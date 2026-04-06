# Phase G.3 Plan Audit Summary

- **Date**: 2026-04-06
- **Plan**: `phase-g3-github-adapter.md`
- **Rounds**: 3 (capped per early-stop rule; H:6→5→5 plateau)
- **Verdict trajectory**: R1 SIGNIFICANT_GAPS H:6 M:2 → R2 SIGNIFICANT_GAPS H:5 M:4 → R3 NEEDS_REVISION H:5 M:4
- **Cost**: ~$0.45, ~12 min
- **Status**: Audit-complete. 16 fixes applied. 5 remaining HIGHs documented as known limitations.

## Key Fixes Applied

**R1 (6 HIGH, 2 MEDIUM addressed)**:
- Optional-dep isolation: lazy `await import()` only for github path, no barrel re-export (H1)
- Branch as authoritative store: Issues are projections only, adapter never reads Issues (H2)
- Idempotency via branch files: event files keyed by idempotency key; issue dedup is best-effort (H3)
- Merge semantics: delta-event model for bandit/FP (append-only); 3-way merge for debt/prompts (H4)
- Scope isolation: `scopeId` = audited-repo fingerprint, `storageRepoSlug` = config (H5)
- Atomic multi-file commits via Git Data API: tree→commit→ref-update (H6)
- Cache revalidation: per-read ref check, ETag caching (M1)
- Rate-limit: explicit @octokit/plugin-throttling + @octokit/plugin-retry (M2)

**R2 (5 HIGH, 4 MEDIUM, 1 LOW addressed)**:
- Unified write architecture: Git Data API for all writes, scrubbed Contents API write references (H1)
- Issues projection purely best-effort, with rate-budget cap (H2/H3)
- Compaction + snapshot strategy with cutoff markers (H4)
- Debt field-level merge to reduce concurrency data loss (H5)
- Path encoding: all segments validated by regex, safe by construction (M2)
- Auth probe: `GET /repos/:o/:r` works for all token types (M3)
- Cache scope clarified: process-scoped with per-read revalidation (M4)
- Missing-dep fail-fast: explicit install guidance error (L1)

## Remaining HIGHs (5, documented as known limitations)

| # | Finding | Mitigation |
|---|---|---|
| R3-H1 | `repo.*` capability matrix still says `repoId = owner/repo slug` vs scopeId text | Implementation: fix capability matrix to `repoId = fingerprint (facade passes it)`; remove slug confusion |
| R3-H2 | Contents API write references linger in some sections alongside Git Data API | Implementation: grep-and-scrub; Git Data API is authoritative |
| R3-H3 | `recursive=1` tree listing + client-side filtering doesn't scale for N>10K files | Implementation: directory-based listing with depth-1 fetches; compaction keeps file count bounded |
| R3-H4 | Git history growth from atomic commits not reclaimable without `git gc` / shallow clone | Documented: operators run `git gc` on storage repo periodically; shallow clones for CI |
| R3-H5 | Issue projection idempotency incomplete (title lacks stable eventId) | Implementation: add `idempotencyKey` to issue title; projection failure is non-fatal |

## Trajectory Analysis

6 → 5 → 5 HIGH. The GitHub adapter is architecturally the most complex of all
G sub-phases — it bridges two fundamentally different storage paradigms (git
object store + REST API) and must handle eventual consistency, rate limits,
and concurrent writers. R2→R3 plateau was expected.

Remaining HIGHs split into two categories:
- **Spec-consistency cleanups** (H1, H2, H5): easy to fix during implementation by grepping the plan
- **Fundamental scaling concerns** (H3, H4): inherent to using a git repo as a database. Documented as limitations with operator-actionable mitigations (compaction, gc, shallow clones)

## Next Steps

Plan is ready to implement. Key implementation notes:
1. Build `git-data-api.mjs` first — it's the single write primitive everything depends on
2. Test merge-ops thoroughly before wiring into the adapter (most complex logic)
3. Issue projection must be strictly best-effort — never block a write for a projection failure
4. Compaction CLI should ship with G.3 even if it's rarely used initially
5. Scrub plan for any remaining Contents API write references before coding
