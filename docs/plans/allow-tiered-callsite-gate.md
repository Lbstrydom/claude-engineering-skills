# allowTiered — per-call execution gate for tiered pipeline / shadow

- **Status**: Complete — audited (`/audit-code`, 1 GPT round + Gemini APPROVE, 0 new findings), shipped, verified via direct repro + full suite (5011 passed).
Date: 2026-07-13

## Problem (observed live, not hypothetical)

`AUDIT_TIERED_PIPELINE_ENABLED` / `AUDIT_TIERED_SHADOW_ENABLED` are operator-
intent flags loaded from the shared `~/.audit-loop.env` into **every** Node
process in every repo — including `npm test`. `runMultiPassCodeAudit` has
multiple callers (production CLI `main()`, model-eval's `runAuditGenerationArm`,
test harnesses that stub only the `openai` argument), and the flags alone
routed ALL of them into tiered/shadow execution. With the shadow flag flipped
on (2026-07-13), fully-mocked unit tests began executing the real tiered
pipeline — real GLM/Sonnet API calls and real `gemini-review.mjs` subprocess
spawns from inside stubbed tests; the full suite went 54s → 6.5 minutes.
The same latent hazard existed for `pipelineEnabled` (it would have fired at
the Phase 14 flip).

## Fix (intended behavior)

Execution eligibility is a **per-call property**, separate from the operator
flags. A new `allowTiered` boolean (default `false`) on the audit-run context:

1. `AuditRunContextSchema` (`scripts/lib/schemas.mjs`): new optional
   `allowTiered` field, documented.
2. `buildAuditRunContext` (`scripts/lib/audit/legacy-production-audit.mjs`):
   destructures `allowTiered = false`; the tiered/shadow provider handles
   (`anthropicClient`, `ossCall`, `geminiReviewCall`, `geminiCleanRegionCall`)
   are constructed only when `(pipelineEnabled || shadowEnabled) && allowTiered`;
   `allowTiered` is included on the returned ctx.
3. `runMultiPassCodeAudit` (`scripts/openai-audit.mjs`): the tiered-pipeline
   chooser requires `tieredAuditConfig.pipelineEnabled && ctx.allowTiered`;
   the shadow comparison requires `tieredAuditConfig.shadowEnabled &&
   ctx.allowTiered`.
4. `main()` (`scripts/openai-audit.mjs`) — the ONE production CLI entrypoint —
   passes `allowTiered: true`. No other caller does: test harnesses and
   `runAuditGenerationArm` (model-eval generation must always exercise the
   legacy 5-pass shape it evaluates) stay hermetic/legacy regardless of env.

Both conditions must hold to spend: env flag (window open) AND call-site opt
(this invocation is a real production audit).

## Non-goals

- No test-environment detection in production code (`NODE_TEST_CONTEXT`
  sniffing etc.) — that would make tests non-representative and is the
  band-aid this fix avoids.
- No change to what the shadow does when eligible; only WHO is eligible.

## Tests

`tests/tiered-pipeline-wiring.test.mjs` — hermetic subprocess probes (config
freezes at import, so the env var is forced in a child process): flag ON +
no opt → zero provider construction; flag ON + `allowTiered: true` → all four
handles constructed. Plus the original repro re-verified: the previously-
hanging harness file runs at baseline speed with the flag forced on.
