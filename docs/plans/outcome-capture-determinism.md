# Plan: Model-Independent Outcome Capture (run-unification + finalize hook)

- **Date**: 2026-06-04
- **Status**: Draft (scoped follow-up from Cluster B)
- **Author**: Claude + Louis
- **Scope**: backend

> **Origin**: Cluster B (learning-store signal recovery) made the outcome sync
> *correct + reliable when invoked*, but capture still depends on the skill (or
> autonomous loop) invoking `write-code-outcomes` after Claude triages. This
> plan removes that dependency. Deferred out of Cluster B deliberately — it
> reworks the audit run/round seam and must be audited as its own change, not
> rushed.

---

## 1. The constraint (evidence)

`audit_findings.adjudication_outcome` is the source of truth and is populated by
`recordAdjudicationEvent` (runs-findings.mjs) → `outcome-sync.recordTriageOutcomes`
← `write-code-outcomes.mjs`. The gap is **invocation**, rooted in two facts:

1. **Per-invocation runs**: [openai-audit.mjs:1504](scripts/openai-audit.mjs#L1504)
   calls `recordRunStart` on *every* invocation, so round 1 and round 2 are
   **separate `audit_runs` rows**. There is no single run_id spanning the audit.
2. **Adjudication is interleaved human/Claude judgment**: openai-audit writes the
   ledger with `adjudicationOutcome: 'pending'`
   ([openai-audit.mjs:2519](scripts/openai-audit.mjs#L2519)); Claude triages and
   rewrites the ledger to `accepted`/`dismissed` *between* invocations (skill
   Step 3). **No pure script ever holds `(run_id, final adjudicated ledger)`
   together** — so the sync can only be triggered by something that runs after
   the model's triage. Today that's the skill's Step 3.5b (mandatory but
   model-remembered) or the autonomous audit loop.

Consequence: a missed Step 3.5b leaves `adjudication_outcome` null → the
`audit_effectiveness` view + the `pass_selection` resolver stay dark for that run.

## 2. Design

### Option A — Run-unification (preferred)
Thread ONE `run_id` across all rounds of a single audit:
- The orchestrator (or the first `openai-audit` invocation) mints the run_id;
  subsequent rounds receive `--run-id <id>` and `recordRunStart` becomes
  upsert-or-reuse instead of always-insert.
- Findings from all rounds attach to the one run; `adjudication_outcome` patches
  resolve by `(run_id, finding_fingerprint)` regardless of which round raised
  the finding.
- A single **finalize** step (run once at convergence) reads the final
  adjudicated ledger + the run's findings and syncs everything — deterministic,
  one call, no per-round bookkeeping.

### Option B — Ledger-writer-triggered sync (lighter, no run rework)
Make persisting an adjudicated ledger entry enqueue a cloud sync keyed by
finding_fingerprint, resolved to the run that raised it via a fingerprint→run_id
index. Avoids run-unification but adds a fingerprint→run lookup table and couples
the local ledger writer to the cloud store (layering cost).

**Recommendation**: Option A. It also fixes the latent per-invocation-run
fragmentation of `audit_runs` itself (every round is a separate "run" today,
inflating run counts and muddying convergence telemetry).

## 3. The deterministic finalize trigger
Even with Option A, *adjudication* is irreducibly the model's judgment. What
becomes model-INDEPENDENT is the **sync**: the orchestrator (`audit-loop.mjs` /
`/cycle` Step 3C, both of which run as a flow after the audit converges) calls
`finalize-outcomes --run-id <id> --ledger <final> ` exactly once. The ledger is
the machine-readable adjudication artifact; the finalize step is pure script.
For the fully-manual `/audit-code` path (no orchestrator), Step 3.5b remains the
fallback — documented, not relied upon for the autonomous path.

## 4. Risk & why deferred
- Touches the audit **hot path** (run lifecycle) — every audit run. A bug here
  corrupts run/finding attribution for all repos. Must go through the full
  `/audit-code` + Gemini gate as its own change.
- `recordRunStart`/`recordRunComplete`/`updateRunMeta` + every `repoId`/`runId`
  caller need review for the reuse semantics.
- Back-compat: existing per-round runs in the store stay as-is (historical);
  the change is forward-only.

## 5. Acceptance
- One `audit_runs` row per audit (not per round); findings across rounds share it.
- After a converged autonomous run, `adjudication_outcome` + `audit_runs.labeled`
  are populated with **zero** model-remembered steps.
- `pass_selection` resolver resolves the run (its findings are now adjudicated).
- Guardrail test: a simulated 3-round audit produces exactly 1 run with all
  findings labeled after the finalize step.

---

> **Deferred from Cluster B by design.** Cluster B shipped the correct + reliable
> sync; this plan removes the model-invocation dependency. Implement as a
> standalone, fully-audited change.
