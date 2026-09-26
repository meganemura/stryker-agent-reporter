# Output

The reporter writes [JSON Lines](https://jsonlines.org/): one JSON object per line, no commas between lines. A coding agent can read one line at a time, and can filter lines with `grep` or `jq` without parsing the whole file.

## Options

Set these under `agentReporter` in the Stryker config file:

```json
{
  "agentReporter": {
    "fileName": "reports/mutation/agent.jsonl",
    "partial": true
  }
}
```

- `fileName`: the relative path of the final report file. Default: `reports/mutation/agent.jsonl`.
- `partial`: whether to write the partial file described below. Default: `true`. Set to `false` to write only the final file.

## Line order

Each line has a `kind` field. The file has this order:

1. One `run` line, first. It carries `schemaVersion`, `tool` (`"stryker"`), `strykerVersion`, `disableBail`, and `concurrency`.
2. One line per mutant an agent can act on. The `kind` is one of `survivor`, `unverified`, `timeout`, `noCoverage`, `ignored`, `invalid`. Lines of one `kind` are grouped together, in this order. Each group is sorted by `(file, location.start.line, location.start.column, mutatorName, replacement)`. A `Killed` or `Pending` mutant has no line here; the summary line counts it instead. An `unverified` mutant is a `Survived` mutant whose covering tests did not complete. This is a known measurement gap, [stryker-js issue #6210](https://github.com/stryker-mutator/stryker-js/issues/6210). A mutant with no covering test at all is `noCoverage` instead.
3. One `testWithoutKills` line per test that killed no mutant, sorted by `(file, name)`.
4. One `summary` line, last. It carries the same counts and score Stryker always reports.

A run that stops before it finishes has no `summary` line. The absence of a `summary` line means the run did not finish.

## Fields on an actionable mutant line

- `kind`: one of `survivor`, `unverified`, `timeout`, `noCoverage`, `ignored`, `invalid`.
- `key`: a stable identifier for this mutant. It is a hash. The hashed fields are the mutant's file, its enclosing line, its original text (whitespace collapsed to one space), its replacement text, and its mutator name. Two ordinals are hashed too: one numbers a repeated tuple of those fields by column; the other, by order of appearance in the file. The key carries no line or column, so an edit elsewhere in the file does not change it. Its weak point: a copy of an identical line, added or removed, can shift a later mutant's ordinal, and so its key.
- `file`: the mutated file's path, relative to the project root.
- `location`: the mutant's 1-based `{ start, end }` position in `file`.
- `mutatorName`: the Stryker mutator that produced this mutant.
- `replacement`: the text the mutator put in place of `original`, when the mutator has one (some mutators only describe the change instead).
- `original`: the exact source text the mutant replaces.
- `static` (`survivor`, `unverified`, `timeout` only): `true` when the mutant runs once, during module load, instead of once per test.
- `tests` (`survivor`, `unverified`, `timeout` only, final file only): a summary of the tests covering this mutant: `total`, `truncated` (`true` when the list below was cut), and `files` (each with `file`, `count`, and up to 3 `names`, capped at 10 files).
- `rerun` (`survivor`, `unverified`, `timeout` only): a command that reruns this mutant's file, incrementally.
- `rerunExact` (`survivor`, `unverified`, `timeout` only): a command that reruns this exact mutant, by position, forcing a fresh run.
- `sourceHash`: a hash of the mutated file's source at the time of the run, so an agent can tell whether the file changed since.
- `patch` (`survivor`, `unverified`, `timeout` only, final file only): a `git apply --unidiff-zero`-ready patch that applies this exact mutation.
- `reason` (`ignored` only): why Stryker ignored this mutant.
- `status`, `statusReason` (`invalid` only): the mutant's status (`CompileError` or `RuntimeError`) and why.

A `reason` or `statusReason` has its sandbox path, its project root, and any cache-busting query string stripped. This way, the same mutant's line reads the same across reruns.

## The partial file

While a run is still going, the final file (`reports/mutation/agent.jsonl` by default) does not exist yet: Stryker writes it once, at the end. So an agent can start fixing survivors sooner, the reporter also writes a partial file next to it. Its name is the final file's name with `.partial` before the extension, always ending in `.jsonl` (`reports/mutation/agent.jsonl` becomes `reports/mutation/agent.partial.jsonl`).

The partial file gets a `run` line as soon as Stryker has planned which mutants to test. One line per mutant follows, appended in the order each mutant finishes, since that order is not known ahead of the run. Once the final file exists, the run is done; read the final file and skip the partial file.

A line in the partial file carries the same fields as the final file, except two: `tests` (which tests cover the mutant) and `patch` (a ready-to-apply diff). Both need data available only once every result is in. The final file always carries the complete set of fields for every line.

Set `agentReporter.partial` to `false` to skip the partial file. With Stryker's `inPlace` option, the reporter never writes the partial file: by the time the plan is ready, Stryker has already written the instrumented code over the original file, and the keys need the original source.

## Read it like this

```bash
grep '"file":"src/example.ts"' reports/mutation/agent.jsonl
jq -c 'select(.kind=="survivor")' reports/mutation/agent.jsonl
tail -n 1 reports/mutation/agent.jsonl
```

## Commands

`stryker-agent-reporter` reads this format; it does not import the reporter's own code. `convert` shares one function with the reporter for a mutant's key and the rest of a line's fields, so the two never drift apart. `gate` reads the format alone.

### `convert`

```
stryker-agent-reporter convert [mutation.json] [--output <file>]
```

Reads a saved Stryker report (default `reports/mutation/mutation.json`) and writes the same JSON-Lines text the `agent` reporter would have written for that run, to standard output or, with `--output`, to a file. The report's `schemaVersion` must start with `1.`; otherwise `convert` exits `2`.

### `gate`

```
stryker-agent-reporter gate [agent.jsonl] [--since <ref>] [--baseline <file>] [--format jsonl|github|text]
```

Reads an `agent.jsonl` file (default `reports/mutation/agent.jsonl`) and turns it into a pass/fail check. The input's last line must be a `summary` line; an input with no `summary` line is an unfinished run, and `gate` exits `3` without reading it further.

- `--since <ref>`: narrows `survivor`, `unverified`, `timeout`, and `noCoverage` lines to the mutants whose `location` overlaps a line `git diff --unified=0 <ref> -- <file>` reports as added or changed, one file at a time. A file git does not track at all counts as changed on every one of its own lines. A file whose current content no longer matches a `sourceHash` recorded for it, or a file `git diff` itself fails to read, is dropped instead of filtered on a line number it can no longer trust; it becomes a `{"kind":"stale", file, reason}` line and a warning on standard error. `--since` needs `git` on `PATH` and a ref that resolves to a commit; a missing `git` or an unknown ref exits `2`.
- `--baseline <file>`: compares this run's survivors against a previous `agent.jsonl`'s, matched by `key`. A survivor this run has and the baseline does not carries `new: true`. A survivor the baseline has and this run does not, and that this run does not report as `unverified` either, becomes a `{"kind":"fixedSurvivor", ...}` line: a survivor that moved to `unverified` ran no test this time, so its absence says nothing about a fix.
- `--format jsonl` (default): the same shape as `reports/mutation/agent.jsonl`, filtered to the lines above. A `stale` line comes right after the `run` line. The `summary` line gains `scoped` and `staleCount` with `--since`, and `newSurvivors` and `fixedSurvivors` with `--baseline`.
- `--format github`: one GitHub Actions workflow command per `survivor`, `noCoverage`, `unverified`, or `stale` entry, so a check can annotate the changed line directly: `::error file=<file>,line=<line>,endLine=<end line>,title=<mutatorName> survived::<original> -> <replacement>` for a survivor or an uncovered mutant, `::warning ...` for an unverified mutant or a stale file. A `%`, a carriage return, or a newline in a value is escaped per GitHub's own rule (`%` becomes `%25`, `\r` becomes `%0D`, `\n` becomes `%0A`).
- `--format text`: one block per item (its file, line, `mutatorName`, and `key`; its `patch`, when the item carries one; its `rerun` and `rerunExact`), then a stale-file line per stale file, then a summary line.
- Exit code: `0` when nothing needs attention. `1` when a survivor or an uncovered mutant remains (with `--baseline`, only a new survivor counts). `2` on a usage error. `3` when an unverified mutant or a stale file remains, or the input is an unfinished run: a measurement failure, kept apart from a real survivor so neither reads as a test failure.

### Compatibility

Adding a field to a line, or a new `kind`, is a minor change to this format. Removing a field, renaming a field, or changing a field's meaning is a breaking change. A reader may ignore a field or a `kind` it does not recognize.
