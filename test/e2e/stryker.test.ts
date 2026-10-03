/**
 * Runs the built plugin against a real Stryker mutation test run, over a
 * small fixture project (`test/e2e/fixture/`), and checks the shape of the
 * JSONL file the reporter writes. Needs `dist/index.js`; run `npm run
 * build` first.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..', '..');
const pluginEntry = path.join(packageRoot, 'dist', 'index.js');
const strykerBin = path.join(
  packageRoot,
  'node_modules',
  '@stryker-mutator',
  'core',
  'bin',
  'stryker.js',
);

function parseJsonl(content: string): any[] {
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function requireBuiltPlugin(): void {
  if (!existsSync(pluginEntry)) {
    throw new Error(
      `${pluginEntry} does not exist. Run "npm run build" before "npm run test:e2e".`,
    );
  }
}

function prepareProject(): string {
  const projectDir = mkdtempSync(path.join(tmpdir(), 'agent-reporter-e2e-'));
  cpSync(path.join(here, 'fixture'), projectDir, { recursive: true });

  const config = {
    mutate: ['src/math.js'],
    testRunner: 'command',
    // `node --test test/` (a directory argument) fails on Node 26.7.0
    // with "Cannot find module …/test", observed by hand in a sandbox
    // this same run produced. Auto-discovery (no argument) finds the
    // same files and works.
    commandRunner: { command: 'node --test' },
    coverageAnalysis: 'off',
    reporters: ['agent'],
    plugins: [pluginEntry],
    concurrency: 1,
    timeoutMS: 30000,
    logLevel: 'error',
    tempDirName: path.join(projectDir, '.stryker-tmp'),
  };
  writeFileSync(
    path.join(projectDir, 'stryker.config.json'),
    JSON.stringify(config, null, 2),
  );
  return projectDir;
}

function runStryker(projectDir: string, extraArgs: string[] = []): void {
  // `node --test` (running this very file) sets `NODE_TEST_CONTEXT` and
  // `NODE_TEST_WORKER_ID` in this process's environment. Left in place,
  // the sandbox's own `node --test` inherits them: observed on Node
  // 26.7.0, every mutant then survives (summary `killed: 0` of 6), where
  // running the same config from a plain `node -e` script gives `killed:
  // 4`. Deleting both env vars for the child restores that.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;

  execFileSync(
    process.execPath,
    [strykerBin, 'run', 'stryker.config.json', ...extraArgs],
    { cwd: projectDir, stdio: 'pipe', env: childEnv },
  );
}

function readFinalReport(projectDir: string): any[] {
  const reportFile = path.join(projectDir, 'reports', 'mutation', 'agent.jsonl');
  assert.ok(
    existsSync(reportFile),
    `expected ${reportFile} to exist after the run`,
  );
  return parseJsonl(readFileSync(reportFile, 'utf-8'));
}

describe('the agent reporter, run through real Stryker', () => {
  it('writes a run line, a summary line, and at least one survivor', () => {
    requireBuiltPlugin();
    const projectDir = prepareProject();
    runStryker(projectDir);
    const lines = readFinalReport(projectDir);

    assert.equal(lines[0].kind, 'run');
    const summary = lines[lines.length - 1];
    assert.equal(summary.kind, 'summary');
    // A positive `killed` count is what tells this run apart from a run
    // whose command never executed the fixture's own tests: with no test
    // run at all, every mutant would surface as `survivor` instead.
    assert.ok(summary.killed > 0, 'expected at least one killed mutant');
    const survivors = lines.filter((line) => line.kind === 'survivor');
    assert.ok(survivors.length >= 1, 'expected at least one survivor');

    const partialFile = path.join(
      projectDir,
      'reports',
      'mutation',
      'agent.partial.jsonl',
    );
    assert.ok(existsSync(partialFile), `expected ${partialFile} to exist`);
    const partialLines = parseJsonl(readFileSync(partialFile, 'utf-8'));
    assert.equal(partialLines[0].kind, 'run');
    const finalScopes = lines.filter((line) => line.kind === 'scope');
    const partialScopes = partialLines.filter((line) => line.kind === 'scope');
    assert.ok(partialScopes.every((line) => !('pending' in line)));
    assert.deepEqual(
      partialScopes.map((line) => JSON.stringify(line)),
      finalScopes.map(({ pending: _pending, ...line }) => JSON.stringify(line)),
    );
    for (const scope of finalScopes) {
      assert.equal(new Set(scope.keys).size, scope.keys.length);
    }
  });

  it('gives a mutant the same key when the mutate range narrows to it', () => {
    requireBuiltPlugin();
    const projectDir = prepareProject();
    runStryker(projectDir);
    const wide = readFinalReport(projectDir);
    const survivor = wide.find((line) => line.kind === 'survivor');
    assert.ok(survivor, 'expected at least one survivor in the wide run');

    const range = /--mutate "([^"]+)"/.exec(survivor.rerunExact)?.[1];
    assert.ok(range, 'expected rerunExact to carry a --mutate range');
    runStryker(projectDir, ['--force', '--mutate', range]);
    const narrow = readFinalReport(projectDir);

    assert.deepEqual(narrow[0].mutate, [range]);
    const narrowSurvivor = narrow.find((line) => line.kind === 'survivor');
    assert.ok(narrowSurvivor, 'expected the narrowed run to report the survivor');
    assert.equal(narrowSurvivor.key, survivor.key);
    const wideScope = wide.find((line) => line.kind === 'scope');
    const narrowScope = narrow.find((line) => line.kind === 'scope');
    assert.ok(narrowScope.keys.includes(survivor.key));
    assert.ok(narrowScope.keys.length < wideScope.keys.length);
    for (const key of narrowScope.keys) {
      assert.ok(wideScope.keys.includes(key), `narrow key ${key} is in the wide scope`);
    }
  });
});
