# Plan: The audit admits extensionless git hook scripts

- **Date**: 2026-11-24
- **Status**: Approved
- **Author**: Claude + Louis
- **Scope**: backend (`shared-lib` taxonomy + its reference extractors; no UI)
- **Target domain(s)**: `shared-lib`, `tests`
- **Source**: wine-cellar-app PR #1431 — it changed only `.githooks/pre-push.local`; both GPT rounds and the final gate
  "passed", and the gate rated code coverage PARTIAL because neither reviewer was ever handed the file.

Neighbourhood considered (arch memory, 2026-11-24): `extractPlanPaths` banded `precedent` (opened: it is the plan-path
extractor this plan extends, not a duplicate); `matchFileKind`, `buildFileReferenceRegex`, `classifyFileCoverage`,
`resolveReferenceExtension`, `mergeScopeFiles` banded `review`. No new classifier: the fix extends the existing one.

## 1. Defect

`scripts/lib/file-taxonomy.mjs` `matchFileKind` admits a path by its last extension or by an exact name in
`EXACT_NAME_DEFS`. A git hook is named for its event (`pre-push`, `post-merge`) and carries no extension, or one no table
knows (`pre-push.local`), so it classified `uncovered`: `resolveReferenceExtension` returned null, `partitionDiffScope`
reported it as an unrecognised type, and it never entered `code_files`, which is also the final gate's subject list
(`selectBaseCodePaths` in `scripts/lib/final-review/scope.mjs`). CES's own `.githooks/pre-push` (the
`fail-closed-on-signal` trap block) was equally invisible to every CES audit.

## 2. Design

One rule in the ONE classifier, no second list:

- `HOOK_SCRIPT_DIRS = ['.githooks', '.husky']` (exported). A file whose directory segments include one of them, and
  which no earlier step classified, is `source` / language `sh` / extension `sh`, rule `hook-dir:<dir>` (new step 3b,
  AFTER the last-extension step, so `.githooks/lib/check.mjs` stays `js` and `.githooks/README.md` stays markdown).
  Matched as ANY segment, so a monorepo's `frontend/.husky/pre-commit` counts. A FILE named `.githooks` is not a hook.
  `sh` because git executes hooks through a shell and husky's are always shell; `sh` has no deterministic profile, so
  the class is `model-only` — the model reads it, no tool pre-pass claims to have.
- **`.husky/_/` is excluded** as `non-code` (new step 0b, before exact names): husky writes that directory itself
  (`husky install` / `husky`) and gitignores it with a `.gitignore` it writes there, so it is generated, like a lockfile.
  Before exact names so that generated `.gitignore` is not classed as reviewable policy.
- `fenceLanguageFor` / `commentPrefixFor` fall back to the hook language only when `matchFileKind` itself returned a
  `hook-dir:` rule — asked of the classifier, never re-derived — so a hook gets the `bash` fence and `#` markers and the
  fence can never disagree with admission.
- **Reference extraction**: `HOOK_SCRIPT_PATH_PATTERN` (exported, capture-free) is spliced FIRST into
  `buildFileReferenceRegex` (`language-profiles.mjs`) and into `extractPlanPaths`'s generic and backtick regexes
  (`plan-paths.mjs`) — first because alternation is first-match-wins and `.githooks/check.sh.local` must be captured
  whole. It ends on `[\w-]`, so prose punctuation (`pre-push.`) is not swallowed, and a trailing boundary lookahead
  means a name the fragment cannot spell (`.githooks/pre+push`) is skipped rather than truncated to a different real
  path. Extracted hook paths then pass the same `resolveReferenceExtension` admission as any other file.
- `.husky/_/` wins wherever it sits in the path (`.githooks/vendor/.husky/_/x` is generated), never decided by which
  hook segment comes first.
- `extractPlanPaths`'s `node_modules` exclusion becomes segment-aware (any depth, not only the root) for its Phase-1
  regexes, since the hook fragment accepts leading directories (audit R1). `KNOWN_EXTENSIONLESS_FILENAMES` is unchanged: it is a
  NAME list, and a hook is identified by its directory, not its name.

Consumers checked and needing no change, because they read `matchFileKind` / `resolveReferenceExtension` /
`classifyFileCoverage`: `diff-scope-admission.mjs` (audit file selection), `final-review/code-coverage.mjs` (the
coverage verdict's NONE/UNMEASURED lists, keyed on `kind !== 'non-code'`), `audit/file-coverage.mjs`,
`cycle-cluster-scope.mjs`, `ship-train/impact.mjs`, `prepush-step.mjs`. `AUDITABLE_EXTENSIONS` (an extension list) does
not and should not grow: a hook has no extension to add. `getProfileForFile` (extname-keyed) returns the unknown
profile for a hook, which is correct — `sh` has no profile.

## 3. Files

- `scripts/lib/file-taxonomy.mjs` — `HOOK_SCRIPT_DIRS`, `HOOK_SCRIPT_PATH_PATTERN`, steps 0b and 3b, fence/comment fallback.
- `scripts/lib/language-profiles.mjs` — hook alternative in `buildFileReferenceRegex`.
- `scripts/lib/plan-paths.mjs` — hook alternative in `extractPlanPaths`'s Phase-1 regexes.
- `tests/file-taxonomy-hook-scripts.test.mjs` — new.
- `docs/reference/file-coverage.md` — the class table names hooks and `.husky/_/`.

## 4. Tests (negative control)

`tests/file-taxonomy-hook-scripts.test.mjs`: hooks classify `source`/`sh`, pass `resolveReferenceExtension`, are
`model-only`, get the `bash` fence and `#` prefix, and `partitionDiffScope` audits them (not `uncovered`); every
`HOOK_SCRIPT_DIRS` entry is honoured; `.husky/_/*` is `non-code`; controls — an extensionless file outside a hook dir
stays `uncovered`, a file named `.githooks` is not a hook, a real extension inside a hook dir keeps its own class; the
reference regex captures hook paths whole and still ignores `scripts/pre-push`; `extractPlanPaths` finds this repo's
real `.githooks/pre-push`. Run against `origin/main`'s three library files: 14 of 19 fail (the controls pass on both).

## 5. Acceptance

- A diff touching only `.githooks/pre-push.local` audits that file and the final gate receives it (coverage FULL).
- No change in classification for any path outside `.githooks/` / `.husky/`.
