import { defineStep, z } from "nukadoko";
import { runCli } from "./cli.ts";
import convertReport from "./convert-report.ts";
import createChangedRepository from "./create-changed-repository.ts";

// The exit code is the check's verdict in CI, so it is returned as data. The
// default jsonl format is the one an agent parses; github and text render the
// same items.
export default defineStep({
  description: "Runs `stryker-agent-reporter gate <agent.jsonl> --since <base>` and reads the survivors it kept.",
  pattern: "the agent gates the converted output since the commit before the change",
  args: z.object({ root: z.string(), output: z.string(), base: z.string() }),
  returns: z.object({
    exitCode: z.number().describe("the gate's exit code: 0 pass, 1 survivor, 2 usage error, 3 measurement failure"),
    survivorLines: z.array(z.number()).describe("the start line of each survivor the gate reported, in output order"),
    staleCount: z.number().describe("the summary line's staleCount: files the gate could not scope"),
  }),
  from: {
    root: [createChangedRepository, "root"],
    output: [convertReport, "output"],
    base: [createChangedRepository, "base"],
  },
  mutates: false,
  async run({}, { root, output, base }) {
    const { exitCode, stdout } = await runCli(["gate", output, "--since", base], root);
    const lines = stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
    const summary = lines.find((line) => line.kind === "summary");
    return {
      exitCode,
      survivorLines: lines.filter((line) => line.kind === "survivor").map((line) => line.location.start.line),
      staleCount: summary?.staleCount ?? -1,
    };
  },
});
