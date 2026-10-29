import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import createChangedRepository from "./create-changed-repository.ts";
import saveStrykerReport from "./save-stryker-report.ts";

const OUTPUT = "reports/mutation/agent.jsonl";

const survivor = z.object({
  line: z.number().describe("the survivor's start line"),
  patch: z.string().nullable().describe("the line's ready-to-apply patch, or null when it has none"),
  rerun: z.string().nullable().describe("the line's rerun command, or null when it has none"),
});

// The agent reads the file, not stdout, so the step reads back what convert
// wrote to --output and keeps only the fields the agent acts on. No sentence
// states convert's exit code, so a failed convert fails here rather than in
// a Then.
export default defineStep({
  description: "Runs `stryker-agent-reporter convert <report> --output reports/mutation/agent.jsonl`, fails when it exits non-zero or writes to stderr, and reads the survivor lines it wrote.",
  pattern: "the agent converts the saved report to JSON Lines",
  args: z.object({ root: z.string(), report: z.string() }),
  returns: z.object({
    output: z.string().describe("the JSON-Lines file convert wrote, relative to root"),
    survivors: z.array(survivor).describe("one entry per survivor line in the written file"),
    survivorLines: z.array(z.number()).describe("the start line of each survivor line in the written file, ascending"),
  }),
  from: { root: [createChangedRepository, "root"], report: [saveStrykerReport, "report"] },
  mutates: true,
  async run({}, { root, report }) {
    const { exitCode, stderr } = await runCli(["convert", report, "--output", OUTPUT], root);
    if (exitCode !== 0) throw new Error(`convert exited ${exitCode}: ${stderr}`);
    if (stderr !== "") throw new Error(`convert wrote to stderr: ${stderr}`);
    const survivors = readFileSync(join(root, OUTPUT), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line))
      .filter((line) => line.kind === "survivor")
      .map((line) => ({ line: line.location.start.line, patch: line.patch ?? null, rerun: line.rerun ?? null }));
    return { output: OUTPUT, survivors, survivorLines: survivors.map((s) => s.line).sort((a, b) => a - b) };
  },
});
