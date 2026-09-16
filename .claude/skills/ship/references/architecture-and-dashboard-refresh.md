---
summary: Why the arch-map and dashboard pages are Category A, and deleted-step history for 0.5c/0.5d.
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
