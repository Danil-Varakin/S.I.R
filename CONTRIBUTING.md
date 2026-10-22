# Contributing

> Русская версия: [CONTRIBUTING.ru.md](./CONTRIBUTING.ru.md)

How to work on Hatch. The design rationale is in [ARCHITECTURE.md](./ARCHITECTURE.md), the
versioning rules in [VERSIONING.md](./VERSIONING.md).

## Prerequisites

- **Node 22+.** Sources are `.ts` and run directly through
  `node --experimental-strip-types`: development has no build step. `npm run build`
  (`tsconfig.build.json` → `dist/`) is needed only for the package.
- `npm install` pulls three runtime dependencies: `web-tree-sitter` (WASM grammars —
  cross-platform, no compiler, no `node-gyp`), `diff` (the line diff under `generate`)
  and `simple-git` (reading a version out of git).
- Grammars load asynchronously: an adapter exposes `init(): Promise<void>`, awaited once
  at startup, after which `buildMap` is synchronous. Anything that calls `buildMap` —
  tests included — must `await adapter.init()` first.

## Run and check

```bash
npm test           # node --test over test/**/*.test.ts
npm run typecheck  # tsc over src/, test/ and bench/ (three configs)
npm run check      # both — run before every commit
npm run bench      # speed measurements (bench/); not part of check
```

The commands run straight from the sources:

```bash
npm run hatch -- <command> …
npm run apply -- --match changes.hatch --in src/main.cpp --out out.cpp
npm run generate -- --in new.cpp --in-old old.cpp --debug
npm run service    # the JSON-lines service, PROTOCOL.md
```

A red `npm run check` blocks the commit.

## The strict tsconfig

Each flag is there for a reason; do not loosen one without it:

- **`noEmit` + `allowImportingTsExtensions`** — `tsconfig.json` only checks types;
  sources run through strip-types, so imports are written with the `.ts` extension.
  The package build (`tsconfig.build.json`) turns emit on and adds
  `rewriteRelativeImportExtensions`, which rewrites `.ts` → `.js` in the output.
- **`verbatimModuleSyntax` + `isolatedModules`** — type-only imports MUST be
  `import type { … }`: a module imports types from `ast.ts` with `import type`, and the
  value `ParseError` with a plain `import`.
- **`noUncheckedIndexedAccess`** — index access (`arr[i]`, `m.groups[k]`) yields
  `T | undefined`. Handle it explicitly: `?? ''`, `.entries()`, a guard, or `!` where an
  invariant guarantees the value.
- **`exactOptionalPropertyTypes`** — `hint?: string` does NOT include `undefined`;
  assign the field only when a value exists (`if (hint !== undefined) …`). When an
  options object legitimately receives a computed `T | undefined`, widen that one field
  to `T | undefined` rather than the flag.

## Code conventions

- **No parameter properties in constructors** — strip-types does not support them.
  Declare fields explicitly (see `core/errors.ts`).
- `core/` stays language-neutral: no `case '}'`, no indentation rules, no tree-sitter
  import. A change "for C++" or "for Python" belongs in that language's folder under
  `lang/`.
- A new language never means editing `core/`: one folder under `lang/` and two lines in
  the registry `lang/adapter.ts`. The registry is a closed whitelist — a language name
  from a `.hatch` never becomes a dynamic `import()`. The rule of one folder per language
  is in README, "Adding a language".
- Comments explain **why**, not what. A comment that restates the code is noise; one that
  records the failure a line prevents is worth its space.
- An invariant a bug can break should `throw`, not quietly produce `undefined`: a bad
  index silently turning into "the whole file" surfaces three modules away.
- Files are written atomically (`infra/fs.ts`): a temp file, then `rename`. hatch edits
  source files, and a truncated file is a broken build.
- Errors extend `HatchError` and carry an `exitCode`. Messages to the user are in
  English and say what to do next.

Where each directory and file is, and what it holds: README, "Project layout". Which file
owns a given rule: ARCHITECTURE.md, "Where each rule lives".

## Tests

- `test/unit/` — one file per module, plus checks of the rules themselves:
  `versioning.test.ts` (VERSIONING.md), `protocol-types.test.ts` (the wire types against
  the core), `api.test.ts` (the exports against README "API"), `property.test.ts`
  (properties on generated inputs).
- `test/roundtrip/` — `parse(print(ast))` ≡ `ast`.
- `test/golden/<language>/` — hand-written cases, below.

Conventions:

- A test asserts a **behaviour with a reason**, and the reason goes in a comment. When a
  test exists because of a specific bug, say which, so the assertion is not
  "simplified" away later.
- For the pipelines prefer end-to-end assertions: generate hunks, apply them, compare
  with the expected file. That catches interference between hunks, which per-module
  assertions miss.
- A bug fix comes with the smallest input that reproduces it, and the test is run
  against the old code to see it fail.

The invariants in
[ARCHITECTURE.md](./ARCHITECTURE.md#diagnostics-and-invariants-green-on-every-commit)
stay green on every commit.

### Golden cases

`test/golden/<language>/` has two folders, and they check different things:

- **`generate/`** — `test<n>.old.<ext>` and `test<n>.new.<ext>`. Each case is synthesized,
  printed, parsed, applied to the old file and compared with the new one (the result is
  correct), and the printed `.hatch` is compared byte for byte with `test<n>.hatch` (the
  form is the same). The round trip says nothing about form: a hunk that rewrites a whole
  function body reproduces the file as faithfully as a one-line one. A change of form is
  not breaking, but goes into CHANGELOG (VERSIONING.md F1).
- **`apply/`** — `test<n>.hatch` applied to `test<n>.<ext>` must give
  `test<n>.expected.<ext>`. This is how VERSIONING.md F1 is held: a released `.hatch` must
  apply the same in every later release, so a changed expected result is a breaking
  change unless the old one was a bug. The same cases run through every `hatch-apply`
  binary.

When a change is MEANT to alter the expected output, regenerate it and **read the diff**:

```bash
UPDATE_GOLDEN=1 npm test
```

Two markers, on the first line of a case:

- `MUST-REFUSE` — the patch must NOT apply. A silent false match is the worst class of
  bug hatch can have, so it gets a test.
- `KNOWN-GAP` — synthesis cannot do this yet. Once it can, the test fails with "remove
  the marker".

Hatch has also been run against real Chromium files carrying real downstream patches.
That material is third-party code under a third-party licence and is not part of this
repository; `test/golden` is the suite everyone can run.

## Before opening a pull request

1. `npm run check` is green.
2. A fixed bug has a test that **fails without the fix**. A new feature has a golden case
   or a property test: an example pins one input, a golden or a property holds the
   behaviour on inputs nobody wrote.
3. A change of public behaviour is in `README.md` **and** `README.ru.md`, and the
   `--help` text of the CLI says the same as README.
4. A change of a contract — protocol, config schema, `.hatch` format, CLI flags — raises
   its number as VERSIONING.md says and has its line in the "Unreleased" entry of
   `CHANGELOG.md`.
5. The commit message says *why*, not only *what* changed.

## Grammars

Grammars are not in git. `npm run grammars` (`scripts/fetch-grammars.ts`) puts the pinned
ones into `grammars/`, each checked against its sha256 pin; a file already there with the
right bytes is left alone. `npm test` (`pretest`) and `npm pack` (`prepack`) run it, so the
first test run of a fresh clone needs the network (the npm CDNs, jsdelivr then unpkg).
hatch itself never downloads anything.

`HATCH_GRAMMAR_DIR` makes hatch look in another directory first — for work on the core or
a grammar of one's own; the pin is checked all the same.

## Releasing

**[VERSIONING.md](./VERSIONING.md) is binding**: which number moves when, what counts as
breaking, and the release steps (§5). Every release has its [CHANGELOG.md](./CHANGELOG.md)
entry before its tag.

Releases are cut by CI. The last step of §5 pushes the tag:

```bash
git push origin v<version>
```

`.github/workflows/release.yml` then:

1. checks the tag against `version` in `package.json` — a tag on code that still carries
   the previous version is refused;
2. runs typecheck and tests;
3. runs `npm pack` (`prepack` fetches the grammars and builds `dist/`);
4. builds `hatch-apply` for linux-x64, linux-arm64, darwin-arm64 and win-x64 and runs the
   apply goldens and `test/unit/hatch-apply.test.ts` through each binary;
5. writes `SHA256SUMS` and publishes the GitHub Release with the `.tgz`, the binaries and
   the sums. Nothing goes to the npm registry.

Before the tag, run the mutation workflow (or `npm run mutation`). A score below the last
one is a reason to look at what the tests stopped catching, not a blocked release.

To build the archive locally (`npm run check`, then `npm pack`), sending nothing anywhere:

```bash
npm run pack
```

To list its files without creating anything:

```bash
npm pack --dry-run
```

The archive holds `dist/`, `grammars/`, `schemas/`, `hatch.config.schema.json`, both
READMEs, `PROTOCOL.md`, `LICENSE` and `package.json` — the `files` field of `package.json`
decides. Nothing from `src/`, `test/` or `docs/`.

How users install each form of hatch: README, "Install".

## Checks (CI)

`.github/workflows/ci.yml` runs on every push and pull request:

- **matrix** — Linux, macOS and Windows, each on every Node version the project supports
  (the list is in `ci.yml`). `grammars/` is cached between runs, keyed by the pins in
  `src/lang/*/index.ts`;
- **coverage** — the code of the package (`src/`) at ≥ 98 % of lines and ≥ 95 % of
  branches. Not part of `npm run check`: coverage slows the suite every commit waits for.
  Locally:

  ```bash
  node --test --experimental-strip-types --experimental-test-coverage --test-coverage-include='src/**' --test-coverage-lines=98 --test-coverage-branches=95 "test/**/*.test.ts"
  ```

- **package contents** — builds the package, checks that the archive holds the grammars,
  and installs it the way README does (`npm run smoke:install`): the command, the API and
  the service;
- **hatch-apply (linux-x64)** — builds the binary and runs the apply goldens and its tests
  through it, so an import that does not bundle is caught before a release.

`.github/workflows/nightly.yml` runs the property tests every night on a new seed, 25 times
the cases `npm test` draws (also by hand: *Run workflow*, with a seed to repeat one). A
failing case names its seed; the run's summary gives the command that draws the same cases
again:

```bash
HATCH_PROP_SEED=<seed> HATCH_PROP_RUNS=25 node --test --experimental-strip-types test/unit/property.test.ts
```

A failing seed is a bug like any other: fix it and add the case as a test of its own — a
seed is not a test, because the property's generator may change.

`.github/workflows/mutation.yml` runs `npm run mutation` — Stryker (`stryker.config.json`)
over `core/` and synthesis: the share of planted bugs the tests catch — weekly and by hand.
It is incremental: after the first run only mutants whose code or tests changed run again.
That check looks at the mutated code and the tests that cover it, not at the code around
it: after an edit that changes what a mutant means — a guard removed near it, say — a
result is reused that no longer holds. After such an edit run it whole:
`npm run mutation -- --force`.

Two runs compare only if both ran on an idle machine and on the same stand (machine, Node,
`concurrency`, config). Stryker counts a timeout as a caught mutant: load inflates the
score, and even an idle machine moves it by a timeout or two. Never more workers than
cores — `mutation.yml` gives a 4-core runner 4. Scores, stands and durations are kept in
`docs/BACKLOG.md`, section "М".

A mutant that can never change a result is first a reason to simplify the code: a check
that decides nothing goes. Only where that cannot be done is it marked where it stands,
`// Stryker disable next-line <mutator>: <why>` — and only when every mutation of that
kind on the line is equivalent: the mark switches them all off, the caught ones too (an
`<` whose `<=` cannot change anything but whose `>=` is caught is not marked).
