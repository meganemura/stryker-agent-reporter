// Responsibility: exercises `gate.ts` against real temporary files and, for
// `--since`, a real git repository: exit codes 0/1/2/3, scoping to changed
// lines, staleness, `--baseline`, and the escaping `--format github` needs.
// Boundary: does not run Stryker; every agent.jsonl here is a synthetic
// fixture written directly to a temp file.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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

const runLine = { kind: 'run', schemaVersion: '2', tool: 'stryker', strykerVersion: '10.0.0', disableBail: false, concurrency: undefined };

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
    // Exit code 3: `nowUnverified` outranks the new survivor.
    assert.equal(result.exitCode, 3);
  });
});

describe('gate: --since', { skip: !gitAvailable && 'git is not installed' }, () => {
  function initRepo(dir: string): void {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
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
    const file = writeAgentJsonl(dir, [runLine, changedSurvivor, unchangedSurvivor, summaryLine]);

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
    const file = writeAgentJsonl(dir, [runLine, s, summaryLine]);

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
    const file = writeAgentJsonl(dir, [runLine, s, summaryLine]);

    const result = runGate({ input: file, since: ref, format: 'jsonl' }, dir);
    assert.equal(result.exitCode, 3);
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[1].kind, 'stale');
    assert.equal(lines[1].file, 'src/f.ts');
    assert.match(result.stderr, /warning: src\/f\.ts/);
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
