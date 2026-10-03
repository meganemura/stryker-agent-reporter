import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { PlanKind } from '@stryker-mutator/api/core';
import type { schema, StrykerOptions } from '@stryker-mutator/api/core';
import type { MutationTestingPlanReadyEvent } from '@stryker-mutator/api/report';
import type { Logger } from '@stryker-mutator/api/logging';
import { calculateMutationTestMetrics } from 'mutation-testing-metrics';

import {
  AgentReporter,
  partialFileIO,
  partialFileNameFor,
} from '../src/agent-reporter.ts';
import type { AgentReporterOptions } from '../src/agent-reporter.ts';

/**
 * `function add(a, b, c) {\n  return a + b + c;\n}\n`: two distinct
 * `ArithmeticOperator` sites (both `+` to `-`) exercise site-based keys.
 * One `Survived` mutant with no completed test exercises `unverified`.
 */
const fileSource = 'function add(a, b, c) {\n  return a + b + c;\n}\n';

function buildLogger(): Logger {
  const noop = () => undefined;
  return {
    isTraceEnabled: () => false,
    isDebugEnabled: () => false,
    isInfoEnabled: () => false,
    isWarnEnabled: () => false,
    isErrorEnabled: () => false,
    isFatalEnabled: () => false,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  } as unknown as Logger;
}

function buildOptions(
  overrides: Partial<StrykerOptions> = {},
  agentReporter: AgentReporterOptions = {
    fileName: 'reports/mutation/agent.jsonl',
    partial: true,
  },
): StrykerOptions & { agentReporter: AgentReporterOptions } {
  return {
    disableBail: false,
    concurrency: undefined,
    tempDirName: '.stryker-tmp',
    inPlace: false,
    agentReporter,
    ...overrides,
  } as unknown as StrykerOptions & { agentReporter: AgentReporterOptions };
}

function buildReport(
  overrides: Partial<schema.MutationTestResult> = {},
): schema.MutationTestResult {
  return {
    schemaVersion: '1',
    thresholds: { high: 80, low: 60 },
    projectRoot: '/home/user/project',
    files: {
      'src/file.js': {
        language: 'js',
        source: fileSource,
        mutants: [
          {
            id: 'm1',
            location: {
              start: { line: 2, column: 12 },
              end: { line: 2, column: 13 },
            },
            mutatorName: 'ArithmeticOperator',
            replacement: '-',
            status: 'Survived',
            coveredBy: ['t1'],
            testsCompleted: 1,
            static: false,
          },
          {
            id: 'm2',
            location: {
              start: { line: 2, column: 16 },
              end: { line: 2, column: 17 },
            },
            mutatorName: 'ArithmeticOperator',
            replacement: '-',
            status: 'Survived',
            coveredBy: ['t1'],
            testsCompleted: 1,
            static: false,
          },
          {
            id: 'm3',
            location: {
              start: { line: 1, column: 1 },
              end: { line: 1, column: 2 },
            },
            mutatorName: 'Identifier',
            replacement: 'x',
            status: 'Survived',
            coveredBy: ['t1'],
            testsCompleted: 0,
            static: false,
          },
          {
            id: 'm4',
            location: {
              start: { line: 1, column: 2 },
              end: { line: 1, column: 3 },
            },
            mutatorName: 'Identifier',
            replacement: 'y',
            status: 'NoCoverage',
          },
          {
            id: 'm5',
            location: {
              start: { line: 1, column: 3 },
              end: { line: 1, column: 4 },
            },
            mutatorName: 'Identifier',
            replacement: 'z',
            status: 'Timeout',
            static: true,
            statusReason:
              'Timeout in file:///home/user/project/.stryker-tmp/sandbox-Ab12/src/file.js?vitest=1234',
          },
          {
            id: 'm6',
            location: {
              start: { line: 1, column: 4 },
              end: { line: 1, column: 5 },
            },
            mutatorName: 'Identifier',
            replacement: 'w',
            status: 'Ignored',
            statusReason:
              'excluded by file:///home/user/project/stryker.config.js in .stryker-tmp/sandbox-Zz99/src/file.js?vitest=42',
          },
          {
            id: 'm7',
            location: {
              start: { line: 1, column: 5 },
              end: { line: 1, column: 6 },
            },
            mutatorName: 'Identifier',
            replacement: 'v',
            status: 'CompileError',
            statusReason: 'compile error in .stryker-tmp/sandbox-Qq11/src/file.js',
          },
          {
            id: 'm8',
            location: {
              start: { line: 1, column: 6 },
              end: { line: 1, column: 7 },
            },
            mutatorName: 'Identifier',
            replacement: 'u',
            status: 'Killed',
            killedBy: ['t1'],
          },
          {
            id: 'm9',
            location: {
              start: { line: 1, column: 7 },
              end: { line: 1, column: 8 },
            },
            mutatorName: 'Identifier',
            replacement: 't',
            status: 'Pending',
          },
        ],
      },
    },
    testFiles: {
      'test/file.spec.js': {
        source: '',
        tests: [
          {
            id: 't1',
            name: 'adds numbers',
            location: { start: { line: 5, column: 3 } },
          },
          {
            id: 't2',
            name: 'never used',
            location: { start: { line: 10, column: 3 } },
          },
        ],
      },
    },
    ...overrides,
  } as unknown as schema.MutationTestResult;
}

function buildTestsSummaryReport(
  fileSpecs: Array<{ file: string; testNames: string[] }>,
): schema.MutationTestResult {
  const testFiles: Record<string, unknown> = {};
  const coveredBy: string[] = [];
  let id = 0;
  for (const spec of fileSpecs) {
    testFiles[spec.file] = {
      source: '',
      tests: spec.testNames.map((name) => {
        const testId = `t${id++}`;
        coveredBy.push(testId);
        return { id: testId, name };
      }),
    };
  }
  return {
    schemaVersion: '1',
    thresholds: { high: 80, low: 60 },
    projectRoot: '/home/user/project',
    files: {
      'src/file.js': {
        language: 'js',
        source: fileSource,
        mutants: [
          {
            id: 'm1',
            location: {
              start: { line: 2, column: 12 },
              end: { line: 2, column: 13 },
            },
            mutatorName: 'ArithmeticOperator',
            replacement: '-',
            status: 'Survived',
            coveredBy,
            testsCompleted: coveredBy.length,
            static: false,
          },
        ],
      },
    },
    testFiles,
  } as unknown as schema.MutationTestResult;
}

function parseJsonl(content: string): any[] {
  assert.ok(content.endsWith('\n'));
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function linesOfKind(lines: any[], kind: string): any[] {
  return lines.filter((line) => line.kind === kind);
}

function plan(mutant: any) {
  return { plan: PlanKind.Run, mutant, runOptions: {}, netTime: 0 };
}

function readyEvent(mutants: any[]): MutationTestingPlanReadyEvent {
  return {
    mutantPlans: mutants.map(plan),
  } as unknown as MutationTestingPlanReadyEvent;
}

function survivedResult(
  planFileName: string,
  overrides: Record<string, unknown> = {},
): any {
  return {
    id: 'm1',
    fileName: planFileName,
    // `Mutant.location` is 0-based; the plan carries the same 0-based
    // location `onMutantTested`'s result also carries (it is converted to
    // 1-based only when the final report is built).
    location: {
      start: { line: 1, column: 11 },
      end: { line: 1, column: 12 },
    },
    mutatorName: 'ArithmeticOperator',
    replacement: '-',
    status: 'Survived',
    coveredBy: ['t1'],
    testsCompleted: 1,
    static: false,
    ...overrides,
  };
}

describe('AgentReporter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-reporter-'));
  });

  function fileNameIn(...segments: string[]): string {
    return path.join(tmpDir, ...segments);
  }

  function readWritten(fileName: string): any[] {
    return parseJsonl(readFileSync(fileName, 'utf-8'));
  }

  async function actAndWrite(
    report: schema.MutationTestResult,
    fileName: string,
  ): Promise<any[]> {
    const sut = new AgentReporter(
      buildOptions({}, { fileName, partial: false }),
      buildLogger(),
    );
    sut.onMutationTestReportReady(report, calculateMutationTestMetrics(report));
    await sut.wrapUp();
    return readWritten(fileName);
  }

  describe('onMutationTestReportReady', () => {
    it('writes each location with start before end, as the partial file does', async () => {
      const fileName = fileNameIn('agent.jsonl');
      await actAndWrite(buildReport(), fileName);
      const text = readFileSync(fileName, 'utf-8');
      assert.match(text, /"location":\{"start":/);
      assert.doesNotMatch(text, /"location":\{"end":/);
    });

    it('writes to the configured file path', async () => {
      const fileName = fileNameIn('out', 'agent.jsonl');
      await actAndWrite(buildReport(), fileName);
      assert.ok(readFileSync(fileName, 'utf-8').length > 0);
    });

    it('uses the default file path when agentReporter has no fields', async () => {
      // A caller can pass a partial `agentReporter` (e.g. `{}`), before the
      // schema's own defaults are applied to it. The reporter must fill in
      // `fileName` itself in that case, or `path.normalize(undefined)`
      // throws.
      const previousCwd = process.cwd();
      process.chdir(tmpDir);
      try {
        const options = {
          ...buildOptions(),
          agentReporter: {},
        } as unknown as StrykerOptions & { agentReporter: AgentReporterOptions };
        const sut = new AgentReporter(options, buildLogger());
        const report = buildReport();
        sut.onMutationTestReportReady(
          report,
          calculateMutationTestMetrics(report),
        );
        await sut.wrapUp();
        assert.ok(
          existsSync(path.join(tmpDir, 'reports', 'mutation', 'agent.jsonl')),
        );
      } finally {
        process.chdir(previousCwd);
      }
    });

    it('defaults partial to true when agentReporter only sets fileName', async () => {
      const fileName = fileNameIn('agent.jsonl');
      const options = {
        ...buildOptions(),
        agentReporter: { fileName },
      } as unknown as StrykerOptions & { agentReporter: AgentReporterOptions };
      const sut = new AgentReporter(options, buildLogger());
      const sourceDir = fileNameIn('src');
      mkdirSync(sourceDir, { recursive: true });
      const sourceFile = path.join(sourceDir, 'file.js');
      writeFileSync(sourceFile, fileSource, 'utf-8');
      sut.onMutationTestingPlanReady(
        readyEvent([survivedResult(sourceFile)]),
      );
      await sut.wrapUp();
      assert.ok(existsSync(partialFileNameFor(fileName)));
    });

    it('writes a run line first, then each item kind grouped in order, then a summary line last', async () => {
      const lines = await actAndWrite(
        buildReport(),
        fileNameIn('agent.jsonl'),
      );
      assert.equal(lines[0].kind, 'run');
      assert.equal(lines[lines.length - 1].kind, 'summary');
      const expectedKindOrder = [
        'run',
        'scope',
        'survivor',
        'unverified',
        'timeout',
        'noCoverage',
        'ignored',
        'invalid',
        'testWithoutKills',
        'summary',
      ];
      const kindsInOrder = lines.map((l) => l.kind);
      const presentKinds = [...new Set(kindsInOrder)];
      const filteredExpected = expectedKindOrder.filter((k) =>
        presentKinds.includes(k),
      );
      assert.deepEqual(
        kindsInOrder.filter((k, i, arr) => arr.indexOf(k) === i),
        filteredExpected,
      );
    });

    it('puts schemaVersion, tool, strykerVersion and run options on the run line', async () => {
      const lines = await actAndWrite(
        buildReport(),
        fileNameIn('agent.jsonl'),
      );
      const run = lines[0];
      assert.equal(run.tool, 'stryker');
      assert.equal(run.schemaVersion, '3');
      assert.equal(typeof run.strykerVersion, 'string');
      assert.equal(typeof run.disableBail, 'boolean');
    });

    it('writes generated and pending keys on a scope line after the run line', async () => {
      const lines = await actAndWrite(
        buildReport(),
        fileNameIn('agent.jsonl'),
      );
      const scope = lines[1];

      assert.equal(scope.kind, 'scope');
      assert.equal(scope.file, 'src/file.js');
      assert.match(scope.sourceHash, /^[0-9a-f]{16}$/);
      assert.equal(scope.keys.length, 9);
      // The Pending mutant `m9` (line 1, columns 7 to 8, `Identifier`, `t`).
      // The key is the sha1 prefix of the documented hash input, worked out
      // by hand: file, trimmed line, start offset 6, end offset 7, mutator,
      // replacement, and 0 earlier copies of the line.
      assert.deepEqual(scope.pending, ['cc0a00c4a2c3']);
      assert.ok(scope.keys.includes('cc0a00c4a2c3'));
    });

    it('includes a configured concurrency on the run line', async () => {
      const fileName = fileNameIn('agent.jsonl');
      const sut = new AgentReporter(
        buildOptions(
          { concurrency: 4 } as Partial<StrykerOptions>,
          { fileName, partial: false },
        ),
        buildLogger(),
      );
      const report = buildReport();
      sut.onMutationTestReportReady(
        report,
        calculateMutationTestMetrics(report),
      );
      await sut.wrapUp();
      const lines = readWritten(fileName);
      assert.equal(lines[0].concurrency, 4);
    });

    it('echoes configured mutate patterns and incremental mode on the run line', async () => {
      const fileName = fileNameIn('agent.jsonl');
      const sut = new AgentReporter(
        buildOptions(
          {
            mutate: ['src/file.js:2:11-2:12'],
            incremental: true,
          } as Partial<StrykerOptions>,
          { fileName, partial: false },
        ),
        buildLogger(),
      );
      const report = buildReport();
      sut.onMutationTestReportReady(report, calculateMutationTestMetrics(report));
      await sut.wrapUp();

      const run = readWritten(fileName)[0];
      assert.deepEqual(run.mutate, ['src/file.js:2:11-2:12']);
      assert.equal(run.incremental, true);
    });

    it('reports a summary that matches the metrics', async () => {
      const report = buildReport();
      const metrics = calculateMutationTestMetrics(report);
      const lines = await actAndWrite(report, fileNameIn('agent.jsonl'));
      const summary = lines[lines.length - 1];
      const m = metrics.systemUnderTestMetrics.metrics;
      assert.deepEqual(summary, {
        kind: 'summary',
        total: m.totalMutants,
        killed: m.killed,
        timeout: m.timeout,
        survived: m.survived,
        noCoverage: m.noCoverage,
        compileError: m.compileErrors,
        runtimeError: m.runtimeErrors,
        ignored: m.ignored,
        pending: m.pending,
        unverified: 1,
        mutationScore: m.mutationScore,
        mutationScoreBasedOnCoveredCode: m.mutationScoreBasedOnCoveredCode,
      });
    });

    it('reports a survivor with its original text, patch, static, tests, rerun commands and source hash', async () => {
      const lines = await actAndWrite(
        buildReport(),
        fileNameIn('agent.jsonl'),
      );
      const survivor = linesOfKind(lines, 'survivor').find(
        (s) => s.location.start.column === 12,
      );
      assert.equal(survivor.file, 'src/file.js');
      assert.equal(survivor.mutatorName, 'ArithmeticOperator');
      assert.equal(survivor.replacement, '-');
      assert.equal(survivor.original, '+');
      assert.equal(survivor.static, false);
      assert.equal(
        survivor.rerun,
        'npx stryker run --incremental --mutate "src/file.js"',
      );
      // location columns are 1-based per the schema; `--mutate`'s range
      // matches the instrumenter's 0-based AST positions, one less on each
      // side.
      assert.equal(
        survivor.rerunExact,
        'npx stryker run --force --mutate "src/file.js:2:11-2:12"',
      );
      assert.deepEqual(survivor.tests, {
        total: 1,
        truncated: false,
        files: [
          { file: 'test/file.spec.js', count: 1, names: ['adds numbers'] },
        ],
      });
      assert.equal(
        survivor.patch,
        '--- a/src/file.js\n+++ b/src/file.js\n@@ -2,1 +2,1 @@\n-  return a + b + c;\n+  return a - b + c;\n',
      );
      assert.match(survivor.sourceHash, /^[0-9a-f]{16}$/);
    });

    it('routes a Survived mutant with testsCompleted 0 to unverified, not survivors', async () => {
      const lines = await actAndWrite(
        buildReport(),
        fileNameIn('agent.jsonl'),
      );
      const unverified = linesOfKind(lines, 'unverified');
      assert.equal(unverified.length, 1);
      assert.equal(unverified[0].location.start.line, 1);
      assert.equal(
        linesOfKind(lines, 'survivor').some(
          (s) => s.location.start.line === 1,
        ),
        false,
      );
    });

    it('gives each same-line mutation site a key from its own column', async () => {
      const lines = await actAndWrite(
        buildReport(),
        fileNameIn('agent.jsonl'),
      );
      const keys = linesOfKind(lines, 'survivor')
        .filter((s) => s.original === '+')
        .map((s) => s.key);
      assert.equal(keys.length, 2);
      assert.notEqual(keys[0], keys[1]);
      keys.forEach((key: string) => assert.match(key, /^[0-9a-f]{12}$/));
    });

    it('keeps a key stable when a line is added above the mutant', async () => {
      const before = buildReport();
      const beforeLines = await actAndWrite(before, fileNameIn('before.jsonl'));
      const beforeKey = linesOfKind(beforeLines, 'survivor').find(
        (s) => s.original === '+' && s.location.start.column === 12,
      ).key;

      // The comment adds no matching source window, so both site keys stay stable.
      const shiftedSource = `// a leading comment\n${fileSource}`;
      const after = buildReport();
      (after.files['src/file.js'] as any).source = shiftedSource;
      for (const mutant of (after.files['src/file.js'] as any).mutants) {
        mutant.location = {
          start: {
            line: mutant.location.start.line + 1,
            column: mutant.location.start.column,
          },
          end: {
            line: mutant.location.end.line + 1,
            column: mutant.location.end.column,
          },
        };
      }
      const afterLines = await actAndWrite(after, fileNameIn('after.jsonl'));
      const afterKey = linesOfKind(afterLines, 'survivor').find(
        (s) => s.original === '+' && s.location.start.column === 12,
      ).key;

      assert.equal(afterKey, beforeKey);
    });

    it('keeps a key stable when indentation around the mutant changes', async () => {
      const before = buildReport();
      const beforeLines = await actAndWrite(before, fileNameIn('before.jsonl'));
      const beforeKey = linesOfKind(beforeLines, 'survivor').find(
        (s) => s.original === '+' && s.location.start.column === 12,
      ).key;

      // Four extra leading spaces on the mutated line leave its trimmed window unchanged.
      const reindentedSource =
        'function add(a, b, c) {\n      return a + b + c;\n}\n';
      const after = buildReport();
      const mutant = (after.files['src/file.js'] as any).mutants[0];
      mutant.location = {
        start: { line: 2, column: 16 },
        end: { line: 2, column: 17 },
      };
      (after.files['src/file.js'] as any).source = reindentedSource;
      (after.files['src/file.js'] as any).mutants = [mutant];
      const afterLines = await actAndWrite(after, fileNameIn('after.jsonl'));
      const afterKey = linesOfKind(afterLines, 'survivor')[0].key;

      assert.equal(afterKey, beforeKey);
    });

    it('keeps a key stable when indentation changes at a site in a multi-line source', async () => {
      // The site window stays the same after indentation changes.
      const source = 'function f(a, b) {\n  return (\n    a && b\n  );\n}\n';
      const report = buildReport();
      report.files['src/file.js'] = {
        language: 'js',
        source,
        mutants: [
          {
            id: 'multi1',
            location: {
              start: { line: 3, column: 5 },
              end: { line: 3, column: 11 },
            },
            mutatorName: 'LogicalOperator',
            replacement: 'a || b',
            status: 'Survived',
            coveredBy: ['t1'],
            testsCompleted: 1,
            static: false,
          },
        ],
      } as any;
      const beforeLines = await actAndWrite(report, fileNameIn('before.jsonl'));
      const beforeKey = linesOfKind(beforeLines, 'survivor')[0].key;

      const reindentedSource =
        'function f(a, b) {\n  return (\n        a && b\n  );\n}\n';
      const after = buildReport();
      after.files['src/file.js'] = {
        language: 'js',
        source: reindentedSource,
        mutants: [
          {
            id: 'multi1',
            location: {
              start: { line: 3, column: 9 },
              end: { line: 3, column: 15 },
            },
            mutatorName: 'LogicalOperator',
            replacement: 'a || b',
            status: 'Survived',
            coveredBy: ['t1'],
            testsCompleted: 1,
            static: false,
          },
        ],
      } as any;
      const afterLines = await actAndWrite(after, fileNameIn('after.jsonl'));
      const afterKey = linesOfKind(afterLines, 'survivor')[0].key;

      assert.equal(afterKey, beforeKey);
    });

    it('gives two mutants on identical, repeated lines different keys', async () => {
      // The matching source window above the second site changes its ordinal.
      const source =
        'function add(a, b) {\n  return a + b;\n}\nfunction sum(a, b) {\n  return a + b;\n}\n';
      const report = buildReport();
      report.files['src/file.js'] = {
        language: 'js',
        source,
        mutants: [
          {
            id: 'r1',
            location: {
              start: { line: 2, column: 12 },
              end: { line: 2, column: 13 },
            },
            mutatorName: 'ArithmeticOperator',
            replacement: '-',
            status: 'Survived',
            coveredBy: ['t1'],
            testsCompleted: 1,
            static: false,
          },
          {
            id: 'r2',
            location: {
              start: { line: 5, column: 12 },
              end: { line: 5, column: 13 },
            },
            mutatorName: 'ArithmeticOperator',
            replacement: '-',
            status: 'Survived',
            coveredBy: ['t1'],
            testsCompleted: 1,
            static: false,
          },
        ],
      } as any;
      const lines = await actAndWrite(report, fileNameIn('agent.jsonl'));
      const keys = linesOfKind(lines, 'survivor').map((s) => s.key);
      assert.equal(keys.length, 2);
      assert.notEqual(keys[0], keys[1]);
    });

    it('strips the sandbox path, project root and query string from a status reason', async () => {
      const lines = await actAndWrite(
        buildReport(),
        fileNameIn('agent.jsonl'),
      );
      assert.equal(
        linesOfKind(lines, 'ignored')[0].reason,
        'excluded by stryker.config.js in src/file.js',
      );
      assert.equal(
        linesOfKind(lines, 'invalid')[0].statusReason,
        'compile error in src/file.js',
      );
    });

    it('lists a timeout with static true as an item', async () => {
      const lines = await actAndWrite(
        buildReport(),
        fileNameIn('agent.jsonl'),
      );
      const timeouts = linesOfKind(lines, 'timeout');
      assert.equal(timeouts.length, 1);
      assert.equal(timeouts[0].static, true);
      assert.equal(typeof timeouts[0].rerun, 'string');
    });

    it('lists an invalid mutant with its status', async () => {
      const lines = await actAndWrite(
        buildReport(),
        fileNameIn('agent.jsonl'),
      );
      const invalid = linesOfKind(lines, 'invalid');
      assert.equal(invalid.length, 1);
      assert.equal(invalid[0].status, 'CompileError');
    });

    it('lists testWithoutKills as one line per test, and disableBail as the run line', async () => {
      const lines = await actAndWrite(
        buildReport(),
        fileNameIn('agent.jsonl'),
      );
      assert.equal(lines[0].disableBail, false);
      assert.deepEqual(linesOfKind(lines, 'testWithoutKills'), [
        {
          kind: 'testWithoutKills',
          name: 'never used',
          file: 'test/file.spec.js',
          line: 10,
        },
      ]);
    });

    it('follows disableBail on the run line', async () => {
      const fileName = fileNameIn('agent.jsonl');
      const sut = new AgentReporter(
        buildOptions(
          { disableBail: true } as Partial<StrykerOptions>,
          { fileName, partial: false },
        ),
        buildLogger(),
      );
      const report = buildReport();
      sut.onMutationTestReportReady(
        report,
        calculateMutationTestMetrics(report),
      );
      await sut.wrapUp();
      const lines = readWritten(fileName);
      assert.equal(lines[0].disableBail, true);
    });

    it('marks a patch with "\\ No newline at end of file" when the mutated line has none', async () => {
      const report = buildReport();
      report.files['src/file.js'] = {
        language: 'js',
        source: 'const x = 1;',
        mutants: [
          {
            id: 'no-eof-newline',
            location: {
              start: { line: 1, column: 11 },
              end: { line: 1, column: 12 },
            },
            mutatorName: 'EqualityOperator',
            replacement: '2',
            status: 'Survived',
            coveredBy: ['t1'],
            testsCompleted: 1,
            static: false,
          },
        ],
      } as any;
      const lines = await actAndWrite(report, fileNameIn('agent.jsonl'));
      assert.equal(
        linesOfKind(lines, 'survivor')[0].patch,
        '--- a/src/file.js\n+++ b/src/file.js\n@@ -1,1 +1,1 @@\n' +
          '-const x = 1;\n\\ No newline at end of file\n' +
          '+const x = 2;\n\\ No newline at end of file\n',
      );
    });

    it('produces byte-identical bytes for the same input, written twice', async () => {
      const fileNameA = fileNameIn('a.jsonl');
      const fileNameB = fileNameIn('b.jsonl');
      await actAndWrite(buildReport(), fileNameA);
      await actAndWrite(buildReport(), fileNameB);
      assert.equal(
        readFileSync(fileNameA, 'utf-8'),
        readFileSync(fileNameB, 'utf-8'),
      );
    });

    describe('tests summary', () => {
      async function getTestsSummary(
        fileSpecs: Array<{ file: string; testNames: string[] }>,
      ) {
        const lines = await actAndWrite(
          buildTestsSummaryReport(fileSpecs),
          fileNameIn(`ts-${Math.random()}.jsonl`),
        );
        return linesOfKind(lines, 'survivor')[0].tests;
      }

      it('keeps truncated false at exactly 10 files', async () => {
        const fileSpecs = Array.from({ length: 10 }, (_, i) => ({
          file: `test/f${String(i).padStart(2, '0')}.spec.js`,
          testNames: ['a test'],
        }));
        const tests = await getTestsSummary(fileSpecs);
        assert.equal(tests.total, 10);
        assert.equal(tests.truncated, false);
        assert.equal(tests.files.length, 10);
      });

      it('sets truncated true and keeps only the top 10 files at 11 files', async () => {
        const fileSpecs = Array.from({ length: 11 }, (_, i) => ({
          file: `test/f${String(i).padStart(2, '0')}.spec.js`,
          testNames: ['a test'],
        }));
        const tests = await getTestsSummary(fileSpecs);
        assert.equal(tests.total, 11);
        assert.equal(tests.truncated, true);
        assert.equal(tests.files.length, 10);
        // Tied counts (1 each): the tie breaks on file name, so the
        // alphabetically-last file (f10) is the one left out.
        assert.ok(
          !tests.files.map((f: any) => f.file).includes('test/f10.spec.js'),
        );
      });

      it('keeps truncated false at exactly 3 names in one file', async () => {
        const tests = await getTestsSummary([
          { file: 'test/a.spec.js', testNames: ['zebra', 'apple', 'mango'] },
        ]);
        assert.equal(tests.truncated, false);
        assert.deepEqual(tests.files[0].names, ['apple', 'mango', 'zebra']);
      });

      it('sets truncated true and caps names at 3 at 4 names in one file', async () => {
        const tests = await getTestsSummary([
          { file: 'test/a.spec.js', testNames: ['d', 'a', 'c', 'b'] },
        ]);
        assert.equal(tests.truncated, true);
        assert.equal(tests.files[0].count, 4);
        assert.deepEqual(tests.files[0].names, ['a', 'b', 'c']);
      });

      it('sorts files by count descending, then by file name', async () => {
        const tests = await getTestsSummary([
          { file: 'test/b.spec.js', testNames: ['t1', 't2'] },
          { file: 'test/a.spec.js', testNames: ['t1', 't2'] },
          { file: 'test/c.spec.js', testNames: ['t1'] },
        ]);
        assert.deepEqual(
          tests.files.map((f: any) => [f.file, f.count]),
          [
            ['test/a.spec.js', 2],
            ['test/b.spec.js', 2],
            ['test/c.spec.js', 1],
          ],
        );
      });
    });
  });

  describe('the partial file', () => {
    // The reporter reads this file itself (`partialFileIO.readSource`) to
    // compute a mutant's key, so the plan's `fileName` must point at a real
    // file on disk, not a stubbed read.
    function planFileNameIn(): string {
      const dir = fileNameIn('src');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'file.js');
      writeFileSync(file, fileSource, 'utf-8');
      return file;
    }

    it('writes the run line to the partial file when the plan is ready', async () => {
      const fileName = fileNameIn('agent.jsonl');
      const partialFileName = partialFileNameFor(fileName);
      const sut = new AgentReporter(
        buildOptions({}, { fileName, partial: true }),
        buildLogger(),
      );
      sut.onMutationTestingPlanReady(
        readyEvent([survivedResult(planFileNameIn())]),
      );
      await sut.wrapUp();
      const lines = readWritten(partialFileName);
      assert.equal(lines[0].kind, 'run');
    });

    it('writes a planned scope line with stable keys', async () => {
      const source = [
        'const aToB = edgesByPair.get(`${a}->${b}`) ?? [];',
        'const other = 1;',
        'if (x) {',
        '  const aToB = edgesByPair.get(`${a}->${b}`) ?? [];',
        '}',
        '',
      ].join('\n');
      const fileName = fileNameIn('agent.jsonl');
      const partialFileName = partialFileNameFor(fileName);
      const readSource = partialFileIO.readSource;
      partialFileIO.readSource = async () => source;
      try {
        const sut = new AgentReporter(
          buildOptions({}, { fileName, partial: true }),
          buildLogger(),
        );
        const first = survivedResult('src/rules/cycles.ts', {
          id: 'cycle-1',
          location: {
            start: { line: 0, column: 13 },
            end: { line: 0, column: 48 },
          },
          mutatorName: 'LogicalOperator',
          replacement: 'edgesByPair.get(`${a}->${b}`) && []',
        });
        const second = survivedResult('src/rules/cycles.ts', {
          id: 'cycle-2',
          location: {
            start: { line: 3, column: 15 },
            end: { line: 3, column: 50 },
          },
          mutatorName: 'LogicalOperator',
          replacement: 'edgesByPair.get(`${a}->${b}`) && []',
        });
        sut.onMutationTestingPlanReady(readyEvent([first, second]));
        await sut.wrapUp();

        assert.equal(
          JSON.stringify(readWritten(partialFileName)[1]),
          '{"kind":"scope","file":"src/rules/cycles.ts","sourceHash":"7c1cae4b334c6a13","keys":["8764c5229f05","2e79224b8652"]}',
        );
      } finally {
        partialFileIO.readSource = readSource;
      }
    });

    it('appends one line per tested mutant, after the plan, in the order they complete', async () => {
      const fileName = fileNameIn('agent.jsonl');
      const partialFileName = partialFileNameFor(fileName);
      const sut = new AgentReporter(
        buildOptions({}, { fileName, partial: true }),
        buildLogger(),
      );
      const first = survivedResult(planFileNameIn(), { id: 'm1' });
      const second = survivedResult(planFileNameIn(), {
        id: 'm2',
        location: {
          start: { line: 1, column: 15 },
          end: { line: 1, column: 16 },
        },
        status: 'Timeout',
      });
      sut.onMutationTestingPlanReady(readyEvent([first, second]));
      sut.onMutantTested(first);
      sut.onMutantTested(second);
      await sut.wrapUp();

      const lines = readWritten(partialFileName).slice(2);
      assert.equal(lines.length, 2);
      assert.equal(lines[0].kind, 'survivor');
      assert.equal(lines[1].kind, 'timeout');
    });

    it('keys a partial line the same as the same mutant keys in the final report', async () => {
      const fileName = fileNameIn('agent.jsonl');
      const partialFileName = partialFileNameFor(fileName);
      const sut = new AgentReporter(
        buildOptions({}, { fileName, partial: true }),
        buildLogger(),
      );
      const planFileName = planFileNameIn();
      const survived = survivedResult(planFileName);
      sut.onMutationTestingPlanReady(readyEvent([survived]));
      sut.onMutantTested(survived);
      await sut.wrapUp();
      const partialLine = readWritten(partialFileName)[2];

      // The final report keys a file relative to `process.cwd()`, the same
      // way the reporter's own `normalizeReportFileName` does; the plan's
      // (absolute) `fileName` must map to this same key for the two to
      // agree.
      const reportKey = path
        .relative(process.cwd(), planFileName)
        .replace(/\\/g, '/');
      const report = buildReport();
      delete (report.files as Record<string, unknown>)['src/file.js'];
      report.files[reportKey] = {
        language: 'js',
        source: fileSource,
        mutants: [
          {
            id: 'm1',
            location: {
              start: { line: 2, column: 12 },
              end: { line: 2, column: 13 },
            },
            mutatorName: 'ArithmeticOperator',
            replacement: '-',
            status: 'Survived',
            coveredBy: ['t1'],
            testsCompleted: 1,
            static: false,
          },
        ],
      } as any;
      const finalLines = await actAndWrite(report, fileNameIn('final.jsonl'));
      const finalSurvivor = linesOfKind(finalLines, 'survivor')[0];

      assert.equal(partialLine.key, finalSurvivor.key);
    });

    it('routes an unverified mutant (covered, testsCompleted 0) to "unverified" in the partial file', async () => {
      const fileName = fileNameIn('agent.jsonl');
      const partialFileName = partialFileNameFor(fileName);
      const sut = new AgentReporter(
        buildOptions({}, { fileName, partial: true }),
        buildLogger(),
      );
      const unverified = survivedResult(planFileNameIn(), {
        testsCompleted: 0,
      });
      sut.onMutationTestingPlanReady(readyEvent([unverified]));
      sut.onMutantTested(unverified);
      await sut.wrapUp();
      const line = readWritten(partialFileName)[2];
      assert.equal(line.kind, 'unverified');
    });

    it('writes no item line for a Killed or Pending mutant', async () => {
      const fileName = fileNameIn('agent.jsonl');
      const partialFileName = partialFileNameFor(fileName);
      const sut = new AgentReporter(
        buildOptions({}, { fileName, partial: true }),
        buildLogger(),
      );
      const killed = survivedResult(planFileNameIn(), {
        status: 'Killed',
        killedBy: ['t1'],
      });
      sut.onMutationTestingPlanReady(readyEvent([killed]));
      sut.onMutantTested(killed);
      await sut.wrapUp();
      const lines = readWritten(partialFileName);
      assert.equal(lines.length, 2);
    });

    it('does not write or append to the partial file when partial is false', async () => {
      const fileName = fileNameIn('agent.jsonl');
      const partialFileName = partialFileNameFor(fileName);
      const sut = new AgentReporter(
        buildOptions({}, { fileName, partial: false }),
        buildLogger(),
      );
      const survived = survivedResult(planFileNameIn());
      sut.onMutationTestingPlanReady(readyEvent([survived]));
      sut.onMutantTested(survived);
      await sut.wrapUp();
      assert.throws(() => readFileSync(partialFileName));
    });

    it('does not write or append to the partial file when inPlace is true', async () => {
      // In place, the file on disk already holds the instrumented code
      // when the plan is ready, so a key read from it would be wrong.
      const fileName = fileNameIn('agent.jsonl');
      const partialFileName = partialFileNameFor(fileName);
      const sut = new AgentReporter(
        buildOptions({ inPlace: true } as Partial<StrykerOptions>, {
          fileName,
          partial: true,
        }),
        buildLogger(),
      );
      const survived = survivedResult(planFileNameIn());
      sut.onMutationTestingPlanReady(readyEvent([survived]));
      sut.onMutantTested(survived);
      await sut.wrapUp();
      assert.throws(() => readFileSync(partialFileName));
    });

    it('derives the default partial file name from the default fileName', () => {
      assert.equal(
        partialFileNameFor('reports/mutation/agent.jsonl'),
        'reports/mutation/agent.partial.jsonl',
      );
    });

    it('always ends a configured fileName in .partial.jsonl', () => {
      assert.equal(
        partialFileNameFor('out/agent.json'),
        'out/agent.partial.jsonl',
      );
    });
  });

  describe('wrapUp', () => {
    it('resolves when everything is OK', async () => {
      const report = buildReport();
      await actAndWrite(report, fileNameIn('agent.jsonl'));
    });

    it('rejects when the write fails', async () => {
      // A regular file where a directory needs to be: `mkdir` fails with
      // ENOTDIR, which `wrapUp` must surface, not swallow.
      const blocker = fileNameIn('blocker');
      writeFileSync(blocker, '', 'utf-8');
      const fileName = path.join(blocker, 'agent.jsonl');
      const sut = new AgentReporter(
        buildOptions({}, { fileName, partial: false }),
        buildLogger(),
      );
      const report = buildReport();
      sut.onMutationTestReportReady(
        report,
        calculateMutationTestMetrics(report),
      );
      await assert.rejects(() => sut.wrapUp() as Promise<void>);
    });
  });
});
