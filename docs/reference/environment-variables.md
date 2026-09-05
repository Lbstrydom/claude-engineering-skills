# Environment variables — full table

Moved out of `AGENTS.md` (2026-08-10) under its progressive-disclosure rule: a
lookup table is consulted *when you need a variable*, not every session, so it is
duplicated depth rather than a resident invariant. AGENTS.md keeps the handful of
rows whose **semantics constrain how you write code** (the kill switch, the
coupled timeout, the DSN pooler rule, the observation-only hint) plus a pointer
here.

Azure work-profile variables are documented separately in
[`docs/runbooks/azure-work-profile.md`](../runbooks/azure-work-profile.md).

## LLM providers + models

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | Yes | — | GPT access (audit model defaults to latest pinned GPT) |
| `GEMINI_API_KEY` | No | — | Gemini final review (Step 7 falls back to Claude Opus if absent) |
| `OPENAI_AUDIT_MODEL` | No | `latest-gpt` | Model sentinel or concrete ID (see AGENTS.md "Model Resolution") |
| `OPENAI_AUDIT_REASONING` | No | `high` | Reasoning effort |
| `GEMINI_REVIEW_MODEL` | No | `latest-pro` | Gemini model sentinel or concrete ID |
| `GEMINI_REVIEW_TIMEOUT_MS` | No | `270000` | Gemini timeout — sized for the CONSOLIDATED union-diff gate, not a per-cluster one (120s→180s 2026-07-31; 180s→270s 2026-08-10 after a 31-file union review timed out at 180s then ran 142s/130s). **COUPLED**: the watchdog floor is `2×timeout + 60000`, so 270s is the most the `FINAL_REVIEW_HARD_DEADLINE_MS` default admits — raise both together. Rationale: `config.mjs` `geminiConfig`. |
| `ANTHROPIC_API_KEY` | No | — | Claude Haiku fallback for brief generation (sdk backend only) |
| `CLAUDE_BACKEND` | No | `sdk` | Routing for Claude calls: `sdk` (raw API) or `cli` (`claude -p` headless — draws from Max 20x Agent SDK $200/mo credit from 2026-06-15). See AGENTS.md "Anthropic Backend Routing". |
| `CLAUDE_BIN` | No | `claude` | Path/name of the `claude` CLI (cli backend only) |
| `CLAUDE_FINAL_REVIEW_MODEL` | No | `latest-opus` | Claude Opus override (Step 7 fallback) |
| `BRIEF_MODEL_GEMINI` | No | `latest-flash` | Brief-generation Gemini model |
| `BRIEF_MODEL_CLAUDE` | No | `latest-haiku` | Brief-generation Claude model |
| `META_ASSESS_MODEL` | No | `latest-flash` | Meta-assessment Gemini model |
| `META_ASSESS_GPT_FALLBACK` | No | `latest-gpt-mini` | Meta-assessment GPT fallback when `GEMINI_API_KEY` is absent |
| `XAI_API_KEY` | No | — | xAI Grok access for the shadow final reviewer (`FINAL_REVIEW_SHADOW=xai`) and `scripts/grok-effort-preflight.mjs`. Native provider (own base URL/credential pair via `resolveXaiCreds()` in `model-resolver.mjs`), not an OpenRouter gateway route — no `X.AI_API_KEY` variant; the dot is unreachable as a shell variable name. |
| `ALIBABA_CLOUD_API_KEY` | No | — | Alibaba Cloud Model Studio access for the shadow final reviewer (`FINAL_REVIEW_SHADOW=alibaba`) — currently the qwen bake-off campaign arm. Native provider via `resolveAlibabaCreds()` in `model-resolver.mjs`; must be set together with `ALIBABA_CLOUD_BASE_URL`. |
| `ALIBABA_CLOUD_BASE_URL` | No | — | The Alibaba Cloud Model Studio **workspace** gateway (OpenAI-compatible `/compatible-mode/v1`) — a per-account host, not a universal endpoint, so there is no code fallback. Model ids routed here must be in `ALIBABA_POOL` (`model-resolver.mjs`) — a curated allowlist; qwen only as of 2026-08-17 (deepseek moved to its own direct API below after repeated timeouts on this workspace at real review size). |
| `DEEPSEEK_API_KEY` | No | — | DeepSeek's own direct API for the shadow final reviewer (`FINAL_REVIEW_SHADOW=deepseek`) — the deepseek bake-off campaign arm, moved off the Alibaba workspace 2026-08-17. Native provider via `resolveDeepseekCreds()` in `model-resolver.mjs`; the base URL (`https://api.deepseek.com/v1`) is a universal public endpoint hardcoded in code, unlike Alibaba's per-account gateway — only the key belongs here. Model ids must be in `DEEPSEEK_POOL` (`deepseek-v4-pro` / `deepseek-v4-flash` — no dated-snapshot suffix, unlike the Alibaba-hosted pin). |

## Shadow final review

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `FINAL_REVIEW_SHADOW` | No | — | Opt-in **shadow** final reviewer (observation-only A/B): `claude-opus` \| `anthropic` \| `gemini` \| `openrouter` \| `xai` \| `alibaba` \| `deepseek` — the key set of `SHADOW_PROVIDER_SPECS` (`scripts/lib/final-review/provider-specs.mjs`), verified 2026-09-04. The row previously named four, while the credential rows above documented `=alibaba` and `=deepseek`, so the document contradicted itself. Runs a second blind reviewer in parallel with the primary; never gates the build. No-op when unset or under an Azure profile. |
| `FINAL_REVIEW_SHADOW_MODEL` | No | per-provider | Concrete model / sentinel for the shadow reviewer. Unset → derived from the provider (`claude-opus`→`latest-opus`, `gemini`→`latest-pro`, `xai`→`latest-grok`). A family mismatch is a logged no-op. |
| `FINAL_REVIEW_SHADOW_SCOPE` | No | `full` | Envelope scope the shadow reviewer receives: `full` (byte-identical to the primary's own envelope — the historical baseline), `thin` (blind; drops repo-context, narrows code files to the in-scope diff, budget-capped — see `THIN_ENVELOPE_MAX_CHARS` in `scripts/lib/final-review/envelope.mjs`), or `gap` (thin + non-blind — also sees the primary reviewer's findings, projected and capped; campaign-ineligible per KD-5, since a gap shadow is conditioned on its own arm's primary result and isn't comparable across a cohort). An active campaign (`--campaign-digest` passed to `gemini-review.mjs`) requires a valid value and refuses `gap` outright, both before any provider call; outside a campaign an invalid value warns and falls back to `full` (the most expensive envelope, so a typo can't silently buy the cheap one). `--envelope-scope` on the CLI takes precedence over this variable. |
| `CAMPAIGN_HMAC_KEY_<CAMPAIGN_ID>` | Campaign-only | — | Per-campaign worksheet-integrity secret, name derived by `hmacKeyRefFor()` (`scripts/lib/store/campaign.mjs`) as `CAMPAIGN_HMAC_KEY_` + the campaign id uppercased with non-alphanumerics folded to `_` (e.g. campaign id `final-review-scoped-2026q3` → `CAMPAIGN_HMAC_KEY_FINAL_REVIEW_SCOPED_2026Q3`). Generate fresh per campaign (`crypto.randomBytes(32).toString('hex')`) — never reuse or rotate an existing campaign's key, which would orphan its human dispositions. |

`FINAL_REVIEW_{BASE_URL,API_KEY,MODEL,HARD_DEADLINE_MS}` (provider-agnostic
gateway + termination watchdog) are documented in the
[azure-work-profile runbook](../runbooks/azure-work-profile.md)
§Provider-agnostic final review.

## Audit store (Postgres)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `AUDIT_DB_URL` | No | — | **Postgres DSN** for the audit-loop store. Supabase users: dashboard → Connect → **Session pooler** (URI, port 5432). Unset → local-only mode (#16 graceful degradation). Replaces the legacy `SUPABASE_AUDIT_*` triplet (postgres-parity M4). |
| `AUDIT_DB_SSL_MODE` | No | `require` | TLS mode: `require` (default; strict verify), `no-verify` (accept self-signed — needed for Supabase poolers), `disable`. |
| `AUDIT_DB_POOL_MAX` | No | `4` | Maximum simultaneous pg connections. Increase only when the audit-loop's chunked upserts demand it. |
| `AUDIT_ALLOW_SCHEMA_BEHIND` | No | — | `1` lets `openai-audit.mjs` proceed when the store is provably behind this checkout (a bundled migration absent from `public.audit_loop_migrations`). Unset, the audit **refuses before spending**: a behind store rejects the `audit_runs` INSERT, so the run cannot be registered, no gate-evidence marker is written, and the commit reads `AI-Gate: not-run` however clean the audit was. The override keeps the findings and accepts that loss — it is announced at start and again at the end. Fail-OPEN either way: only a definite set difference blocks. |
| ~~`SUPABASE_AUDIT_*`~~ | — | — | **Sunset in M4** (postgres-parity). The audit-loop now uses `AUDIT_DB_URL` exclusively; the legacy URL + anon-key + service-role-key triplet was tied to the old `@supabase/supabase-js` PostgREST path which has been removed. The runtime DSN's password IS the secret — no separate write-role key. |

## Audit behaviour

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `SUPPRESS_SIMILARITY_THRESHOLD` | No | `0.35` | Jaccard threshold for R2+ suppression (0.0-1.0). Calibrated against a labelled corpus — do not retune casually; the 2026-08-14 re-raise that prompted Layer 3 scored **0.508** against it, so the matcher was working and the threshold was not the defect. |
| `AUDIT_DISMISSAL_REOPEN_REQUIRES_DECLARATION` | No | `true` | Layer 3. When true (default), a **dismissed** ledger entry whose file changed reopens only if the re-raise sets `is_reopened: true`; otherwise it is suppressed with a `declared=no` reason and counted in `reopenTelemetry.relitigationSuppressed`. `fixed`/`verified` entries are unaffected — they always reopen on touch, because regression detection must not depend on the model noticing. Set to `false` to restore the pre-2026-08-14 uniform behaviour. |
| `AUDIT_AUTHOR_TIER_HINT` | No | — | **Observation-only** (never routes). Optional author-model hint (concrete id e.g. `claude-sonnet-4-6`, or a logical tier `economy\|standard\|frontier`) read by the `author_tier` recorder in `openai-audit.mjs` to capture actual-vs-suggested tier + the ladder partition key. A concrete id populates the partition key; a bare logical tier leaves it null. See [`docs/plans/model-tier-observation.md`](../plans/model-tier-observation.md). |

## GitHub (check-setup "GitHub" section)

Read by `check-setup.mjs` and the doctor's `machine/github-permissions` probe.
Nothing here is required, and nothing here blocks — absence of a GitHub token is
a supported state, not a misconfiguration.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `GH_TOKEN` / `GITHUB_TOKEN` | No | — | The GitHub token the checks probe with. Resolved in `gh`'s own precedence (`GH_TOKEN` > `GITHUB_TOKEN` > `gh` keyring), with the repo `.env` slotted under genuine shell exports. A value present in `.env` is attributed to the FILE even though `load-env.mjs` has already put it in `process.env`. Not consumed by this repo's own tooling beyond the check — it is read to answer "which token would `gh` use here, and what does it grant?". |
| `GH_TOKEN_SOURCE_EXPECTED` | No | — | Declares which source SHOULD win in this repo: `shell` \| `dotenv` \| `keyring`. A **falsifiable declaration, not a mute**: when it holds, the "multiple tokens, different accounts" finding drops from WARN to INFO and the source line is annotated `[declared: …]`; when the declared source stops winning it WARNS *harder* than the generic case, naming the intent that is no longer met. An unrecognised value is reported as invalid rather than treated as an opt-out, so a typo cannot suppress the warning by accident. Set it in the repo `.env` next to the token it describes. Example: a work repo whose `.env` holds a work PAT while the `gh` keyring is logged into a personal account sets `GH_TOKEN_SOURCE_EXPECTED=dotenv`. It does **not** change `gh`'s precedence — a bare `gh` command still uses the keyring unless the `.env` token is exported. |

## persona-test

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `PERSONA_TEST_APP_URL` | No | — | Default app URL for persona-test list/add (per-project `.env`) |
| `PERSONA_TEST_REPO_NAME` | No | — | Repo name for cross-referencing audit-loop findings (per-project `.env`) |

## Memory-health gate

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `MEMORY_HEALTH_WINDOW_DAYS` | No | `30` | Lookback window |
| `MEMORY_HEALTH_FUZZY_RATE` | No | `0.15` | Fuzzy re-raise rate trigger threshold |
| `MEMORY_HEALTH_CLUSTER_MEDIAN` | No | `5` | Cluster density trigger threshold (median similar pairs/repo) |
| `MEMORY_HEALTH_RECURRENCE_RATE` | No | `0.10` | Fixed-finding recurrence rate trigger threshold |
| `MEMORY_HEALTH_MIN_FINDINGS` | No | `50` | Minimum findings in window to report a trigger (below → INSUFFICIENT_DATA) |
| `MEMORY_HEALTH_RPC_TIMEOUT_MS` | No | `240000` | Caller-side bound on `memory_health_metrics` (the function's own `SET statement_timeout` is inert). Sized under the maintenance runner's 300s spawn budget so a runaway is a loud `57014`, not a silent kill. |

See [`memory-health-gate.md`](memory-health-gate.md) for what these thresholds
govern.

## Learning system

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `LEARNING_DISABLE` | No | — | Set to `1` to disable all adaptive-learning live behaviour and telemetry recording (single env-var kill switch). |
| `LEARNING_REPO_NAME` | Required for weekly-review | — | Per-repo gate for `weekly-review.mjs`. Aborts if missing — prevents cross-tenant data leakage in the digest issue body. **Must be the `owner/repo` slug** (matches `audit_repos.name`, derived from the git origin URL via `resolveRepoIdentity()`) — the bare repo name silently misses the lookup (`{posted:false, reason:'unknown-repo'}`), which is exactly how this sat broken for weeks in every consumer before 2026-07-22. `install.mjs`/`setup.mjs` now derive it automatically; don't hand-type it. |
| `LEARNING_QUEUE_CAP_PER_TYPE` | No | `64` | Per-`decision_type` bounded sub-queue cap. Increase for high-throughput audits. |

## Remediation-state verification reconciler

`scripts/remediation-reconcile.mjs` — the out-of-band writer for `accepted`/
`severity_adjusted` findings stuck `pending`/`planned` outside the live-audit-
round lifecycle's reach. [`docs/plans/remediation-state-verification-reconciler.md`](../plans/remediation-state-verification-reconciler.md).

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `AUDIT_REMEDIATION_RECONCILE_ENABLED` | No | `true` | Set to `false` to disable the reconciler entirely (both the `/ship` 0.5e capped call and the `remediation-reconcile` weekly-maintenance entry check this before any DB/LLM call). |
| `AUDIT_REMEDIATION_RECONCILE_MODEL` | No | `latest-sonnet` (sentinel — see [Model Resolution](model-resolution.md)) | The verifier model. A real code-reading judgment call per file batch, not a naming/labelling task — Haiku is too weak, Opus is unnecessary. |

## Consumer dependency install

`scripts/lib/install/deps.mjs` — the per-phase ceilings on the package-manager
install the sync runs in a consumer repo. They are **ceilings on a network
operation, not budgets**: on a warm cache both phases finish in seconds, and a
generous ceiling only changes how long a wedged install takes to give up.

Two numbers, not one, because the optional phase downloads `playwright` and the
required phase does not. A single 120s cap covering both was measured on
2026-09-04 killing installs that then turned out to have succeeded, and — since
a caller had independently chosen a 240s bound for the whole sync — killing the
caller too. A cap-kill is now reported as `dependency install timed out`, kept
distinct from a manager-reported failure, and adjudicated by re-probing
`node_modules` rather than by the exit code.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `AUDIT_DEPS_INSTALL_TIMEOUT_MS` | No | `300000` | Ceiling on the REQUIRED-dep install phase. A non-integer or non-positive value falls back to the default — it never disables the cap. |
| `AUDIT_DEPS_OPTIONAL_INSTALL_TIMEOUT_MS` | No | `600000` | Ceiling on the OPTIONAL-dep phase (`codeowners-utils`, `proper-lockfile`, `playwright`). Higher than the required phase by design. |
