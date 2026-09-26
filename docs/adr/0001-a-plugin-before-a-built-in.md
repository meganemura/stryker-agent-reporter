# 1. A plugin before a built-in

## Context

An earlier version of this reporter was written as a built-in reporter, on a branch of a Stryker fork. It measured 1,086 lines for the reporter and 912 lines for its test. A pull request that size is large to review in one pass. The output shape had not yet been used on a real project long enough to settle, either.

## Decision

Ship this reporter as an independent plugin first. Use it on real projects, let the output shape settle, then propose a built-in reporter to Stryker upstream.

Keep the reporter's name `agent`, so a project that adopts the built-in reporter later, once it exists, changes no configuration.

## Rejected alternatives

- Submit the pull request to Stryker now: the reporter is large to review in one pass. Its output shape still has room to change based on real use.
- Give the plugin a different name than the eventual built-in reporter: this would break a user's configuration on migration to the built-in reporter.

## Consequences

The reporter carries its own versions of two functions Stryker's own internal reporters use, `reporterUtil.writeFile` and `normalizeReportFileName`. It reads `version` from the installed `@stryker-mutator/core` package instead of importing Stryker's internal `strykerVersion` export. When Stryker's major version increases, the peer dependency range on `@stryker-mutator/api` and `@stryker-mutator/core` needs review.
