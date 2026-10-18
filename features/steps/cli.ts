// Runs the built command line the way a user's shell would: the published
// bin, a child process, and the exit code read as data rather than thrown.
import { fileURLToPath } from "node:url";
import { runCommand } from "nukadoko";

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export async function runCli(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await runCommand(process.execPath, [CLI, ...args], { cwd });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
}
