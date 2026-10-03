# stryker-agent-reporter

A [Stryker](https://stryker-mutator.io/) reporter for a coding agent. It writes [JSON Lines](https://jsonlines.org/): one line per actionable mutant, one summary line, and a partial file an agent can read before the run finishes.

## Install

```bash
npm install --save-dev stryker-agent-reporter
```

## Configure

```json
{
  "reporters": ["clear-text", "agent"],
  "plugins": ["@stryker-mutator/*", "stryker-agent-reporter"]
}
```

Stryker's default `plugins` value loads only `@stryker-mutator/*` packages. Add `stryker-agent-reporter` to `plugins` so Stryker loads the `agent` reporter too.

## Output

The reporter writes to `reports/mutation/agent.jsonl` by default. Each line has a `kind` field. A `run` line comes first, then one `scope` line per mutated file, then one line per actionable mutant, then one line per test that killed no mutant, then a `summary` line last. A `scope` line lists the key of every mutant Stryker generated for its file. With it, a reader can tell a mutant that Stryker killed from a mutant that a narrower `mutate` range left out. See [docs/output.md](docs/output.md) for every field.

## Read it while the run goes

A run writes its final file only once, at the end. Before that, read the partial file next to it (`reports/mutation/agent.partial.jsonl`):

```bash
tail -f reports/mutation/agent.partial.jsonl
```

## Convert a saved report

`stryker-agent-reporter convert` turns a saved `reports/mutation/mutation.json` into the same JSON-Lines file the `agent` reporter would have written for that run, for a report you already have but did not run with the `agent` reporter configured.

## Gate a pull request

`stryker-agent-reporter gate` turns an `agent.jsonl` file into a pass/fail check for a pull request, scoped to the lines it changed:

```bash
npx stryker-agent-reporter gate --since origin/main --format github
```

| Exit code | Meaning |
| --- | --- |
| `0` | Nothing to act on. |
| `1` | A survivor or an uncovered mutant remains. |
| `2` | A usage error: an unreadable file, an unknown flag, a file that is not `schemaVersion` `"3"`, or, with `--since`, a missing `git` or an unknown ref. |
| `3` | An unverified mutant, or a file `--since` could not scope: a measurement failure, not a proven gap. |

See [docs/output.md](docs/output.md) for `gate`'s and `convert`'s full input and output.

## License

Apache-2.0

---

[Japanese](README.ja.md)
