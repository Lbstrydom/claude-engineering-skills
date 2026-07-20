# Azure AI Foundry Work Profile — Deployment Guide

Run the **same** `claude-engineering-skills` bundle in a corporate Azure
environment with restricted models, so fixes made in your personal repo stop
drifting from the work repo.

> **Opt-in invariant.** Everything here activates only when
> `AZURE_OPENAI_ENDPOINT` is set. With no Azure env vars, the bundle behaves
> byte-identically to the public profile (public OpenAI/Gemini/Anthropic +
> whatever `AUDIT_DB_URL` points at). Plan + design rationale:
> [`docs/plans/azure-work-profile.md`](../completed/azure-work-profile.md).

## What changes under the Azure profile

| Role | Public profile | Azure work profile |
|---|---|---|
| GPT auditor | `api.openai.com` | Azure OpenAI v1 (`AZURE_OPENAI_ENDPOINT/openai/v1`), deployment `AZURE_OPENAI_GPT_DEPLOYMENT` (`gpt-5.5`) |
| Final reviewer | Gemini (→ Claude Opus fallback) | **Claude Opus on Azure Foundry** (`AZURE_AI_ENDPOINT`), deployment `AZURE_FOUNDRY_CLAUDE_DEPLOYMENT` (`claude-opus-4-7`) — opt in with `set-provider azure-claude` (no longer automatic; see Provider precedence below) |
| Embeddings | Gemini `gemini-embedding-001` | Azure OpenAI `text-embedding-3-large` (`dimensions: 768`) |
| Author (coding) | your choice in the IDE | Sonnet 4.6 in VS Code (unchanged; out of the bundle's scope) |

## Setup

### 1. Provide credentials

Copy [`defaults/work-profile.env.example`](../../defaults/work-profile.env.example)
into either your repo `.env` or — preferred for the shared secrets — the
per-user shared file `~/.audit-loop.env` (gitignored, `chmod 600`). Consumer
repos auto-inherit `~/.audit-loop.env`; see the "Shared cloud config" section of
[AGENTS.md](../../AGENTS.md).

The minimum required when `AZURE_OPENAI_ENDPOINT` is set:
`AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_GPT_DEPLOYMENT`. The final reviewer also
needs `AZURE_AI_ENDPOINT` + `AZURE_FOUNDRY_CLAUDE_DEPLOYMENT`. Missing any of
these fails fast with a message naming the absent var (never echoing the key).

### 2. Stand up local Postgres

The store is just a DSN — local now, AWS/Azure-managed later with no code
change. To check/guide a local install and bring the schema up to date:

```bash
node scripts/setup-postgres.mjs --ensure-local
```

This **guides, never silently installs**. If Postgres is missing it prints the
exact `winget` / `choco` (Windows) or `apt` / `brew` (POSIX) command and, in an
interactive terminal, offers to run it. Once Postgres is present + the DSN is
set, it chains `--migrate` to apply the audit-loop migrations. Non-interactive
(CI) runs print the next action and exit non-zero rather than installing.

### 3. Verify + lock in the embedding deployment (`azure:doctor`)

`AZURE_OPENAI_EMBED_DEPLOYMENT` is easy to leave unset — most real work `.env`s
carry only the API key + endpoints. When it's unset the config falls back to a
**guess** (`text-embedding-3-large`) that your resource may not actually have,
producing an opaque `400 unknown_model` on every embedding call.

```bash
npm run azure:doctor            # report-only: which deployment actually answers?
npm run azure:doctor -- --fix   # probe → confirm → write AZURE_OPENAI_EMBED_DEPLOYMENT to .env
```

**You no longer have to remember this.** `npm run sync` inspects each consumer's
`.env` and, when `AZURE_OPENAI_ENDPOINT` is set but `AZURE_OPENAI_EMBED_DEPLOYMENT`
is not, prints the exact cd-scoped command for that repo. Silent otherwise — it
fires only when actionable. The advisory does **not** run the probe for you: that
is a network call authenticated as the consumer, and `azure-doctor`'s `.env`
containment guard is rooted at `process.cwd()`, so writing another repo's file
means running it there — correct as an operator's choice, wrong as a silent
side effect of a file sync.

For a consumer with no `package.json` (adoption Tier 2 — see
[consumer-adoption.md](consumer-adoption.md)), `npm run` doesn't exist there;
run the script directly, which is the form the advisory prints:

```bash
cd /path/to/consumer && node /path/to/claude-engineering-skills/scripts/azure-doctor.mjs --fix
```

The doctor does **verified-candidate selection**, not blind trust: the model
catalog lists models that aren't deployed (both `3-small` and `3-large` show as
"generally-available" even when only one is deployed), so it confirms each
candidate with a real 1-token call — configured name → your `--candidate <name>`
values (for custom deployment aliases the catalog can't see) → catalog models, in
that order, first verified wins. It **never auto-switches without you**: `--json`
and non-TTY runs never write; only an interactive `--fix` with a confirmed `y`
mutates `.env`. A transient/auth/5xx failure is reported as unverifiable and
preserves your config rather than repointing it. `npm run check` also flags the
unset var locally (no network).

> **The deployment name IS the vector-space identity.** Provenance is stored
> endpoint-qualified (`azure-openai:<endpoint-origin>::<deployment>`), so changing
> the deployment — or pointing `AZURE_OPENAI_ENDPOINT` at a different resource with
> the same alias — is a *different* vector space. The doctor warns before it
> writes, and the next `arch:refresh` auto-promotes to a full re-embed so the index
> can't silently mix spaces. Rebuild after any change (step 4).

### 4. Rebuild the architecture index in the Azure vector space (important)

Embeddings are only comparable **within one provider's vector space**. If your
arch-memory / security-memory index was previously built with Gemini (or with a
different Azure deployment/resource), the Azure profile will **refuse
cross-provider/cross-resource queries** with an actionable error. Rebuild once
after adopting Azure or changing the deployment — use `--full` (a provenance
change auto-promotes to full anyway, but be explicit):

```bash
npm run arch:refresh -- --full   # re-embeds symbols via Azure OpenAI
npm run security:refresh         # re-embeds incidents via Azure OpenAI
```

### 5. Smoke-test the live endpoints

```bash
node scripts/gemini-review.mjs ping   # final-reviewer (Opus) connectivity
```

**Verified contract** (smoke-tested live against the work Azure resource, 2026-06-05;
deployment selection refreshed 2026-06-08 as the Foundry quota expanded):
- GPT + embeddings (`text-embedding-3-large`, 768) → `…/openai/v1/...` with the
  `api-key` header. The Responses API works on the v1 surface, so the
  chat-completions fallback is rarely needed.
- Claude Opus/Sonnet → **native Anthropic** at `…/anthropic/v1/messages` with
  `Authorization: Bearer` (this is the default `AZURE_CLAUDE_API_SHAPE=anthropic`).
- Deployments: `gpt-5.5` (auditor — replaces the deprecating `gpt-5.3-chat`,
  retires 2026-06-29), `claude-opus-4-7` (reviewer — 100K TPM, holds a full audit
  transcript; the older `claude-opus-4-6` at 10K TPM can 429 unrecoverably),
  `claude-sonnet-4-6` (arch summaries), `text-embedding-3-large` (embeddings).
- **`claude-haiku-4-5` now exists on Foundry** but summaries deliberately stay on
  Sonnet: Haiku here is 10K TPM / 10 RPM vs Sonnet's 200K / 200, and `arch:refresh`
  is a hundreds-of-calls batch where Azure quota — not per-token cost — binds.

## Provider precedence (final reviewer)

Deterministic, top wins:

1. Explicit `--provider <gemini|anthropic|azure-claude|openai-compatible|openrouter>` CLI flag (per-invocation).
2. **`FINAL_REVIEW_PROVIDER`** persistent per-repo setting (the work-repo lever).
3. `GEMINI_API_KEY` present → **Gemini** (the default reviewer).
4. Azure work profile active → **azure-claude**.
5. `ANTHROPIC_API_KEY` present → public Claude Opus.

The two gateway routes (`openai-compatible`, `openrouter`) are **explicit-selection-only** — they are never chosen by auto-detect (steps 3–5), so a globally-scoped `OPENROUTER_API_KEY` used by other skills can't silently route code egress to a third-party gateway.

> **Why Gemini outranks an active Azure profile (changed 2026-06-09).** The
> per-repo default stack is "GPT auditor + Gemini reviewer". A *configured* Azure
> profile no longer auto-replaces Gemini — a stray `AZURE_OPENAI_ENDPOINT` in the
> shell used to silently reroute a private-repo review to Foundry Opus (and hit
> the non-streaming SDK error). The work repo opts into Azure **explicitly and
> permanently**:
>
> ```bash
> node scripts/gemini-review.mjs set-provider azure-claude   # or: npm run final-review:set -- azure-claude
> ```
>
> This writes `FINAL_REVIEW_PROVIDER=azure-claude` to the repo `.env`, so it wins
> regardless of whether a Gemini key leaks in via `~/.audit-loop.env`.
> `set-provider default` clears it.

## Provider-agnostic final review

The final-review gate is not Gemini-only. One abort-correct `callReviewer` seam +
a `PROVIDERS` descriptor catalog in [`scripts/gemini-review.mjs`](../../scripts/gemini-review.mjs)
back five providers over three transports (`gemini` / `anthropic` / `openai`);
adding another is a small descriptor + (only if a new wire shape) one adapter.

| Provider | Transport | Client | Model source |
|---|---|---|---|
| `gemini` | gemini | GoogleGenAI | `GEMINI_REVIEW_MODEL` |
| `claude-opus` | anthropic | public Anthropic | `CLAUDE_FINAL_REVIEW_MODEL` |
| `azure-claude` | anthropic **or** openai (per `AZURE_CLAUDE_API_SHAPE`) | Foundry | `AZURE_FOUNDRY_CLAUDE_DEPLOYMENT` |
| `openai-compatible` | openai | `createOpenAIClient({oss})` | `FINAL_REVIEW_MODEL` (verbatim) |
| `openrouter` | openai | `createOpenAIClient({oss})` (baseURL preset) | `FINAL_REVIEW_MODEL` (verbatim) |

**Point the gate at any OpenAI-compatible gateway** (OpenRouter / Together /
Fireworks / Groq / vLLM / Ollama / LM Studio — e.g. a corporate profile that runs
its own model for the reviewer role):

```bash
# Generic OpenAI-compatible endpoint
export FINAL_REVIEW_BASE_URL="https://your-gateway/v1"
export FINAL_REVIEW_API_KEY="..."
export FINAL_REVIEW_MODEL="your/model-id"     # passed to the gateway verbatim (no sentinel remap)
node scripts/gemini-review.mjs set-provider openai-compatible

# OpenRouter preset (baseURL prefilled; key may come from the shared OPENROUTER_API_KEY)
export FINAL_REVIEW_MODEL="anthropic/claude-opus-4"
node scripts/gemini-review.mjs set-provider openrouter
```

Env vars (all optional; validated per-provider at selection, never at import):

| Var | Default | Purpose |
|---|---|---|
| `FINAL_REVIEW_BASE_URL` | — | Gateway base URL (`openai-compatible`; overrides the OpenRouter preset if set). |
| `FINAL_REVIEW_API_KEY` | — | Gateway key. For `openrouter`, falls back to `OPENROUTER_API_KEY` **only after** an explicit `openrouter` selection. |
| `FINAL_REVIEW_MODEL` | — | Concrete gateway model id, passed verbatim (no `latest-*` sentinel resolution). Required for both gateway routes. |
| `FINAL_REVIEW_HARD_DEADLINE_MS` | `600000` | Process-level watchdog that guarantees the review CLI terminates even if a provider wedges. Clamped `[60000, 3600000]`; raised to a floor of `2×GEMINI_REVIEW_TIMEOUT_MS + 60000`. |

**Background-safe termination** (why the watchdog exists): the review CLI now
force-terminates through one idempotent `finishAndExit` (flush → clear watchdog →
`process.exit`) plus a hard-deadline watchdog that aborts the in-flight review
first. Previously the success path relied on natural event-loop drain, so a
lingering LLM-SDK keep-alive socket blocked exit — invisible foreground (an outer
timeout reaped it) but an indefinite hang in a **detached/background** run. Runs
are now bounded regardless of provider.

**Secure defaults / egress**: the review payload is assembled once (sensitive-path
filtered) and every transport receives only that envelope, so selecting a gateway
sends the same already-filtered transcript+code you'd send Gemini/OpenAI — an
explicit operator choice, never an auto-fallback.

## Env-var reference

See [`defaults/work-profile.env.example`](../../defaults/work-profile.env.example)
for the annotated list. Notes:

- **Deployment names vs sentinels** — `OPENAI_AUDIT_MODEL` /
  `CLAUDE_FINAL_REVIEW_MODEL` stay logical sentinels (for logging/pricing); the
  wire-level deployment comes from the `AZURE_*_DEPLOYMENT` vars. This avoids
  the `gpt-5.3 → latest-gpt` remap footgun.
- **`api-version=preview`** is correct for the v1 surface (not a dated string).
- **DB aliases** — `AUDIT_POSTGRES_URL` / `AUDIT_POSTGRES_SSL_MODE` are accepted
  as back-compat aliases for `AUDIT_DB_URL` / `AUDIT_DB_SSL_MODE` (one-time
  deprecation notice; canonical wins). `AUDIT_STORE=postgres` without a DSN
  fails fast.

## Runtime details & operations

(Stubbed from AGENTS.md — operational depth lives here, not in the always-loaded
context.)

**Seams** (mirror `anthropic-client.mjs`): [`scripts/lib/openai-client.mjs`](../../scripts/lib/openai-client.mjs)
`createOpenAIClient({purpose})` returns an Azure-v1 or public `OpenAI` client by env
presence; [`scripts/lib/embed-text.mjs`](../../scripts/lib/embed-text.mjs) `embedText()`
routes embeddings the same way. The GPT auditor swaps `responses.parse()` →
chat-completions + `zodResponseFormat` **only** on a positive Responses-unsupported
signal ([`openai-responses-capability.mjs`](../../scripts/lib/openai-responses-capability.mjs)
— a generic 404 stays fatal, per "never retry 404"). `azureConfig` lives in
[config.mjs](../../scripts/lib/config.mjs) (`buildAzureConfig`, fail-fast + redacted).

**Role swaps**: GPT auditor → Azure OpenAI v1 (`AZURE_OPENAI_ENDPOINT/openai/v1`,
deployment `AZURE_OPENAI_GPT_DEPLOYMENT`); final reviewer → **Opus on Foundry**
(`AZURE_AI_ENDPOINT`, deployment `AZURE_FOUNDRY_CLAUDE_DEPLOYMENT`) replacing Gemini;
embeddings → Azure `text-embedding-3-large` (`dimensions: 768`).

**Vector-space safety**: embeddings are only comparable within one provider's space.
Adopting Azure on a Gemini-built index is **refused** (provenance guard in
`neighbourhood-query.mjs`); rebuild once with `npm run arch:refresh` +
`npm run security:refresh`.

**Foundry Claude API shape** (verified live 2026-06-05): Foundry serves Claude as the
**native Anthropic API** at `…/anthropic/v1/messages` with `Authorization: Bearer`, so
`AZURE_CLAUDE_API_SHAPE` defaults to `anthropic` (the `openai` value is for a rare
OpenAI-shaped Foundry deployment). Both Anthropic-shaped paths (public Opus + Foundry
Claude) **stream** — `max_tokens` (32000) exceeds the SDK's non-streaming ceiling, so a
plain `messages.create()` throws "Streaming is required…". Deployments: `claude-opus-4-7`
(reviewer — 100K TPM, holds a full audit transcript; the older `claude-opus-4-6` at
10K TPM 429s unrecoverably on big audits), `claude-sonnet-4-6` (summaries). GPT auditor
deployment falls back to a concrete `OPENAI_AUDIT_MODEL` (`gpt-5.5`; the prior
`gpt-5.3-chat` is 10K TPM, retires 2026-06-29) when `AZURE_OPENAI_GPT_DEPLOYMENT` unset.

**Arch-index summaries route to Sonnet** via Foundry (`summarise.mjs` /
`summarise-domains.mjs` → `createAnthropicClient({baseURL})`, deployment
`AZURE_FOUNDRY_SUMMARY_DEPLOYMENT`, default `claude-sonnet-4-6`). `claude-haiku-4-5`
exists on Foundry but summaries stay on Sonnet: Haiku here is 10K TPM / 10 RPM vs
Sonnet's 200K / 200, and `arch:refresh` is a hundreds-of-calls batch where Azure
deployment quota — not per-token cost — is the binding constraint.

**Postgres**: still just a DSN. `node scripts/setup-postgres.mjs --ensure-local` is a
**guided** preflight — detects `psql`, prints the `winget`/`choco`/`apt`/`brew`
command if missing (never auto-installs), then chains `--migrate`.

**Rate limits**: fresh Azure deployments often ship tiny default quotas; the
`contoso-ai-dev` workhorses sit at **100K TPM / 100 RPM** (`gpt-5.5`, `claude-opus-4-7`),
`claude-sonnet-4-6` at 200K/200, `text-embedding-3-large` at 100K/600. `npm run
azure:limits` probes each deployment's live TPM/RPM + reset window. Management (opt-in,
no-op on the public path): a global in-flight concurrency cap
([`scripts/lib/azure-throttle.mjs`](../../scripts/lib/azure-throttle.mjs),
`AZURE_MAX_CONCURRENCY`, default 4 — TPM-bound on large GPT passes; raise toward 6–8 for
RPM-bound batch work) paces the burst sources (the embedder's 25-wide `Promise.all`,
parallel audit passes); the SDK clients run with `maxRetries` (`AZURE_MAX_RETRIES`,
default 6) honouring `Retry-After` / `x-ratelimit-reset-*`. A single call larger than
the per-minute TPM can't be fixed client-side — raise the deployment quota in the
Foundry portal. RPM is as binding as TPM for batched work (embeddings/summaries).

## Disabling / rollback

Unset `AZURE_OPENAI_ENDPOINT`. Every seam reverts to its public construction —
no migration, no state to tear down. The work profile and the public profile
are the same code on two `.env`s.
