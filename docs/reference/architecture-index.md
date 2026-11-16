# Architecture index — refresh order, the dependency model, and two measurement incidents

**What it is**: the detail behind AGENTS.md's arch-map preamble — how the symbol
index and the domain map are bootstrapped and refreshed, the two-layer (observed +
manual) dependency model, and two incident-grade lessons about *what the index
measures*: the corpus is the repo rather than the disk, and a retag changes the
edges **into** a module as well as out of it.

**When you need it**: refreshing a stale `docs/architecture-map.md`, editing
`.audit-loop/domain-map.json`, retagging a module, touching
`enumerateFilesWithOwnership` or `CRUISABLE_EXTENSIONS`, or reading an
`arch:drift` / coverage verdict.

**Why it lives here**: AGENTS.md is loaded every session and enforced at 92,000
characters (`npm run context:check`). Its own rule is that subsystem-grade depth
belongs in `docs/` behind a short stub. These passages were relocated from
AGENTS.md on 2026-10-03 **verbatim apart from link paths**, so nothing was lost —
AGENTS.md keeps the rule, the test and a pointer here.

Plans behind this material:
[observed-domain-deps.md](../plans/observed-domain-deps.md) ·
[observed-graph-coverage-honesty.md](../plans/observed-graph-coverage-honesty.md) ·
[consumer-corpus-and-honesty-2026-09-04.md](../plans/consumer-corpus-and-honesty-2026-09-04.md) ·
[god-module-and-layering-debt.md](../plans/god-module-and-layering-debt.md) ·
[incremental-refresh-ownership-propagation.md](../plans/incremental-refresh-ownership-propagation.md).

---

## Domain roster drift is gated

[`docs/architecture-intent.md`](../architecture-intent.md) documents each domain
as a `### \`<domain>\`` heading; **this doc + `.audit-loop/domain-map.json`
together enforce** that the two agree. `npm run docs:architecture-intent:check`
(in the pre-push `check`) fails when the map declares a domain the doc never
documents — the reverse is never flagged, since the doc may retain retired
domains as rationale. It landed 2026-08-02 after sitting unmerged for 110
commits, during which the doc drifted to 12 headings against a 36-domain map.

## Bootstrap / refresh order

When the map is stale, missing, or after editing
[`.audit-loop/domain-map.json`](../../.audit-loop/domain-map.json):
`npm run dashboard:setup` (chains `arch:refresh` → `arch:render` →
`dashboard:build`). Domain re-tagging happens in `arch:refresh` against the
symbol_index table — editing `domain-map.json` alone does not retag existing DB
rows; always start with `arch:refresh` after a rename.

**Ownership is the same shape and is now automatic**: a plain incremental
re-asks the ownership oracle about the rows it CARRIES (not `args.files` — a
gitignored-and-untracked file can never appear in a git diff), and a change to
`OWNERSHIP_RULE_EPOCH` promotes the next run to a full walk, because dropping a
row is expressible from the index and re-admitting one is not.

## Two-layer dependency model (Architecture tab tiers)

- **Observed** — DB import graph from `symbol_file_imports`, written to
  `.audit-loop/domain-deps-observed.json` by `arch:render`, regenerated every
  render, gitignored. Evidence layer: this is what code *actually* imports.
- **Manual** — `allowedDeps` block inside `domain-map.json`, committed. Intent
  layer: architectural rules the import graph cannot see (dynamic imports,
  intentionally-forbidden edges, framework wiring).

The dashboard reader merges both with per-edge provenance (`source ∈
{observed, manual, both}`). Manual entries are NOT a fallback — they add
architectural intent the import graph misses. The reader Zod-validates the
observed envelope and rejects it as stale when the domain-map rules digest
changes without a fresh `arch:render`.

**Coverage honesty**: the envelope also carries a `coverage` verdict counting what
the graph DROPPED; absent reads `unknown`, never clean. `npm run
arch:coverage-gate` owns the exit code — in `check`, NOT `dashboard:setup`.
Design: [observed-graph-coverage-honesty.md](../plans/observed-graph-coverage-honesty.md).

## The corpus is the repo, not the disk — and dep-cruiser's extension list is a question, not a constant

Two ways the index measured the wrong thing, both measured in a consumer
2026-09-04 and both invisible in this repo (it vendors nothing and is all
`.mjs`).

1. The walker enumerated the filesystem against a fixed `SKIP_DIRS` list and never
   asked git: **3,963 of 5,158 walked files (76.8%) were gitignored-and-untracked**,
   the largest contributor being `scripts/.claude-skills/` — this bundle —
   indexed as the consumer's code and then counted against them by the
   duplication score, leaving GREEN unreachable. `enumerateFilesWithOwnership` now
   filters through the one oracle
   ([disowned-paths.mjs](../../scripts/lib/disowned-paths.mjs)) — **ignored AND
   untracked**, asked of the CANDIDATES, fail-open and loud — and edges touching
   a disowned path get their own bucket.
2. `CRUISABLE_EXTENSIONS` **claimed** `.ts`/`.vue` were parseable; dep-cruiser
   parses `.ts` only when it can resolve `typescript`, which pnpm's strict layout
   does not hoist. **522 of 675 eligible files were unreadable** while the graph
   reported `outcome: 'ok'` and `arch:drift` printed `Layering violations: 0` — a
   sentence that reads as *no violations* and means *nothing measured*.
   `assessParserAvailability` asks dep-cruiser's own `allExtensions` instead, and
   `extraction.parser` names the gap with its remedy.

**Generalise both: before a walk or an allowlist decides what a repo contains,
ask what already knows — git for ownership, the parser for its own capability.**
Measurements and the full design:
[consumer-corpus-and-honesty-2026-09-04.md](../plans/consumer-corpus-and-honesty-2026-09-04.md).

## Retagging a module changes every edge *into* it — re-baseline BOTH directions

Moving a file to another domain changes the `from` domain of everything it
imports *and* the `to` domain of everything that imports it. The second half is
the one that gets forgotten, because it is invisible from the file you are
editing. **Three retags in four days made this exact error**: `d5e66d35`
(2026-08-10) cleared `shared-lib`'s outbound grant and created four inbound
violations, its own commit message showing the one-sided check (*"adds no new
edge: model-eval → audit-orchestration was already declared"* — that is what the
file IMPORTS, never who imports IT); `a146bb7b` (08-12) repeated it, retagging
`lib/cross-skill/**` and creating four `tests → cross-skill-bridge` violations.

Do not verify this by grep — a docstring mention reads as an import. Run the
mechanical check: `tests/arm-vocabulary-layering.test.mjs` re-derives the whole
violation set and is in `npm test`, so a retag that breaks the inbound half fails
at push. Detail: [god-module-and-layering-debt.md](../plans/god-module-and-layering-debt.md) §1.2.

## `arch:duplicates` size floor — opt-in, so trivial helpers need not be clusters

Exact-signature clustering used to report every cross-file copy, including 2–5
line test helpers (`sleep`, `sha256`), and those inflated both the cluster list
and the `arch:drift` score. An opt-in size floor excludes symbols spanning fewer
than N lines before grouping, **inside the SQL** (`top_duplicate_clusters` and
`drift_score`), so the list and the score always agree.

**The default is OFF (`0`)**, so no consumer's drift-score population or trend
changes until it opts in. **Opt in from your own workflow** by passing the same
value to both CLIs — e.g. storyline passes `--min-lines 6` to `duplicates.mjs`
and to `drift.mjs`, which hides symbols of 5 lines or fewer (the
`sleep`/`sha256`/`claim` class) while a function with real logic (≥6 lines) still
clusters. Pass it to **both**, or the list and the verdict count different
populations.

The floor is **path-independent**: when you opt in it also hides a short duplicate in production code, not only test helpers. The suppressed count below is how you notice; if a real 4-line duplicate matters to you, lower the floor or leave it off.

Set it per run or per repo — the flag wins over the env var, `0` (the default) is off:

```bash
node scripts/.claude-skills/symbol-index/duplicates.mjs --json --min-lines 6
ARCH_DUPLICATE_MIN_LINES=4 node scripts/.claude-skills/symbol-index/duplicates.mjs
node scripts/.claude-skills/symbol-index/drift.mjs --min-lines 6
```

(In the CES repo itself the same files live at `scripts/symbol-index/…`.)

What to read in the output — the `--json` envelope gains a `floor` object:

| Field | Meaning |
|---|---|
| `minLines`, `source` | The effective floor and where it came from (`flag` / `env` / `default`). |
| `applied` | `false` when the floor is off (`reason: disabled`) **or** the store cannot honour it (`reason: store-not-migrated`). `true` with `reason: count-unavailable` means the floor ran but its suppressed-count query failed — `suppressedClusters` is then `null`. |
| `suppressedClusters` | Clusters that vanished because of the floor. `null` means *unknown*, never zero. Also `pairsBefore/After`, `rowsSuppressed` to explain a score change when a cluster shrank but survived. |

A store that has not applied migration `20261030130000_duplicate_min_lines_floor.sql`
returns the **un-floored** list with `applied: false` (the population can only
over-report; if the page is `truncated`, trivial clusters can push real ones off
it — raise `--limit`); if you asked for the floor explicitly (flag or env), the CLI
exits 2 instead. A malformed value (`--min-lines 1O`) is exit 2, not a quiet
default. Design: [`duplicate-min-lines-floor.md`](../plans/duplicate-min-lines-floor.md).
