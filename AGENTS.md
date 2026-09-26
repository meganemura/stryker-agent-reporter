# AGENTS.md

Context for agents that work in this repository.

## What this is

stryker-agent-reporter is a [Stryker](https://stryker-mutator.io/) reporter plugin, plus two commands that work from its output alone. The reporter writes JSON Lines a coding agent can act on directly. Each survivor's line carries its location, its original and replacement text, a ready-to-apply patch, and a rerun command. The agent does not need to re-derive any of that from Stryker's own report. `convert` produces the same JSON Lines from a saved report; `gate` turns that output into a pass/fail check for a pull request.

## Structure

- `src/index.ts`: registers the `agent` reporter with Stryker and exposes its option schema.
- `src/agent-reporter.ts`: the reporter itself, and its partial-file logic.
- `src/build-lines.ts`: builds a mutant's key and the rest of a JSON-Lines line from a report and its metrics. Shared by `agent-reporter.ts` and `convert.ts`, so a mutant's key is computed by one function, not two.
- `src/convert.ts`: turns a saved `mutation.json` into the same output `agent-reporter.ts` would have written.
- `src/gate.ts`: turns an `agent.jsonl` file into a pass/fail check. Reads only the JSON-Lines format `docs/output.md` defines; does not import the reporter.
- `src/cli.ts`: the `stryker-agent-reporter` command's entry point; dispatches to `convert` and `gate`.
- `schema/agent-reporter-options.json`: the JSON Schema for the `agentReporter` config option.
- `test/agent-reporter.test.ts`, `test/convert.test.ts`, `test/gate.test.ts`, `test/cli.test.ts`: unit tests, run with `node:test` against real temporary files (and, for `gate`'s `--since`, a real git repository).
- `test/e2e/`: an end-to-end test that runs a real Stryker mutation test run over a small fixture project.
- `docs/output.md`: every field the reporter writes, and `convert`'s and `gate`'s own input and output.
- `docs/adr/`: design records.
- `docs/releasing.md`: the release process, and the npm trusted-publisher bootstrap for this package's first version.

## Commands

- `npm run typecheck` runs `tsc --noEmit` over `src` and `test`.
- `npm test` runs the unit tests.
- `npm run build` emits `dist/` from `src/`.
- `npm run test:e2e` runs the end-to-end test; it needs `npm run build` first.
- `node dist/cli.js convert [mutation.json] [--output <file>]` and `node dist/cli.js gate [agent.jsonl] [--since <ref>] [--baseline <file>] [--format jsonl|github|text]` run the built commands directly; see `docs/output.md`.

## Rules

- Write all committed text in English: code, comments, docs, commit messages.
- Follow ASD-STE100 (Simplified Technical English) in documentation: one word for one meaning, active voice, short sentences, explicit articles.
- Do not add a dependency without the owner's approval.
- `src/` only uses erasable TypeScript syntax (no parameter properties, no enum, no namespace): tests run it directly through Node's type stripping, with no build step.
- This repository is intended for public release; do not reference private tools or internal working documents.
- If you change README.md, change README.ja.md to match.
