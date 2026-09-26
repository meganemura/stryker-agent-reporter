#!/usr/bin/env node
/**
 * Responsibility: parse argv, dispatch to `convert` or `gate`, and print
 * their result. This file holds no reporter logic and no report-parsing
 * logic; see `convert.ts` and `gate.ts`.
 * Boundary: no added dependency; argument parsing is `node:util`'s
 * `parseArgs`.
 */

import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { ConvertUsageError, convertReport } from './convert.ts';
import { GateUsageError, runGate } from './gate.ts';
import type { GateArgs } from './gate.ts';

const USAGE = `Usage:
  stryker-agent-reporter convert [mutation.json] [--output <file>]
  stryker-agent-reporter gate [agent.jsonl] [--since <ref>] [--baseline <file>] [--format jsonl|github|text]

convert reads a saved mutation.json (default reports/mutation/mutation.json)
and writes the JSON-Lines file the agent reporter would have written for
that run.

gate reads an agent.jsonl file (default reports/mutation/agent.jsonl) and
exits 0, 1, or 3 for a pass/fail check. See docs/output.md.
`;

const DEFAULT_MUTATION_REPORT = 'reports/mutation/mutation.json';
const DEFAULT_AGENT_REPORT = 'reports/mutation/agent.jsonl';

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runConvert(argv: string[]): Promise<CliResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        output: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { exitCode: 2, stdout: '', stderr: `usage error: ${(err as Error).message}\n` };
  }
  if (parsed.values.help) {
    return { exitCode: 0, stdout: USAGE, stderr: '' };
  }
  const reportPath = parsed.positionals[0] ?? DEFAULT_MUTATION_REPORT;
  try {
    const output = await convertReport(reportPath);
    if (parsed.values.output) {
      await writeFile(parsed.values.output, output, 'utf8');
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: output, stderr: '' };
  } catch (err) {
    if (err instanceof ConvertUsageError) {
      return { exitCode: 2, stdout: '', stderr: `usage error: ${err.message}\n` };
    }
    throw err;
  }
}

function runGateCommand(argv: string[]): CliResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        since: { type: 'string' },
        baseline: { type: 'string' },
        format: { type: 'string', default: 'jsonl' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { exitCode: 2, stdout: '', stderr: `usage error: ${(err as Error).message}\n` };
  }
  if (parsed.values.help) {
    return { exitCode: 0, stdout: USAGE, stderr: '' };
  }
  const format = parsed.values.format;
  if (format !== 'jsonl' && format !== 'github' && format !== 'text') {
    return { exitCode: 2, stdout: '', stderr: `usage error: unknown --format ${format}\n` };
  }
  const args: GateArgs = {
    input: parsed.positionals[0] ?? DEFAULT_AGENT_REPORT,
    format,
  };
  if (parsed.values.since) args.since = parsed.values.since;
  if (parsed.values.baseline) args.baseline = parsed.values.baseline;
  try {
    return runGate(args, process.cwd());
  } catch (err) {
    if (err instanceof GateUsageError) {
      return { exitCode: 2, stdout: '', stderr: `usage error: ${err.message}\n` };
    }
    throw err;
  }
}

export async function run(argv: string[]): Promise<CliResult> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    return { exitCode: 0, stdout: USAGE, stderr: '' };
  }
  if (command === 'convert') {
    return runConvert(rest);
  }
  if (command === 'gate') {
    return runGateCommand(rest);
  }
  return { exitCode: 2, stdout: '', stderr: `usage error: unknown command ${command}\n${USAGE}` };
}

async function main(): Promise<void> {
  const result = await run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
