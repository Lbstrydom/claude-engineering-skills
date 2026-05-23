# Plan: Phase D — Persistent Tech-Debt Memory

- **Date**: 2026-04-05
- **Status**: Complete (shipped — `.audit/tech-debt.json` ledger + `scripts/lib/debt-ledger.mjs` (+ cloud `debt_entries` Supabase table). `/audit-code` Step 3.6 "Debt Capture" + Step 5.1 "Debt Resolution Prompt" both wired. Status line corrected 2026-05-23.)
- **Author**: Claude + Louis
- **Scope**: Persist out-of-scope audit findings as a committed, repo-level debt ledger. Feed debt into normal audit suppression (zero resurfacing of known debt), track recurrence occurrences, and provide a standalone `debt-review` LLM pass that clusters debt into actionable refactor plans. Extend with advisory severity escalation, GitHub Actions PR surfacing, and team-ownership / per-file debt budgets.
- **Parent plan**: follows Phase C (linter pre-pass) — builds on `LedgerEntrySchema` (Phase B) and `suppressReRaises()` (Phase 0)
- **Depends on**: Phase B ClassificationSchema, Phase 0 session ledger + suppression pipeline

---

## 1. Context Summary

### Problem

Audit-loop currently has two terminal states for a finding:

1. **In-scope** → adjudicated via Claude-GPT deliberation, recorded in session ledger, suppressed in R2+
2. **Out-of-scope / pre-existing** → documented in `-audit-summary.md`, then forgotten

State (2) is a leak. On the Phase B code audit we had 11 findings, zero related to the Phase B diff — all flagged pre-existing architectural concerns in files Phase B didn't touch. On Phase C, 14 HIGH findings surfaced, 2 real bugs in Phase C code, 12 pre-existing. Those 12 pre-existing HIGHs cost GPT tokens to find, Claude tokens to triage, and will cost the same again next time any adjacent file is audited. They're also real concerns that deserve visibility beyond a markdown file nobody reads.

### Observed patterns from three audit summaries

| Pattern | Occurrences |
|---|---|
| `scripts/openai-audit.mjs` god module (~82KB) | Phase B H3, Phase C H4, H6 |
| `scripts/lib/findings.mjs` god module + globals | Phase B H3, Phase C H11, H14 |
| `scripts/gemini-review.mjs` mixed concerns (540 lines) | Phase B M3 |
| `semanticId()` identity model prose-derived | Phase B H1, Phase C H10 |
| Module-global mutable state | Phase B H3, M5; Phase C H11 |
| Ledger fail-open recovery | Phase B H2 |
| Tool/model cross-source dedup | Phase C H13 (documented limitation) |

These repeat across audits. If we had tracked them, Phase C's audit would have suppressed 8 of 12 HIGHs automatically and surfaced the recurrence as a **cluster** signal: "`openai-audit.mjs` has accumulated 3 systemic findings across 2 audits → candidate for refactor pass."

### Why Not Just Ignore Them

Three failure modes with ignoring:

1. **Token waste** — every audit re-finds + re-deliberates the same issue
2. **Noise dilution** — real Phase-specific bugs get buried in 30+ pre-existing findings
3. **Signal loss** — recurrence is itself information; a LOW that shows up 7 times is different from a LOW that shows up once

### Key Requirements

1. **Persistent, committed ledger** — `.audit/tech-debt.json`, schema-compatible with session ledger
2. **Hybrid capture (option C)** — orchestrator auto-captures challenged/out-of-scope findings during Step 3 deliberation, then Claude reviews + confirms before write
3. **Zero resurfacing of untouched debt** — debt merged into `suppressReRaises()` input. No new suppression path
4. **Auto-reopen on change** — if `--changed` overlaps a debt entry's `affectedFiles`, existing reopen logic surfaces it for deliberation
5. **Recurrence tracking** — `occurrences` counter incremented on every suppression match
6. **Standalone refactor planner** — `debt-review` LLM pass clusters by file/principle/recurrence, outputs structured refactor plan
7. **Advisory escalation** — opt-in flag surfaces debt with `occurrences >= N` for re-deliberation
8. **PR surfacing** — GitHub Action comments on PRs when touched files have deferred debt
9. **Ownership + budgets** — CODEOWNERS-style assignment, per-file budget thresholds

### Non-Goals

- Automatic LLM-driven severity escalation (v1 is advisory — human decides)
- Mutating debt entries' severity based on occurrences (record occurrences, surface them, let humans decide)
- Replacing the session ledger (Phase 0/R2+ behavior) — this is additive
- Cross-repo debt federation

---

## 2. Proposed Architecture

### 2.1 Debt Ledger Schema

**New file**: `.audit/tech-debt.json` (committed to repo — durable human-approved decisions)
**New file**: `.audit/local/debt-events.jsonl` (LOCAL ONLY, gitignored — high-frequency
operational telemetry; see §2.3 and fix H2 below)

Fix H2 (R1 audit) — telemetry must not live in committed state. The ledger
(low-frequency, human-approved) is committed. The event log (high-frequency,
per-audit-run) is:

1. **Primary home**: Supabase `suppression_events` table (we already use this via
   `recordSuppressionEvents()` in learning-store.mjs). Add a `debt_events` table
   alongside it. Cloud-first, always-on when `SUPABASE_AUDIT_URL` is set.
2. **Local fallback**: `.audit/local/debt-events.jsonl` — gitignored, kept for
   offline/no-cloud workflows. `readDebtLedger()` reads from cloud if configured
   and reachable; falls back to local log when cloud is unavailable. **Never
   merges the two sources** — exactly one is authoritative per read. Precedence
   order (fix R2-H1):
   a. If `SUPABASE_AUDIT_URL` is set AND connection succeeds → cloud is authoritative
   b. If cloud is configured but unreachable → local fallback, logs a warning
   c. If cloud is unconfigured → local is authoritative
   Each run logs which source it used. Mixed-mode execution is an explicit error.

Fix R3-H3 (split-brain healing) — offline runs write local events; when the
next run successfully reaches cloud, it performs a one-shot reconciliation:

1. Read local `.audit/local/debt-events.jsonl`
2. For each local event, check if an event with the same `{runId, topicId, event}`
   tuple exists in cloud `debt_events`
3. If missing → INSERT into cloud (idempotent via unique constraint)
4. If present → skip (cloud wins, local was stale)
5. After successful reconciliation, append a marker line to the local log:
   `{"event":"reconciled","ts":"...","runId":"..."}` so subsequent runs can skip
   already-reconciled events

This is a best-effort heal, NOT eventual consistency. If the local log is
deleted between runs, those events are lost. Operators running in
intermittently-connected environments should periodically commit-push their
local log manually OR accept the gap (documented in SKILL.md).

Contract: the system is NOT split-brain within a single audit run (exactly one
source is authoritative per run, chosen at start). Split-brain risk is
bounded to offline-run data visibility, which is what the reconciliation step
addresses.
3. **Never committed.** `.audit/local/` is added to `.gitignore` as part of this
   phase.

This matches the existing architecture: `audit_runs`, `suppression_events`, and
`audit_findings` are already cloud-persisted. Debt events are the same kind of data.
No new persistence tier introduced.

Fix H1 — do NOT extend `LedgerEntrySchema` blindly. Session ledger fields like
`resolvedRound`, `ruling`, `rulingRationale`, `adjudicationOutcome`, `originalSeverity`
are R2+ deliberation artifacts that don't apply to deferred debt.

**Additional Fix H1b (R1 audit)** — split persisted vs hydrated state explicitly,
matching Phase B's ProducerFindingSchema/PersistedFindingSchema pattern. Runtime
fields that come from event-log replay are NOT part of the persisted contract:

- `PersistedDebtEntrySchema` — what's actually stored in `.audit/tech-debt.json`.
  No `occurrences`, `lastSurfacedAt`, `lastSurfacedRun`, `escalated`, `escalatedAt`
  — those are all derived.
- `HydratedDebtEntrySchema` — persisted fields + derived runtime fields. What
  `readDebtLedger()` returns after event replay. Used by suppression + debt-review.
- `DebtEventSchema` — individual event-log line shape.
- `DebtEntrySchema` alias = `HydratedDebtEntrySchema` for convenience at read sites.

```javascript
// scripts/lib/schemas.mjs — NEW DebtEntrySchema (composed, not extended)

// Shared core fields (topicId, semanticHash, severity, category, section, affectedFiles,
// affectedPrinciples, pass, detailSnapshot) — extracted into a DRY base for both ledgers.
const LedgerCoreFields = {
  topicId: z.string(),
  semanticHash: z.string(),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  category: z.string(),
  section: z.string(),
  detailSnapshot: z.string(),
  affectedFiles: z.array(z.string()),
  affectedPrinciples: z.array(z.string()),
  pass: z.string(),
  // Phase B classification envelope (optional — legacy entries may lack it)
  classification: ClassificationSchema.nullable().optional(),
};

export const DebtEntrySchema = z.object({
  ...LedgerCoreFields,
  // Phase D-specific fields:
  source: z.literal('debt'),                           // fix H2 — explicit source marker
  deferredReason: z.enum([
    'out-of-scope',        // finding cites code not in this audit's scope
    'blocked-by',          // requires an upstream change first
    'accepted-permanent',  // team decision to keep as-is indefinitely (fix M4)
    'deferred-followup',   // will be fixed in a named follow-up PR (fix M4)
    'policy-exception'     // violates policy but has governance signoff
  ]),
  deferredAt: z.string().datetime(),
  deferredRun: z.string().max(40),
  deferredRationale: z.string().min(20).max(400),      // min 20 chars — no rubber-stamp rationales
  occurrences: z.number().int().min(1),                // derived from event log (see §2.3)
  lastSurfacedRun: z.string().max(40).optional(),
  lastSurfacedAt: z.string().datetime().optional(),
  owner: z.string().max(80).optional(),
  escalated: z.boolean().optional(),
  escalatedAt: z.string().datetime().optional(),
  // Fix R2-H4 / R2-M1: per-reason required fields via discriminated union.
  // Zod 4 syntax: z.discriminatedUnion('deferredReason', [...variants]) is
  // applied at the schema root; this inline shape becomes one of several
  // variants. See §2.4 eligibility table for the full per-reason contract.
  blockedBy: z.string().max(200).optional(),           // required when deferredReason='blocked-by'
  followupPr: z.string().max(120).optional(),          // required when deferredReason='deferred-followup'
  approver: z.string().max(120).optional(),            // required when deferredReason='accepted-permanent' | 'policy-exception'
  approvedAt: z.string().datetime().optional(),        // required when deferredReason='accepted-permanent'
  policyRef: z.string().max(200).optional(),           // required when deferredReason='policy-exception'
  // Fix H4 (R1 audit) — alias mitigation for semanticId drift.
  // When a topic re-surfaces with a different content hash (paraphrased by GPT),
  // we record the alias so future matches find this entry. This is a tactical
  // mitigation, NOT a replacement for the deeper semanticId redesign documented
  // as recurring debt in prior audits (Phase B H1, Phase C H10).
  //
  // Fix R2-H3 (ACCEPTED LIMITATION): Phase D deliberately reuses topicId as
  // both suppression-match key and durable identity. A full identity-model
  // redesign (separate `debtId` with robust cross-source matching) is a
  // substantial piece of work that would itself become a Phase E. Rationale
  // for deferral:
  //   1. The underlying semanticId concern has surfaced in 3 consecutive
  //      audits (Phase B H1, Phase C H10, Phase D R1-H4) — it IS the kind of
  //      recurring debt Phase D is designed to track. Phase D should track it,
  //      not fix it.
  //   2. contentAliases catches the common drift case (paraphrased restatement)
  //   3. session-wins topicId collision resolution is a known, documented
  //      policy — not a silent conflict
  //   4. Phase D's suppression value is much greater than its identity cost:
  //      20% imperfect matching beats 0% suppression
  // The identity model redesign is explicitly out of scope, tracked as a
  // Phase D debt entry on first run ("Phase E candidate: unified identity").
  contentAliases: z.array(z.string().max(12)).max(20).default([]),
  // Sensitivity flag (fix H6) — true if any affectedFiles matches isSensitiveFile().
  // Blocks debt-review from sending the entry to external models.
  sensitive: z.boolean().default(false),
});

// Existing LedgerEntrySchema gets a source marker added for disambiguation.
// Migration: existing entries without `source` default to 'session' at read time.
export const LedgerEntrySchema = z.object({
  ...LedgerCoreFields,
  source: z.literal('session').default('session'),     // fix H2
  // Session-only R2+ fields:
  adjudicationOutcome: z.enum(['dismissed', 'accepted', 'severity_adjusted']),
  remediationState: z.enum(['pending', 'planned', 'fixed', 'verified', 'regressed']),
  originalSeverity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  ruling: z.enum(['sustain', 'overrule', 'compromise']),
  rulingRationale: z.string(),
  resolvedRound: z.number(),
});

export const DebtLedgerSchema = z.object({
  version: z.literal(1),
  entries: z.array(DebtEntrySchema),
  // Budget spec — glob support via micromatch (decision from §8)
  budgets: z.record(z.string(), z.number().int().min(0)).optional(),
  lastUpdated: z.string().datetime().optional(),
});
```

Fix H2 — `suppressReRaises()` gets a source-aware filter update:

```javascript
// lib/ledger.mjs — updated filter (see §2.4)
const suppressible = entries.filter(e =>
  // session-ledger dismissals + fixes (existing behavior)
  (e.source === 'session' && (
    e.adjudicationOutcome === 'dismissed' ||
    e.remediationState === 'fixed' ||
    e.remediationState === 'verified'
  ))
  // debt-ledger entries (new behavior — all non-escalated debt suppresses)
  || (e.source === 'debt' && !e.escalated)
);
```

This keeps the `dismissed` vocabulary pure (it means "GPT overruled in deliberation")
and makes debt suppression an explicit separate concept.

### 2.2 Debt Ledger Writer

**New module**: `scripts/lib/debt-ledger.mjs`

```javascript
// Uses Phase B's batchWriteLedger contract ({inserted, updated, rejected}) with
// validation at the write boundary. Occurrences are NOT written here — they're
// derived from event log replay (see §2.3) to avoid race conditions.
//
// Fix H3 (R1 audit): all ledger mutations go through a single-writer flock +
// atomic-rename pipeline. Read-modify-write on `.audit/tech-debt.json` uses:
//   1. Acquire exclusive advisory lock on .audit/tech-debt.json.lock
//   2. Read ledger (capture revision hash = sha256 of file bytes)
//   3. Mutate in memory
//   4. Atomic write (temp + rename, reuses Phase 0 atomicWriteFileSync)
//   5. Release lock
// proper-lockfile (widely used, cross-platform) handles locking with retries
// and stale-lock detection. Same pattern protects writeDebtEntries(),
// resolveDebtEntry(), and the backfill import pipeline.

export const DEFAULT_DEBT_LEDGER_PATH = '.audit/tech-debt.json';
export const DEFAULT_DEBT_EVENTS_PATH = '.audit/local/debt-events.jsonl';  // local only (fix H2)

/**
 * Write new debt entries OR update mutable fields of existing entries.
 * Never writes `occurrences`, `lastSurfacedRun`, `lastSurfacedAt` — those come
 * from replaying debt-events.jsonl (fix H3).
 *
 * @returns {{ inserted, updated, rejected }}
 */
export function writeDebtEntries(entries, { ledgerPath = DEFAULT_DEBT_LEDGER_PATH } = {}) { ... }

/**
 * Read debt ledger. Returns empty on ENOENT; throws on corruption (fail-loud).
 * Hydrates `occurrences`/`lastSurfacedAt` by replaying debt-events.jsonl.
 */
export function readDebtLedger(ledgerPath = DEFAULT_DEBT_LEDGER_PATH,
                               eventsPath = DEFAULT_DEBT_EVENTS_PATH) { ... }

/**
 * Merge session + debt ledger entries for suppressReRaises() input.
 * Both ledgers share topicId space; on collision debt loses (fix M1) because
 * the session ledger reflects the current audit's active decisions, which are
 * more specific than historical debt state.
 *
 * @returns {object} { version: 1, entries: [...] } — the merged ledger
 */
export function mergeLedgers(sessionLedger, debtLedger) {
  const byTopic = new Map();
  // Debt first, session second — session wins topicId collisions (fix M1)
  for (const e of debtLedger.entries) byTopic.set(e.topicId, { ...e, source: 'debt' });
  for (const e of sessionLedger.entries) byTopic.set(e.topicId, { ...e, source: 'session' });
  return { version: 1, entries: [...byTopic.values()] };
}

/**
 * Resolve a debt entry — call after a finding it tracks has been fixed.
 * Removes the entry from the ledger and appends a 'resolved' event.
 */
export function resolveDebtEntry(topicId, { runId, rationale,
                                            ledgerPath = DEFAULT_DEBT_LEDGER_PATH,
                                            eventsPath = DEFAULT_DEBT_EVENTS_PATH } = {}) { ... }
```

### 2.3 Occurrence Tracking (append-only event log, race-safe)

**New file**: `.audit/debt-events.jsonl` — one JSON object per line, append-only.

Fix H3 — occurrences are never written in-place. They're recorded as events:

```jsonl
{"ts":"2026-04-05T12:00:00Z","runId":"audit-phaseb-1775344731","topicId":"abc123","event":"surfaced"}
{"ts":"2026-04-05T14:12:00Z","runId":"audit-phasec-1775371054","topicId":"abc123","event":"surfaced"}
{"ts":"2026-04-06T09:15:00Z","runId":"audit-refactor-...","topicId":"abc123","event":"resolved","rationale":"fixed in PR #42"}
```

Event types:
- `deferred` — entry added to debt ledger
- `surfaced` — entry matched by suppression in an audit run
- `reopened` — entry's files were in `--changed` (not a suppression)
- `escalated` — `--escalate-recurring` gate flipped `escalated=true`
- `resolved` — entry removed (underlying issue fixed)

On read, `readDebtLedger()` replays events per topicId:
- `distinctRunCount` = count of **unique `runId` values** across `surfaced` events
  (the primary recurrence metric — fix M1)
- `matchCount` = total count of `surfaced` events (raw match count, for analytics)
- `occurrences` alias = `distinctRunCount` (the value status cards + escalation
  gate use; named `occurrences` for continuity with earlier plan text)
- `lastSurfacedAt` = timestamp of most recent `surfaced` event
- `escalated` = most recent `escalated` event without a subsequent `resolved`

Fix M1 (R1 audit) — emit ONE `surfaced` event per topicId per run, not per
suppression match. A single audit run that matches the same debt topic in
multiple passes records one event with `{ matchCount: N }`, not N events.
This makes "occurrences ≥ 3" mean "surfaced in 3 distinct runs," which is the
semantically meaningful escalation signal.

Escalation lifecycle:
- `escalated` event flips `escalated: true`, bypasses suppression for that run
- Resolution (`resolved` event) clears escalation state
- Re-deferral after escalation creates a new `deferred` event with the same
  topicId, keeping historical `surfaced` events intact (they still count
  toward `distinctRunCount` unless the entry was `resolved` in between)

Append is concurrent-safe via filesystem `O_APPEND` semantics + line-oriented JSONL.
Two parallel runs both `fs.appendFileSync()` — Node writes whole lines atomically on
POSIX and Windows up to PIPE_BUF (4KB), well above a single event line. Uses existing
`AppendOnlyStore` infrastructure from `findings.mjs`.

`--read-only-debt` CLI flag suppresses all event writes for CI environments that
want debt suppression without mutating the committed log.

### 2.4 Orchestrator Capture Flow (Hybrid — Option C)

**Modified file**: `.claude/skills/audit-loop/SKILL.md` + `.github/skills/audit-loop/SKILL.md`

Fix H5 (R1 audit) — model validity, scope, and action as three separate
decisions, not conflated. H4's original design required CHALLENGE to precede
DEFER, which wrongly forced Claude to artificially dispute findings it agreed
with just to get them into debt. Corrected model:

```
Step 3 — Triage (existing + extended)
  For each finding, Claude records three orthogonal judgments:

    validity: valid | invalid | uncertain
      - valid     = concern is real
      - invalid   = finding is wrong (cite evidence)
      - uncertain = needs GPT deliberation

    scope:    in-scope | out-of-scope
      - in-scope      = within this audit's target (diff/plan/files scope)
      - out-of-scope  = cites code outside the audit target

    action:   fix-now | defer | dismiss | rebut
      - fix-now  = goes into Step 4 fix list
      - defer    = eligible for debt capture (see below)
      - dismiss  = no action, no record
      - rebut    = send to GPT rebuttal (existing)

  Rules:
    - validity=invalid → action must be dismiss or rebut
    - validity=valid + scope=in-scope → action must be fix-now (HIGH/MEDIUM)
    - validity=valid + scope=out-of-scope → action=defer is eligible
    - validity=uncertain → action must be rebut
    - Only validity=valid findings can be deferred
    - accepted-permanent debt is the narrow exception: validity=valid +
      in-scope + team accepts the tradeoff (e.g., "we choose not to fix this")

Step 3.5 — Update Session Ledger (existing, unchanged)

Step 3.6 — Debt Capture (NEW)
  Eligible candidates = findings where action=defer.
  For each candidate, Claude:
    - Assigns deferredReason (out-of-scope | blocked-by | accepted-permanent
      | deferred-followup | policy-exception) — matches the triage reasoning
    - Writes deferredRationale (≥20 chars, schema-enforced, explains WHY
      beyond the reason tag)
    - Optionally sets followupPr for 'deferred-followup' reason
    - Computes sensitive flag from affectedFiles (fix H6)
    - Checks for existing debt entry with matching topicId OR contentAlias;
      if found, appends an alias and does NOT create a duplicate entry
    - Calls writeDebtEntries() → .audit/tech-debt.json (single-writer locked)
    - Emits 'deferred' event to event log
    - Reports in status card: "Deferred N findings to tech-debt ledger"
```

This keeps DEFER deliberate (every defer requires rationale) without forcing
spurious CHALLENGE cycles. A finding can be valid, out-of-scope, and
immediately deferred without going through rebuttal.

Fix R2-H2 (approval workflow) — the debt ledger is "committed, human-approved"
because the operator running audit-loop IS the approver. The hybrid-capture
flow IS the approval mechanism:

1. Operator runs `/audit-loop`, reviews each deferrable finding in Step 3 triage
2. Operator writes explicit `deferredRationale` (≥20 chars) — no bulk defer
3. Orchestrator calls `writeDebtEntries()` with operator-approved records only
4. Git commit of the updated ledger is the final gate — operator sees the diff
   before pushing

Branch/merge semantics:
- Debt ledger updates go in the Step 4 fix commit, or a separate
  `chore(debt): defer N findings` commit when no code changed
- `writeDebtEntries()` sorts entries by `topicId` so merges produce stable,
  localized diffs
- Never auto-push — operator's normal PR flow handles review

CI environments (`--read-only-debt`) NEVER write to the committed ledger.
Only interactive audit-loop runs driven by a human operator mutate it.

Fix R2-H4 (business-rule consistency) — the eligibility rules from §2.4 need
per-reason refinement. Different `deferredReason` values have different
validity × scope preconditions:

| deferredReason | validity | scope | Additional required fields |
|---|---|---|---|
| `out-of-scope` | valid | out-of-scope | — |
| `blocked-by` | valid | any | `blockedBy: string` (issue/PR/debt-id ref) |
| `deferred-followup` | valid | any | `followupPr: string` (required, not optional) |
| `accepted-permanent` | valid | any | `approver: string` (who signed off), `approvedAt` |
| `policy-exception` | valid | any | `policyRef: string` (link to policy doc), `approver` |

Fix R2-M1 (per-reason required fields) is folded into this table — the schema
enforces per-reason required fields via a Zod discriminated union.

Re-deferral: if the same topicId surfaces in a later audit and Claude again
decides to defer it, we update `lastSurfacedAt` via the event log but do NOT
create a duplicate ledger entry. The orchestrator inspects existing debt
before writing.

### 2.5 Suppression Integration

**Modified file**: `scripts/openai-audit.mjs` (R2+ initialization block)

```javascript
// Load session ledger (existing)
const sessionLedger = ledgerFile ? loadSessionLedger(ledgerFile) : { version: 1, entries: [] };

// NEW: load debt ledger (default path, opt-out via --no-debt-ledger)
const debtLedger = noDebtLedger
  ? { version: 1, entries: [] }
  : readDebtLedger();  // replays debt-events.jsonl for occurrences
process.stderr.write(`  [debt] Loaded ${debtLedger.entries.length} debt entries\n`);

// Merge for suppression (session wins topicId collisions — fix M1)
const mergedLedger = mergeLedgers(sessionLedger, debtLedger);

// Existing suppressReRaises() call — no signature change, source-aware filter added
const { kept, suppressed, reopened } = suppressReRaises(
  allFindings, mergedLedger, { changedFiles, impactSet }
);

// NEW: emit 'surfaced' events for debt-backed suppressions (race-safe append)
if (!readOnlyDebt) {
  const debtEvents = [];
  for (const s of suppressed) {
    const entry = mergedLedger.entries.find(e => e.topicId === s.matchedTopic);
    if (entry?.source === 'debt') {
      debtEvents.push({ ts: new Date().toISOString(), runId: SID, topicId: s.matchedTopic, event: 'surfaced' });
    }
  }
  // Also emit 'reopened' events for debt entries whose files changed
  for (const r of reopened) {
    const entry = mergedLedger.entries.find(e => e.topicId === r._matchedTopic);
    if (entry?.source === 'debt') {
      debtEvents.push({ ts: new Date().toISOString(), runId: SID, topicId: r._matchedTopic, event: 'reopened' });
    }
  }
  if (debtEvents.length > 0) {
    appendDebtEvents(debtEvents);
    process.stderr.write(`  [debt] Logged ${debtEvents.length} debt events\n`);
  }
}
```

**CLI flags**:
- `--no-debt-ledger` — skip loading `.audit/tech-debt.json` entirely
- `--debt-ledger <path>` — override default ledger path
- `--debt-events <path>` — override default event log path
- `--read-only-debt` — load debt for suppression but never append events (CI/parallel-run safety)

Fix R3-H1 (end-to-end suppression) — `gemini-review.mjs` must also honor the
debt ledger. Options considered:

- (a) Wire the same `readDebtLedger()` + `suppressReRaises()` pipeline into
  `gemini-review.mjs` before Gemini formats findings
- (b) Strip debt-matching topics from the transcript at the boundary where
  `openai-audit.mjs` hands off to `gemini-review.mjs`

Plan chooses (b). Rationale: Gemini's job is independent review of the
Claude-GPT transcript. If debt was already suppressed upstream, the transcript
shouldn't include debt-matched findings at all. Adding suppression inside
Gemini duplicates logic. Instead, `openai-audit.mjs` includes debt suppression
stats in the transcript envelope so Gemini can see "N findings were suppressed
as known debt" without needing to re-evaluate them.

Concrete change: the transcript-building step adds a
`_debtSuppressionContext` block summarizing suppressed topicIds, and Gemini's
prompt gets a line: "N findings were known debt and pre-filtered — do not
resurface them." If Gemini raises a NEW finding that matches debt, it goes
through the same merge path as GPT findings did.

**Reopen behavior (unchanged)**: if a debt entry's `affectedFiles` overlap `--changed`,
`suppressReRaises()` marks it `_reopened: true` and the debt re-surfaces for deliberation.
A `reopened` event is logged (distinct from `surfaced`); it does NOT count toward occurrences.

### 2.6 Debt Review LLM Pass

**New module**: `scripts/debt-review.mjs`

```bash
node scripts/debt-review.mjs [--out <file>] [--since <days>] [--owner <name>]
                             [--write-plan-doc] [--ttl-days 180]
```

Input: debt ledger + event log, optionally filtered
Output: **Zod-validated structured output** → markdown + optional plan doc

Fix M5 — GPT returns structured JSON, markdown is derived:

```javascript
// scripts/lib/schemas.mjs — NEW
export const ClusterSchema = z.object({
  id: z.string().max(20),                          // e.g. 'cluster-god-module-openai'
  title: z.string().max(120),
  kind: z.enum(['file', 'principle', 'recurrence']),
  entries: z.array(z.string()),                    // topicIds
  rationale: z.string().max(500),
});

export const RefactorCandidateSchema = z.object({
  clusterId: z.string().max(20),
  targetModules: z.array(z.string().max(120)).max(10),
  resolvedTopicIds: z.array(z.string()).max(50),
  effortEstimate: z.enum(['TRIVIAL', 'EASY', 'MEDIUM', 'MAJOR', 'CRITICAL']),
  effortRationale: z.string().max(400),
  leverageScore: z.number(),                       // server-computed, not LLM-reported
  risks: z.array(z.string().max(200)).max(5),
  rollbackStrategy: z.string().max(400),
});

export const DebtReviewResultSchema = z.object({
  summary: z.object({
    totalEntries: z.number().int(),
    clustersIdentified: z.number().int(),
    oldestEntryDays: z.number().int(),
    staleEntries: z.array(z.string()),             // topicIds older than ttl-days
    budgetViolations: z.array(z.object({
      path: z.string(),
      count: z.number().int(),
      budget: z.number().int(),
    })),
  }),
  clusters: z.array(ClusterSchema).max(20),
  refactorPlan: z.array(RefactorCandidateSchema).max(10),
  reasoning: z.string().max(1500),
});
```

Fix M2 — effort weights are fixed and server-side, not LLM-reported:

```javascript
const EFFORT_WEIGHTS = { TRIVIAL: 1, EASY: 2, MEDIUM: 4, MAJOR: 8, CRITICAL: 16 };
const SONAR_TYPE_WEIGHTS = { BUG: 3, VULNERABILITY: 3, SECURITY_HOTSPOT: 2, CODE_SMELL: 1 };

// Leverage = sum(sonarType weights of resolved entries) / effort weight
function computeLeverage(refactor, debtIndex) {
  const impact = refactor.resolvedTopicIds.reduce((sum, tid) => {
    const e = debtIndex.get(tid);
    return sum + (SONAR_TYPE_WEIGHTS[e?.classification?.sonarType] ?? 1);
  }, 0);
  return impact / EFFORT_WEIGHTS[refactor.effortEstimate];
}
```

LLM returns effort estimate + cluster membership; server computes the ranking.
This makes leverage scores reproducible and lets us reject GPT's effort inflation.

Fix L4 — TTL warnings flagged in `summary.staleEntries`:
- Default `--ttl-days 180`
- Entries with `deferredAt` older than TTL surface in output as "consider resolving
  or promoting to accepted-permanent"
- No auto-expiry (per non-goals)

Fix H6 (R1 audit) — sensitive data handling. Debt entries with
`sensitive: true` (set at capture-time from `isSensitiveFile()`) are NEVER sent
to external LLMs by `debt-review`. Three modes:

- **Default (external LLM)**: filters out sensitive entries entirely. Logs
  `[debt-review] 3 sensitive entries redacted from external model input`.
  Output includes them in summary counts and a separate "Sensitive (local-only)"
  section that lists topicIds only, no detail content.
- **`--local-only` mode**: runs clustering locally (deterministic heuristics,
  no LLM) over the full ledger including sensitive entries. Smaller clusters
  but no leakage.
- **`--include-sensitive` flag**: explicit opt-in. Requires confirmation prompt
  + logs a warning. Used only for trusted-environment analysis.

At debt-capture time (§2.4), the orchestrator computes `sensitive` via TWO checks:

1. **Path check** — any `affectedFiles` entry matches `isSensitiveFile()` in
   `file-io.mjs` → `sensitive: true`
2. **Content check (fix R2-H5)** — scan `detailSnapshot`, `section`, `category`,
   and `deferredRationale` for secret patterns:
   - API keys (`sk-[A-Za-z0-9]{20,}`, `AIza[0-9A-Za-z-_]{35}`, etc.)
   - AWS credentials (`AKIA[0-9A-Z]{16}`)
   - Generic tokens > 32 chars of base64/hex after keywords like
     `token|secret|password|api[_-]?key`
   - If any match → `sensitive: true` AND the matched substring is redacted
     in the persisted `detailSnapshot`, replaced with `[REDACTED:${pattern_name}]`

The content scanner uses a small patterns registry (`scripts/lib/secret-patterns.mjs`)
that matches common secret formats. It's not a full secret-scanning tool — it's
a defense-in-depth check that catches the obvious cases. For high-security
repos, operators should also run dedicated secret scanning in CI.

Redaction happens BEFORE writeDebtEntries() persists the record, so no secrets
ever reach `.audit/tech-debt.json`.

Q1 decision — `--write-plan-doc` flag writes top-ranked refactor to
`docs/plans/refactor-<clusterId>.md` (fix Q1, changed from "output-only" lean).
Rationale: output-only adds friction and we've seen `plan-backend`/`plan-frontend`
skills already own the plan-doc template. Reusing that pipeline is higher leverage
than asking humans to manually copy clusters into a new plan doc. Default is OFF;
opt-in via flag keeps the script composable.

### 2.7 Occurrence Surfacing (Status Card)

Every audit ends with a debt status line. Fix L3 — top-file line is suppressed
for small ledgers to avoid noise:

```
═══════════════════════════════════════
  DEBT LEDGER: 47 entries | Suppressed this run: 12
  Recurring (≥3 occurrences): 5 | Escalated: 2
  Oldest: 187d | Top file: scripts/openai-audit.mjs (8 entries)
═══════════════════════════════════════
```

Status card emitted after suppression runs; omitted if the ledger is empty.
Top-file line shown only when `ledger.entries.length >= 10`.

### 2.8 Advisory Escalation Gate

**CLI flag**: `--escalate-recurring <N>` (default: disabled — fix L2, renamed from
`--surface-recurring` for active-voice clarity)

When enabled:
- Before `suppressReRaises()` runs, scan debt ledger for entries with `occurrences >= N`
- For each qualifying entry, set `escalated: true` via an `escalated` event in the log
- The §2.1 suppression filter (`e.source === 'debt' && !e.escalated`) means escalated
  entries naturally bypass suppression — they get re-raised this round for deliberation
- Log: `[debt] 5 debt entries with occurrences≥3 escalated for re-deliberation`

Rationale: a LOW finding that surfaces 7 times across 7 different features is no longer
LOW. Claude (orchestrator) decides whether to escalate severity, fix now, or mark
`accepted-permanent` (which keeps suppression active but halts escalation).

**Not in v1**: auto-rewriting severity. The occurrences counter is the signal; severity
stays under human control. See non-goals in §1.

### 2.9 Ownership + Per-File Budgets

**Debt ledger additions**:
- `owner` field per entry (optional) — string from CODEOWNERS match or `--owner` flag
- `budgets` top-level map — `{ "scripts/openai-audit.mjs": 5, "scripts/lib/**": 10 }`

Q3 decision — glob support via `micromatch` (already a transitive dep; if not,
add as a direct dep). File patterns use micromatch semantics: `**` = recursive,
`*` = single segment, negation via `!`. Budget lookup: for each file, find all
matching globs, use the MOST RESTRICTIVE (lowest) budget. Exact-path wins over
globs on ties.

**Budget enforcement**:
- `debt-review` output flags violations in `summary.budgetViolations[]`
- `scripts/debt-budget-check.mjs` — CI script, exits 1 on any violation
- Budgets advisory in `audit-loop` runs (logged, not blocking)
- Budgets blocking in the GitHub Action when `fail-on-budget-exceeded: true`

**Ownership resolution** (fix M3 — use `codeowners-utils` package or pin to a
narrow subset):

Use the `codeowners-utils` npm package (0 runtime deps, small, widely used).
It handles the full CODEOWNERS spec: wildcards, multi-owner rules, last-match-
wins semantics, email-vs-handle normalization.

```javascript
import { loadOwners, matchFile } from 'codeowners-utils';

async function resolveOwner(affectedFile, { explicitOwner = null } = {}) {
  if (explicitOwner) return explicitOwner;
  const owners = await loadOwners('.github/CODEOWNERS').catch(() => null);
  if (!owners) return undefined;
  const match = matchFile(owners, affectedFile);
  return match?.owners?.[0]; // first owner wins for string field
}
```

If `codeowners-utils` is unavailable, fall back to: parse CODEOWNERS as
line-oriented file, match trailing globs against first `affectedFiles` entry
using `micromatch`, take first match's first owner. Document this as a
degraded-mode fallback, not a feature.

**Resolution order at defer-time** (populates `owner` field):
1. Explicit `--owner <name>` flag → use that
2. CODEOWNERS match against `affectedFiles[0]` → use first matched owner
3. Else leave unset; debt-review groups as "unassigned"

### 2.10 GitHub Actions PR Workflow

**New file**: `.github/workflows/audit-debt-surface.yml`

Triggers on `pull_request`. Steps:
1. Check out PR + base branch
2. Compute `git diff --name-only origin/<base>..HEAD` → changed files
3. Read `.audit/tech-debt.json` from the base branch (debt as of base, not PR)
4. For each debt entry whose `affectedFiles` overlap changed files: surface in PR comment
5. If any file in changed set exceeds its budget: optionally fail the check (§2.9)

**New module**: `scripts/debt-pr-comment.mjs`
- Generates markdown comment body
- Groups debt by file
- Shows `distinctRunCount` (occurrences) per entry — sourced from cloud
  `debt_events` if configured, else from the git history of the base branch's
  `.audit/tech-debt.json` (count of commits touching each topicId — fix R2-M2)
- Links each entry to its first-defer commit via `git log --follow --diff-filter=A -S<topicId> .audit/tech-debt.json` — the commit that first introduced the entry. No dependency on `deferredRun` being a resolvable ref.
- If neither cloud nor git-history derivation succeeds, shows entry without
  occurrences count (degrades gracefully, logs warning)

Fix M6 — sticky comment update strategy:

The comment body starts with a magic marker: `<!-- audit-loop:debt-comment -->`.
The action uses `gh pr comment --edit-last` OR finds the existing comment by
grepping for the marker and calls `gh api --method PATCH` to update it in place.
No marker found → create new comment. This prevents comment spam on every push.

```yaml
# In the workflow step:
- name: Post or update debt comment
  run: |
    node scripts/debt-pr-comment.mjs --pr ${{ github.event.pull_request.number }} > /tmp/body.md
    EXISTING=$(gh api repos/${{ github.repository }}/issues/${{ github.event.pull_request.number }}/comments \
      --jq '.[] | select(.body | startswith("<!-- audit-loop:debt-comment -->")) | .id' | head -1)
    if [ -n "$EXISTING" ]; then
      gh api --method PATCH repos/${{ github.repository }}/issues/comments/$EXISTING --field body=@/tmp/body.md
    else
      gh pr comment ${{ github.event.pull_request.number }} --body-file /tmp/body.md
    fi
```

Comment format (example):
```markdown
## 📋 Touched code has 3 deferred debt entries

**scripts/openai-audit.mjs** (2 entries, 8 total across ledger)
- [abc123] H — God Module / Excessive File Size (occurrences: 3, deferred 2026-04-05)
- [def456] M — Split Schema Ownership (occurrences: 2, deferred 2026-04-05)

**scripts/lib/findings.mjs** (1 entry)
- [789abc] H — Global Mutable State (occurrences: 2, deferred 2026-04-05)

> These are pre-existing concerns you may want to address as part of this PR.
> Run `node scripts/debt-review.mjs --out /tmp/review.md` for a structured refactor plan.
```

Action inputs:
- `fail-on-budget-exceeded` (default: `false`) — non-blocking by default
- `surface-threshold` (default: `1`) — comment only if ≥ N touched entries

### 2.11 Escalation Gate Integration

Q2 decision — combine §2.8 + §2.10: the GitHub Action surfaces escalated entries
(`occurrences >= 3`) on every PR, regardless of which files the PR touches. They
go in a separate collapsed `<details>` section of the sticky comment so they don't
drown out scope-specific debt. Rationale: the signal "this repo has systemic debt
accumulating" is team-level, not PR-level — always worth showing.

Output as a separate PR comment section:
```markdown
<details>
<summary>⚠️ Recurring debt (5 entries with ≥3 occurrences, repo-wide)</summary>

Consider a dedicated refactor pass for these:
- [abc123] scripts/openai-audit.mjs — God Module (occurrences: 5)
- [def456] scripts/lib/findings.mjs — Global Mutable State (occurrences: 4)
...
</details>
```

### 2.12 Debt-Entry Resolution (fix M7)

When a debt entry's underlying issue is fixed, it needs to come out of the ledger.
Semi-automatic flow:

1. **Detection**: in audit-loop Step 5 (verify), if a debt entry was reopened this
   round AND no finding matches its topicId in the current audit's output, it's
   fixed. The orchestrator prompts Claude: "Mark abc123 as resolved? [y/n]"
2. **Manual resolution**: `node scripts/debt-resolve.mjs <topicId> --rationale "fixed in this PR"`
   — for cases the orchestrator missed
3. **Effect**: `resolveDebtEntry()` removes the entry from `.audit/tech-debt.json` and
   appends a `resolved` event to `.audit/debt-events.jsonl`. The event log preserves
   the historical trail.

Rationale: auto-resolution risks false positives (a finding might not surface
because its file wasn't in scope, not because it's fixed). Semi-auto with
orchestrator confirmation catches the common case without being dangerous.

Fix R2-M3 (verification state) — resolution requires POSITIVE evidence, not
absence. The Step 5 prompt only fires when ALL of these are true:

1. The debt entry was `reopened` this round (files in `--changed` scope)
2. The same round's audit output has no finding matching the entry's topicId
   OR contentAliases
3. The entry's files appear in `--changed` AND the audit scope includes them
   (cannot be satisfied from an audit that didn't cover the files)

When the prompt fires, Claude confirms resolution by providing a
`resolutionRationale` (≥20 chars) referencing the specific fix commit/change.
The `resolved` event records this rationale. Entries resolved this way carry
`resolvedBy: runId` + `resolutionRationale` in the event log.

Absent positive evidence, entries stay open. This avoids "fell out of scope →
silently deleted" false positives.

### 2.13 CLI Contracts (fix R2-M4)

All debt-* scripts follow a uniform contract for CI and tooling integration:

**Exit codes:**
- `0` — success (including "nothing to do" — empty ledger, no violations)
- `1` — operational error (missing input, corrupt ledger, IO failure)
- `2` — policy failure (budget exceeded, unapproved records in staging,
  lock contention after max retries) — distinguishes "working, found problems"
  from "broken"
- `3` — sensitivity gate tripped (external LLM call would leak data)

**stdout vs stderr:**
- stdout: JSON (`--json`) or human summary, intended for `--out <file>` or pipe
- stderr: progress logs, warnings, API errors — all human-readable

**Empty-ledger behavior:**
- `debt-review` with 0 entries → writes empty summary, exits 0
- `debt-budget-check` with 0 entries → no violations, exits 0
- `debt-pr-comment` with 0 touched entries → writes comment with "No debt in
  touched files" OR exits 0 with no-op flag to suppress the comment entirely

**Redacted-ledger behavior:**
- `debt-review` with all entries marked `sensitive: true` and no
  `--include-sensitive` → falls through to `--local-only` mode automatically,
  logs the downgrade, exits 0

**Missing API keys:**
- `debt-review` without `OPENAI_API_KEY` → exits 1, tells user to set the key
  OR use `--local-only`
- All other scripts do NOT call external APIs — no key requirements

**Supabase outages:**
- Event-log operations fall back to local (§2.3 precedence order), log a
  warning, exit 0. Never fail an audit because cloud is down.

**CODEOWNERS parse failure:**
- `owner` resolution falls through to `undefined`, logs warning, exits 0.
  Entries get `owner: null`.

**Lock contention (writeDebtEntries):**
- `proper-lockfile` retries (default 5× with exponential backoff)
- On max-retry exceeded → exit 2 with actionable error message
  ("another audit-loop run is mutating .audit/tech-debt.json — wait or remove
  stale lock at .audit/tech-debt.json.lock")

---

## 3. File Impact Summary

| File | Changes |
|---|---|
| `scripts/lib/schemas.mjs` | Add `PersistedDebtEntrySchema`, `HydratedDebtEntrySchema`, `DebtEventSchema`, `DebtLedgerSchema`, `ClusterSchema`, `RefactorCandidateSchema`, `DebtReviewResultSchema`; add `source` field to `LedgerEntrySchema` with `'session'` default; extract `LedgerCoreFields` for DRY |
| `scripts/lib/debt-ledger.mjs` | **New** — read/write, merge, event-log append, resolution, CODEOWNERS lookup |
| `scripts/lib/debt-events.mjs` | **New** — append/replay for `.audit/debt-events.jsonl` (race-safe occurrences) |
| `scripts/lib/ledger.mjs` | Update `suppressReRaises()` filter to be source-aware (debt entries suppress unless `escalated`) |
| `scripts/openai-audit.mjs` | Load + merge debt ledger, append debt events on surface/reopen, status card, `--no-debt-ledger`, `--debt-ledger`, `--debt-events`, `--read-only-debt`, `--escalate-recurring` flags |
| `scripts/debt-review.mjs` | **New** — standalone LLM refactor planner (Zod-validated output, server-computed leverage, `--write-plan-doc` flag) |
| `scripts/debt-budget-check.mjs` | **New** — CI-friendly budget enforcement via micromatch |
| `scripts/debt-pr-comment.mjs` | **New** — generate GitHub PR comment markdown with sticky marker |
| `scripts/debt-resolve.mjs` | **New** — manual debt-entry resolution CLI |
| `scripts/shared.mjs` | Re-export debt-ledger APIs |
| `.audit/tech-debt.json` | **New** (committed, initially empty) |
| `.audit/local/debt-events.jsonl` | **New** (LOCAL ONLY, gitignored, fallback when cloud unavailable) |
| `.audit/staging/debt-staging.json` | **New** (gitignored, backfill staging area) |
| `.gitignore` | Add `.audit/local/`, `.audit/staging/` |
| `scripts/debt-backfill.mjs` | **New** — parse audit summaries → staging → promote (fix M2) |
| `scripts/learning-store.mjs` | Add `debt_events` table writer + reader (fix H2 cloud primary) |
| `supabase/migrations/<ts>_add_debt_events.sql` | **New** — debt_events table + indexes |
| `.github/workflows/audit-debt-surface.yml` | **New** — PR workflow with sticky comment updates |
| `.claude/skills/audit-loop/SKILL.md` | Step 3.6 — debt capture flow (challenged-only), Step 5 — resolution prompt |
| `.github/skills/audit-loop/SKILL.md` | Mirror |
| `tests/debt-ledger.test.mjs` | **New** — read/write/merge/resolve |
| `tests/debt-events.test.mjs` | **New** — event-log append, replay, concurrent-append |
| `tests/debt-review.test.mjs` | **New** — clustering, leverage ranking (LLM mocked), TTL staleness |
| `tests/debt-budget.test.mjs` | **New** — micromatch budget resolution, violations |
| `tests/debt-pr-comment.test.mjs` | **New** — sticky-marker generation, grouping |
| `package.json` | Add `codeowners-utils` + `micromatch` + `proper-lockfile` deps |

---

## 4. Testing Strategy

### Unit Tests — Hermetic

| Test | What it validates |
|---|---|
| `DebtEntrySchema.parse()` with valid entry | Accepts all required fields |
| `DebtEntrySchema.parse()` rejects `deferredRationale` < 20 chars | Schema-enforced minimum |
| `DebtEntrySchema.parse()` rejects invalid `deferredReason` enum | Enum enforcement |
| `DebtEntrySchema` does NOT require session-only fields | Doesn't inherit `ruling`, etc. |
| `LedgerEntrySchema.parse()` defaults `source` to `'session'` | Backward compat for old ledgers |
| `writeDebtEntries()` — new entries written | Initial write |
| `writeDebtEntries()` — does NOT write occurrences (derived from events) | Fix H3 |
| `writeDebtEntries()` returns `rejected[]` for invalid entries | Phase B contract |
| `readDebtLedger()` returns empty on ENOENT | Optional ledger |
| `readDebtLedger()` throws on corruption | Fail-loud |
| `readDebtLedger()` replays event log to populate occurrences | Fix H3 |
| `appendDebtEvents()` emits valid JSONL lines | Event format |
| Event replay: count of 'surfaced' = occurrences | Derivation correctness |
| Event replay: 'resolved' removes from occurrences count | Resolution semantics |
| Concurrent append (10 processes, 100 events each) — no data loss | Race-safety |
| `mergeLedgers()` — debt + session entries disjoint by topicId | Base case |
| `mergeLedgers()` — on topicId collision, session wins | Fix M1 |
| `mergeLedgers()` — preserves `source` field on each entry | Fix H2 |
| `suppressReRaises()` suppresses debt entries on untouched files | Zero resurfacing |
| `suppressReRaises()` does NOT suppress escalated debt | Escalation bypass |
| `suppressReRaises()` reopens debt entries when affected files change | Auto-reopen |
| `suppressReRaises()` keeps existing session-dismissal semantics | Backward compat (fix H2) |
| Reopen emits `reopened` event, NOT `surfaced` event | Reopen is not suppression |
| `--escalate-recurring 3` flips `escalated=true` for qualifying entries | Fix L2 rename + escalation |
| `--read-only-debt` skips all event-log writes | CI safety |
| `resolveDebtEntry()` removes from ledger + appends `resolved` event | Fix M7 |
| `computeLeverage()` — server-computed, TRIVIAL=1..CRITICAL=16 | Fix M2 weights |
| `debt-review` output validates against `DebtReviewResultSchema` | Fix M5 |
| `debt-review` flags entries older than `--ttl-days` | Fix L4 TTL |
| Budget lookup — most-restrictive glob wins on multi-match | Fix M3 semantics |
| CODEOWNERS resolution — uses `codeowners-utils` for parsing | Fix M3 spec |
| PR comment generator embeds sticky marker | Fix M6 sticky update |
| `PersistedDebtEntrySchema` rejects `occurrences` field | Fix H1b persisted/hydrated split |
| `HydratedDebtEntrySchema` requires `occurrences` + `distinctRunCount` | Fix H1b + M1 |
| Event log written to `.audit/local/` NOT `.audit/` | Fix H2 telemetry location |
| `.gitignore` excludes `.audit/local/` and `.audit/staging/` | Fix H2 gitignore |
| Debt event replay prefers cloud source when Supabase configured | Fix H2 cloud-first |
| Debt event replay falls back to local JSONL on cloud failure | Fix H2 fallback |
| Concurrent `writeDebtEntries()` — proper-lockfile serializes writes | Fix H3 single-writer |
| `writeDebtEntries()` retries on lock contention | Fix H3 retry behavior |
| Stale lock (>30s) is broken by next writer | Fix H3 stale-lock detection |
| Matching via `contentAliases` finds re-paraphrased entries | Fix H4 alias mitigation |
| `appendContentAlias()` dedups identical aliases | Fix H4 idempotence |
| Triage with `validity=valid + scope=out-of-scope` → action=defer eligible | Fix H5 |
| Triage with `validity=invalid` cannot → action=defer | Fix H5 guard |
| Triage with `validity=valid + scope=in-scope + HIGH` cannot → action=defer (except accepted-permanent) | Fix H5 guard |
| `sensitive: true` set when affectedFiles includes `.env` / credentials | Fix H6 capture-time |
| `debt-review` filters out sensitive entries from external LLM payload | Fix H6 external mode |
| `debt-review --local-only` processes sensitive entries locally | Fix H6 local mode |
| `debt-review --include-sensitive` prompts for confirmation | Fix H6 opt-in warning |
| One `surfaced` event per topicId per run regardless of match count | Fix M1 |
| `distinctRunCount` = unique runIds, `matchCount` = total surfaced events | Fix M1 metrics |
| `debt-backfill.mjs` writes staging file, NOT live ledger | Fix M2 staging |
| Staging records flag low-confidence field derivations | Fix M2 confidence markers |
| `debt-backfill.mjs --promote` requires approved records only | Fix M2 human review gate |
| Transcript envelope includes `_debtSuppressionContext` with suppressed topicIds | Fix R3-H1 |
| Gemini system prompt warns against resurfacing pre-filtered debt | Fix R3-H1 |
| Gemini new_findings matching debt get re-suppressed in final-merge | Fix R3-H1 |
| Offline run writes events to local log, marks source='local' | Fix R3-H3 |
| Next online run replays unreconciled local events to cloud | Fix R3-H3 |
| Reconciliation is idempotent (duplicate runId+topicId+event skipped) | Fix R3-H3 |
| Per-reason required fields enforced via discriminated union | Fix R2-H4 / R2-M1 |
| `blocked-by` debt requires `blockedBy` field | Fix R2-H4 |
| `deferred-followup` debt requires `followupPr` field | Fix R2-H4 |
| `accepted-permanent` debt requires `approver` + `approvedAt` | Fix R2-H4 |
| Secret-pattern scanner redacts API keys in detailSnapshot | Fix R2-H5 |
| Redaction happens BEFORE writeDebtEntries() persists | Fix R2-H5 |
| Verification requires positive evidence (affected files in --changed AND scope) | Fix R2-M3 |
| CLI contracts: exit codes 0/1/2/3, documented stderr vs stdout | Fix R2-M4 |

### Integration Tests — Hermetic

| Test | What it validates |
|---|---|
| Full audit with debt ledger — no debt-matched findings in output | End-to-end suppression |
| Audit with `--changed` overlapping debt → matched entries re-raised | End-to-end reopen |
| `debt-review` on synthetic debt ledger produces clusters | LLM pass (mocked) |
| `debt-budget-check` exits 1 when over budget | CI enforcement |
| `debt-pr-comment` generates expected markdown for synthetic debt | PR surfacing |
| Ownership resolution from CODEOWNERS → debt entry `owner` field | CODEOWNERS integration |

### Smoke Tests — Gated behind `AUDIT_LOOP_SMOKE=1`

| Test | What it validates |
|---|---|
| Real GPT debt-review pass on the repo's own accumulated debt | Cluster quality |
| GitHub Action dry-run on synthetic PR | Workflow correctness |

---

## 5. Rollback Strategy

All changes are additive and gated:

- **Debt ledger is optional** — `readDebtLedger()` returns empty on ENOENT
- **`--no-debt-ledger` opt-out** — restores pre-Phase-D behavior entirely
- **Suppression merge is transparent** — if debt ledger is empty, `mergeLedgers()`
  returns a ledger equivalent to the session ledger alone
- **Event-log append is race-safe and append-only** — no corruption path that
  destroys history
- **`--read-only-debt`** — use suppression without mutating event log (CI safety)
- **`source='session'` default on LedgerEntrySchema** — old ledger files without
  the field continue to validate and behave identically (backward compat fix H2)
- **GitHub Action is advisory by default** — `fail-on-budget-exceeded: false`

Revert path:
1. Delete `.audit/tech-debt.json` and `.audit/debt-events.jsonl` (harmless)
2. Add `--no-debt-ledger` to `audit-loop` skill's default invocation (one-line skill edit)
3. `debt-review` / `debt-budget-check` / `debt-pr-comment` / `debt-resolve` scripts
   are standalone — harmless if unused
4. `source` field on `LedgerEntrySchema` is defaulted — no migration needed to remove

---

## 6. Implementation Order

1. **Schemas** — `PersistedDebtEntrySchema`/`HydratedDebtEntrySchema` split (fix H1b),
   `DebtEventSchema`, `DebtLedgerSchema`, `source` field on `LedgerEntrySchema`,
   `ClusterSchema`/`RefactorCandidateSchema`/`DebtReviewResultSchema` + unit tests
2. **`supabase/migrations/<ts>_add_debt_events.sql`** — cloud table for debt events (fix H2)
3. **`learning-store.mjs` extension** — debt event cloud writer/reader (fix H2 primary path)
4. **`lib/debt-events.mjs`** — local JSONL fallback, cloud-first replay, per-run dedup (fix M1)
5. **`lib/debt-ledger.mjs`** — read/write/merge/resolve with proper-lockfile serialization
   (fix H3), contentAliases matching (fix H4) + unit tests
6. **`lib/ledger.mjs` filter update** — source-aware suppression + backward-compat tests
7. **Suppression integration** — wire debt into `openai-audit.mjs`, emit per-run `surfaced`
   / `reopened` events (fix M1), emit transcript `_debtSuppressionContext` for Gemini
   review (fix R3-H1), implement offline→cloud event reconciliation (fix R3-H3) +
   integration tests for zero-resurfacing and auto-reopen
8. **CLI flags** — `--no-debt-ledger`, `--debt-ledger`, `--debt-events`, `--read-only-debt`
9. **Orchestrator capture** — SKILL.md Step 3 triage model (validity/scope/action per H5),
   Step 3.6 debt capture with sensitivity flag (H6), Step 5 resolution (M7)
10. **`scripts/debt-resolve.mjs`** — manual resolution CLI (fix M7)
11. **`scripts/debt-review.mjs`** — LLM clustering with sensitivity filter (H6),
    Zod-validated output (M5), server-computed leverage (M2), TTL flagging,
    `--write-plan-doc`, `--local-only`, `--include-sensitive` flags + mocked-LLM test
12. **`--escalate-recurring <N>` flag** — escalation gate + tests
13. **Ownership + budgets** — `codeowners-utils` + `micromatch` deps, `debt-budget-check.mjs`
14. **`scripts/debt-pr-comment.mjs`** — sticky-marker markdown generator + tests
15. **GitHub Actions workflow** — `.github/workflows/audit-debt-surface.yml`
16. **Run `npm test`** — verify 342 baseline + ~65 new tests all green
17. **Backfill pipeline** (fix M2 — staging + human review, NOT direct import):
    - `scripts/debt-backfill.mjs --source docs/plans/*-audit-summary.md --stage .audit/staging/debt-staging.json`
    - Parses summary files, extracts deferred findings, emits **staging records**
      with explicit `parseConfidence: 'high' | 'medium' | 'low'` per field
    - Fields that can't be derived with confidence (topicId, classification,
      affectedFiles) get `null` with confidence markers
    - Staging file is NOT read by normal audits — separate from live ledger
    - Second CLI: `scripts/debt-backfill.mjs --promote .audit/staging/debt-staging.json`
      asks the operator to review/fill missing fields interactively OR via a
      JSON patch file, then writes approved records into `.audit/tech-debt.json`
      via the standard locked `writeDebtEntries()` path
    - Rejected records stay in staging with human-written rationale for rejection

---

## 7. Known Limitations (accepted for Phase D)

**Identity model** (surfaced 3 consecutive audits: Phase B H1, Phase C H10,
Phase D R1-H4, R2-H3, R3-H2): `topicId` is reused as suppression key, durable
identity, merge key, and resolution key despite being derived from prose
content via `semanticId()`. `contentAliases` is a tactical mitigation.

**Phase D doesn't fix this — Phase D TRACKS it.** On first audit-loop run after
Phase D ships, the orchestrator is expected to defer the "unified identity
model" concern as its first self-referential debt entry:

```
topicId: <derived at capture>
category: Identity Model Redesign
severity: HIGH
deferredReason: accepted-permanent  (for Phase D) / deferred-followup  (if promoting to Phase E)
deferredRationale: "Phase D deliberately reuses topicId; full identity redesign
  would be Phase E scope. contentAliases mitigates common drift. Accepted as
  ledger-tracked debt, to be promoted to a Phase E plan when recurrence warrants."
```

This is Phase D proving its own value: the first recurring architectural
concern it tracks is itself.

## 8. Out of Scope (Post-Phase-D)

- Cross-repo debt federation
- Auto-severity-rewriting based on occurrences (v1 is advisory surfacing only)
- LLM-driven auto-deferral decisions (v1 requires orchestrator confirmation)
- Debt-entry auto-expiry (TTL warnings yes, auto-delete no)
- Per-team debt dashboards beyond the PR comment
- Full identity-model redesign (tracked as Phase D's canonical debt entry —
  candidate for Phase E)

---

## 9. Resolved Design Decisions

All four pre-audit open questions have been answered in the relevant sections:

| # | Question | Decision | Rationale | Section |
|---|---|---|---|---|
| Q1 | `debt-review` writes plan docs directly? | **Yes, opt-in via `--write-plan-doc`** | Reusing existing plan-doc pipeline is higher-leverage than manual copy-paste. Default off keeps script composable. | §2.6 |
| Q2 | Escalated debt in PR comments — always, or only PRs with no debt? | **Always, in collapsed `<details>` section** | Signal is team-level, not PR-level. Collapsing keeps it non-intrusive. | §2.11 |
| Q3 | Budget syntax: exact paths or globs? | **Globs via `micromatch`, most-restrictive wins** | `scripts/lib/**: 20` beats listing every file. | §2.9 |
| Q4 | Backfill from existing `-audit-summary.md` files? | **Yes, as final implementation step (L1)** | We already have 3 summary files with ~35 deferred findings. Throwing them away defeats the point. | §6 step 15 |
