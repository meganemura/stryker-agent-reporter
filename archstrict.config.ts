import type { Config } from "./archstrict.types.js";

// Public surface: other modules may import a directory module only through
// its own surface file (named by `surface` below), or through the files its own
// package.json exports map names. An import that reaches any other file in
// the directory is a violation. A directory module with no such file is
// entirely private. A module whose glob names one file is that file, so its
// entry names the file itself as its surface.
export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
  // Kept out of analysis entirely:
  // - archstrict's own two files, which are never module content;
  // - hidden directories at any depth (.git, tool state), which tsc's own
  //   default include also skips;
  // - common noise directories that init found on disk (test).
  //   test/** also covers test/e2e/fixture. This repository has no
  //   top-level fixtures/ directory.
  //   Remove one of these entries if that directory holds module content.
  exclude: [
    "archstrict.config.ts",
    "archstrict.types.ts",
    ".*/**",
    "**/.*/**",
    "test/**",
  ],
  // init declared one module per directory that holds TypeScript source and
  // one per TypeScript source file, so every file that check analyzes
  // belongs to exactly one module. Merge, rename, or remove entries freely:
  // init never rewrites this file. After an edit, run archstrict init to
  // regenerate archstrict.types.ts.
  declaredModules: [
    // Each directory and TypeScript source file directly in src/.
    { name: "agent-reporter.ts", glob: "src/agent-reporter.ts", surface: "agent-reporter.ts" },
    { name: "build-lines.ts", glob: "src/build-lines.ts", surface: "build-lines.ts" },
    { name: "cli.ts", glob: "src/cli.ts", surface: "cli.ts" },
    { name: "convert.ts", glob: "src/convert.ts", surface: "convert.ts" },
    { name: "gate.ts", glob: "src/gate.ts", surface: "gate.ts" },
    { name: "index.ts", glob: "src/index.ts", surface: "index.ts" },
  ],
  because: "archstrict init: one module per directory that holds TypeScript source and per TypeScript source file, so the first check covers every file it analyzes",
} satisfies Config;
