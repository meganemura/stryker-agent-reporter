// Responsibility: exercises `cli.ts`'s dispatcher directly, in-process
// (`run()`, not a child process): usage output, an unknown command, and an
// unknown --format value. `convert.test.ts` and `gate.test.ts` cover each
// command's own behavior.
// Boundary: does not run Stryker.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { run } from '../src/cli.ts';

describe('cli', () => {
  it('prints usage and exits 0 with no command', async () => {
    const result = await run([]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /stryker-agent-reporter convert/);
    assert.match(result.stdout, /stryker-agent-reporter gate/);
  });

  it('prints usage and exits 0 for --help', async () => {
    const result = await run(['--help']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Usage/);
  });

  it('exits 2 with one stderr line for an unknown command', async () => {
    const result = await run(['frobnicate']);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /usage error: unknown command frobnicate/);
  });

  it('exits 2 for gate with an unknown --format', async () => {
    const result = await run(['gate', '--format', 'yaml']);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /usage error: unknown --format yaml/);
  });

  it('exits 2 for an unrecognized flag', async () => {
    const result = await run(['gate', '--not-a-flag']);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /usage error/);
  });

  it('prints usage and exits 0 for gate --help', async () => {
    const result = await run(['gate', '--help']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Usage/);
  });

  it('prints usage and exits 0 for convert --help', async () => {
    const result = await run(['convert', '--help']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Usage/);
  });
});
