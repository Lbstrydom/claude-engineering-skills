# Plan: Out-of-diff audit noise — a pre-existing tag (8a) and changed-chunk scoping (1c)

- **Date**: 2026-11-12
- **Status**: In progress — 8a and the 1c mechanism are built (1c is OFF by default); the recall campaign below has not run, so 1c stays off until it does.
- **Author**: Claude + Louis Strydom
- **Mode**: campaign
- **Scope**: backend (audit pipeline + pre-push gate library)
- **Stack**: `js-ts`
- **Target domain(s)**: `audit-orchestration`, `shared-lib`
- **Source**: `docs/research/consumer-feedback-2026-11-11.md` items 1c (AIO) and 8a (Anthropic code-review write-up); design notes from `docs/plans/prepush-gate-consumer-feedback-theme1.md` §Out of Scope (rounds 1 notes H3, H6).

---

## 1. Context Summary

**The defect (verified 2026-11-11).** AIO #109's first pre-push audit returned 17 findings; 15 were about code the push did not change (the diff was 1 line in `en.ts`, 1 in `types.ts`, 6 in `styles.css`). `buildAuditUnits` ([code-analysis.mjs](../../scripts/lib/code-analysis.mjs)) splits a file over the unit budget into function-boundary chunks and the map-reduce scheduler sends **every** chunk to the model without consulting the diff. The model reviews code nobody touched, and the author pays for it at the gate.

**A fact that reshapes 8a.** The legacy passes' findings carry **no line field**, deliberately ([schemas.mjs](../../scripts/lib/schemas.mjs) `FindingBase`: a model's line claim is unverifiable there). So "classify from the cited line range" has nothing to read for a legacy finding. The only deterministic line evidence that exists is (a) the tiered pipeline's verified `anchor` / `triggerAnchor`, and (b) **the chunk the model was shown**: a model that saw only lines outside the change cannot have found a defect in the change. 8a therefore stamps the chunk's line ranges on each MAP finding (`_scopeEvidence`) and classifies from that. Everything with no evidence is `in-diff`.

**Two steps, smallest first**

| Step | What | Default |
|---|---|---|
| 8a | `scope: 'pre-existing'` tag, set mechanically; excluded from every count that gates | **on** (inert where no evidence exists) |
| 1c | `AUDIT_CHUNK_SCOPE=overlap\|referenced`: send only chunks the diff touches (+ chunks defining symbols they use) | **off** until the campaign passes |

## 2. Design

### D1 — Classification (8a)

[`finding-scope.mjs`](../../scripts/lib/finding-scope.mjs): `classifyFindingScope(finding, {hunksFor, window})`. Pre-existing **iff** the finding has line evidence **and** every item of it lies outside every hunk of its file widened by 15 lines. Fail closed on every other path: no `hunksFor`, no evidence, an unreadable or partly unreadable range, a file with no hunk entry, a malformed hunk, a throwing producer. The hunks come from the round's ONE hunk map (`buildHunkMap`, via `coverageRecorder.getHunkMap()`), so the tag and the coverage ledger agree on what the change is. Deletion-only hunks (`lineCount 0`) are a point. Model prose is never read.

### D2 — Pre-existing findings skip REDUCE

REDUCE rewrites findings and would drop the provenance, so `runMapReducePass` partitions after MAP: pre-existing findings bypass REDUCE and are appended unchanged on every return path (`withPre`). They lose cross-finding dedup/elevation, which is acceptable for findings that do not gate.

### D3 — Every place that counts (impact, not authorship)

| Site | Change |
|---|---|
| `finding-assembly.mjs` `countFor`, `quickFix` | exclude pre-existing → store `high/medium/low`, `computeAuditVerdict`, `evaluateConvergence*`, `round_converged_after`, and the AI-Gate evidence all derive from these |
| `prepush-audit-gate.mjs` `countBySeverity` | pre-existing counted apart (`outcome.preExisting`), never in H/M/L; a **malformed severity still makes the envelope unreadable** (shape first); the decision prints "N pre-existing … NOT counted"; `formatFindingTitles` skips them |
| `audit-loop.mjs` `countFindings` | excluded, so `isConverged` cannot be held open by them |
| `openai-audit.mjs` `printAuditResult` + `formatAuditSummaryLine` | counts exclude; `| pre-existing:N (not counted)` appended AFTER the seconds so the leading `Verdict: X \| H: M: L: \| Ns` shape is unchanged |
| `findings-format.mjs` | own `### Pre-existing` heading after the author's findings |
| `run-persistence.mjs` `highKept/mediumKept` (learning outcome) | exclude |
| R2+ ledger, debt capture, `audit_findings` rows, `totalFindings` | **unchanged**: pre-existing findings are still stored, ledgered and debt-captured |

No hook-body change: the gate reads its counts through the library, so `HOOK_VERSION` is not bumped.

### D4 — Changed-chunk scoping (1c)

`selectChangedChunks(chunks, file, {mode, hunksFor})` ([code-analysis.mjs](../../scripts/lib/code-analysis.mjs)), called from `buildAuditUnits` for a file that is chunked. `overlap` keeps chunks touching a hunk ±15 lines (a deletion-only hunk anchors at its point, so the chunk enclosing it is kept); `referenced` also keeps a skipped chunk declaring a name a kept chunk uses. **Returns every chunk** when it cannot decide: mode off, `hunksFor` null/throwing, no hunks for the file, a chunk with no line range, or nothing would be dropped/kept. A file outside the changed set (a dependent) is never scoped. Unsent chunks hold no changed line by construction, so the coverage ledger's `changedLinesUnread` stays honest. With the variable unset the result is byte-identical.

## 3. Measured so far (zero model spend)

`measured` — `scratchpad/chunk-share.mjs` (kept in the PR description), last 80 non-merge commits, files over the 30,000-token unit budget, hunks from `git diff -U0` of each commit:

| Repo | Commits with an oversized changed file | Chunk units, all | `overlap` sends | `referenced` sends |
|---|---|---|---|---|
| ai-organiser | 58 / 80 | 765 | 286 (37.4%) | 345 (45.1%) |
| wine-cellar-app | 12 / 80 | 99 | 47 (47.5%) | 49 (49.5%) |

A push spans several commits, so its diff touches more chunks: these are **lower bounds on the share sent**. The AIO #109 SHAPE fixture (`tests/finding-scope.test.mjs`; synthetic, built from the reported counts, not the real findings) pins the 8a mechanics: 17 findings → 15 tagged, gate counts 2. It shows the plumbing, not the real tag rate; that is measured by the campaign.

Convergence baseline (8d, `expected` source = the coordinator's brief, 2026-11-12; PR #342's CLI is not on this branch's base): code audits 29.8% first-round pass, 6.7% need 5+ rounds, mean 2.31 rounds.

## Campaign Contract

### C1 — Decision and metric
- **decision**: whether `AUDIT_CHUNK_SCOPE` may default to `overlap` or `referenced` for map-reduce passes. Louis decides.
- **metric**: recall of in-diff defects (share of labelled corpus findings an arm still raises) alongside the out-of-diff share of findings and chunk units sent. Recall decides; noise only breaks a tie.
- **error-costs**: a missed in-diff defect ships a bug (expensive, silent); an extra out-of-diff finding costs one fix/dismiss round (cheap, visible). The metric is trivially satisfied (recall 100%) by the every-chunk baseline, which is why the arm is the reference, not a pass.

### C2 — Split, leakage and sealed test custody
- **split**: no training. The corpus is split by audited commit (all findings of one audit stay together) into a 10-finding calibration slice (used for the dress rehearsal and to fix matching rules) and a sealed test slice (the rest).
- **test-set-hash**: SHA-256 of the sealed corpus JSON at freeze, recorded in `.audit/campaigns/out-of-diff-noise/corpus.sha256` by the freeze tool; not yet frozen.
- **access-record**: `.audit/campaigns/out-of-diff-noise/access.jsonl`, one line per read of the sealed slice (who, when, run id). One authorised test run; a changed matching rule needs a fresh slice and any later analysis is labelled exploratory.

### C3 — Feasibility and power
- **bound**: with 40 sealed findings and 0 misses the one-sided 95% lower bound on recall is 0.05^(1/40) = 92.8%; 1 miss → ~88%. A bar of "no worse than baseline" is therefore NOT certifiable at n=40; the declared bar is "at most 2 misses of 40 and 0 of the HIGH-severity ones" — a decision rule, not a proof of equivalence.
- **assumptions**: findings are independent across audits (they are not within one audit: the effective n is the number of audits, ~15); model nondeterminism adds miss noise, so baseline is re-run and its own misses are subtracted. The rule can return a non-empty result: baseline recall on the corpus is expected near 1 because the corpus is built from findings the baseline raised.

### C4 — Instrument and controls
- **controls**: a planted known-answer defect inside a changed chunk (`AUDIT_CANARY=1`, named like a real function) must be raised by every arm; a planted defect in an UNCHANGED chunk must be raised by baseline and absent (or tagged pre-existing) in the scoped arms. A scoped arm that misses the first is a blind arm.
- **independence**: labels come from the store (accepted + fixed findings, the fix commit's hunks) not from a labeller reading the candidate list; one adjudicator (Louis) reviews the borderline matches — single-adjudicator limit stated.

### C5 — Declared telemetry
- **telemetry**: per arm: chunk units built/sent, files scoped, findings raised, findings tagged pre-existing, matched corpus findings, cost USD, model id served.
- **fill-check**: the dress rehearsal asserts each field is non-null on every item; a zero must come from a counter, not a default.

### C6 — Operations
- **revision**: a pinned worktree at the merge commit of this PR (`npm run fixture:create`), never the shared tree.
- **model**: requested `latest-gpt` auditor sentinel (terra since 10-28); the served id is read from each run's envelope `model` and written to the arm record.
- **spend-limit**: USD 15 hard cap for the whole campaign (est. 15 audits × 3 arms × ~USD 0.25, plus the rehearsal); provider quota checked on the day; price table reviewed 2026-11-12 (stale after 2026-12-12). Not started before approval; weekdays 14:00-20:00 local excluded.
- **heartbeat**: run id `ces-out-of-diff-noise-<date>` under `node scripts/run-heartbeat.mjs run --run-id ... --stale-after 900 -- node scripts/<replay-cli>`; artifact hashes written by the tool.

### C7 — Dress rehearsal
- **items**: 5
- **evidence**: `.audit/campaigns/out-of-diff-noise/rehearsal.json` (not yet produced; the real run waits for it).

### C8 — In-run canary
- **canary**: the two planted defects of C4, one pair per replayed audit; a miss makes that arm's audit INCOMPLETE, not clean.
- **evidence**: `.audit/campaigns/out-of-diff-noise/canary.jsonl`

### C9 — Contract epoch
- **contract-epoch**: `oodn-1`, stamped on every arm record by the collector; a matching-rule or scope-rule change bumps it and re-collects.

### C10 — Deviations
- **ledger**: `docs/plans/audit-out-of-diff-noise.md` §6 (below), reported to the CES coordinator before merge.

### C11 — Done means artifact
- **done-evidence**: `docs/research/out-of-diff-noise-campaign-result.md` (planned)
- (Per-arm tables, the corpus hash and the access record are committed with it; the PR for 8a + the mechanism is not "done" for 1c's default.)

### C12 — Close-out claims check
- **claims-check**: `docs/research/out-of-diff-noise-campaign-result.md` (planned)

## 5. Verification

`tests/finding-scope.test.mjs` (24): classification truth table incl. every fail-closed path, window edges, deletion-only hunk, tiered anchors, prose-ignored, the AIO #109 fixture through the gate and `/audit-code` convergence, formatter/summary line, `selectChangedChunks`/`buildAuditUnits` including off = identical. Negative controls (seen to fail): removing the gate's partition → 2 fail; removing the overlap test → 6 fail.

## 6. Deviations / open items

- **Residual risk of 8a (audit R1 H1/H5/H8, accepted by design).** A change can introduce a defect in an unchanged chunk (an unchanged caller of a function whose contract changed). Such a finding would be tagged pre-existing and not gate. Mitigations: it is still stored, listed under its own heading in every report, and counted in the gate output ("N pre-existing … NOT counted"); `referenced` scoping (1c) keeps the callee's definitions with the change, not callers. Not closed: caller-side blast radius needs the adjacency machinery, and is the campaign's recall question for the tag too (add 'tagged pre-existing but fixed in-diff' to the campaign's miss count).

- 8a cannot tag legacy findings from a non-chunked file or from a file chunked while `AUDIT_CHUNK_SCOPE` is off **and** whose chunk the diff touched: they have no line evidence and stay in-diff. This is the fail-closed direction and is stated in the PR.
- Single-pass (non map-reduce) legacy calls render whole files; scoping and the tag do not apply there.
- PR #342's `audit:convergence` CLI is not on this branch; after both merge, re-run it for the "after" figures once enough post-change audits exist.
