# Final-review shadow A/B — adjudication briefing

**Status**: collection CLOSED 2026-07-28 · verdict PENDING your adjudication
**Experiment**: [`docs/plans/final-review-shadow-reviewer.md`](../plans/final-review-shadow-reviewer.md)
**Pair under test**: primary `gemini-pro-latest` × shadow `claude-opus-5`

---

## 1. What you need to decide

The shadow reviewer has been **turned off** — the pre-registered collection
window is met and further runs cost money without changing the decision. What
remains is a judgement only you can make:

> **Does a second, independent final-review gate earn its keep as a permanent
> part of the audit loop?**

Two things block that call. Both are below: **(a)** 63 shadow-only findings
were never adjudicated, and the rule scores on *human* acceptance; **(b)** the
two halves of the pre-registered rule currently point in **opposite
directions**, which is a genuine ambiguity in the rule as written and is
yours to resolve, not mine.

---

## 2. What the experiment cost

| | claude-engineering-skills | wine-cellar-app | Total |
|---|---|---|---|
| Runs with shadow executed | 26 | 9 | **35** |
| Shadow input tokens | 1,760,228 | 915,241 | 2,675,469 |
| Shadow output tokens | 95,204 | 48,308 | 143,512 |
| **API cost** @ Opus $15/$75 per M | $33.54 | $17.35 | **$50.90** |
| Added gate latency | 23.0 min | 11.7 min | **34.7 min** (59.5 s/run) |

`ai-organiser` contributed **zero** runs — it never triggered a final review
in the window, so it is absent from the evidence entirely.

This $50.90 is the answer to "why are we still making many Anthropic calls."
Note the shadow deliberately pinned `backend: 'sdk'`
([gemini-review.mjs:1199](../../scripts/gemini-review.mjs)) rather than drawing
Max-20x Agent SDK credit — under the `cli` backend it returned conversational
markdown instead of JSON and silently recorded nothing. The comment there
accepts the cost on the basis that the window was ~20 runs. We are at 35, which
is why it is now off.

---

## 3. The pre-registered rule, and where we stand

From `final-review-shadow-reviewer.md` §"Pre-registered stopping rule", decided
**before** data collection:

- **N** = runs where the shadow actually ran, for a *fixed* (primary, shadow) pair.
- **Collect until N ≥ 20.**
- **KEEP** iff human-`accepted` shadow-only findings of severity **HIGH or
  MEDIUM** occur at **≥ 1 per 5 runs**, *and* cost per accepted-unique finding
  is within operator tolerance.
- **DROP** iff shadow-only findings are **predominantly dismissed** OR
  **predominantly LOW/polish**.

### Current standing

| Criterion | Threshold | Actual | Reads |
|---|---|---|---|
| Window size | N ≥ 20 | **35** | met |
| Accepted HIGH/MED (ces) | ≥ 6 | **7** | met |
| Accepted HIGH/MED (wine) | ≥ 2 | **3** | met |
| Accepted HIGH/MED (pooled) | ≥ 7 | **10** | met |
| Cost per accepted HIGH/MED | operator tolerance | **$5.09** + ~60 s/run | **your call** |
| Predominantly dismissed? | — | 8 dismissed / 25 labelled | not yet |
| Predominantly LOW? | — | 34 LOW / 88 (39%) | no |

### The part that actually matters

**The acceptance criterion is already met and cannot be un-met.** It is a floor
on a *count* (10 accepted vs. a threshold of 7), and adjudicating the remaining
63 can only add accepts, never remove them. So no amount of further
adjudication can flip that half of the rule to DROP.

**But the DROP criterion is still live.** It triggers on shadow-only findings
being *predominantly dismissed*. Today 8 of 25 labelled are dismissed (32%). If
a large share of the outstanding 63 are dismissed, the dismissal rate rises
toward the 70–80% range and the DROP condition fires **while the KEEP condition
also holds**.

That is a real contradiction in the rule as written — it pins a *floor on
absolute accepts* against a *ratio of dismissals*, and at high finding volume
both can be true at once. Resolving it means deciding what you actually care
about:

- **"Does it find things nothing else finds?"** → the accept floor is the right
  test, and the answer is already **yes**.
- **"Is the signal-to-noise good enough to sit in the loop permanently?"** →
  the dismissal ratio is the right test, and it is unresolved.

I have deliberately **not** picked one for you. Rewriting or reinterpreting a
pre-registered rule after seeing the data is the failure the pre-registration
exists to prevent; per the plan's own instruction, any amendment must be dated
in the final write-up so a reader can see the rule changed after data was in
hand.

### Already-disclosed blind spot (do not re-litigate)

The rule counts HIGH/MEDIUM only. `d99f9e30` was **LOW** and cosmetic — and
tracing it is what uncovered that wine-cellar-app's wine-detail "Link" row had
been dead code for ~4 months. Arguably the highest-value thing this experiment
produced, and it scores **zero**. This was documented and dated 2026-07-27,
*before* the verdict, and deliberately left unamended. It is context for your
judgement, not a licence to retune the threshold.

---

## 4. The GPT cross-check — how much to trust it

You asked for a second LLM opinion alongside the human column. The plan
anticipated exactly this: **"GPT rebuttal" is named in §8 as the deferred
automation escalation**, with the human explicitly retained as *"the arbiter,
not Claude"* (self-evaluation bias — Claude Opus is the shadow under test, so
Claude cannot grade its own output here).

**Method**: every one of the 88 shadow-only findings was sent to
`gpt-5.6-terra` — independent of both the primary (Gemini) and the shadow
(Opus) — together with the **current source of the cited file**, and asked to
judge whether the claim describes a real defect *today*. The 25 findings you
had already labelled were included **blind**, as a calibration set.

### Calibration result — the GPT column is NOT a substitute for you

| | GPT: real defect | GPT: not real / unclear |
|---|---|---|
| **You accepted** | 5 | **12** |
| **You dismissed** | **0** | 8 |

- **Agreement: 52%.** Barely better than a coin flip on this set.
- **Recall on your accepts: 29%.** GPT would have missed 12 of the 17 findings
  you accepted.
- **False-positive rate: 0%.** It never called a finding real that you dismissed.

So GPT is strongly **conservative** here. Decomposing the 12 misses:

- **~8** were `unclear` because the source was truncated past the relevant
  region (24K-char cap) — a tooling limit, not a judgement.
- **~2** were `contradicted_by_code` on files that had since moved.
- **~2** were genuine disagreement: GPT confirmed the described code exists and
  still judged it not a defect.

**How to use the column, given that:**

- ✅ **`REAL` is high-precision.** Zero false positives on the calibration set.
  Treat the 7 findings GPT flags as real (rows 1–7) as a **priority queue** —
  most likely to survive your review.
- ❌ **`not-a-defect` and `unclear` are NOT safe to close on.** They missed 12
  of 17 of your accepts. Do not batch-dismiss on the GPT column.

### A caveat on the "file touched since?" column

All 88 findings were filed within the last **three days** (2026-07-26 → 07-28),
and 59 have exactly **one** commit since — consistent with the audited work
simply being shipped, not with a targeted later fix. Read that column as
**context, not evidence**. It matters mainly for the handful with 2–3 commits.

There is a deeper version of this problem: the audit loop *fixes findings
between rounds*, so a shadow finding raised in round N may well have been
remediated before the ship commit. A code-grounded judgement made today
therefore cannot cleanly separate *"never a defect"* from *"was a defect, fixed
during the loop"*. That is the main reason GPT's recall reads low, and it is
the strongest argument for adjudicating close to the run rather than in arrears.

---

## 5. How to work through this

63 findings, ordered so the highest-value ones come first: GPT-flagged `REAL`
first, then `unclear`, then `not-a-defect`; severity descending within each.

**If you want to timebox it**, three tiers:

1. **Rows 1–7** — GPT says `REAL`. Highest hit-rate; zero false positives on
   calibration.
2. **All three HIGH-severity rows (8, 34, 35 — all wine-cellar-app).** Note two
   of them are ones GPT *dismissed*. Given it missed 12 of your 17 accepts, a
   HIGH that GPT waves off is precisely where its conservatism is most
   expensive. Do not skip these on the strength of the GPT column.
3. **The MEDIUM `unclear` rows** — mostly cases where the source was truncated
   past the relevant region, so GPT abstained rather than judged.

The tail of LOW + `not-a-defect` will not move either criterion.

Every finding below carries **two ready-to-run commands** — one to accept, one
to dismiss. Run whichever applies; nothing needs editing first. (They are spelled
out in full rather than as `<placeholders>` because PowerShell reserves `<` and
refuses to paste such a line — a convention this repo learned the hard way.)

Re-score at any point:

```bash
node scripts/cross-skill.mjs final-review-stats --repo Lbstrydom/claude-engineering-skills --queue-limit 500
```

```bash
node scripts/cross-skill.mjs final-review-stats --repo Lbstrydom/wine-cellar-app --queue-limit 500
```

If a finding led to a real code fix, record that separately — acceptance and
remediation are different axes in this system, and conflating them is what made
the conversion metric unmeasurable until it was fixed on 2026-07-27. Substitute
the real sha:

```bash
node scripts/cross-skill.mjs final-review-record-fix 66bdeaea-3c3c-430e-9c1e-100621c4cfb2 2d65e6fd --commit-sha a805d34
```

---

## 6. Adjudication queue

| # | Repo | Sev | GPT verdict | Conf | Evidence | File touched since? | File | Your call |
|---|---|---|---|---|---|---|---|---|
| 1 | ces | MEDIUM | **REAL** | high | confirmed in code | yes (1) | `scripts/lib/lint/on-conflict.mjs` | ☐ accept ☐ dismiss |
| 2 | ces | MEDIUM | **REAL** | high | confirmed in code | yes (1) | `scripts/lib/claudemd/autofix.mjs` | ☐ accept ☐ dismiss |
| 3 | ces | MEDIUM | **REAL** | high | confirmed in code | yes (1) | `scripts/lib/store/arch/imports.mjs` | ☐ accept ☐ dismiss |
| 4 | wine | MEDIUM | **REAL** | high | confirmed in code | yes (1) | `tests/unit/contracts/clientStorageFacadeRatchet.test.js` | ☐ accept ☐ dismiss |
| 5 | ces | LOW | **REAL** | high | confirmed in code | yes (1) | `scripts/symbol-index/refresh-args.mjs` | ☐ accept ☐ dismiss |
| 6 | ces | LOW | **REAL** | high | confirmed in code | yes (1) | `scripts/lib/store/arch/refresh-runs.mjs` | ☐ accept ☐ dismiss |
| 7 | wine | LOW | **REAL** | high | confirmed in code | yes (1) | `data/migrations/162_undo_batch_id_rollback.sql` | ☐ accept ☐ dismiss |
| 8 | wine | HIGH | unclear | low | code unavailable | yes (1) | `public/js/api/base.js` | ☐ accept ☐ dismiss |
| 9 | ces | MEDIUM | unclear | low | code unavailable | yes (1) | `scripts/sync-to-repos.mjs` | ☐ accept ☐ dismiss |
| 10 | ces | MEDIUM | unclear | low | code unavailable | yes (1) | `scripts/lib/lint/on-conflict.mjs` | ☐ accept ☐ dismiss |
| 11 | ces | MEDIUM | unclear | high | code unavailable | yes (1) | `scripts/lib/audit/diff-path-map.mjs` | ☐ accept ☐ dismiss |
| 12 | ces | MEDIUM | unclear | low | code unavailable | yes (1) | `scripts/symbol-index/extract.mjs` | ☐ accept ☐ dismiss |
| 13 | ces | MEDIUM | unclear | low | code unavailable | yes (2) | `docs/plans/refactor-evidence-integrity.md` | ☐ accept ☐ dismiss |
| 14 | ces | MEDIUM | unclear | low | code unavailable | yes (1) | `tests/refresh-heartbeat.test.mjs` | ☐ accept ☐ dismiss |
| 15 | ces | MEDIUM | unclear | low | code unavailable | no | `scripts/check-architecture-intent-drift.mjs` | ☐ accept ☐ dismiss |
| 16 | ces | MEDIUM | unclear | low | code unavailable | no | `scripts/check-architecture-intent-drift.mjs` | ☐ accept ☐ dismiss |
| 17 | wine | MEDIUM | unclear | low | code unavailable | ? | `—` | ☐ accept ☐ dismiss |
| 18 | wine | MEDIUM | unclear | low | code unavailable | yes (1) | `public/js/wineShop/state.js` | ☐ accept ☐ dismiss |
| 19 | wine | MEDIUM | unclear | low | code unavailable | yes (1) | `docs/plans/monolith-commercial-quality.md` | ☐ accept ☐ dismiss |
| 20 | wine | MEDIUM | unclear | low | code unavailable | yes (1) | `src/routes/pairing.js` | ☐ accept ☐ dismiss |
| 21 | wine | MEDIUM | unclear | low | code unavailable | ? | `—` | ☐ accept ☐ dismiss |
| 22 | wine | MEDIUM | unclear | low | code unavailable | yes (1) | `scripts/start.sh` | ☐ accept ☐ dismiss |
| 23 | wine | MEDIUM | unclear | medium | code unavailable | yes (1) | `public/js/cellarSwitcher.js` | ☐ accept ☐ dismiss |
| 24 | wine | MEDIUM | unclear | low | code unavailable | yes (1) | `docs/plans/monolith-commercial-quality.md` | ☐ accept ☐ dismiss |
| 25 | wine | MEDIUM | unclear | low | code unavailable | yes (1) | `public/js/api/base.js` | ☐ accept ☐ dismiss |
| 26 | wine | MEDIUM | unclear | low | code unavailable | yes (1) | `public/js/app.js` | ☐ accept ☐ dismiss |
| 27 | ces | LOW | unclear | low | code unavailable | yes (1) | `scripts/lib/lint/on-conflict.mjs` | ☐ accept ☐ dismiss |
| 28 | ces | LOW | unclear | high | code unavailable | yes (3) | `docs/plans/refactor-autofix-security.md` | ☐ accept ☐ dismiss |
| 29 | ces | LOW | unclear | low | code unavailable | yes (3) | `docs/plans/refactor-autofix-security.md` | ☐ accept ☐ dismiss |
| 30 | ces | LOW | unclear | low | code unavailable | no | `scripts/check-architecture-intent-drift.mjs` | ☐ accept ☐ dismiss |
| 31 | wine | LOW | unclear | low | code unavailable | yes (1) | `tests/unit/services/agent/agentContext.test.js` | ☐ accept ☐ dismiss |
| 32 | wine | LOW | unclear | low | code unavailable | yes (1) | `tests/unit/contracts/_baselines/fileSizes.json` | ☐ accept ☐ dismiss |
| 33 | wine | LOW | unclear | high | code unavailable | yes (1) | `src/server.js` | ☐ accept ☐ dismiss |
| 34 | wine | HIGH | not-a-defect | high | contradicted by code | yes (1) | `src/services/pairing/pairingChatContext.js` | ☐ accept ☐ dismiss |
| 35 | wine | HIGH | not-a-defect | high | contradicted by code | yes (1) | `public/js/api/base.js` | ☐ accept ☐ dismiss |
| 36 | ces | MEDIUM | not-a-defect | high | contradicted by code | yes (1) | `scripts/regenerate-skill-copies.mjs` | ☐ accept ☐ dismiss |
| 37 | ces | MEDIUM | not-a-defect | high | contradicted by code | yes (1) | `scripts/lib/audit/adjacency-detector.mjs` | ☐ accept ☐ dismiss |
| 38 | ces | MEDIUM | not-a-defect | high | confirmed in code | yes (1) | `scripts/lib/audit/diff-path-map.mjs` | ☐ accept ☐ dismiss |
| 39 | ces | MEDIUM | not-a-defect | high | contradicted by code | yes (1) | `scripts/lib/audit/diff-path-map.mjs` | ☐ accept ☐ dismiss |
| 40 | ces | MEDIUM | not-a-defect | high | contradicted by code | yes (1) | `scripts/lib/claudemd/autofix.mjs` | ☐ accept ☐ dismiss |
| 41 | ces | MEDIUM | not-a-defect | high | contradicted by code | yes (3) | `docs/plans/refactor-autofix-security.md` | ☐ accept ☐ dismiss |
| 42 | ces | MEDIUM | not-a-defect | high | confirmed in code | yes (1) | `scripts/lib/store/arch/refresh-runs.mjs` | ☐ accept ☐ dismiss |
| 43 | ces | MEDIUM | not-a-defect | high | contradicted by code | yes (1) | `scripts/lib/store/arch/refresh-runs.mjs` | ☐ accept ☐ dismiss |
| 44 | ces | MEDIUM | not-a-defect | high | contradicted by code | yes (1) | `scripts/lib/store/arch/imports.mjs` | ☐ accept ☐ dismiss |
| 45 | wine | MEDIUM | not-a-defect | high | contradicted by code | yes (1) | `src/services/shared/flagFromEnv.js` | ☐ accept ☐ dismiss |
| 46 | wine | MEDIUM | not-a-defect | high | contradicted by code | yes (1) | `tests/unit/contracts/findBestZoneRetired.test.js` | ☐ accept ☐ dismiss |
| 47 | wine | MEDIUM | not-a-defect | high | contradicted by code | yes (1) | `tests/unit/contracts/fileSizeBudgetRatchet.test.js` | ☐ accept ☐ dismiss |
| 48 | wine | MEDIUM | not-a-defect | high | confirmed in code | yes (1) | `public/js/grid.js` | ☐ accept ☐ dismiss |
| 49 | wine | MEDIUM | not-a-defect | high | contradicted by code | yes (1) | `src/services/shared/undoManager.js` | ☐ accept ☐ dismiss |
| 50 | wine | MEDIUM | not-a-defect | high | contradicted by code | yes (2) | `tests/integration/undoBatchClaim.test.js` | ☐ accept ☐ dismiss |
| 51 | ces | LOW | not-a-defect | high | confirmed in code | yes (1) | `tests/install-surface-scope.test.mjs` | ☐ accept ☐ dismiss |
| 52 | ces | LOW | not-a-defect | high | contradicted by code | yes (1) | `scripts/lib/install/surface-paths.mjs` | ☐ accept ☐ dismiss |
| 53 | ces | LOW | not-a-defect | high | confirmed in code | yes (1) | `scripts/lib/import-binding.mjs` | ☐ accept ☐ dismiss |
| 54 | ces | LOW | not-a-defect | high | confirmed in code | yes (1) | `scripts/lib/audit/tiered-shadow-contract-digest.mjs` | ☐ accept ☐ dismiss |
| 55 | ces | LOW | not-a-defect | high | contradicted by code | yes (1) | `scripts/symbol-index/refresh-subprocess.mjs` | ☐ accept ☐ dismiss |
| 56 | ces | LOW | not-a-defect | high | contradicted by code | yes (1) | `scripts/symbol-index/drift.mjs` | ☐ accept ☐ dismiss |
| 57 | ces | LOW | not-a-defect | high | contradicted by code | yes (2) | `docs/plans/refactor-evidence-integrity.md` | ☐ accept ☐ dismiss |
| 58 | ces | LOW | not-a-defect | high | contradicted by code | yes (1) | `tests/claudemd/autofix.test.mjs` | ☐ accept ☐ dismiss |
| 59 | ces | LOW | not-a-defect | high | contradicted by code | yes (1) | `scripts/lib/store/arch/imports.mjs` | ☐ accept ☐ dismiss |
| 60 | ces | LOW | not-a-defect | high | contradicted by code | no | `scripts/lib/store/arch/coverage.mjs` | ☐ accept ☐ dismiss |
| 61 | wine | LOW | not-a-defect | high | confirmed in code | yes (1) | `tests/unit/contracts/clientStorageFacadeRatchet.test.js` | ☐ accept ☐ dismiss |
| 62 | wine | LOW | not-a-defect | high | contradicted by code | yes (1) | `tests/unit/contracts/reactSliceOneInOneOut.test.js` | ☐ accept ☐ dismiss |
| 63 | wine | LOW | not-a-defect | high | contradicted by code | yes (1) | `public/js/cellarAnalysis/state.js` | ☐ accept ☐ dismiss |

---

## Per-finding detail

### 1. [MEDIUM] Silent Suppression Widening

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/lint/on-conflict.mjs — SUPPRESSION_RE / findSuppression selector form`
- **Fingerprint**: `2d65e6fd` · run `66bdeaea` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The plan specifies the new selector pragma `@on-conflict-ok(<col>): reason` as governing 'the exact {callId, column, kind} signal(s) for that one column — allowlisted diagnostic AND that column's findings'. That means the new syntax silently gains the power to suppress a gating `nullable-conflict-key` FINDING for that column, not just the new non-gating diagnostic. There is no separate reviewer signal distinguishing 'I adjudicated an undecidable diagnostic' from 'I suppressed a proven nullable conflict key'. bandit-fp.mjs's live pragma is written for the diagnostic case but would equally silen

**GPT-5.6 independent judgement:** **REAL** · worth fixing: yes · confidence high · evidence confirmed in code · _source truncated_

> The source explicitly documents selector pragmas as governing a call-and-column signal for both findings and the unresolved diagnostic, so a selector for a nullable column can suppress the gating `nullable-conflict-key` finding without a kind-specific reviewer acknowledgement.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 66bdeaea-3c3c-430e-9c1e-100621c4cfb2 2d65e6fd accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 66bdeaea-3c3c-430e-9c1e-100621c4cfb2 2d65e6fd dismissed
```

### 2. [MEDIUM] Missing Error Handling / Reporting Honesty

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/claudemd/autofix.mjs — `atomicWriteFileSync(canonical, ...)` write loop`
- **Fingerprint**: `c28c2850` · run `4851afed` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The final write is unguarded. If `atomicWriteFileSync` throws (EROFS/ENOSPC/EACCES, or a Windows transient rename failure) for canonical group N, the exception propagates out of `applyFixes` — but groups 1..N-1 have ALREADY been written to disk. The caller (`scripts/claudemd-lint.mjs`) catches at top level and exits 3 with only `err.message`, so the operator is told the linter failed while an unknown subset of their instruction files has in fact been mutated. The plan deferred this as "independent, behaviour identical before/after", but that independence claim is weaker after this change: cano

**GPT-5.6 independent judgement:** **REAL** · worth fixing: yes · confidence high · evidence confirmed in code

> `atomicWriteFileSync` is unguarded after earlier canonical groups may have been committed, so a later write failure aborts `applyFixes` without returning structured per-group failure information.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 4851afed-5723-44d0-a7f6-857c1ac4da06 c28c2850 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 4851afed-5723-44d0-a7f6-857c1ac4da06 c28c2850 dismissed
```

### 3. [MEDIUM] Data Integrity / Stale Snapshot Data

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/store/arch/imports.mjs — copyForwardImports`
- **Fingerprint**: `d0ddfbf2` · run `9bbbe893` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> copyForwardImports filters carried-forward edges with `!touchedFileSet.has(r.importer_path)` only. An edge `a.mjs -> b.mjs` where only `b.mjs` changed (or was deleted) is copied forward verbatim into the new snapshot, so the import graph can retain edges pointing at files that no longer exist. The optional `fileStillExists` gate is likewise applied only to `r.importer_path`, never to `r.imported_path`, so even the timed-out-full recovery path cannot catch it. This was raised as GPT Cluster-A/r4 H1 (topicId 27dbcbc5) and explicitly routed to Cluster E ('to be fixed in Cluster E (Phase 5), which

**GPT-5.6 independent judgement:** **REAL** · worth fixing: yes · confidence high · evidence confirmed in code

> `copyForwardImports` excludes and existence-checks only `importer_path`, so an unchanged importer edge targeting a deleted touched file is copied into the new snapshot; a target merely changing does not itself make the edge stale.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 9bbbe893-2fc9-418e-b9c7-0a88fa7c91ba d0ddfbf2 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 9bbbe893-2fc9-418e-b9c7-0a88fa7c91ba d0ddfbf2 dismissed
```

### 4. [MEDIUM] Incomplete Enforcement / Bypassable Ratchet

- **Repo / file**: `wine-cellar-app` → `tests/unit/contracts/clientStorageFacadeRatchet.test.js + _baselines/clientStorage.json`
- **Fingerprint**: `c4358b46` · run `5ca09e1b` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The client-storage ratchet is specified as a text/regex scan over call sites (raw localStorage/sessionStorage counts per path, cellarStorage.<op>( first-argument must be a DOMAINS.<MEMBER> reference, and safeStorage.<op>( call counts per path). Every one of those predicates is trivially defeated by ordinary aliasing that is not a new raw call and not a new importer: `const s = window.localStorage`, `const {get} = cellarStorage`, `const D = DOMAINS; cellarStorage.get(D.PLACEMENT, ...)`, or `globalThis['local'+'Storage']`. public/js/wineShop/state.js already shows the shape of the hole — it keep

**GPT-5.6 independent judgement:** **REAL** · worth fixing: yes · confidence high · evidence confirmed in code

> The three checks only match direct property-call syntax, so aliases or computed access evade raw, safeStorage, and DOMAINS-first-argument enforcement while preserving the intended forbidden behavior.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 5ca09e1b-4600-4a5f-8115-760493b2710c c4358b46 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 5ca09e1b-4600-4a5f-8115-760493b2710c c4358b46 dismissed
```

### 5. [LOW] Silent Failure / CLI Contract

- **Repo / file**: `claude-engineering-skills` → `scripts/symbol-index/refresh-args.mjs — parseArgs switch with no default case`
- **Fingerprint**: `8b44afac` · run `9bbbe893` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The rewritten `switch (a)` has no `default:` branch. Correctness today rests entirely on `assertKnownFlags` having already rejected anything not in KNOWN_FLAGS, plus a bare-positional silently falling through. That is exactly the coupling that produced the original `--selfcheck-relocation` incident documented in this file's own header (an allowlist entry with no parser handler). The two lists (KNOWN_FLAGS and the switch cases) must now be kept in sync by hand, with no mechanism that fails when they diverge — a future flag added to KNOWN_FLAGS but not to the switch is silently ignored again.

**GPT-5.6 independent judgement:** **REAL** · worth fixing: yes · confidence high · evidence confirmed in code

> `KNOWN_FLAGS` is independently maintained from the switch, and a future allowlisted flag without a case will pass validation and be silently ignored; a default invariant/error would prevent recurrence.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 9bbbe893-2fc9-418e-b9c7-0a88fa7c91ba 8b44afac accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 9bbbe893-2fc9-418e-b9c7-0a88fa7c91ba 8b44afac dismissed
```

### 6. [LOW] Error Swallowing

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/store/arch/refresh-runs.mjs (getRefreshRun catch block)`
- **Fingerprint**: `eb126c98` · run `90157ab9` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> getRefreshRun ends with a bare `catch { return null; }` — no logging, no error preservation, no cause chaining. Its sole caller (finalizeRefreshMode, refresh-mode.mjs:74) uses the result to decide whether a prior snapshot can be reused. A transient DB error is now indistinguishable from three other null-producing conditions this PR expanded: cloud disabled, genuine not-found, and repoId mismatch. Shadow finding SFG2-4 raised this; no disposition recorded. Note the contrast with abortRefreshRun and markImportGraphPopulated in the same PR, which both wrap errors with a descriptive `<fn> failed:`

**GPT-5.6 independent judgement:** **REAL** · worth fixing: yes · confidence high · evidence confirmed in code

> `getRefreshRun` catches every query failure and returns `null`, conflating database failures with cloud-disabled and absent/scoped-out rows, so callers cannot distinguish a transient store outage from a valid cache miss.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 90157ab9-c4a5-448d-baf7-9868996b4148 eb126c98 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 90157ab9-c4a5-448d-baf7-9868996b4148 eb126c98 dismissed
```

### 7. [LOW] Migration Safety / Deployment

- **Repo / file**: `wine-cellar-app` → `data/migrations/162_undo_batch_id_rollback.sql`
- **Fingerprint**: `7fa59b66` · run `adff5e14` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The fail-loud guard `SELECT count(*) ... WHERE batch_id IS NOT NULL AND consumed_at IS NULL AND expires_at > NOW()` runs inside the same transaction as the DROP COLUMNs, but takes no lock preventing a concurrent `createBatchUndoToken()` from stamping a NEW live batch row between the guard's read and the DROP. `ALTER TABLE ... DROP COLUMN` acquires ACCESS EXCLUSIVE and will block behind the in-flight batchResolve transaction, then proceed — the guard's snapshot is already stale. The rollback's own comment ('confirm the application code that issues batch tokens is already stopped') acknowledges

**GPT-5.6 independent judgement:** **REAL** · worth fixing: yes · confidence high · evidence confirmed in code

> The guard only performs an unlocked read before requesting ACCESS EXCLUSIVE via ALTER TABLE, so a concurrent writer can insert a live batch row after the check and commit before the drop proceeds.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate adff5e14-4306-4408-9b23-3ffed0bf9a69 7fa59b66 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate adff5e14-4306-4408-9b23-3ffed0bf9a69 7fa59b66 dismissed
```

### 8. [HIGH] Incomplete Fix / Tenant Isolation

- **Repo / file**: `wine-cellar-app` → `public/js/api/base.js (getActiveCellarId / clearAuthState) + public/js/shared/cellarStorage.js`
- **Fingerprint**: `ba09dae1` · run `3d955dfd` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The whole Cluster A isolation guarantee rests on `getActiveCellarId()` in `api/base.js`, which still reads the raw, UNSCOPED `active_cellar_id` key via `safeStorage` — and `safeStorage` silently falls back to an in-memory Map on quota failure. The plan explicitly identified this exact swallow-and-lie behaviour as fatal for the facade (Gemini G2, 'Write truthfulness') and made `cellarStorage` bypass `safeStorage` for writes. But the facade's *namespace selector* — the single value that decides which tenant's data is readable — was left on the very mechanism the plan condemned. If `setActiveCell

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable

> base.js does use safeStorage for the global active-cellar selector, but the supplied source omits safeStorage and cellarStorage, so the alleged fallback divergence and resulting cross-tenant read cannot be verified.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 3d955dfd-8727-4f17-a1af-9fe925b5d7b1 ba09dae1 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 3d955dfd-8727-4f17-a1af-9fe925b5d7b1 ba09dae1 dismissed
```

### 9. [MEDIUM] Silent Failure / Detection Gap

- **Repo / file**: `claude-engineering-skills` → `scripts/sync-to-repos.mjs — inspectTargetSkillSurfaces + decideShadowFailure interaction`
- **Fingerprint**: `7e5361a4` · run `47623e0b` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> inspectTargetSkillSurfaces returns `{shadowed: [], orphans: [], inspectionError: stale.error}` when the stale surface is unreadable, and decideShadowFailure short-circuits on `inspection.shadowed.length === 0` — so an unreadable .github/skills/ in a consumer repo logs a warning and the sync reports SUCCESS. This is precisely the false-clean class of bug that round-2 M1, round-3 M1 and Gemini shadow #2 fixed three separate times inside listSurfaceNames/removeStaleGithubSkills; the sync call site re-opens it one layer up. Note the asymmetry with check-stale-skill-surface.mjs's main(), which deli

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable · _source truncated_

> The provided source truncates before inspectTargetSkillSurfaces and decideShadowFailure, so their error propagation and success-path behavior cannot be verified.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 47623e0b-8a71-4445-af26-7f19732c6874 7e5361a4 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 47623e0b-8a71-4445-af26-7f19732c6874 7e5361a4 dismissed
```

### 10. [MEDIUM] Missing Error Handling / Fail-Open Analysis

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/lint/on-conflict.mjs (uses parseSource from scripts/lib/ast.mjs)`
- **Fingerprint**: `91d3f4eb` · run `66bdeaea` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> on-conflict.mjs is the module whose whole stated thesis (fileoverview) is that an undecidable input must never be laundered into a clean result — yet it still consumes `parseSource()` without inspecting `recoveredErrors`. ast.mjs (also changed in this diff) explicitly documents the three-outcome contract and warns that a Babel-recovered PARTIAL AST is 'indistinguishable from a clean one' for a consumer needing sound structural coverage. A truncated/partially-parsed store file therefore yields fewer discovered upsert sites, fewer columns, and possibly a missing conflict target — reported as cle

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable · _source truncated_

> The provided excerpt imports `parseSource` but is truncated before its invocation and any handling of `recoveredErrors`, so the claimed fail-open behavior cannot be verified.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 66bdeaea-3c3c-430e-9c1e-100621c4cfb2 91d3f4eb accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 66bdeaea-3c3c-430e-9c1e-100621c4cfb2 91d3f4eb dismissed
```

### 11. [MEDIUM] Audit Process Integrity

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/audit/diff-path-map.mjs (in-scope file omitted from transcript)`
- **Fingerprint**: `416e8858` · run `65f85691` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The single in-scope file was omitted from the transcript ("1 file(s) omitted — context budget reached"), and GPT's only finding explicitly reasons from a "truncated diff". `claude_resolutions` is empty, so the finding was never accepted or challenged. The Stage 2 adjudication therefore converged without either (a) the code under review or (b) any author response — the gate produced a verdict on absent evidence.

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence high · evidence code unavailable

> The supplied source is the previously omitted implementation, but it contains no Stage 2 transcript, GPT finding, or `claude_resolutions` data to verify that adjudication occurred without evidence or author response.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 65f85691-5816-48a1-8e1b-400fec8ff833 416e8858 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 65f85691-5816-48a1-8e1b-400fec8ff833 416e8858 dismissed
```

### 12. [MEDIUM] Missing Regression Guard

- **Repo / file**: `claude-engineering-skills` → `scripts/symbol-index/extract.mjs — per-file loop named beat / tests/subprocess-idle-timeout.test.mjs`
- **Fingerprint**: `8fa17dfe` · run `0ecf52a3` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The entire safety property of this change is positional: the named `emit({type:'progress', file: rel})` must sit AFTER `admitFile` and inside the admitted branch. Nothing in the shipped test set fails if a future editor hoists that emit above `admitFile` or moves it out of the guarded branch, EXCEPT the fixture-based sequence assertions — and those only cover paths that `resolveAndClassify`/`shouldSkipForIndexing` actually reject on the running platform. The plan's own §4 flags this ("the safety property is positional, not enforced by a type") but the implementation adds no guard that binds th

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable · _source truncated_

> The extractor places the named progress emit after successful admission, but the cited test file is not provided, so the alleged lack of a regression test for hoisting it cannot be verified.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 0ecf52a3-c680-4b11-88db-c6bbfdcabb4a 8fa17dfe accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 0ecf52a3-c680-4b11-88db-c6bbfdcabb4a 8fa17dfe dismissed
```

### 13. [MEDIUM] Missing Migration/Compatibility Analysis

- **Repo / file**: `claude-engineering-skills` → `docs/plans/refactor-evidence-integrity.md §4.2 / §7 (buildDiffPathMap 'invalid' branch)`
- **Fingerprint**: `feb2ed24` · run `c065479c` · filed 2026-07-27
- **File changed since filed**: **yes — 2 commit(s)**

**Shadow (Claude Opus) claim:**

> The plan adds a new `{kind:'invalid', reason:'undecodable_diff_header'}` result from buildDiffPathMap but never enumerates the existing consumers of that discriminated union to confirm they all handle an unknown `reason` value. diff-path-map.mjs's JSDoc types `reason` as a closed union ('malformed_diff_header'\|'parser_threw'\|'discovery_map_exceeds_budget'), and discovery-diff-scope.mjs's resolveEligibleDiffPathMap only checks `map.kind !== 'ready'`. Any downstream switch/if-chain on `reason` (telemetry labels, fallback messaging, dashboard aggregation) that is not exhaustive-by-default will si

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable · _source truncated_

> The supplied plan is truncated before §4.2 and §7, so it cannot confirm whether the new invalid reason’s consumers and compatibility handling are enumerated there.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate c065479c-0827-42f0-9f58-32b084e0f0b5 feb2ed24 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate c065479c-0827-42f0-9f58-32b084e0f0b5 feb2ed24 dismissed
```

### 14. [MEDIUM] Missing Test Coverage vs. Stated Acceptance Criteria

- **Repo / file**: `claude-engineering-skills` → `tests/refresh-heartbeat.test.mjs, tests/refresh-runs-repo-scoping.test.mjs`
- **Fingerprint**: `e92150c0` · run `90157ab9` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The plan's Phase 1 acceptance criteria name the deterministic two-directional abort/publish race test as THE correctness proof of the mutual-exclusion invariant (publish-then-abort must be a 0-row no-op with status staying 'published'; abort-then-publish must have the RPC's `IF v_status != 'running'` guard reject), explicitly demoting the empirical live-process run to a wiring sanity check. The two new test files are named for heartbeat behaviour and repo scoping. Neither the transcript, the resolutions list, nor the file names records that the two-directional race test was written. Shadow fin

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable

> The supplied heartbeat test contains no publish/abort RPC race coverage, but the referenced repo-scoping test and acceptance-plan evidence are unavailable, so absence of the required test cannot be confirmed.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 90157ab9-c4a5-448d-baf7-9868996b4148 e92150c0 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 90157ab9-c4a5-448d-baf7-9868996b4148 e92150c0 dismissed
```

### 15. [MEDIUM] Gate Coverage Gap

- **Repo / file**: `claude-engineering-skills` → `scripts/check-architecture-intent-drift.mjs + docs/architecture-intent.md`
- **Fingerprint**: `a76736c3` · run `bfdb39aa` · filed 2026-07-27
- **File changed since filed**: no

**Shadow (Claude Opus) claim:**

> The drift gate compares only rule.domain names against `### \`<domain>\`` headings. domain-map.json also carries an `allowedDeps` map whose KEYS are domains (e.g. `arch-intent`, `cross-skill-bridge`) and whose VALUES name domains. A domain that appears only in allowedDeps — or a domain whose rule is later removed but whose allowedDeps entry remains — is invisible to the gate. The doc's own stated purpose ('This doc + domain-map.json together enforce that those seams stay clean') covers the dependency intent, not just the domain roster, so the gate under-covers the very drift class item 3 exist

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable

> The relevant script, documentation, and domain-map schema are unavailable, so the claimed omission of allowedDeps keys and values cannot be verified against current code.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate bfdb39aa-61de-40aa-85a3-8a40046f452b a76736c3 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate bfdb39aa-61de-40aa-85a3-8a40046f452b a76736c3 dismissed
```

### 16. [MEDIUM] Duplicated Logic / DRY Violation

- **Repo / file**: `claude-engineering-skills` → `scripts/check-architecture-intent-drift.mjs vs scripts/check-context-drift.mjs`
- **Fingerprint**: `84f9bbd8` · run `bfdb39aa` · filed 2026-07-27
- **File changed since filed**: no

**Shadow (Claude Opus) claim:**

> check-architecture-intent-drift.mjs re-implements CommonMark fence tracking inline (fenceOpenRe + fenceChar/fenceLen state) while scripts/check-context-drift.mjs already exports the identical logic as makeFenceTracker() — same rules (same char, len >= open len), same tilde/backtick handling. The new script's version was hand-derived across rounds 2, 3 and 4 of the audit, converging on the behaviour the existing helper already had. Two copies of a subtle Markdown parser will drift; the audit itself demonstrated how easy each variant is to get wrong.

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable

> The relevant source was unavailable, so the alleged duplicate fence-tracking implementation and existing exported helper cannot be verified.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate bfdb39aa-61de-40aa-85a3-8a40046f452b 84f9bbd8 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate bfdb39aa-61de-40aa-85a3-8a40046f452b 84f9bbd8 dismissed
```

### 17. [MEDIUM] Missing Deliberation / Process Gap

- **Repo / file**: `wine-cellar-app` → `Audit transcript (rounds: [], claude_resolutions[0]) — consolidated gate over all 5 clusters`
- **Fingerprint**: `6406f08f` · run `3d955dfd` · filed 2026-07-28
- **File changed since filed**: unknown

**Shadow (Claude Opus) claim:**

> This pass is declared as the /cycle skill's mandatory Step 3C.2 consolidated cross-cluster review — the one gate whose explicit purpose is to catch what no single cluster's isolated diff could surface. It ran with zero rounds and zero findings, and its sole resolution is a pointer back to the per-cluster logs. The union diff spans 40 files across frontend tenancy, boot wiring, Docker build args, service-worker precaching and six governance ratchets, and includes at least two genuine cross-cluster couplings the plan itself flags (`src/server.js` written by both B5 and E3; `public/sw.js`'s asset

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable

> The referenced audit transcript and underlying changes are unavailable, so the claimed zero-round consolidated review and any cross-cluster defects cannot be verified.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 3d955dfd-8727-4f17-a1af-9fe925b5d7b1 6406f08f accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 3d955dfd-8727-4f17-a1af-9fe925b5d7b1 6406f08f dismissed
```

### 18. [MEDIUM] Cross-Cluster Contradiction

- **Repo / file**: `wine-cellar-app` → `public/js/wineShop/state.js + public/js/cellarAnalysis/state.js (deferred-init rule)`
- **Fingerprint**: `83650f0b` · run `3d955dfd` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The plan's own 'Deferred initial reads' rule (Gemini-r2/G3) requires every converted state module to initialise persisted fields to a neutral value at import and expose an `init()` called from the post-auth boot path — and Cluster A ships a test asserting importing each converted module performs ZERO storage reads. `cellarAnalysis/state.js` and `restaurantPairing/state.js` comply and are wired into `app.js` boot. `wineShop/state.js` was converted to the facade but has NO `init()` and is NOT in `app.js`'s boot wiring; it reads lazily via `getActiveCollectionId()` instead. That is arguably fine

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable

> The supplied module has no init() and reads only on getter calls, but the alleged mandatory rule and app.js boot wiring are not provided, so a defect cannot be established.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 3d955dfd-8727-4f17-a1af-9fe925b5d7b1 83650f0b accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 3d955dfd-8727-4f17-a1af-9fe925b5d7b1 83650f0b dismissed
```

### 19. [MEDIUM] Governance / Self-Approval of a Gated Decision

- **Repo / file**: `wine-cellar-app` → `docs/plans/monolith-commercial-quality.md §9a + all six D2 deletions (src/routes/pairing.js, signalNormaliser.js, catego`
- **Fingerprint**: `d5af90b7` · run `441eee38` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The plan defines D2 as audit-gated: 'No D2 item may be deleted unless the audit approves it', with an adversarial reviewer explicitly named as the mechanism because the author's own grep already falsified 2 of 8 candidates. In the shipped change every §9a row reads 'Claude: DELETE (pending audit-code gate)' with 'Deleted? Yes' — i.e. all six were deleted before any external ruling, and the only audit round that then ran (GPT r1) raised zero findings on any of them and admitted incomplete enumeration (M5). The gate was recorded as satisfied by the same party that proposed the deletions.

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable · _source truncated_

> The supplied source is truncated before §9a and provides none of the six deletion diffs or audit records needed to verify whether the audit gate was bypassed or self-approved.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 441eee38-66b2-42b1-a2f3-ae4cd5dbdb95 d5af90b7 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 441eee38-66b2-42b1-a2f3-ae4cd5dbdb95 d5af90b7 dismissed
```

### 20. [MEDIUM] Missing Error Handling / Wrong Removal Semantics for a Public HTTP Endpoint

- **Repo / file**: `wine-cellar-app` → `src/routes/pairing.js, tests/unit/routes/pairingStyleGuidanceRouteRemoval.test.js`
- **Fingerprint**: `8e51fae0` · run `441eee38` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The deprecated route POST /api/pairing/wine-store/style-guidance was removed outright and the new test asserts a bare 404 on the old mount. A 404 is indistinguishable from a typo/transient routing fault: any residual caller (a cached PWA bundle from before this deploy, a bookmarked integration, an offline client replaying a queued request) gets a generic not-found with no signal that the endpoint was retired or where to go. The plan's own D1/D2 reachability table for the HTTP-route class asked for '404/410' — 410 Gone with a pointer to POST /api/pairing/style-guidance is the semantically corre

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable · _source truncated_

> The supplied file truncates inside the style-guidance handler before its route registrations, and the cited test is not provided, so the old-route behavior cannot be confirmed.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 441eee38-66b2-42b1-a2f3-ae4cd5dbdb95 8e51fae0 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 441eee38-66b2-42b1-a2f3-ae4cd5dbdb95 8e51fae0 dismissed
```

### 21. [MEDIUM] Missing Verification / Untested Enforcement

- **Repo / file**: `wine-cellar-app` → `tests/unit/contracts/*Ratchet.test.js + tests/unit/contracts/_baselines/*.json`
- **Fingerprint**: `1b7282e7` · run `5ca09e1b` · filed 2026-07-28
- **File changed since filed**: unknown

**Shadow (Claude Opus) claim:**

> The PR's entire value proposition is that six ratchet tests will FAIL on regression while nobody is watching (plan §0: 'prefer mechanisms over plans'). Plan §6 Cluster C explicitly requires 'each ratchet must be shown to fail when the count is artificially incremented, not merely to pass today', and AC-6 requires they 'fail on an artificial regression'. Neither the transcript nor the audit summary records any negative-path evidence — only 'full unit suite (11,815 tests) green', which is exactly the passing-at-baseline signal the plan says is insufficient. A ratchet whose scanner silently match

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable

> The cited ratchet tests, baselines, and execution evidence are unavailable, so the absence of negative-path verification cannot be confirmed from the source.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 5ca09e1b-4600-4a5f-8115-760493b2710c 1b7282e7 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 5ca09e1b-4600-4a5f-8115-760493b2710c 1b7282e7 dismissed
```

### 22. [MEDIUM] Missing Error Handling / Deployment Safety

- **Repo / file**: `wine-cellar-app` → `scripts/start.sh — advisory-lock exit-code contract`
- **Fingerprint**: `429e3b84` · run `d7cb96cf` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> start.sh runs under `set -e` and now invokes the migration runner with --require-db. Decision B-iii specifies the runner exits 1 loudly when it cannot acquire the advisory lock within lock_timeout=120s. Under `set -e` that exit-1 kills the container before `exec node src/server.js`. On a multi-replica deploy where one replica's migration legitimately takes longer than 120s, every other replica crash-loops rather than waiting — and Railway will interpret that as a failed deploy for the whole service. The plan states the deadline exists so a contender 'must not proceed unlocked', but never recon

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable

> start.sh intentionally treats migration failures as deployment failures, but the migration runner’s advisory-lock timeout/exit behavior and any retry policy are not provided.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate d7cb96cf-2275-48fb-918b-97a913dbfc09 429e3b84 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate d7cb96cf-2275-48fb-918b-97a913dbfc09 429e3b84 dismissed
```

### 23. [MEDIUM] Tenant Isolation / Incomplete Migration

- **Repo / file**: `wine-cellar-app` → `public/js/cellarSwitcher.js — setActiveCellarId() ordering vs. cellarStorage namespace`
- **Fingerprint**: `a7e0d783` · run `d7cb96cf` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The switch handler flips setActiveCellarId(nextCellarId) and then calls window.location.reload() as the last two statements. The inline comment acknowledges this 'minimises (does not require a structural fix to fully close) the window where old-cellar UI could still be on screen while cellarStorage's active-cellar scope has already changed underneath it'. But reload() is not synchronous — it schedules a navigation, and any already-queued microtask, pending subscriber callback, or in-flight promise resolution that WRITES through cellarStorage between the flip and the actual unload will persist

**GPT-5.6 independent judgement:** unclear · worth fixing: yes · confidence medium · evidence code unavailable

> The code does set the active ID immediately before reload, but no cellarStorage implementation or concurrent writers are provided to establish that any callback can persist old-cellar data in the interval before navigation unloads the page.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate d7cb96cf-2275-48fb-918b-97a913dbfc09 a7e0d783 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate d7cb96cf-2275-48fb-918b-97a913dbfc09 a7e0d783 dismissed
```

### 24. [MEDIUM] Architectural Coherence / Plan-Code Divergence

- **Repo / file**: `wine-cellar-app` → `docs/plans/monolith-commercial-quality.md §9b + §11 Cluster 2 — B0 blocker disposition`
- **Fingerprint**: `45384efc` · run `d7cb96cf` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> §9b records all three registered handlers as external-side-effect with no reclaim-stable idempotency key, and correctly halts B2/B3. But the plan then ships B1, B4, B5 in the same PR and marks Cluster 2 as proceeding. The consequence is that Cluster 2 is now permanently half-delivered with no mechanism that forces the remainder to land — precisely the 'attention decay' failure mode §0 identifies as the plan's central thesis. There is no ratchet, no test, and no §9a-style pending-ruling table entry that fails when the blocker is left open. §11 Cluster 3's fix-gate covers the ratchets, not this.

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable · _source truncated_

> The supplied excerpt confirms B2/B3 remain explicitly blocked, but it truncates before §§9b and 11, so it cannot verify the alleged shipment, proceeding status, or absence of a pending-ruling ratchet.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate d7cb96cf-2275-48fb-918b-97a913dbfc09 45384efc accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate d7cb96cf-2275-48fb-918b-97a913dbfc09 45384efc dismissed
```

### 25. [MEDIUM] Inconsistent Abstraction / Leaky Facade

- **Repo / file**: `wine-cellar-app` → `public/js/api/base.js (safeStorage for ACTIVE_CELLAR_KEY) vs public/js/shared/cellarStorage.js`
- **Fingerprint**: `c244b105` · run `f69b1f8a` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The plan's Gemini-G2 finding established that safeStorage silently falls back to an in-memory Map on QuotaExceededError and returns success, which is why the facade must not delegate writes to it. Yet base.js still routes the four most security-relevant keys — AUTH_TOKEN_KEY, ACTIVE_CELLAR_KEY, INVITE_CODE_KEY, SUPABASE_SESSION_KEY — through `safeStorage.set()`, whose return value is discarded entirely. Under quota pressure `setActiveCellarId()` can appear to succeed while the id lives only in an in-memory Map that dies on the reload cellarSwitcher performs three lines later. The user is then

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable

> base.js does discard safeStorage.set() results, but the asserted quota-error in-memory fallback and cellarSwitcher reload behavior are in unavailable modules, so the claimed failure cannot be confirmed.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate f69b1f8a-2ba3-4553-8349-b1c3f6a69d87 c244b105 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate f69b1f8a-2ba3-4553-8349-b1c3f6a69d87 c244b105 dismissed
```

### 26. [MEDIUM] Missing Idempotency Guard

- **Repo / file**: `wine-cellar-app` → `public/js/app.js — post-auth boot wiring of sweepLegacyKeys() / initRestaurantPairingState() / initCellarAnalysisState()`
- **Fingerprint**: `c604810d` · run `f69b1f8a` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> app.js statically imports `sweepLegacyKeys`, `init as initRestaurantPairingState` and `init as initCellarAnalysisState` and calls them from the post-auth boot path. restaurantPairing/state.js documents init() as 'Idempotent — safe to call again after a cellar switch', but the boot path itself has no guard against being entered twice. app.js already carries an `appStarted` flag for a different purpose, and auth flows in this file can re-enter (token refresh, `handleAuthExpired`, the `cellars:changed` re-render path that already caused the cellarSwitcher closure bug). A second post-auth boot re-

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable · _source truncated_

> The shown loadUserContext block has no local guard, but the truncated source omits its callers and the implementations of the three functions, so re-entry and any harmful non-idempotent effect cannot be confirmed.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate f69b1f8a-2ba3-4553-8349-b1c3f6a69d87 c604810d accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate f69b1f8a-2ba3-4553-8349-b1c3f6a69d87 c604810d dismissed
```

### 27. [LOW] Gate Coverage Gap

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/lint/on-conflict.mjs + scripts/on-conflict-lint.mjs (unchanged) — hygiene diagnostic kinds`
- **Fingerprint**: `8db3a977` · run `66bdeaea` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The two new pragma-hygiene kinds (`duplicate-suppression`, `unknown-suppression-column`) are deliberately named outside the `unresolved-*` family so they do not gate under `--strict`, and the plan argues this is a decision. But combined with the close-out reality that `--strict` already exits 3 on a pre-existing `plans-ship.mjs` site and is therefore NOT a pass criterion, and that the standing test assertion only checks findings + `unresolved-conflict-key-nullability` + the diagnostic (kind,file) set, a malformed pragma (`@on-conflict-ok(): reason`, a selector naming an absent column, a duplic

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable · _source truncated_

> The supplied source truncates before pragma-hygiene emission and the CLI strict-gating logic, so it cannot confirm whether these diagnostic kinds are intentionally non-gating or leave malformed suppressions unprotected.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 66bdeaea-3c3c-430e-9c1e-100621c4cfb2 8db3a977 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 66bdeaea-3c3c-430e-9c1e-100621c4cfb2 8db3a977 dismissed
```

### 28. [LOW] Missing Error Handling

- **Repo / file**: `claude-engineering-skills` → `docs/plans/refactor-autofix-security.md §4 File-Level Plan step 0 (canonicalRepoRoot)`
- **Fingerprint**: `ebdc4c55` · run `2335eab9` · filed 2026-07-27
- **File changed since filed**: **yes — 3 commit(s)**

**Shadow (Claude Opus) claim:**

> Step 0 introduces `const canonicalRepoRoot = fs.realpathSync(repoRoot);` and justifies the absence of a try/catch with the assertion that it "cannot meaningfully fail here — applyFixes is always invoked with a real, existing directory (claudemd-lint.mjs derives it from process.cwd())". This is exactly the same 'the only current caller can't trigger it' reasoning the plan itself REJECTS one section earlier when arguing defect #2 must be fixed now because `applyFixes` is an exported library function whose path inputs are untrusted. The plan is internally inconsistent: repoRoot gets a trusted-cal

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence high · evidence code unavailable · _source truncated_

> The supplied source is truncated before §4 step 0, so the asserted `canonicalRepoRoot` code and its stated justification cannot be verified.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 2335eab9-c7e5-4fda-8ba2-fadabe105e09 ebdc4c55 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 2335eab9-c7e5-4fda-8ba2-fadabe105e09 ebdc4c55 dismissed
```

### 29. [LOW] Incomplete Test Specification / Silent Behaviour Change

- **Repo / file**: `claude-engineering-skills` → `docs/plans/refactor-autofix-security.md §6 Testing Strategy; §4 step 7`
- **Fingerprint**: `79b142b3` · run `2335eab9` · filed 2026-07-27
- **File changed since filed**: **yes — 3 commit(s)**

**Shadow (Claude Opus) claim:**

> The plan changes the write target from `path.join(repoRoot, filePath)` to `gate.canonical` (an absolute realpath) but §6 contains no assertion that the file written is the SAME file today's code writes for the ordinary, non-symlinked case. On macOS this is a real observable difference: `claudemd-lint.mjs` passes `process.cwd()`, and with step 0 now realpath'ing repoRoot, a repo under `/tmp` (→ `/private/tmp`) will have every write go to the `/private/...` spelling. That is almost certainly harmless, but combined with `atomicWriteFileSync`'s tmp-file-then-rename behaviour it changes which DIREC

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable · _source truncated_

> The supplied plan is truncated before §4 step 7 and §6, so it cannot establish the claimed missing assertion or assess whether any macOS alias-spelling change is observable in the implemented code.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 2335eab9-c7e5-4fda-8ba2-fadabe105e09 79b142b3 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 2335eab9-c7e5-4fda-8ba2-fadabe105e09 79b142b3 dismissed
```

### 30. [LOW] Silent Failure Mode

- **Repo / file**: `claude-engineering-skills` → `scripts/check-architecture-intent-drift.mjs (runArchitectureIntentDriftCheck)`
- **Fingerprint**: `2e90aeb9` · run `bfdb39aa` · filed 2026-07-27
- **File changed since filed**: no

**Shadow (Claude Opus) claim:**

> The doc side is defensively handled (fs.existsSync -> empty string -> fail loud), but the map side calls fs.readFileSync(domainMapPath) and JSON.parse with no guard. A missing or malformed .audit-loop/domain-map.json throws an unhandled ENOENT/SyntaxError out of main(), producing a raw Node stack trace and exit code 1 — indistinguishable, from an npm-run-check operator's perspective, from a genuine drift failure. The plan explicitly reasoned that 'JSON.parse throwing is a legitimate hard failure', but it did not distinguish that from the gate's own drift exit code.

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable

> The relevant source is unavailable, so the claimed unguarded map read/parse and its exit-code behavior cannot be verified.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate bfdb39aa-61de-40aa-85a3-8a40046f452b 2e90aeb9 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate bfdb39aa-61de-40aa-85a3-8a40046f452b 2e90aeb9 dismissed
```

### 31. [LOW] Coverage Loss Justified by Self-Assessment

- **Repo / file**: `wine-cellar-app` → `tests/unit/services/agent/agentContext.test.js, src/services/agent/agentContext.js`
- **Fingerprint**: `b6d99af3` · run `441eee38` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The string-form buildSystemPrompt was deleted along with its dedicated tests, justified by the claim that buildSystemPromptBlocks' own tests 'already cover the same behaviors ... so no coverage was lost'. No measurement backs that claim — the plan's own D1 mitigation for deleting a module's only test (show a green full suite before and after) is a much weaker check than it appears here, because the deleted tests were the only ones exercising the string-composition path and a green suite after their removal is guaranteed by construction. This surface also sits behind AGENT_ENABLED=false, so no

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable

> The provided test confirms coverage for buildSystemPromptBlocks only, but the referenced agentContext.js implementation and the alleged deleted string-form function are not available to verify its existence, removal, or reachability.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 441eee38-66b2-42b1-a2f3-ae4cd5dbdb95 b6d99af3 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 441eee38-66b2-42b1-a2f3-ae4cd5dbdb95 b6d99af3 dismissed
```

### 32. [LOW] Ratchet Baseline Silently Loosened

- **Repo / file**: `wine-cellar-app` → `tests/unit/contracts/_baselines/fileSizes.json, src/config/cellarZones.js`
- **Fingerprint**: `d4a7828e` · run `441eee38` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> Deleting the 22 preferredRowRange literals dropped cellarZones.js from 523 to 458 lines, and the change removed its entry from fileSizes.json entirely rather than re-baselining it at 458. Cluster C's stated ratchet semantics are 'no listed file may grow; no 89th may appear' — a file that falls below the 500-line threshold and is then delisted can grow back to 499 lines with nothing failing, and its next crossing of 500 registers as a brand-new violator rather than a regression. Removing the key is the weakest of the three available options (keep at 458, keep with a sub-threshold note, or delet

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence low · evidence code unavailable

> The supplied baseline confirms cellarZones.js is absent, but neither its current size nor the ratchet test/enforcement logic is provided, so the claimed regression gap cannot be verified.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 441eee38-66b2-42b1-a2f3-ae4cd5dbdb95 d4a7828e accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 441eee38-66b2-42b1-a2f3-ae4cd5dbdb95 d4a7828e dismissed
```

### 33. [LOW] Missing Error Handling

- **Repo / file**: `wine-cellar-app` → `src/server.js (B5) — startCleanup() idempotency and shutdown wiring`
- **Fingerprint**: `62bcee54` · run `d7cb96cf` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The plan specifies startCleanup() must be idempotent, .unref()ed, and stopped on shutdown, and §7 AC-5 restates this. Neither the transcript nor the surfaced code shows a test asserting the idempotency property (a second startCleanup() call is a no-op rather than creating a second timer). Because src/server.js is edited by two different clusters (B5 now, E3 later, explicitly noted as the one exception to §11's disjoint-file rule), a future edit that adds a second boot path — or a test harness that boots the server twice in one process — would silently create duplicate sweepers, each independen

**GPT-5.6 independent judgement:** unclear · worth fixing: no · confidence high · evidence code unavailable

> server.js calls startPairingChatCleanup() once at boot and stopPairingChatCleanup() during shutdown, but the imported cleanup module (where idempotency and unref behavior reside) is not provided.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate d7cb96cf-2275-48fb-918b-97a913dbfc09 62bcee54 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate d7cb96cf-2275-48fb-918b-97a913dbfc09 62bcee54 dismissed
```

### 34. [HIGH] Data Integrity / Incomplete Change

- **Repo / file**: `wine-cellar-app` → `src/services/pairing/pairingChatContext.js + src/server.js (B4/B5)`
- **Fingerprint**: `fd33a4e4` · run `d7cb96cf` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The plan's B4 acceptance criterion (§7 AC-5) requires pairingChatContext to gain an eager sweeper, a 500-entry LRU bound, and removal of setStore(). GPT round-1 H12 observed that MAX_CHAT_TURNS = 20 is declared but never applied by appendChatTurn(), i.e. the module advertises a bound it does not enforce. That finding was raised once in round 1 and does not reappear in round 2, with no visible ruling in the transcript. Unbounded per-context turn growth is the same memory-leak class the cluster exists to fix: wiring startCleanup() bounds the NUMBER of contexts but not the SIZE of each one, so a

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> appendChatTurn() enforces MAX_CHAT_TURNS by trimming chatHistory to MAX_CHAT_TURNS * 2 messages after every append, while the module also includes the LRU capacity eviction and eager cleanup timer described.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate d7cb96cf-2275-48fb-918b-97a913dbfc09 fd33a4e4 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate d7cb96cf-2275-48fb-918b-97a913dbfc09 fd33a4e4 dismissed
```

### 35. [HIGH] Incomplete Fix / Tenant Isolation

- **Repo / file**: `wine-cellar-app` → `public/js/api/base.js — clearAuthState() and safeStorage-backed ACTIVE_CELLAR_KEY`
- **Fingerprint**: `df2dfeac` · run `f69b1f8a` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> clearAllScopes() is invoked from clearAuthState() via `await import('../shared/cellarStorage.js')`. If that dynamic import rejects — offline, chunk 404 after a deploy, or a service-worker cache miss for the module — the await throws and clearAuthState() propagates the rejection AFTER having already removed AUTH_TOKEN_KEY/ACTIVE_CELLAR_KEY. The auth keys are gone but every `wc:<cellarId>:*` namespace survives, and the caller's sign-out flow sees a rejected promise. Worse, ACTIVE_CELLAR_KEY has already been cleared, so a later clearCellarScope() has no cellar id to work from. Sign-out on a flaky

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> clearAuthState wraps the awaited dynamic import and clearAllScopes call in try/catch, so an import failure is logged and does not reject the sign-out flow, although scoped keys cannot be cleared until the module is available.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate f69b1f8a-2ba3-4553-8349-b1c3f6a69d87 df2dfeac accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate f69b1f8a-2ba3-4553-8349-b1c3f6a69d87 df2dfeac dismissed
```

### 36. [MEDIUM] Missing Error Handling / Ordering

- **Repo / file**: `claude-engineering-skills` → `scripts/regenerate-skill-copies.mjs — removeStaleGithubSkills() + main() ordering`
- **Fingerprint**: `ff5c32d5` · run `47623e0b` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> removeStaleGithubSkills() runs as a required precondition BEFORE any .claude/skills/ copy, but it runs before loadSkillsOrDie() has validated the authoritative source tree and before enumerateSkillFiles() has validated each skill's allowlist. So a run against a repo with a missing/empty skills/ tree, or a skill containing a disallowed file, can permanently rmSync -r the .github/skills/ tree and THEN exit 2 with an allowlist violation — having destroyed the deprecated surface while writing nothing. GPT raised the inverse ordering concern (H1/M2) and Claude deferred it as 'pre-existing architect

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> main() calls loadSkillsOrDie() and validateAllSkillsOrDie(skills) before removeStaleGithubSkills(), so missing/empty sources and allowlist violations exit before .github/skills can be removed.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 47623e0b-8a71-4445-af26-7f19732c6874 ff5c32d5 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 47623e0b-8a71-4445-af26-7f19732c6874 ff5c32d5 dismissed
```

### 37. [MEDIUM] Silent Coverage Loss / Missing Guard

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/audit/adjacency-detector.mjs — parseHunkTargets null-path skip`
- **Fingerprint**: `36569d7f` · run `a46088f6` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> `parseHunkTargets` now does `if (newPath === null) continue;` for pathDecodeFailed sections, with a comment explaining it must not ride on `SOURCE_EXT_RE.test(null)` coercion. That guard is correct but SILENT: adjacency analysis simply pretends the file was never changed. Unlike `buildDiffPathMap`, which converts the same condition into a named `undecodable_diff_header` and a loud stderr line, and unlike this module's own documented discipline (INCOMPLETENESS_KINDS / `incompleteness(kind, scope, detail)`, imported at the top of the file precisely to report analysis gaps), the skip emits nothin

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code · _source truncated_

> `parseHunkTargets` counts null-path sections, and `runAdjacencyAnalysis` emits a `PARSE_FAILURE` incompleteness record explicitly stating affected files were not enumerated.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate a46088f6-8421-4e58-82d0-aa1487455e33 36569d7f accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate a46088f6-8421-4e58-82d0-aa1487455e33 36569d7f dismissed
```

### 38. [MEDIUM] Fail-Open Degradation / Availability Regression

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/audit/diff-path-map.mjs — buildDiffPathMap undecodable_diff_header branch`
- **Fingerprint**: `abf8d907` · run `a46088f6` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The undecodable check is whole-diff, not per-file: `sections.filter((s) => s.pathDecodeFailed)` returning ≥1 aborts the ENTIRE map with `{kind:'invalid', reason:'undecodable_diff_header'}`, discarding every other perfectly decodable section in the diff. One pathological filename in a 200-file PR therefore kills the tiered path for all 200. The plan's R2 accepted this ("matches the discovery_map_exceeds_budget precedent"), but the precedents are not analogous: over-budget is a property of the diff AS A WHOLE (no subset is safely auditable without changing recall semantics), whereas an undecodab

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence confirmed in code

> The whole-map invalidation is deliberate and explicitly falls back to the legacy path, which can audit the undecodable file rather than silently omitting it or losing audit coverage.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate a46088f6-8421-4e58-82d0-aa1487455e33 abf8d907 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate a46088f6-8421-4e58-82d0-aa1487455e33 abf8d907 dismissed
```

### 39. [MEDIUM] Unenforced Invariant / Leaky Abstraction

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/audit/diff-path-map.mjs — buildDiffPathMap entries vs renderDiffPathTable`
- **Fingerprint**: `52461c38` · run `65f85691` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> GPT's M4 identified that the raw-vs-encoded path invariant is convention-only. The complementary structural gap neither model articulated is that `entries` exposes ambiguously-typed path fields: a consumer reading `entry.oldPath`/`entry.newPath` cannot tell from the shape whether the value is display-safe (JSON.stringify-encoded) or raw. The encoding decision lives in the renderer, so the data model itself carries no discriminator. This is the mechanism by which M4's risk materialises, and it is fixable in the data model rather than by documentation.

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> `entries` deliberately carries raw semantic paths for hydration while the sole prompt-table renderer JSON-encodes them at the display boundary, so no current consumer requires or mistakes encoded paths.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 65f85691-5816-48a1-8e1b-400fec8ff833 52461c38 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 65f85691-5816-48a1-8e1b-400fec8ff833 52461c38 dismissed
```

### 40. [MEDIUM] Logic Error / Incomplete Validation

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/claudemd/autofix.mjs — `normalizeLineNumber` accepts canonical decimal strings`
- **Fingerprint**: `ae691e4c` · run `4851afed` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> `normalizeLineNumber` deliberately accepts string line numbers matching `/^[1-9]\d*$/` so that a `'2'` duplicate dedups against a numeric `2` (round-1 finding 817bc3d4). But the group sort comparator, the bounds check, and the dedup check all now read the NORMALIZED value, while `skipped[]`/`applied[]` entries report the RAW `finding.line`. That means two findings for the same physical line can be reported with different `line` values (`2` and `'2'`) in the caller's output, and — more importantly — the accepted string form silently widens the trusted input contract for a security-hardening fun

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> Canonical positive-decimal strings are explicitly supported and normalized for all operational uses; retaining the raw input value in reporting is an intentional observability choice, not a security-relevant widening or duplicate-processing defect.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 4851afed-5723-44d0-a7f6-857c1ac4da06 ae691e4c accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 4851afed-5723-44d0-a7f6-857c1ac4da06 ae691e4c dismissed
```

### 41. [MEDIUM] Missing Requirement / Incomplete Fix

- **Repo / file**: `claude-engineering-skills` → `docs/plans/refactor-autofix-security.md §4 File-Level Plan step 5/7; §6 Testing Strategy`
- **Fingerprint**: `f73b1794` · run `2335eab9` · filed 2026-07-27
- **File changed since filed**: **yes — 3 commit(s)**

**Shadow (Claude Opus) claim:**

> The plan's read step (5) reads `gate.canonical` — an ABSOLUTE realpath'd path — but §4 does not state that the existing `standaloneLink` matching, `applied`/`skipped` reporting, and the `atomicWriteFileSync` target are all still consistent with the fact that `content` now comes from a DIFFERENT path string than today's `path.join(repoRoot, filePath)`. Concretely: `resolveAndClassify` returns the realpath'd target, so for a symlinked in-repo alias the write now lands on the symlink TARGET rather than (as today, via file-io.mjs's own symlink-following) the same place — behaviourally equivalent —

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code · _source truncated_

> The plan explicitly specifies grouping by canonical only internally, retaining original `finding.file` for applied/skipped reporting, and using `gate.canonical` for both read and `atomicWriteFileSync`.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 2335eab9-c7e5-4fda-8ba2-fadabe105e09 f73b1794 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 2335eab9-c7e5-4fda-8ba2-fadabe105e09 f73b1794 dismissed
```

### 42. [MEDIUM] Missing Error Handling / Inconsistent Availability Policy

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/store/arch/refresh-runs.mjs — heartbeatRefreshRun vs abortRefreshRun cloud-disabled contract`
- **Fingerprint**: `72c419c4` · run `9bbbe893` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The three D1-widened functions now return three different things when `isCloudEnabled()` is false: heartbeatRefreshRun returns `true` ("still running"), abortRefreshRun returns `{aborted:false}`, getRefreshRun falls through to its own not-found path. heartbeatRefreshRun's `true` is documented as "never interferes with cancellation", but this makes a cloud-disabled state indistinguishable from a verified-running state at the one call site (runWithHeartbeat) whose entire purpose is to distinguish those. The doc comment defends this as "not currently reachable" because main() exits earlier — a re

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence confirmed in code

> The differing cloud-disabled values are intentional, type-appropriate contracts, and the source explicitly establishes this heartbeat path as unreachable after main()’s cloud-disabled exit.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 9bbbe893-2fc9-418e-b9c7-0a88fa7c91ba 72c419c4 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 9bbbe893-2fc9-418e-b9c7-0a88fa7c91ba 72c419c4 dismissed
```

### 43. [MEDIUM] Inconsistent Degradation Semantics

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/store/arch/refresh-runs.mjs (heartbeatRefreshRun) vs scripts/lib/store/arch/imports.mjs (markImportGraphPopu`
- **Fingerprint**: `dead601b` · run `90157ab9` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The SFG1 fix made heartbeatRefreshRun return `true` when cloud is disabled — semantically 'still running, never interfere'. markImportGraphPopulated returns `{populated:false}` in the identical cloud-disabled condition — semantically 'the write did not land', which refresh.mjs surfaces as a WARNING. In the same cloud-disabled process the heartbeat reports health while the import-graph writer reports failure. Shadow finding SFG2-3 named this; the resolutions list records no disposition. Additionally heartbeatRefreshRun's `true` conflates 'cloud off' with 'confirmed running' — the boolean has no

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> heartbeatRefreshRun intentionally returns true only to avoid treating cloud-disabled operation as cancellation, while write-result APIs honestly report no persistence; its comment also states the path is defensively unreachable because main exits first.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 90157ab9-c4a5-448d-baf7-9868996b4148 dead601b accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 90157ab9-c4a5-448d-baf7-9868996b4148 dead601b dismissed
```

### 44. [MEDIUM] Contract Inconsistency

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/store/arch/imports.mjs (markImportGraphPopulated) vs scripts/lib/store/arch/refresh-runs.mjs (getRefreshRun,`
- **Fingerprint**: `7b4952b5` · run `90157ab9` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The PR converged on 'a missing refreshId/repoId is a loud programmer error' for getImportGraphPopulated and getRefreshRun (both now throw), but markImportGraphPopulated — widened in the same PR, on the same refresh_runs table, with the same new repoId parameter — has no such guard. It has no `if (!refreshId \|\| !repoId)` check at all; a caller that omits repoId simply produces a WHERE predicate matching 0 rows and returns `{populated:false}`, which refresh.mjs logs as a benign WARNING. Shadow finding SFG2-1 raised exactly this and the transcript's claude_resolutions list contains no entry accep

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> markImportGraphPopulated now explicitly throws when either refreshId or repoId is missing, so the claimed silent zero-row update path is not reachable for omitted repoId.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 90157ab9-c4a5-448d-baf7-9868996b4148 7b4952b5 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 90157ab9-c4a5-448d-baf7-9868996b4148 7b4952b5 dismissed
```

### 45. [MEDIUM] Incorrect Parser Semantics

- **Repo / file**: `wine-cellar-app` → `src/services/shared/flagFromEnv.js (new) — consumed by src/server.js, scripts/build-sw-manifest.mjs, src/middleware/inje`
- **Fingerprint**: `21f23d86` · run `3d955dfd` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> `flagFromEnv` returns `true` for ANY defined value that is not exactly `'0'`, `'false'`, or `'off'` — including the empty string. In Docker, `ARG PAIRING_LAB_REACT_ENABLED` re-declared as `ENV` with no value, or a Railway service variable created-but-blank, both yield `''`, which this parser reads as ENABLED. That is the opposite of the intended default and it silently flips the precache decision, the injected app config, AND the boot coherence gate's notion of 'runtime value' in one go. The plan's whole Decision E rationale was 'one parser so the contexts cannot diverge' — but a single parser

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> The implementation explicitly treats `undefined` and `''` as unset and returns `fallback`, so blank Docker/Railway variables do not enable the flag.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 3d955dfd-8727-4f17-a1af-9fe925b5d7b1 21f23d86 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 3d955dfd-8727-4f17-a1af-9fe925b5d7b1 21f23d86 dismissed
```

### 46. [MEDIUM] Weakened Test Contract

- **Repo / file**: `wine-cellar-app` → `tests/unit/contracts/findBestZoneRetired.test.js, tests/unit/contracts/classifierSeamSingleSource.test.js, src/config/ce`
- **Fingerprint**: `e4f6403b` · run `441eee38` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The D2 approval for deleting ZONE_PRIORITY_ORDER rested on findBestZoneRetired.test.js already asserting the symbol has zero consumers. The same commit then edits that test's detection regex to drop the now-deleted symbol. The evidence that justified the deletion and the artefact that enforced it are mutated in one change, so nothing now prevents ZONE_PRIORITY_ORDER (or an equivalently-named priority constant) from being reintroduced into cellarZones.js. Per MIGRATION_INVARIANTS §2.5 ('dropping a table means grepping the world' — the dropped token joins a contract test forever), the deleted to

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> The supplied test explicitly scans all comment-stripped src files and fails if ZONE_PRIORITY_ORDER appears, so the claimed removal of its enforcement regex is contradicted by the current code.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 441eee38-66b2-42b1-a2f3-ae4cd5dbdb95 e4f6403b accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 441eee38-66b2-42b1-a2f3-ae4cd5dbdb95 e4f6403b dismissed
```

### 47. [MEDIUM] Self-Exempting Governance

- **Repo / file**: `wine-cellar-app` → `tests/unit/contracts/fileSizeBudgetRatchet.test.js + _baselines/fileSizes.json + appJsSizeRatchet.test.js`
- **Fingerprint**: `62b105bf` · run `5ca09e1b` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The oversized-file baseline pins 88 paths to their current line counts and forbids growth, and app.js is pinned at 2435. But this same PR adds six new test files and four baseline JSON files, and Clusters 1–2 already modified app.js (sweepLegacyKeys + init() wiring + toast), cellarStorage.js, cellarSwitcher.js and pairingChatContext.js. Nothing in the transcript records whether the baselines were measured BEFORE or AFTER those edits, nor whether tests/ and _baselines/*.json are excluded from the file-size scan. The plan flags this exact hazard in §5 ('Ratchet baselines drift between authoring

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> The scanner only traverses public/js, src, and web, so tests and baseline JSON files are excluded; whether the baseline was generated before or after unrelated edits is not a defect demonstrable from this code.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 5ca09e1b-4600-4a5f-8115-760493b2710c 62b105bf accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 5ca09e1b-4600-4a5f-8115-760493b2710c 62b105bf dismissed
```

### 48. [MEDIUM] Data Integrity / Missing Invalidation

- **Repo / file**: `wine-cellar-app` → `public/js/grid.js — recentlyPlacedCache + cellarStorage-backed placement enumeration`
- **Fingerprint**: `87bf0fe7` · run `f69b1f8a` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> `recentlyPlacedCache` is a module-level `Set\|null` documented as 'built from sessionStorage once per render'. The cellar-scoped facade now supplies the underlying keys, but the cache itself carries no cellar identity and no invalidation hook. The plan's Decision A explicitly relies on `window.location.reload()` to re-instantiate modules after a switch — that holds for cellarSwitcher's path, but cellarAnalysis/state.js's own comment confirms the reload is the ONLY mechanism keeping per-cellar module state fresh. Any future non-reloading cellar change (or a soft switch introduced by the React is

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence confirmed in code · _source truncated_

> The cache is rebuilt on each `renderStorageAreas()` from active-cellar-scoped storage, and the alleged non-reloading cellar-switch path is hypothetical rather than behavior present in this source.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate f69b1f8a-2ba3-4553-8349-b1c3f6a69d87 87bf0fe7 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate f69b1f8a-2ba3-4553-8349-b1c3f6a69d87 87bf0fe7 dismissed
```

### 49. [MEDIUM] Data Integrity / Race Condition

- **Repo / file**: `wine-cellar-app` → `src/services/shared/undoManager.js — createBatchUndoToken() stamping loop`
- **Fingerprint**: `9152746b` · run `adff5e14` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The stamping loop overwrites each member row's `expires_at` with a shared, LATER value computed at stamp time (`Date.now() + 30s`). Combined with the migration's unique partial index on `(batch_id, batch_position)` this is fine for a single batch, but the stamp UPDATE's WHERE clause is only `id = $4 AND cellar_id = $5` — it does NOT require `batch_id IS NULL`, `consumed_at IS NULL`, or `expires_at > NOW()`. A row that was already consumed, already expired, or already stamped into another batch would be silently re-stamped and re-extended, and `rowCount` would still be 1, so the write-verificat

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> The stamp UPDATE already requires `batch_id IS NULL`, `consumed_at IS NULL`, and `expires_at > NOW()`, and throws on any row-count mismatch, so stale, consumed, expired, or foreign-batch rows cannot be silently restamped.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate adff5e14-4306-4408-9b23-3ffed0bf9a69 9152746b accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate adff5e14-4306-4408-9b23-3ffed0bf9a69 9152746b dismissed
```

### 50. [MEDIUM] Missing Test Coverage / False Assurance

- **Repo / file**: `wine-cellar-app` → `tests/integration/undoBatchClaim.test.js — first test's claim query`
- **Fingerprint**: `f6ad2f53` · run `adff5e14` · filed 2026-07-27
- **File changed since filed**: **yes — 2 commit(s)**

**Shadow (Claude Opus) claim:**

> The headline integration test ("CTE-wrapped claim query parses + executes with LIFO order") does NOT execute the production claim predicate. `undoBatch()` claims with `WHERE batch_id = $1 AND cellar_id = $2 AND user_id = $3 ...`, but the test's query omits `batch_id` entirely and claims by `cellar_id`/`user_id` only. It is a hand-copied approximation of the production SQL, not the production SQL. The suite therefore proves that *a* CTE parses, not that `undoBatch`'s actual statement does — which is precisely the failure mode (invalid SQL reaching production) that round-1 H1 and this whole inte

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> The first test's CTE includes `WHERE batch_id = $1 AND cellar_id = $2 AND user_id = $3` with `[batchId, testCellarId, userId]`, matching the claimed production predicate shape.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate adff5e14-4306-4408-9b23-3ffed0bf9a69 f6ad2f53 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate adff5e14-4306-4408-9b23-3ffed0bf9a69 f6ad2f53 dismissed
```

### 51. [LOW] Test Design / False Assurance

- **Repo / file**: `claude-engineering-skills` → `tests/install-surface-scope.test.mjs, tests/sync-stale-skill-detection.test.mjs`
- **Fingerprint**: `544dc3d9` · run `47623e0b` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> A large share of the new coverage is source-text regex assertion against install-skills.mjs (`assert.match(SRC, /case '--keep-github-skills':([\s\S]*?)break;/)`, brace-counting guard extraction, `doesNotMatch(SRC, /\bresolveSkillTargets\(/)`). GPT flagged this style (L1, M7) and Claude deferred it as pre-existing convention — a fair point for the pre-existing authoritativeScopesFor tests, but the NEW blocks are new debt in the same style, and this exact technique already produced one false-assurance bug in this very PR (R2-M1: a regex that terminated at the parameter list and asserted nothing)

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence confirmed in code

> The cited source assertions are supplemented by real CLI spawn tests for both rejection paths, and static assertions intentionally pin structural invariants; the alleged prior false-assurance failure is not evidenced by this source.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 47623e0b-8a71-4445-af26-7f19732c6874 544dc3d9 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 47623e0b-8a71-4445-af26-7f19732c6874 544dc3d9 dismissed
```

### 52. [LOW] Contract Inconsistency

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/install/surface-paths.mjs — resolveSkillTargets()`
- **Fingerprint**: `4ed6a2f9` · run `47623e0b` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The unrecognized-surface validation added for Gemini G1 is placed AFTER the two target-pushing branches rather than at the top with the 'copilot' guard. Functionally equivalent today, but it means the function does allocation work and then throws, and — more importantly — the validation is now split across two non-adjacent locations in the body, so a future contributor adding a new surface branch (e.g. 'cursor') can easily add the branch above and forget the allowlist below, silently reintroducing the exact fall-through. The JSDoc @param still documents `'claude' \| 'copilot' \| 'agents' \| 'both

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> The supplied code already co-locates the unrecognized-surface guard immediately after the copilot guard and before allocation/target branches; its JSDoc also documents the supported values.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 47623e0b-8a71-4445-af26-7f19732c6874 4ed6a2f9 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 47623e0b-8a71-4445-af26-7f19732c6874 4ed6a2f9 dismissed
```

### 53. [LOW] Interface Inconsistency

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/import-binding.mjs — export surface after audit-driven growth`
- **Fingerprint**: `334a2431` · run `66bdeaea` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The module now exports five functions where the audited plan specified 'exactly three', and the two additions are three-valued/discriminated variants sitting beside their own boolean projections (`resolveNamedImportBinding` vs `resolvesToNamedImport`, `classifyCallbackWrapper` vs `findSyncCallbackWrapper`). Notably `resolvesToModuleBinding` did NOT receive the same treatment — it still collapses 'shadowed' and 'unresolvable' to `false` with no discriminated counterpart, even though defect 2d's module-object path is exactly where a guard would want to report 'I could not determine what `fs` is'

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence confirmed in code

> The source intentionally exposes discriminated APIs only where callers need that distinction, while `resolvesToModuleBinding` correctly treats both non-matches as unsafe; an alleged external export-count plan is not a behavioral defect.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 66bdeaea-3c3c-430e-9c1e-100621c4cfb2 334a2431 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 66bdeaea-3c3c-430e-9c1e-100621c4cfb2 334a2431 dismissed
```

### 54. [LOW] Coupling / Layering

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/audit/tiered-shadow-contract-digest.mjs — SEMANTICS_REGIONS name coupling`
- **Fingerprint**: `8431f5b5` · run `a46088f6` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> `SEMANTICS_REGIONS[EVIDENCE_TRIAGE_FILE]` now pins three function NAMES in `evidence-triage.mjs` (`findQuoteLineRangesInHunk`, `selectAnchoredMatch`, `resolveAnchorLocation`), and `extractNamedRegions` throws when a name is absent. This PR is the second time in two days that a refactor of evidence-triage.mjs required a coordinated edit here (the plan's own §4.5 and R5 enumerate the coupling, and the mutation test in tests/tiered-shadow-summary.test.mjs had to be retargeted from a deleted function's literal return line to a different function's push line). The guard is valuable, but the couplin

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence confirmed in code

> The name coupling and missing-name failure are deliberate, documented fail-loud contract behavior that ensures renamed or removed semantics-bearing functions require an explicit region update and epoch bump.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate a46088f6-8421-4e58-82d0-aa1487455e33 8431f5b5 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate a46088f6-8421-4e58-82d0-aa1487455e33 8431f5b5 dismissed
```

### 55. [LOW] Observability Regression

- **Repo / file**: `claude-engineering-skills` → `scripts/symbol-index/refresh-subprocess.mjs — describeExtractStall`
- **Fingerprint**: `0a6e553b` · run `0ecf52a3` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> `describeExtractStall` reduces the wedge diagnostic to three strings and discards the one piece of non-sensitive information that survives the redaction rule and materially bounds an operator's search: the count of progress records seen before the stall (i.e. how many files into the walk it wedged) and, in the bare-tick case, whether any file had been admitted at all. The plan explicitly relies on "the record count bound[ing] the search" (§2 D3) as the mitigation for withholding the name, but the implemented helper never surfaces that count, so the stated mitigation is not actually delivered t

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> Although the helper returns only the stall description, the timeout log explicitly includes `(err.cause?.records ?? []).length` as the progress-record count, including for the bare-tick case, delivering the stated search bound.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 0ecf52a3-c680-4b11-88db-c6bbfdcabb4a 0a6e553b accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 0ecf52a3-c680-4b11-88db-c6bbfdcabb4a 0a6e553b dismissed
```

### 56. [LOW] Incomplete DRY Fix

- **Repo / file**: `claude-engineering-skills` → `scripts/symbol-index/drift.mjs — PRAGMA_CANDIDATE_POOL_CAP call sites`
- **Fingerprint**: `28bb874a` · run `0ecf52a3` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> Phase 3's stated acceptance criterion is that the cap is single-sourced across all four sites, and `isPragmaPoolCapped(totalCount, cap = PRAGMA_CANDIDATE_POOL_CAP)` was introduced with an injectable `cap` parameter so tests can drive a custom cap. But the query `limit:` argument and the two operator-facing message interpolations still reference the module constant directly, not the predicate's effective cap. A test that calls `isPragmaPoolCapped(n, 5000)` therefore proves nothing about the query limit, and the default-parameter seam creates a second place a cap value can come from — the exact

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> The predicate no longer accepts an injectable cap, and its comparison, query limit, and operator messages all reference the same PRAGMA_CANDIDATE_POOL_CAP identifier.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 0ecf52a3-c680-4b11-88db-c6bbfdcabb4a 28bb874a accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 0ecf52a3-c680-4b11-88db-c6bbfdcabb4a 28bb874a dismissed
```

### 57. [LOW] Incomplete Rollback/Verification Plan

- **Repo / file**: `claude-engineering-skills` → `docs/plans/refactor-evidence-integrity.md §7b Implementation Phases / §4.5`
- **Fingerprint**: `a5b7f68a` · run `c065479c` · filed 2026-07-27
- **File changed since filed**: **yes — 2 commit(s)**

**Shadow (Claude Opus) claim:**

> §9 states 'npm run check — expected to fire the contract-digest guard until §4.5 lands, which is the guard working.' Phases 3-4 change findQuoteLineInHunk/resolveAnchorLocation and Phase 5 fixes the digest, so the repo is intentionally red across a multi-phase window. The plan does not state whether Phases 3-5 must land in one commit (§4.5 says 'in the same commit' only about the three §4.5 constants, not about Phases 3-4) nor how the pre-push hook is to be handled during that window. AGENTS.md's own doctrine is that a guard which cries wolf gets bypassed with --no-verify.

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code · _source truncated_

> The plan’s current status explicitly says Complete and implemented, so its temporary phase-order check failure does not describe a live repository defect or an actionable rollback gap.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate c065479c-0827-42f0-9f58-32b084e0f0b5 a5b7f68a accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate c065479c-0827-42f0-9f58-32b084e0f0b5 a5b7f68a dismissed
```

### 58. [LOW] Test Gap

- **Repo / file**: `claude-engineering-skills` → `tests/claudemd/autofix.test.mjs — cross-alias dedup test`
- **Fingerprint**: `caf64562` · run `4851afed` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The cross-alias dedup test asserts one `applied` + one `skipped` + one line removed, and its comment claims this "proves the grouping key is gate.canonical ... not raw finding.file". It does not: with raw-`file` grouping, group A (`AGENTS.md`) would splice line 2 and write, then group B (`ALIAS.md`) would independently READ the already-shortened file, find line 2 no longer exists or is a different line, and could produce `applied.length === 2` OR a skip with a different reason — the assertion happens to distinguish these today only because the fixture's line 2 is the last content line. The gen

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> The test comment explicitly acknowledges that this fixture alone cannot distinguish canonical grouping from raw-file grouping, so the finding's claim that it asserts such proof is contradicted by the source.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 4851afed-5723-44d0-a7f6-857c1ac4da06 caf64562 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 4851afed-5723-44d0-a7f6-857c1ac4da06 caf64562 dismissed
```

### 59. [LOW] Deferral Risk / Cross-Cluster Dependency

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/store/arch/imports.mjs (recordSymbolFileImports, copyForwardImports)`
- **Fingerprint**: `de8f83f3` · run `90157ab9` · filed 2026-07-27
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> GPT raised the input-cardinality count bug in recordSymbolFileImports (rounds 5 H1/M1, 6 H1) and Claude deferred it to Cluster E with a forward-note. This is a defensible sequencing call, but the function's own JSDoc in the current file state still reads '@returns count of DISTINCT edges persisted' while the body does `inserted += payload.length` — an attempted count. The PR touched this file (widening markImportGraphPopulated/getImportGraphPopulated) and left a documented-contract violation in place with no in-file marker tying it to the Cluster E deferral. Nothing in the file records that th

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> recordSymbolFileImports now adds result.rowCount rather than payload.length, and its in-file D5 comment explicitly documents the prior attempted-count issue and why the implementation changed.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 90157ab9-c4a5-448d-baf7-9868996b4148 de8f83f3 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 90157ab9-c4a5-448d-baf7-9868996b4148 de8f83f3 dismissed
```

### 60. [LOW] Incomplete Refactor / Stale Comment

- **Repo / file**: `claude-engineering-skills` → `scripts/lib/store/arch/coverage.mjs (copyForwardCoverage docstring)`
- **Fingerprint**: `b909eb73` · run `bfdb39aa` · filed 2026-07-27
- **File changed since filed**: no

**Shadow (Claude Opus) claim:**

> The docstring still says "this asymmetry is exactly what observed-deps.mjs's `CoverageSchema` cross-field check now rejects". After item 2 the schema lives in scripts/lib/observed-deps-contracts.mjs and observed-deps.mjs is explicitly no longer its owner. The import at the top of this same file was updated; the prose reference pointing readers at the old owner was not. This is the same class of stale-ownership doc claim that GPT R2-M8 caught in docs/architecture-intent.md and Claude fixed there — it was simply not swept for elsewhere.

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> The file still imports `CoverageSchema` from `../../observed-deps.mjs`, so its docstring reference matches the current source rather than a stale moved owner.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate bfdb39aa-61de-40aa-85a3-8a40046f452b b909eb73 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate bfdb39aa-61de-40aa-85a3-8a40046f452b b909eb73 dismissed
```

### 61. [LOW] Ratchet Enforcement Gap

- **Repo / file**: `wine-cellar-app` → `tests/unit/contracts/clientStorageFacadeRatchet.test.js + public/js/api/base.js`
- **Fingerprint**: `a2cb5d31` · run `3d955dfd` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The client-storage ratchet exempts `public/js/utils.js` (the `safeStorage` definition) and baselines `safeStorage.{get,set,remove}(` call counts per path to close the bypass. But `public/js/api/base.js` — which the ratchet must baseline, since it makes six+ `safeStorage` calls including the isolation-critical `active_cellar_id` — is itself the module `cellarStorage.js` imports `getActiveCellarId` from. A baseline that merely freezes base.js's call count at today's number permanently blesses the unscoped `active_cellar_id` handling (G1) as acceptable, and the accompanying `justification` string

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence confirmed in code

> The test explicitly defines a deliberately partial, count-ratcheting migration: baseline entries preserve existing safeStorage calls while preventing new or increased callers, so freezing base.js’s current calls is intentional rather than a gap.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 3d955dfd-8727-4f17-a1af-9fe925b5d7b1 a2cb5d31 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 3d955dfd-8727-4f17-a1af-9fe925b5d7b1 a2cb5d31 dismissed
```

### 62. [LOW] Grandfather Exception Without Growth Bound

- **Repo / file**: `wine-cellar-app` → `tests/unit/contracts/reactSliceOneInOneOut.test.js`
- **Fingerprint**: `9e1afeb4` · run `5ca09e1b` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The policy ratchet depends on two hand-maintained constants inside the test: SLICE_MAP ({'pairing-lab': 'public/js/pairingLab'}) and GRANDFATHERED (one entry for pairing-lab, self-clearing when the legacy dir disappears). The plan requires the grandfather list be non-growing, but a developer adding web/<new-slice>/ can satisfy the test by adding BOTH a SLICE_MAP entry and — if the non-growth assertion is only on GRANDFATHERED count and not enforced against SLICE_MAP additions paired with an existing legacy dir — route around it. More concretely, nothing pins SLICE_MAP itself: mapping a new sli

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> A new mapped slice with an existing mapped legacy path fails unless grandfathered, and adding a second grandfathered entry fails the explicit <=1 bound.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 5ca09e1b-4600-4a5f-8115-760493b2710c 9e1afeb4 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate 5ca09e1b-4600-4a5f-8115-760493b2710c 9e1afeb4 dismissed
```

### 63. [LOW] Incomplete Migration / Dead Contract

- **Repo / file**: `wine-cellar-app` → `public/js/cellarAnalysis/state.js — cellar-revision:<cellarId> keys left unswept`
- **Fingerprint**: `c5300134` · run `f69b1f8a` · filed 2026-07-28
- **File changed since filed**: **yes — 1 commit(s)**

**Shadow (Claude Opus) claim:**

> The file documents that `cellar-revision:<cellarId>` is deliberately not routed through cellarStorage because it is keyed by an explicit cellarId parameter. That reasoning is sound for isolation, but it leaves an unbounded, never-swept key family: `_revisionByCellar` grows one durable key per cellar ever visited, and neither sweepLegacyKeys() (its eight enumerated families do not include this prefix) nor clearAllScopes() (which removes only `wc:` keys) will ever remove them. On sign-out these survive, and they accumulate forever across cellar membership changes.

**GPT-5.6 independent judgement:** not-a-defect · worth fixing: no · confidence high · evidence contradicted by code

> The file provides clearCellarRevision(cellarId), including a no-argument path that removes all tracked durable revision keys, explicitly intended for logout or cellar removal, so the claim that this family is never removable is false.

**Your decision:** ☐ accept ☐ dismiss — _notes:_

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate f69b1f8a-2ba3-4553-8349-b1c3f6a69d87 c5300134 accepted
```

```bash
node scripts/cross-skill.mjs final-review-stats adjudicate f69b1f8a-2ba3-4553-8349-b1c3f6a69d87 c5300134 dismissed
```

