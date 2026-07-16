# Consumer-repo adoption

Guide for adopting `claude-engineering-skills` in a new consumer repo, and
for the one-time migration from the pre-isolation layout to the
`scripts/.claude-skills/` isolated layout.

---

## When to adopt

If you maintain a repo where you want Claude / Copilot / Cursor to use the
engineering-skills suite (`/plan`, `/audit-code`, `/audit-plan`,
`/persona-test`, `/click-test`, `/ux-lock`, `/ship`, `/brainstorm`), and
you have a local checkout of `claude-engineering-skills` somewhere on your
machine, you can adopt the bundle into your repo.

This is **a per-developer-machine setup**. The synced tooling tree is
gitignored on the consumer side — it doesn't get committed and won't be
present on a fresh clone until you re-sync.

---

## What gets installed where

After adoption, your consumer repo's working tree contains:

| Where | What | Tracked? |
|---|---|---|
| `scripts/.claude-skills/` | All of the engineering-skills `.mjs` files (~250 files including transitive lib deps) | **NO** — gitignored via managed block |
| `.claude/skills/` | Skill `.md` files (Claude Code reads from here) | YES |
| `.github/prompts/` | Copilot prompt shims | YES |
| `.vscode/mcp.json` | MCP server registrations (deep-merged with your existing values) | YES |
| `.claude/hooks/`, `.claude/settings.json` | Claude Code hooks + settings (deep-merged) | YES |
| `scripts/.sync-manifest.json` | Authoritative file list + `layout: 'isolated'` | YES |
| `.audit-loop/migrations/*.sql` | Postgres-parity migrations (consumer applies via their own DB tooling, separate from any consumer-app Supabase migrations) | YES |

The skill `.md` files reference scripts via `node scripts/.claude-skills/X.mjs`
(the rewriter handles that on sync). Your `.vscode/mcp.json` is deep-merged,
not overwritten, so your custom MCP server registrations survive.

---

## One-time migration recipe

This section covers consumers who were using the **pre-isolation** layout
(tooling files at the canonical `scripts/X.mjs` paths in their repo).
Skip if you're a brand-new consumer.

### Step 1 — verify pre-migration state

In your consumer repo:

```bash
# Verify the legacy manifest exists and has `layout: 'legacy'` (or no layout field at all)
jq '.layout // "legacy"' scripts/.sync-manifest.json
# Expect: "legacy" (or no output → treat as legacy)
```

```bash
# Verify git status is clean OR has only changes you've explicitly approved
# for the migration. The migration runner will pause to ask if it finds anything.
git status --porcelain
```

### Step 2 — snapshot the legacy manifest

The legacy manifest is the authoritative "what is ours" record. Copy it
somewhere safe BEFORE the new sync runs, because step 3 will overwrite it.

```bash
cp scripts/.sync-manifest.json /tmp/legacy-manifest.json
```

### Step 3 — hydrate the new layout

From the **source repo** (claude-engineering-skills checkout):

```bash
cd /path/to/claude-engineering-skills
npm run sync -- --target <ai|wine|your-alias>
```

This:

- Reads your consumer's prior manifest (legacy layout)
- Writes new tooling files under `scripts/.claude-skills/...`
- Rewrites every `node scripts/X.mjs` reference in `.claude/skills/**/*.md`,
  `.claude/hooks/`, `.claude/settings.json`, `.github/prompts/*.prompt.md`,
  `.vscode/mcp.json` to point at the new path — but ONLY for files we own.
  Your `scripts/automated-tests.js`-style consumer commands stay untouched.
- Writes a new `scripts/.sync-manifest.json` with `layout: 'isolated'`.
- Appends a managed block to your consumer `.gitignore` excluding
  `scripts/.claude-skills/`.

### Step 4 — verify hydration

Back in your consumer repo:

```bash
node scripts/.claude-skills/lib/sync-isolation-verify.mjs \
  --consumer-root . \
  --legacy-manifest /tmp/legacy-manifest.json \
  --gates 2B,3,4,5,6,7 \
  --format json
```

All gates must pass. If any fails, STOP — fix the underlying issue
before proceeding. The verifier output explains each failure.

### Step 5 — remove legacy files

Now that the new layout is hydrated and verified, delete the old tracked
tooling files from your `scripts/` root:

```bash
node scripts/.claude-skills/lib/remove-legacy-synced.mjs \
  --consumer-root . \
  --legacy-manifest /tmp/legacy-manifest.json
```

This script:

- Validates every legacy path is safe (no `..`, no traversal, no shell metacharacters)
- **Hash-verifies** each file against the legacy manifest — files you've
  locally modified are skipped and reported (not destroyed)
- Preflight-aborts on dirty tracked files (use `--force-dirty` only if you
  know what you're doing)
- `git rm -f --cached` each tracked legacy file, `fs.unlink` from disk
- Tolerates `ENOENT` for files already gone

### Step 6 — final verification

```bash
node scripts/.claude-skills/lib/sync-isolation-verify.mjs \
  --consumer-root . \
  --gates 1,2A \
  --format json
```

Gate 2A asserts no `scripts/.claude-skills/**` paths appear in `git status`
(neither uncommitted nor committed-but-clean). Should be empty.

### Step 7 — reconcile your `package.json` scripts

If your consumer's `package.json` has `npm run` scripts that invoke
`node scripts/X.mjs` paths matching our tooling, update those to point at
`scripts/.claude-skills/X.mjs`. The verifier's gate 5 lists every stale
reference.

### Step 8 — commit + PR

```bash
git status   # should show: skill .md modifications, .gitignore append, manifest update, legacy file deletions
git checkout -b chore/isolate-engineering-skills-tooling
git add .gitignore scripts/.sync-manifest.json .claude/ .github/ .vscode/
git add -u   # picks up legacy file deletions
git commit -m "chore: isolate engineering-skills tooling under scripts/.claude-skills/"
git push -u origin chore/isolate-engineering-skills-tooling
```

The migration commit should contain ONLY:

- Deletions for every legacy tracked file
- Modifications to skill `.md` files (path rewrites)
- `.gitignore` append (managed block)
- `scripts/.sync-manifest.json` update (layout flip + key updates)
- Modifications to `.vscode/mcp.json`, `.claude/settings.json`, etc.
  (path rewrites)

Anything else in `git status` is unrelated work — do NOT bundle it.

---

## Updating later

After the initial migration, future updates from the source repo are:

```bash
cd /path/to/claude-engineering-skills
git pull
npm run sync -- --target <your-alias>
```

The sync is **idempotent**: re-running it against an already-current
consumer produces no diff. The `.gitignore` managed block, the manifest
hashes, and the skill `.md` rewrites all short-circuit when unchanged.

### Selector-policy update (2026-07)

`/ux-lock` now enforces a selector priority ladder on the specs it generates
(`getByRole` → `getByLabel`/`getByPlaceholder` → `getByText` → `getByTestId` →
justified-structural CSS with a `// selector-policy: structural — <reason>`
marker), and `scripts/.claude-skills/ux-lock-run.mjs` lints every spec it runs
(plus local-helper imports) for unmarked structural selectors and app-module
imports. Re-sync to pick this up, and run `setup-postgres --migrate` for the
`selector_policy_violations` telemetry columns.

**Existing consumer specs are NOT rewritten by this change.** The lint defaults
to warn, so legacy structural-selector suites keep running unchanged;
`--strict-selectors` is opt-in per run (recommended for newly generated specs).

---

## Fresh-clone workflow

If you (or a teammate) clone the consumer repo on a new machine, the
tooling tree under `scripts/.claude-skills/` won't be there — it's
gitignored. To populate it:

```bash
# In the consumer repo:
git clone <consumer-repo-url>
cd consumer-repo

# In the source repo:
cd /path/to/claude-engineering-skills
npm run sync -- --target <your-alias>
```

That single `sync` command hydrates the tooling tree at the right paths
and you can start using `/audit-code`, `/persona-test`, etc.

---

## Troubleshooting

### Sync aborts on `.gitignore` malformed marker

The managed-block manager fails-fast on malformed marker state (duplicate
blocks, orphan markers, out-of-order markers). If sync aborts with a
message like:

```
ABORT  .gitignore preflight: .gitignore has orphan begin marker at line 42
```

…manually consolidate the markers in `.gitignore` (delete the orphan) and
re-run sync.

### Sync aborts on "unowned collision"

The sync preflight scans every destination it intends to write. If a
file already exists at that path AND isn't in the prior manifest, it's
flagged as foreign. This protects you from sync accidentally
overwriting consumer-owned files at the same path.

Resolution: identify whether the file is yours or stale. If yours, move
it out of `scripts/.claude-skills/`. If stale (e.g. from an aborted
migration), delete it and re-run sync.

### Mid-sync crash recovery

If sync crashes after writing some files but before completing, you'll
see `scripts/.sync-in-progress.json` left behind. The next sync run
detects this and treats listed destinations as "owned by the
interrupted prior run", re-attempting writes idempotently. No manual
recovery needed.

### Modified tracked files in legacy removal

`remove-legacy-synced.mjs` aborts by default when it detects modified
tracked files (i.e. files where your working tree differs from the
git index). This protects against destroying in-flight work.

To proceed anyway (only if you're sure you don't want the modifications):

```bash
node scripts/.claude-skills/lib/remove-legacy-synced.mjs \
  --consumer-root . --legacy-manifest /tmp/legacy-manifest.json \
  --force-dirty
```

The `--force-dirty` flag is logged in the JSON summary so PR reviewers
can see it was used.

---

## Private / corporate consumers (keep the name out of this public repo)

`scripts/lib/consumer-repos.mjs` is committed to this **public** repo, so don't
add a corporate consumer there. Instead create a **gitignored local override**
on the dev machine:

```bash
cp scripts/lib/consumer-repos.local.example.json scripts/lib/consumer-repos.local.json
# edit: { "repos": [ { "name": "audit-loop", "alias": "work", "path": "../audit-loop" } ] }
```

`path` is absolute or relative to the repo root; the consumer must sit beside
this clone (e.g. `C:\GIT\claude-engineering-skills` + `C:\GIT\audit-loop`).
`consumer-repos.local.json` is gitignored and never leaves the machine; local
entries merge into `--target` resolution (and win on alias collision).

## Keeping a consumer updated (one-directional)

Sync is **canonical → local clone → consumer**. Nothing pushes back to
`claude-engineering-skills`, and nothing auto-commits the consumer. One command
pulls canonical + re-hydrates the consumer:

```bash
npm run sync:refresh -- --target work          # pull canonical, sync into the consumer
npm run sync:refresh -- --target work --no-pull # sync only (offline / pinned clone)
```

It prints the consumer's tracked changes (skill `.md`, prompts, manifest,
migrations) so you can review and `git commit && git push` them to the
consumer's OWN remote by hand. The synced `scripts/.claude-skills/**` tooling is
gitignored on the consumer, so it never appears in that push (re-hydrate a fresh
clone with another `sync:refresh`). **Never edit the synced tooling in the
consumer — fix it upstream here and re-sync.**

---

## Two ways to deploy this bundle

There are two distinct shapes — pick by whether the target repo has **its own
code** worth keeping.

### A) As a consumer (layer the skills INTO an existing repo)
The repo has its own application code; you want `/plan`, `/audit-code`, `/ship`,
etc. available inside it. Use the sync flow above (`npm run sync:refresh --
--target <alias>`). Tooling lands gitignored under `scripts/.claude-skills/`;
only skill `.md` + config are tracked. This is the right shape for
`wine-cellar-app`, `ai-organiser`, and any product repo.

### B) As a private fork/mirror (the bundle IS the repo, on a private remote)
The target repo has **nothing of its own** — it exists only to run this bundle
(e.g. an old, redundant tooling checkout you want to retire). Don't make it a
thin consumer (you'd get a near-empty repo). Instead make it a fork that tracks
this canonical repo as `upstream` and pushes to your private remote as `origin`:

```bash
git clone <canonical-url> <repo>
cd <repo>
git remote rename origin upstream          # canonical (read-only, pull updates)
git remote add origin <your-private-url>    # your backup remote (push here)
git push -u origin main --force             # replaces any old unrelated history

# stay updated — one-directional, no automation:
git pull upstream main      # latest canonical
git push origin main        # mirror to your private remote
```

Secrets live in a gitignored `.env` (or `~/.audit-loop.env`), so they never
reach either remote. The fork is fully self-contained + runnable from a fresh
clone — including the Azure work profile, which ships in this bundle. Keep the
fork's `main` identical to upstream (no local commits on `main`) so pulls stay
fast-forward; put any machine-specific config in the gitignored `.env` or the
gitignored `consumer-repos.local.json`, not in tracked files.

---

## Sync internals (moved from AGENTS.md, 2026-07-13 sprawl trim)

### Why isolated

ai-organiser has its own `scripts/` with `automated-tests.js`,
`install-ffmpeg.js`, `persona-harness/`, etc. wine-cellar-app has
its own. Without isolation, our 40+ tooling files mix into theirs
and either (a) pollute the consumer's commits when tracked, or
(b) clutter `git status` when untracked. The `scripts/.claude-skills/`
subdir makes ownership obvious and structurally avoids name
collisions.

### What sync writes

`scripts/sync-to-repos.mjs` writes to each consumer:

| What | Where in consumer | Tracked? |
|---|---|---|
| Tooling files (`scripts/X.mjs` and subdirs) | `scripts/.claude-skills/X.mjs` etc. | No (gitignored) |
| Skill `.md` files (`.claude/skills/**`) | `.claude/skills/**` (rewritten — paths in body point at `scripts/.claude-skills/`) | Yes |
| Copilot prompt shims (`.github/prompts/*.prompt.md`) | same path (rewritten) | Yes |
| Editor config (`.vscode/mcp.json`) | same path (rewritten if it references scripts) | Yes |
| Claude Code hooks + settings (`.claude/hooks/`, `.claude/settings.json`) | same path (rewritten) | Yes |
| Per-consumer manifest (`scripts/.sync-manifest.json`) | same path; layout=`isolated` | Yes |
| Migrations (`supabase/migrations/*.sql` in source) | `.audit-loop/migrations/*.sql` | Yes |

The managed `.gitignore` block also covers our **runtime outputs** (`AUDIT_RUNTIME_IGNORES`
in `sync-to-repos.mjs`: `.audit/cache-metrics.jsonl`, `.audit-loop/*-{observed,verify-result,drift-ledger}.json`,
`.audit-loop/arm-eval-toggle.json`, `.audit/tiered-shadow-log*.jsonl`, and
`docs/arm-eval/{sessions,worksheets}/*` — arm-eval exports are a *tracked* auditable
record in the SOURCE repo but local-only runtime output in consumers, where the
authoritative capture is the cloud `arm_eval_*` tables) so audit / `--verify` runs
don't churn in consumers. Because a `.gitignore` rule never untracks an
already-committed file, sync ALSO self-heals: after writing the block it
`git rm --cached`'s any tracked file matching those patterns
(`scripts/lib/sync-untrack.mjs`, faithful gitignore-glob semantics so `*` never
crosses `/` → a consumer's own files and `.audit-loop/migrations/*.sql` are never
swept; the consumer commits the resulting index change). Idempotent; dry-run
previews it.

### Key modules

- `scripts/lib/sync-path-map.mjs` — bidirectional path mapper (`sourceRelToDestRel`/`destRelToSourceRel`), single source of truth for the layout.
- `scripts/lib/sync-rewriter.mjs` — ownership-aware command rewriter. Only rewrites `node scripts/X.mjs` references when `X` is a file we own (consumer-owned `scripts/foo.js` stays untouched). Exports `COMMAND_REGEX` so the verifier reuses the same parser.
- `scripts/lib/sync-gitignore.mjs` — managed-block `.gitignore` manager. Validates marker state and aborts on malformed input (no fail-soft).
- `scripts/lib/sync-isolation-verify.mjs` — CLI verifier consumers run during migration (`--gates 1,2A,2B,3,4,5,6,7`).
- `scripts/lib/remove-legacy-synced.mjs` — migration helper. Reads the legacy manifest, hash-verifies each file (skips on mismatch — won't destroy locally-modified content), preflight-blocks on dirty tracked files unless `--force-dirty`.
- `scripts/lib/npm-script-enumerator.mjs` — extracts `npm run X` references from synced skill `.md` so the consumer's `package.json` scripts can be reconciled.
