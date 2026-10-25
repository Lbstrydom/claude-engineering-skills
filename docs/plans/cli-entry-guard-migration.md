# Plan: migrate every CLI entry guard to `isInvokedAsScript`
- **Date**: 2026-10-13
- **Status**: Complete — shipped in #236 (status reconciled against merged PRs 2026-10-25)
- **Author**: Claude + Louis
- **Scope**: backend (stack `js-ts`)
- **Target domain(s)**: `shared-lib` (the helper), every domain that owns a CLI (mechanical one-line change per file)
- **Depends on**: `claude/loving-mcclintock-d57154` ([sync-to-repos-failure-honesty.md](sync-to-repos-failure-honesty.md) H8), which adds `scripts/lib/cli-entry.mjs` and migrates `sync-to-repos.mjs`. That plan's §8 names this migration as follow-up work.

## 1. Context Summary

Node realpaths the main module before building `import.meta.url`, but leaves `process.argv[1]` as typed (resolved, not realpath'd). Any guard that compares the two lexically is false when the script is reached through a symlink or a Windows junction, so `main()` is skipped and the process exits 0 having done nothing.

**Census (measured, be057735).** 129 guards across `scripts/**/*.mjs`, `install.mjs` and `setup.mjs`, in eight shapes:

| Shape | Through a link | Other defect |
|---|---|---|
| `import.meta.url === pathToFileURL(argv[1]).href` | false | — |
| `` import.meta.url === `file://${argv[1]}` `` (± a `file:///` + backslash-replace variant) | false | the first arm is false on every Windows path |
| `path.resolve(argv[1]) === fileURLToPath(import.meta.url)` / `__filename` | false | — |
| `new URL(`file://${argv1}`).pathname` basename compare (IIFE) | true | true for any file with that basename |
| `argv[1]?.endsWith('x.mjs')` | true | true for any file with that basename; `endsWith('debt-review')` also matches a different suffix |
| `import.meta.url.endsWith(basename(argv[1]))` | true | same |
| realpath `canon()` on both sides (fleet, ship-train, gh-batch) | true | case-sensitive on win32 |
| two-statement `invoked = resolve(argv[1])` then compare (azure-doctor, refresh) | false | — |

`install.mjs` is the `npx github:…` bin. On POSIX that bin is a symlink in `node_modules/.bin`, so its lexical guard falls into the first row (derived, not measured here; Windows uses a `.cmd` shim that names the real path).

**Measured on the pre-migration tree** (`git archive be057735`): of the 26 CLIs whose `--selfcheck-relocation` handler is the first statement of `main()` or sits inside the guard block, run through a junction, **16 exited 0 with no output**.

## 2. Proposed Architecture

One oracle: `isInvokedAsScript(import.meta.url)` from `scripts/lib/cli-entry.mjs` (realpath on both sides, case-insensitive on win32, lexical fallback when canonicalisation fails). Each guard keeps its variable name (`isMain`, `invokedDirectly`, …) so surrounding code and existing tests that match `const isMain =` are untouched. Only the right-hand side or the `if` condition changes.

The census is a test, not a gate: `tests/cli-entry-guards.test.mjs` walks the filesystem (`scripts/**`, root `*.mjs`) and fails on any ad-hoc shape. Its predicate is fixture-tested both ways, catching each of the eight shapes and ignoring the legitimate `process.argv[1]` uses (`JSON.parse(process.argv[1])` in `node -e` children, printing the invoked path). A non-vacuity assertion requires the migrated population to be seen.

**Rejected:** a ratchet/baseline gate (there is no residual population to baseline, since everything migrates in one change). Also rejected: keeping per-file guards and adding junction tests per CLI (129 spawns for a property one helper owns).

## 3. Sustainability Notes

- Synced CLIs import `./lib/cli-entry.mjs`, so the consumer bundle closure picks the helper up from the import graph. No sync list is edited.
- Tests that hand-copy a CLI's lib closure into a fake consumer layout must add `cli-entry.mjs` (one such test: `workflow-cadence-doctor.test.mjs`).
- `.requirements/ledger.json` anchors quoting the old guard text are updated in place.

## 4. File-Level Plan

- 129 guard sites in `scripts/**`, `install.mjs` and `setup.mjs`: replace the guard expression with `isInvokedAsScript(import.meta.url)`, add the import, and drop `node:url`/`fs`/`path` imports that become unused (AST-checked against HEAD, so no import still in use is dropped).
- Comments that described the replaced mechanism ("Windows-safe — match by basename", "pathToFileURL for drive-letter robustness") are rewritten. Incident history in those comments is kept.
- `tests/cli-entry-guards.test.mjs` (new), plus one line in `tests/workflow-cadence-doctor.test.mjs`.
- `AGENTS.md`: one invariant paragraph under the CLI smoke contract.

## 5. Risk & Trade-off Register

- **Behaviour change for basename guards.** These used to fire for any script with the same file name. Now they fire only for this file. That is stricter and correct. No shim without an extension exists (`git ls-files` has no `debt-review` or `meta-assess` without `.mjs`).
- **Mechanical migration can break imports.** Mitigated by the AST import check, `node --check` on every file, and the per-file probe below, which imports each module.

## 6. Testing Strategy

1. **Guard probe (all 129).** A `--import` loader hook swaps `cli-entry.mjs` for a wrapper that exits 99 with a marker the moment a guard answers true. `main()` never runs. Each file is run directly, through a junction, and through a lower-cased path, where the guard must answer TRUE for this file's URL. It is also imported by a driver script, where the guard must answer FALSE and the import must complete. Negative controls (a guard asking about the wrong URL, a module with no guard, a guard that is true on import) each fail the expected leg.
2. **Real `main()` red→green (26 CLIs).** `--selfcheck-relocation` directly and through a junction. Pre-migration: 26/26 direct, 10/26 junction. Migrated: 26/26 and 26/26.
3. **Permanent:** `tests/cli-entry-guards.test.mjs`, the census and predicate fixtures plus one real junction run. It is red on the pre-migration tree, listing every guard site, and green after.

## 7. Acceptance Criteria

- [ ] No ad-hoc entry guard remains in `scripts/**` or root `*.mjs` (census test green).
- [ ] Every migrated CLI reaches its guard as TRUE directly, through a junction and via a case variant, and FALSE when imported.
- [ ] `npm test` green; `bundle:deps:check`, `size:ratchet:gate`, `knip:gate` and `cli:flags` gating are clean.
