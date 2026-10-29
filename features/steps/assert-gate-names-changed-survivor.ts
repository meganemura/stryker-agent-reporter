import { defineStep, z } from "nukadoko";
import createChangedRepository from "./create-changed-repository.ts";
import gateSinceBase from "./gate-since-base.ts";

// "Only" is every named survivor on the changed line, and an empty list
// breaks an each claim, so a gate that names nothing does not pass either.
export default defineStep({
  description: "Claims the gate exited 1 and every survivor it named is on the changed line, with at least one named.",
  pattern: "the gate exits 1 and names only the survivor on the changed line",
  args: z.object({
    exitCode: z.number(),
    survivorLines: z.array(z.number()),
    changedLine: z.number(),
  }),
  from: {
    exitCode: [gateSinceBase, "exitCode"],
    survivorLines: [gateSinceBase, "survivorLines"],
    changedLine: [createChangedRepository, "changedLine"],
  },
  claims: [
    { actual: "exitCode", compare: "equal", expected: { literal: 1 } },
    { actual: "survivorLines", each: { claims: [{ compare: "equal", expected: { from: "changedLine" } }] } },
  ],
});
