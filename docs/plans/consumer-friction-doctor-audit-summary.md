# `/audit-code` summary — `machine/git-autocrlf` probe (8620cfe8)

**SID** `audit-code-1788374248` · **plan** [consumer-friction-doctor.md](consumer-friction-doctor.md)
· **scope** `diff` vs `0896c845` · **rounds** 2 · **store run** `081547a7`

## Verdict

**Threshold met, NOT certified converged.** R2 reached `H:0 M:2 L:0`
(`H==0 && M<=2 && quickFix==0`), but stability is **1/2** — a second clean
round was not run — and the Gemini gate's `APPROVE` is **unverified with
respect to this change** (see §3). Read this as "the GPT rounds found nothing
outstanding in the new code", not as "two independent reviewers read it and
approved".

## 1. Round 1 — `SIGNIFICANT_ISSUES` (H:1)

**[H1] [Structure] Missing planned file** — *overruled*.
`tests/gate-honesty-ratchet.test.mjs` is genuinely absent (verified on disk and
in `git ls-files`), but the premise is a misread: the plan does not *plan* it.
Line 850 sits in Testing Strategy and names it as a style analogy — "every §2.4
failure mode asserted without a repo, mirroring `X`" — not a deliverable.
Authoring the recommended "canonical ratchet regression suite" would duplicate
`tests/gate-contract-ratchet.test.mjs`.

*Independence*: this commit adds a doctor probe and its tests; nothing in it
imports or derives from the gate-honesty ratchet.

*Real defect, fixed not deferred*: the analogy cited a path that does not exist.
`consumer-friction-doctor.md:850` now cites `tests/gate-contract-ratchet.test.mjs`,
whose layer 1 is "PURE unit tests of `computeRatchetDivergences` … without
touching a repo" — exactly what that sentence describes, and the sibling of
`computeDispositionDivergences` named in the same Tier 1 list.

## 2. Round 2 — `PASS` (H:0 M:2), both deferred as independent debt

Captured to the debt ledger (2 inserted, cloud synced). Full reasoning here
because the ledger's `deferredRationale` is capped at 400 chars
([schemas.mjs:1154 (8620cfe8)](../../scripts/lib/schemas.mjs)).

### [M1] Fail-open diagnostic gate — corrupt `package.json` → `unknown`

`hydration/tooling-absent` returns `status:'unknown'` for a syntactically
invalid `package.json`; `--gate` fails only on a `class:'repo'` `fail`/`error`,
so a structurally broken repo passes the gate.

- **Valid, and not churn.** It does not re-litigate round-5 M12 — that ruling
  moved this branch from silently reporting "no package name" to `unknown`, a
  different axis from `unknown`-vs-`fail`.
- **Precedent already set in this very file's tests**: "a missing manifest must
  FAIL, not read as unknown/n-a — it silently skipped `--gate` before this fix"
  (`tests/doctor-probes.test.mjs`, the `sync/manifest-hydration` case). The same
  fail-open remains open on the hydration side.
- **Root cause**: a definite repository-integrity failure modelled as
  indeterminate.
- **Minimal fix considered and rejected for now**: flip the corrupt-parse branch
  to `status:'fail'` and update its pinned test. Small — but it changes `--gate`
  semantics for *every* consumer, which is a deliberate behaviour change that
  belongs in its own commit with its own review. **Rejected as a scope boundary,
  never for size.**
- **Independence**: `machine/git-autocrlf` reads one git config key and never
  touches `readPackageName` or `package.json`; the hydration probes behave
  identically with or without this commit.
- **Residual risk**: a consumer with an invalid `package.json` gets a passing
  `doctor --gate`, masking a broken tree.

### [M2] Hardcoded package-manager command in `fix` strings

Several `SYNC_ISOLATION_PROBES` / `HYDRATION_PROBES` fix strings embed
`npx github:Lbstrydom/claude-engineering-skills …` literally, against AGENTS.md's
rule that a consumer's package manager is `package-manager.mjs`'s answer, never
a hardcoded `npm`/`npx`.

- **Root cause**: remediation commands are authored per-probe as
  registration-time literals instead of built by one package-manager-aware
  formatter.
- **Minimal fix considered and rejected for now**: route them through
  `detectPackageManager` (already imported here, already used for the Playwright
  hints). Rejected **on scope, not size**: a probe's `fix` is a registration-time
  constant evaluated before `ctx.subjectRoot` exists, so this means moving those
  strings into each `run()` across several probes — a real design change.
- **Independence**: the probe added here is not an instance of the class — its
  fix is `git config --global core.autocrlf input`, a git invocation with no
  package-manager dependency — and it neither builds nor forwards another
  probe's fix string.
- **Residual risk**: a pnpm-only or npx-less consumer gets remediation that does
  not run as printed.

## 3. Gemini gate — `APPROVE`, but it never saw the code

`gemini-pro-latest`, 0 new findings, 0 `wrongly_dismissed`, 0
`over_engineering_flags`, `architectural_coherence: Strong`. **Do not bank
this verdict for this change.** Its own `overall_reasoning` says the target
files "were truncated from the review context, preventing direct code
inspection", while `_envelope.truncated` reported `{}`. The prose was right and
the structured field was wrong:

| Measurement | Value |
|---|---|
| Files nominated in `code_files` | 58 (both changed files included) |
| Their total size on disk | 1,114,879 chars |
| Chars the envelope actually carried | 240,340 (~22%) |
| `full`-path caps ([gemini-review.mjs:1355 (8620cfe8)](../../scripts/gemini-review.mjs)) | `maxPerFile: 8000`, `maxTotal: 100000` |
| `scripts/lib/doctor/probes.mjs` size | 22,162 chars |
| Offset of `AUTOCRLF_PROBE` in that file | 16,170 — past the 8,000 head cut |

Reproduced in isolation: `readFilesAsContext(['scripts/lib/doctor/probes.mjs',
'tests/doctor-probes.test.mjs'], {maxPerFile: 8000, maxTotal: 100000})` renders
16,161 chars containing **none** of `AUTOCRLF_PROBE`,
`readGitConfigWithOrigin`, `machine/git-autocrlf` or `core.autocrlf`. Re-running
the gate cannot fix this — the cap is the blocker, not the nomination.

**Why the telemetry lied**: on the `scope === 'full'` branch
([envelope.mjs:171 (8620cfe8)](../../scripts/lib/final-review/envelope.mjs)) the accounting
is built as `{ budgeted: false, truncated: {} }` — a hardcoded literal, not a
measurement, while `renderCode` truncates underneath it. A field that reads as a
measurement but is a constant is the "hardcoded 0 in telemetry" class.

This is an upstream (this repo) defect affecting every `/audit-code` final gate
here and in every consumer. It was **not** fixed by 8620cfe8, so the honest
reading of the gate verdict **for this change** remains `unverified`, not
`approved` — re-running the gate at 8620cfe8 would reproduce it.

### Closed 2026-09-02 — `fix(final-review): measure what the code render drops`

Fixed upstream in this repo, in three parts, because fixing any one alone leaves
the others:

1. **The telemetry now measures.** `readFilesAsContextDetailed`
   ([audit-scope.mjs](../../scripts/lib/audit-scope.mjs)) returns
   `{context, stats}` — head cuts, budget omissions, unreadable and
   sensitive-excluded paths, chars-on-disk vs chars-rendered — and both envelope
   branches report it instead of `{}`. `readFilesAsContext` is a wrapper over
   the same render, so no existing caller's bytes change. A renderer that
   returns a bare string reports `{code: 'unmeasured'}`: an absent measurement
   must not be representable as a clean one.
2. **The diff is rendered first.**
   [code-render.mjs](../../scripts/lib/final-review/code-render.mjs) renders
   changed files at 40K/file into the budget, then ambient context at the
   historical 8K/file out of what survives. Ordering alone would not have fixed
   the case measured above — the file was *cut*, not dropped — and a larger cap
   alone would still have spent the budget on ambient files first.
3. **A verdict over zero coverage is no longer an approval.**
   [code-coverage.mjs](../../scripts/lib/final-review/code-coverage.mjs) reports
   `full`/`partial`/`none`/`unknown` against the declared diff set and downgrades
   `APPROVE` → `CONCERNS` on `none` only, preserving the model's verdict on
   `_coverageGate.reportedVerdict`. `partial` and `unknown` are reported but
   never gate: a head cut may or may not have held the change, and gating on a
   maybe makes the check cry wolf.

Re-measured on this commit's own file set: the render now carries
`AUTOCRLF_PROBE`, `readGitConfigWithOrigin`, `machine/git-autocrlf` and
`core.autocrlf`; coverage reads `full`; `truncated` reads
`{codeFilesHeadCut: 7, codeFilesBudgetOmitted: 1, codeCharsDropped: 397171}`.

One thing the fix surfaced rather than closed:
`tests/run-final-review-harness.test.mjs` had declared
`changed_files: ['src/a.mjs']`, a path that does not exist — so every run in
that harness had been asserting verdict routing against a review that received
no code at all. Repointed at a real file.

**This does NOT retroactively certify §3.** The gate verdict recorded above was
produced by the old renderer and still saw none of 8620cfe8. What changed is
that the next gate cannot repeat it silently.

## Census

    structure           completed
    wiring              completed
    backend             completed
    frontend            completed
    sustainability      completed
    quickfix (wave)     completed
    duplication (wave)  completed
    adjacency (wave)    completed
    arch-memory         ineligible   (Step 0.5 is --scope=full only)
    detector census     completed    (checked 0 — all findings single-file)
    gemini gate         completed    (verdict APPROVE — unverified for this change, §3)
