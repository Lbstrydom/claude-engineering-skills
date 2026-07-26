# Plan: Arch-Memory / Symbol-Index Pipeline Debt (2026-07-26 triage)

- **Date**: 2026-07-26
- **Status**: Draft
- **Author**: Claude (tech-debt backlog triage session)
- **Scope**: backend

> Origin: full `.audit/tech-debt.json` backlog triage (384 entries). This
> cluster (25 entries) covers the `scripts/symbol-index/**` +
> `scripts/lib/store/arch/**` pipeline that populates architectural memory
> (the same system `AGENTS.md`'s "Architectural Memory" section documents).
> All verified against current source on 2026-07-26.

---

## Theme 1 — Heartbeat/liveness is decorative, not load-bearing

`41bf7af6`, `812d9d83` — `refresh.mjs`'s heartbeat is fire-and-forget inside
a `setInterval`; a rejection is now logged (a partial fix already landed)
but the actual refresh pipeline proceeds regardless, and
`refresh-lock.mjs`'s own comment claims an aborted worker's heartbeat loop
"exits cleanly when it observes status != 'running'" — no such check exists
anywhere in `runWithHeartbeat`. A `--force`-aborted run keeps executing
unaware. **Fix**: make the heartbeat interval actually check run status and
abort the in-flight `fn()` (via an AbortController threaded through) when
it observes the run was force-stopped — currently it's a liveness signal
with no enforcement teeth.

## Theme 2 — `drift.mjs` fail-open scoring

`0b72a3da`/`e74dbba2` — `Number(drift.score) || 0` coerces a missing/NaN
score to 0, which reads as GREEN in the dashboard rather than "unknown."
`fca2fde3` — `renderMarkdownViaShared` passes `commitSha: drift.refresh_id`
(a refresh UUID, not a git sha) into a field that renders as if it were one.
`3cac922a` — `listSymbolsForSnapshot` has a hardcoded `limit: 10000`.
`688c866f` — writes to stdout then unconditionally `process.exit()`s (a
half-fixed cross-file pair — the other half, `archive-completed-plans.mjs`,
was deleted entirely this session; this instance remains). **Fix**: for the
score, follow this repo's own established pattern (`Number.isFinite` +
explicit `unknown` state, same as the coverage-gate honesty work
`docs/plans/observed-graph-coverage-honesty.md` already did) rather than a
silent numeric fallback.

## Theme 3 — `extract.mjs` (symbol extraction)

`43c77e0c` — `extractSymbols` is one 213-line function mixing admit/load/
classify/redact/emit. `45dcee69`/`a46ddb5a` — progress events are emitted
*before* the sensitive-path skip check and canonical classification, so a
sensitive filename can appear in progress output pre-filter (a narrower,
real instance of the general redaction-ordering class this repo already
takes seriously per the sensitive-paths doctrine in AGENTS.md). `59a36988`
— the extension allowlist gate checks the lexical name, not the
symlink-resolved canonical target computed two lines later — a smaller
version of the WS-CANON symlink-bypass class already fixed for
`sensitive-paths.mjs` (INC-001), just not yet applied here. `6327e5d8` —
raw numeric TS compiler-option literals instead of named enum constants.
`e058e7df` — heartbeat only fires once per file, so one huge (near the
500KB cap) file gets no interior heartbeat. `395e92881aa4`/`c191e74d781b` —
`--files-from` manifest parsing is still lossy on newlines/whitespace
(accepted debt per the file's own comment — these two topicIds are
duplicates of the same acknowledged gap, safe to track as one item going
forward). **Priority**: fix `59a36988` (the progress/classification
ordering + extension-gate-on-lexical-name pair) first — it's the one with
a real security-adjacent angle, matching a class this repo already treats
as a security incident elsewhere.

## Theme 4 — Refresh-subprocess file-scope handling

`b021576b` — an intentionally-empty incremental-files array is treated the
same as `null` (full walk) rather than "nothing to do." `e86a9cbb` —
predictable `os.tmpdir()/arch-refresh-files-${pid}-${Date.now()}.txt` path
with plain `writeFileSync`, no `wx`/symlink guard. `c5b28713` —
`retryFiles` from `listFilesNeedingSummaryRetry` bypasses
`filterDiffFiles`/sensitive-path policy that `diffResult.files` goes
through, a real (if narrow) sensitive-path filtering gap. `1b95d1e7` —
`refresh-mode.mjs`/`refresh-lock.mjs` store functions filter purely by `id`,
accepting no `repoId` at all (single-tenant assumption baked into a
multi-repo-capable schema). `aba921ff` — `parseArgs` in
`refresh-args.mjs` only matches exact `--flag` tokens, not `--flag=value`,
inconsistent with `cli-io.mjs`'s `assertKnownFlags`.

## Theme 5 — Store-layer write-result honesty

`0aa2b07f` — `recordDuplicateJustifications`-style unchunked bulk UPDATE (4
bind params/row) with no batching cap; exceeds Postgres's 65,535-parameter
limit past ~16,384 rows. `db707fba`, `45d75ad9` — several
`arch/symbols.mjs`/`arch/imports.mjs` writers still don't check `rowCount`
after `upsert`/`updateWhere`, unlike a sibling function in the same file
that was *already* fixed to do so (round-3 H2) — this is the same class,
just not yet propagated to every call site. **Fix**: this is the
"jsonb-safe write seam" doctrine AGENTS.md already documents for a
different failure mode (raw-array-to-jsonb) — the missing-rowCount-check
class deserves the same repo-wide sweep treatment.

## Theme 6 — `graph-verdict.mjs`

`bde4d5ec36e7` — `Number.isFinite` guards silently *skip* the degradation
check when `ratio`/`elapsedMs` are absent, so a partial persisted
extraction can still read `verified` — the exact "can this return green
without having actually checked anything" pattern AGENTS.md's pre-ship
empirical-verify doctrine calls out by name.

---

## Full entry table


**`scripts/symbol-index/extract.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `43c77e0c` | MEDIUM | symbol-index/extract.mjs:86-299 extractSymbols still one 213-line function |
| `45dcee69` | LOW | extract.mjs:124 progress emitted before skip-check/classification at 130/149 |
| `59a36988` | MEDIUM | extract.mjs:136,149,164 extension gate checked on lexical name not canonical target |
| `6327e5d8` | MEDIUM | extract.mjs:106-108 raw numeric literals not enum constants |
| `a46ddb5a` | MEDIUM | extract.mjs:124,155 same progress-before-classification ordering duplicate |
| `e058e7df` | MEDIUM | extract.mjs:124 heartbeat only at top of loop, no interior heartbeat, own comment concedes |
| `395e92881aa4` | MEDIUM | extract.mjs:64 --files-from still lossy split, accepted-debt comment confirms |
| `c191e74d781b` | HIGH | extract.mjs:64 files-from manifest still lossy split, accepted-debt comment confirms |

**`scripts/symbol-index/drift.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `0b72a3da` | MEDIUM | drift.mjs:106 Number(drift.score)\|\|0 coercing missing/NaN scores to 0 -> GREEN |
| `3cac922a` | MEDIUM | drift.mjs:155 listSymbolsForSnapshot hardcoded limit:10000 cap |
| `688c866f` | MEDIUM | drift.mjs:176-183 still writes stdout then unconditionally calls process.exit() |
| `e74dbba2` | HIGH | drift.mjs:106 same Number(drift.score)\|\|0 fallback duplicate of 0b72a3da |
| `fca2fde3` | MEDIUM | drift.mjs:64 renderMarkdownViaShared passes commitSha:drift.refresh_id, acknowledging comment unchanged |

**`scripts/symbol-index/refresh.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `41bf7af6` | HIGH | refresh.mjs:134-138 heartbeat still fire-and-forget, fn() proceeds regardless of failure |
| `812d9d83` | HIGH | refresh.mjs:131-142 + refresh-runs.mjs:80-82 heartbeat rejection only logged, no status check exists despite refresh-lock.mjs comment claim |
| `d6d8267b1fd9` | MEDIUM | refresh.mjs:24-39,144-614 own header admits steps 8-14 deliberately inline, main() still ~470 lines mixed concerns |

**`scripts/symbol-index/refresh-subprocess.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `b021576b` | HIGH | refresh-subprocess.mjs:92 empty array conflated with null (full walk) |
| `e86a9cbb` | HIGH | refresh-subprocess.mjs:93-94 predictable tmp path no wx/symlink check |

**`scripts/symbol-index/refresh-mode.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `1b95d1e7` | HIGH | refresh-mode.mjs:74,refresh-lock.mjs:80 no repoId param at all |

**`scripts/symbol-index/refresh-args.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `aba921ff` | HIGH | refresh-args.mjs:38-42 parseArgs exact-token match only, no equals-form support unlike cli-io.mjs |

**`scripts/symbol-index/refresh-file-scope.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `c5b28713` | HIGH | refresh-file-scope.mjs:95-105 retryFiles merged without sensitive-path filtering unlike diffResult.files |

**`scripts/lib/symbol-index/graph-verdict.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `bde4d5ec36e7` | MEDIUM | symbol-index/graph-verdict.mjs:223-233 finite guards silently skip degradation checks on partial data |

**`scripts/lib/store/arch/symbols.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `0aa2b07f` | MEDIUM | store/arch/symbols.mjs:238-277 unchunked bulk UPDATE 4 params/row, exceeds pg 65535 param limit at scale |
| `db707fba` | HIGH | store/arch/symbols.mjs:93-97,203-207 no rowCount check unlike sibling function already fixed |

**`scripts/lib/store/arch/imports.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `45d75ad9` | HIGH | store/arch/imports.mjs upsert/updateWhere no rowCount check |

## Rollback

All fixes are additive/refactor-only; no schema/data migrations except
where a store-layer batching fix is added (which is itself a defensive
change, not a migration).
