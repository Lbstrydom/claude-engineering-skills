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

## Runtime prerequisites — and non-Node consumers

**The consumer repo does NOT have to be a Node repo.** The bundle ships in two
independent halves, and only one of them needs a Node runtime:

| Half | Needs | Works in a Python / Go / Databricks repo? |
|---|---|---|
| `.claude/skills/**` (skill `.md`) | nothing — Claude Code reads the markdown directly | **Yes, fully** |
| `scripts/.claude-skills/**` (`.mjs`) | Node + the bundle's deps resolvable from the consumer | **No** — see Tier 2 below |

The **target language is irrelevant to the skills' value** — `/audit-code`
sends a diff to GPT, and a Python diff audits exactly as well as a TypeScript
one; `/plan` is language-agnostic. What the `.mjs` half needs is a *runtime*,
not a matching language.

### The three adoption tiers

**Tier 1 — full sync (consumer has `package.json` + installed deps).**
The documented default. Everything in "What gets installed where" applies;
`node scripts/.claude-skills/X.mjs` resolves the bundle's imports (`zod`, `pg`,
`openai`, `@google/genai`, `dotenv`) from the consumer's own `node_modules`.

**Tier 2 — skills-only + source-repo driving (consumer has no `package.json`).**
The markdown half installs and works. The `.mjs` half lands but is **inert** —
nothing installs its deps, so every entry point fails to resolve on first
import. Recover the tooling half by running the scripts **from your
`claude-engineering-skills` checkout against the consumer's cwd**:

```bash
# from the CONSUMER repo's root (e.g. a Databricks / Python repo).
# PLAN_FILE = the plan you are auditing, relative to the consumer root.
PLAN_FILE=$(ls docs/plans/*.md | head -1)
AUDIT_ALLOW_FOREIGN_CWD=1 node C:/GIT/claude-engineering-skills/scripts/openai-audit.mjs code "$PLAN_FILE" --scope diff
```

```powershell
# PowerShell — set the source path and the plan once, then reuse them:
$SkillsRepo = "C:/GIT/claude-engineering-skills"
$PlanFile   = (Get-ChildItem docs/plans/*.md | Select-Object -First 1).FullName
$env:AUDIT_ALLOW_FOREIGN_CWD = "1"
node "$SkillsRepo/scripts/openai-audit.mjs" code "$PlanFile" --scope diff
```

`AUDIT_ALLOW_FOREIGN_CWD=1` is the **sanctioned** escape hatch, not a
workaround — see [`scripts/lib/assert-repo-root.mjs`](../../scripts/lib/assert-repo-root.mjs).
These scripts read their target from `process.cwd()`, so "script's repo ≠ cwd"
is the correct shape here. The consumer pre-push hook we generate uses the
identical pattern ([`install-prepush-hook.mjs`](../../scripts/install-prepush-hook.mjs)).
The source repo supplies the runtime and deps; the consumer supplies the code
under analysis.

> Prefer Tier 2 over adding a `package.json` to a repo that has no other
> reason to have one — a Node manifest in a Python repo is a lie about the
> project that every future reader has to decode.

**Tier 3 — private fork/mirror.** The bundle *is* the repo. See
"Two ways to deploy this bundle" §B below.

### The second axis: runtime ≠ language support

Tier is about whether the `.mjs` can **run**. It says nothing about whether a
given skill can **understand your code** — a separate axis, and the one that
surprises people:

> **Architectural memory (`arch:refresh` / `arch:render`) is JS/TS-only in v1.**
> [`symbol-index/refresh.mjs`](../../scripts/symbol-index/refresh.mjs)
> short-circuits unless `detectRepoStack` returns `js-ts` or `mixed`, emitting
> `reason: 'unsupported-stack'`. `arch:render` then correctly writes its
> `repo-not-registered` stub. Both steps report honestly — but you only find
> out after running them.

Because `detectRepoStack` requires a `package.json` **with dependencies** to
report `js-ts`, **every Tier-2 consumer is automatically outside architectural
memory's support** — fixing the runtime does not unlock it. A Tier-1 repo whose
`package.json` is an empty shell is skipped for the same reason. Everything
else — `/plan`, `/audit-plan`, `/audit-code`, `/ship`, and the browser lenses —
is language-agnostic and works regardless.

**Don't reason about this by hand — ask:**

```bash
node C:/GIT/claude-engineering-skills/scripts/skills-fit-check.mjs --repo-root .
```

It prints FITS / PARTIAL / MISMATCH per skill for the repo you point it at, and
is the authoritative answer — the architectural-memory verdict is coupled by
test to the extractor's real short-circuit, so it cannot quietly go stale.

`npm run sync` detects which tier a target is in and prints the applicable
mode. It **warns rather than aborts** on a Tier-2 target: the markdown half is
genuinely useful on its own, so refusing to sync would withdraw working value
to punish a missing `package.json`.

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

### May your own code `import` from `scripts/.claude-skills/`?

**No. Treat the synced tree as a process boundary, not a library.** Call it with
`execFileSync` / `spawn`; do not `import` from it in code you own.

Asked by a consumer (2026-07-20) who wanted `assertKnownFlags` from the synced
`lib/cli-io.mjs` and instead wrote a local copy with the same signature, worried
that a re-sync could break a DB-mutating operator script. **That instinct is
right**, and the reasoning generalises:

- **The tree is gitignored and overwritten wholesale.** An `import` from it is a
  dependency on a file your repo does not track, that no reviewer sees in a diff,
  and that the next `npm run sync` can change or remove. A rename upstream
  becomes a runtime failure in *your* script, and the GC pass deletes files that
  leave our payload.
- **It is absent on a fresh clone.** Nothing under `scripts/.claude-skills/` is
  committed, so a teammate who clones and runs your script gets
  `ERR_MODULE_NOT_FOUND` until they re-run sync from the source repo. A
  process-boundary call fails the same way but *loudly and locally*, at the call
  site, rather than at module load.
- **We do not version it as an API.** The synced modules are internal to the
  skills. They carry no deprecation policy, and we change signatures freely
  because the only supported callers are our own CLIs.

So: **copy the small helper, don't link it.** A forked copy is the intended
outcome here, not a workaround — it is tracked, reviewable, and stable across
syncs. Where a copy must stay behaviour-compatible with ours, the coupling that
matters is the *detector*, not the implementation: our `check-cli-flags.mjs`
recognises a guard by the name `assertKnownFlags`, so keeping that name is what
keeps a local copy compatible.

The reverse direction is unchanged and stricter: **never edit the synced copy
itself** — that is an upstream bug, fixed upstream and re-synced (see the
governance note in [AGENTS.md](../../AGENTS.md)).

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

### Pre-push audit-hook refresh (2026-07)

If you installed the optional pre-push audit hook (`npm run hooks:install
--target <your-alias>`), **re-run it after a bundle update** to pick up the v2
plan-selection behaviour:

```bash
cd /path/to/claude-engineering-skills
npm run hooks:install -- --target <your-alias>
```

The hook is **version-stamped** (`# hook-version: N`) and the installer is
idempotent: a managed body is refreshed in place, an unmanaged (operator-authored)
pre-push hook is **refused, never clobbered**, and an already-current body is a
no-op. `npm run sync` does *not* auto-install git hooks (opt-in, per-consumer), so
this is a separate one-liner — surfaced as a reminder at the end of every sync.

**What v2 fixes**: the old body selected the newest `docs/plans/*.md` regardless
of its `Status:`, so it could re-audit a `Complete` plan on every push. v2 selects
via `check-plan-status.mjs --select` — only an *active* plan
(`Draft`/`Approved`/`In Progress`) is ever audited. A consumer that never
re-installs keeps the old behaviour — a strict improvement, never a regression.

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

## Repo-specific push gates — `.githooks/pre-push.local`

`install-prepush-hook.mjs` regenerates `.git/hooks/pre-push` **wholesale** on
every run: it writes a single `HOOK_BODY` constant and preserves nothing. A
repo-specific gate appended to that file therefore works until the next sync
and is then silently gone — the "your fix is lost, and it's invisible to
review because the hook isn't tracked" failure mode, applied to hooks.

The managed hook's last step is the sanctioned extension point:

```sh
LOCAL_HOOK=".githooks/pre-push.local"
if [ "$PREPUSH_LOCAL_DISABLE" != "1" ] && [ -f "$LOCAL_HOOK" ]; then
  sh "$LOCAL_HOOK" || exit $?
fi
```

Properties that make this the right seam:

- **Committed and reviewable.** Unlike `.git/hooks/*`, `.githooks/` is tracked,
  so a push gate is visible in review and survives a fresh clone.
- **Consumer-owned.** The installer never reads or writes it. Re-running
  `install-prepush-hook.mjs` (or a full `npm run sync`) leaves it untouched.
- **Genuinely blocking.** `|| exit $?` propagates the exit code, so a repo can
  express a hard gate — its own test suite, a schema check — without forking
  upstream tooling.
- **Bypassable the same way as everything else**: `PREPUSH_LOCAL_DISABLE=1`, or
  `git push --no-verify` for the whole chain.

Make it executable (`chmod +x`) and keep it `sh`-compatible — it is invoked via
`sh`, not bash, so it runs identically under Git Bash on Windows.

**Adopted example** — `wine-cellar-app` uses it to hold the full unit suite,
moved off `pre-commit` (which now lints staged files only). Worth copying if
your repo auto-deploys from `main`: push is the last boundary before code
leaves the machine, and it fires far less often than commit, so the gate stays
cheap enough that routing around it never becomes the rational move.
