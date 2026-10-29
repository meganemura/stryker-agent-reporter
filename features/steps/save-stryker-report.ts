import { defineStep, z } from "nukadoko";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import createChangedRepository from "./create-changed-repository.ts";

const REPORT = "reports/mutation/mutation.json";

// A real Stryker run takes a minute and decides by itself which mutants
// survive. The report here is the schema Stryker writes (mutation-testing-
// report-schema 1.x), with the file's real source, so convert computes real
// keys, patches, and source hashes from it.
export default defineStep({
  description:
    "Writes a saved Stryker mutation.json into the repository with two surviving mutants: one on the changed line, one on an unchanged line.",
  pattern: "a saved Stryker report with one survivor on that changed line and one on an unchanged line",
  args: z.object({
    root: z.string(),
    file: z.string(),
    source: z.string(),
    changedLine: z.number(),
    unchangedLine: z.number(),
  }),
  returns: z.object({
    report: z.string().describe("the report's path, relative to root"),
    survivorLines: z.array(z.number()).describe("the start line of each surviving mutant the report holds, ascending"),
  }),
  from: {
    root: [createChangedRepository, "root"],
    file: [createChangedRepository, "file"],
    source: [createChangedRepository, "source"],
    changedLine: [createChangedRepository, "changedLine"],
    unchangedLine: [createChangedRepository, "unchangedLine"],
  },
  mutates: true,
  run({}, { root, file, source, changedLine, unchangedLine }) {
    const lines = source.split("\n");
    const mutantOn = (id: string, line: number, original: string, replacement: string) => {
      const column = lines[line - 1]!.indexOf(original) + 1;
      return {
        id,
        mutatorName: "ArithmeticOperator",
        replacement,
        status: "Survived",
        static: false,
        coveredBy: ["t1"],
        testsCompleted: 1,
        location: { start: { line, column }, end: { line, column: column + original.length } },
      };
    };
    const report = {
      schemaVersion: "1.0",
      thresholds: { high: 80, low: 60 },
      projectRoot: root,
      config: { disableBail: false, concurrency: 1 },
      files: {
        [file]: {
          language: "javascript",
          source,
          mutants: [
            mutantOn("changed", changedLine, "net - tax", "net + tax"),
            mutantOn("unchanged", unchangedLine, "price * 2", "price / 2"),
          ],
        },
      },
      testFiles: { "test/price.test.js": { tests: [{ id: "t1", name: "totals a price" }] } },
    };
    mkdirSync(join(root, "reports/mutation"), { recursive: true });
    writeFileSync(join(root, REPORT), JSON.stringify(report, null, 2));
    return { report: REPORT, survivorLines: [changedLine, unchangedLine].sort((a, b) => a - b) };
  },
});
