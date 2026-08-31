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
| GPT auditor | `api.openai.com` | Azure OpenAI, deployment-qualified (`AZURE_OPENAI_ENDPOINT/openai/deployments/<deployment>/…`), deployment `AZURE_OPENAI_GPT_DEPLOYMENT` — tenant-chosen name, discover yours with `npm run azure:doctor -- --target gpt --fix` (e.g. `gpt-5.6-terra`) |
| Final reviewer | Gemini (→ Claude Opus fallback) | **Claude Opus on Azure Foundry** (`AZURE_AI_ENDPOINT`), deployment `AZURE_FOUNDRY_CLAUDE_DEPLOYMENT` (`claude-opus-4-7`) — opt in with `set-provider azure-claude` (no longer automatic; see Provider precedence below) |
| Embeddings | Gemini `gemini-embedding-001` | Azure OpenAI `text-embedding-3-large` (`dimensions: 768`) |
| Author (coding) | your choice in the IDE | Sonnet 4.6 in VS Code (unchanged; out of the bundle's scope) |
| `/brainstorm` voices | OpenAI + Gemini | **OpenAI + Foundry Claude** (`--models openai,azure-claude`, the default here) |

### `/brainstorm` voices on Azure

The OpenAI voice routes through the same Azure GPT deployment as the auditor, so
`/brainstorm` works on an Azure-only install with no `OPENAI_API_KEY`. The Gemini
voice cannot — there is no Gemini in an Azure tenant — so the second voice is
**Claude on Foundry** (`azure-claude`), the same substitution the final reviewer
makes, using `AZURE_FOUNDRY_CLAUDE_DEPLOYMENT` and the resolved
`AZURE_CLAUDE_ROUTE`. You do not have to ask for it: with no explicit `--models`,
an active Azure profile defaults to `openai,azure-claude`. Public installs are
unchanged (`openai,gemini`).

Two honest caveats. The Azure pair is **not** cross-vendor independent the way
OpenAI+Gemini is — when Claude Code is the orchestrator, the second voice shares
its model family (it is still a separate call with no conversation history and
its own prompt, but say so rather than presenting it as an outside opinion). And
the cost line for that leg is a **list-price estimate**: a Foundry tenant's
negotiated rate may differ, so read it as an order of magnitude, not an invoice.
Pass `--openai-only` for a single voice; `--with-gemini` forces the Gemini leg
back in if you really do hold a key.

> Both fixed 2026-08-13, in that order. Before that, both legs reported
> *"OPENAI_API_KEY / GEMINI_API_KEY not set"* on Azure and `/brainstorm` was unusable
> there: the OpenAI adapter had been Azure-aware since 2026-07-14, but the dispatch
> gate short-circuited on the public env var before reaching it. The tell in the
> envelope is `latencyMs: 0` — no call was attempted. Availability oracle:
> [`provider-availability.mjs`](../../scripts/lib/brainstorm/provider-availability.mjs);
> the second voice: [`azure-claude-adapter.mjs`](../../scripts/lib/brainstorm/azure-claude-adapter.mjs).

**Adding a voice is a multi-table change.** A provider id must be declared in
every table that must know it, and the tables fail differently: the adapter map
(absent ⇒ no dispatch), `PROVIDER_INPUT_CEILING_TOKENS` (absent ⇒ FATAL at call
time — this is the one that was missed, and only a live run caught it), and the
`resolvedModels` schema key (absent ⇒ **silent**: a non-`.strict()` `z.object`
strips the undeclared key and the writer emits the `parse`d data, so the model id
vanishes from the record with no error anywhere). And because the default itself
is profile-dependent — `defaultProviders()` returns `openai,gemini` on a public
install and `openai,azure-claude` on an active Azure profile — a new voice is
never "just a constant": run it on **both** profiles before calling it done.

## Setup

### 1. Provide credentials

Copy [`defaults/work-profile.env.example`](../../defaults/work-profile.env.example)
into either your repo `.env` or — preferred for the shared secrets — the
per-user shared file `~/.audit-loop.env` (gitignored, `chmod 600`). Consumer
repos auto-inherit `~/.audit-loop.env`; see the "Shared cloud config" section of
[AGENTS.md](../../AGENTS.md).

The minimum required when `AZURE_OPENAI_ENDPOINT` is set:
`AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_GPT_DEPLOYMENT`. The final reviewer also
needs `AZURE_FOUNDRY_CLAUDE_DEPLOYMENT` and — on the `foundry` route only —
`AZURE_AI_ENDPOINT`. Missing any of these fails fast with a message naming the
absent var (never echoing the key).

#### Which Claude route? (`AZURE_CLAUDE_ROUTE`)

Claude reaches your tenant one of two ways, and they are **different services**
— different host, different credential, different auth header:

| `AZURE_CLAUDE_ROUTE` | Base URL | Auth header | Credential |
|---|---|---|---|
| `apim` | `$AZURE_OPENAI_ENDPOINT/anthropic` | `api-key` | `AZURE_OPENAI_API_KEY` |
| `foundry` | `$AZURE_AI_ENDPOINT/anthropic` | `Authorization: Bearer` | `AZURE_AI_API_KEY`, else `AZURE_OPENAI_API_KEY` |

Unset, it defaults to `foundry` when `AZURE_AI_ENDPOINT` is present, else `apim`.

**If your tenant fronts Foundry with API Management, set
`AZURE_CLAUDE_ROUTE=apim` explicitly** — even though `AZURE_AI_ENDPOINT` is also
set. Behind an APIM gateway the direct Foundry host will not accept the APIM
subscription key, and a Bearer token is rejected there with *"Access denied due
to missing subscription key"*.

When the `foundry` route falls back to `AZURE_OPENAI_API_KEY` (no dedicated
`AZURE_AI_API_KEY`), the credential is being sent to a service it may not belong
to. That is legal — some tenants really do share one key — so it is permitted but
flagged `credentialShared` on the resolved route — surfaced as `[SHARED across
services]` in `azure:routes` and in any 401 message. `azure:routes` prints each
route's credential **variable name**, never its value, plus a live probe.

> **Why this is one resolved unit (fixed 2026-08-13).** Claude's base URL used to
> be hard-wired to `AZURE_AI_ENDPOINT` while `anthropic-client.mjs` picked the
> credential by sniffing `AZURE_OPENAI_API_KEY` off the ambient env and always sent
> it as Bearer. On an APIM-fronted tenant — two different services — every call
> therefore shipped the APIM subscription key to the direct Foundry host for a bare
> `401`, and the APIM route was **unrepresentable**: no combination of env vars
> reached it. `azureConfig.claudeRoute` now resolves `{origin, baseUrl, authMode,
> apiKey, credentialVar}` **together**, selected by `AZURE_CLAUDE_ROUTE`, and call
> sites pass it as `createAnthropicClient({azureRoute})` — never a bare `baseURL`.

Check what you have configured, without sending a single secret to your terminal:

```bash
npm run azure:routes
```

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

> **Field-verified 2026-07-20** (work tenant, read-only probe): with the
> `text-embedding-3-large` default, `azure:doctor --json` returned
> `selected: text-embedding-3-large`, `probed.length === 1` (verified on the
> FIRST probe — no ladder walk), and `catalogSource: "catalog"`, confirming live
> catalog listing works against a real endpoint rather than silently falling
> back to the static list.
>
> **Not** field-verified: the contract-unsupported branch (a deployment that
> exists but rejects the `dimensions` parameter). `text-embedding-ada-002` — the
> case it exists for — is not deployed on that tenant, so the branch is pinned by
> unit tests against the documented error wording, not by observation. If you
> ever see discovery HALT on a deployment that exists, that is the branch to
> suspect first.

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

### 3b. The same discovery for the GPT and Claude deployment slots (`--target`)

`AZURE_OPENAI_GPT_DEPLOYMENT` and `AZURE_FOUNDRY_CLAUDE_DEPLOYMENT` get the
same probe → select → confirm → persist flow as the embedding slot above, via
`--target`:

```bash
npm run azure:doctor -- --target gpt              # report-only
npm run azure:doctor -- --target gpt --fix        # probe → confirm → write AZURE_OPENAI_GPT_DEPLOYMENT
npm run azure:doctor -- --target claude --fix     # probe → confirm → write AZURE_FOUNDRY_CLAUDE_DEPLOYMENT
```

`--target embed` is the default (unchanged from §3 above). This is *probe, not
enumerate*, more so than the embedding path: neither surface lists a live
catalog before a deployment is known to exist, so the candidate ladder is the
static, offline list of model ids the public-profile `latest-gpt`/`latest-opus`
sentinels already resolve from (`model-resolver.mjs`'s `STATIC_POOL`) — a
narrowing hint only, since an Azure deployment NAME is tenant-chosen and need
not match a catalog model id. Pass `--candidate <your-deployment-name>` for a
custom alias the pool can't guess. Every other invariant from §3 carries over
unchanged (verified-candidate selection, never-auto-switches, transient
failures preserve config) — except the architectural-memory vector-space
invalidation warning, which is specific to the embedding slot and does not
print for `--target gpt`/`--target claude`.

> **The deployment name IS the vector-space identity.** Provenance is the single
> endpoint-qualified `resolveEmbedProfile()` identity
> (`azure-openai:<endpoint-origin>::<deployment>`), so changing
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
npm run azure:routes
```

That prints every wire route — endpoint origin, final path, wire deployment,
api-version, the credential's **source variable name** (never its value) and the
auth header — then probes each one. Exit `0` = all routes authenticated, `7` =
at least one failed, with a classified reason (`AUTH_ENDPOINT_MISMATCH`,
`DEPLOYMENT_ROUTE_NOT_FOUND`, `CREDENTIAL_MISSING`, `TRANSPORT_UNAVAILABLE`).
Add `--json` for a machine-readable table.

**It is bounded.** The whole probe sweep carries a hard deadline
(`AZURE_ROUTES_DEADLINE_MS`, default 180s) and exits `124` if it expires — a
diagnostic that never returns blocks whatever script or CI step invoked it. Exit
also drains stdout first: a bare `process.exit()` truncates a piped stdout on
Windows, so `npm run azure:routes | tee` could lose the tail of the report. Both
come from the shared `finishAndExit`/`armExitWatchdog` in
[`lib/cli-io.mjs`](../../scripts/lib/cli-io.mjs), and
[`tests/azure-routes-lifecycle.test.mjs`](../../tests/azure-routes-lifecycle.test.mjs)
drives the real CLI as a subprocess to assert it — an in-process test cannot
observe whether a PROCESS would have exited.

To smoke-test only the configured final reviewer, on whichever provider is
actually selected:

```bash
node scripts/gemini-review.mjs ping --provider azure-claude
```

`ping` honours `--provider`, the persisted `FINAL_REVIEW_PROVIDER`, and the same
auto-detect precedence a review uses — it does **not** require `GEMINI_API_KEY`
or `ANTHROPIC_API_KEY`, neither of which exists on an Azure-only install.

**Verified contract** (smoke-tested live against the work Azure resource, 2026-06-05;
deployment selection refreshed 2026-06-08 as the Foundry quota expanded; GPT +
embedding routing changed 2026-08-12, see below):
- GPT + embeddings (`text-embedding-3-large`, 768) → the **deployment-qualified**
  routes, with the `api-key` header:
  - `…/openai/deployments/<AZURE_OPENAI_EMBED_DEPLOYMENT>/embeddings`
  - `…/openai/deployments/<AZURE_OPENAI_GPT_DEPLOYMENT>/chat/completions`
  - `…/openai/responses` — the Responses API is **not** deployment-qualified;
    the deployment travels in the body's `model`. It works, so the
    chat-completions fallback is rarely needed.

  These URLs are generated by the OpenAI SDK's own `AzureOpenAI` client from
  `{endpoint, deployment, apiVersion}` — the bundle never concatenates an
  operation path. **Until 2026-08-12** both purposes used the `/openai/v1/…`
  surface with the deployment carried only in the body; resources and API
  gateways that expose the standard deployment-qualified API have no such route
  and returned 404. If you are pinned to the older surface, set
  `AZURE_OPENAI_API_VERSION=preview` — but note the SDK still emits
  `/openai/deployments/…`, so a resource serving only `/openai/v1` needs the
  gateway to rewrite, not just a version pin.
- Claude Opus/Sonnet → **native Anthropic** at `…/anthropic/v1/messages` (the
  default `AZURE_CLAUDE_API_SHAPE=anthropic`). The auth header depends on the
  route: `Authorization: Bearer` on `foundry`, `api-key` on `apim`. Both
  measured live 2026-08-13 against an APIM-fronted tenant — the APIM host
  rejects Bearer, the Foundry host rejects the APIM subscription key.
- Deployments: the GPT auditor deployment is **tenant-chosen, not a fixed
  name** — Azure gateways rename/retire model families over time (this repo's
  own work tenant moved `gpt-5.5` → `gpt-5.6-terra` on 2026-08-21 when the
  gateway began serving the `gpt-5.6-*` family). Don't hardcode a literal;
  discover your tenant's real name with `npm run azure:doctor -- --target gpt --fix`.
  The rest of that verification: `claude-opus-4-7` (reviewer — 100K TPM, holds
  a full audit transcript; the older `claude-opus-4-6` at 10K TPM can 429
  unrecoverably), `claude-sonnet-4-6` (arch summaries), `text-embedding-3-large`
  (embeddings).
- **`claude-haiku-4-5` now exists on Foundry** but summaries deliberately stay on
  Sonnet: Haiku here is 10K TPM / 10 RPM vs Sonnet's 200K / 200, and `arch:refresh`
  is a hundreds-of-calls batch where Azure quota — not per-token cost — binds.

## Which Claude a bare `createAnthropicClient()` reaches

**Since 2026-08-30 an omitted `azureRoute` adopts the tenant's route.** On an
active profile a bare `await createAnthropicClient()` targets
`azureConfig.claudeRoute` — the endpoint, the credential and the header that
carries it, resolved together. Off Azure nothing changes: the resolver keys on
`AZURE_OPENAI_ENDPOINT`, so the public path is byte-identical (the opt-in
invariant). `isClaudeAvailable()` follows the same route, so a call site gated
on it no longer skips itself on a tenant that has no `ANTHROPIC_API_KEY`.

**Why the default flipped.** Requiring every call site to pass the route made
correctness a property of ~30 call sites rather than of the seam, and it failed
exactly as that predicts — five separate fixes patched individual sites while
new bare calls kept appearing (upstream report `7af14dd6` asked for the sweep).
Measured in a corporate consumer on 2026-08-30, with `azureConfig.active` true
and a live APIM Claude call succeeding in 1.4 s, a bare call did one of two
things depending only on whose machine it ran on:

| machine | bare `createAnthropicClient()` |
|---|---|
| carries a personal key in `~/.audit-loop.env` | **corporate source → `api.anthropic.com` on that personal credential** |
| no personal key (the real corporate machine) | throws `ANTHROPIC_API_KEY required`, beside an unused working route |

Neither is "target public Anthropic on purpose", which is why the default is
adoption rather than a lint.

**The opt-out is `azureRoute: null`,** and it belongs anywhere a provider id
*means* the public service rather than "whatever Claude this machine has":
`gemini-review.mjs`'s `claude-opus` provider and its shadow arm (distinct ids
from `azure-claude`, and the shadow's cost note says it bills
`ANTHROPIC_API_KEY`), and `model-eval/provider-adapter.mjs`'s non-azure branch.
Omitting it there would make an A/B silently compare a provider with itself and
read as agreement.

**With a route resolved, `ANTHROPIC_API_KEY` is unreachable** — not merely
outranked. That is the independent post-condition on the 2026-08-13 rule that an
endpoint and its credential are one unit: no environment state may put the
public key on a corporate host.

Guarded by [`tests/anthropic-azure-route-default.test.mjs`](../../tests/anthropic-azure-route-default.test.mjs),
which asserts on the **emitted request** (URL + headers as the installed SDK
sends them) and pins the three directions a naive "make Azure work" fix breaks:
the public path unchanged, the `azureRoute: null` opt-out, and `cli`/`bedrock`
left uncoerced.

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
  `MODEL_CATALOG_REFRESH` **auto-skips** under an active Azure profile: the live
  public catalog describes models a tenant does not serve.
- **`api-version`** defaults to **`2025-03-01-preview`**, the dated version the
  deployment-qualified GPT/embedding surface expects. The undated `preview`
  sentinel belongs to the older `/openai/v1` surface and is still the default on
  the Foundry-Claude route. `AZURE_OPENAI_API_VERSION` overrides both.
- **`AZURE_OPENAI_ENDPOINT` is the resource root** — never append `/openai` or
  `/openai/v1`; the SDK derives the operation path. Trailing slashes are stripped,
  and a gateway base path (`https://<gateway>/<route>`) is preserved.
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

**One client per purpose; the deployment is CONSTRUCTOR-level route state.** The
`gpt` and `embed` clients are built as `AzureOpenAI({endpoint, deployment,
apiVersion})` and the SDK derives `/openai/deployments/{deployment}/…` itself — the
bundle never concatenates an operation path, and never shares one client across
purposes: the client cache key carries **purpose + deployment**. A caller probing
*candidate* deployments must therefore build a client per candidate
(`selectEmbedDeployment`'s `clientFor`); reusing one silently sends every probe to
the already-configured deployment, so the ladder "verifies" a name it never called.
Fixed 2026-08-12, together with the `/openai/v1`-surface 404s above.

**Tests that spawn one of these CLIs must scrub `AZURE_*` explicitly.** The seams
key on ambient env, so a child process inherits whatever profile the developer's
machine carries — an unscrubbed spawn passes, fails, or *spends* according to whose
machine ran it.

**Role swaps**: GPT auditor → Azure OpenAI, deployment-qualified
(`AZURE_OPENAI_ENDPOINT/openai/deployments/<deployment>/…`,
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
deployment falls back to a concrete `OPENAI_AUDIT_MODEL` when `AZURE_OPENAI_GPT_DEPLOYMENT`
is unset — either way the value is your tenant's own deployment name (e.g.
`gpt-5.6-terra`), not a fixed id; run `npm run azure:doctor -- --target gpt --fix`
to discover and lock in the real one.

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
`contoso-ai-dev` workhorses sit at **100K TPM / 100 RPM** (the GPT auditor
deployment — a tenant-chosen name, e.g. `gpt-5.6-terra`, see above — and
`claude-opus-4-7`), `claude-sonnet-4-6` at 200K/200, `text-embedding-3-large`
at 100K/600. `npm run
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
