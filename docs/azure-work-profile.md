# Azure AI Foundry Work Profile — Deployment Guide

Run the **same** `claude-engineering-skills` bundle in a corporate Azure
environment with restricted models, so fixes made in your personal repo stop
drifting from the work repo.

> **Opt-in invariant.** Everything here activates only when
> `AZURE_OPENAI_ENDPOINT` is set. With no Azure env vars, the bundle behaves
> byte-identically to the public profile (public OpenAI/Gemini/Anthropic +
> whatever `AUDIT_DB_URL` points at). Plan + design rationale:
> [`docs/plans/azure-work-profile.md`](plans/azure-work-profile.md).

## What changes under the Azure profile

| Role | Public profile | Azure work profile |
|---|---|---|
| GPT auditor | `api.openai.com` | Azure OpenAI v1 (`AZURE_OPENAI_ENDPOINT/openai/v1`), deployment `AZURE_OPENAI_GPT_DEPLOYMENT` |
| Final reviewer | Gemini (→ Claude Opus fallback) | **Claude Opus on Azure Foundry** (`AZURE_AI_ENDPOINT`), deployment `AZURE_FOUNDRY_CLAUDE_DEPLOYMENT` |
| Embeddings | Gemini `gemini-embedding-001` | Azure OpenAI `text-embedding-3-small` (`dimensions: 768`) |
| Author (coding) | your choice in the IDE | Sonnet 4.6 in VS Code (unchanged; out of the bundle's scope) |

## Setup

### 1. Provide credentials

Copy [`defaults/work-profile.env.example`](../defaults/work-profile.env.example)
into either your repo `.env` or — preferred for the shared secrets — the
per-user shared file `~/.audit-loop.env` (gitignored, `chmod 600`). Consumer
repos auto-inherit `~/.audit-loop.env`; see the "Shared cloud config" section of
[AGENTS.md](../AGENTS.md).

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

### 3. Rebuild the architecture index in the Azure vector space (important)

Embeddings are only comparable **within one provider's vector space**. If your
arch-memory / security-memory index was previously built with Gemini, the
Azure profile will **refuse cross-provider queries** with an actionable error.
Rebuild once after adopting Azure:

```bash
npm run arch:refresh        # re-embeds symbols via Azure OpenAI
npm run security:refresh    # re-embeds incidents via Azure OpenAI
```

### 4. Smoke-test the live endpoints (manual — can't be done from CI)

The exact Foundry calling convention can only be confirmed against your
corporate endpoint:

```bash
npm run anthropic:ping        # exercises the configured Claude backend
node scripts/gemini-review.mjs ping   # final-reviewer connectivity
```

If the Foundry Claude call 404s, your deployment may route at `/models` rather
than `/openai/v1` — set `AZURE_FOUNDRY_API_PATH=/models`. If it speaks the
native Anthropic API rather than the OpenAI-shaped one, set
`AZURE_CLAUDE_API_SHAPE=anthropic`.

## Provider precedence (final reviewer)

Deterministic, top wins:

1. Explicit `--provider <gemini|anthropic|azure-claude>` CLI flag.
2. Azure work profile active → **azure-claude** (replaces Gemini).
3. `GEMINI_API_KEY` present → Gemini.
4. `ANTHROPIC_API_KEY` present → public Claude Opus.

## Env-var reference

See [`defaults/work-profile.env.example`](../defaults/work-profile.env.example)
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

## Disabling / rollback

Unset `AZURE_OPENAI_ENDPOINT`. Every seam reverts to its public construction —
no migration, no state to tear down. The work profile and the public profile
are the same code on two `.env`s.
