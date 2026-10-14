import { defineStep, z } from "nukadoko";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "src/price.js";
const BEFORE = ["export function total(price, tax) {", "  const net = price * 2;", "  return net + tax;", "}", ""];
const AFTER = ["export function total(price, tax) {", "  const net = price * 2;", "  return net - tax;", "}", ""];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export default defineStep({
  description: "Creates a scratch git repository with two commits; the second one changes one line of src/price.js.",
  pattern: "a git repository whose last commit changed one line of a source file",
  args: z.object({}),
  returns: z.object({
    root: z.string().describe("the scratch repository's root directory"),
    file: z.string().describe("the changed source file, relative to root"),
    source: z.string().describe("the file's content at the last commit"),
    base: z.string().describe("the commit before the change, the ref a pull request is gated against"),
    changedLine: z.number().describe("the 1-based line the last commit changed"),
    unchangedLine: z.number().describe("a 1-based line both commits share"),
  }),
  mutates: true,
  rationale:
    "gate --since asks git which lines changed, so the scenario needs a real repository rather than a list of line numbers. The repository is a scratch directory the scratch fixture removes after the scenario, so nothing outside it changes.",
  run({ scratch }) {
    const root = scratch.dir("stryker-agent-reporter-gate");
    mkdirSync(join(root, "src"));
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "scenario@example.invalid");
    git(root, "config", "user.name", "scenario");
    writeFileSync(join(root, FILE), BEFORE.join("\n"));
    git(root, "add", FILE);
    git(root, "commit", "--quiet", "-m", "Add total");
    const base = git(root, "rev-parse", "HEAD");
    const source = AFTER.join("\n");
    writeFileSync(join(root, FILE), source);
    git(root, "commit", "--quiet", "-am", "Subtract tax");
    return { root, file: FILE, source, base, changedLine: 3, unchangedLine: 2 };
  },
});
