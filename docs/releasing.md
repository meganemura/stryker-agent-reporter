# Releasing

Each version step below is one command, run from the root, on a clean `main` that CI has passed.

Pushing a `v*` tag runs [`.github/workflows/publish.yml`](../.github/workflows/publish.yml). The workflow checks out that tag, installs from the lockfile, builds `dist/`, runs the release checks, and runs `npm publish`. npm authenticates with the GitHub Actions OIDC token for the GitHub Environment `publish`. Provenance is attached because the repository and the package are public. The environment is the human gate: the job waits until it is approved. The workflow stores no `NPM_TOKEN`, and the repository secrets do not keep one.

`dist/` is gitignored. The workflow builds it, then `prepack` builds it again, and that tree is what is published. `npm pack --dry-run` names the tarball's contents: `dist/`, `schema/`, `README.md`, `LICENSE`, and `package.json`.

An environment and a trusted publisher create no state in this repository; they exist only in GitHub's and npm's own settings. Create them once, using the values below, before the first release.

## Bootstrap: done with a placeholder

npm lets a trusted publisher be added only to a package that already exists. The bootstrap for this package is done:

1. On 2026-09-26, a short-lived, granular npm access token published `0.0.1`, a placeholder that holds the package name. It contains `package.json`, `README.md`, and `LICENSE`, and no code. The token was deleted after that one publish.
2. The GitHub Actions trusted publisher was then added on npmjs.com, with the values under "Trusted publisher" below.
3. `0.1.0`, the first usable version, is the first publish through OIDC. After it succeeds, set the package to disallow token publishing, and deprecate the placeholder: `npm deprecate stryker-agent-reporter@0.0.1 "placeholder"`.
4. Every `v*` tag publishes through OIDC alone; see "Each version" below.

Do not repeat the bootstrap. A token publish is needed again only if the package is deleted from npm.

## Trusted publisher

The fields are case-sensitive:

- Organization or user: `meganemura`
- Repository: `stryker-agent-reporter`
- Workflow filename: `publish.yml` (the filename, including `.yml`)
- Environment name: `publish`
- Allowed action: `npm publish`

A trusted publisher created after 3 September 2026 starts with `npm stage publish` allowed. Select `npm publish` as well: the workflow runs `npm publish`.

`package.json` `repository.url` is `git+https://github.com/meganemura/stryker-agent-reporter.git`. npm checks that URL against the workflow repository.

The GitHub Environment `publish` needs required reviewers, so a tag push waits for a human approval before the job runs `npm publish`.

An approval appears only after a `v*` tag starts `publish.yml` and the job waits on the Environment `publish`. Registering the trusted publisher does not queue an approval.

## Action SHA pins

`publish.yml` and `ci.yml` pin each `uses:` to a full 40-character commit SHA, with the version in a comment on the same line:

- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
- `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0`

Set the repository's `sha_pinning_required` setting once the repository exists on GitHub.

## Each version

1. Choose the version by SemVer (before 1.0, a minor version may change the API; `CHANGELOG.md`'s own opening line says so). Set it in `package.json`, then turn `CHANGELOG.md`'s `## Unreleased` heading into `## <version> (<date>)`. Add a `## Unreleased` heading first if none exists.
2. `npm install --package-lock-only` so the lock file carries the version.
3. `npm test` and `npm run typecheck`.
4. `npm pack --dry-run` and read the file list: `dist/`, `schema/`, `README.md`, `LICENSE`, `package.json`, and nothing else.
5. Commit as `release: <version>`, tag `v<version>`, push the commit and the tag. The tag without the leading `v` is the `package.json` version; the workflow stops when they differ. The tag push starts the workflow.
6. Approve the `publish` environment on that Actions run. The approval is requested when the job waits on that environment, which happens only after the tag starts `publish.yml`. The workflow uses Node 24 on `ubuntu-latest` with the npm registry URL set. It requires Node 24.20 or later on that line and npm 11.5.1 or later. It runs `npm ci`, `npm run build`, a check that the build did not modify tracked files, `npm run typecheck`, `npm test`, and `npm run test:e2e`, then `npm publish`. `dist/` is gitignored, so the new build output is expected and is what gets packed.
7. A GitHub release from the tag, with that version's CHANGELOG entry as its text. `--notes-file CHANGELOG.md` would paste every version, so extract the section first: `awk '/^## <version>/{f=1;next} /^## /{f=0} f' CHANGELOG.md > notes.md`, then `gh release create v<version> --title v<version> --notes-file notes.md`.

Approving the `publish` environment, and a change of the repository's visibility, are the owner's to run.
When the repository is public, private vulnerability reporting stays on in its Security settings; `SECURITY.md` points there, and the setting exists only for a public repository.
