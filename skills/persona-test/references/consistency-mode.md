---
summary: Full consistency-mode grammar, manifest schema, canary schema, runner exit codes, contradiction kinds.
---

# Consistency Mode — Full Reference

Loaded on demand when `/persona-test --mode consistency` runs.
Canonical user-facing contract: [docs/reference/consistency-contract.md](../../../docs/reference/consistency-contract.md).
This file is the *operator's* deep dive — the canonical doc is the
*adopter's* surface contract.

---

## Execution model

Consistency mode runs on **code-owned Playwright**, not Playwright MCP.
This is the critical departure from exploratory persona-test mode:

| Concern | Exploratory mode | Consistency mode |
|---|---|---|
| Browser driver | Playwright MCP via Claude Code tool calls | `playwright` npm package directly |
| Step authoring | LLM at runtime | `canary.journeySteps[]` declared ahead of time |
| Capture timing | n/a (no synchronous capture) | Synchronous between Act and the next action |
| Reproducibility | Best-effort — LLM choice varies per run | Byte-identical given same `fixtureSeed` |

The LLM authors canaries (ahead of time, or extracted from an exploratory
session). The runner executes them deterministically.

---

## Contradiction kinds

Every contradiction carries a `kind` so downstream filters, fingerprints,
and reports can dispatch on the failure mode. The seven kinds in v1:

| Kind | When it fires |
|---|---|
| `value-mismatch` | DOM value (after type coercion) doesn't equal the matched network ground truth |
| `stale-projection` | `data-freshness="stale"` on a visible element, regardless of value match — severity from manifest `severityFloor` |
| `undeclared-engine-claim` | DOM element carries `data-engine-claim="X"` but `X` isn't declared in `surfaces.json` (P0) |
| `missing-surface` | A surface in `surfaces.json` whose `appliesTo` matches the current context is absent from the DOM (P3) |
| `value-coercion-error` | DOM string can't be coerced to the manifest's declared type (e.g. `data-engine-value="seven"` for a `count` field) |
| `absent-not-rendered` | DOM freshness disagrees with the null-ness of the engine ground truth (engine null → DOM must be `absent`; engine present → DOM must not be `absent`) |
| `key-coercion-error` | `data-engine-key` can't be coerced to the inferred JSON type of `collectionBinding.keyField` |

---

## Type coercion matrix

The diff engine coerces every DOM string to the manifest's declared type
before equality. Rules per `engineFields[].type`:

| Type | Accepts | Rejects → emits |
|---|---|---|
| `boolean` | exactly `"true"` or `"false"` | anything else → `value-coercion-error` |
| `integer`, `count` | round-trip-equal integer string (`"42"`) | `"42abc"`, `""`, fractional → `value-coercion-error` |
| `enum` | string ∈ `semanticValues` (when declared) | unknown enum value → `value-coercion-error` |
| `id` | any string | n/a |
| `freshness` | any string | n/a (freshness contract handled separately via `data-freshness` attr) |
| `prose` | any string | n/a; routed to `semantic-compare` if `llmSafe: true`, else skipped |

Key coercion (for `data-engine-key` ↔ JSON keyField) follows the inferred
type of the first matching response (cached for the session).

---

## Severity floor — which kinds bypass it (resolves wine-cellar adoption #7)

`severityFloor` applies to **state-contradiction kinds** (`value-mismatch`,
`stale-projection`, `absent-not-rendered`, `undeclared-engine-claim`,
`value-coercion-error`, `key-coercion-error`). For these the floor
clamps the proposed severity UP — a P0-floor surface emitting a P2
proposed value-mismatch ends up P0.

`severityFloor` does NOT apply to **rig observability kinds**:

- `missing-surface` — fixed at P3 (declared surface absent from current
  context; appliesTo-gated)
- `unresolved-ground-truth` — fixed at P2 (rig couldn't see engine
  truth; manifest may be misconfigured)

The rationale: these aren't state mismatches, they're notes about what
the rig DID see vs what it COULD see. The floor is for contracts;
observability findings live in a fixed severity tier so operators see
them consistently. They DO appear in the contradiction list, but they
don't count toward `expectedContradictions.min` — that gate is
state-mismatch-only.

## Stale-projection rule (Gemini-R2-G4 resolution)

`data-freshness="stale"` + element visible → emit `stale-projection`
contradiction at the **surface's `severityFloor`**, NOT a hardcoded P0.

The rationale: stale-while-revalidate, optimistic updates, and background
sync are legitimate UX patterns. Consumer apps tune:

- Status chip with contract-critical currency → `severityFloor: 'P0'`
- Restock advisor where stale copy is acceptable → `severityFloor: 'P2'`

The contradiction is ALWAYS emitted so the ledger has the audit trail;
severity controls what `/ship` does with it.

---

## Null ground-truth rule (Gemini-R4-G3)

| Engine value | Required DOM `data-freshness` | Otherwise |
|---|---|---|
| `null` | `"absent"` | emit `absent-not-rendered` (DOM falsely claims a value) |
| non-null | NOT `"absent"` | emit `absent-not-rendered` (DOM falsely claims unknown) |

When `data-freshness="absent"` is correctly paired with `null` engine
truth, `data-engine-value` is ignored — the surface explicitly says
"no claim".

---

## Negative-space rule

Two directions:

- **DOM → manifest**: any DOM element with `data-engine-claim="X"` where
  `X` isn't declared in `surfaces.json` for the matching surface →
  P0 `undeclared-engine-claim`. The capture library populates
  `witness.undeclaredDomClaims[]` for this.

- **Manifest → DOM**: any surface with no matching DOM element in the
  current step → P3 `missing-surface`, but ONLY if `appliesTo` resolves
  truthy for the current context (route pattern / step label / state
  tags). Route-conditional surfaces don't false-positive on pages where
  they were never expected.

---

## Cross-stream invariant

Semantic comparison (LLM) is invoked ONLY for `prose` fields with
`llmSafe: true`. The invariant is enforced at TWO boundaries:

1. **Dispatch in `consistency.mjs`** — the diff engine routes by type;
   typed fields go through exact-match, prose goes through `semanticCompare`.
2. **Defence in `semantic-compare.mjs`** — the `compare()` function
   refuses to run for any `fieldType !== 'prose'` by throwing
   `Error('CROSS_STREAM_VIOLATION: …')`. This catches misuse if some
   caller bypasses the diff engine.

Test coverage asserts the throw for `type: 'boolean'`.

---

## LLM egress contract

Every semantic-compare call passes through `scripts/lib/redact.mjs` BEFORE
the provider call. Steps:

1. Cap both inputs to `engineFields[].llmMaxChars` (default 2000); on
   truncation, the verdict carries `reason: 'prose-truncated-for-llm'`.
2. Run both inputs through `redact()` — secret patterns replaced with
   `[REDACTED:<pattern-name>]`.
3. Cache lookup by sha256 of redacted text + model id — cache hits
   return zero-cost zero-latency verdicts.
4. If `opts.callLLM` is not wired, return
   `{ matched: 'uncertain', reason: 'comparator-not-configured' }`.
5. Log to `.persona-test/semantic-egress.log` (gitignored) with
   `{timestamp, surfaceId, charsIn, costUsd, redactionCount, truncated}` —
   never the prose itself.

The verdict envelope follows the repo-standard `{result, usage, latencyMs}`
shape. The inner `SemanticVerdict` is `{matched, score?, reason?}` only —
operational telemetry never lives inside the verdict (Gemini-R4-G4).

---

## Exit codes

Set by `scripts/persona-consistency-run.mjs`. Always-persist-then-exit:
the ledger is committed BEFORE process termination, except in case 4.

| Exit | Verdict | Meaning |
|---|---|---|
| `0` | `healthy` | Canary expectations met; zero or fewer-than-min contradictions |
| `2` | `broken` | Canary `expectedContradictions` violated — rig itself is suspect |
| `3` | `fatal` | Manifest missing / canary schema invalid / Playwright disconnected |
| `4` | n/a | Ledger persist failed (disk full / permission); no ledger written |
| `5` | `fatal` | Playwright npm dep missing; run `npx playwright install chromium` |
| `6` | `app-error` | A journey action threw (TimeoutError, element-missing) — APP regression, NOT rig issue |

Exit 4 is intentionally distinct from exit 3: "rig found a problem" vs
"rig couldn't record a problem" are different operational states.

---

## Idempotency replay

`normaliseForReplay(ledger)` strips:

- All timestamps (`startedAt`, `endedAt`, per-step `durationMs`)
- Semantic-verdict telemetry (`usage`, `latencyMs`, `costUsd`)
- `cache_hit` flags from semantic verdicts
- Sorts `witness.domClaims[]` by `(surfaceId, scope, key)`
- Sorts `witness.networkClaims[]` by `(surfaceId, engineField)`

Two runs of the same canary + same `fixtureSeed` → byte-identical
normalised ledger. Catches non-deterministic AI copy and timing-dependent
captures that would otherwise hide as flakiness.

---

## Candidate emission

For every contradiction with `severity ∈ {P0, P1}` AND a resolved
surfaceId, the runner emits a candidate row via `cross-skill.mjs`:

- `source_kind = 'persona-consistency-candidate'`
- `candidate_fingerprint = sha256(repoId + journeyKey + surfaceId + engineField + contradictionKind + normalisedLocator)`
- `witness_snapshot` carries the relevant WitnessRecord slice (deep-redacted)
- `contradiction_payload` carries the Contradiction record (deep-redacted)
- `journey_context` carries `canary.journeySteps[0..stepIndex]` plus
  `authBootstrap` + `routes` so the spec renderer at promotion has the
  navigation context

Re-emit suppression: before INSERT, the writer checks for an existing
`persona-consistency-locked` row with the same fingerprint. If present,
candidate emission is skipped and the ledger records
`suppressedByLockedSpec: <specId>` on the contradiction.

The partial unique index `(repo_id, candidate_fingerprint) WHERE … repo_id IS NOT NULL`
makes the candidate INSERT effectively an upsert per `(repo, fingerprint)`.

---

## Where this connects

- **Phase 0 contract layer**: `scripts/lib/persona-test/schemas.mjs`,
  `scripts/lib/redact.mjs`, migration `20260520120000`, `docs/reference/consistency-contract.md`.
- **Phase 1 (this PR)**: `manifest-resolver.mjs`, `consistency.mjs`,
  `semantic-compare.mjs`, `context.mjs`. SKILL.md Phase 3b dispatches.
- **Phase 2 (next)**: `scripts/lib/ux-lock/capture.mjs` —
  `captureWitness(page, manifest)` using `page.on('response')` +
  cumulative session-wide `NetworkGroundTruth` store.
- **Phase 3 (after)**: `scripts/lib/persona-test/ledger.mjs` — atomic
  per-step JSON writes; mandatory persistence for every terminal state.
- **Phase 4**: `scripts/lib/persona-test/canary.mjs` + `scripts/persona-consistency-run.mjs`.
- **Phase 6**: `/ship` promotion of candidates → locked specs.
