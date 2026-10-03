# Changelog

Before 1.0, a minor version may change the API.

## Unreleased

## 0.2.0 (2026-10-04)

Breaking: every `key` changes, and `schemaVersion` is now `"3"`. A key from 0.1.0 matches no key from 0.2.0. To get a version 3 file from a saved report, run `convert` on its `mutation.json`.

- A mutant's `key` now reads only its file's path, the whole source of that file, and the mutant. A narrower or wider `mutate` range no longer changes it. In 0.1.0, a narrower range changed the key of a mutant that was still in the run, and a column range could give one mutant the key of another. See `docs/adr/0003-a-key-that-reads-only-its-mutant-and-its-source.md`.
- The final file has one `scope` line for each mutated file. It lists the key of every generated mutant and the keys of the pending ones, so a reader can tell a killed mutant from a mutant that the `mutate` range left out. The partial file has the same line without the pending list.
- The `run` line carries `mutate` and `incremental` when the producer knows them.
- `gate --baseline` reports a baseline survivor as fixed only when the run generated its key. A survivor that the run did not generate becomes an `outOfScope` line, and `summary` counts them in `outOfScope`. In 0.1.0, every survivor outside a narrower range looked fixed.
- `gate --since` with `--baseline` no longer reports a survivor on an unchanged line as fixed.
- `gate --since` can find a stale file that has only `noCoverage` lines, because the `scope` line carries the file's `sourceHash`.
- `gate` reads only `schemaVersion` `"3"` and exits `2` for any other version.

## 0.1.0 (2026-09-26)

- The `agent` Stryker reporter: a JSON-Lines final file, and a partial file an agent can read before the run finishes. See `docs/output.md`.
- `stryker-agent-reporter convert`: turns a saved `mutation.json` into the same JSON-Lines file the reporter would have written for that run.
- `stryker-agent-reporter gate`: turns an `agent.jsonl` file into a pass/fail check, with `--since` to scope it to a git ref's changed lines and `--baseline` to compare against a previous run.
