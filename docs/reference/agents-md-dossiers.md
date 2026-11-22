# AGENTS.md dossiers (moved text)

Text moved out of [AGENTS.md](../../AGENTS.md) to cut the context every session loads on every turn
([plan](../plans/agents-md-kernel-shrink.md)). Each section keeps its AGENTS.md H2 heading and holds the moved units
**verbatim** as they stood at `b52a77f1`, except that repo-root-relative link targets gain a `../../` prefix. The rule
each section enforces still sits in AGENTS.md as a shortened tripwire: this file is the detail, not the rule. Where a topic
doc exists, AGENTS.md links it; prefer it for anything newer than the stage that moved the text.

## Browser Tool Setup (persona-test)

<!-- moved in stage 1, 2026-11-22; rebased to 4ba6c280 (#450 rewrote this unit before stage 1 merged) -->

`/persona-test` drives a real browser through a declared driver contract (`references/browser-tool-detection.md`, shared with `/click-test`): any driver meeting the capability set works, and the host's built-in browser pane (`mcp__Claude_Browser__*`) is what most sessions actually use (63 of 110 measured; Playwright snapshots 16). **Playwright MCP is the pinned, free, credential-less fallback** (registered in `.mcp.json`). **First-time setup: `npx playwright install chromium`** — without it the server crashes silently and no tools appear. Windows may need an MCP override: [CLAUDE.md](../../CLAUDE.md#claude-code-only-notes). BrightData alternative: [mcp-tooling.md](../../docs/runbooks/mcp-tooling.md).

## Mermaid validation (for plan diagrams)

<!-- moved in stage 1, 2026-11-22 -->

**Interactive**: call **`mcp__mermaid__generate_mermaid_diagram`** with `outputType: "mermaid"` to validate without rendering — invalid syntax returns an MCP error with line/column, no API key. **Pre-push**: `npm run plans:lint` (in `check`) scans `docs/plans/*.md` for what the parser accepts but stricter renderers reject — **ERROR `subgraph-as-edge-endpoint`** (anchor the edge to a node *inside* the subgraph) blocks; **WARN `unquoted-special-chars-in-label`** (write `ID["..."]` when a label has `<br/>` or non-ASCII) is advisory. Registration and rule-coverage rationale: [mcp-tooling.md](../../docs/runbooks/mcp-tooling.md).

## Model Resolution

<!-- moved in stage 1, 2026-11-22 -->

`scripts/lib/model-resolver.mjs` resolves model IDs so config stops going stale
when providers ship new versions. All model-reading env vars in config.mjs pass
through `resolveModel()`.

**Sentinels** (preferred in `.env`) — `latest-gpt`, `latest-gpt-mini`,
`latest-opus`, `latest-sonnet`, `latest-haiku`, plus Google's `latest-pro` /
`latest-flash` / `latest-flash-lite`. A sentinel picks the newest tier match from
live-catalog ∪ `STATIC_POOL`; a stale concrete id is remapped with a one-time
warning; concrete ids pass through. Heavy entry points refresh the catalog and
re-resolve, so new provider models need no `STATIC_POOL` edit
(`MODEL_CATALOG_REFRESH=skip` opts out for air-gapped CI; a network failure falls
back silently). Self-check: `node scripts/lib/model-resolver.mjs resolve | catalog`.

**Anti-patterns (load-bearing):**
- Do NOT pin concrete model IDs in new code — use a sentinel (`latest-*`).
- Do NOT drop `-preview` from Gemini 3 IDs unverified — bare `gemini-3-flash` /
  `gemini-3.1-pro` never shipped (Google 404s). Verify via the `…/v1beta/models` list.
- Do NOT retry 404 — `classifyLlmError` treats any 4xx (except 429) as non-retryable.
- When rewrapping an LLM error, surface `err.status` + the real provider
  `error.message` — don't collapse to `"API error ${status}"` (it names the bad model).
- **OpenRouter**: one model id → many backends with incompatible ctx limits, picked per request, and reasoning tokens count against `max_tokens`. Unpinned runs fail at random, reading as model flakiness — always send `provider:{require_parameters,sort}` + `reasoning:{effort}`. [experiment-4](../../docs/research/experiment-4-cheap-final-reviewer-smoke.md)
- **A model id carries its ROUTE, and the two are never reconciled.** Some models
  are reached BOTH natively and via OpenRouter (`qwen3.8-max` vs
  `qwen/qwen3.8-max`); `transportForModel` dispatches on exactly that shape and
  the routes bill differently, so **never "normalise" `source_model`** — it erases
  the routing decision and corrupts costing. What must NOT vary by route is the
  vendor **family**: call `modelFamily`, never a local head-of-string helper —
  reading the vendor off whichever half of the id was present is how a model
  grading its own output got recorded as unbiased (`self_family`, fixed
  2026-08-23). A new vendor needs `VENDOR_ALIASES` too; `npm test` fails until it has it.

→ Per-sentinel table, resolution order, live-catalog mechanics, startup-log
example, static-pool maintenance:
[`model-resolution.md`](../../docs/reference/model-resolution.md).

## Memory-Health Gate

<!-- moved in stage 1, 2026-11-22 -->

`scripts/memory-health.mjs`: three trigger metrics deciding whether the flat
`audit_findings` + fingerprint-dedup design leaks signal a graph memory would
recover. A weekly AMBER, a metric change, promoting the graph design:
[`memory-health-gate.md`](../../docs/reference/memory-health-gate.md).
**Resident**: a new wave that emits control state needs a
`control_marker_prefixes` sentinel (matched on the detail-snapshot **prefix**,
never the category), or the gate reads AMBER forever on its own logging.

## Learning System (Phase 1)

<!-- moved in stage 1, 2026-11-22 -->

Adaptive-learning telemetry across audit decision points → `learning_decisions` +
`recurring_finding_clusters`. Auto-deferral, `learning:*`, the weekly review,
replay/promotion:
[`learning-system.md`](../../docs/runbooks/learning-system.md). **Resident**:
`LEARNING_DISABLE=1` kills all live learning + telemetry; telemetry never crashes
a run (flush failures spill to `.audit/learning-outbox/`); a plan accepts a v1
limit with `<!-- audit:accept-v1: <glob> :: <reason> -->`.

## Shadow Final-Review A/B — CLOSED 2026-07-28, verdict KEEP

<!-- moved in stage 1, 2026-11-22 -->

Opt-in, observation-only 2nd final reviewer (`FINAL_REVIEW_SHADOW`); committed
default unset, paused locally on cost. Unset ⇒ byte-identical; never gates. Read
it **before any reviewer/model comparison** (three results that generalise):
[briefing](../../docs/research/final-review-shadow-adjudication-briefing.md) ·
[plan](../../docs/plans/final-review-shadow-reviewer.md).

## Tiered-Recall Audit Pipeline

<!-- moved in stage 1, 2026-11-22 -->

Discovery → Stage 0/1/2 alternative to the GPT 5-pass legacy audit; chooser
`AUDIT_TIERED_PIPELINE_ENABLED` defaults **off** (production runs legacy).
Enabling it, its shadow window, Phase 14:
[`tiered-recall-audit-pipeline.md`](../../docs/plans/tiered-recall-audit-pipeline.md).
Resident:

- **Execution eligibility is per-call, not env-global** (`allowTiered`): only
  `openai-audit.mjs`'s `main()` passes `allowTiered: true`, so tests and library
  callers can never spend. Both must hold before a provider is constructed.

## Model Swap-In Evaluation Harness

<!-- moved in stage 1, 2026-11-22 -->

`scripts/lib/model-eval/` answers "is this new LLM release worth switching to?" for
the auditor or adjudicator role. Playbook, tiers, recall-ceiling caveat, verdict
history: [`model-eval-harness.md`](../../docs/runbooks/model-eval-harness.md). Resident,
because they bind any measurement work:
- **A model swap is SYNCHRONOUS, never a background window**: run it when the
  model ships, adjudicate in the same sitting, verdict → `docs/research/`. Passive
  collection killed arm-eval and produced five false "window met" reads. Only
  intervention-over-organic-work earns a shadow; exactly two are open
  (tiered-pipeline, final-review 2nd gate). **Do not add a sixth collector.**
- **Evidence counts only if produced under the contract the stopping rule
  validates**: stamp `contractEpoch` **at the collector** and verify by match.
  Unstamped ⇒ ineligible, never "assume current"; bump on a meaning-changing fix
  and re-collect — **never backfill by date**, the relabelling that let the fifth
  false green through.

→ Design: [`docs/plans/model-swap-eval-harness.md`](../../docs/plans/model-swap-eval-harness.md).

## Local Weekly Maintenance Checks (opt-in)

<!-- moved in stage 1, 2026-11-22 -->

Default-OFF local replica of the weekly maintenance checks, run from the pre-push
hook when overdue (`AUDIT_LOOP_WEEKLY_MAINTENANCE=1`; `npm run maintenance:status`)
— in THIS repo the only runner of the four store-backed checks, whose Actions
crons were deleted 2026-09-13. Enabling it, a stale heartbeat,
`runner:doctor`/`cadence:doctor`:
[local-maintenance-checks.md](../../docs/runbooks/local-maintenance-checks.md) ·
[workflow-cadence-doctor.md](../../docs/reference/workflow-cadence-doctor.md).
**Resident**: a cadence is OBSERVED, never trusted for having been configured, and
**`ok` means "the run did not fail", not "the thing it measures is current"** — so
a workflow skip branch emits `::notice title=audit-loop-no-measurement::<reason>`
(`lib/measurement-marker.mjs`); never grep the job log for it.

## Azure AI Foundry Work Profile

<!-- moved in stage 1, 2026-11-22 -->

The **same** bundle in a corporate Azure tenant (restricted models), env-selected.
**Opt-in invariant**: the Azure path activates **only** when `AZURE_OPENAI_ENDPOINT`
is set; without Azure env vars, client construction and resolved models are
**byte-identical** to the public path. Seams: `createOpenAIClient({purpose})`,
`embedText()`, `azureConfig` in [config.mjs](../../scripts/lib/config.mjs). Dossier
(tenant setup, `AZURE_CLAUDE_ROUTE`, 401/404/429, quota):
[`azure-work-profile.md`](../../docs/runbooks/azure-work-profile.md).

**Four invariants that constrain any code reaching a provider**:

- **An availability gate must ask whether a ROUTE exists, not whether a public env
  var is set.** An `if (!process.env.OPENAI_API_KEY)` guard upstream of an
  Azure-aware seam is dead code on exactly the installs it was written for (tell: a
  **failure with zero latency**). Let ONE oracle answer
  (`lib/provider-availability.mjs`); use **`isClaudeAvailable()`, never
  `ANTHROPIC_API_KEY`**. An **omitted `azureRoute` ADOPTS the tenant's route**;
  pass `azureRoute: null` only where an id *means* the public service. Tests
  spawning such a CLI must scrub `AZURE_*`. Which voices /brainstorm runs is
  `defaultProviders()`, never a constant.
- **The deployment is CONSTRUCTOR-level route state, not a body field**: build
  `AzureOpenAI({endpoint, deployment, apiVersion})`, **never concatenate an
  operation path**, and never share one client across purposes.
- **An endpoint and the credential it is addressed with are ONE unit** — pass
  `azureConfig.claudeRoute` as `createAnthropicClient({azureRoute})`, **never a
  bare `baseURL`**. Assert on the **emitted request**, not the client config.
- **A deployment or resource switch is a DIFFERENT vector space** — provenance is
  `resolveEmbedProfile()`, and `arch:refresh` auto-promotes to a full re-embed.

## Cross-Skill Data Loop

<!-- moved in stage 1, 2026-11-22 -->

Migration `20260419120000_cross_skill_data_loop.sql` closes the feedback loop
between the skills. Catalogue (9 tables, 3 columns, 6 views, the bandit reward
extension, the `recommend-skills` advisor):
[`cross-skill-data-loop.md`](../../docs/reference/cross-skill-data-loop.md).

**Design rule**: all cross-skill writes go through `scripts/cross-skill.mjs`, a
graceful no-op when the cloud store is off. Never hand-write curl POSTs in a
SKILL.md for these tables — the CLI handles auth, graceful no-op, git-derived
commit_sha and error normalisation.

## R2+ Audit Mode (Phase 1)

<!-- moved in stage 1, 2026-11-22 -->

`--round >= 2` (with `--ledger`/`--diff`/`--changed`) enables three-layer defence
against finding churn: rulings injection, R2+ prompts, post-output suppression.
The **Adjudication Ledger** is two-axis — `adjudicationOutcome` ×
`remediationState`, written via `writeLedgerEntry()`. Changing suppression, a
rulings group or the existence gate: read
[`r2-audit-mode.md`](../../docs/reference/r2-audit-mode.md) first. Resident: a rulings
header claims only what its ruling ESTABLISHED, and hard-suppress keys on the
CONCERN, never on category text — an overstated header or fuzzed category
suppresses true positives silently.

## Security incident memory — mandatory consultation

<!-- moved in stage 1, 2026-11-22 -->

Companion to architectural memory. `/plan` auto-fires
`get-incident-neighbourhood` in Phase 0.5b — for ad-hoc fixes outside `/plan`,
consult it by hand before writing security-relevant code:

`node scripts/cross-skill.mjs get-incident-neighbourhood --json` with the same
`targetPaths` / `intentDescription` shape and `k: 3`.

**When to consult**: any change to auth flows, payment handling, input parsing,
logs that might carry sensitive data, external API calls with credentials, file
uploads, or any domain named in a `docs/security-strategy.md` incident. **NOT**:
UI tweaks, type-only refactors, test fixtures, doc-only or cosmetic edits.

If the response includes incidents with `mitigation-failing` or
`manual-verification-required` status matching your target paths, address them
explicitly in the design before proposing code. If `docs/security-strategy.md`
doesn't exist here, run `/security-strategy bootstrap` once to seed it; `/ship`
surfaces security-relevant commits in a one-line post-push reminder.

### Secret pre-write gate + audit trail (back-port from corporate kit)

`npm run security:refresh` gates every parsed incident before it reaches the DB
([secret-classifier.mjs](../../scripts/lib/security/secret-classifier.mjs)):
high-confidence secret shapes **REFUSE** (not indexed, non-zero exit — scrub
`docs/security-strategy.md` and re-run); low-confidence PII **auto-REDACTs** into
the stored row, and writes append to `security_strategy_events`. One
defence-in-depth invariant: the final-pass redactor is the gentle
`lib/secret-patterns.mjs`, deliberately **NOT** `sanitizer.mjs`, which
blanket-redacts any 20+ char token and would corrupt incident prose. Full kit:
[docs/plans/security/](../../docs/plans/security/).

## Quick-fix detection — two-layer architecture

<!-- moved in stage 1, 2026-11-22 -->

**Philosophy**: nudge, not gate — root cause beats shortcut, explicit acceptance
beats a silent one.

**The RULE is host-neutral; the hook is Claude-Code-only ACCELERATION** (same
shape as arch-memory above). *Rule*: a shortcut signature is surfaced to the
author before the change is called done — satisfied when EITHER layer ran.
*Portable path (all hosts)*: **Layer 2**, the `quickfix` wave in /audit-code, a
low-reasoning GPT pass for DESIGN-level shortcuts regex can't see; emits
`is_quick_fix: true`, gated by the `quickFix == 0` convergence threshold.
*Accelerator (Claude Code only)*: **Layer 1**,
`.claude/hooks/quickfix-scan.mjs` — pure-regex on every Edit/Write, emits a
`<system-reminder>`, NEVER blocks. Two layers because neither covers the other's
axis: mechanical-at-edit-time vs semantic-at-review-time. **Cadence is NOT
equivalent** — hook = every edit, wave = once per audit, so on Copilot a shortcut
is caught later and only in audited changes; say so rather than implying parity.
Signatures and opt-outs:
[enforcement-mechanisms.md](../../docs/reference/enforcement-mechanisms.md)
§The two accelerators · full spec:
[`brainstorm-quickfix-v1.md`](../../docs/plans/brainstorm-quickfix-v1.md) §B.

## Where enforcement lives — NOT in a `$PATH` wrapper

<!-- moved in stage 1, 2026-11-22 -->

**Enforcement goes into the code that performs the action — host-agnostic and
fail-closed.** `assertDisposableDbUrl` is the pattern: the destructive suites
cannot run against a non-loopback DSN because **the code refuses**, on every host,
with no PATH and no hook. Its limit is the honest part — it covers only actions
that go through repo code, so a raw-shell gotcha ("never bare `git stash` in a
shared tree") has no interception point and stays prose on every host.

**A `$PATH`-wrapper layer — a `.bin/` prepended to `PATH` shadowing `git`/`npm` to
intercept dangerous invocations — was proposed for exactly that gap and REJECTED
2026-11-15**: machine/shell-global state (the retired-surface shape, §Skill Chain
invariant 2); `spawnSync('git', …)` resolves through PATH, so the gates' own
tooling would run through it and a bug in it reads as a clean gate; PATH shadowing
resolves differently in Git Bash, PowerShell and `cmd`; and it is invisibly
bypassable, so it is an accelerator at far higher blast radius. The four reasons
and the forcing question for the next such proposal:
[`enforcement-mechanisms.md`](../../docs/reference/enforcement-mechanisms.md).

## Commit provenance trailers (`AI-*`)

<!-- moved in stage 1, 2026-11-22 -->

`/ship` commits carry `AI-*` git trailers (`AI-Skill`/`AI-Models`/`AI-Gate`/…)
written ONLY by `ship-commit.mjs` and `ship-train.mjs` — **never hand-typed; the
`AI-*` namespace is reserved.** `AI-Gate` is `passed`/`converged` (verified against
the store) or `waived`/`not-run` (declared); **`passed` is rare by design** — never
hand-write `.audit/last-audit-run.json` or reorder a ship to chase it. Reading or
querying trailers, and gate refusals:
[`commit-provenance.md`](../../docs/reference/commit-provenance.md).
