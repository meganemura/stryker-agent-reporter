// Responsibility: exercises `gate.ts` against real temporary files and, for
// `--since`, a real git repository: exit codes 0/1/2/3, scoping to changed
// lines, staleness, `--baseline`, and the escaping `--format github` needs.
// Boundary: does not run Stryker; every agent.jsonl here is a synthetic
// fixture written directly to a temp file.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runGate } from '../src/gate.ts';
import type { GateArgs } from '../src/gate.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;

function writeAgentJsonl(dir: string, lines: unknown[]): string {
  const file = path.join(dir, 'agent.jsonl');
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const runLine = { kind: 'run', schemaVersion: '3', tool: 'stryker', strykerVersion: '10.0.0', disableBail: false, concurrency: undefined };

function scopeLine(
  file: string,
  keys: string[],
  pending: string[] = [],
  sourceHash = 'abc123abc123abcd',
) {
  return { kind: 'scope', file, sourceHash, keys, pending };
}

function survivor(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'survivor',
    key: 'k1',
    file: 'src/a.ts',
    location: { start: { line: 2, column: 10 }, end: { line: 2, column: 15 } },
    mutatorName: 'ArithmeticOperator',
    replacement: 'x - 1',
    original: 'x + 1',
    static: false,
    sourceHash: 'abc123abc123abcd',
    tests: { total: 1, truncated: false, files: [] },
    rerun: 'npx stryker run --incremental --mutate "src/a.ts"',
    rerunExact: 'npx stryker run --force --mutate "src/a.ts:2:9-2:14"',
    patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2,1 +2,1 @@\n-  x + 1\n+  x - 1\n',
    ...overrides,
  };
}

const summaryLine = {
  kind: 'summary',
  total: 1,
  killed: 0,
  timeout: 0,
  survived: 1,
  noCoverage: 0,
  compileError: 0,
  runtimeError: 0,
  ignored: 0,
  pending: 0,
  unverified: 0,
  mutationScore: 0,
  mutationScoreBasedOnCoveredCode: 0,
};

function baseArgs(input: string): GateArgs {
  return { input, format: 'jsonl' };
}

describe('gate: exit codes', () => {
  it('exits 0 when there is nothing to act on', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-ok-'));
    const file = writeAgentJsonl(dir, [runLine, summaryLine]);
    const result = runGate(baseArgs(file), dir);
    assert.equal(result.exitCode, 0);
  });

  it('exits 1 when a survivor remains', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-survivor-'));
    const file = writeAgentJsonl(dir, [runLine, survivor(), summaryLine]);
    const result = runGate(baseArgs(file), dir);
    assert.equal(result.exitCode, 1);
  });

  it('exits 1 when a noCoverage mutant remains', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-nocoverage-'));
    const noCoverage = {
      kind: 'noCoverage',
      key: 'k2',
      file: 'src/b.ts',
      location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
      mutatorName: 'BooleanLiteral',
      replacement: 'false',
      original: 'true',
    };
    const file = writeAgentJsonl(dir, [runLine, noCoverage, summaryLine]);
    const result = runGate(baseArgs(file), dir);
    assert.equal(result.exitCode, 1);
  });

  it('exits 2 when the input file cannot be read', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-missing-'));
    const result = runGate(baseArgs(path.join(dir, 'missing.jsonl')), dir);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /usage error/);
  });

  it('exits 3 when a mutant is unverified', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-unverified-'));
    const unverified = survivor({ kind: 'unverified' });
    const file = writeAgentJsonl(dir, [runLine, unverified, summaryLine]);
    const result = runGate(baseArgs(file), dir);
    assert.equal(result.exitCode, 3);
  });

  it('exits 3 when the input has no summary line (an unfinished run)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-unfinished-'));
    const file = writeAgentJsonl(dir, [runLine, survivor()]);
    const result = runGate(baseArgs(file), dir);
    assert.equal(result.exitCode, 3);
    assert.match(result.stderr, /did not finish/);
  });

  it('exits 3, not 2, when the input is empty (an unfinished run)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-empty-'));
    const file = path.join(dir, 'agent.jsonl');
    writeFileSync(file, '');
    const result = runGate(baseArgs(file), dir);
    assert.equal(result.exitCode, 3);
    assert.match(result.stderr, /did not finish/);
  });
});

describe('gate: --format github', () => {
  it('renders a survivor as ::error and escapes %, \\r, and \\n', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-github-'));
    const s = survivor({ original: '100% "x"\ry\nz', replacement: 'x - 1' });
    const file = writeAgentJsonl(dir, [runLine, s, summaryLine]);
    const result = runGate({ input: file, format: 'github' }, dir);
    assert.match(result.stdout, /^::error file=src\/a\.ts,line=2,endLine=2,title=ArithmeticOperator survived::/m);
    assert.match(result.stdout, /100%25/);
    assert.match(result.stdout, /%0D/);
    assert.match(result.stdout, /%0A/);
  });

  it('renders unverified as ::warning', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-github-warn-'));
    const u = survivor({ kind: 'unverified' });
    const file = writeAgentJsonl(dir, [runLine, u, summaryLine]);
    const result = runGate({ input: file, format: 'github' }, dir);
    assert.match(result.stdout, /^::warning file=src\/a\.ts,line=2,endLine=2,title=unverified::/m);
  });
});

describe('gate: --baseline', () => {
  it('reports a new survivor and a fixed survivor, excluding an unverified one from fixed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-baseline-'));
    const baselineSurvivor = survivor({ key: 'old1', file: 'src/old.ts' });
    const fixedByRerun = survivor({ key: 'old2', file: 'src/fixed.ts' });
    const stillUnverified = survivor({ key: 'old3', file: 'src/gap.ts' });
    const baselineFile = writeAgentJsonl(path.join(dir), [
      runLine,
      baselineSurvivor,
      fixedByRerun,
      stillUnverified,
      summaryLine,
    ]);

    const currentSurvivor = survivor({ key: 'old1', file: 'src/old.ts' });
    const newSurvivor = survivor({ key: 'new1', file: 'src/new.ts' });
    const nowUnverified = survivor({ key: 'old3', file: 'src/gap.ts', kind: 'unverified' });
    const currentDir = mkdtempSync(path.join(tmpdir(), 'gate-baseline-current-'));
    const currentFile = writeAgentJsonl(currentDir, [
      runLine,
      scopeLine('src/fixed.ts', ['old2']),
      scopeLine('src/gap.ts', ['old3']),
      scopeLine('src/new.ts', ['new1']),
      scopeLine('src/old.ts', ['old1']),
      currentSurvivor,
      newSurvivor,
      nowUnverified,
      summaryLine,
    ]);

    const result = runGate(
      { input: currentFile, baseline: baselineFile, format: 'jsonl' },
      currentDir,
    );
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const newLine = lines.find((l) => l.kind === 'survivor' && l.key === 'new1');
    const oldLine = lines.find((l) => l.kind === 'survivor' && l.key === 'old1');
    assert.equal(newLine.new, true);
    assert.equal(oldLine.new, false);
    const fixed = lines.filter((l) => l.kind === 'fixedSurvivor').map((l) => l.key);
    assert.deepEqual(fixed, ['old2']);
    const summary = lines[lines.length - 1];
    assert.equal(summary.newSurvivors, 1);
    assert.equal(summary.fixedSurvivors, 1);
    assert.equal(summary.outOfScope, 0);
    // Exit code 3: `nowUnverified` outranks the new survivor.
    assert.equal(result.exitCode, 3);
  });

  it('marks an absent in-scope survivor fixed and an absent out-of-scope survivor', () => {
    const baselineDir = mkdtempSync(path.join(tmpdir(), 'gate-baseline-scope-base-'));
    const currentDir = mkdtempSync(path.join(tmpdir(), 'gate-baseline-scope-current-'));
    const survivorA = survivor({ key: 'A' });
    const survivorB = survivor({ key: 'B' });
    const baselineFile = writeAgentJsonl(baselineDir, [runLine, survivorA, survivorB, summaryLine]);
    const currentFile = writeAgentJsonl(currentDir, [
      runLine,
      scopeLine('src/a.ts', ['A']),
      summaryLine,
    ]);

    const result = runGate(
      { input: currentFile, baseline: baselineFile, format: 'jsonl' },
      currentDir,
    );
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.filter((line) => line.kind === 'fixedSurvivor'), [{
      kind: 'fixedSurvivor',
      key: 'A',
      file: 'src/a.ts',
      mutatorName: 'ArithmeticOperator',
      original: 'x + 1',
      replacement: 'x - 1',
      location: { start: { line: 2, column: 10 }, end: { line: 2, column: 15 } },
    }]);
    assert.deepEqual(lines.filter((line) => line.kind === 'outOfScope'), [{
      kind: 'outOfScope',
      key: 'B',
      file: 'src/a.ts',
      mutatorName: 'ArithmeticOperator',
      original: 'x + 1',
      replacement: 'x - 1',
      location: { start: { line: 2, column: 10 }, end: { line: 2, column: 15 } },
    }]);
    const summary = lines[lines.length - 1];
    assert.equal(summary.fixedSurvivors, 1);
    assert.equal(summary.outOfScope, 1);
    assert.equal(result.exitCode, 0);

    const textResult = runGate(
      { input: currentFile, baseline: baselineFile, format: 'text' },
      currentDir,
    );
    assert.match(textResult.stdout, /summary: .*outOfScope=1/);
  });

  it('marks both survivors out of scope when the file has no scope line', () => {
    const baselineDir = mkdtempSync(path.join(tmpdir(), 'gate-baseline-no-scope-base-'));
    const currentDir = mkdtempSync(path.join(tmpdir(), 'gate-baseline-no-scope-current-'));
    const baselineFile = writeAgentJsonl(baselineDir, [
      runLine,
      survivor({ key: 'A' }),
      survivor({ key: 'B' }),
      summaryLine,
    ]);
    const currentFile = writeAgentJsonl(currentDir, [runLine, summaryLine]);

    const result = runGate(
      { input: currentFile, baseline: baselineFile, format: 'jsonl' },
      currentDir,
    );
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.filter((line) => line.kind === 'outOfScope').map((line) => line.key),
      ['A', 'B'],
    );
    assert.equal(lines.some((line) => line.kind === 'fixedSurvivor'), false);
    assert.equal(lines[lines.length - 1].outOfScope, 2);
    assert.equal(result.exitCode, 0);
  });

  it('does not classify a pending baseline survivor', () => {
    const baselineDir = mkdtempSync(path.join(tmpdir(), 'gate-baseline-pending-base-'));
    const currentDir = mkdtempSync(path.join(tmpdir(), 'gate-baseline-pending-current-'));
    const baselineFile = writeAgentJsonl(baselineDir, [runLine, survivor({ key: 'K' }), summaryLine]);
    const currentFile = writeAgentJsonl(currentDir, [
      runLine,
      scopeLine('src/a.ts', ['K'], ['K']),
      summaryLine,
    ]);

    const result = runGate(
      { input: currentFile, baseline: baselineFile, format: 'jsonl' },
      currentDir,
    );
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.some((line) => line.kind === 'fixedSurvivor'), false);
    assert.equal(lines.some((line) => line.kind === 'outOfScope'), false);
    assert.equal(lines[lines.length - 1].fixedSurvivors, 0);
    assert.equal(lines[lines.length - 1].outOfScope, 0);
    assert.equal(result.exitCode, 0);
  });

  it('marks an in-scope timeout as a fixed baseline survivor', () => {
    const baselineDir = mkdtempSync(path.join(tmpdir(), 'gate-baseline-timeout-base-'));
    const currentDir = mkdtempSync(path.join(tmpdir(), 'gate-baseline-timeout-current-'));
    const baselineFile = writeAgentJsonl(baselineDir, [runLine, survivor({ key: 'K' }), summaryLine]);
    const currentFile = writeAgentJsonl(currentDir, [
      runLine,
      scopeLine('src/a.ts', ['K']),
      survivor({ kind: 'timeout', key: 'K' }),
      summaryLine,
    ]);

    const result = runGate(
      { input: currentFile, baseline: baselineFile, format: 'jsonl' },
      currentDir,
    );
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.filter((line) => line.kind === 'fixedSurvivor').map((line) => line.key), ['K']);
    assert.equal(lines.some((line) => line.kind === 'outOfScope'), false);
    assert.equal(result.exitCode, 0);
  });

  it('rejects schema version 2 in the input and baseline files', () => {
    const inputDir = mkdtempSync(path.join(tmpdir(), 'gate-schema-input-'));
    const currentDir = mkdtempSync(path.join(tmpdir(), 'gate-schema-current-'));
    const baselineDir = mkdtempSync(path.join(tmpdir(), 'gate-schema-baseline-'));
    const oldRunLine = { ...runLine, schemaVersion: '2' };
    const oldInput = writeAgentJsonl(inputDir, [oldRunLine, summaryLine]);
    const inputResult = runGate(baseArgs(oldInput), inputDir);
    assert.equal(inputResult.exitCode, 2);
    assert.equal(
      inputResult.stderr,
      `usage error: ${oldInput} has schemaVersion 2; gate reads 3. Rebuild it with convert from its mutation.json\n`,
    );

    const currentInput = writeAgentJsonl(currentDir, [runLine, summaryLine]);
    const oldBaseline = writeAgentJsonl(baselineDir, [oldRunLine, survivor(), summaryLine]);
    const baselineResult = runGate(
      { input: currentInput, baseline: oldBaseline, format: 'jsonl' },
      currentDir,
    );
    assert.equal(baselineResult.exitCode, 2);
    assert.equal(
      baselineResult.stderr,
      `usage error: ${oldBaseline} has schemaVersion 2; gate reads 3. Rebuild it with convert from its mutation.json\n`,
    );
  });
});

describe('gate: --since', { skip: !gitAvailable && 'git is not installed' }, () => {
  function initRepo(dir: string): void {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  }

  function noCoverageWithStaleScope() {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-since-nocoverage-stale-'));
    initRepo(dir);
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'f.ts'), 'export const a = true;\n');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const noCoverage = {
      kind: 'noCoverage',
      key: 'N',
      file: 'src/f.ts',
      location: { start: { line: 1, column: 17 }, end: { line: 1, column: 21 } },
      mutatorName: 'BooleanLiteral',
      replacement: 'false',
      original: 'true',
    };
    const file = writeAgentJsonl(dir, [
      runLine,
      scopeLine('src/f.ts', ['N'], [], '0000000000000000'),
      noCoverage,
      { ...summaryLine, noCoverage: 1 },
    ]);
    return { dir, ref, file };
  }

  it('scopes survivors to a changed-line range', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-since-'));
    initRepo(dir);
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    const original = 'export function a(x) {\n  return x + 1;\n}\n\nexport function b(x) {\n  return x + 2;\n}\n';
    writeFileSync(path.join(dir, 'src', 'f.ts'), original);
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

    const changed = 'export function a(x) {\n  return x + 100;\n}\n\nexport function b(x) {\n  return x + 2;\n}\n';
    writeFileSync(path.join(dir, 'src', 'f.ts'), changed);
    const hash = execFileSync(
      'node',
      ['-e', "const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex').slice(0,16))", path.join(dir, 'src', 'f.ts')],
      { encoding: 'utf8' },
    );

    const changedSurvivor = survivor({ key: 'sc', file: 'src/f.ts', location: { start: { line: 2, column: 10 }, end: { line: 2, column: 19 } }, sourceHash: hash });
    const unchangedSurvivor = survivor({ key: 'su', file: 'src/f.ts', location: { start: { line: 6, column: 10 }, end: { line: 6, column: 17 } }, sourceHash: hash });
    const file = writeAgentJsonl(dir, [
      runLine,
      scopeLine('src/f.ts', ['sc', 'su'], [], hash),
      changedSurvivor,
      unchangedSurvivor,
      summaryLine,
    ]);

    const result = runGate({ input: file, since: ref, format: 'jsonl' }, dir);
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const survivorKeys = lines.filter((l) => l.kind === 'survivor').map((l) => l.key);
    assert.deepEqual(survivorKeys, ['sc']);
  });

  it('treats an untracked file as changed on every line', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-since-untracked-'));
    initRepo(dir);
    writeFileSync(path.join(dir, 'README.md'), 'placeholder\n');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

    mkdirSync(path.join(dir, 'src'), { recursive: true });
    const source = 'export function a(x) {\n  return x + 1;\n}\n';
    writeFileSync(path.join(dir, 'src', 'new.ts'), source);
    const hash = execFileSync(
      'node',
      ['-e', "const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex').slice(0,16))", path.join(dir, 'src', 'new.ts')],
      { encoding: 'utf8' },
    );

    const s = survivor({ key: 'sn', file: 'src/new.ts', location: { start: { line: 2, column: 10 }, end: { line: 2, column: 15 } }, sourceHash: hash });
    const file = writeAgentJsonl(dir, [
      runLine,
      scopeLine('src/new.ts', ['sn'], [], hash),
      s,
      summaryLine,
    ]);

    const result = runGate({ input: file, since: ref, format: 'jsonl' }, dir);
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.filter((l) => l.kind === 'survivor').length, 1, 'a never-tracked file counts as changed on every line');
  });

  it('marks a file stale when its content no longer matches sourceHash, and exits 3', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-since-stale-'));
    initRepo(dir);
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'f.ts'), 'export const a = 1;\n');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    writeFileSync(path.join(dir, 'src', 'f.ts'), 'export const a = 999;\n');

    const s = survivor({ key: 'sf', file: 'src/f.ts', sourceHash: 'not-the-real-hash-0' });
    const file = writeAgentJsonl(dir, [
      runLine,
      scopeLine('src/f.ts', ['sf'], [], 'not-the-real-hash-0'),
      s,
      summaryLine,
    ]);

    const result = runGate({ input: file, since: ref, format: 'jsonl' }, dir);
    assert.equal(result.exitCode, 3);
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[1].kind, 'scope');
    assert.equal(lines[2].kind, 'stale');
    assert.equal(lines[2].file, 'src/f.ts');
    assert.match(result.stderr, /warning: src\/f\.ts/);
  });

  it('marks a noCoverage-only file stale from its scope hash', () => {
    const { dir, ref, file } = noCoverageWithStaleScope();
    const result = runGate({ input: file, since: ref, format: 'jsonl' }, dir);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.filter((line) => line.kind === 'stale'), [{
      kind: 'stale',
      file: 'src/f.ts',
      reason: 'source no longer matches the report; cannot scope by line',
    }]);
    assert.equal(result.exitCode, 3);
  });

  it('writes scope lines after run and before stale lines in JSONL output', () => {
    const { dir, ref, file } = noCoverageWithStaleScope();
    const result = runGate({ input: file, since: ref, format: 'jsonl' }, dir);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.kind), ['run', 'scope', 'stale', 'summary']);
  });

  it('does not mark a file stale when every mutant of it was killed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-since-all-killed-'));
    initRepo(dir);
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'f.ts'), 'export const a = 1;\n');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    writeFileSync(path.join(dir, 'src', 'f.ts'), 'export const a = 2;\n');

    const file = writeAgentJsonl(dir, [
      runLine,
      scopeLine('src/f.ts', ['K'], [], '0000000000000000'),
      { ...summaryLine, killed: 1, survived: 0 },
    ]);

    const result = runGate({ input: file, since: ref, format: 'jsonl' }, dir);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.kind), ['run', 'scope', 'summary']);
    assert.equal(result.exitCode, 0);
  });

  it('does not call a survivor fixed when --since leaves it out of the changed lines', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-since-baseline-'));
    initRepo(dir);
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(
      path.join(dir, 'src', 'f.ts'),
      'export function a(x) {\n  return x + 1;\n}\n\nexport function b(x) {\n  return x + 2;\n}\n',
    );
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const changed =
      'export function a(x) {\n  return x + 100;\n}\n\nexport function b(x) {\n  return x + 2;\n}\n';
    writeFileSync(path.join(dir, 'src', 'f.ts'), changed);
    const hash = createHash('sha256').update(changed).digest('hex').slice(0, 16);

    const onChangedLine = survivor({ key: 'sc', file: 'src/f.ts', location: { start: { line: 2, column: 10 }, end: { line: 2, column: 19 } }, sourceHash: hash });
    const onUnchangedLine = survivor({ key: 'su', file: 'src/f.ts', location: { start: { line: 6, column: 10 }, end: { line: 6, column: 17 } }, sourceHash: hash });
    const current = writeAgentJsonl(dir, [
      runLine,
      scopeLine('src/f.ts', ['sc', 'su'], [], hash),
      onChangedLine,
      onUnchangedLine,
      summaryLine,
    ]);
    const baselineDir = mkdtempSync(path.join(tmpdir(), 'gate-since-baseline-base-'));
    const baseline = writeAgentJsonl(baselineDir, [
      runLine,
      scopeLine('src/f.ts', ['sc', 'su'], [], hash),
      onChangedLine,
      onUnchangedLine,
      summaryLine,
    ]);

    const result = runGate({ input: current, since: ref, baseline, format: 'jsonl' }, dir);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.filter((line) => line.kind === 'fixedSurvivor'), []);
    assert.deepEqual(lines.filter((line) => line.kind === 'outOfScope'), []);
    const summary = lines[lines.length - 1];
    assert.equal(summary.fixedSurvivors, 0);
    assert.equal(summary.outOfScope, 0);
  });

  it('exits 2 for an unknown git ref', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-since-badref-'));
    initRepo(dir);
    const file = writeAgentJsonl(dir, [runLine, summaryLine]);
    const result = runGate({ input: file, since: 'no-such-ref', format: 'jsonl' }, dir);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /usage error/);
  });
});
