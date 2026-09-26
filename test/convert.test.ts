// Responsibility: exercises `convert.ts` against real temporary files: a
// converted report must match, byte for byte, what `AgentReporter` writes
// for the same report and metrics (see `docs/output.md` and `build-lines.ts`).
// Boundary: does not run Stryker; every report here is a synthetic fixture.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { schema, StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { calculateMutationTestMetrics } from 'mutation-testing-metrics';

import { AgentReporter } from '../src/agent-reporter.ts';
import type { AgentReporterOptions } from '../src/agent-reporter.ts';
import { ConvertUsageError, convertReport } from '../src/convert.ts';

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

/** A report whose `config` mirrors what Stryker itself stores there: its own resolved `StrykerOptions`. */
function buildReport(
  dir: string,
  source: string,
  overrides: Partial<schema.MutationTestResult> = {},
): schema.MutationTestResult {
  return {
    schemaVersion: '1.0',
    thresholds: { high: 80, low: 60 },
    projectRoot: dir,
    config: { tempDirName: '.stryker-tmp', disableBail: false, concurrency: 4 },
    files: {
      'src/file.js': {
        language: 'js',
        source,
        mutants: [
          {
            id: 'm1',
            mutatorName: 'ArithmeticOperator',
            replacement: 'a - b',
            status: 'Survived',
            static: false,
            coveredBy: ['t1'],
            testsCompleted: 1,
            location: {
              start: { line: 2, column: 10 },
              end: { line: 2, column: 15 },
            },
          },
        ],
      },
    },
    testFiles: {
      'test/file.test.ts': { tests: [{ id: 't1', name: 'adds' }] },
    },
    ...overrides,
  } as unknown as schema.MutationTestResult;
}

describe('convert', () => {
  it('produces byte-identical output to the reporter for the same report and metrics', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'convert-'));
    const source = 'function add(a, b) {\n  return a - b;\n}\n';
    const report = buildReport(dir, source);
    const reportPath = path.join(dir, 'mutation.json');
    writeFileSync(reportPath, JSON.stringify(report));

    const metrics = calculateMutationTestMetrics(report);
    const agentFile = path.join(dir, 'agent.jsonl');
    const options = {
      disableBail: false,
      concurrency: 4,
      tempDirName: '.stryker-tmp',
      inPlace: false,
      agentReporter: { fileName: agentFile, partial: false } as AgentReporterOptions,
    } as unknown as StrykerOptions & { agentReporter: AgentReporterOptions };
    const reporter = new AgentReporter(options, buildLogger());
    reporter.onMutationTestReportReady(report, metrics);
    await reporter.wrapUp();
    const expected = readFileSync(agentFile, 'utf8');

    const actual = await convertReport(reportPath);
    assert.equal(actual, expected);
  });

  it('reads the default report path when none is given', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'convert-default-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const source = 'function f(x) {\n  return x;\n}\n';
      const report = buildReport(dir, source);
      const { mkdirSync } = await import('node:fs');
      mkdirSync('reports/mutation', { recursive: true });
      writeFileSync('reports/mutation/mutation.json', JSON.stringify(report));
      const output = await convertReport('reports/mutation/mutation.json');
      assert.match(output.split('\n')[0], /"kind":"run"/);
    } finally {
      process.chdir(cwd);
    }
  });

  it('rejects a schemaVersion that is not 1.x', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'convert-badversion-'));
    const report = buildReport(dir, 'const x = 1;\n', { schemaVersion: '2.0' });
    const reportPath = path.join(dir, 'mutation.json');
    writeFileSync(reportPath, JSON.stringify(report));
    await assert.rejects(() => convertReport(reportPath), ConvertUsageError);
  });

  it('rejects a report path that cannot be read', async () => {
    await assert.rejects(
      () => convertReport('/nonexistent/does-not-exist.json'),
      ConvertUsageError,
    );
  });
});
