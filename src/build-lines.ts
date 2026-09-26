/**
 * Responsibility: build the ordered list of JSON-Lines values a finished
 * mutation-testing run produces, from a Stryker report and its metrics
 * alone. Both `AgentReporter` (run live, inside Stryker) and the `convert`
 * command (run later, from a saved `mutation.json`) call this module so a
 * mutant's key is computed by one function, not two.
 * Boundary: this module only reads a `schema.MutationTestResult`, a
 * `MutationTestMetricsResult`, and a small run-info object; it writes
 * nothing and has no dependency on `@stryker-mutator/core` internals.
 * `writeFile`, `normalizeReportFileName`, and the partial-file logic stay
 * in `agent-reporter.ts`: `convert` never writes a partial file, so they
 * are not shared.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import type { schema } from '@stryker-mutator/api/core';
import type {
  FileUnderTestModel,
  MetricsResult,
  MutantModel,
  MutationTestMetricsResult,
  TestFileModel,
  TestMetrics,
  TestModel,
} from 'mutation-testing-metrics';

/**
 * Bumped from `'1'` (a single JSON object) because the output shape
 * changed to JSON Lines: a run line, one line per actionable mutant, and a
 * summary line, so a run that stops early still leaves a readable,
 * partial file behind.
 */
export const SCHEMA_VERSION = '2';

/**
 * Stryker's own default (`tempDirName` in `stryker-schema.json`). `convert`
 * reads the real value from the report's own `config.tempDirName` when
 * present; this is the fallback for a report saved without one.
 */
export const DEFAULT_TEMP_DIR_NAME = '.stryker-tmp';

/**
 * Caps on `TestsSummary.files` and each entry's `.names`: central code is
 * covered by hundreds of tests, so an uncapped list per mutant made the
 * output of a 3,689-survivor report 44 MB, most of it the same tests
 * repeated. An agent reads this field to pick the test file to extend.
 */
const MAX_TEST_FILES = 10;
const MAX_TEST_NAMES_PER_FILE = 3;

/**
 * Item kinds an agent can act on, in the fixed order they are written to
 * the final file. `run` and `summary` are not in this list: they are
 * written once, first and last respectively.
 */
export const ITEM_KINDS = [
  'survivor',
  'unverified',
  'timeout',
  'noCoverage',
  'ignored',
  'invalid',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface KeyedLocation {
  key: string;
  file: string;
  location: schema.Location;
  mutatorName: string;
  replacement: string | undefined;
  original: string;
}

export interface AgentEntry extends KeyedLocation {
  static: boolean | undefined;
  tests: TestsSummary;
  rerun: string;
  rerunExact: string;
  sourceHash: string;
  patch: string;
}

export interface TestRef {
  name: string;
  file: string;
  line?: number;
}

export interface TestFileSummary {
  file: string;
  count: number;
  names: string[];
}

export interface TestsSummary {
  total: number;
  truncated: boolean;
  files: TestFileSummary[];
}

export interface Summary {
  total: number;
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  compileError: number;
  runtimeError: number;
  ignored: number;
  pending: number;
  unverified: number;
  mutationScore: number;
  mutationScoreBasedOnCoveredCode: number;
}

/** The run-line fields `buildAgentReportLines`'s caller supplies, not read from `report`/`metrics`. */
export interface RunInfo {
  disableBail: boolean;
  concurrency?: number | string | undefined;
  tempDirName: string;
}

/**
 * Reads `version` from the installed `@stryker-mutator/core` package, so the
 * run line can report the Stryker version actually driving it. Returns
 * `undefined` rather than throwing: a missing or unreadable version is not a
 * reason to fail the whole build.
 */
export function readStrykerVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@stryker-mutator/core/package.json') as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

export function buildRunLine(runInfo: RunInfo): Record<string, unknown> {
  return {
    kind: 'run',
    schemaVersion: SCHEMA_VERSION,
    tool: 'stryker',
    strykerVersion: readStrykerVersion(),
    disableBail: runInfo.disableBail,
    concurrency: runInfo.concurrency,
  };
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Compares two records by (file, location.start.line, location.start.column,
 * mutatorName, replacement): a fixed order, independent of the report's own
 * array order, so the same report always serializes to the same bytes.
 */
function compareByPosition(a: KeyedLocation, b: KeyedLocation): number {
  return (
    compareStrings(a.file, b.file) ||
    a.location.start.line - b.location.start.line ||
    a.location.start.column - b.location.start.column ||
    compareStrings(a.mutatorName, b.mutatorName) ||
    compareStrings(a.replacement ?? '', b.replacement ?? '')
  );
}

function compareTests(a: TestRef, b: TestRef): number {
  return compareStrings(a.file, b.file) || compareStrings(a.name, b.name);
}

/**
 * Walks a metrics tree collecting every leaf's `.file`, keyed by the model's
 * own id (mutant id, or test id). Correlating by id, not by the model's
 * `.name`, matters: `calculateMutationTestMetrics` rewrites `.name` relative
 * to `projectRoot` (and, when building the tree's directory nesting, to a
 * common base path too), so it can differ from the report's own
 * `files`/`testFiles` key: the path a user would actually pass back to
 * `--mutate`. So this map is only used to look up per-mutant/per-test
 * computed data (diffs, covered tests); `file` in the output always comes
 * from the report's own key, read separately below.
 */
function indexMutantsById(
  systemUnderTestMetrics: MetricsResult<FileUnderTestModel>,
): Map<string, MutantModel> {
  const byId = new Map<string, MutantModel>();
  const visit = (node: MetricsResult<FileUnderTestModel>) => {
    for (const mutant of node.file?.mutants ?? []) {
      byId.set(mutant.id, mutant);
    }
    node.childResults.forEach(visit);
  };
  visit(systemUnderTestMetrics);
  return byId;
}

function collectTestFiles(
  testMetrics: MetricsResult<TestFileModel, TestMetrics> | undefined,
): TestFileModel[] {
  if (!testMetrics) {
    return [];
  }
  const files: TestFileModel[] = [];
  const visit = (node: MetricsResult<TestFileModel, TestMetrics>) => {
    if (node.file) {
      files.push(node.file);
    }
    node.childResults.forEach(visit);
  };
  visit(testMetrics);
  return files;
}

function toTestRef(test: TestModel): TestRef {
  const ref: TestRef = { name: test.name, file: test.sourceFile?.name ?? '' };
  if (test.location?.start.line !== undefined) {
    ref.line = test.location.start.line;
  }
  return ref;
}

/**
 * Groups the tests covering one mutant by test file, count-descending (tied
 * files in file-name order), each file's own names name-ascending. `line`
 * is left out on purpose: only some runners report a test location, and
 * one element shape for every runner keeps the output simple to read.
 */
function buildTestsSummary(tests: TestModel[]): TestsSummary {
  const total = tests.length;
  const byFile = new Map<string, TestModel[]>();
  for (const test of tests) {
    const file = test.sourceFile?.name ?? '';
    const group = byFile.get(file);
    if (group) {
      group.push(test);
    } else {
      byFile.set(file, [test]);
    }
  }

  let truncated = byFile.size > MAX_TEST_FILES;
  const allFiles: TestFileSummary[] = Array.from(byFile.entries()).map(
    ([file, groupTests]) => {
      const names = groupTests.map((t) => t.name).sort(compareStrings);
      if (names.length > MAX_TEST_NAMES_PER_FILE) {
        truncated = true;
      }
      return {
        file,
        count: groupTests.length,
        names: names.slice(0, MAX_TEST_NAMES_PER_FILE),
      };
    },
  );
  allFiles.sort((a, b) => b.count - a.count || compareStrings(a.file, b.file));

  return { total, truncated, files: allFiles.slice(0, MAX_TEST_FILES) };
}

/** The exact source text a mutant replaces: not the enclosing line(s), the range itself. */
export function extractOriginal(
  source: string,
  lineMap: number[],
  location: schema.Location,
): string {
  const { start, end } = location;
  return source.substring(
    lineMap[start.line] + start.column - 1,
    lineMap[end.line] + end.column - 1,
  );
}

/**
 * The line(s) a mutant's range falls on, each stripped of its own leading
 * and trailing whitespace, joined with '\n' for a multi-line range. The
 * range text alone (`original`) is not enough to tell two mutants apart: on
 * a 14,140-mutant report, (file, original, mutatorName, replacement) held
 * 4,261 colliding pairs (30%); adding the whole line the range sits on cut
 * that to 1,163 (8%), because most repeats are the same short token (`+`,
 * `1`, an identifier) recurring across unrelated lines, while whole lines
 * repeat far less. `.trim()` also drops the line's own terminator
 * (`\r`, `\n`, `U+2028`, `U+2029`), since `lineMap` marks where a line
 * starts, not where it ends.
 */
export function wholeLineOf(
  source: string,
  lineMap: number[],
  location: schema.Location,
): string {
  const lines: string[] = [];
  for (let line = location.start.line; line <= location.end.line; line++) {
    const end = line + 1 < lineMap.length ? lineMap[line + 1] : source.length;
    lines.push(source.slice(lineMap[line], end).trim());
  }
  return lines.join('\n');
}

/**
 * Builds a stable key with no line or column in it, so a key survives an
 * edit elsewhere in the file. Two ordinals disambiguate what the other
 * fields alone would merge, both counted over every mutant of the file
 * regardless of status, in source-position order (assigned by the caller),
 * so they come out the same on every run:
 *
 * - `lineOrdinal`: two mutants on the exact same line, same original text,
 *   mutator and replacement (e.g. `a + a` with both `+`s mutated the same
 *   way) get 0, 1, ... in column order. Always present, 0 when there is
 *   only one.
 * - `lineRepeatOrdinal`: once a copy of an identical line exists elsewhere
 *   in the file, `wholeLine` no longer picks out one physical line, so two
 *   mutants that also share original/mutatorName/replacement/lineOrdinal
 *   need a further tiebreaker: their order of appearance in the file.
 *   Included only when more than one mutant shares that tuple; this is the
 *   key's remaining weak point, since adding or removing a copy of the
 *   repeated line shifts this ordinal for every mutant after it.
 */
function hashKey(
  file: string,
  wholeLine: string,
  original: string,
  mutatorName: string,
  replacement: string | undefined,
  lineOrdinal: number,
  lineRepeatOrdinal: number | undefined,
): string {
  let input = `${file}\0${wholeLine}\0${original}\0${mutatorName}\0${replacement ?? ''}\0${lineOrdinal}`;
  if (lineRepeatOrdinal !== undefined) {
    input += `\0${lineRepeatOrdinal}`;
  }
  return createHash('sha1').update(input).digest('hex').slice(0, 12);
}

/**
 * Assigns every mutant of a file its key. `records` must already be sorted
 * by source position (line, then column), not the report's own array order:
 * that fixed order is what numbers a repeated tuple the same way on every
 * run, keeping the key independent of the report's array order.
 */
export function assignKeys(
  file: string,
  records: Array<{
    location: schema.Location;
    wholeLine: string;
    original: string;
    mutatorName: string;
    replacement: string | undefined;
  }>,
): string[] {
  type Record = (typeof records)[number];
  // Same physical line, same original/mutatorName/replacement: numbered by
  // column order (the order `records` is already sorted in).
  const lineGroupKeyOf = (r: Record) =>
    `${r.location.start.line}\0${r.wholeLine}\0${r.original}\0${r.mutatorName}\0${r.replacement ?? ''}`;
  const lineGroupSeen = new Map<string, number>();
  const lineOrdinals = records.map((r) => {
    const key = lineGroupKeyOf(r);
    const ordinal = lineGroupSeen.get(key) ?? 0;
    lineGroupSeen.set(key, ordinal + 1);
    return ordinal;
  });

  // Same wholeLine/original/mutatorName/replacement/lineOrdinal, dropping
  // `line` on purpose: this is what a repeated line collides on.
  const repeatGroupKeyOf = (r: Record, lineOrdinal: number) =>
    `${r.wholeLine}\0${r.original}\0${r.mutatorName}\0${r.replacement ?? ''}\0${lineOrdinal}`;
  const repeatGroupCounts = new Map<string, number>();
  records.forEach((r, i) => {
    const key = repeatGroupKeyOf(r, lineOrdinals[i]);
    repeatGroupCounts.set(key, (repeatGroupCounts.get(key) ?? 0) + 1);
  });
  const repeatGroupSeen = new Map<string, number>();

  return records.map((r, i) => {
    const key = repeatGroupKeyOf(r, lineOrdinals[i]);
    let lineRepeatOrdinal: number | undefined;
    if ((repeatGroupCounts.get(key) ?? 0) > 1) {
      lineRepeatOrdinal = repeatGroupSeen.get(key) ?? 0;
      repeatGroupSeen.set(key, lineRepeatOrdinal + 1);
    }
    return hashKey(
      file,
      r.wholeLine,
      r.original,
      r.mutatorName,
      r.replacement,
      lineOrdinals[i],
      lineRepeatOrdinal,
    );
  });
}

/**
 * `getOriginalLines()`/`getMutatedLines()` return the enclosing whole
 * line(s), each still carrying its own line terminator, because they exist
 * to show a diff view, not to isolate the replaced range. That is exactly
 * what a unified-diff hunk's `-`/`+` lines need. Splitting the text on '\n'
 * directly would add one bogus empty trailing line, because the text ends
 * with the final line's own terminator; this strips that terminator first.
 */
function toHunkLines(text: string): {
  lines: string[];
  endsWithNewline: boolean;
} {
  const endsWithNewline = text.endsWith('\n');
  const body = endsWithNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), endsWithNewline };
}

/**
 * A `git apply --unidiff-zero`-ready patch for one mutant, with no context
 * lines. `MutantModel.getOriginalLines()`/`getMutatedLines()` supply both
 * sides already aligned to the same line range, so the hunk header's line
 * counts come straight from their split length. A hunk whose last line has
 * no trailing newline needs the `\ No newline at end of file` marker or
 * `git apply` rejects it (verified against real git for a mutant on the
 * last, newline-less line of a file).
 */
function buildPatch(file: string, mutant: MutantModel): string {
  const original = toHunkLines(mutant.getOriginalLines());
  const mutated = toHunkLines(mutant.getMutatedLines());
  const { start } = mutant.location;
  const header = `@@ -${start.line},${original.lines.length} +${start.line},${mutated.lines.length} @@`;
  const originalHunk = original.lines.map((l) => `-${l}`);
  if (!original.endsWithNewline) {
    originalHunk.push('\\ No newline at end of file');
  }
  const mutatedHunk = mutated.lines.map((l) => `+${l}`);
  if (!mutated.endsWithNewline) {
    mutatedHunk.push('\\ No newline at end of file');
  }
  const hunk = [header, ...originalHunk, ...mutatedHunk].join('\n');
  return `--- a/${file}\n+++ b/${file}\n${hunk}\n`;
}

/**
 * A `--mutate` range reproduces `location` exactly one column short on both
 * ends: the report writer (`toSchemaPosition`) adds 1 to both columns when
 * it builds the report, but Stryker's own `--mutate` parser reads the
 * column digits unshifted and compares them straight against the
 * instrumenter's 0-based AST positions. The line is untouched; only the
 * columns need the shift back.
 */
export function rerunExactCommand(
  file: string,
  location: schema.Location,
): string {
  const startColumn = location.start.column - 1;
  const endColumn = location.end.column - 1;
  const range = `${file}:${location.start.line}:${startColumn}-${location.end.line}:${endColumn}`;
  return `npx stryker run --force --mutate "${range}"`;
}

export function rerunCommand(file: string): string {
  return `npx stryker run --incremental --mutate "${file}"`;
}

export function sourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

/**
 * Removes the parts of a status reason that are specific to one sandbox run
 * and would otherwise make an unrelated rerun's output differ from this
 * one: the sandbox's own temp directory (named after `tempDirName`, plus a
 * random suffix) and a cache-busting query string a test runner (e.g.
 * Vitest) can append to a file URL.
 */
export function sanitizeReason(
  text: string | undefined,
  projectRoot: string | undefined,
  tempDirName: string,
): string | undefined {
  if (text === undefined) {
    return text;
  }
  let result = text;
  if (projectRoot) {
    result = result.split(`file://${projectRoot}/`).join('');
  }
  const escapedTempDirName = tempDirName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  result = result.replace(
    new RegExp(`${escapedTempDirName}[\\\\/]sandbox-[A-Za-z0-9]+[\\\\/]`, 'g'),
    '',
  );
  result = result.replace(/\?[A-Za-z0-9_]+=\d+/g, '');
  return result;
}

/**
 * Builds every line of the final JSONL file, in the order they are
 * written: the run line, then each item kind's lines (sorted by position),
 * in `ITEM_KINDS` order, then one line per test without a kill, then the
 * summary line. Called with a freshly completed report and its metrics,
 * so every field (`tests`, `patch`) can be filled in; `AgentReporter`'s own
 * partial-file lines are built earlier, from `MutantResult` alone, and stay
 * in `agent-reporter.ts`.
 */
export function buildAgentReportLines(
  report: schema.MutationTestResult,
  metrics: MutationTestMetricsResult,
  runInfo: RunInfo,
): unknown[] {
  const mutantsById = indexMutantsById(metrics.systemUnderTestMetrics);
  const projectRoot = report.projectRoot;

  const survivors: AgentEntry[] = [];
  const unverified: AgentEntry[] = [];
  const timeouts: AgentEntry[] = [];
  const noCoverage: KeyedLocation[] = [];
  const ignored: Array<KeyedLocation & { reason: string | undefined }> = [];
  const invalid: Array<
    KeyedLocation & {
      status: schema.MutantStatus;
      statusReason: string | undefined;
    }
  > = [];
  let unverifiedCount = 0;

  for (const [file, fileResult] of Object.entries(report.files)) {
    const lineMap = computeLineMap(fileResult.source);

    // Sorted by position, over every mutant of the file regardless of
    // status: `assignKeys` needs this order to number a repeated tuple the
    // same way on every run.
    const records = fileResult.mutants
      .map((mutant) => ({
        mutant,
        location: mutant.location,
        wholeLine: wholeLineOf(fileResult.source, lineMap, mutant.location),
        original: extractOriginal(fileResult.source, lineMap, mutant.location),
        mutatorName: mutant.mutatorName,
        replacement: mutant.replacement,
      }))
      .sort(
        (a, b) =>
          a.mutant.location.start.line - b.mutant.location.start.line ||
          a.mutant.location.start.column - b.mutant.location.start.column,
      );
    // The key reads `original` with each run of whitespace collapsed to one
    // space, so re-indenting the lines of a multi-line range keeps its key.
    // The `original` field in the output keeps the text as written.
    const keys = assignKeys(
      file,
      records.map((record) => ({
        ...record,
        original: record.original.replace(/\s+/g, ' ').trim(),
      })),
    );

    records.forEach((record, index) => {
      const { mutant } = record;
      const key = keys[index];
      const keyedLocation: KeyedLocation = {
        key,
        file,
        // Rebuilt, not copied: the report lists `end` before `start`, and
        // the partial file writes `start` first. One key order lets a
        // reader compare lines from both files as text.
        location: {
          start: { line: mutant.location.start.line, column: mutant.location.start.column },
          end: { line: mutant.location.end.line, column: mutant.location.end.column },
        },
        mutatorName: mutant.mutatorName,
        replacement: mutant.replacement,
        original: record.original,
      };

      switch (mutant.status) {
        case 'Survived': {
          const model = mutantsById.get(mutant.id);
          const entry = buildEntry(
            file,
            fileResult.source,
            keyedLocation,
            mutant,
            model,
          );
          // Survived, covered, and yet not one covering test actually ran
          // during this mutant's run: a measurement gap (stryker-js
          // issue #6210), not an untested line. Routed away from
          // `survivors` so an agent does not spend a test-writing pass on
          // a mutant no test tried.
          const isUnverified =
            (mutant.coveredBy?.length ?? 0) > 0 && mutant.testsCompleted === 0;
          if (isUnverified) {
            unverifiedCount += 1;
            unverified.push(entry);
          } else {
            survivors.push(entry);
          }
          break;
        }
        case 'Timeout': {
          const model = mutantsById.get(mutant.id);
          timeouts.push(
            buildEntry(file, fileResult.source, keyedLocation, mutant, model),
          );
          break;
        }
        case 'NoCoverage': {
          noCoverage.push(keyedLocation);
          break;
        }
        case 'Ignored': {
          ignored.push({
            ...keyedLocation,
            reason: sanitizeReason(
              mutant.statusReason,
              projectRoot,
              runInfo.tempDirName,
            ),
          });
          break;
        }
        case 'CompileError':
        case 'RuntimeError': {
          invalid.push({
            ...keyedLocation,
            status: mutant.status,
            statusReason: sanitizeReason(
              mutant.statusReason,
              projectRoot,
              runInfo.tempDirName,
            ),
          });
          break;
        }
        default:
        // Killed and Pending mutants are only counted in `summary`; they
        // give an agent nothing to act on.
      }
    });
  }

  survivors.sort(compareByPosition);
  unverified.sort(compareByPosition);
  timeouts.sort(compareByPosition);
  noCoverage.sort(compareByPosition);
  ignored.sort(compareByPosition);
  invalid.sort(compareByPosition);

  const testsWithoutKills: TestRef[] = [];
  for (const testFile of collectTestFiles(metrics.testMetrics)) {
    for (const test of testFile.tests) {
      if (!test.killedMutants?.length) {
        testsWithoutKills.push(toTestRef(test));
      }
    }
  }
  testsWithoutKills.sort(compareTests);

  const m = metrics.systemUnderTestMetrics.metrics;
  const summary: Summary = {
    total: m.totalMutants,
    killed: m.killed,
    timeout: m.timeout,
    // `m.survived` already counts every unverified mutant too: Stryker's
    // own metrics treat "no covering test ran" the same as "ran and
    // survived", so `survived` and `unverified` overlap by design.
    survived: m.survived,
    noCoverage: m.noCoverage,
    compileError: m.compileErrors,
    runtimeError: m.runtimeErrors,
    ignored: m.ignored,
    pending: m.pending,
    unverified: unverifiedCount,
    mutationScore: m.mutationScore,
    mutationScoreBasedOnCoveredCode: m.mutationScoreBasedOnCoveredCode,
  };

  const byKind: Record<ItemKind, unknown[]> = {
    survivor: survivors.map((e) => ({ kind: 'survivor', ...e })),
    unverified: unverified.map((e) => ({ kind: 'unverified', ...e })),
    timeout: timeouts.map((e) => ({ kind: 'timeout', ...e })),
    noCoverage: noCoverage.map((e) => ({ kind: 'noCoverage', ...e })),
    ignored: ignored.map((e) => ({ kind: 'ignored', ...e })),
    invalid: invalid.map((e) => ({ kind: 'invalid', ...e })),
  };

  return [
    buildRunLine(runInfo),
    ...ITEM_KINDS.flatMap((kind) => byKind[kind]),
    // `testWithoutKills.complete` (whether every test ran, i.e.
    // `disableBail`) has no per-line home in this shape: it is already the
    // run line's `disableBail` field.
    ...testsWithoutKills.map((test) => ({ kind: 'testWithoutKills', ...test })),
    { kind: 'summary', ...summary },
  ];
}

function buildEntry(
  file: string,
  fileSource: string,
  keyedLocation: KeyedLocation,
  mutant: schema.MutantResult,
  model: MutantModel | undefined,
): AgentEntry {
  const tests = buildTestsSummary(model?.coveredByTests ?? []);
  return {
    ...keyedLocation,
    static: mutant.static,
    tests,
    rerun: rerunCommand(file),
    rerunExact: rerunExactCommand(file, mutant.location),
    sourceHash: sourceHash(fileSource),
    // A patch needs `model` for `getOriginalLines()`/`getMutatedLines()`,
    // and needs `mutant.replacement` to be set: when it is undefined,
    // `getMutatedLines()` falls back to `description` or `mutatorName`
    // instead, which is not a reproduction of the mutation at all.
    patch:
      model && mutant.replacement !== undefined
        ? buildPatch(file, model)
        : buildFallbackPatch(file),
  };
}

/**
 * `model` is only missing if a mutant id in `report.files` has no matching
 * model in the metrics tree, which `calculateMutationTestMetrics` does not
 * do for a well-formed report; `mutant.replacement` is missing for a
 * description-only mutant. Either way this degrades to an empty-hunk patch
 * instead of a wrong one.
 */
function buildFallbackPatch(file: string): string {
  return `--- a/${file}\n+++ b/${file}\n`;
}

/**
 * 1-based line number to the byte offset of that line's first character.
 * Index 0 is unused, matching `mutation-testing-metrics`' own line map, so
 * `lineMap[location.start.line]` needs no further shift.
 */
export function computeLineMap(source: string): number[] {
  const result = [0];
  let lineStart = 0;
  let pos = 0;
  while (pos < source.length) {
    const ch = source.charCodeAt(pos);
    pos++;
    if (ch === 13 /* \r */) {
      if (source.charCodeAt(pos) === 10 /* \n */) {
        pos++;
      }
      result.push(lineStart);
      lineStart = pos;
    } else if (ch === 10 /* \n */ || ch === 0x2028 || ch === 0x2029) {
      result.push(lineStart);
      lineStart = pos;
    }
  }
  result.push(lineStart);
  return result;
}
