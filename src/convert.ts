/**
 * Responsibility: turn a saved `mutation.json` (Stryker's own
 * mutation-testing-report-schema report) into the same JSON-Lines file
 * `AgentReporter` would have written for that run. It calls `build-lines.ts`
 * for the mutant key and every line, so a converted report and a live
 * reporter run agree on the same mutant's key.
 * Boundary: this module reads one file and returns text; it does not run
 * Stryker or a mutation test. It resolves `mutation-testing-metrics`
 * through `@stryker-mutator/core`'s own install rather than depending on it
 * directly: `@stryker-mutator/core` already carries it as a dependency, and
 * this package's `peerDependencies` already requires core to be installed.
 */

import { createRequire } from 'node:module';

import type { schema } from '@stryker-mutator/api/core';
import type {
  calculateMutationTestMetrics as CalculateMutationTestMetrics,
  MutationTestMetricsResult,
} from 'mutation-testing-metrics';

import { buildAgentReportLines, DEFAULT_TEMP_DIR_NAME } from './build-lines.ts';
import type { RunInfo } from './build-lines.ts';

export class ConvertUsageError extends Error {}

/**
 * Resolves `calculateMutationTestMetrics` from the `mutation-testing-metrics`
 * copy `@stryker-mutator/core` already installed, instead of adding a direct
 * runtime dependency on it. Throws `ConvertUsageError` when `@stryker-mutator/
 * core` itself, or the copy of `mutation-testing-metrics` next to it, cannot
 * be found; a caller not running inside a project with Stryker installed has
 * no report to convert either way.
 */
function resolveCalculateMutationTestMetrics(): typeof CalculateMutationTestMetrics {
  let corePackageJson: string;
  try {
    const require = createRequire(import.meta.url);
    corePackageJson = require.resolve('@stryker-mutator/core/package.json');
  } catch (err) {
    throw new ConvertUsageError(
      `cannot find @stryker-mutator/core, needed to calculate metrics: ${String(err)}`,
    );
  }
  try {
    const coreRequire = createRequire(corePackageJson);
    const metrics = coreRequire('mutation-testing-metrics') as {
      calculateMutationTestMetrics: typeof CalculateMutationTestMetrics;
    };
    return metrics.calculateMutationTestMetrics;
  } catch (err) {
    throw new ConvertUsageError(
      `cannot find mutation-testing-metrics next to @stryker-mutator/core: ${String(err)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A report's `config` is a free-format object (Stryker writes its own
 * resolved `StrykerOptions` there, but the schema does not say so). This
 * reads the fields the run line and `sanitizeReason` need, each only when
 * it has the expected type. `disableBail` and `tempDirName` take the same
 * default Stryker itself uses. `mutate` and `incremental` stay absent when
 * the report lacks them: a guessed value would read as a fact about the run.
 */
function runInfoFromReport(report: schema.MutationTestResult): RunInfo {
  const configValue: unknown = report.config;
  const config = isRecord(configValue) ? configValue : {};
  const mutate = stringArray(config.mutate);
  return {
    disableBail: typeof config.disableBail === 'boolean' ? config.disableBail : false,
    concurrency:
      typeof config.concurrency === 'number' ||
      typeof config.concurrency === 'string'
        ? config.concurrency
        : undefined,
    mutate,
    incremental:
      typeof config.incremental === 'boolean' ? config.incremental : undefined,
    tempDirName:
      typeof config.tempDirName === 'string'
        ? config.tempDirName
        : DEFAULT_TEMP_DIR_NAME,
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter(
    (item: unknown): item is string => typeof item === 'string',
  );
  return strings.length === value.length ? strings : undefined;
}

/**
 * Builds the JSON-Lines text for a report already read into memory, and the
 * metrics `calculateMutationTestMetrics` computes from it. Exported for a
 * caller (a test, or a future format) that has already parsed the report
 * and does not need `convertReport`'s file I/O.
 */
export function buildConvertedLines(
  report: schema.MutationTestResult,
  metrics: MutationTestMetricsResult,
): string {
  const lines = buildAgentReportLines(report, metrics, runInfoFromReport(report));
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

/**
 * Reads `reportPath`, checks its `schemaVersion`, computes its metrics, and
 * returns the JSON-Lines text `AgentReporter` would have written for the
 * same run. Throws `ConvertUsageError` on a report that cannot be read,
 * cannot be parsed, or whose `schemaVersion` is not `1.x`.
 */
export async function convertReport(reportPath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await readFile(reportPath, 'utf8');
  } catch (err) {
    throw new ConvertUsageError(`cannot read ${reportPath}: ${String(err)}`);
  }
  let report: schema.MutationTestResult;
  try {
    report = JSON.parse(raw) as schema.MutationTestResult;
  } catch (err) {
    throw new ConvertUsageError(`cannot parse ${reportPath} as JSON: ${String(err)}`);
  }
  if (
    typeof report.schemaVersion !== 'string' ||
    !report.schemaVersion.startsWith('1.')
  ) {
    throw new ConvertUsageError(
      `unsupported schemaVersion in ${reportPath}: ${String(report.schemaVersion)}`,
    );
  }
  const calculateMutationTestMetrics = resolveCalculateMutationTestMetrics();
  const metrics = calculateMutationTestMetrics(report);
  return buildConvertedLines(report, metrics);
}
