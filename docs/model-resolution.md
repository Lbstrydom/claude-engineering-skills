# Model Resolution

> Full reference for `scripts/lib/model-resolver.mjs`. AGENTS.md keeps the
> sentinel table + anti-patterns inline as a quick reference; the resolution
> mechanics, live-catalog behaviour, CLI self-check, and static-pool maintenance
> live here.

`resolveModel()` resolves model IDs so config stops going stale when providers ship
new versions. All model-reading env vars in `config.mjs` pass through it.

## Sentinels (preferred in `.env`)

| Sentinel            | Picks from                                  |
|---------------------|---------------------------------------------|
| `latest-gpt`        | newest non-mini GPT in the pool             |
| `latest-gpt-mini`   | newest GPT mini variant                     |
| `latest-opus`       | newest Claude Opus                          |
| `latest-sonnet`     | newest Claude Sonnet                        |
| `latest-haiku`      | newest Claude Haiku (prefers undated alias) |
| `latest-pro`        | `gemini-pro-latest` (alias short-circuit)   |
| `latest-flash`      | `gemini-flash-latest`                       |
| `latest-flash-lite` | `gemini-flash-lite-latest`                  |

## Resolution order in `resolveModel(modelId)`

1. Apply `DEPRECATED_REMAP` — stale concrete IDs (`gpt-5.2`, `gemini-3-flash`,
   `claude-opus-3`, …) are rewritten to a sentinel with a one-time warning.
2. If the result is a sentinel, merge live catalog ∪ `STATIC_POOL`, then pick the
   newest entry matching the tier. Google's `gemini-{tier}-latest` alias is
   authoritative (short-circuits version heuristics).
3. If result is concrete, return as-is.

## Live catalog (always-on for audit/brainstorm/gemini-review)

The three heavy LLM entry points — `scripts/openai-audit.mjs`,
`scripts/brainstorm-round.mjs`, `scripts/gemini-review.mjs` — call
`await refreshModelCatalog()` at the top of their `main()`. The audit + gemini scripts
then RE-RESOLVE the sentinel against the freshly-populated live catalog and reassign
their `MODEL` (and `CLAUDE_OPUS_MODEL`) `let` bindings, so providers' newest models are
picked up automatically — no manual `STATIC_POOL` updates required when a new
GPT/Claude/Gemini ships.

The startup log surfaces an upgrade when it fires:

```
  [model-resolver] upgraded MODEL gpt-5.5 → gpt-5.6 (live catalog newer than STATIC_POOL)
```

Operators can disable this with `MODEL_CATALOG_REFRESH=skip` (air-gapped CI / scarce API
quota); resolution then stays at the module-load static-pool value. Silent on network
failure — falls back to static pool cleanly.

Other scripts (utility CLIs that don't make heavy LLM calls) skip the refresh to keep
their startup latency low. They use the static-pool value which lags but never breaks.

## CLI self-check

```bash
node scripts/lib/model-resolver.mjs resolve             # show current resolution
node scripts/lib/model-resolver.mjs catalog             # live catalog delta vs static
```

## Anti-patterns to avoid

- Do NOT pin concrete model IDs in new code — use a sentinel (`latest-*`).
- Do NOT drop `-preview` suffixes from Gemini 3 IDs without verifying via
  `curl https://generativelanguage.googleapis.com/v1beta/models?key=$KEY`. The bare
  `gemini-3-flash` / `gemini-3.1-pro` have never shipped — Google returns 404.
- Do NOT retry 404. It's a client error (model not found). `classifyLlmError` treats any
  4xx (except 429) as non-retryable.
- When you catch and rewrap an LLM error, surface `err.status` and the real provider
  message. Don't collapse to `"API error ${status}"` — the provider's `error.message` is
  what tells you which model wasn't found.

## Refreshing the static pool

Rarely needed since the live-catalog refresh handles new releases automatically. Only
update `STATIC_POOL` when supporting an air-gapped scenario or when a new MAJOR
version's ID shape isn't recognised by the resolver's family-detection heuristics. Edit
`STATIC_POOL` + `DEPRECATED_REMAP` in `scripts/lib/model-resolver.mjs` and run
`node scripts/lib/model-resolver.mjs resolve` to verify.
