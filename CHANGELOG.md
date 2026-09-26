# Changelog

Before 1.0, a minor version may change the API.

## Unreleased

## 0.1.0 (2026-09-26)

- The `agent` Stryker reporter: a JSON-Lines final file, and a partial file an agent can read before the run finishes. See `docs/output.md`.
- `stryker-agent-reporter convert`: turns a saved `mutation.json` into the same JSON-Lines file the reporter would have written for that run.
- `stryker-agent-reporter gate`: turns an `agent.jsonl` file into a pass/fail check, with `--since` to scope it to a git ref's changed lines and `--baseline` to compare against a previous run.
