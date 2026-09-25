# Audit convergence summary — runs-findings write-boundary hardening

**Plan**: [`docs/plans/runs-findings-write-boundary-hardening.md`](runs-findings-write-boundary-hardening.md)
**SID**: `audit-code-1790332605`
**Scope**: R2+ diff-scoped, `--changed`/`--files` = the 9 files touched across
rounds 2-6 (`scripts/lib/store/runs-findings.mjs`, `scripts/lib/store/finding-write.mjs`,
`scripts/lib/final-review/shadow.mjs`, plus 6 test files). Round 1 (Phases 1-10 +
its own 27 findings) was already committed as `060ade2d` before this audit-code
session began; rounds 2-6 below audit the round-1-and-later fixes on top of that.

## Verdict: Round 6 (cap) reached without full GPT-side stability; Gemini final gate (Step 7) → **APPROVE**

Per the skill's own table (`Round 6, not stable → Present to user, then REQUIRED
Step 7`), rounds are reported honestly below rather than forced to a clean
convergence. Step 7 (mandatory regardless of round-6 outcome) ran twice:

- **First pass: `CONCERNS`** — one new, genuine finding (Gemini G1, MEDIUM,
  mechanical): `runShadowAndPersist` appended `model_eval_shadow_observations`
  rows referencing findings even when the write those refs point at never
  landed (`persistResult.findingsRecorded === false`, or
  `persistResult.shadowWriteFailed === true` — both signals this very audit
  added in rounds 3-5). Fixed: the append is now skipped entirely when
  nothing was recorded, and shadow-specific refs are dropped (while primary
  refs are kept) when only the shadow's own transaction rolled back.
- **Second pass, after the fix: `APPROVE`.** `new_findings: 0`,
  `wrongly_dismissed: 0`, `architectural_coherence: Strong`,
  `claude_bias_detected: false`, `deliberation_was_fair: true`,
  `gpt_false_positive_count: 6` (Gemini independently confirmed all 6 of this
  session's GPT-finding dismissals were correct).

| Round | H | M | L | Verdict | Fixed | Dismissed (GPT-ruled) | Deferred (debt) |
|---|---|---|---|---|---|---|---|
| 2 | 5 | 1 | 0 | SIGNIFICANT_ISSUES | H4, H5, M1 | — | — |
| 3 | 4 | 3 | 0 | SIGNIFICANT_ISSUES | H1, H4, M1 | H3 (overrule), M5 (n/a) | M2 |
| 4 | 2 | 4 | 0 | SIGNIFICANT_ISSUES | H1, M1, M4 | M2, M3 (overrule) | H2 |
| 5 | 1 | 5 | 0 | SIGNIFICANT_ISSUES | H1, M1 | M2, M4, M5 (overrule) | M3 |
| 6 | 3 | 3 | 0 | SIGNIFICANT_ISSUES | H1, H3 | M1 (overrule) | H2, M3, M4 |

**All HIGH-severity findings across all 5 rounds were either fixed or
dismissed via GPT deliberation** (never silently accepted-and-ignored). The
findings still open at round 6 are exactly the deferred set below — every one
independent of this plan's own changes, each with a specific independence
argument, several cross-round-confirmed by GPT deliberation.

## What changed (cumulative diff, rounds 2-6)

9 files, +990/-261 lines. Highlights:

- **H4 (r2)**: fixed a real self-inflicted bug — this plan's own Phase 3 fix
  (preserving same-fingerprint-different-bucket findings) broke the embedding
  persistence id-lookup, which was still keyed by fingerprint alone.
- **H1 (r3)**: bucket now gets severity's drop-not-coerce treatment — an
  out-of-domain bucket value was silently colliding with the genuine
  null-bucket identity slot.
- **H2 (r3, GPT compromise)**: `probeColumnExistence` distinguishes
  confirmed-absent from exhausted-transient at the ONE write site where the
  distinction matters (verdict persistence), without widening the ~25 other
  `columnExists` boolean call sites GPT explicitly rejected touching.
- **H2/H3 (r2), H2/H3 (r3 dismissed)**: repo ownership + fingerprint identity
  folded into write predicates (closing TOCTOU windows), with GPT-confirmed
  unreachability for the theoretical `applyFindingWrite` over-match case.
- **M1 (r5), H1/H3 (r6)**: `persistKeptEmbeddings`' `isCallerTx:true` path
  now isolates a failed (or malformed) embedding write via `withTx`'s
  re-entrant SAVEPOINT nesting, using the client `withTx` itself hands back —
  an optional, best-effort index write can no longer poison the transaction
  holding the primary findings that matter.
- **H1 (r5)**: `shadowWriteFailed` disambiguates a lost shadow observation
  from a clean, empty one.

Full per-finding rationale for all 34 round 2-6 findings (fixed, dismissed,
and deferred) is in the ledger: `.audit/audit-code-1790332605-ledger.json`
(58 entries total, including round 1's 27).

## Deferred (captured as debt, `npm run debt:review` to see them)

- `resolveShadow`'s Azure-Claude-unreachable branch (round-1 H6/H15 → r4 H2 →
  r5 M3 → r6 H2) — pre-existing, confirmed independent 4 times.
- `buildShadowClient` provider-routing duplication (r6 M4) — related to the
  above, also pre-existing.
- `reconcileRemediationProjection`'s `ok` semantics (round-1 H19 → r4 M2 →
  r5 M2) — GPT-adjudicated as intentional design, re-raised 3 times as
  false positives by the same class of static reasoning.
- `getRunFindings`'s transient-probe test (r6 M3) — pre-existing, untouched.
- `normaliseBucket`'s enum-domain coercion for non-identity fields — round-1
  H13, pre-existing.
- Two `resolveFindingBucket`/replay edge cases from round 1 (H4, H20) —
  documented, accepted v1 limits.

## Test evidence

- **609→610 tests** across the 30 directly-and-transitively-affected test
  files, run against a real local Postgres container (`npm run db:local`
  topology, `AUDIT_DB_SSL_MODE=disable`), **0 failures** at every checkpoint.
- Every fix landed with a red-then-green regression test in the SAME round,
  including two pre-existing tests corrected where they pinned since-fixed
  bugs (`final-review-persistence-isolation.test.mjs`'s stale severity-regex
  assertion from round 1's H18; `final-review-replay-db.test.mjs`'s primary-pass
  prune-coverage gap from round 2's M1).
- `npm run db:enrolment:gate` and the DB-suite two-edits rule were not
  re-checked this session (no new DB-gated suite files were added, only
  existing ones extended).

## Next step

Gemini's final gate is APPROVE. `/cycle --autonomous`'s own Step 7 (ship) can
never be invoked autonomously — this run ends in a blocked handoff naming
`/ship docs/plans/runs-findings-write-boundary-hardening.md` for the human to
run. All changes (rounds 2-6 of this audit-code session, plus the Gemini G1
fix) remain uncommitted, ready for `/ship` to create the properly-trailered
commit.
