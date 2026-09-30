# File coverage — what the audit did and did not examine

Every changed file ends an audit with **exactly one recorded outcome**, and an outcome that means
"not examined" is never printed as "examined and clean". Design + audit trail:
[`docs/plans/file-coverage-contract-and-csharp.md`](../plans/file-coverage-contract-and-csharp.md).

**Why it exists.** A consumer's 68-file diff held 12 `.cs` files. Two audit rounds and the final review returned
`APPROVE`; no C# file had been read and nothing said so. Each stage decided silently whether to look at a file, from its own
hand-kept extension list, and "did not look" printed exactly like "looked, found nothing".

## The taxonomy — one registry

[`scripts/lib/file-taxonomy.mjs`](../../scripts/lib/file-taxonomy.mjs) answers "what kind of file is this path?" — a pure
function of the **path only**, ordered precedence (exact filename → generated/compound suffix → last extension → `uncovered`):

| Class | Meaning | Reaches the model? |
|---|---|---|
| `profiled` | a known language **with** a profile (boundaries, imports, tools): js, ts, py, **cs** | yes |
| `model-only` | a known source language with no profile (go, rs, java, kt, rb, php, sh, …) | yes |
| `declarative` | reviewable config / markup / build definition (json, yml, sql, md, `.csproj`, `Dockerfile`, …) | yes |
| `non-code` | an **expected** exclusion: binary, asset, lockfile, generated (`.g.cs`, `*.min.js`) | no (expected) |
| `uncovered` | **unrecognised** — never silently dropped, always reported | no, **reported** |

**Adding a language is one edit**: a language entry in the taxonomy gives admission, repo profiling, fence language,
file-reference extraction and the sensitive-path code carve-out. A profile in `language-profiles.mjs` upgrades it from
`model-only` to `profiled`. **Never hand-keep an extension list** — `tests/extension-list-drift.test.mjs` runs the whole
taxonomy through every generic decision point and scans `scripts/` for new lists; a list that must stay narrower (a
parser-bound one) is registered there with its reason.

## `_coverage` — on every round's result JSON

Strict, versioned (`schemaVersion: 1`), built by `buildCoverageReport` (`scripts/lib/audit/file-coverage.mjs`). One record
per changed path: `class`, terminal `outcome` (`audited` · `not-admitted` · `excluded-infra` · `excluded-user` · `sensitive` ·
`deleted` · `unreadable` · `budget-omitted`), `changeKind` from `git diff --name-status -z` (never inferred from the
filesystem), render evidence `read` (per pass; **only completed passes count**), `changedLinesUnread` (`null` = not measured),
and the tool/wave states. Counts are **recomputed from `files[]`**; a violated invariant makes `status: 'incomplete'`.

| `status` | Meaning | `gate` |
|---|---|---|
| `complete` | every changed source/declarative file was audited in full | `pass` (`warn` if a source file was excluded by policy) |
| `partial` | some were not fully audited (head-cut read, unread, deleted, unrecognised type) | `warn` |
| `none` | changed source existed and **nothing** was audited | `fail` → the round is `INCOMPLETE` (exit 3), never converged |
| `incomplete` | the ledger contradicts itself | `fail` |

A `warn` never blocks convergence — it changes the **wording**: the summary line and the `CONVERGED` banner carry a suffix
naming the files ("`coverage: PARTIAL — 3 of 12 changed source file(s) not fully audited; 2 unrecognised file type(s): xyz ×2`").
The suffix is copied, not paraphrased. The final reviewer receives an **Audit Coverage** note (a projection of the ledger,
with a digest of the full one) and is told to treat every listed file as unreviewed.

## The mechanical waves and the tool pre-pass are honest too

- The four JS/TS-only waves (orphan-introduced, event-wiring-symmetry, duplication, adjacency) report
  `INELIGIBLE — 0 of N changed file(s) are js/ts; nothing was examined` over a change they could not read — never
  `ANALYZED_CLEAN`, `clean` or `not-triggered`. A partial one adds `examined k of n`.
- A tool that ran and produced nothing it could locate is **`failed`**, never `ok` with zero findings (a non-zero exit with no
  parseable finding, or any diagnostic flagged `toolFault`). States: `ok` · `no_tool` · `spawn_error` · `failed` · `timeout` ·
  `deadline_exceeded` · `ambiguous_project` · `no_project` · `skipped_budget` · `not_applicable`.

## C#

`.cs` is a `profiled` language: a real lexer + scope-stack boundary scanner (`scripts/lib/csharp-scanner.mjs`; raw,
interpolated and verbatim strings, comments, directives; unbalanced input degrades to whole-file chunking, never a guessed
split) and a compiler pre-pass. **Project-scoped**: each changed file resolves to its nearest project (`.csproj`, then `.sln`;
two in one directory is `ambiguous_project`) and each project is built once, serially, under a project cap and one monotonic
deadline, killed as a **process tree** on timeout.

- `dotnet build --no-incremental --no-restore …` — `--no-incremental` is load-bearing: an incremental build re-emits **no**
  warnings for an up-to-date project (measured: 0 vs 1 on a real project), so a plain build reads clean over code it never
  re-analysed. Parsed from MSBuild's `File.cs(line,col): warning CS…: message [proj]`, de-duplicated, repo-relative. A compiler
  **error** is a `HIGH` finding.
- `dotnet format --verify-no-changes` — diagnostics arrive on **stderr**; every one is a `LOW` style note.
- **Restore is off** (`--no-restore`): the audit never touches NuGet on its own. An unrestored project fails with `NETSDK1004`
  and is reported `failed` with a `dotnet restore` hint. `AUDIT_DOTNET_RESTORE=1` opts in; `AUDIT_TOOLS_DEADLINE_MS` bounds the
  pre-pass ([variables](environment-variables.md)).
- MSBuild evaluates repository- and package-controlled `.targets` during a build — the same trust class as an ESLint config or
  `npx` resolution; `--no-tools` turns all of it off.
- Not built: a namespace-to-file import graph (C# resolves by namespace, not path; `buildDependencyGraph` has no production
  caller), Roslyn analysis, C# ports of the four JS-only waves.

## Reading a result

```bash
node -p "const c=require('./.audit/<sid>-r1-result.json')._coverage; JSON.stringify({status:c.status,gate:c.gate,counts:c.counts,uncovered:c.uncoveredByExtension})"
```
