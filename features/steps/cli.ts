// Runs the built command line the way a user's shell would: the published
// bin, a child process, and the exit code read as data rather than thrown.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export function runCli(args: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}
