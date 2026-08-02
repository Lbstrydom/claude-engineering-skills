# Audit Summary — refactor-architecture-debt-remainder-2026-07

**Plan**: [`refactor-architecture-debt-remainder-2026-07.md`](refactor-architecture-debt-remainder-2026-07.md)
**Audit-code SID**: `audit-code-arch-debt-1785136564`
**Rounds**: 5 (GPT, stopped early on rigor pressure) + 1 (Gemini) | **Final**: H:0 M:0 L:0 (post-triage) | Gemini verdict: **APPROVE**

## GPT round-by-round

| Round | H | M | L | Notable |
|---|---|---|---|---|
| 1 | 1 | 12 | 2 | H1 (non-atomic write) fixed; 14 others verified via `git diff` as pre-existing/untouched, deferred or dismissed as adjacency-wave control-state |
| 2 | 0 | 8 | 1 | 4 genuine new-code bugs fixed (fenced-block false-heading, `--repo` crash, stale doc claim, dead import); 3 dismissed as duplicates; 2 deferred as new independent debt |
| 3 | 0 | 4 | 0 | 2 robustness gaps fixed (tilde fences, charset consistency); 2 dismissed as duplicates |
| 4 | 1 | 6 | 0 | 1 plan typo + 1 real fence-length bug fixed; 3 dismissed as duplicates; 2 deferred (same dangerous-key cluster) |
| 5 | 1 | 4 | 0 | All 5 dismissed — 6th re-raise of the same dangerous-key cluster, plus 3 rigor-pressure findings on an already-refined internal tool. **Stopped here** rather than running round 6. |

The dangerous-key gap-class in `observed-deps.mjs`'s flattening logic was
independently re-raised **6 times** across rounds 1–5, each time re-verified
via `git diff` as untouched by this diff (this plan never touches that
logic). Captured once as debt (topicId `c459176ded13`) plus 2 related
angles (round-3 M3, round-4 H1/M6) — never fixed here, since doing so would
exceed this plan's stated scope of 3 domain-boundary fixes.

## Gemini gate

- **Round 1 → APPROVE**, 0 new findings, 0 wrongly dismissed. `deliberation_quality.gpt_false_positive_count: 31` — Gemini's own assessment that most of GPT's 5-round output was scope-blind noise on pre-existing code, correctly filtered.
- Shadow reviewer (Claude Opus, non-gating) raised 4 findings, all evaluated and 2 folded in despite the gate already passing:
  - **Fixed**: a DRY violation — the new drift gate had hand-derived the exact same CommonMark fence-matching logic (`makeFenceTracker`) already present privately in `check-context-drift.mjs`, across 3 audit rounds. Extracted to a shared `scripts/lib/markdown-fence-tracker.mjs`; both scripts now import it.
  - **Fixed**: a stale docstring in `coverage.mjs` still naming `observed-deps.mjs` as `CoverageSchema`'s owner after the move.
  - **Dismissed** (empirically disproven): a claim that malformed `domain-map.json` produces a crash "indistinguishable from a genuine drift failure" — directly tested; the script exits `99` with a clearly labeled `Error:` prefix, distinct from exit `1` (drift found).
  - **Dismissed** (currently zero impact, forward-looking): a claim that `allowedDeps` map entries could introduce domain names invisible to the gate — verified empirically that today's `domain-map.json` has zero such entries; a real but hypothetical future robustness question, out of this plan's stated "domain-NAME presence from `rules`" scope.

## Debt captured (`.audit/tech-debt.json`)

15 entries total this session (in addition to the 2 captured during the
sibling `vcs-parsing-and-rmsync-scope-hardening` work): the dangerous-key
cluster (3 related entries), CoverageSchema cross-measurement validation,
`parseReferenceFrontmatter`'s regex-vs-YAML approach, `recordGraphCoverage`'s
discarded validation result, `lintSkill`'s path-traversal concern,
`collect-reference.mjs`'s error classification/oversized-function/contract-
inconsistency issues, `parseSkill`'s error swallowing, the verdict-policy
DRY duplication, and one unrelated pre-existing layer-boundary violation
(`tiered-shadow-contract-digest.mjs`). All verified independent via `git
diff` before deferring — every entry names the specific evidence, not an
authorship-based dismissal.

## Verification

- `npm test`: 8851 passing, 22 pre-existing skips, 0 failures (final run).
- Every fix verified empirically before committing to code: the pure-read
  contract for `loadAllSkills`/`parseSkill`, the domain-map placement checks
  (zero new `allowedDeps` edges for both items), the fenced-code-block/
  tilde-fence/nested-fence-length scenarios (each with a direct repro
  script before being folded into a permanent regression test), and the
  malformed-JSON exit-code claim.
