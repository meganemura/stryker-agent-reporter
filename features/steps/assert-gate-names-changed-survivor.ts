import { defineStep, z } from "nukadoko";
import createChangedRepository from "./create-changed-repository.ts";
import gateSinceBase from "./gate-since-base.ts";

export default defineStep({
  description: "Asserts the gate exited 1 with exactly the survivor on the changed line, and scoped every file.",
  pattern: "the gate exits 1 and names only the survivor on the changed line",
  args: z.object({
    exitCode: z.number(),
    survivorLines: z.array(z.number()),
    staleCount: z.number(),
    changedLine: z.number(),
  }),
  returns: z.object({}),
  from: {
    exitCode: [gateSinceBase, "exitCode"],
    survivorLines: [gateSinceBase, "survivorLines"],
    staleCount: [gateSinceBase, "staleCount"],
    changedLine: [createChangedRepository, "changedLine"],
  },
  mutates: false,
  rationale:
    "A stale file is dropped rather than scoped, so a zero staleCount is what makes the missing unchanged-line survivor a scoping result and not a dropped file.",
  run({}, { exitCode, survivorLines, staleCount, changedLine }) {
    if (staleCount !== 0) throw new Error(`expected every file scoped, the gate reported staleCount ${staleCount}`);
    if (survivorLines.length !== 1 || survivorLines[0] !== changedLine) {
      throw new Error(`expected only the survivor on line ${changedLine}, the gate reported lines [${survivorLines.join(", ")}]`);
    }
    if (exitCode !== 1) throw new Error(`expected exit 1, the gate exited ${exitCode}`);
    return {};
  },
});
