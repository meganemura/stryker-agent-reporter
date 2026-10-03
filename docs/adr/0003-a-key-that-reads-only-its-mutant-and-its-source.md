# 3. A key that reads only its mutant and its source

## Context

Version 0.1.0 built a mutant's `key` from the mutant's text and two ordinals. One ordinal numbered mutants that share a line and a replacement. The other numbered mutants that share a repeated line. The code counted both ordinals over the mutants of the run, not over the source file. The `--mutate` option changes which mutants a run plans. So a narrower range changed a mutant's ordinal, and with it the key.

A user saw this on one mutant. A wide run gave it the key `68aa41de9e39`. A run narrowed to its range gave it `a0f92cc50480`. A second case is worse. Take the line `const s = a + a + a;`, with both `+` mutated to `-`, and a run narrowed to the second `+`. The second mutant then took the first mutant's key, so a baseline matched the wrong mutant.

A second problem sits next to the first. A `Killed` mutant has no line in the output. A reader who finds a key missing cannot tell "outside the `mutate` range" from "generated, then killed". The reader had to read the Stryker configuration and the source ranges again.

## Decision

A key reads only the path of its file, the whole source of that file, and one mutant. The code gets the source through `sourceFile(path, source)`. Its `keyOf(site)` takes one mutant and has no access to the other mutants of the run. So no `mutate` range can change a key. The hash input is in [docs/output.md](../output.md).

Two numbers replace the two ordinals. Both come from the source text alone:

- The start and the end of the mutant's location, each counted from the first non-blank character of its line. They tell apart two mutants on one line.
- The number of earlier copies of the same line or lines in the file. It tells apart two mutants on repeated lines. The code always hashes it, also when it is `0`.

Each mutated file gets one `scope` line. It lists the key of every mutant Stryker generated for the file, and the keys of the pending ones. A reader decides "not generated", "killed", "pending", or "has a line" by looking a key up in that line. The `scope` line also carries the file's `sourceHash`.

The `run` line gains the `mutate` and `incremental` options as Stryker used them, each only when the producer knows it. They echo the configuration. They are not evidence.

`gate --baseline` reports a baseline survivor as fixed only when the run generated its key. A survivor that the run did not generate becomes an `outOfScope` line. A survivor that is still pending produces no line.

This is a breaking change. `schemaVersion` becomes `"3"`, every key changes, and `gate` reads only version 3.

## Rejected alternatives

- Keep the ordinals and write a table from old keys to new keys. A narrow run does not have the plan of the wide run, so it cannot write the table. The key would still depend on the plan.
- Hash only the mutant's own text, with no ordinal. This is range-independent by construction. It also gives two different mutants the same key: the same text on two lines, or two `+` on one line. `gate --baseline` would then let one surviving copy hide a new survivor on the other copy.
- Count the ordinals over the source with a filter by mutator and replacement. The filter needs the mutants, and the key would depend on the plan again. Counting lines of text needs no filter.
- Put the resolved `mutate` ranges on the `run` line, or a parser for the patterns. The code would handle only patterns that name one file exactly. It would not resolve a glob. With `incremental` it would mislead, because Stryker adds results of earlier runs for mutants outside the range. The generated keys are the result a reader needs.
- Write one line for each killed mutant. A run with 14,140 mutants would add an estimated 640 KB (about 45 bytes for each line), and an agent would read thousands of lines it cannot act on. One list of keys per file gives the same answer in about 212 KB.
- Write the list of keys to a separate file. `convert` writes one stream, and a second file is one more thing to carry and to lose.

## Consequences

Every key from version 2 differs from the key of the same mutant now. `gate` refuses a version 2 input or baseline with exit `2`. A user who kept the `mutation.json` of the baseline run can make a version 3 baseline with `convert`.

Three limits remain. An edit to the mutant's own line changes its key. A change to the leading or trailing blanks of that line does not. A copy of the same line added above the mutant moves the key to a different copy of that line, so `--baseline` can then match the wrong physical copy. A copy added below changes nothing.

Two mutants with the same location, mutator, and replacement share a key. `keys` lists it twice.

Under `--incremental`, Stryker adds the stored results of earlier runs for mutants outside the `mutate` range. Those keys are in `keys`, so "generated and killed" can rest on an earlier run. The `incremental` field on the `run` line tells the reader when this applies. In the same case, Stryker sets the replacement of a reused mutant that has none to its mutator name. The key hashes the replacement, so a description-only mutant gets a different key when Stryker reuses it than when Stryker generates it.

The `scope` lines add about 15 bytes for each mutant. On a run with 14,140 mutants that is about 212 KB.

`gate --since` can now find a stale file that has only `noCoverage` mutants, because the `scope` line carries the file's `sourceHash`.
