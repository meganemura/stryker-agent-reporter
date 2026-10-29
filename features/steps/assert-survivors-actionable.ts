import { defineStep, z } from "nukadoko";
import convertReport from "./convert-report.ts";
import saveStrykerReport from "./save-stryker-report.ts";

// A survivor the agent cannot apply or rerun leaves it re-deriving both from
// Stryker's own report, which is what the format exists to spare it.
export default defineStep({
  description: "Claims convert wrote one line per survivor of the saved report, and every survivor line's patch starts with, and its rerun command contains, the text the scenario names for it.",
  pattern: "each survivor's line carries a patch that starts with {patchText:string} and a rerun command that contains {rerunText:string}",
  args: z.object({
    patchText: z.string().describe("text every survivor line's patch starts with"),
    rerunText: z.string().describe("text every survivor line's rerun command contains"),
    reportLines: z.array(z.number()),
    survivorLines: z.array(z.number()),
    survivors: z.array(z.object({ line: z.number(), patch: z.string().nullable(), rerun: z.string().nullable() })),
  }),
  from: {
    reportLines: [saveStrykerReport, "survivorLines"],
    survivorLines: [convertReport, "survivorLines"],
    survivors: [convertReport, "survivors"],
  },
  claims: [
    { actual: "survivorLines", compare: "equal", expected: { from: "reportLines" } },
    {
      actual: "survivors",
      each: {
        claims: [
          { actual: "patch", compare: "starts-with-text", expected: "patchText" },
          { actual: "rerun", compare: "contains-text", expected: "rerunText" },
        ],
      },
    },
  ],
});
