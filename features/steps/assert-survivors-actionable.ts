import { defineStep, z } from "nukadoko";
import convertReport from "./convert-report.ts";

// A survivor the agent cannot apply or rerun leaves it re-deriving both from
// Stryker's own report, which is what the format exists to spare it.
export default defineStep({
  description: "Asserts convert exited 0 and every survivor line carries a patch and a rerun command.",
  pattern: "each survivor's line carries a patch and a rerun command",
  args: z.object({
    exitCode: z.number(),
    survivors: z.array(z.object({ line: z.number(), patch: z.string().nullable(), rerun: z.string().nullable() })),
  }),
  from: { exitCode: [convertReport, "exitCode"], survivors: [convertReport, "survivors"] },
  mutates: false,
  run({}, { exitCode, survivors }) {
    if (exitCode !== 0) throw new Error(`convert exited ${exitCode}`);
    if (survivors.length !== 2) throw new Error(`expected 2 survivor lines, got ${survivors.length}`);
    for (const survivor of survivors) {
      if (!survivor.patch?.startsWith("--- a/")) throw new Error(`survivor on line ${survivor.line} has no patch`);
      if (!survivor.rerun?.includes("stryker run")) throw new Error(`survivor on line ${survivor.line} has no rerun command`);
    }
  },
});
