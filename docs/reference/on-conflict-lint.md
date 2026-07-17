# on-conflict lint — the conflict-target-≠-stored-identity gate

**What it is.** A mechanical lint over the cloud store's write path
(`scripts/lib/store/**`) that catches one recurring, expensive defect class:
**an `ON CONFLICT` target that disagrees with the row's real identity.**
Module: [`scripts/lib/lint/on-conflict.mjs`](../../scripts/lib/lint/on-conflict.mjs);
CLI: [`scripts/on-conflict-lint.mjs`](../../scripts/on-conflict-lint.mjs);
tests: [`tests/on-conflict-lint.test.mjs`](../../tests/on-conflict-lint.test.mjs).

## Why it exists — three field instances of one class

1. **`false_positive_patterns`** — `repo_id` written `repoId || null` while `repo_id`
   was IN the conflict target. Postgres treats NULLs as DISTINCT, so a null-repo
   row never matched its own conflict key → the upsert degraded to an INSERT every
   run → **403k duplicate rows, Disk-IO budget depleted** (fixed: `718ca90` +
   migration `20260717120000`).
2. **`bandit_arms`** — same shape: `context_bucket || null` in its own conflict
   target (fixed: migration `20260718090000`).
3. **`prompt_variants`** (`upsertPromptVariant`) — the mirror image: `repo_id`
   STORED on the row but OMITTED from the conflict target `['pass_name','variant_name']`,
   so one repo's row would silently overwrite another's on a shared DSN. It was
   also dead code (no caller, 0 rows, contradicted the table's documented global
   scope) → **deleted 2026-07-18** rather than fixed.

## The two rules (each proven by a real instance — no rule without a requirement)

- **`nullable-conflict-key`** (instances 1, 2): a column IN the conflict target
  whose written value can be null (`x || null`, `x ?? null`, literal `null`/
  `undefined`, or a nullable conditional). `arm.contextBucket || GLOBAL_CONTEXT_BUCKET`
  is correctly NOT flagged — the fallback is a non-null sentinel.
- **`omitted-scope-identity`** (instance 3): a scope column (`repo_id`/`user_id`/
  `repo_name`) written on the row but absent from a DO-UPDATE/DO-NOTHING conflict
  target.

## Gate model: **drift-only** (not whole-tree) — and why

Run against the whole existing store, the lint is ~90% false-positive, because
the real store already handles this class correctly everywhere:

| Live finding | Verdict | Why it's not a bug |
|---|---|---|
| `learning_decisions` repo_id omitted | FALSE | `decision_key = auditRunId:…` is transitively repo-unique |
| `personas` repo_name omitted | FALSE | global registry keyed `(name, app_url)` by design |
| `persona_test_sessions` repo_id/repo_name | FALSE | `session_id` is a globally-unique surrogate |
| `symbol_index` / `symbol_layering_violations` repo_id | FALSE | `refresh_id`-scoped surrogate key |
| `plans` repo_id nullable | FALSE | an early-return guard makes repo_id non-null; `\|\| null` is dead |
| `persona_audit_correlations` audit_finding_id nullable | FALSE | flagged site is the non-null branch; the null branch uses a partial index |
| `debt_events` topic_id nullable | DORMANT | `?? null` on an idempotency key, but 0/145 rows null |

These false-positive shapes (surrogate/global natural keys, guard-narrowed
nullability) are **not mechanically distinguishable** from real bugs at the write
site. So a blanket whole-tree gate would be pure noise and would train everyone to
ignore it.

The gate therefore mirrors **nav-audit / visual-audit**: **drift-only** — a
finding gates only when its line is inside a changed hunk of the push (`git diff
@{u}`, falling back to the audit's dirty-aware base). Pre-existing design-correct
writers never gate; a NEW or edited bad conflict target does — which is exactly
when instances 1, 2, and 3 were introduced. Wired into `npm run check` as
`on-conflict:check`; `npm run on-conflict:all` lints the whole tree for manual
review.

## Escape hatch: the `@on-conflict-ok` pragma

For the rare case where an edit re-surfaces a design-correct-but-flagged site,
place `// @on-conflict-ok: <reason>` on or up to two lines above the `upsert`
call. The reason is mandatory (a reasonless pragma is itself flagged), and a
pragma over a site that no longer produces a finding is reported as
`orphaned-suppression` — suppressions can't silently outlive what they excused.

## Honesty over coverage

Instances 1 and 2 lived INSIDE builder functions (`buildBanditArmRows`,
`buildFpPatternRows`), not inline literals — so the extractor resolves a row
argument through bounded intra-file indirection: array literals, `.map()`
callbacks, local const bindings, local builder functions, and the store's
`for (const slice of chunk(rows, N))` batched-write idiom. A call site it CANNOT
resolve is reported as an `unresolved-upsert-rows` diagnostic (advisory, non-
gating) — never silently treated as clean. The `tests/on-conflict-lint.test.mjs`
"coverage guard" asserts the live store has ≤1 unresolved site, so a new
unreadable upsert shape (or a resolver regression) turns the suite red.

## Out of scope / follow-ups

- **`debt_events` topic_id `?? null`** — dormant (0/145 null) but a latent
  idempotency hole if a caller ever passes a null topicId. Worth a one-line fix
  (drop the `?? null`, or add topic_id to a NOT-NULL guard) in its own change.
