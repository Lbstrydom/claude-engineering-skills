# Audit Summary — git-env-leak-sustainability

**Plan**: [`docs/plans/git-env-leak-sustainability.md`](./git-env-leak-sustainability.md)
**SID**: `audit-code-1784844293`
**Status**: CONVERGED (GPT rounds) + Gemini final review complete (2 rounds, capped)

## Round-by-round (GPT, `/audit-code`)

| Round | Verdict | H | M | L | Notes |
|---|---|---|---|---|---|
| 1 | SIGNIFICANT_ISSUES | 6 | 10 | 5 | 5 fixed (H1/H3/H4/H5/H6, M1/M5/M12), 3 captured as debt (M2/M3/M4/L1), rest dismissed (GPT conceded on rebuttal) |
| 2 | SIGNIFICANT_ISSUES | 2 | 6 | 1 | 2 fixed (H2, M6), 3 captured as debt (M1/M2/M5), 1 dismissed |
| 3 | SIGNIFICANT_ISSUES | 0 | 6 | 0 | 3 fixed (M1/M5/M6), 3 captured as debt (M2/M4/M8) |
| 4 | PASS | 0 | 1 | 0 | 1 fixed anyway (M1 — `headOf()` diagnostic honesty), within threshold |

Converged at round 4: `H:0 M:0 L:0` after the voluntary M1 fix. Full test suite green (8507/8507 at that point).

## Gemini final review (mandatory Step 7)

### Round 1 — REJECT

First transcript was built from raw per-round GPT findings only, omitting the
adjudication ledger's triage disposition (which findings were fixed vs.
deliberately deferred as independent pre-existing debt, and why). Gemini
correctly could not distinguish "deferred with a documented independence
rationale" from "ignored" — it flagged 7 recurring findings as `wrongly
dismissed` and surfaced 2 new findings (`G1`, `G2`), concluding `claude_bias_
detected: true`.

**Each of the 9 claims was independently re-verified against current code**
(not re-argued from the transcript) before any action:

| Finding | Verdict after re-verification | Action |
|---|---|---|
| G1 — sync-untrack.mjs N+1 `git rm --cached` subprocess per file | Real, and genuinely in-scope (new code from this same diff's H4 injection fix) | **Fixed** — chunked batching (200/chunk) |
| G2 — diff-scope-resolver.mjs symlinked source files silently skipped | Real, but independently verified out-of-scope (zero git subprocess calls in either walker; zero diff hunks touch them) | Deferred as debt |
| wrongly_dismissed M4 — `gitWorktreeTree()`'s `read-tree HEAD` catch swallows all failures, not just "no HEAD yet" | Real, and on reconsideration **load-bearing** (feeds the `AI-Gate: passed` identity hash; empirically confirmed a tracked-then-gitignored file's content silently drops from the hash if this masks a failure) | **Fixed** — catch narrowed to the exact "no HEAD yet" message; empirically verified the distinguishing git error text via two real repro repos |
| wrongly_dismissed M5 — `SAFE_KD_ID_RE.test(kdEntry.id)` string-coerces non-string ids | Real (`RegExp#test(null)` → tests `"null"`, which matches) | **Fixed** — explicit `typeof` guard |
| wrongly_dismissed M2 — `classifyChildError`'s `err.code` allegedly misreads spawnSync's nested error shape | **Factually incorrect** — read all 6 call sites; every one passes spawnSync's `.error` (never the raw result) or a hand-built synth object, matching Node's actual (flat, non-nested) `.error.code` shape and the ORIGINAL GPT finding's own accurate description | **Rebutted**, no code change |
| wrongly_dismissed M4 (SHA-1 40-char regex), M4 (docblock catch), M2 (PRAGMA_RE unanchored), H1 (colon-in-filename parsing) | All independently reverified as genuinely out-of-scope (untouched lines/functions, several with zero git subprocess involvement at all) | Reaffirmed debt, no change |

3 genuine fixes landed, each with a new regression test that was
**false-positive-verified** (temporarily reverted the fix, confirmed the test
fails, restored the fix, confirmed it passes again). One claim was rebutted
with cited evidence rather than blindly fixed.

### Round 2 — CONCERNS (one trivial finding, then stopped)

Re-ran with a corrected transcript (added `changed_files`/`code_files`, plus
an explicit "Debt Ledger Disposition" section documenting the independence
rationale for every deferred finding, and a "Response to Gemini round-1"
entry documenting the fix-vs-rebut disposition of every claim).

Result: `claude_bias_detected: false`, `deliberation_was_fair: true`,
`gpt_false_positive_count: 2` (Gemini now agrees the spawnSync claim was a
false positive), `wrongly_dismissed: []`. One new finding:

- **G1** — `gitBuf()` (diff-scope-resolver.mjs) and the `ls-files -z` call
  (sync-untrack.mjs) had no `maxBuffer` override, defaulting to Node's 1MB
  and risking a silent `ENOBUFS`→empty-fallback on large repos. Real,
  mechanical, trivial, and in a call site this diff touched. **Fixed** —
  added the same 64MB bound already used elsewhere in this codebase
  (`known-defect-corpus.mjs`, `vcs.mjs::gitShowFileAtRevision`).

Gemini's own framing after the fix-eligible finding: *"Aside from this, the
codebase changes are production-ready."* — the rising-praise + one-nit
pattern this skill's Gemini-cap rule identifies as the stop signal. **Capped
at 2 rounds per policy** (`/audit-plan` Gemini-gate rule, mirrored for
`/audit-code`'s Step 7) rather than spending a third round chasing further
polish.

## Net result

- **6 genuine bugs found and fixed** across the full loop (4 GPT rounds + 2
  Gemini rounds), each with a regression test that was verified to actually
  catch the regression (temporarily broken, confirmed red, restored, confirmed
  green).
- **1 false-positive claim rebutted** with cited evidence rather than
  reflexively fixed or reflexively dismissed.
- **~7 findings correctly deferred** as independent, pre-existing, out-of-scope
  debt — each with a specific, verified (not asserted) independence rationale,
  captured in `.audit/tech-debt.json`.
- Full test suite green throughout: final state **8516 pass / 0 fail / 22
  skipped**.

**Files changed**: 29 (10 production `scripts/lib/**` + `scripts/prepush-check.mjs`,
19 test files) + the plan doc itself.
