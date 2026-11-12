# Plan: Test-Campaign Controls — heartbeat, audit canary, close-out claims check, `/plan --campaign`

- **Date**: 2026-11-08
- **Status**: Complete — shipped in #329, #332 and #333 (canary 11/11). Optional: make `AUDIT_CANARY` on by default (needs a structured detection field first).
- **Author**: Claude + Louis Strydom
- **Scope**: backend (CLI + skill prose)
- **Stack**: `js-ts`
- **Target domain(s)**: `fleet`, `audit-core`, `skills`
- **Execution**: single unit under `/cycle --autonomous` (no §11 block — the four
  pieces share no source file except skill markdown, and one union-diff audit
  is cheaper than four).

---

## 1. Context Summary

An evaluation campaign in a consumer (wine-cellar-app, capstone E5) had method
failures that no existing skill would have stopped: a labelling blind spot both
labellers shared (NONE-NONE counted as agreement), an agreed blind audit marked
done but never run, a 429 quota forcing a model swap from uncommitted code, no
feasibility check before pre-registration, runs that died silently, lost
provenance, one adjudicator, write-up errors, pieces merged without a ledger.
CES has its own record of the same class (an audit round that lost every pass to
429s read as clean; five false "window met" reads; spend-bearing runs killed by a
moving tree; a hardcoded telemetry zero).

A `/brainstorm` (GPT + Gemini + debate) converged on: **no 18th skill, no fleet
daemon** — four small primitives, weighted toward readiness (a dress rehearsal)
and close-out rather than a longer form. The owner approved all four and asked
for the checklist to be back-tested against the real incidents (§6).

### Code trace (where each piece plugs in)

1. **Audit honesty** — `formatAuditSummaryLine` (`scripts/lib/audit/findings-pipeline.mjs:397`, 6830fd07)
   refuses the counts-first shape for INCOMPLETE; `computeAuditVerdict` (`:355`)
   downgrades PASS→INCOMPLETE on `incomplete`; `assembleFindings`
   (`scripts/lib/audit/finding-assembly.mjs:~865`) computes verdict + convergence
   once; `openai-audit.mjs:953` sets exit 3; `countFindings` (`scripts/audit-loop.mjs:79`)
   folds INCOMPLETE into `failed`. **The canary only has to produce INCOMPLETE —
   every downstream consumer already treats it as "not evidence".**
2. **Pass prompts** — every legacy pass builds through the one wrapper
   `passPrompt` (`scripts/lib/audit/legacy-production-audit.mjs:815`) →
   `buildCachePrompt` → `buildAuditPassPrompt`, whose LAST message is the code
   (`prompt-builder.mjs` msg #3). Appending there keeps the cacheable prefix
   byte-stable.
3. **Fleet status** — `cmdStatus` (`scripts/lib/fleet/commands.mjs:186`) composes
   independent lines (`prune.line`, `proposalsLine`, `upstreamLine`). A runs line
   joins them.
4. **Skill size** — `skills/{fleet,plan,audit-plan,ship}/SKILL.md` are all over the
   12K-char ratchet (`npm run skills:size:gate`), so every addition is offset by
   moving prose to `references/` and the shrink re-baselined.

### Neighbourhood considered

`get-neighbourhood` (2026-11-08): `heartbeatRefreshRun`
(`scripts/lib/store/arch/refresh-runs.mjs:128`, band `precedent`, above-floor-cluster)
— a DB-row liveness stamp for `arch:refresh`, store-bound, not reusable for a
file journal any process can append. `loadHeartbeat`/`isOverdue`
(`scripts/lib/maintenance-heartbeat.mjs`) — the shape precedent: a missing or
future timestamp reads as "never run", never as healthy; **copied as a rule, not
imported** (single JSON record, daily cadence, no per-run identity).
`scripts/lib/persona-test/canary.mjs` — a different canary (a persona session
expecting contradictions); no shared code. Decision: two new sibling modules.

## 2. Proposed Architecture

### 2.1 Heartbeat + stale-watch (`/fleet`)

- **`scripts/lib/run-heartbeat.mjs`** (pure + fs append). A run journal is JSONL,
  one file per run id, in **`<git-common-dir>/audit-loop/runs/<runId>.jsonl`** —
  the common dir, so a pinned `fixture:create` worktree's run is visible from
  every checkout's `/fleet status`. **Inside git there is no fallback**: an
  unwritable common dir makes `start`/`run` exit non-zero naming the path (a
  worktree-local fallback would silently break cross-worktree visibility). Only
  outside git is the dir `.audit/runs/` (gitignored, Category A).
  Line: `{v:1, ts, runId, kind:'start'|'beat'|'end', staleAfterSec?, pid?, childPid?, note?, exitCode?, signal?}`.
- **Run id grammar** (every CLI and library entry point): `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`
  and no `..`; the resolved path must stay inside the runs dir (checked after
  `path.resolve`), and an existing journal that is a symlink is refused. Tests:
  traversal, absolute path, `\` separator, 81-char id.
- **Lifecycle** — `start` creates the journal with an **exclusive create**
  (`flag: 'wx'`), so a reused id — including two concurrent launches — fails
  before anything is spawned; `run` reserves first, **then** spawns, then appends a
  `beat` carrying `childPid`; if that append fails the child is killed and reaped
  and the wrapper exits non-zero (no untracked child). The latest `childPid` in
  the journal is the one probed; `beat`/`end` refuse a journal with no `start`; a line found after `end`
  (only a hand edit can produce one) is ignored and reported. Appends are single `appendFileSync` writes of one line
  (< 4 KiB, O_APPEND), so concurrent writers interleave whole lines; order is file
  order. A malformed line anywhere is skipped and counted (`malformedLines`); a
  journal whose only lines are malformed is UNKNOWN.
- **`assessJournal(entries, {now, staleAfterSec?})`** → `{state, reason, lastTs, ...}`,
  state ∈ `RUNNING | STALE | ENDED_OK | ENDED_FAILED | UNKNOWN`.
  **UNKNOWN, never RUNNING**, when: no file, no parseable line, no `start`, no
  declared `staleAfterSec`, or a timestamp more than 60s in the future. STALE = no
  `end` and `now - lastTs > staleAfterSec`. **STALE means "no progress observed",
  not "stopped"**: the verdict carries `childAlive: true|false|unknown` from a
  `process.kill(childPid, 0)` probe of the recorded pid, so the operator can tell a
  hung run from a dead one (pid reuse makes `true` a hint, said so in the docs).
  The reader scans the **whole** journal (no tail window — a window can lose the
  `start` or the `end` record). Size is bounded at the writer instead: beats are
  throttled to one per 5 s (≈ 2 MB per day of continuous output), and `end` is
  **terminal at the writer** — `beat`/`end` refuse a journal that already has an
  `end`, so nothing legitimate follows it. Tests cover a > 1 MB journal in the
  running, stale and ended states, and malformed lines in its middle.
- **CLI `scripts/run-heartbeat.mjs`**: `start | beat | end | run | check | watch | list`.
  - `run --run-id X --stale-after S -- <cmd…>` — the **launch convention** for a
    command that does not beat itself: writes `start` (before spawn, no
    `childPid`), a `beat` carrying `childPid` right after spawn, a `beat` on child
    output (throttled to one per 5s), an `end` with exit code/signal, and
    exits with the child's code. A spawn error writes `end` with `exitCode: 127`.
    SIGINT/SIGTERM to the wrapper are **forwarded** to the child and the wrapper
    waits for it, then writes `end`. **An uncatchable wrapper death (SIGKILL, a
    closed terminal on Windows) writes no `end`, and the child may survive** — the
    journal goes STALE and `check` reports `childAlive`, which is the honest
    statement; v1 is not a supervisor and does not claim to stop the child.
  - `check` — one verdict; exit 0 RUNNING/ENDED_OK, 1 ENDED_FAILED, 3 STALE/UNKNOWN
    (3 = "not evidence of health", the INCOMPLETE convention).
  - `watch` — polls, prints one line per state change, **exits on a terminal
    state** (ENDED_*, STALE, UNKNOWN). This is what the launching session arms with
    Claude Code's `Monitor` (or `Bash run_in_background`), so a stale journal
    wakes that session. It is not a daemon: a Monitor expires (≤30 min) and must be
    re-armed; an expired watcher is **not** a health signal and the docs say so.
  - `list` — every journal + verdict (JSON for `fleet status`). Ended journals
    older than 14 days are skipped (not deleted); unended ones are always listed.
- **`/fleet status`** gains one `runs:` line (`2 running · 1 STALE <id> (last beat 41m ago)`)
  from `summariseRuns()`. Runs dir absent ⇒ no line (nothing was launched); runs
  dir **unreadable** ⇒ `runs: UNMEASURED (<reason>)` — never omitted, never zero.
- Docs: `skills/fleet/references/background-runs.md` (convention + Monitor/
  scheduled-task recipe); a 2-line pointer in `skills/fleet/SKILL.md`.

### 2.2 Known-answer canary in audit rounds (opt-in)

- **`AUDIT_CANARY=1`** (default unset ⇒ byte-identical prompts and results).
- **`scripts/lib/audit/canary.mjs`**:
  - `createCanary({seed})` → a virtual file `audit-canary/<id>.mjs` (id from the
    round's run identity, so it varies by round) holding one unambiguous defect:
    an authorization check written as an assignment (`if (user.role = 'admin')`),
    which grants every caller admin. Small (~400 chars) so its cost is a
    measurable rounding error.
  - `makeCanaryPlanter(canary)` → `plant(built, opts)`: appends the canary file to
    the last (code) message of **every eligible wave-2 correctness pass**
    (`backend`, `be-routes`, `be-services`, `frontend`), in its single call or, for
    a map-reduce pass, its **first unit** (`unitLabel` `''` or `Audit Unit 1/…`;
    never the `probe` cache-seed call). Selection is by pass NAME, not call order,
    so it is deterministic under the async map-reduce dispatch; a retry rebuilds
    the prompt and is planted again. Cost stays small: ~100 tokens per planted pass.
  - `resolveCanary(canary, passResults, failedPasses)` → `{status, planted, detectedIn, missedIn}`
    and the pass results with every canary-cited finding **removed** (so a canary
    finding never reaches the ledger, cloud store, debt capture or counts).
    **Match rule** (two conditions, both required): the finding's normalised `file`
    equals the canary's virtual path, **and** its text (category + detail +
    recommendation) names the planted defect **as an assignment** — `/\bassign/i` or
    an explicit `=`-for-`===`/`==` statement — together with the guarded subject
    (`/admin|role|authori[sz]/i`). "Use a named constant for the admin comparison"
    does **not** match (no assignment), nor does any naming/style finding; both are
    still stripped. Any severity counts. **Stated limit**: this is keyword
    evidence that the defect was named, not proof the model understood its
    effect; the canary is a floor against a blind, truncated or degraded pass, not
    a recall estimate. Detection reads each planted pass's **returned result** (the final
    attempt after `safeCallGPT`'s own retries; for map-reduce, the post-REDUCE
    output — a reduce that drops the canary is pipeline blindness and is reported
    as such), **before ledger suppression** (R2+ suppression could eat it).
- **Fail closed when enabled** — with `AUDIT_CANARY=1` **only `detected` in every
  planted pass is evidence**. `missed` (any planted pass), `not-planted` (no
  eligible pass ran: e.g. `--passes structure`, a docs-only scope) and
  `unsupported-pipeline` (tiered pipeline, v1) all make the round `INCOMPLETE`
  with `convergence = {converged:false, reason:'canary-<status>'}`; a
  `pass-failed` round is already INCOMPLETE. Exit 3, `countFindings.failed`,
  AI-Gate refusal follow from the existing INCOMPLETE path.
  `formatAuditSummaryLine` gains a `canary` input and names the reason
  (`Verdict: INCOMPLETE — the planted canary defect was not reported by backend
  (the auditor was blind this round)…`). Result carries
  `_canary: {status, planted, detectedIn, missedIn, chars}` (declared in
  `AuditRunResultSchema`). Flag unset ⇒ no `_canary` key and no behaviour change.
- **MECHANICAL_WAVES**: unchanged — the canary is **not a wave** (no
  `PASS_PROMPTS` entry, no model call of its own), so the shadow cannot enrol it.
- **Cost measurement** (the reason for opt-in): one A/B pair, same scope,
  `--passes backend`, flag off vs on; report Δ input/output tokens from `_usage`.

### 2.3 Close-out claims check (`/ship` + campaign close-out)

No new engine. A named `/ship` step, **Step 1.5 — Close-out claims check**: when
the change carries a write-up or status report (`docs/research/**`, a results doc,
a `status.md` entry, a plan's status/audit trail with figures), every figure must
carry `measured`/`derived`/`expected` and the command or artifact it came from,
and every line citation is pinned (`node scripts/check-doc-citations.mjs <doc>`,
existing). An untraceable figure is fixed or settled with `/investigate` before
the commit. Detail in `skills/ship/references/claims-check.md`; the campaign
close-out (§2.4 C11) points at the same step.

### 2.4 Campaign mode on `/plan` + `/audit-plan` checks

- `/plan --campaign <task>` loads `skills/plan/references/campaign.md` and emits
  `- **Mode**: campaign` plus a `## Campaign Contract` with sections **C1–C12**
  (§6 is their back-test). No 18th skill.
- **`scripts/lib/campaign-contract.mjs`** — the ONE list of section ids + required
  fields, and `checkCampaignContract(markdown)` → `{ok, problems:[{id, field?, why}]}`.
  **Field grammar** (documented in `campaign.md`): inside the `## Campaign Contract`
  section each item is a `### C<n> — <title>` heading; a required fact is a line
  `- **<field>**: <value>` within that item. Required fields:
  C1 `decision`, `metric`, `error-costs` · C2 `split`, `test-set-hash`, `access-record` ·
  C3 `bound`, `assumptions` (bound must contain a digit) · C4 `controls`, `independence` ·
  C5 `telemetry`, `fill-check` · C6 `revision`, `model`, `spend-limit`, `heartbeat` ·
  C7 `items` (integer ≥ 5), `evidence` (a repo-relative path) ·
  C8 `canary`, `evidence` · C9 `contract-epoch` · C10 `ledger` · C11 `done-evidence` ·
  C12 `claims-check`. Problems: missing section, **duplicate** section, missing or
  empty field, a C3 `bound` with no digit, a C7 `items` below 5 or non-integer, an
  `evidence`/`done-evidence` value that is not a repo-relative path (absolute,
  drive-letter, `..` segment, or resolving outside the repo root), no
  `## Campaign Contract` section at all. An empty value or `TBD` counts as missing.
  Evidence values are a path in backticks or bare; `done-evidence` may list several,
  comma-separated.
- **CLI `scripts/campaign-contract-check.mjs <plan> [--closeout] [--json]`** — exit 0
  complete, 1 problems found, 2 unreadable input / bad usage (stderr names it).
  `/audit-plan` runs it when the plan declares campaign mode and files each
  problem as a HIGH finding.
- **The execution boundary, stated plainly.** The contract check proves the plan
  *declares* a rehearsal and a canary — it cannot prove either ran. Execution is
  the campaign's own pipeline, and its evidence is the artifact the plan named.
  So `--closeout [--rev <ref>]` (run at campaign close-out, C11; default rev
  `origin/main`) additionally verifies that every `evidence`/`done-evidence` path
  exists **as a committed, non-empty regular file at that immutable revision**
  (`git ls-tree <oid> -- <path>` must report mode `100644`/`100755` and type
  `blob` — a symlink, mode `120000`, is refused because its blob is the link text,
  not the artifact; the rev is resolved to an OID first) and prints the
  OID and the SHA-256 of the committed content for the close-out record. Untracked,
  branch-only and working-tree-only files are problems (exit 1) — B15's "linked
  but on an unmerged branch" is exactly that case. Evidence produced before merge
  is checked with `--rev <branch>` during review and again at `origin/main` after. Whether the artifact *shows* a
  passing rehearsal stays a reviewer judgement, and both SKILL.md files say so.
- A test compares `campaign.md`'s C-headings with the code's list **in both
  directions** (prose↔code seam rule).
- Model swaps stay routed to the existing synchronous model-eval harness
  (`docs/runbooks/model-eval-harness.md`); campaign mode adds no collector.

### Key design decisions

| Decision | Why | Rejected alternative |
|---|---|---|
| Journal in git common dir | a pinned-fixture worktree run must be visible from the coordinator's checkout | per-worktree `.audit/` (invisible across worktrees) |
| `watch` exits on terminal state | maps 1:1 onto Monitor / run_in_background "wake me once" | a daemon (rejected by the brainstorm; nothing runs between turns) |
| Canary in every wave-2 correctness pass (by name), detection before suppression | ~100 tokens per pass is cheap; name-keyed selection is deterministic under async dispatch; R2+ suppression would hide a canary read after it | a separate canary call (tests a call that is not the audit); "first call" selection (races under map-reduce) |
| Contract check is presence-only | substance needs a reviewer; a mechanical "adequacy" check would be theatre | no mechanical check (a missing dress rehearsal would pass silently) |

## 3. Right-sizing

- **Band-aid**: prose checklists only — the brief's own incidents show prose was
  present (a protocol, a ledger) and was not followed; nothing fired.
- **Over-built**: a campaign skill, a fleet daemon, a figure-provenance linter
  over prose (high false-positive rate), a canary per pass.
- **This plan**: two small libs + two CLIs with exit codes callers already
  understand (3 = not evidence), one opt-in env flag, one presence check, and
  prose that names the existing tools. Each mechanical piece fires on an incident
  in §6.

## 4. Sustainability Notes

- No file in `.file-size-baseline.json` grows: `legacy-production-audit.mjs` /
  `openai-audit.mjs` edits are net-zero (logic lives in `canary.mjs`).
- New CLIs: `isInvokedAsScript` guard, `assertKnownFlags`, `finishAndExit`,
  `--selfcheck-relocation`, CLI catalog entry, `CORE_ENTRY` in
  `sync-entry-lists.mjs` (synced SKILL.md files name them).
- Env var documented in `docs/reference/environment-variables.md`.

## 5. File-Level Plan

| File | Intent |
|---|---|
| `scripts/lib/run-heartbeat.mjs` | (create) journal path, append, parse, `assessJournal`, `summariseRuns` |
| `scripts/run-heartbeat.mjs` | (create) CLI |
| `scripts/lib/fleet/commands.mjs` | (modify) `runs:` line in `cmdStatus` |
| `scripts/lib/audit/canary.mjs` | (create) create / plant / resolve |
| `scripts/lib/audit/legacy-production-audit.mjs` | (modify) plant via `passPrompt`; resolve before assembly |
| `scripts/lib/audit/finding-assembly.mjs` | (modify) canary-missed ⇒ INCOMPLETE + non-convergence |
| `scripts/lib/audit/findings-pipeline.mjs` | (modify) `formatAuditSummaryLine` canary clause |
| `scripts/lib/audit/run-finalization.mjs` | (modify) attach `_canary` |
| `scripts/lib/schemas.mjs` | (modify) `_canary` |
| `scripts/openai-audit.mjs` | (modify) pass `_canary` to the summary line |
| `scripts/lib/campaign-contract.mjs` | (create) section list + check |
| `scripts/campaign-contract-check.mjs` | (create) CLI |
| `scripts/lib/sync-entry-lists.mjs`, `scripts/.cli-catalog.json` | (modify) register CLIs |
| `skills/fleet/SKILL.md`, `references/background-runs.md` | (modify/create) |
| `skills/plan/SKILL.md`, `references/campaign.md` | (modify/create) |
| `skills/audit-plan/SKILL.md` | (modify) campaign check step |
| `skills/ship/SKILL.md`, `references/claims-check.md` | (modify/create) Step 1.5 |
| `docs/reference/environment-variables.md` | (modify) `AUDIT_CANARY` |
| `tests/run-heartbeat.test.mjs`, `tests/audit-canary.test.mjs`, `tests/campaign-contract.test.mjs`, `tests/ship-claims-check-step.test.mjs` | (create) |
| `.skill-size-baseline.json` | (modify) re-baseline shrinks |

Close-out: `npm run skills:regenerate && npm run skills:check`, both size gates,
`npm run guards:preflight`.

## 6. Back-test — every campaign item against a real incident

**Rule**: an item that names no incident it would have caught is dropped.
Sources: `wine-cellar-app/docs/capstone/e5-status-ledger-2026-11-08.md` (B1–B16) and
`wine-cellar-app/docs/capstone/e5-protocol.md` Amendments 1–2 (A1.n / A2.n); CES AGENTS.md + docs as cited.
"Brief" = incident reported in the commissioning brief (2026-11-08) with no
ledger number.

| Item | Contract requirement | Incidents it would have caught |
|---|---|---|
| **C1** Decision + metric | The decision the result informs, the error costs, the metric derived from them; state the base where the metric is trivially satisfied | B9 ("100% vintage agreement" — all 37 NL/ZA inputs had no vintage); A1.3 (57 cases cannot certify 0.95 — the market question was not decidable as posed) |
| **C2** Split, leakage, sealed test custody | Group-aware split by canonical identity; test set hash (proves identity, not secrecy) + an access record; "test once" = one recorded authorised run; a changed rule ⇒ fresh test set; post-hoc analysis labelled exploratory | A1.5c (cross-source twins: 495 of 683 same-name groups — same wine on both sides of a split); B5 (sensitivity rule written after the core errors were seen — post hoc for core); B12 (agreement report untimestamped, so "before adjudication" unprovable) |
| **C3** Feasibility / power | Before pre-registration: can the declared rule produce a non-empty result? State the bound with its assumptions (e.g. 0 errors in 50 HITs ⇒ one-sided 95% lower bound on precision only ≈94.2%) | A1.5a (no feasibility check; ≥59 error-free HITs needed); B5 (rule empty under T null on both strata — knowable in advance); A2.7 (erratum: the floor's arithmetic was mis-explained) |
| **C4** Instrument + controls over the WHOLE pipeline | Controls that exercise candidate generation, not only the decision; labellers sharing an input are not independent; ≥2 adjudicators or a stated limit | A1.5b (labelling index searched producer+wine words only — 14% of rows invisible to BOTH labellers); B8 (g305 NONE-NONE probably wrong); B7 (24 market NONE labels with no independent check); A2.6 (one adjudicator); B4 (different labeller model/prompt/index across strata — confounded comparison); CES 2026-11-08 (this plan's own canary, skipped in 7 of 12 runs while its path announced it — §10) |
| **C5** Declared telemetry + day-0 fill check | Every column the analysis reads is declared; day 0 checks each fills with a real value (a zero is a measurement only if something measured it) | B10 (Cohere reported-model field empty on all 57 calls); CES hardcoded telemetry zero (memory `feedback_fabricated_telemetry_zero`); CES reader matching 0 findings in 7 sessions (`severity` vs `code`, `docs/reference/testing-doctrine.md` §prose↔code seam) |
| **C6** Operations | Pinned revision via `npm run fixture:create`; model identity recorded from the response; price review / quota / spend limit checked before the run; artifact hashes by tool; a heartbeat run id per run (§2.1) | B2 (labels from code not on main; model swapped after a 429); A2.2 (`command-a-plus` monthly cap on a production key); CES 2026-08-17 (~$13 lost: two spend runs killed by a rebase and a concurrent commit — AGENTS.md §pinned revision); B11 (adjudication files missing); Brief (overnight runs that silently died) |
| **C7** Dress-rehearsal gate | Before the real run: N ≥ 5 items end to end through the real pipeline writing real artifacts, hashes verified, telemetry filled, canary detected | B13 (`SHA256SUMS` lists itself — a rehearsal hash check fails on day 0); A1.5b (an in-catalogue item with an empty `wine` field fails to surface); CES tiered-shadow window "met" at 100% `fallback_legacy` (`docs/plans/tiered-recall-audit-pipeline.md` addendum 2026-07-14) |
| **C8** In-run canary | A known-answer item per batch/round; a miss makes the batch INCOMPLETE, not clean | CES unmeasured round (every pass lost to 429s printed `INCOMPLETE H:0 M:0 L:0`, exit 0 — AGENTS.md); A1.5b (a planted known in-catalogue item hidden from the index would have exposed the blind spot during labelling) |
| **C9** Contract epoch / evidence eligibility | Evidence counts only if stamped with the contract it was produced under; a meaning-changing fix bumps the epoch and re-collects | CES five false "window met" reads (AGENTS.md §Model swap harness — contractEpoch); B2 (labels produced under a model main does not name) |
| **C10** Deviations ⇒ owner before merge | Anything "outstanding", "differs" or deviating from the contract goes to the owner before merge; a campaign ledger | B16 (pieces merged one at a time with no ledger; #1247 merged with known gaps); B2 (#1248 "no audit") |
| **C11** Done = artifact + verification | "Done" names the artifact on main and how it was verified | B1 (supervisor-agreed blind label audit marked done, never run); B15 (sibling-gate analysis linked but on an unmerged branch); B14 (build plan still "E5 pending") |
| **C12** Close-out claims check | Every figure in the write-up traces to an artifact and carries measured/derived/expected (§2.3) | B3 ("identity not retrieved" — g319 was retrieved, rank > 5); B6 (core write-up not updated after the blind-spot finding); B4 (comparison stated without its confound); CES 22.5% reduction with a false attribution (AGENTS.md §verification discipline) |
| **Model swap** (routing rule, not a section) | A swap is a synchronous model-eval harness run, never a background window | A2.2 (swap mid-campaign from uncommitted code); CES passive collection killed arm-eval (AGENTS.md §Model swap harness) |

**Dropped (no incident)**: external pre-registration (OSF) — the pre-registration
held (A2: core result stands as registered); multiple-comparison correction —
nothing in E5 or CES turned on one; an inter-rater κ threshold as a gate — the
incidents were about the instrument's shared blind input (C4), not a κ value.

## 7. Testing Strategy (red-then-green for each new check)

Each new check is first run against its target **before** the fix to show it
fails, then green:

1. **Heartbeat** — `tests/run-heartbeat.test.mjs`: missing journal ⇒ UNKNOWN;
   start with no beat past `staleAfterSec` ⇒ STALE (withheld heartbeat); a real
   `run` wrapper spawned around a long-sleeping child, **wrapper killed** ⇒ no
   `end`, STALE once the injected clock passes the threshold, `childAlive`
   reported (then the child is killed by the test); clean exit ⇒ ENDED_OK with the
   child's exit code propagated; non-zero ⇒ ENDED_FAILED; spawn of a missing
   binary ⇒ ENDED_FAILED 127; future timestamp ⇒ UNKNOWN; malformed lines counted
   and skipped; duplicate `start` refused and a `run` with a taken id spawns
   nothing; `beat` after `end` refused; > 1 MB journal keeps start and end; run-id traversal/absolute/`\`/overlong
   refused; unreadable runs dir ⇒ UNMEASURED in the fleet line. Negative control:
   a fresh beat ⇒ RUNNING (the check does not fire on a live run).
2. **Canary** — `tests/audit-canary.test.mjs`: plant into every eligible pass and
   map-reduce unit 1 only (never `probe`), byte-identical when disabled; resolve
   on canned pass output ⇒ `detected` + finding stripped; a non-canary finding
   with the same category is not a match; a canary-file finding about naming only
   ⇒ not detected (and stripped); "use a named constant for the admin role
   comparison" ⇒ not detected; missing in one of two planted passes ⇒
   `missed`; `not-planted` and `unsupported-pipeline` ⇒ INCOMPLETE; summary line
   wording; assembly-level: missed ⇒ INCOMPLETE + non-converged. **Orchestration
   test** through the existing `runMultiPassCodeAudit` regression harness with a
   stubbed client: the canary text reaches the backend prompt, the canary finding
   is absent from the final result's `findings` (what the ledger, cloud and debt
   writers read), and the verdict is INCOMPLETE when the stub omits it. Red: the
   summary/verdict tests run against the pre-change code first.
3. **Campaign contract** — `tests/campaign-contract.test.mjs`: complete fixture ⇒
   ok; each section removed ⇒ that id reported; each required field emptied or
   `TBD` ⇒ reported; C7 `items: 3` and `items: five` ⇒ reported; duplicate section
   ⇒ reported; no contract section ⇒ reported; CLI exit 2 on an unreadable path;
   C3 bound without a digit, absolute / `..` / drive-letter evidence ⇒ reported;
   `--closeout` in a temp git repo: untracked evidence ⇒ exit 1, committed only on a
   branch and checked at the base rev ⇒ exit 1, committed at the rev ⇒ OID + hash
   printed (working-tree edits after commit do not change the hash); a committed
   symlink as evidence ⇒ exit 1;
   campaign.md headings and field names ⇔ code list, both directions.
4. **Claims step** — `tests/ship-claims-check-step.test.mjs`: `/ship` SKILL.md
   names Step 1.5 and its reference; campaign.md C12 points at it. Honest label:
   guards presence of the step, not its execution.

## 7b. Implementation Phases

1. Heartbeat lib + CLI + fleet line + docs + tests.
2. Canary lib + wiring + schema + env doc + tests; measure cost.
3. Campaign contract lib + CLI + `/plan` + `/audit-plan` prose + tests.
4. `/ship` Step 1.5 + reference + test.
5. Size offsets, regenerate, gates.

## 8. Risk & Trade-off Register

| Risk | Mitigation |
|---|---|
| Canary finding persisted as a real finding | stripped from raw pass results before assembly; test asserts absence |
| Canary too obvious ⇒ measures only gross blindness | stated: it is a floor (catches lost/truncated/degraded passes), not a recall estimate |
| Monitor expiry read as "healthy" | `watch` docs + `/fleet` reference: expiry is not a verdict; re-arm or `check` |
| Journal in git common dir not writable | `start`/`run` exit non-zero naming the path — no silent local fallback |
| Wrapper killed, child keeps spending | STALE + `childAlive` reported; docs give the identity-checked stop (`check` prints the child pid and command) |

## 10. Implementation Log (2026-11-08)

### Red-then-green, per new check (measured: mutate the check, run its test, restore)

| Check | Mutation | Red | Green |
|---|---|---|---|
| Heartbeat STALE | stale branch `if (false)` | 5 of 21 fail (withheld beat, killed wrapper, > 1 MB journal, fleet line, `watch`) | 21 pass, 1 skip (symlink on Windows) |
| Canary verdict | `canaryBlocked = false` | 2 of 15 fail (blind round, not-planted) | 15 pass |
| Canary match rule | drop the assignment test | 1 fail ("named constant" accepted) | 15 pass |
| Canary `section` match | `section` branch `return false` | 6 of 15 fail | 15 pass |
| Contract C7 items / closeout mode | `n < 0`; mode check `if (false)` | 2 of 15 fail | 15 pass |
| `/ship` Step 1.5 | (presence test only — guards the step's presence, not its execution) | — | 3 pass |

Commands: `node --test tests/run-heartbeat.test.mjs`, `tests/audit-canary.test.mjs`,
`tests/campaign-contract.test.mjs`, `tests/ship-claims-check-step.test.mjs`.

### What the live runs caught that review did not

1. **The canary matched on a field the producer never emits.** Producer findings
   (`ProducerFindingSchema`) carry the location in `section`; `file` is derived later.
   The first live run (flag on) printed `missed` with the model having reported the
   defect — a `file`-only matcher reads every real report as a miss. The hand-written
   fixtures used `file` and so encoded the same wrong assumption (AGENTS.md §prose↔code
   seam). Fixed: `citesCanary` matches `section` or `file`; fixtures now use the producer
   shape; a mutation of the `section` branch turns 6 tests red.
2. **A plant that announces itself gets skipped.** With the virtual file at
   `audit-canary/c<id>.mjs`, the `be-services` pass named the defect in **5 of 12** live
   runs (measured: 4/8 at the medium reasoning ceiling, 1/4 with
   `OPENAI_AUDIT_REASONING=high`; every miss was a pass reporting zero findings). Renamed
   to a neutral `src/access/console-guard-<id>.mjs`: **6 of 6** detected (measured).
   Same lesson as C4: a known-answer item must be indistinguishable from a real one.
3. **A tightened match rule rejected real reports.** `/audit-code` R2 asked for a rule
   that "Do not assign the admin role; check authorization" cannot satisfy. The first
   tightening (require the noun "assignment") read 3 of 6 live reports as misses; the
   stderr excerpt showed the real wording — *"assigns 'admin' to user.role instead of
   comparing it"*. The verb form (`assign… instead of/rather than compar…`) was added and
   two of those live texts are now verbatim fixtures. Final rule: **4 of 4** live runs
   detected (measured). Across all 16 neutral-path runs the pass anchored a finding on
   the canary file every time (measured from the `[canary]` stderr lines); the misses
   were the matcher's, not the auditor's.

### Canary token cost (measured, one-file scope, `--passes backend`, air-gapped store)

| Arm | Input tokens | Output tokens | costUsd |
|---|---|---|---|
| flag off | 9,721 | 87 | 0.0102 |
| flag on, neutral path (6 runs) | 9,796–9,798 | 359–439 | 0.0116–0.0120 |

Δ ≈ **+75 input tokens** (measured) and ≈ +270–350 output tokens (measured; the pass
writes the canary finding), ≈ **+$0.0014–0.0018 per planted pass** (measured). On this
tiny scope that is +14–18%; on a normal round (≈ 100k input tokens across 5 passes, 1–2
planted) it is a fixed ≈ $0.002–0.004, i.e. under 1% (derived from the per-pass delta).
Command: `AUDIT_CANARY=1 AUDIT_DB_URL= LEARNING_DISABLE=1 node scripts/openai-audit.mjs code docs/plans/test-campaign-controls.md --files scripts/lib/mechanical-waves.mjs --passes backend --no-tools --no-debt-ledger --out <file>`.
Detection was measured on one scope and one model; it stays opt-in until a few real
rounds confirm the rate.

## 9. Audit Trail

### `/audit-plan` — SID `audit-plan-1794169638872-253164`, 2026-11-08

| Round | Verdict | H | M | Accepted | Main corrections |
|---|---|---|---|---|---|
| R1 | SIGNIFICANT_GAPS | 6 | 2 | 8/8 | run-id containment; canary fails closed when enabled; deterministic plant + match rule; wrapper signal/child-survival honesty; no silent in-git fallback; execution boundary of C7/C8 + `--closeout`; journal lifecycle; field grammar |
| R2 | NEEDS_REVISION | 5 | 0 | 5/5 | start metadata preserved; canary match requires the defect; evidence path containment; close-out reads the committed blob; reserve-before-spawn |
| R3 | NEEDS_REVISION | 2 | 1 | 3/3 | match requires "assignment"; whole-file scan with writer-side bound; regular-file mode check |

**Stop decision**: stopped at the 3-round cap. HIGH fell 6 → 5 → 2 with 100%
acceptance each round (productive, not rigor pressure); R3's items were
small, concrete and fixed. **Gemini final gate** (`gemini-4-argon`, round 1):
`APPROVE`, disposition `approve`, 0 blocking, 1 LOW (the `run` bullet still said
`start` carries `childPid`) — fixed in place.

### `/audit-code` — SID `audit-code-1794173720725-238204`, 2026-11-08 (base `38e171d8`)

| Round | Verdict | H | M | Disposition |
|---|---|---|---|---|
| R1 (diff, 40 files) | SIGNIFICANT_ISSUES | 17 | 14 | ~19 distinct after cross-pass duplicates; 26 fixed, 5 dismissed (concurrent-append race: reader is order-defined; synced-path pointer: the sync rewrites it; 3 adjacency enumeration-cap notes) |
| R2 | SIGNIFICANT_ISSUES | 6 | 2 | pid-record failure handling, canary rule tightening, anchor-only stripping (overrules R1-H15), size wording; 1 dismissed |
| R3 | SIGNIFICANT_ISSUES | 5 | 2 | anchor at section start, `./` evidence paths, `watch --grace` documented, platform-true `childAlive` |
| R4 | SIGNIFICANT_ISSUES | 3 | 5 | GPT deliberation: H3/M4 (self-check body, AGENTS.md non-finding) and M3 dismissed; H1, H2 → MEDIUM and M2 → LOW, all fixed; broken-worktree and close-out timing fixed |
| R5 | SIGNIFICANT_ISSUES | 1 | 2 | anchor = first path token, whole-path match; keyword-limit re-raise dismissed as the R4 concern |
| R6 | SIGNIFICANT_ISSUES | 1 | 2 | root-level file anchors, `./` citations, git-failure ≠ "not committed" — all fixed |

Every new guard added in R1–R6 was proven by mutation: the guard removed, its test
red, restored, green (scratchpad harnesses `mutate*.cjs`; 18 mutations, 18 red).

**Stop decision (round 6, structural-or-stop card)**: 2 STRUCTURAL clusters, both the
canary matcher in `canary.mjs` (a prose rule each round could probe with a new sentence),
55 polish. Decision: **STOP** — the rule passes all 16 live neutral-path samples and every
adversarial negative raised; the flag is opt-in and the keyword-evidence limit is
documented. The structural fix (a structured detection field in the pass schema rather
than matching prose) is the follow-up if `AUDIT_CANARY` is ever made default-on.

**Gemini final gate** (`gemini-4-argon`, round 1, run `9ee137f8`): `APPROVE`, disposition
`approve`, 0 blocking, 1 LOW (G1: `main(argv)` was half-honoured by the ambient flag
helpers) — fixed. The review envelope reported `Code: PARTIAL, 1306 changed line(s) never
shown`: the approval covers the examined files, not the whole 40-file change.
