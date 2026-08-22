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

## Diagnostics — the doctor

Hitting friction? Before reaching for any of the scattered checks below
(sync isolation, worktree preflight, setup, azure/runner doctors — each is
still documented in its own section further down), run the **one** command
that covers every known adoption-friction class:

```bash
# RECOMMENDED — pinned to an immutable commit, once you know a good one
npx github:Lbstrydom/claude-engineering-skills#<sha> doctor [target-repo]

# once hydrated — inside the consumer repo
node scripts/.claude-skills/doctor.mjs

# quick, from anywhere, no hydration needed — resolves the default branch
# TIP at request time; prefer the pinned form above once you can
npx github:Lbstrydom/claude-engineering-skills doctor [target-repo]
```

`npx` is a stage-0 bootstrap prerequisite (Node.js + npm on YOUR machine), independent of
whatever package manager the target repo itself uses (round-3 audit M2/M12) — it runs
before any target-repo package manager can even be detected. The two `node scripts/…`
forms above use whichever manager already hydrated `scripts/.claude-skills/`.

Every finding carries a `Fix:` line. Advisory by default (exit 0 — findings
are payload, not failure); pass `--gate` for a CI-style exit code, `--json`
for machine-readable output, `--only <id,id,...>` to narrow what's printed
(never what `--gate` checks), `--consumer-root <path>` to diagnose a repo
other than the one the code runs in (`install.mjs doctor <target>` always
passes this explicitly).

**Two acquisition stages, two different trust properties — this is why the
pinned form is the recommended default, not just a "security-sensitive"
footnote.** `npx github:...` fetches this installer via npx's own spec
resolution (stage 0). An UNPINNED spec (no `#<sha>`) resolves the default
branch's TIP at request time — mutable, not integrity-verified —
and `install.mjs`'s `--ref` flag cannot protect this stage at all: it is
parsed only after the code stage 0 already fetched is running. `--ref` (or
the default branch) IS then resolved to an immutable SHA before
`install.mjs` acquires the bundle `doctor.mjs` runs from (stage 1) — that
part is reproducible regardless. The `#<sha>` form pins BOTH stages at once,
using nothing but an ordinary npx capability:
`npx github:Lbstrydom/claude-engineering-skills#<sha> doctor [target-repo]`.
Prefer it whenever you can supply a known-good commit; reach for the
unpinned form only for a quick, low-stakes first look.

**Closing an upstream report** (`cross-skill.mjs upstream fix|wont-fix`)
requires `--disposition probe:<doctor-probe-id>|test:<tracked-test-path>|exempt:<reason>`
— naming the doctor probe that now detects the failure class, the
regression test that closes it, or a written reason neither applies.
Ratcheted in `npm run check` by `upstream:coverage:gate`; see
[Reporting an upstream bug](#reporting-an-upstream-bug--file-it-dont-paste-it) below.

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

### Your package manager — npm, pnpm, yarn or bun

Nothing to configure: sync detects it from your repo and uses it. Detection is
evidence-ordered — the `packageManager` field in `package.json` first (an
explicit declaration, and what corepack itself obeys), then a lockfile, then npm
as the fallback. Carrying two lockfiles is reported rather than silently
resolved, because whichever one loses is somebody's broken CI.

This matters more than it sounds. Until 2026-08-15 dependency install was
hardcoded to `npm install --save-dev`, which in a **pnpm** repo is not a slower
route to the same place:

- pnpm's `node_modules` is a symlink farm over `.pnpm/`; `npm install` writes a
  flat tree beside it and updates `package-lock.json`, which pnpm ignores.
- `pnpm-lock.yaml` is untouched, so your next `pnpm install --frozen-lockfile`
  removes what npm added.
- Under pnpm's strict layout only **direct** dependencies get a top-level entry,
  so a package npm hoisted into place stops resolving once pnpm rebuilds.

The symptom is a dependency that works locally, fails in CI, and repairs itself
on the next sync — with nothing to attribute it to.

pnpm and yarn are driven through **corepack**, which ships inside Node, so
neither has to be on your `PATH` and a pinned `packageManager` version is
honoured. It also sidesteps a Windows-only trap: `pnpm`/`yarn`/`npx` on `PATH`
are `.cmd` shims, and Node ≥ 22.19 refuses to spawn a `.cmd` without a shell
(CVE-2024-27980 hardening). The `npx` fallback for `/ux-lock`'s Playwright
runner had been dead on Windows for exactly this reason; it now uses your
manager's own fetch-and-run verb (`npx` / `pnpm dlx` / `yarn dlx` / `bun x`).

One-shot install works under any of them:

```bash
npx github:Lbstrydom/claude-engineering-skills <dir>
```

```bash
pnpm dlx github:Lbstrydom/claude-engineering-skills <dir>
```

### The three adoption tiers

**Tier 1 — full sync (consumer has `package.json` + installed deps).**
The documented default. Everything in "What gets installed where" applies;
`node scripts/.claude-skills/X.mjs` resolves the bundle's imports from the
consumer's own `node_modules`. `npm run sync` installs them for you
(`ensureAuditDeps`) — you do not maintain the list.

> **The dependency set is DERIVED, not written down.** `requiredDeps()` in
> [`scripts/lib/install/deps.mjs`](../../scripts/lib/install/deps.mjs) computes
> it from the bundle's own import closure; `OPTIONAL_DEPS` beside it is the only
> hand-curated part (a semantic judgement the graph can't make: does absence
> degrade a feature or break an import?). To see the current set:
>
> ```bash
> node -e "import('./scripts/lib/install/deps.mjs').then(m=>console.log(m.requiredDeps().join('\n')))"
> ```
>
> This used to be a hardcoded list here and in `REQUIRED_DEPS`, and it drifted:
> on 2026-07-20 the bundle imported 17 packages against 10 declared. The gap
> was invisible until a consumer hit `ERR_MODULE_NOT_FOUND` at runtime —
> `@babel/traverse` aborted `/audit-plan` in wine-cellar-app before its first
> API call (upstream#57). Do not reintroduce a copy of the list; it will rot
> the same way. `tests/install-deps-contract.test.mjs` guards the derivation.

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
| `.claude/skills/` | Skill `.md` files (Claude Code + Copilot Agent Skills read from here) | YES |
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
  `.claude/hooks/`, `.claude/settings.json`,
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

## Linked git worktrees — the tooling tree is not there

**Symptom.** Any synced command dies with a bare Node error carrying no
diagnosis:

```
Error: Cannot find module 'C:\repo\.claude\worktrees\my-branch\scripts\.claude-skills\check-context-drift.mjs'
  code: 'MODULE_NOT_FOUND'
```

**Why.** `scripts/.claude-skills/` is gitignored by design (consumers never
commit synced files), and `git worktree add` never populates ignored paths.
The tree is present in the main checkout and absent in every linked worktree.

What makes it a trap rather than an inconvenience is that **only tracked content
is guaranteed to reach a worktree**, and the bundle straddles that line.
Measured across three live worktrees of one consumer, 2026-08-13:

| worktree | `.claude/skills/` | `.claude/hooks/` (ignored half) | `scripts/.claude-skills/` |
|---|---|---|---|
| harness-created | present | present | **absent** |
| harness-created | present | present | **absent** |
| `git worktree add` by hand | absent | absent | **absent** |

Claude Code copies `.claude/` into the worktrees it creates, ignored files
included; a hand-made `git worktree add` copies nothing ignored. So in a
harness-created worktree the synced **SKILL.md arrives and the tooling it
instructs does not** — same class as the `check-cli-flags` /
`check-npm-run-args` gaps recorded above (the instruction ships, the tool does
not), on a new axis: *location* rather than bundle contents. In a hand-made
worktree neither arrives, which is less confusing but no more usable.

The design consequence, and the reason the remedy below is shaped the way it
is: **anything that has to be present in every worktree must ride on tracked
content.** `package.json` qualifies. A synced script does not, and neither does
a `.claude/` hook — which is why there is no auto-detector here. Reported by a
consumer 2026-08-13.

It affects the whole synced surface, not one script: every
`scripts/.claude-skills/*.mjs` that an npm script or a SKILL.md step names
(`check-context-drift`, `ship-commit`, `cross-skill`, `visual-audit`,
`symbol-index/*`, …). `/ship` fails on its **first** command — Phase 0's
`detect-stack` — before reaching the `context:check` most people notice.

### Do NOT sync into a worktree

`npm run sync -- --target-path <worktree>` looks like the remedy and is not.
Verified 2026-08-13 against a live consumer worktree: it aborts with
`would ABORT — 1 unowned collision(s)`, because the ownership manifest
(`scripts/.sync-manifest.json`) is itself gitignored and therefore absent
there — so **every worktree reads as a fresh repo full of unowned files**.
`--adopt-orphans` clears the abort by overwriting *tracked* files (in the
reporting consumer, a committed `.audit-loop/expected-schema.json`). Don't.

### Remedy 1 — hydrate the worktree (preferred when working there)

Copy the main checkout's tree. The destination is gitignored in the worktree
too, so nothing tracked is touched, and plain `npm run <script>` then works
unchanged — which is why this beats rewiring every npm script to be
worktree-aware.

Add one script to the consumer's `package.json`. `package.json` is tracked, so
it is present in every worktree — that is what makes this bootstrappable at all:

```json
"skills:hydrate": "node -e \"const{execFileSync}=require('node:child_process'),p=require('node:path'),f=require('node:fs');const main=p.dirname(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim());const dir='scripts/.claude-skills';const src=p.join(main,dir);if(p.resolve(dir)===p.resolve(src)){console.log('[hydrate] main checkout - nothing to do');process.exit(0)}if(!f.existsSync(src)){console.error('[hydrate] no tooling at '+src+' - re-sync the main checkout first');process.exit(1)}f.cpSync(src,dir,{recursive:true});console.log('[hydrate] copied '+src)\""
```

Then, in the worktree:

```bash
npm run skills:hydrate
```

Three properties worth knowing, each verified by running the branch:

- In the **main checkout** it is a no-op that says so — it never re-syncs, and
  never masks a stale bundle as a fresh one.
- With **no tooling in the main checkout** it exits **1** naming the path,
  rather than leaving you with a half-populated tree.
- It **copies, so it can go stale.** Re-run it in each worktree after a
  re-sync from `claude-engineering-skills`.

Node-only, single-quoted internals: it survives both `sh` and `cmd.exe`, which
a `$(…)` shell substitution in an npm script does not. It assumes the common
git dir's parent *is* the main checkout — true for a normal repo, wrong for a
bare-repo-plus-worktrees layout.

> **`node_modules` is the second gitignored absence, and hydrating does not
> cover it.** A worktree *nested* inside the checkout — which is where Claude
> Code puts them, `.claude/worktrees/<name>` — is fine: Node walks up and finds
> the main checkout's copy (`prepush-sandbox.md` §2.2). A worktree created
> OUTSIDE the tree (`git worktree add ../my-branch`) has no upward path to it,
> and the hydrated tooling then dies on `Cannot find package 'dotenv'` instead.
> Verified both ways 2026-08-13: identical commit, `npm run context:check` clean
> in the nested worktree and `ERR_MODULE_NOT_FOUND` in a `C:/tmp` one. Run
> `npm install` there, and **do not hand-link `node_modules`** — that hides the
> resolution bug from the next person.

### Remedy 2 — one-off, without hydrating

Run the main checkout's **script file** while keeping cwd in the worktree
(bash / Git Bash; not `cmd.exe`):

```bash
node "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/scripts/.claude-skills/check-context-drift.mjs" --strict
```

### The cwd trap — do not `cd` to the main checkout

Reaching for the main checkout by changing directory into it silently changes
*what is being measured or written*:

- `ship-commit.mjs` and `cross-skill.mjs` would read the main checkout's HEAD,
  branch and `commit_sha` — committing and attributing the wrong tree.
- `check-context-drift.mjs` takes its repo root from **cwd**
  (`path.resolve(args.repo || '.')`), so a clean result obtained from the main
  checkout describes the main checkout, not the branch you are shipping. Pass
  `--repo <worktree>` if you must run it from elsewhere.

**`.env` is the one thing you no longer have to `cd` for** (fixed 2026-08-15).
It is gitignored, so it exists only in the main checkout — and every CLI used to
load it with `import 'dotenv/config'`, which reads `${cwd}/.env` and nothing
else. From a worktree that found nothing, so the command ran with no
`OPENAI_API_KEY`, no `AUDIT_DB_URL`, and no error: the tell is a **failure with
zero latency**, because nothing was ever called. Entry points now import
`lib/load-env.mjs`, which walks up and then asks git for the main worktree root
(`--git-common-dir`), so the main checkout's `.env` is found from a worktree,
from a subdirectory, and from a worktree stored outside the checkout entirely.

Do not "fix" this by copying `.env` into a worktree — you get a second copy that
drifts from the first, and the copy is what a stale credential incident is made
of.

### Pre-push hooks: fail loudly, do not skip

A guard of the shape below — the natural thing to write, and present in a real
consumer's `.githooks/pre-push.local` — degrades to a **pass** in a worktree:

```sh
if [ -f "$GATE" ]; then node "$GATE" --gating || exit $?; else echo "skipped"; fi
```

The push proceeds ungated and the run reads clean. That is the sandbox-honesty
rule (AGENTS.md): a check that can go green having checked nothing needs to
fail, not skip. Resolve the gate against the common git dir, or exit non-zero
naming `npm run skills:hydrate`.

---

## Main-branch protection (baseline-ratchet safety)

**Why.** Any consumer that runs a **main-derived ratchet** — a Snyk baseline,
a schema round-trip baseline, or any status check that compares a PR against
the state on `main` — has a latent failure: a branch cut *before* the current
baseline landed on `main` fails the ratchet on **phantom findings** (findings
that already exist on `main`), even on a PR touching nothing security-related.
The fix is the native GitHub lever **"Require branches to be up to date before
merging"** (`strict_required_status_checks_policy` on the status-check ruleset
rule): it forces every PR current with `main` before checks run, so the ratchet
always compares against the landed baseline.

**Apply it.** Three invocation forms, by where you are:

```bash
# From THIS source repo (has the npm scripts) — target any repo by name:
node scripts/ensure-branch-protection.mjs --repo Lbstrydom/wine-cellar-app          # dry-run
node scripts/ensure-branch-protection.mjs --repo Lbstrydom/wine-cellar-app --apply  # write

# From this source repo against itself (npm shorthand; auto-detects origin):
npm run protect:main            # dry-run
npm run protect:main:apply      # write

# From a CONSUMER repo checkout (no npm script there — run the synced copy;
# auto-detects that repo's origin):
node scripts/.claude-skills/ensure-branch-protection.mjs            # dry-run
node scripts/.claude-skills/ensure-branch-protection.mjs --apply    # write
```

Requires the `gh` CLI authenticated with **admin** on the target repo.

**Strengthen-only, by design.** The tool sets the flag on an **existing**
status-check ruleset; it **never creates** protection where none exists. A
direct-push consumer with no PR/ratchet flow has nothing to strengthen and is
left as-is (imposing a PR workflow there is a *workflow* change, not a safety
fix). Idempotent — re-running is a no-op once strict is on. Add
`protect:main:apply` to a new consumer's adoption checklist.

> **Not automatic on `git clone`.** Server-side settings can't be applied by a
> clone — git has no post-clone hook, and a clone must not be able to silently
> change a repo's settings. So this is a **one-command setup step**, not a hook.
> Background + the general invariant: memory
> `project_baseline_ratchet_needs_branch_current`.

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

#### Keeping a *shared* fork updated — `npm run update-auditloop`

The two-line "stay updated" recipe above is the **owner's** flow: it ends in a
push to a private remote, so it belongs to whoever owns that remote. When several
people clone the fork, they need the other half — update my clone, touch no
remote — and they need it to be one command:

```bash
npm run update-auditloop
```

It fast-forwards the current branch from its configured upstream, reinstalls
dependencies when they need it, verifies the generated skills, and **never
pushes**. There is no push code in the script, and the test suite asserts that on
the commands actually issued rather than on the source reading well.

What it will not do, deliberately: it refuses a dirty tracked tree, refuses a
detached `HEAD`, and never merges, rebases, resets, stashes, or force-updates to
resolve divergence. A fork's `main` should hold no local commits; when it does,
that is a fact for a human, not something a script should quietly paper over.
Untracked and gitignored files (`.env`, `consumer-repos.local.json`, local notes)
do **not** block an update.

The dependency step runs `npm ci` — never `npm install`, which can rewrite the
lockfile and leave the tree dirty for the *next* update — under either of two
conditions: the pull changed `package.json`/`package-lock.json`, **or**
`npm ls --depth=0` reports an unhealthy tree. The second condition is the one
that matters in practice: if an earlier run fast-forwarded and then died during
install, `HEAD` is already current on the retry, so only the health check can
still spot the broken tree.

A `skills:check` failure is reported as a warning and still exits `0`. It
describes the commit you just pulled, not anything you did — report it upstream
instead of regenerating locally.

Exit codes: `0` updated (including the advisory skills warning) · `1` dirty tree,
detached `HEAD`, pull failure, or dependency failure · `2` bad arguments.

**Not the same command as `sync:refresh`** — the distinction is worth holding
onto, because both sound like "update my skills":

| | updates | use when |
|---|---|---|
| `npm run update-auditloop` | **this clone of the bundle**, from its own upstream | the bundle IS the repo (shape B) |
| `npm run sync:refresh -- --target <alias>` | a **separate product repo**, by copying the bundle into it | the skills are layered into your app (shape A) |

Teammates on a clone that predates this command need one manual bootstrap
(`git pull --ff-only && npm ci`) to acquire it; every update after that is the
one-liner.

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
| Editor config (`.vscode/mcp.json`) | same path (rewritten if it references scripts) | Yes |
| Claude Code hooks + settings (`.claude/hooks/`, `.claude/settings.json`) | same path (rewritten) | Yes |
| Per-consumer manifest (`scripts/.sync-manifest.json`) | same path; layout=`isolated` | No (gitignored 2026-07-21 — Feature B of sync-ownership-from-content.md; `sync-isolation-verify` reads it from disk) |
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

## Reporting an upstream bug — file it, don't paste it

Condensed out of AGENTS.md 2026-08-10; the governance rule ("a failure in
`scripts/.claude-skills/**` is an UPSTREAM bug — never patch the synced copy")
stays resident there.

**From the consumer:**

```bash
node scripts/.claude-skills/cross-skill.mjs upstream report --title "…" --affected-path <synced path>
```

The body goes on **stdin**. The command auto-captures the repo, the **bundle
sha**, and whether the cited path is really upstream-owned.

**From here (the source repo):** `npm run upstream:issues` to list, then
`upstream ack` / `upstream fix --commit <sha>` / `upstream wont-fix --id <id>`.
`/ship` Step 0.5h prints the open count — **advisory**: cloud state nudges, never
blocks.

Why the worksheet exists (2026-07-31): prose reports arrived with a non-existent
path, against an unknowable version, for a bug fixed the day before. The
worksheet answers "already fixed?" mechanically. Two reports sat unread on
2026-08-01, one of them already fixed 45 minutes earlier. Bodies are readable by
every repo sharing the DSN. Plan:
[`upstream-issue-reports.md`](../plans/upstream-issue-reports.md).

### Three shapes consumers keep reporting (2026-08-08)

Check for these when adding a gate or a nudge. Each is a general defect class,
not a one-off.

**(1) A read handing back a key its writer rejects.** `/ship` 0.5e listed
unclosable rows for weeks because `unremediated_acceptances` projected
`audit_finding_id` while its only closer needs `--fingerprint` — two reports, one
column. **A new close-this-row nudge means a new row in**
[`view-writer-key-contract.test.mjs`](../../tests/view-writer-key-contract.test.mjs).

**(2) A gate judging files the repo does not own.** `context:check` scanned a
vendored, gitignored `.agents/skills/**/CLAUDE.md` and exited 1 on a clean repo.
The right predicate is **ignored AND untracked**, not a longer exclusion list
(which grows per vendoring tool). Ask it of the **candidates**, never of the
repo: a whole-repo `git ls-files --others --ignored` is megabytes of
`node_modules`, ENOBUFS past `spawnSync`'s 1MiB `maxBuffer`, and a fail-open
guard reads that as "nothing disowned" — inert 2026-08-08 → 08-10, green
throughout.

**(3) A check verifying one direction only.** `sync-isolation-verify` walked
manifest→disk, so 100 orphaned executables were invisible *by construction*. Gate
**2C** now walks disk→manifest over `scripts/.claude-skills/` alone — other
directories hold consumer-owned files, and flagging those earns a bypass. Ask of
any set comparison: **which side am I iterating, and what is unrepresentable from
it?**
