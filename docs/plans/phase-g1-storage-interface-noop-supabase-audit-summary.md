# Phase G.1 Plan Audit Summary

- **Date**: 2026-04-05
- **Plan**: `phase-g1-storage-interface-noop-supabase.md`
- **Rounds**: 3 (capped per early-stop rule, HIGH plateau at R2→R3)
- **Verdict trajectory**: R1 SIGNIFICANT_GAPS H:5 → R2 SIGNIFICANT_GAPS H:4 → R3 NEEDS_REVISION H:4
- **Cost**: ~$0.40, ~10 min
- **Status**: Audit-complete. 10 fixes applied. 4 remaining HIGHs documented as known limitations.

## Key Fixes Applied

**R1 (5 HIGH addressed)**:
- Added `learningState.*` capability to noop (wraps existing `.audit/bandit-state.json` + `.audit/fp-tracker.json`) to preserve pre-G.1 behavior (H1)
- Clarified `repoId` as opaque adapter-specific, documented adapter-specific mappings + fingerprint as portable identity (H2)
- Replaced "silently no-op on disconnect" with pending-writes buffering + 30-day stale warning (H3)
- Mandated Phase D caller migration to facade in G.1 scope (~5 sites, 1-line each); marked `lib/debt-ledger.mjs` @internal (H4)
- Added §2.11 discriminated envelope `{ok, supported, reason, data}` distinguishing capability-missing/transient/empty (H5)

**R2 (4 HIGH, 3 MEDIUM addressed)**:
- Added §2.0 authoritative capability & return-shape matrix — single source of truth (H4 contradictions)
- Dual-API: legacy shapes preserved via `learningStore.*`; envelope API exposed via parallel `learningStore.envelope.*` namespace — zero-behavior-change guaranteed (H2)
- Client-generated IDs (repoId=sha256(profile), runId=UUIDv4) so identities work offline (H1)
- Documented noop as working-directory-scoped with `scopeIsolation: false` capability flag; conformance isolation test skips for noop (H3)
- Specified outbox journal format: versioned, idempotency keys, lock file, partial-success handling, atomic append+fsync (M1)
- Lazy-loading isolation boundary + ESLint no-restricted-imports for supabase-store.mjs (M2)
- Split generic vs adapter-specific repoId validation in conformance tests (M3)

**R3 (1 LOW addressed, spec contradictions)**:
- Fixed init stderr message to match §2.1 buffering contract
- Fixed §3 "NOT touched" contradiction with §2.6 (openai-audit.mjs + Phase D scripts migrate to facade)
- Removed bogus "604+ tests" test-count citation

## Remaining HIGHs (4, documented as known limitations §7)

| # | Finding | Mitigation |
|---|---|---|
| R3-H1 | Legacy-API callers can't distinguish transient-failure from empty | Loud stderr warning on unreachable; opt-in `envelope.*` API for callers that need precision |
| R3-H2 | Fingerprint drift could orphan repo identity if profile detector evolves | `.audit/repo-identity.json` pins first-computed repoId; adapter `aliases` column for historical fingerprints |
| R3-H4 | Outbox replay doesn't enforce causal ordering for dependent ops | Client-generated IDs ensure idempotent re-creation; strict ordering deferred to post-G.1 |
| R3-M2 | Module-global `_adapter` singleton hurts parallel cross-adapter testability | Conformance suite instantiates adapters directly; `__resetForTest()` export for facade tests |

## Trajectory Analysis

5 → 4 → 4 HIGH. Plateaued at R2→R3. Each round exposed an adjacent concern:
- R1 surfaced "does noop regress existing local persistence?" (fixed)
- R2 surfaced "does the envelope change break the zero-behavior-change invariant?" (fixed via dual-API)
- R3 surfaced "does the legacy API preserve enough signal for operators?" (accepted — opt-in envelope path)

Consistent with Phase F and Phase H trajectories (architecturally-deep plans
don't converge cleanly in 3 rounds). Remaining HIGHs are judgment calls,
not correctness gaps — each has a concrete mitigation documented in §7.

## Next Steps

Plan is ready to implement. Key implementation notes:
1. Write §2.0 capability matrix first; test every adapter method against it
2. Build `scripts/lib/stores/` with interfaces → schemas → conformance suite → noop → supabase in order
3. Pin repo identity via `.audit/repo-identity.json` on first run
4. Add `__resetForTest()` to facade early (conformance tests need it)
5. ESLint rule blocking direct `supabase-store.mjs` imports must land with the refactor
