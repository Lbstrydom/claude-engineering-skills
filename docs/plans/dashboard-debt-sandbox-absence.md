# Plan: The dashboard's debt queue treats "no local cache" as an expected absence

- **Date**: 2026-10-11
- **Status**: In Progress — implemented on `fix/dashboard-debt-sandbox-absence`; under /audit-code
- **Author**: Claude + Louis
- **Scope**: backend (one classifier in the dashboard's queue reader; no UI change)

> **Target domain(s)**: `stores`.

## 1. Context Summary

**Measured 2026-10-11** in a linked worktree (`npm run dashboard:setup`):
`dashboard:build` exited **1** with `reference: source "home" is
unexpected-error — failing: queues`. The failing queue was `debt`:

```
queue-debt unexpected-error process-failed reader reported failure (exit 0, clean-checkout-sandbox)
```

The debt reader is `node scripts/debt-reconcile.mjs --json`, which compares the
local debt cache (`.audit/tech-debt.json`, gitignored) against the private
store. In a linked worktree or a fresh clone the cache does not exist, and the
reader's documented answer — exit 0 — is
`{"ok":false,"verdict":"unverifiable","reason":"clean-checkout-sandbox","action":"none"}`.
`classifyReaderResult` (`scripts/lib/store/backlog-gather.mjs`) had no rule for
it and fell through to `process-failed` (→ `unexpected-error`), the bucket that
means "the reader is broken". Sessions in this repo run in linked worktrees,
so the documented bootstrap failed where it is used.

## 2. Proposed Architecture

A closed `EXPECTED_ABSENCE_REASONS` list beside the existing
`STORE_UNREACHABLE_REASONS`, scoped per reader (`debt: ['clean-checkout-sandbox']`),
and a new outcome kind `no-local-cache` → `missing-optional`. The rule fires
only for that reader, only with exit 0 (the reader's documented exit), and only
with no `error.code` — the same evidence discipline the unreachable-store rule
uses. The card still shows no number: `missing-optional` carries no value.

Rejected: mapping it to `store-off` (the store is reachable; that label is
false) and having the debt reader report the store total without a cache
(changes the reconcile envelope that `backlog-snapshot` also formats).

## 3. Testing Strategy

`tests/backlog-gather.test.mjs`: the exact captured envelope classifies as
`no-local-cache` / `missing-optional`; the same envelope from another reader,
or with a non-zero exit, stays `process-failed`. Red before the fix
(`process-failed`), green after.

## 4. Acceptance Criteria

- `node scripts/build-dashboard.mjs all` in a linked worktree with the store
  configured exits 0 and reports `degraded: false`.
- A genuinely broken debt reader still classifies as `unexpected-error`.
