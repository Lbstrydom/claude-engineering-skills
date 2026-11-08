---
summary: Why the arch-map and dashboard pages are Category A, 0.5c's failure-mode matrix, and 0.5c/0.5d history.
---

# Architecture-memory and dashboard refresh — design rationale

## 0.5c — `docs/architecture-map.md` is Category A and is NEVER staged

This step used to end with `git add docs/architecture-map.md 2>/dev/null ||
true`, which outlived the file's B → A reclassification (2026-07-20) — the
same stale-staging instruction that 0.5d documents for the dashboard, two
steps away from that note. `git add` on a gitignored path *fails*, and the
`2>/dev/null || true` swallowed the failure, so an agent following the
instruction was told nothing while believing the map had shipped.

It fails the byte-identical Category B test three independent ways: the
header embeds a timestamp + commit sha + refresh_id; the body carries
LLM-written per-domain summaries (two renders of one commit differ in
wording); and it renders from the **cloud** `symbol_index`, i.e. external
mutable state, not from committed source. Citations to it in AGENTS.md stay
legal via `GENERATED_UNTRACKED_TARGETS` in `check-docs-refs.mjs`; a fresh
clone of the **source repo** regenerates it with `npm run dashboard:setup` —
an alias that exists here only, since the sync never adds npm scripts. A
consumer runs the three steps by path: `symbol-index/refresh.mjs`,
`symbol-index/render-mermaid.mjs`, `build-dashboard.mjs all`.

So this step's value is a current LOCAL map plus a fresh cloud symbol-index
for future arch-memory consultations — not a commit artifact.

## 0.5d — the dashboard pages are Category A, and the deleted second build

**Nothing here is ever staged.** Both pages are **gitignored** — Category A
per the generated-artifact policy (they derive from mutable store state, so
two builds of one commit can differ). They were reclassified B → A in
2026-06; this step's staging instruction outlived that change and told the
agent to `git add` a gitignored path, which either fails or force-adds a
Category-A artifact into a commit. (Design rationale, source repo only —
`docs/plans/` is not synced to consumers: `docs/plans/local-dashboard.md`
§2.1.)

**This is the only dashboard build.** There was a second one at "Step 5.5b"
that rebuilt AFTER plan archiving so the Plans tab reflected the final
active/completed split. Plans no longer move (Step 5.5), so nothing can
change between the two points and Step 5.5b was deleted along with the
archiver — but this note outlived it and still said "if you only run one,
run 5.5b", naming a step that does not exist.

## 0.5c — failure-mode matrix (every row: the ship continues)

**This step is ALWAYS advisory — it never blocks a ship.** Verified against
the current `pg`-direct implementation (`scripts/lib/db/client.mjs`'s
`resolveDbUrl()` and `scripts/symbol-index/refresh.mjs`) — the
`SERVICE_ROLE_REQUIRED` / RPC vocabulary below predates the postgres-parity
migration and no longer matches the code:

- Cloud off (no `AUDIT_DB_URL`, and no legacy `SUPABASE_AUDIT_*` set) →
  skip silently, ship continues.
- Legacy-only `SUPABASE_AUDIT_*` present without `AUDIT_DB_URL` → `resolveDbUrl()`
  throws (swallowed by this step's `|| true`), ship continues but the refresh
  does not run.
- Non-JS/TS stack → skips silently (`reason: 'unsupported-stack'`), exit 0,
  ship continues.
- HEAD not on the default branch (a feature branch, or detached at a commit
  the default branch does not contain) → skips (`reason: 'not-default-branch'`),
  status 0, ship continues. Deliberate: the next incremental refresh anchors on the
  active snapshot, so only the default branch may publish one. The local map then
  renders the default branch's snapshot.
- Any other failure (DB error, embedding-provider error, repo-registration
  or refresh-lock conflict) → `refresh.mjs` exits 1 or 2 and writes a message
  to stderr; this step's own `|| true` swallows the non-zero exit so the ship
  is never blocked, but the stderr line still prints — read it if the local
  map looks stale.
- Incremental refresh uses `git diff --name-status <since>`
  (NO `..HEAD`) UNION `git ls-files --others --exclude-standard` so
  the working-tree edits about to be committed are visible
  (per Gemini-G1 fix).

## 0.5d — building the dashboard in a consumer

Skip silently in consumer repos — the dashboard is opt-in and unwired there
(the sync never adds npm scripts), so a consumer runs it by path and gets
gitignored pages under its own `dashboard/`:

```bash
node scripts/build-dashboard.mjs all         # reference + telemetry
node scripts/build-dashboard.mjs serve       # build, then serve locally
node scripts/build-dashboard.mjs --help      # every mode and flag
```

## 0.5c — the drift sticky-issue

The architecture-drift sticky-issue is updated only by the weekly GH workflow, never by `/ship` directly.
