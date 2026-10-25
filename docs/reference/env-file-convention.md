# `.env` file convention

One layout for the `.env` of CES, wine-cellar-app, storyline and ai-organiser, so any
key can be found by section. Variable meanings stay in
[`environment-variables.md`](environment-variables.md); this file only fixes **layout
and naming**. A `.env` is never committed and never pasted anywhere — work with key
*names*.

## Section order

Banner each section (`# ═══` rule, numbered title). Omit a section that has no keys.

1. **LLM providers** — `ANTHROPIC_`, `OPENAI_`, `GEMINI_`, `OPENROUTER_`, `XAI_`, … keys, model pins, `CLAUDE_BACKEND`
2. **Azure work profile** — `AZURE_*` (an endpoint here switches the repo to the Azure profile)
3. **Audit store / DB** — `AUDIT_DB_*`, `DATABASE_URL`, `PG*`
4. **Audit-loop tool** — `LEARNING_REPO_NAME`, `PERSONA_TEST_REPO_NAME`, campaign keys, final-review settings
5. **App runtime (repo-specific)** — what the product itself reads
6. **Third-party services** — GitHub, email, scraping, scanners, cloud CLIs
7. **Feature flags / kill switches** — `AUDIT_LOOP_WEEKLY_MAINTENANCE`, `*_ENABLED`, `*_DISABLE`
8. **Local dev only** — test accounts, NAS/tunnel credentials, `NODE_ENV`
9. **UNUSED? (Louis to confirm)** — keys nothing reads or whose name looks wrong. A *move*, never a delete.

## Per key

- One `# comment` line above each key saying what it is. **Never a value, never a fragment of one.**
- Extra history comments (dates, decisions) may follow the description line; keep them above the key they explain.
- Within a section, group related keys (a key and its `_URL`/`_ENDPOINT`).

## Naming

`<VENDOR>_<THING>_<SUFFIX>`: vendor prefix first (`GEMINI_`, `AZURE_OPENAI_`), then the thing, then
`_API_KEY` (secret), `_URL` (full URL/DSN), `_ENDPOINT` (service host), `_MODEL` / `_DEPLOYMENT` (model id),
`_TOKEN` (PAT/bearer), `_USER`/`_PASSWORD`/`_EMAIL` (login pairs). No dots in names. A name no code reads
is dead or misnamed — move it to section 9 and ask.

## Shared vs per-repo

| Lives in | What |
|----------|------|
| `~/.audit-loop.env` | Keys every repo shares: `AUDIT_DB_URL`, `AUDIT_DB_SSL_MODE`, the three main provider keys, `OPENROUTER_API_KEY`, shared budgets and `FINAL_REVIEW_MODEL`. Managed by `setup:cloud`/sync, which **strips comments in its unmanaged block** — so it is the one file this convention does not annotate. |
| repo `.env` | Everything repo-specific, and any shared key this repo must override. **The repo `.env` wins** (`override:false` fill-in from the shared file), so a repeated key silently shadows the shared one — repeat only deliberately, and say why in the comment (storyline's own `AUDIT_DB_URL` does). |

## `.env.example`

Committed. Mirrors the `.env` section structure, each key `KEY=` with **empty value** and its one-line
comment. Optional or advanced keys not set locally may appear as `# KEY=default` under their section.
Update it in the same change that adds a key.

## Tidying an existing file (no value may change)

Back up first (`.env.bak-<date>`, gitignored), reorder and comment only, then compare a SHA-256 of the
dotenv-parsed, key-sorted map before and after — equal or restore. Then run the repo's own self-check
(`scripts/.claude-skills/check-setup.mjs` in consumers, `scripts/check-setup.mjs` here).
