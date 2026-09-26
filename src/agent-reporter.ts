/**
 * Responsibility: read the report and metrics Stryker already produced and
 * write a JSON-Lines file that a coding agent can act on directly (write a
 * test, or re-examine a measurement), without it having to re-derive
 * positions, diffs, or rerun commands from the full report itself. It also
 * appends each actionable mutant result to a second, partial file as soon
 * as the mutant's status is known, so an agent can start fixing survivors
 * before the run finishes.
 * Boundary: this reporter only reads `mutantPlans`/`result`/`report`/
 * `metrics` and writes two files. It does not change what Stryker mutates
 * or how it runs. It has no dependency on `@stryker-mutator/core` internals:
 * `writeFile` and `normalizeReportFileName` below are based on the
 * corresponding functions in Stryker (Apache-2.0). The final file's own
 * lines come from `build-lines.ts`, shared with the `convert` command so a
 * mutant's key is computed by one function, not two.
 */

import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  schema,
  StrykerOptions,
  MutantResult,
} from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { commonTokens, tokens } from '@stryker-mutator/api/plugin';
import type { Reporter } from '@stryker-mutator/api/report';
import type { MutationTestingPlanReadyEvent } from '@stryker-mutator/api/report';
import type { MutationTestMetricsResult } from 'mutation-testing-metrics';

import {
  assignKeys,
  buildAgentReportLines,
  buildRunLine,
  computeLineMap,
  extractOriginal,
  rerunCommand,
  rerunExactCommand,
  sanitizeReason,
  sourceHash,
  wholeLineOf,
} from './build-lines.ts';
import type { ItemKind } from './build-lines.ts';

/**
 * The options this reporter reads off `StrykerOptions.agentReporter`.
 * `StrykerOptions` itself does not declare this property; the schema in
 * `schema/agent-reporter-options.json` is what teaches Stryker's config
 * loader to fill it in and validate it.
 */
export interface AgentReporterOptions {
  fileName: string;
  partial: boolean;
}

const DEFAULT_OPTIONS: AgentReporterOptions = {
  fileName: 'reports/mutation/agent.jsonl',
  partial: true,
};

/**
 * Based on Stryker's own `reporterUtil.writeFile` (Apache-2.0): creates the
 * destination directory first, since a fresh report directory may not exist
 * yet, then writes the file.
 */
async function writeFile(fileName: string, content: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(fileName), { recursive: true });
  await fsPromises.writeFile(fileName, content, 'utf8');
}

/**
 * Based on Stryker's own `normalizeReportFileName` (Apache-2.0): a report
 * key is always relative to the current working directory and always uses
 * `/` as its separator, even on Windows, so a key computed here matches the
 * key Stryker's own report uses for the same file.
 */
function normalizeReportFileName(fileName: string | undefined): string {
  if (fileName) {
    return path.relative(process.cwd(), fileName).replace(/\\/g, '/');
  }
  return '';
}

/**
 * A thin wrapper around the two async file operations this reporter
 * performs on the partial file, kept as an object (not free functions) so
 * a test can stub a call site without stubbing all of `fs`.
 */
export const partialFileIO = {
  readSource: (fileName: string): Promise<string> =>
    fsPromises.readFile(fileName, 'utf-8'),
  appendLine: (fileName: string, line: string): Promise<void> =>
    fsPromises.appendFile(fileName, line, 'utf-8'),
};

/**
 * What `onMutationTestingPlanReady` can already work out for one mutant,
 * before it is tested: its key, its schema (1-based) location, and the
 * source-derived fields the key itself is built from. Kept per mutant id
 * so `onMutantTested` can look it up without re-reading the file.
 */
interface PlannedMutant {
  key: string;
  file: string;
  location: schema.Location;
  mutatorName: string;
  replacement: string | undefined;
  original: string;
  sourceHash: string;
}

export class AgentReporter implements Reporter {
  private readonly options: StrykerOptions & {
    agentReporter: AgentReporterOptions;
  };
  private readonly log: Logger;
  private mainPromise: Promise<void> | undefined;
  /**
   * Every write to the partial file, chained one after another: the run
   * line (from `onMutationTestingPlanReady`) must land before any mutant
   * line, and mutant lines must not interleave, since `appendFile` calls
   * issued concurrently on the same file are not guaranteed to keep their
   * calling order.
   */
  private partialChain: Promise<void> = Promise.resolve();
  private readonly plannedMutants = new Map<string, PlannedMutant>();
  private partialFileName: string | undefined;

  public static readonly inject = tokens(
    commonTokens.options,
    commonTokens.logger,
  );

  constructor(options: StrykerOptions, log: Logger) {
    // The schema fills in `agentReporter`'s defaults once Stryker validates
    // config against `strykerValidationSchema`; this fallback only matters
    // for a caller that builds `options` itself, such as a unit test.
    const withDefaults = options as StrykerOptions & {
      agentReporter?: Partial<AgentReporterOptions>;
    };
    this.options = {
      ...options,
      agentReporter: {
        ...DEFAULT_OPTIONS,
        ...withDefaults.agentReporter,
      },
    };
    this.log = log;
  }

  public onMutationTestingPlanReady(
    event: MutationTestingPlanReadyEvent,
  ): void {
    this.partialChain = this.partialChain.then(() =>
      this.preparePlan(event.mutantPlans),
    );
  }

  /**
   * The partial file needs each mutant's key before the run ends, and the
   * key comes from the original source on disk. With `inPlace`, Stryker has
   * already written the instrumented code over that file by the time the
   * plan is ready, so a key from it would not match the final file's key.
   * The final file reads the original source from the report and stays
   * correct either way.
   */
  private get writesPartial(): boolean {
    return this.options.agentReporter.partial && !this.options.inPlace;
  }

  public onMutantTested(result: Readonly<MutantResult>): void {
    if (!this.writesPartial) {
      return;
    }
    this.partialChain = this.partialChain.then(() =>
      this.appendPartialLine(result),
    );
  }

  public onMutationTestReportReady(
    report: schema.MutationTestResult,
    metrics: MutationTestMetricsResult,
  ): void {
    this.mainPromise = this.generateReport(report, metrics);
  }

  public wrapUp(): Promise<void> | undefined {
    if (this.mainPromise === undefined) {
      return this.partialChain;
    }
    return Promise.all([this.partialChain, this.mainPromise]).then(
      () => undefined,
    );
  }

  /**
   * Computes every planned mutant's key up front, from the mutate target's
   * own source on disk (Stryker mutates a sandbox copy, never the project
   * file itself, so this file is still the original the mutant was found
   * in). This is also where the partial file is (re)created, truncating
   * whatever an earlier run left there.
   */
  private async preparePlan(
    mutantPlans: MutationTestingPlanReadyEvent['mutantPlans'],
  ): Promise<void> {
    if (!this.writesPartial) {
      return;
    }
    const byFile = new Map<
      string,
      typeof mutantPlans extends readonly (infer T)[] ? T[] : never
    >();
    for (const plan of mutantPlans) {
      const group = byFile.get(plan.mutant.fileName);
      if (group) {
        group.push(plan);
      } else {
        byFile.set(plan.mutant.fileName, [plan]);
      }
    }

    for (const [fileName, plans] of byFile) {
      let source: string;
      try {
        source = await partialFileIO.readSource(fileName);
      } catch (err) {
        // The partial line for these mutants is skipped (see
        // `appendPartialLine`); the final report still keys them, since it
        // reads the same file through the normal report pipeline, which
        // surfaces a read failure on its own.
        this.log.warn(
          'Could not read "%s" for the agent reporter: %s',
          fileName,
          err,
        );
        continue;
      }
      this.indexPlannedMutants(fileName, source, plans);
    }

    {
      this.partialFileName = path.resolve(
        partialFileNameFor(path.normalize(this.options.agentReporter.fileName)),
      );
      await writeFile(
        this.partialFileName,
        `${JSON.stringify(buildRunLine(this.options))}\n`,
      );
    }
  }

  private indexPlannedMutants(
    fileName: string,
    source: string,
    plans: readonly MutationTestingPlanReadyEvent['mutantPlans'][number][],
  ): void {
    const reportFile = normalizeReportFileName(fileName);
    const lineMap = computeLineMap(source);
    const hash = sourceHash(source);

    // Sorted by position, over every mutant of the file: `assignKeys`
    // needs this order to number a repeated tuple the same way on every
    // run, matching the order `buildAgentReportLines` uses later.
    const records = plans
      .map(({ mutant }) => {
        const location = toOneBasedLocation(mutant.location);
        return {
          id: mutant.id,
          location,
          wholeLine: wholeLineOf(source, lineMap, location),
          original: extractOriginal(source, lineMap, location),
          mutatorName: mutant.mutatorName,
          replacement: mutant.replacement,
        };
      })
      .sort(
        (a, b) =>
          a.location.start.line - b.location.start.line ||
          a.location.start.column - b.location.start.column,
      );
    const keys = assignKeys(
      reportFile,
      records.map((record) => ({
        ...record,
        original: record.original.replace(/\s+/g, ' ').trim(),
      })),
    );

    records.forEach((record, index) => {
      this.plannedMutants.set(record.id, {
        key: keys[index],
        file: reportFile,
        location: record.location,
        mutatorName: record.mutatorName,
        replacement: record.replacement,
        original: record.original,
        sourceHash: hash,
      });
    });
  }

  /**
   * Appends one line for a mutant that just finished, if it is one an
   * agent can act on (a Killed or Pending mutant gives nothing to act on,
   * same as in the final report). Left out of this line, and filled in
   * only by the final report: `tests` (needs the covering `TestModel`s,
   * not carried on `MutantResult`) and `patch` (needs `MutantModel`'s
   * aligned original/mutated line pairs).
   */
  private async appendPartialLine(
    result: Readonly<MutantResult>,
  ): Promise<void> {
    if (this.partialFileName === undefined) {
      return;
    }
    const planned = this.plannedMutants.get(result.id);
    if (!planned) {
      // Not indexed: either its file could not be read (logged already in
      // `preparePlan`), or `onMutantTested` fired without a preceding
      // `onMutationTestingPlanReady` (a misuse this reporter cannot key).
      return;
    }
    const kind = classifyForPartial(result);
    if (!kind) {
      return;
    }
    const base = {
      kind,
      key: planned.key,
      file: planned.file,
      location: planned.location,
      mutatorName: planned.mutatorName,
      replacement: planned.replacement,
      original: planned.original,
    };
    let line: Record<string, unknown>;
    switch (kind) {
      case 'survivor':
      case 'unverified':
      case 'timeout':
        line = {
          ...base,
          static: result.static,
          rerun: rerunCommand(planned.file),
          rerunExact: rerunExactCommand(planned.file, planned.location),
          sourceHash: planned.sourceHash,
        };
        break;
      case 'ignored':
        line = {
          ...base,
          reason: sanitizeReason(
            result.statusReason,
            process.cwd(),
            this.options.tempDirName,
          ),
        };
        break;
      case 'invalid':
        line = {
          ...base,
          status: result.status,
          statusReason: sanitizeReason(
            result.statusReason,
            process.cwd(),
            this.options.tempDirName,
          ),
        };
        break;
      case 'noCoverage':
        line = base;
        break;
    }
    await partialFileIO.appendLine(
      this.partialFileName,
      `${JSON.stringify(line)}\n`,
    );
  }

  private async generateReport(
    report: schema.MutationTestResult,
    metrics: MutationTestMetricsResult,
  ) {
    const filePath = path.normalize(this.options.agentReporter.fileName);
    this.log.debug(`Using relative path ${filePath}`);
    const lines = buildAgentReportLines(report, metrics, this.options);
    const content = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
    await writeFile(path.resolve(filePath), content);
    this.log.info(
      `Your report can be found at: ${pathToFileURL(filePath).href}`,
    );
  }
}

/**
 * The partial file's name: the given file name, with `.partial` inserted
 * before its extension, and always ending in `.jsonl` regardless of that
 * extension, because the partial file is always append-only JSON Lines
 * even when `fileName` itself is not (a user could still set `fileName`
 * to a `.json` path; the partial file next to it stays `.jsonl`).
 */
export function partialFileNameFor(fileName: string): string {
  const ext = path.extname(fileName);
  const withoutExt = ext ? fileName.slice(0, -ext.length) : fileName;
  return `${withoutExt}.partial.jsonl`;
}

/**
 * A mutant tested to `Survived` and covered by no completed test is a
 * measurement gap (stryker-js issue #6210), not an untested line: routed
 * to `unverified` so an agent does not spend a test-writing pass on a
 * mutant no test actually ran. `Killed`/`Pending` give an agent nothing to
 * act on and are left out (only counted in `summary`).
 */
function classifyForPartial(
  result: Readonly<MutantResult>,
): ItemKind | undefined {
  switch (result.status) {
    case 'Survived':
      return (result.coveredBy?.length ?? 0) > 0 && result.testsCompleted === 0
        ? 'unverified'
        : 'survivor';
    case 'Timeout':
      return 'timeout';
    case 'NoCoverage':
      return 'noCoverage';
    case 'Ignored':
      return 'ignored';
    case 'CompileError':
    case 'RuntimeError':
      return 'invalid';
    default:
      return undefined;
  }
}

/**
 * `Mutant.location` is 0-based (Stryker's own internal convention); the
 * report's `schema.Location` is 1-based. Converting here, at plan time,
 * keeps every downstream computation (`extractOriginal`, `wholeLineOf`,
 * `assignKeys`, the rerun commands) working on the same 1-based positions
 * the final report uses, so a key computed in the plan matches the key
 * computed later from the report.
 */
function toOneBasedLocation(location: schema.Location): schema.Location {
  return {
    start: { line: location.start.line + 1, column: location.start.column + 1 },
    end: { line: location.end.line + 1, column: location.end.column + 1 },
  };
}

