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

1. One `run` line, first. It carries `schemaVersion` (`"3"`), `tool` (`"stryker"`), `strykerVersion`, `disableBail`, and `concurrency`. It also carries `mutate` (the `mutate` patterns Stryker used) and `incremental` (the `incremental` option), each only when the producer knows it. The live reporter always knows both, because Stryker gives it its resolved options; `mutate` can then be Stryker's default patterns. `convert` reads both from the saved report's `config`. A report without them gives a `run` line without them. They echo the configuration for the reader; they are not evidence of what the run generated. The `scope` lines are the evidence.
2. One `scope` line per file that has a mutant in this run, sorted by `file`. See [The `scope` line](#the-scope-line).
3. One line per mutant an agent can act on. The `kind` is one of `survivor`, `unverified`, `timeout`, `noCoverage`, `ignored`, `invalid`. Lines of one `kind` are grouped together, in this order. Each group is sorted by `(file, location.start.line, location.start.column, mutatorName, replacement)`. A `Killed` or `Pending` mutant has no line here; the summary line counts it instead. An `unverified` mutant is a `Survived` mutant whose covering tests did not complete. This is a known measurement gap, [stryker-js issue #6210](https://github.com/stryker-mutator/stryker-js/issues/6210). A mutant with no covering test at all is `noCoverage` instead.
4. One `testWithoutKills` line per test that killed no mutant, sorted by `(file, name)`.
5. One `summary` line, last. It carries the same counts and score Stryker always reports.

A run that stops before it finishes has no `summary` line. The absence of a `summary` line means the run did not finish.

## Fields on an actionable mutant line

- `kind`: one of `survivor`, `unverified`, `timeout`, `noCoverage`, `ignored`, `invalid`.
- `key`: a stable identifier for this mutant. It is a hash of these values:
  - the mutant's file;
  - the text of the line or lines its `location` covers, each line trimmed;
  - the start and the end of its `location`, each counted in characters from the first non-blank character of its line;
  - the mutator name;
  - the replacement text;
  - the number of earlier copies of the same line or lines in the file.

  The key reads only the mutant and the whole source of its file. It does not read the other mutants of the run. So a narrower or wider `mutate` range gives the same mutant the same key. The key carries no line number, so an edit elsewhere in the file does not change it. Four limits:
  - An edit to the mutant's own line or lines changes its key. A change to the leading or trailing blanks of those lines does not.
  - A copy of the same line or lines, added or removed above the mutant, changes the count of earlier copies. The key then moves to a different copy. A copy added below changes nothing.
  - Two mutants with the same `location`, mutator, and replacement have the same key. This happens, for example, with two description-only mutants at one location.
  - With the `incremental` option, Stryker adds the stored results of earlier runs for mutants outside the `mutate` range. For such a mutant that has no replacement, it sets the replacement to the mutator name. That mutant gets a different key than a fresh run gives it.
- `file`: the mutated file's path, relative to the project root.
- `location`: the mutant's 1-based `{ start, end }` position in `file`.
- `mutatorName`: the Stryker mutator that produced this mutant.
- `replacement`: the text the mutator put in place of `original`, when the mutator has one (some mutators only describe the change instead).
- `original`: the exact source text the mutant replaces.
- `static` (`survivor`, `unverified`, `timeout` only): `true` when the mutant runs once, during module load, instead of once per test.
- `tests` (`survivor`, `unverified`, `timeout` only, final file only): a summary of the tests covering this mutant: `total`, `truncated` (`true` when the list below was cut), and `files` (each with `file`, `count`, and up to 3 `names`, capped at 10 files).
- `rerun` (`survivor`, `unverified`, `timeout` only): a command that reruns this mutant's file, incrementally.
- `rerunExact` (`survivor`, `unverified`, `timeout` only): a command that reruns this exact mutant, by position, forcing a fresh run.
- `sourceHash` (`survivor`, `unverified`, `timeout` only): a hash of the mutated file's source at the time of the run, so an agent can tell whether the file changed since. The file's `scope` line carries the same value.
- `patch` (`survivor`, `unverified`, `timeout` only, final file only): a `git apply --unidiff-zero`-ready patch that applies this exact mutation.
- `reason` (`ignored` only): why Stryker ignored this mutant.
- `status`, `statusReason` (`invalid` only): the mutant's status (`CompileError` or `RuntimeError`) and why.

A `reason` or `statusReason` has its sandbox path, its project root, and any cache-busting query string stripped. This way, the same mutant's line reads the same across reruns.

## The `scope` line

A `Killed` mutant has no line of its own, so a missing key alone does not tell a reader why the key is missing. The `scope` line answers this. The final file has one per file that has at least one mutant in the run. Example:

```json
{"kind":"scope","file":"src/rules/cycles.ts","sourceHash":"7c1cae4b334c6a13","keys":["8764c5229f05","2e79224b8652"],"pending":[]}
```

- `file`: the mutated file's path, relative to the project root.
- `sourceHash`: a hash of the file's source at the time of the run. It has the same value as `sourceHash` on the file's item lines.
- `keys`: the `key` of every mutant Stryker generated for this file in this run, whatever its status. The order is `(location.start.line, location.start.column, mutatorName, replacement)`. A key can appear twice when two mutants have the same key.
- `pending` (final file only): the `key` of every mutant that has the status `Pending`. It is `[]` when no mutant is pending.

To find out what happened to a key `K` of file `F`, read the final file in this order:

1. `F` has no `scope` line: this run has no mutant in `F`.
2. `K` is not in the `keys` of `F`: this run did not generate `K`. The `mutate` range can have left it out. The source of `F` can have changed: compare `sourceHash` with the value the key came from. Or no such mutant exists.
3. `K` is in `keys`, and an item line has `key` equal to `K`: that line's `kind` is the result.
4. `K` is in `keys` and in `pending`: Stryker did not finish testing it.
5. `K` is in `keys`, not in `pending`, and no item line has it: Stryker killed it.

With the `incremental` option, Stryker adds the stored results of earlier runs for mutants outside the `mutate` range. Those mutants are in `keys`, and step 5 can then rest on a result from an earlier run. The `run` line's `incremental` field tells a reader when this applies.

The partial file has no `pending` list, and its item lines arrive while the run goes. So steps 4 and 5 do not apply to it: there, a key in `keys` without an item line has no result yet.

Size: one key takes 15 bytes in the array, so a run with 14,140 mutants adds about 212 KB.

## The partial file

While a run is still going, the final file (`reports/mutation/agent.jsonl` by default) does not exist yet: Stryker writes it once, at the end. So an agent can start fixing survivors sooner, the reporter also writes a partial file next to it. Its name is the final file's name with `.partial` before the extension, always ending in `.jsonl` (`reports/mutation/agent.jsonl` becomes `reports/mutation/agent.partial.jsonl`).

The partial file gets a `run` line as soon as Stryker has planned which mutants to test. One `scope` line per planned file follows it, without `pending`: no mutant has a result yet. A planned file that the reporter cannot read gets no `scope` line and no mutant lines in the partial file; the reporter logs a warning, and the final file still has both. One line per mutant follows, appended in the order each mutant finishes, since that order is not known ahead of the run. Once the final file exists, the run is done; read the final file and skip the partial file.

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

Reads an `agent.jsonl` file (default `reports/mutation/agent.jsonl`) and turns it into a pass/fail check. The input's `run` line must have `schemaVersion` `"3"`; for any other value, `gate` exits `2` and tells the user to rebuild the file with `convert` from its `mutation.json`. The input's last line must be a `summary` line; an input with no `summary` line is an unfinished run, and `gate` exits `3` without reading it further.

- `--since <ref>`: narrows `survivor`, `unverified`, `timeout`, and `noCoverage` lines to the mutants whose `location` overlaps a line `git diff --unified=0 <ref> -- <file>` reports as added or changed, one file at a time. A file git does not track at all counts as changed on every one of its own lines. A file whose current content no longer matches the `sourceHash` on its `scope` line, or a file `git diff` itself fails to read, is dropped instead of filtered on a line number it can no longer trust. This check covers a file that has only `noCoverage` lines too, because the `scope` line carries the hash. A file that has no `scope` line cannot be checked and counts as stale. Each dropped file becomes a `{"kind":"stale", file, reason}` line and a warning on standard error. `--since` needs `git` on `PATH` and a ref that resolves to a commit; a missing `git` or an unknown ref exits `2`.
- `--baseline <file>`: compares this run's survivors against a previous `agent.jsonl`'s, matched by `key`. The baseline needs `schemaVersion` `"3"` too; otherwise `gate` exits `2`. A survivor this run has and the baseline does not carries `new: true`. A baseline survivor that this run does not report as `survivor` or `unverified` falls into one of three cases. A survivor that moved to `unverified` ran no test this time, so its absence says nothing about a fix.
  - Its key is in the `pending` list of its file's `scope` line: the run did not finish testing it. `gate` writes no line and counts nothing.
  - Its key is in the `keys` of its file's `scope` line: this run generated it, and this run no longer reports it as a survivor or as unverified. It becomes a `{"kind":"fixedSurvivor", ...}` line. Stryker can have killed it, or it can now have a line of another kind (`timeout`, `noCoverage`, `ignored`, or `invalid`); the item line of that key, if any, tells which. `gate` reads all of these lists before `--since` narrows the output, so a survivor on an unchanged line is still a survivor.
  - Its key is in neither list: this run did not generate it. A narrower `mutate` range causes this most often. It becomes a `{"kind":"outOfScope", ...}` line, with the same fields as a `fixedSurvivor` line. It is not a fix, and it does not change the exit code.
- `--format jsonl` (default): the same shape as `reports/mutation/agent.jsonl`, filtered to the lines above. The `scope` lines come right after the `run` line, then the `stale` lines. The `summary` line gains `scoped` and `staleCount` with `--since`, and `newSurvivors`, `fixedSurvivors`, and `outOfScope` with `--baseline`.
- `--format github`: one GitHub Actions workflow command per `survivor`, `noCoverage`, `unverified`, or `stale` entry, so a check can annotate the changed line directly: `::error file=<file>,line=<line>,endLine=<end line>,title=<mutatorName> survived::<original> -> <replacement>` for a survivor or an uncovered mutant, `::warning ...` for an unverified mutant or a stale file. A `%`, a carriage return, or a newline in a value is escaped per GitHub's own rule (`%` becomes `%25`, `\r` becomes `%0D`, `\n` becomes `%0A`).
- `--format text`: one block per item (its file, line, `mutatorName`, and `key`; its `patch`, when the item carries one; its `rerun` and `rerunExact`), then a stale-file line per stale file, then a summary line.
- Exit code: `0` when nothing needs attention. `1` when a survivor or an uncovered mutant remains (with `--baseline`, only a new survivor counts). `2` on a usage error, such as an input or baseline file with a `schemaVersion` other than `"3"`. `3` when an unverified mutant or a stale file remains, or the input is an unfinished run: a measurement failure, kept apart from a real survivor so neither reads as a test failure.

### Compatibility

Adding a field to a line, or a new `kind`, is a minor change to this format. Removing a field, renaming a field, or changing a field's meaning is a breaking change. A reader may ignore a field or a `kind` it does not recognize.

`schemaVersion` `"3"` changed what a `key` means: every key from `schemaVersion` `"2"` differs from the key of the same mutant now, and no key from version 2 matches one from version 3. `gate` reads only version 3. To get a version 3 file from a saved report, run `convert` on its `mutation.json`. The design record [3. A key that reads only its mutant and its source](adr/0003-a-key-that-reads-only-its-mutant-and-its-source.md) gives the reason.
