# Plan: Sashiko-inspired audit improvements (audit --resume, contested-finding verification, defect corpus)
- **Date**: 2026-11-19
- **Status**: Draft
- **Author**: Claude + Louis
- **Proposal**: `p-20261118213122-bc4c` (theme `audit-quality`), approved by Louis 2026-11-18 for after #395 landed (main at `1df6fbfb`).
- **Scope**: backend (js-ts). Principle set: `skills/plan/references/engineering-principles.md`.
- **Target domain(s)**: `audit-orchestration` (PR A, PR B), `model-eval` + `scripts` (PR C), `tests`.
- **Not touched**: `scripts/lib/fleet/**`, `scripts/fleet.mjs` (owned by the concurrent fleet-hygiene chip).

**PROOF PLAN**: each PR ships a test that fails on `main` and passes on the branch, and each test also has a negative
control. PR A: a fake OpenAI client loses pass B to a 429; the `--resume` run calls only pass B, and the result carries
`resumed`. Each identity field changed alone (prompt byte, model, schema, tree) forces a live call. PR B: verdicts run over
real `.audit/` artifacts from PR #395's sessions; a `refuted` verdict whose quote is not in the evidence pack is demoted to
`inconclusive`. PR C: the miner runs on a fixture git repo, and its outcomes reconcile by set equality against an independent `git rev-list` universe; an injected omission exits 3.
`stratifiedSelectKDs` stops drawing the `invalidated` KD-013. The final report shows each red→green pair, the test counts,
and the miner's reconciliation line on CES's own history.

**Neighbourhood considered** (`get-neighbourhood`, k=8, 2026-11-19). All three intents banded `review`
(`below-noise-floor-near`). The nearest hits were the files this plan extends, and I opened each of them before designing:
- `scripts/lib/audit/llm-helpers.mjs` (`callGPT`, `safeCallGPT`, `_callGPTOnce`): the record/replay seam (PR A).
- `scripts/lib/audit/pass-result-cache.mjs`: a per-pass cache that is write-only. It has no reader, which grep verified
  2026-11-19 at `1df6fbfb`. PR A retires its four write functions.
- `scripts/lib/audit/finding-verification.mjs` (`verifyExistenceFindings`, `isRefuted`): the deterministic existence gate.
  PR B reuses its verdict vocabulary and its safe direction (only `refuted` downgrades).
- `scripts/defect-harvest.mjs` (`harvestCandidates`): the miner already exists. PR C extends it; no second miner.

Incident neighbourhood: INC-001 (sensitive-path symlinks) applies to PR B's evidence reader. It is handled by routing every
read through `resolveAndClassify` and `assertEgressSafe` (§4.4).

---

## 1. Context

### 1.1 What sashiko does

The research read sashiko at HEAD `57371e8` (shallow clone, 2026-11-18; read-only).

| Item | Sashiko | Where |
|---|---|---|
| Corpus | Fix/introducer pairs taken from explicit links (`Fixes:` trailers; GCC "caused by <sha>"). Filters: introducer is an ancestor of the fix, touches real source, ≤600 lines across ≤10 files, deduplicated. **No miner script exists and no drop report is kept.** Size tiers tiny/small/full (9/99/999). Suites `missed` (446) and `expect_clean` (20 neutral commits that soaked 6 months with no later `Fixes:`/`Revert`). An expect_clean entry is scored with no judge: any finding counts as a FALSE_POSITIVE, recorded per stage. | `designs/DESIGN_GCC_REVIEW.md` §5.1, `designs/DESIGN_PERFORMANCE_STAGE.md` §3, `src/benchmark.rs` |
| Resume | Every run records LLM calls to a SQLite cache keyed by SHA-256 over (provider identity + model + effort, NUL, canonical request JSON), with volatile fields removed. Time is used only for TTL. `--resume` replays from the cache. A rejected, truncated or failed answer is **evicted**, so it is never replayed. A replayed result is marked only weakly (cached-token counters). | `src/ai/cache.rs`, `src/ai/session.rs` ~L380-440 |
| Verification | A sorting stage splits concerns into direct findings, dropped (a quoted snippet disproves it), and inconclusive. **Only inconclusive items** are verified, one parallel stage per item (at most 10, highest severity first). The verifier has git read/search tools only and does not run tests. The proof standard is the same both ways: a dismissal resting on an unverified assumption is promoted to a finding. Measured effect: detected-or-partial 51.9%→53.5% with 6.6% fewer findings. | `designs/DESIGN_PARALLEL_POST_VERIFICATION.md` |

### 1.2 What CES has

All facts below were checked at `1df6fbfb`.

- **Corpus.** `known-defects.json` v3 has 18 entries; one, KD-013, is `invalidated: true`. Nothing in `scripts/lib/model-eval/**` or
  `scripts/model-eval-*.mjs` reads `invalidated` (grep, 2026-11-19), so `stratifiedSelectKDs`
  (`scripts/model-eval-auditor.mjs:136`) can draw KD-013. `scripts/defect-harvest.mjs` already mines revert, `Fixes <sha>`
  and blame pairs into a **tracked** `known-defects.candidates.json` (1,247 candidates). That file records absolute
  `c:/GIT/...` roots and a commit count, but no resolved revision, so it cannot be reproduced. Every `continue` in the
  harvester drops a commit silently; only issue-number references are logged. The word "tier" is already taken in
  model-eval (`--tier screen|promotion`, Tier A/B/C), so sashiko's size tiers become **`--subset tiny|small|full`** here.
- **Resume.** An INCOMPLETE round exits 3 (`openai-audit.mjs:952`). `/audit-code` Step 2 offers only a re-run with a
  higher timeout or continuing with partial results (`skills/audit-code/SKILL.md:208`), so a 429 that kills one of
  five passes re-pays all five. `pass-result-cache.mjs` writes per-pass JSON to `.audit-cache-<pid>/`. A `finally` block
  deletes it on every exit (`legacy-production-audit.mjs:273`), and nothing reads it, so its comment's purpose, giving
  "a crashed run something to resume from", is unreachable. It is keyed by PID, not by identity.
- **Verification.** A contested finding (triage `validity=uncertain` → `action=rebut`) goes to
  `openai-audit.mjs rebuttal`, which is a prose deliberation with GPT and no repo evidence (`SKILL.md:275-290`).
  `finding-verification.mjs` adjudicates only existence claims ("X is missing"), deterministically.

### 1.3 PR #395, measured (motivating case)

Source: the worktree `nostalgic-nobel-101150/.audit/` result files for each `audit-code-*-r<N>-result.json`. The counts
are measured; the classifications are derived by reading the findings.

- The planned code audit (SID `…1795028282052-47728`) converged at round 6, with HIGH 10/3/3/0/0/0. That loop worked.
- The **extra rounds** were the CI seam: four `/audit-code` runs, **each a fresh SID at r1**
  (`…1795035542408`, `…1795036796028`, `…1795038077008`, `…1795049627365`). Their HIGH/MEDIUM counts were H4M2, H6M2,
  H3M5 and H3M3. Because every one was r1, none had a ledger, R2+ suppression or rulings injection, and the round cap
  restarted each time.
- **Most of those HIGHs were real.** The seam was finally replaced by a single oracle (`docs/plans/ci-evidence-oracle.md`).
  That is a structural signal, and per-finding verification would not have changed it.
- **Within each round, several HIGHs restate one concern across passes.** For example, `…1795035542408` r1 raises "masked
  import failure" from `be-services`, `Sustainability` and `Quickfix`, which is three HIGHs for one concern.
- **The disputed residuals were narrow and factual**, which makes them verifiable. "A non-boolean `isDraft` passes the
  draft check" and "a configured `requiredChecks` list is taken as complete when the inventory read fails" can each be
  settled by reading the cited code. Both were instead carried to "one more round".

**What this means for the plan:** PR B saves the round that would be spent re-checking a disputed or narrow residual, and
nothing more; it is not a cure for structural churn, which the round cap's structural card already handles. Two other
causes of the inflated round count are separate defects, recorded as findings (§9 F2, F3) rather than built here.

---

## 2. Decision: three PRs, in this order

| PR | Item | Why this position |
|---|---|---|
| **A** | `audit --resume` (call record/replay) | Smallest, and the most direct saving. It touches only the GPT call seam. |
| **B** | Contested-finding verification | New CLI plus a skill change. Its LLM calls go through the same `callGPT` seam, so it inherits PR A's recording, but it does not need it. |
| **C** | Defect corpus: miner drop report, suites, subsets | Touches only model-eval and the harvester. No production audit path. |

**Why three PRs and not one.** The file sets are disjoint (§7). Each PR has its own proof and its own consumer-sync
surface, and #395's 43-file diff left two files read only partially by the code audit. Three diffs of about 10 files are
each fully readable by one audit. None depends on another's code, so any one can be reverted alone. They are built in
order on separate branches from `main`, and one plan holds the shared context.

---

## 3. PR A: `openai-audit.mjs code --resume`

### 3.1 Design

**A call record** (`scripts/lib/audit/call-record.mjs`, new).
- Every **successful** structured GPT call in a legacy code-audit round is written to
  `.audit/call-records/<auditedTree>/<requestKey>.json` as `{requestKey, keyFields, response:{result, usage, model}, recordedAt}`.
- The directory is created with `0o700`, under `.audit/` (gitignored, Category A).
- `recordedAt` is informational only. It is **never** part of the key and never read by replay.

**The request key** is `sha256` over canonical JSON (sorted keys) of the fields below. Nothing time-derived is included.
The key is computed from the **effective request params object** that `_callGPTOnce` hands the SDK (one function,
`effectiveRequestFor(opts)`, used by both the live call and the key), not from a parallel list that could drift from it.
- **Route identity** (R1-H1): the transport (`openai` | `azure`), the endpoint origin (`AZURE_OPENAI_ENDPOINT` origin, or
  the OpenAI base URL), and the Azure deployment name when Azure. One model string on two backends is two keys.
- `wireModel()`: the id actually sent.
- Every output-affecting param in the effective request: `reasoning_effort`, `max_output_tokens`/`max_tokens`, the
  `text.format` / `response_format` block, `temperature` when set, and which API is used (Responses or Chat Completions,
  `llm-helpers.mjs:200`).
- `schemaName` plus `sha256(JSON.stringify(z.toJSONSchema(schema)))`.
- The normalised `system` and `messages` (`normalisePromptInput`).
- `CALL_RECORD_KEY_VERSION`.

**On lookup** (R1-H1), a record is a hit only if all of these hold. Anything else is a **miss** and the call goes live.
- The envelope parses.
- `sha256(canonical(keyFields)) === requestKey === filename`.
- `schema.safeParse(record.response.result)` succeeds against the **current** schema.

The prompt already contains the code, the R2+ ledger rulings and the history block. A changed ledger or a changed file
therefore changes the key, and the replay misses. That is correct by construction, not by a freshness check.

**The namespace is the audited tree *and* the round being run (R2-H1).** Records live under
`.audit/call-records/<auditedTree>/<auditSessionId>-r<auditRound>/`.
- `auditedTree` comes from `captureTargetIdentity`, which is already captured before any input is read
  (`openai-audit.mjs:490`).
- `auditSessionId` and `auditRound` come from `resolveAuditIdentity` (`scripts/lib/audit/audit-identity.mjs:21`), the one
  resolver of `--session-id` / `--round` / the `<sid>-r<N>-result.json` out-path. It is already called at
  `openai-audit.mjs:651`.
- The envelope also stores `{auditedTree, auditSessionId, auditRound}`, and **lookup checks all three** against the
  current run. A record found in the right directory but carrying another identity is a miss.
- **Consequence.** A resume replays only calls made by an earlier attempt **of the same SID and round** against the same
  tree. Two cases that would otherwise replay identical prompts are both misses:
  - round 3 replaying round 2's answers when the ledger did not change between them (which would fake "2 stable
    rounds");
  - another session replaying records for the same tree.
- **Refusals.** `--resume` exits 1 and names the reason when any of these hold:
  - `auditedTree` is null: *"cannot resume: audit-target identity unavailable (`<code>`)"*;
  - `auditSessionId` or `auditRound` is null;
  - the identity is in conflict (`conflict` non-null);
  - no `<sid>-r<N>/` directory exists for this tree. The message is *"nothing to resume for `<sid>` round `<N>` at this
    tree"*, never a silent fresh run.
- **Recording without `--resume`** also needs all three identity fields. When any is null, recording is off for that run
  and one line says so.

**What gets recorded.** Only a response that parsed against its schema, at `callGPT`'s success return.
- `safeCallGPT`'s degraded result (`failed: true`) is never written.
- A truncated or `incomplete` response throws before the success return, so it never reaches the writer either. This is
  sashiko's eviction rule, enforced by where the write happens rather than by a later delete.

**Replay.**
- Replay happens only when `ctx.resume === true`. `callGPT` asks `lookupCallRecord(key)` first; a hit returns
  `{result, usage: {…, replayed: true}, latencyMs: 0, model, replayed: true}` and makes no API call.
- **Without `--resume` nothing is ever replayed**, so a fresh round stays fresh.
- A record that fails to parse, or whose stored `keyFields` do not hash to its filename, is treated as a miss and logged
  `[call-record] corrupt record <key> — ignored`, never as a hit.

**Replay does not pass the egress gate twice.** A replayed call sends nothing. The prompt was already gated when it was
recorded, and the key is built from that same gated prompt.

**Scope.**
- `--resume` is accepted only for `code` mode on the legacy pipeline.
- `plan` and `rebuttal` are single calls, so there is nothing to replay; with the tiered pipeline enabled the request is
  out of scope. Each of these refuses with exit 1 and names the reason (`resume-unsupported:<mode|tiered>`).
- `--resume` requires the same `--round N` as the round it resumes. It does **not** advance the round cap, because it is
  the same round finished, not a new one. This uses `round-cap-gate`'s existing handling of a re-run round number. If
  that gate refuses a re-run of the same N, the plan widens to a stated `resume` exemption that the gate's own test pins.

**A resumed round never reads as a fresh one.**
- The result carries `_resume: {resumed: true, replayedCalls, liveCalls, recordsTree}`.
- `formatAuditSummaryLine` appends `| resumed: <replayed>/<total> calls replayed` **after** the seconds field. This keeps
  the leading `Verdict: X | H:a M:b L:c | Ns` shape that consumers parse, the same placement `pre-existing:N` uses.
- The stamp is added in `stampRunNotices`.
- `writeGateEvidence` and `buildGateEvidence` gain an optional `resumed: boolean`. It is written as `true` only on a
  resumed round and is absent otherwise, so existing markers stay byte-identical.
- A resumed round that still has live failures is INCOMPLETE as before, with exit 3.
- **Not new**: a resumed round that completes is evidence for the same tree. Every replayed response was produced for
  this exact tree and these exact prompts, so it counts toward convergence like any round. The `resumed` stamp is
  provenance, not a demotion.

**Concurrency and failure (R1-H2).** A record is a cache entry for a **pure request within one SID and round**. Two
attempts of the same round against the same tree that write the same key have written two valid responses to the
identical request, and either one is a correct replay.
- **Publication is atomic.** `atomicWriteFileSync` (temp + rename, `file-io.mjs`) writes each record, so a reader sees an
  old record, a new one or none, never a torn file. A torn file left by a killed process is a parse failure, which is a miss.
- **No run ever deletes its own tree's records.** The draft's "a completed round deletes its directory" is removed,
  because a concurrent INCOMPLETE run on the same tree may still need them.
- **Pruning** runs once at run start, not on every write. It keeps the newest `AUDIT_CALL_RECORD_KEEP` (default 5) tree
  directories by directory mtime, **never** removes the current run's tree directory, and treats `ENOENT`/`EBUSY` from a
  concurrent deleter as already gone. Mtime only orders disposable entries for deletion; it is never an identity or
  freshness signal.
- **A run on a pruned older tree** loses only its replay, not correctness: its next lookup misses and the call goes live.
- **Every cache I/O failure degrades to the live path and is reported.** A failed write logs `[call-record] write failed
  <code>` and counts in `_resume.recordWriteFailures`. A failed read is a miss with a log line. Recording never fails the
  audit, and a record failure is never silent.
- `AUDIT_CALL_RECORD=0` disables recording entirely. It is documented in `environment-variables.md`.

**Retiring the dead cache.** `initResultCache`, `cachePassResult`, `cacheWaveResults` and `cleanupCache` are deleted
along with their call sites; they have no reader. The `runLegacyProductionAudit` try/finally wrapper exists only for
`cleanupCache`, so it collapses into the impl. The module keeps its two unrelated exports
(`normalizeFindingsForOutput`, `collectReducePassStatuses`). `.audit-cache-` stays in
`arch-intent/adapter-contract.mjs`'s excluded prefixes, because stale directories may exist on disks.

**The skill.** `/audit-code` Step 2 "Handle results": on an INCOMPLETE round whose failed passes were `http-429`/`timeout`,
re-run **the same command with `--resume`** before considering a higher timeout. The detail goes in a new
`references/resume.md`, and SKILL.md gains one line, offset by trimming elsewhere, because SKILL.md is size-ratcheted.

### 3.2 Right-sizing
- **Band-aid**: raise retry budgets or timeouts. The quota stop still re-pays every finished pass.
- **Over-built**: a SQLite or cloud-store response cache with TTLs, cross-model fallback (sashiko's `--resume` tries other
  models) and a new `audit_runs` column. Cross-model replay would make a resumed round measure a different model, which
  is exactly the dishonesty §3.1 forbids.
- **Chosen**: one JSON file per successful call, keyed by request content, namespaced by audited tree, replayed only on
  `--resume`. It is a function of the problem, which is passes that already finished.

### 3.3 Tests (`tests/audit-call-record.test.mjs`, `tests/openai-audit-resume.test.mjs`)
1. **Red→green.** A fake client: pass `wiring` throws a 429 on every attempt, and the other passes succeed. Run 1 is
   INCOMPLETE and its records exist. Run 2 uses `--resume`, and the client succeeds for `wiring`.
   - Asserts that the client was called **only** for `wiring`'s requests, `_resume.replayedCalls === <the others>`,
     `liveCalls === 1`, and the summary line contains `resumed:`.
   - It fails on `main`, because `assertKnownFlags` rejects `--resume`.
2. **Key controls, one change each.** Run 2 resumes the same round after one change: one prompt byte, `wireModel`,
   `reasoning_effort`, max output tokens, the schema shape, the transport (openai vs azure with the same model string),
   the Azure endpoint or deployment, or `auditedTree`. Each forces that call live (0 replayed for it).
   - Also asserts that `effectiveRequestFor` is the object passed to the fake SDK. A param added to the live request is
     therefore in the key, with no second list to update.
3. **No `--resume`.** The same records exist, and every call goes live (0 replayed).
4. **Never recorded.** A `failed: true` degraded pass, an `incomplete`/`truncated` throw, and a schema-parse failure each
   leave no file.
5. **Corrupt or stale record.** Each of these reads as a miss with the log line:
   - a truncated JSON file;
   - a record whose `keyFields` do not hash to its name;
   - a record whose stored result fails the current schema.
6. **Refusals, exit 1 with the reason.** `--resume` is refused in each of these cases:
   - `plan` mode;
   - the tiered pipeline is enabled;
   - `auditedTree` is null;
   - the SID or round is null;
   - the `--session-id` and `--out` identity conflict;
   - no record directory exists for this SID and round. That run does not silently go fresh.
6a. **Identity isolation (R2-H1, G2).** Records from SID `A` round 2 exist for the same tree, with prompts byte-identical
   to round 3's.
   - (i) A `--resume` of SID `A` round 3, or of SID `B` round 2, with **no** directory of its own exits 1 with
     `nothing to resume`.
   - (ii) With `A-r2`'s record files **copied into** `A-r3/` and `B-r2/`, each resume runs and replays 0 calls. The
     envelope's identity fields mismatch, so every lookup is a miss and every call goes live.
   - The two arms test the directory namespace and the envelope check separately.
7. **Gate evidence.** The marker carries `resumed: true` only on a resumed round. A non-resumed marker is byte-identical
   to its pre-change golden.
8. **Prune.** Seven tree directories reduce to the 5 newest, and the current tree survives even when it is the oldest.
   A completed round leaves its own directory in place.
9. **Concurrency.**
   - Two runs on the same tree write the same key concurrently. Every read during and after sees a parseable record or a
     miss, never a torn file.
   - A run whose tree directory was pruned mid-run makes live calls and completes.
   - A forced write failure (read-only directory) leaves the audit complete, with `recordWriteFailures: 1` and the log line.

### 3.4 Files (PR A)
`scripts/lib/audit/call-record.mjs` (new), `scripts/lib/audit/llm-helpers.mjs`, `scripts/lib/audit/legacy-production-audit.mjs`,
`scripts/lib/audit/pass-result-cache.mjs`, `scripts/lib/audit/planless-intent.mjs` (`stampRunNotices`),
`scripts/lib/audit/findings-pipeline.mjs` (`formatAuditSummaryLine`), `scripts/lib/audit/gate-evidence.mjs`,
`scripts/openai-audit.mjs` (flag, refusals), `skills/audit-code/SKILL.md`, `skills/audit-code/references/resume.md` (new),
`docs/reference/environment-variables.md`, the two tests above, plus the regenerated `.claude/skills/**` and the sync
closure (`scripts/lib/bundle-deps.json`) if the new lib module enters it.

---

## 4. PR B: contested-finding verification (`scripts/verify-findings.mjs`)

### 4.1 Which findings are "contested"

`selectContested({results, ledger, triage})` is a pure, deterministic function over the round result files and the
ledger. There are three contest kinds.
1. **Disputed by the author.** The triage row has `validity=uncertain` or `action=rebut`.
2. **Disputed by the auditor.** In R2+, a finding matches a ledger entry with `adjudicationOutcome=dismissed`, and
   `suppressReRaises` did not suppress it (it survives in `findings[]`).
3. **Flips.** The same `generateTopicId` is present in round k, absent in k+1 and present in k+2, while none of its
   `affectedFiles` changed between those rounds (per `git diff --name-only` between the rounds' `auditedSha`). The same
   applies to a severity change between rounds with no file change. If no `auditedSha` is available, a flip is not
   claimed; the finding is not classed as a flip.
**Final-review `wrongly_dismissed` items are not a contest kind in v1 (R3-H2, R3-M2).** The draft had a fourth kind, and
it needed a second ledger update path for an entry absent from round N, plus binding to a final-review item. The final
review already has its own deliberation protocol for those items (`references/gemini-gate.md`, Step 7.1), and nothing
there depends on this CLI. They stay on that path (§11).

**Every contest kind binds to one canonical source (R2-M2):** a finding present in `--round N`'s result file. Every
selected item carries `source: {kind: 'round-finding', findingId, topicId}`, and the ledger writer validates it against
that file.
- A flip (kind 3) is *detected* from history but is selectable only when the finding is present in round N.
- A flip whose latest appearance is earlier than round N is not actionable now. It is not selected, and it is listed
  under `notSelected` with its reason.
- So every verified item updates an entry whose identity comes from the round result (REQ-correctness-db53f358), through
  the existing writer path.

When there are more than 10 (`--max`, default 10), the highest severity goes first, then the earliest round. The rest are
**put in state `over-cap`** (§4.4), never dropped silently. There is no batching in v1.

### 4.2 Evidence pack (deterministic, no LLM; one acquisition boundary per source, R1-H5)

Every finding gets an evidence pack of numbered items, tagged `E1…En` and capped at 24K chars per finding. **Every source
goes through one `acquire(source)` function before anything is stored, persisted or sent.** It does four things:
- **(a)** It classifies every path the source returns with `resolveAndClassify`, following symlinks (INC-001). A
  sensitive or repo-escaping path becomes `[withheld: sensitive path <hash8>]`; the hash comes from `formatSkipLog`, so no
  basename is shown.
- **(b)** It runs `redactSecrets` over all text. A redaction failure gives `[REDACTED:redaction-failed]`, failing closed.
- **(c)** It caps the item's size.
- **(d)** It marks a withheld item `eligible: false`, so the item can never be cited as proof (§4.3).

The `[withheld]` markers are for operator diagnostics; the model sees only that an item is withheld. The assembled pack
then passes `assertEgressSafe`.

| Source | What it collects | Boundary specifics |
|---|---|---|
| Cited code | The cited file at the finding's lines ±40, or the enclosing function from `symbol-index` | The cited path is classified before it is read |
| Identifier grep | `git grep -n -w` over the **working tree** (git grep's default: tracked files as on disk), up to 20 hits | Each hit's path is classified. Hits in sensitive paths are dropped and counted, never shown |
| History | `git log -L <range>:<file>` and `git blame -w` on the cited range only, both anchored at the sha `HEAD` resolved to when the CLI started | Always redacted: an old blob can hold a secret that has since been removed. Commit messages are dropped; only shas and line text are kept. Labelled `historical` |
| Test (optional) | `--run-test <path>`, repeatable | See below |

**One snapshot for current-code evidence (R2-H2).** Cited code and grep both read the working tree. That tree is the
audited tree only if nothing moved, so identity is checked three times and fails closed:
- `captureTargetIdentity` runs **before** acquisition and **after** it (tests included); both must equal the round's
  `auditedTree`. Any difference exits 2, `tree moved during verification`, and nothing is sent.
- The post-acquisition check runs before any model call. So a test that edits files, or a concurrent edit, voids the run
  before any evidence leaves the machine.
- History items are pinned to the recorded `HEAD` sha, are immutable, and are labelled `historical` so they are never
  presented as current code.

Every item records its **provenance**: `{source: code|grep|history|test|finding, path?, range?, query?, rev: 'audited-tree' | <sha>}`.
That record is what lets the ledger boundary reconstruct the item (§4.4).

`--run-test` rules:
- The **operator** names the path in this invocation, never the model and never text taken from a finding.
- The path must be a **tracked** file that matches the repo's test glob.
- The test runs as `node --test <path>` with a 120 s timeout, in an env **scrubbed** to `PATH`, `SystemRoot`/`HOME` and
  `NODE_ENV=test`. No keys, `AUDIT_DB_*`, `AZURE_*` or `OPENAI_*` reach it.
- Only the TAP summary and the failing-assertion lines are kept, and they are redacted.

### 4.3 Verdicts are evidence for triage, never a ruling (R1-H3)

A quote's presence proves the text exists; it does not prove that the text settles the finding. So the verifier
**dismisses nothing**. It attaches a checked opinion to the finding, and the existing triage still decides: Claude makes
the triage call and the operator can override it.

**The verifier call.** One structured call per finding, through `callGPT` at reasoning `medium`.
- **Model (R1-M2):** in v1, `--model` accepts GPT sentinels and concrete GPT ids only (`latest-gpt`, `latest-gpt-mini`).
  Any other value exits 1 with `unsupported verifier model family`. The recorded model is the response's own `model`,
  which is the id that actually served the call.
- **Schema:** `verdict: confirmed | refuted | inconclusive`, `evidenceRefs: string[]`, `quote: string`,
  `reason: string`, `severityIfConfirmed`.
- **Prompt:** it states sashiko's rule in both directions. Refuting needs a quote that shows the defect cannot occur.
  Confirming needs a quote that shows it does. An argument about intent or design is `inconclusive`.

**`validateVerdict` (pure) checks eligibility, not truth.** A non-`inconclusive` verdict is **demoted to
`inconclusive`**, recording `demotedFrom` and the rule that failed, when any of these holds:
- the quote is empty, or shorter than 12 non-whitespace characters;
- a ref is unknown or has `eligible: false`;
- the quote does not occur verbatim (whitespace-normalised) in one of the cited eligible items;
- the quote occurs only in the finding's own text. That text is copied into the pack as `E0`, which is never eligible.
- the quote's only source is a `test` item. Test output cannot be reconstructed later (§4.4), so in v1 it is context for
  the model and for triage, never a quotable proof. This is a stated limitation.

A verdict that passes is labelled `evidence-backed`, which does not mean correct.

**How triage uses the verdicts.**

| Verdict | Effect |
|---|---|
| `refuted`, evidence-backed | Shown to triage as `[verify: refuted — E3 "…"]`. Triage *may* dismiss with `dismissReasonClass: false-positive`, citing the verify artifact. The dismissal is still a triage decision and is recorded as one |
| `confirmed`, evidence-backed | Shown to triage. Triage keeps the finding; `severityIfConfirmed` is advisory |
| `inconclusive` (raw or demoted) | Routed to the existing `rebuttal` deliberation |

**Family.** `modelFamily` (`model-resolver.mjs`) is recorded for both the verifier and the finder, and `selfFamily: true`
is stamped when they match. A same-family verification is shown as such, not hidden.

### 4.4 Item states, artifact contract and wiring

**Every selected item ends in exactly one state (R1-H7).**

| State | Meaning | Routed to |
|---|---|---|
| `verified` | `confirmed` or `refuted`, and evidence-backed | Triage, as evidence |
| `inconclusive` | No verdict that met the bar, raw or demoted | `rebuttal` |
| `over-cap` | Not sent, because it is beyond `--max` | `rebuttal`, as today. Never silently ignored |
| `failed` | The call was lost (429 or timeout), or acquisition failed | `rebuttal`, and the run is incomplete |

**Per-state schema (R2-M3).** The item schema is a Zod discriminated union on `state`, `.strict()` per branch:

| `state` | Required | Forbidden | Ledger writer |
|---|---|---|---|
| `verified` | `verdict ∈ {confirmed, refuted}`, `evidence {refs, quote, pack, packHash}`, `reason`, `model` | `demotedFrom`, `failure` | Full re-validation (below), then attaches `verification` |
| `inconclusive` | `verdict: 'inconclusive'`, `evidence.pack`, `packHash`, `reason`, `model` | `failure` | Validates the pack, then attaches `verification` with no quote |
| `over-cap` | `rank` (its position past the cap) | `verdict`, `evidence`, `model`, `failure` | Attaches nothing. The item is listed for routing |
| `failed` | `failure: {stage: 'acquire' \| 'call', category}` | `verdict`, `quote` (`evidence.pack` is optional: present only if acquisition succeeded) | Attaches nothing. The batch is still accepted, and the artifact's `complete: false` is echoed in the writer's summary |

The artifact carries `complete: boolean` (`false` if any item is `failed`) and `counts` per state.
- **Exit 0**: the run is `complete`.
- **Exit 3**: at least one item is `failed`, so the run is INCOMPLETE. A partial set must never read as finished
  verification.
- **Exit 2**: bad input, or the tree does not match.
- `emit({ok:false})` makes the exit code non-zero, and stdout is drained through `finishAndExit`.
- `contested-verification.md` routes `inconclusive`, `over-cap` and `failed` items to `rebuttal`, and the round card
  shows the `over-cap` count. The 12-item test (4.6-4) checks both the CLI output and the routing list the skill reads.

**Artifact contract (R1-H4).** The CLI is invoked as
`node scripts/verify-findings.mjs --sid $SID --round N [--max 10] [--run-test …] --out .audit/$SID-r<N>-verify.json`.
It writes a versioned artifact (`schemaVersion: 1`, Zod `.strict()`). The artifact header is bound to:
- `sid`, `round`, the round result file's `sha256`, and the round's `auditedTree`;
- the verification-time `evidenceTree`;
- `complete` and `counts`.

**The per-state union above is the only normative item contract (R3-M1).** Every item shares the fields `source` (§4.1),
`contestKind` and `state`. Its remaining fields are those of its state branch, and nothing else. When an item is
`verified` or `inconclusive`, its `evidence.pack` (the full pack) and `packHash = sha256(canonical(pack))` are stored.
The implementation's test fixtures hold one complete serialised example of each of the four states. The CLI, the writer
and the routing tests all parse those same examples.

`evidenceTree` must equal `auditedTree`, or the CLI exits 2. There is **no `--allow-tree-change`**: evidence about
different bytes is a new audit, not a verdict.

**One validation function, `validateVerifyItem(artifact, findingId, {repoRoot})`, exported from `contested-findings.mjs`.**
It is the only place the artifact is trusted or rejected. It returns `{ok, reason}` and fails on the first check that
does not hold:
- the schema;
- `sid` and `round`;
- the result-file hash against the actual `.audit/$SID-r<N>-result.json`;
- the item's `source` against round N's findings (§4.1), with no duplicates;
- `packHash` against the stored pack. This catches corruption, **not tampering**, because a recomputed hash would still
  match;
- **provenance re-acquisition (R2-H3).** It re-runs `acquire` from each cited item's recorded provenance and requires
  byte-equality with the stored item.
  - Code and grep items are re-acquired only while the working-tree identity still equals the artifact's `auditedTree`.
  - History items are always re-acquired, because they are pinned to a sha.
  - An edited pack with a recomputed hash fails here, because the evidence is rebuilt from the repo and not taken from
    the file. A moved tree fails with `tree moved`.
- `validateVerdict` re-run against the re-acquired items.

**The narrowed ledger seam (round-3 structural card).** The card flagged the verify→ledger seam in
`write-ledger-entries.mjs` (which already carries three open debt items on that file). In response, the seam shrank to a
single pointer:
- **No verification data is copied into the ledger.** There is no `verification` field, no ledger-schema change, and no
  `--verify` flag. The verify artifact stays where it is, in `.audit/` (Category A).
- **Before triage (R3-H1).** `verify-findings --check <artifact>` calls `validateVerifyItem` for each item on the same
  tree, immediately after verification. It prints the `[verify: …]` triage lines **only for items that pass**. The skill
  shows triage that output, never the raw artifact.
- **The binding.** A triage row that uses a verdict carries `reliesOn: {artifact: <path>, packHash}`. One example is a
  dismissal that cites `refuted`. `write-ledger-entries.mjs` stores that pointer on the entry as an optional
  `reliesOn` field, the one additive schema field.
- **At write time.** The writer calls `validateVerifyItem` for every row that carries `reliesOn`, and does nothing else
  with verification.
  - If the item passes, the row is written.
  - If it fails, or the tree moved, **the whole batch is refused**, naming the row: `triage row H2 relied on verification
    that no longer validates: re-triage`.
  - Rows without `reliesOn` never touch verification code.
- **`adjudicationOutcome` always comes from `--triage`, never from verification.**

**No new suppression semantics (R1-H6).** Verification writes no ruling and changes neither the R2+ rulings injection nor
`suppressReRaises`. When triage dismisses a finding after seeing a `refuted` verdict, that dismissal behaves like any
other under today's re-raise rules. The draft's ruling, "void if the cited files change", has been removed, so its
incomplete dependency set no longer matters.

**Skill.** `/audit-code` Step 3, *Tiered rebuttal*, becomes three steps:
1. **Preliminary triage (G1).** Triage first writes its triage JSON as today. Kind-1 contests are the rows that triage
   marks `validity=uncertain` or `action=rebut`, so this file is an input to verification, passed as
   `verify-findings --triage <path>`. In R1 it is the **only** source of contests, because kinds 2 and 3 need an earlier
   round.
2. Run `verify-findings` (with `--triage`) for the contested HIGH and MEDIUM findings, then `--check`.
3. **Final triage.** Triage updates **the same file** for the verified rows: the decision, plus `reliesOn` wherever it
   uses a verdict. `write-ledger-entries.mjs` then runs on that file.
4. `rebuttal` receives only the `inconclusive`, `over-cap` and `failed` items.

The detail goes in a new `references/contested-verification.md`, and SKILL.md stays within its size baseline.

**Where the saving comes from.** A dispute that a quoted line settles is decided within the round, with the evidence on
the record, instead of costing a full round to see whether the finding returns. The saving is expected, not measured
(§10).

### 4.5 Right-sizing
- **Band-aid**: keep running whole rounds to see whether a disputed finding returns, or keep prose GPT-vs-Claude
  deliberation (today's `rebuttal`), where neither side shows code.
- **Over-built**: an agentic tool-calling verifier with its own sandbox, model verdicts that auto-dismiss findings, or
  verifying every finding. Sashiko verifies only the inconclusive third.
- **Chosen**: a deterministic evidence pack behind one acquisition boundary, one call per contested finding, a
  code-checked eligibility rule, and triage keeping the decision. It is the smallest change that puts a quoted line in
  front of the decision.

### 4.6 Tests (`tests/contested-findings.test.mjs`, `tests/verify-findings-cli.test.mjs`)
1. **Fixtures derived from real rows (AGENTS.md).**
   - Real finding objects come from PR #395's `…1795028282052-47728` r1..r6 result files and ledger, trimmed to the
     fields that are read.
   - The tests assert the contested set selected for those rounds. The fixture records its source SID and file.
2. **Red→green, eligibility.**
   - A `refuted` verdict whose quote is absent from the pack is demoted. So is each of: an empty quote, a quote under 12
     characters, a quote that occurs only in `E0`, a quote citing a `[withheld]` item, and an unknown ref.
   - These fail before `validateVerdict` exists.
   - Negative control: a quote present in an eligible cited item stays `refuted`, labelled `evidence-backed` and nothing
     more.
3. **No auto-dismiss.** A `refuted` verdict with a triage of `accepted` yields a ledger entry that is `accepted`. No
   verification data is copied into the ledger, only `reliesOn` when the row declares it.
4. **States, end to end.**
   - 12 contested findings with `--max 10`: 10 are sent and 2 are `over-cap`.
   - One of the 10 gets a fake 429, so it is `failed`; the artifact has `complete: false` and the run exits 3.
   - The routing list contains the inconclusive, over-cap and failed items.
5. **Egress (Tier 3, same commit).** None of the following reaches the pack or the persisted artifact:
   - a cited `.env`;
   - a symlink into `~/.ssh`;
   - a grep hit in a sensitive path outside the cited file;
   - a secret that exists only in a historical blob reached through `git log -L`;
   - a test that prints an env var.
   The scrubbed env holds no `OPENAI_*`.
6. **`--run-test`.** A path taken from finding text is refused. An untracked path is refused. A tracked test runs.
7. **Artifact boundary.**
   - `validateVerifyItem`, which `--check` and the writer (for a `reliesOn` row) both call, refuses each of: a wrong `sid` or `round`, an edited result file (hash mismatch), an unknown
     `findingId`, a duplicate item, a tampered pack (`packHash` mismatch), and a stored verdict that fails
     re-validation.
   - The CLI exits 2 when `evidenceTree` differs from `auditedTree`.
   - **Tamper control (R2-H3).** An artifact whose cited code item was edited to contain a fabricated quote **and** whose
     `packHash` was recomputed is refused by provenance re-acquisition. The negative control is the untouched artifact,
     which is accepted.
   - **Reliance (R3-H1).** The tree moves after verification, and the triage has a row with `reliesOn` that item: the
     whole batch is refused with `re-triage`. Rows without `reliesOn` write normally. `--check` prints no `[verify:]` line
     for an item that fails validation.
7a. **Snapshot (R2-H2).**
   - A dirty audited tree: grep hits come from the working-tree bytes, not from `HEAD`.
   - A `--run-test` test that writes a file during the run exits 2 with `tree moved during verification`, and the fake
     client receives 0 calls.
   - An edit made between the round and the verification exits 2 before acquisition.
7b. **States and sources (R2-M2, R2-M3).**
   - Each state round-trips the strict schema, and a forbidden field on any state is rejected.
   - An `over-cap` item and a `failed` item each attach nothing.
   - An item whose `source.findingId` is absent from round N's result is refused.
   - A flip whose latest appearance precedes round N is listed in `notSelected`.
   - A quote taken only from a `test` item is demoted.
8. **Model.** `--model latest-sonnet` exits 1. The recorded model is the fake response's `model`.

### 4.7 Files (PR B)
`scripts/verify-findings.mjs` (new CLI: `--selfcheck-relocation`, `isInvokedAsScript`, `assertKnownFlags`, catalogue entry),
`scripts/lib/audit/contested-findings.mjs` (new: `selectContested`, `buildEvidencePack`, `validateVerdict`),
`scripts/lib/schemas.mjs` (verdict and artifact schemas, optional ledger `reliesOn`), `scripts/write-ledger-entries.mjs` (`reliesOn` check via `validateVerifyItem`),
`skills/audit-code/SKILL.md`, `skills/audit-code/references/contested-verification.md` (new), `package.json` (one script,
`audit:verify-findings`), `scripts/.cli-catalog.json`, `CLI_SMOKE_SET`, the sync closure, and tests. Consumer sync is a
Tier 3 seam: the CLI is synced, so the relocation/import test lands in the same commit.

---

## 5. PR C: defect corpus (miner drop report, suites, subsets)

### 5.1 Miner (`scripts/defect-harvest.mjs`, extended; no second miner)

- **Reproducible.**
  - `--rev <ref>` is resolved to an OID once, and `HEAD` is the default. `git log` runs on `<oid>` rather than on
    whatever `HEAD` is at the time.
  - **Every output-affecting input is in the output header (R2-H4).** The header is
    `inputs: {minerVersion, repo (basename), rev (oid), options: {sinceN, cleanSoak, cleanSurvival, maxDiffChars},
    curated: {path, digest}}`.
    - `curated.digest` is the `sha256` of the canonicalised `known-defects.json` that the `already-curated` filter read.
      That file is read as **`git show <corpusRev>:docs/experiments/audit-effectiveness/known-defects.json`** from the CES
      repo, where `--corpus-rev` defaults to CES's `HEAD` resolved to an OID. It is an immutable object, never the working
      copy, so the curated set is pinned the same way the mined history is.
    - `options` holds the **effective** values, defaults included, never only the flags the operator typed.
    - The header records no absolute roots and no timestamp. Records are sorted by `(fixCommit, buggyCommit)`.
  - **The guarantee is conditional, and it says so.** The output is byte-identical whenever `inputs` is byte-identical.
    The test changes each input on its own and expects the output to differ exactly where that input reaches.
- **The examined set is computed independently of the outcomes (R1-H10).** The universe is materialised first, as
  `selected = git rev-list --no-merges -n <sinceN> <oid>`, an ordered list of unique shas. It comes from git, not from the
  loop. The classifier then emits outcomes, and reconciliation asserts **set equality**: `set(outcomes.commit) === set(selected)`,
  with exactly one terminal outcome per commit.
  - A missing commit fails as `unclassified:<sha>`, and a duplicate as `double-classified:<sha>`.
  - Either failure **exits 3**, so the reconciliation can never be satisfied by a counter the loop itself increments.
- **The terminal outcome for a commit** is one of:
  - **`candidate`**: it yielded at least one pair with a known introducer.
  - **`candidate-unattributed`**: a pure-addition fix. It is kept with `buggyCommit: null` for a human to attribute.
    It is a candidate class, not a drop.
  - **`dropped:<reason>`**, from a closed enum:
    - `not-fix-typed`
    - `issue-ref-only`
    - `no-auditable-files`
    - `no-blame-introducer`
    - `all-introducers-filtered`: every blame introducer failed `introducer-not-ancestor`, `introducer-disjoint-files`
      or `already-curated`. The per-introducer reasons are listed under the commit.
    - `diff-too-large`: over the loader's `MAX_DIFF_CHARS`, so mining and loading share one bound.
    - `git-error`
- **Commits and pairs are counted separately.** One fix can yield several (introducer, fix) pairs, so the
  `dropReport` is
  `{selected, byOutcome:{candidate, candidate-unattributed, dropped:{…}}, pairs:{emitted, filteredByReason:{introducer-not-ancestor, introducer-disjoint-files, already-curated}}}`.
  The commit counts sum to `selected`. The pair counts are reported, and they are never mixed into the commit sum.
- **New filters from sashiko.** The introducer must be an ancestor of the fix (`git merge-base --is-ancestor`), and it
  must touch at least one file the fix touches.
- **Where the output goes.** It is written to `.audit/defect-candidates/<repo>-<rev12>.json` (gitignored, Category A).
  - The tracked `known-defects.candidates.json` is left untouched. Retiring it is a deletion, which is Louis's call (§9 F5).
  - The miner never writes `known-defects.json`. A test pins that the `--out` path refuses that filename.

### 5.2 Suites and subsets (`known-defects.json` → version 4)

- **`suite`** is a per-entry field. An absent field means `detect`, so the 18 existing entries need no edit.
  - **`detect`**: today's meaning.
  - **`missed`**: the buggy commit carries an `AI-Gate: passed|converged` trailer, so CES's own audit cleared it and a
    later fix proves it was wrong. The miner flags this from trailers alone (offline, no store), as `auditCleared: true`.
    The human decides whether it joins `missed`.
  - **`expect_clean`**: a commit the curator judges defect-free. The miner proposes such commits as `cleanCandidates`:
    every line they added is still attributed to them by `git blame` at `rev` (≥90% of added lines survive), at least
    `--clean-soak 200` commits have landed since, no candidate pair names them as introducer, and they are no larger
    than the same diff bound.
  - Soak is counted in commits, not time, so the result depends on `rev` and not on `now()`.
  - **Expect_clean entry schema (R1-H9).** An entry has `{id, repo, suite: 'expect_clean', commit, files, rationale,
    curation}`. It has no `buggyCommit`, `fixCommit` or `expectedFindingRubric`. `validateCorpus` enforces this per suite:
    a `detect`/`missed` entry needs `buggyCommit` and `expectedFindingRubric`, and an `expect_clean` entry needs `commit`
    and must have neither.
- **`subsets`** is top level: `{tiny: [ids], small: [ids]}`. `full` means every non-`invalidated` entry.
  - `tiny` is the runbook's **frozen anchor subset** (`model-eval-harness.md` Step 5): hand-listed and never re-drawn.
  - Every listed id must exist and not be `invalidated`. `validateCorpus` checks this.
- **`curation`** is required on every entry added from v4 on: `{method: 'human-review', reviewedIn: '<worksheet or PR ref>', miner: {version, rev} | null}`.
  - This cannot prove a human reviewed the entry. What it enforces is that the entry names where its review is recorded,
    and that the miner never writes truth (tested).
  - **Grandfathering covers a frozen set of identities, not a version number or a bare id (R1-H8, R2-M1).**
    `known-defect-corpus.mjs` exports `LEGACY_UNCURATED_KD`, a frozen array of the 18 entries present at `1df6fbfb`. Each
    element is `{id, repo, buggyCommit, fixCommit}`. A test pins the array to the values read with `git show 1df6fbfb:…`,
    and the array can only shrink.
  - **An entry is exempt from `curation` only if all four identity fields match a legacy element exactly.** Each of these
    loses the exemption and must carry `curation`:
    - removing a legacy entry and adding a different one under its id;
    - repointing a legacy id at another commit;
    - changing the repo.
  - **Prose edits keep the exemption.** Changing a legacy entry's `defectDesc`, `expectedFindingRubric`, `severity` or
    `evidenceHunk` is a correction, not a new identity.
  - **To correct an identity field deliberately**, add `curation` with `reviewedIn` naming the correction. That is the
    migration path: the validator then holds the entry to the v4 rule.

### 5.3 Selection and scoring (model-eval)
- `--subset tiny|small|full` is new. The default `full` keeps today's behaviour, minus KD-013.
  - The pool is restricted before the existing seeded `stratifiedSelectKDs`.
  - `invalidated` entries are filtered **always** (§9 F1, folded in because the subset filter is exactly that code path).
  - `--suite detect|missed|expect_clean` defaults to `detect`.
- **The expect_clean flow, end to end (R1-H9).**
  - **Load.** `loadCorpusCase` reads `entry.commit`, using the same `git diff <commit>^ <commit>` extraction, flags and
    `MAX_DIFF_CHARS` bound as a defect case. The existing invariant still holds: the declared `files` must appear in that
    diff (`declared_files_not_in_diff`). `hiddenGroundTruth` becomes `{suite: 'expect_clean', files}`, with no rubric.
  - **Audit.** Cases run through the same screen-tier extractor or promotion generation arm as defect cases. The audit
    input does not change, because the auditor must not be able to tell a clean case from a defect case.
  - **Score.** `deterministic-scorer.mjs` scores without a judge, as sashiko does.
    - A case scores `clean` when it has zero findings at MEDIUM or above on the case's `files`.
    - Otherwise it scores `false_positive`, and each finding's pass is recorded.
    - A case whose run failed or was unavailable scores `failed`. It counts in the denominator and never as `clean`
      (sashiko's strict denominator).
  - **Aggregate.** The suite block is `{cases, clean, falsePositive, failed, fpRate: falsePositive/(cases), measuredRate:
    (cases-failed)/cases}`. With zero cases the result is `unmeasured`, never `fpRate: 0`.
  - **Persist and verdict: none in v1, so no shared contract changes (R3-H3).** `VERDICTS` in
    `scripts/lib/model-eval/contracts.mjs:70 (1df6fbfb)` is `keep | switch | inconclusive | manual_review_required`, and
    stored runs and their readers depend on it. A `--suite expect_clean` run therefore **writes no store row and computes
    no verdict**.
    - It **requires `--out`** and writes a local report there: `{kind: 'expect-clean-report', stamp, perCase, suite}`,
      Category A, gitignored.
    - It exits 0 when every case was measured, and 3 when any case is `failed`. `unmeasured` (zero cases) also exits 3.
    - The run-bundle insert and `verdict.mjs` are not called on this path. A test asserts this by injecting a store
      writer that throws if called.
    - `detect` and `missed` runs keep today's persistence and verdict path unchanged.
    - Making clean-case results a stored, verdict-bearing artifact is a contract change (enum plus readers) and is out of
      scope (§11).
  - Folding false-positive rate into promotion is out of scope (§11). It needs a threshold that no data supports yet.
- **Stamped at the collector (R1-M1).** The run bundle's `evidence` gains a selection stamp:
  - `suite` and `subset`;
  - `corpusVersion`, plus `corpusDigest = sha256(canonical(corpus))` over the whole file, so an edit without a version
    bump still changes the stamp;
  - `corpusLoaderVersion: 'v2'`;
  - `selection: {seed, requestedN, selectedIds}`.
  `CORPUS_LOADER_VERSION` is bumped. Before `verdict.mjs` compares two arms or two runs, they must agree on `suite`,
  `subset`, `corpusDigest`, `corpusLoaderVersion` and `selectedIds`. Any mismatch is refused, naming the field. This is
  verify-by-match (AGENTS.md). It adds no collector and no background capture.

### 5.4 Growing the corpus, and who labels it
This PR ships the miner, the schema and the scorer. The **first mined batch** goes into a worksheet,
`docs/experiments/audit-effectiveness/kd-mining-2026-11.md`, in the existing `kd-curation-worksheet.md` format, with each
candidate's fix subject, introducer, diff stats and drop context.
- Entries enter `known-defects.json` only from rows Louis marks accepted, in this PR if he reviews it in time, or
  otherwise in a follow-up.
- I do not label truth myself, because a model-curated entry is the auto-labelled truth the task rules out.

### 5.5 Right-sizing
- **Band-aid**: hand-append more entries to `known-defects.json` with no drop report. Nobody then knows what the miner
  never surfaced.
- **Over-built**: full SZZ with forward blame across three repos, an LLM pre-labeller, or a curation web UI.
- **Chosen**: extend the existing miner with a closed drop enum and a reconciliation check, and add three
  `suite` values, two committed subset lists, and one judge-free scorer branch.

### 5.6 Tests (`tests/defect-harvest.test.mjs` extended, `tests/known-defect-corpus.test.mjs` extended, `tests/model-eval-subset.test.mjs`)
1. **Red→green.** `stratifiedSelectKDs` over the real corpus with `n = entries.length` never returns KD-013. It fails on
   `main`.
2. **Fixture repo** (built with `git init` in a temp dir, hermetic env: `GIT_CONFIG_NOSYSTEM`, `HOME` isolated). It holds
   one commit for each drop reason, plus a revert, a `Fixes <sha>`, a blame pair, a non-ancestor introducer and an
   `AI-Gate: passed` introducer.
   - Asserts each terminal outcome, and set equality with the `rev-list` universe.
   - Asserts byte-identical output across two runs with identical `inputs`. Then it changes `rev`, `sinceN`, `cleanSoak`,
     `--corpus-rev` (a curated pair added) and `minerVersion` one at a time, and asserts that the header changes each time
     and the body changes exactly where that input reaches (for example, the added pair moves to `already-curated`).
   - Asserts that `auditCleared` is set only on the trailer case.
   - **Multiple pairs.** One fix with three blame introducers: one passes, one is not an ancestor, one is already curated.
     The commit gives one `candidate`, and `pairs.emitted: 1` with the two filtered pairs counted by reason.
     A fix whose introducers are all filtered is `dropped:all-introducers-filtered`.
3. **Reconciliation guard (negative controls).** Injected faults:
   - a classifier that skips one commit, so it emits no outcome;
   - a classifier that emits two outcomes for one commit.
   Each makes the CLI exit 3, naming the sha. The guard therefore detects omission, and its counter is not
   self-satisfying.
4. **Corpus validation.**
   - A new id without `curation` fails.
   - Each of the 18 legacy identities passes without it. A legacy id repointed at another `buggyCommit` (or removed and
     re-added as a different entry) fails without `curation`. A legacy entry with only its `defectDesc` edited still passes.
   - A legacy id that carries a malformed `curation` fails.
   - `LEGACY_UNCURATED_KD` equals the `{id, repo, buggyCommit, fixCommit}` tuples read from `known-defects.json` at
     `1df6fbfb` (`git show`).
   - A subset naming an unknown or invalidated id fails.
   - An expect_clean entry carrying `buggyCommit` or a rubric fails, and so does a detect entry without one.
5. **Expect_clean, end to end** (fixture repo, fake extractor). A three-case suite: one clean, one with a MEDIUM finding
   (`false_positive`, with its pass recorded), and one whose call fails (`failed`). The persisted bundle carries the
   per-case outcomes, `fpRate: 1/3` and `measuredRate: 2/3` in the `--out` report. The run exits 3 because of the failed
   case, and an injected store writer that throws if called is never called. A zero-case suite is `unmeasured`, also
   exit 3. Running `--suite expect_clean` without `--out` exits 1.
   A clean case whose declared file is not in its diff is refused `declared_files_not_in_diff`.
6. **Stamp mismatch.** Comparison is refused in each case:
   - a `subset:tiny` run against a `subset:full` run;
   - two runs whose corpus differs by one edited rubric under the same `version` (the `corpusDigest` differs);
   - two runs with different `selectedIds`.
7. **The miner refuses `--out …/known-defects.json`.**

### 5.7 Files (PR C)
`scripts/defect-harvest.mjs`, `scripts/lib/model-eval/known-defect-corpus.mjs` (`validateCorpus`, the subset pool,
`CORPUS_LOADER_VERSION`), `scripts/model-eval-auditor.mjs` (flags, filter), `scripts/lib/model-eval/deterministic-scorer.mjs`,
`scripts/lib/model-eval/verdict.mjs` (stamp match), `docs/experiments/audit-effectiveness/known-defects.json` (v4: `subsets`,
the version bump), `docs/experiments/audit-effectiveness/kd-mining-2026-11.md` (new worksheet), `docs/runbooks/model-eval-harness.md`
(Step 5: the miner, the suites, `--subset`), and tests. `scripts/model-eval-auditor.mjs` is near the 1,000-line ratchet, so
logic goes in the lib module.

---

## 6. Cross-cutting gates (each PR, before `guards:preflight`)
- **New CLI** (PR B). Needs `CLI_SMOKE_SET`, `--selfcheck-relocation`, `isInvokedAsScript`, `assertKnownFlags`,
  `finishAndExit`, the `.cli-catalog.json` entry, the rmsync guard, and `emit` exit coupling. The memory tripwire applies:
  a new npm script trips two invariants.
- **New lib modules** (A, B). They are tagged by the existing `scripts/lib/audit/**` rule; no domain-map edit.
  `arch:refresh` runs after.
- **Size ratchets.** `size:ratchet:gate`: `legacy-production-audit.mjs` (1,710 lines) may only shrink, and PR A shrinks it,
  so it is re-baselined downward, which is the gate's own instruction. `skills:size:gate`: SKILL.md growth is offset.
- **Sync.** `npm run sync:dry` and `bundle:deps:check` cover the new modules entering the consumer closure, and the
  `docs:synced-links` and `skills:consumer-refs` gates cover the new references.
- **`fullSuite`.** This repo's full suite runs in Actions. Local runs are targeted suites plus `guards:preflight`, and the
  coordinator pushes.

## 7. File ownership (claim globs)
- **A**: `scripts/lib/audit/{call-record,llm-helpers,legacy-production-audit,pass-result-cache,planless-intent,findings-pipeline,gate-evidence}.mjs`,
  `scripts/openai-audit.mjs`, `skills/audit-code/**`, `docs/reference/environment-variables.md`, `tests/*call-record*`, `tests/*resume*`.
- **B**: `scripts/verify-findings.mjs`, `scripts/lib/audit/contested-findings.mjs`, `scripts/lib/schemas.mjs`, `scripts/write-ledger-entries.mjs`,
  `skills/audit-code/**`, `package.json`, `scripts/.cli-catalog.json`, `tests/*contested*`, `tests/verify-findings*`.
- **C**: `scripts/defect-harvest.mjs`, `scripts/model-eval-auditor.mjs`, `scripts/lib/model-eval/**`, `docs/experiments/audit-effectiveness/**`,
  `docs/runbooks/model-eval-harness.md`, `tests/*defect*`, `tests/*known-defect*`, `tests/model-eval-subset*`.
- `skills/audit-code/**` is shared by A and B. They are sequential, so B rebases on A.

## 8. Risks
| Risk | Mitigation |
|---|---|
| A replayed response hides a model-side change (the sentinel resolved to a new model between runs) | `wireModel()` is in the key, so a new model misses the record and the call goes live. |
| `auditedTree` captured differently between run 1 and the resume (a dirty tree edited in between) | A different tree is a different namespace, so the calls go live. That is correct: the bytes changed. |
| Records hold code-bearing prompts on disk | They live under gitignored `.audit/` with mode 0o700, pruned by count (newest 5 trees). This is the same exposure the existing `.audit-cache-<pid>` and transcript archive already have. |
| A verifier from the same family rubber-stamps | The quote is checked by code for eligibility only; `selfFamily` is stamped; and the verdict is evidence for triage, never a ruling. |
| A verification "refuted" is trusted beyond what it proves | It never dismisses. Triage decides, and no new ruling or suppression path exists (§4.4, R1-H6). |
| `missed` labels that come from trailers are wrong (the gate ran on a different tree) | The flag is a hint. A human decides membership (§5.4). |
| A spend surprise | §10. |

## 9. Findings (each recorded with `fleet propose`)
- **F1** (folded into PR C): `stratifiedSelectKDs` can draw `invalidated` KD-013. Evidence: no reader of `invalidated` in
  model-eval (grep at `1df6fbfb`).
- **F2** (proposed, not built): the CI-seam rounds of PR #395 each ran as a **fresh SID at r1**, so there was no ledger,
  R2+ suppression or rulings, and the cap restarted. "One more round" should continue the SID. This is a skill/coordinator
  process fix.
- **F3** (proposed): one concern raised by several passes (`be-services` + `Sustainability` + `Quickfix`) survives
  semantic dedup as two or three HIGHs (#395 `…1795035542408` r1), which inflates the HIGH count that drives "another
  round".
- **F4** (folded into PR A): `pass-result-cache.mjs`'s write-only cache claims to give a crashed run something to resume
  from, but it is PID-keyed and always deleted.
- **F5** (proposed, Louis's call): the tracked `known-defects.candidates.json` is generated but not reproducible (absolute
  roots, no rev). That is the generated-artifact policy's "messy middle". Retiring it means `git rm`, which needs Louis.

## 10. Spend
Normal `/audit-plan` and `/audit-code` rounds only. No corpus replay, model-eval or recall measurement is run in these PRs.
Measuring PR B's effect (for example, verifying #395's contested set live) or running the new suites through model-eval
would be a pinned `npm run fixture:create` run with a stated EUR cap, and the coordinator is asked first. The
expected saving from A and B is **expected, not measured**.

## 11. Out of scope
- `--resume` for the tiered pipeline and for plan mode.
- Batching verification over the cap.
- Cross-model replay.
- Mining wine and ai-organiser history (the miner takes `--roots`, but their curation is separate).
- Final-review `wrongly_dismissed` items as a verification contest kind. They stay on the gemini-gate Step 7.1
  deliberation path, which nothing here depends on (R3-H2).
- A stored, verdict-bearing expect_clean result: that needs a `VERDICTS` contract change, and folding the false-positive rate into promotion needs data to set a threshold (R3-H3).
- F2, F3 and F5.

## Audit trail
- **/audit-plan, SID `audit-plan-1795086122232-96060`** (2026-11-19). GPT rounds (HIGH / MEDIUM): R1 10 / 2, R2 4 / 3, R3 3 / 2. Every finding
  was accepted and fixed: 24 of 24 (acceptance 100% each round, with the ledger written and cloud outcomes labelled
  12/12, 7/7 and 5/5).
- **The soft cap (3) stopped the loop, not convergence.** HIGH ran 10→4→3. Structural card at R3: 1 STRUCTURAL,
  7 LOCAL? (unclassifiable), 0 polish.
  - The STRUCTURAL cluster was "Artifact Integrity", the verify→ledger seam in `write-ledger-entries.mjs`. Three open
    debt items already sit on that file.
  - Response: the seam was **narrowed** rather than patched again (§4.4). Nothing from verification is copied into the
    ledger; there is a `reliesOn` pointer, checked by the single `validateVerifyItem`.
  - Two R3 findings were resolved by **removing scope** (the final-review contest kind; stored expect_clean verdicts)
    rather than adding contract. Both are listed in §11.
  - No round 4. `--past-cap` is the coordinator's or Louis's call, and the final review below sees the narrowed seam.
- **Final review** (gemini, round 1 of 2): `CONCERNS`, gate `approve_with_debt` (blocking 0, debt 2), with no wrongly
  dismissed findings. Both non-blocking items were folded in rather than carried as debt:
  - G1 (MEDIUM): the two-pass triage ordering for kind-1 contests, in §4.4 Skill.
  - G2 (LOW): test 6a was split into a missing-directory arm and an envelope-mismatch arm.
  No second final-review round, because nothing blocking remained.

## Implementation log
_(filled during /cycle code)_
