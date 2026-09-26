/**
 * Responsibility: turn an `agent.jsonl` file into a pass/fail check for a
 * pull request. It reads only the JSON-Lines shape `docs/output.md`
 * defines: it does not import the reporter, and it does not run Stryker.
 * `--since` narrows the check to a git ref's changed lines, matching the
 * same narrowing `mutation-testing-skills`' `digest.mjs` does for a full
 * `mutation.json` report; `--baseline` compares this run's survivors
 * against a previous run's, by `key`.
 * Boundary: this module reads one file (plus, with `--since`, the working
 * tree and `git diff`) and returns text and an exit code. It writes
 * nothing.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export class GateUsageError extends Error {}

/** One line of `agent.jsonl`, loosely typed: every field this module reads, plus whatever else the line carries. */
interface GateLine {
  kind: string;
  key?: string;
  file?: string;
  location?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  mutatorName?: string;
  replacement?: string;
  original?: string;
  sourceHash?: string;
  patch?: string;
  rerun?: string;
  rerunExact?: string;
  reason?: string;
  [field: string]: unknown;
}

const SCOPED_KINDS = new Set(['survivor', 'unverified', 'timeout', 'noCoverage']);

function sourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

/** True when `line` overlaps at least one of `ranges` (each 1-based, inclusive). */
function overlaps(
  start: number,
  end: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((r) => start <= r.end && end >= r.start);
}

/**
 * Parses a `git diff --unified=0` hunk header's "+" side into the 1-based,
 * inclusive line ranges it added or changed in the current file. A pure
 * deletion (a "+0" count) contributes no range: there is no line left in
 * the current file to flag.
 */
function parseUnifiedDiffRanges(
  diffText: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = hunkHeader.exec(diffText)) !== null) {
    const start = Number(m[1]);
    const count = m[2] !== undefined ? Number(m[2]) : 1;
    if (count === 0) continue;
    ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

function gitAvailable(cwd: string): boolean {
  try {
    execFileSync('git', ['--version'], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function gitRefExists(ref: string, cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** True when git's index tracks `file` (a committed or a staged file, not an untracked one). */
function gitFileTracked(file: string, cwd: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', file], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function firstStderrLine(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  const text = stderr ? String(stderr).trim() : '';
  const first = text.split('\n')[0];
  return first || (err as Error).message;
}

export interface ScopeResult {
  changedRangesByFile: Map<string, Array<{ start: number; end: number }>>;
  staleFiles: Map<string, string>;
}

/**
 * Builds `--since`'s two inputs: the changed-line ranges `git diff
 * --unified=0 <ref> -- <file>` reports for every file a scoped kind names,
 * and the set of files whose current on-disk content no longer matches a
 * recorded `sourceHash` (so the caller must drop them, not filter them on a
 * stale line number). A file with no recorded `sourceHash` in this run
 * (only `noCoverage` entries, none of them carrying one) skips that check
 * and is scoped on `git diff` alone.
 */
export function scopeSince(
  files: readonly string[],
  hashByFile: ReadonlyMap<string, string>,
  ref: string,
  cwd: string,
): ScopeResult {
  const changedRangesByFile = new Map<string, Array<{ start: number; end: number }>>();
  const staleFiles = new Map<string, string>();

  for (const file of files) {
    const recordedHash = hashByFile.get(file);
    let currentContent: string;
    try {
      currentContent = readFileSync(`${cwd}/${file}`, 'utf8');
    } catch (err) {
      staleFiles.set(file, `cannot read ${file}: ${(err as Error).message}`);
      continue;
    }
    if (recordedHash !== undefined && sourceHash(currentContent) !== recordedHash) {
      staleFiles.set(
        file,
        'source no longer matches the report; cannot scope by line',
      );
      continue;
    }

    if (!gitFileTracked(file, cwd)) {
      const lineCount = currentContent.split('\n').length;
      changedRangesByFile.set(file, [{ start: 1, end: lineCount }]);
      continue;
    }

    let diffText: string;
    try {
      diffText = execFileSync('git', ['diff', '--unified=0', ref, '--', file], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      staleFiles.set(file, `git diff failed: ${firstStderrLine(err)}`);
      continue;
    }
    changedRangesByFile.set(file, parseUnifiedDiffRanges(diffText));
  }

  return { changedRangesByFile, staleFiles };
}

function escapeGithubValue(text: string): string {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function githubCommand(
  level: 'error' | 'warning',
  file: string,
  line: number | undefined,
  endLine: number | undefined,
  title: string,
  message: string,
): string {
  const location =
    line !== undefined && endLine !== undefined
      ? `,line=${line},endLine=${endLine}`
      : '';
  return (
    `::${level} file=${escapeGithubValue(file)}${location},` +
    `title=${escapeGithubValue(title)}::${escapeGithubValue(message)}`
  );
}

function formatGithub(
  survivors: GateLine[],
  noCoverage: GateLine[],
  unverified: GateLine[],
  stale: Array<{ file: string; reason: string }>,
): string[] {
  const lines: string[] = [];
  for (const s of [...survivors, ...noCoverage]) {
    lines.push(
      githubCommand(
        'error',
        s.file ?? '',
        s.location?.start.line,
        s.location?.end.line,
        `${s.mutatorName} survived`,
        `${s.original} -> ${s.replacement}`,
      ),
    );
  }
  for (const u of unverified) {
    lines.push(
      githubCommand(
        'warning',
        u.file ?? '',
        u.location?.start.line,
        u.location?.end.line,
        'unverified',
        'no test ran for this mutant',
      ),
    );
  }
  for (const s of stale) {
    lines.push(githubCommand('warning', s.file, undefined, undefined, 'stale', s.reason));
  }
  return lines;
}

function formatItemText(item: GateLine): string[] {
  const lines: string[] = [];
  lines.push(`${item.file}:${item.location?.start.line} ${item.mutatorName} ${item.key}`);
  if (item.patch) {
    lines.push(item.patch.trimEnd());
  }
  if (item.rerun) {
    lines.push(item.rerun);
  }
  if (item.rerunExact) {
    lines.push(item.rerunExact);
  }
  lines.push('');
  return lines;
}

function formatText(
  survivors: GateLine[],
  unverified: GateLine[],
  timeouts: GateLine[],
  noCoverage: GateLine[],
  stale: Array<{ file: string; reason: string }>,
  summary: Record<string, unknown>,
): string {
  const lines: string[] = [];
  for (const item of [...survivors, ...unverified, ...timeouts, ...noCoverage]) {
    lines.push(...formatItemText(item));
  }
  for (const s of stale) {
    lines.push(`stale: ${s.file}: ${s.reason}`);
  }
  const parts = Object.entries(summary)
    .filter(([field]) => field !== 'kind')
    .map(([field, value]) => `${field}=${String(value)}`);
  lines.push(`summary: ${parts.join(' ')}`);
  return lines.join('\n');
}

export interface GateResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GateArgs {
  input: string;
  since?: string;
  baseline?: string;
  format: 'jsonl' | 'github' | 'text';
}

function parseJsonl(text: string): GateLine[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as GateLine);
}

function readBaselineSurvivorKeys(path: string): Set<string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new GateUsageError(`cannot read ${path}: ${(err as Error).message}`);
  }
  let lines: GateLine[];
  try {
    lines = parseJsonl(text);
  } catch (err) {
    throw new GateUsageError(`cannot parse ${path} as JSONL: ${(err as Error).message}`);
  }
  return new Set(
    lines.filter((l) => l.kind === 'survivor').map((l) => l.key ?? ''),
  );
}

function readBaselineSurvivors(path: string): GateLine[] {
  const text = readFileSync(path, 'utf8');
  return parseJsonl(text).filter((l) => l.kind === 'survivor');
}

/**
 * Runs `gate` end to end and returns its output and exit code, without
 * calling `process.exit`, so a test can call it in-process.
 */
export function runGate(args: GateArgs, cwd: string): GateResult {
  let text: string;
  try {
    text = readFileSync(args.input, 'utf8');
  } catch (err) {
    return { exitCode: 2, stdout: '', stderr: `usage error: cannot read ${args.input}: ${(err as Error).message}\n` };
  }
  let lines: GateLine[];
  try {
    lines = parseJsonl(text);
  } catch (err) {
    return { exitCode: 2, stdout: '', stderr: `usage error: cannot parse ${args.input} as JSONL: ${(err as Error).message}\n` };
  }
  if (lines.length === 0 || lines[lines.length - 1].kind !== 'summary') {
    return {
      exitCode: 3,
      stdout: '',
      stderr: `${args.input} has no summary line; the run did not finish\n`,
    };
  }

  const runLine = lines.find((l) => l.kind === 'run');
  const summaryLine = lines[lines.length - 1];
  let survivors = lines.filter((l) => l.kind === 'survivor');
  let unverified = lines.filter((l) => l.kind === 'unverified');
  let timeouts = lines.filter((l) => l.kind === 'timeout');
  let noCoverage = lines.filter((l) => l.kind === 'noCoverage');

  let stale: Array<{ file: string; reason: string }> = [];
  let stderr = '';

  if (args.since) {
    if (!gitAvailable(cwd)) {
      return { exitCode: 2, stdout: '', stderr: 'usage error: --since needs git, and it is not on PATH\n' };
    }
    if (!gitRefExists(args.since, cwd)) {
      return { exitCode: 2, stdout: '', stderr: `usage error: --since ref not found: ${args.since}\n` };
    }
    const scopedFiles = new Set<string>();
    const hashByFile = new Map<string, string>();
    for (const item of [...survivors, ...unverified, ...timeouts, ...noCoverage]) {
      if (item.file) scopedFiles.add(item.file);
      if (item.file && item.sourceHash && !hashByFile.has(item.file)) {
        hashByFile.set(item.file, item.sourceHash);
      }
    }
    const { changedRangesByFile, staleFiles } = scopeSince(
      [...scopedFiles],
      hashByFile,
      args.since,
      cwd,
    );
    const rangesFor = (file: string) => changedRangesByFile.get(file) ?? [];
    const filterScoped = (items: GateLine[]) =>
      items.filter((item) => {
        if (!item.file || !item.location || staleFiles.has(item.file)) return false;
        return overlaps(item.location.start.line, item.location.end.line, rangesFor(item.file));
      });
    survivors = filterScoped(survivors);
    unverified = filterScoped(unverified);
    timeouts = filterScoped(timeouts);
    noCoverage = filterScoped(noCoverage);
    stale = [...staleFiles.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([file, reason]) => ({ file, reason }));
    for (const s of stale) {
      stderr += `warning: ${s.file}: ${s.reason}\n`;
    }
  }

  let newSurvivors: GateLine[] | undefined;
  let fixedSurvivors: Array<{ key: string; file: string; mutatorName: string; original: string; replacement: string | undefined; location: unknown }> | undefined;

  if (args.baseline) {
    let baselineKeys: Set<string>;
    let baselineSurvivors: GateLine[];
    try {
      baselineKeys = readBaselineSurvivorKeys(args.baseline);
      baselineSurvivors = readBaselineSurvivors(args.baseline);
    } catch (err) {
      if (err instanceof GateUsageError) {
        return { exitCode: 2, stdout: '', stderr: `usage error: ${err.message}\n` };
      }
      throw err;
    }
    newSurvivors = survivors.filter((s) => !baselineKeys.has(s.key ?? ''));
    const currentSurvivorKeys = new Set(survivors.map((s) => s.key ?? ''));
    const currentUnverifiedKeys = new Set(unverified.map((u) => u.key ?? ''));
    fixedSurvivors = baselineSurvivors
      .filter(
        (b) =>
          !currentSurvivorKeys.has(b.key ?? '') &&
          !currentUnverifiedKeys.has(b.key ?? ''),
      )
      .map((b) => ({
        key: b.key ?? '',
        file: b.file ?? '',
        mutatorName: b.mutatorName ?? '',
        original: b.original ?? '',
        replacement: b.replacement,
        location: b.location,
      }));
  }

  const staticTimeoutCount = timeouts.filter((t) => t.static === true).length;
  if (staticTimeoutCount > 0) {
    stderr += `warning: ${staticTimeoutCount} static mutant timeout(s); reread before trusting the count\n`;
  }

  let exitCode: number;
  if (stale.length > 0 || unverified.length > 0) {
    exitCode = 3;
  } else if (
    (args.baseline ? (newSurvivors?.length ?? 0) > 0 : survivors.length > 0) ||
    noCoverage.length > 0
  ) {
    exitCode = 1;
  } else {
    exitCode = 0;
  }

  let body: string;
  if (args.format === 'github') {
    body = formatGithub(survivors, noCoverage, unverified, stale).join('\n');
  } else if (args.format === 'text') {
    body = formatText(survivors, unverified, timeouts, noCoverage, stale, summaryLine);
  } else {
    const newKeys = newSurvivors ? new Set(newSurvivors.map((s) => s.key)) : undefined;
    const outLines: unknown[] = [];
    if (runLine) outLines.push(runLine);
    for (const s of stale) {
      outLines.push({ kind: 'stale', ...s });
    }
    for (const s of survivors) {
      outLines.push(newKeys ? { ...s, new: newKeys.has(s.key) } : s);
    }
    for (const u of unverified) outLines.push(u);
    for (const t of timeouts) outLines.push(t);
    for (const n of noCoverage) outLines.push(n);
    if (fixedSurvivors) {
      for (const f of fixedSurvivors) {
        outLines.push({ kind: 'fixedSurvivor', ...f });
      }
    }
    const outSummary: Record<string, unknown> = { ...summaryLine };
    if (args.since) {
      outSummary.scoped = true;
      outSummary.staleCount = stale.length;
    }
    if (args.baseline) {
      outSummary.newSurvivors = newSurvivors?.length ?? 0;
      outSummary.fixedSurvivors = fixedSurvivors?.length ?? 0;
    }
    outLines.push(outSummary);
    body = outLines.map((line) => JSON.stringify(line)).join('\n');
  }

  return { exitCode, stdout: `${body}\n`, stderr };
}
