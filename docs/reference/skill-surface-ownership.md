# Skill-surface ownership

**One rule, and everything else follows from it:**

> A SKILL.md is only valid alongside the runner layout it cites. Therefore skills
> install **repo-scoped**, never machine-global.

If you are here because you want to add a skill-install surface, or "fix" the
retired ones by rewriting their content — read §2 first. That fix does not work,
and the reason is structural rather than a matter of effort.

---

## 1. The two layouts

The bundle ships in exactly two shapes, and a SKILL.md's runner paths are a pure
function of which one it sits in:

| Layout | Runners live at | Who writes the skills | Rewrite |
|---|---|---|---|
| **Source repo** (`claude-engineering-skills`) | `scripts/X.mjs` | [`regenerate-skill-copies.mjs`](../../scripts/regenerate-skill-copies.mjs) → committed `.claude/skills/**` | none needed |
| **Any other repo** | `scripts/.claude-skills/X.mjs` | [`sync-to-repos.mjs`](../../scripts/sync-to-repos.mjs) | [`rewriteCommandSurface`](../../scripts/lib/sync-rewriter.mjs) |

The consumer layout exists so the bundle never collides with a consumer's own
`scripts/` directory. [`sync-path-map.mjs`](../../scripts/lib/sync-path-map.mjs)
is the single source of truth for the mapping — never hand-compute a consumer
path.

**Single-writer-per-directory.** `.claude/skills/**` in a repo has exactly one
writer: `regenerate-skill-copies.mjs` in the source repo, `sync-to-repos.mjs`
everywhere else. Two writers for one directory is the defect this page exists to
prevent.

## 2. Why a machine-global surface cannot be correct

`~/.claude/skills/` is **one directory shared by every repo on the machine**. It
is therefore layout-agnostic by construction, and no correct content for it
exists:

- `node scripts/ship-commit.mjs` is right in the source repo, wrong everywhere else.
- `node scripts/.claude-skills/ship-commit.mjs` is right in a consumer, wrong in the source repo.

Applying the sync rewriter to the global copy does not fix this. It flips which
repo is broken.

**Field evidence (2026-07).** A Claude Code session working in a consumer repo
was served the global `ship/SKILL.md`. Every runner invocation missed;
`MODULE_NOT_FOUND` was read as "the tooling is not installed"; the session
skipped its audit gates on that false premise and reported a diagnosis that was
wrong twice over. Measured at the time:

| File | `scripts/.claude-skills/` references |
|---|---|
| `~/.claude/skills/ship/SKILL.md` | **0** |
| `<consumer>/.claude/skills/ship/SKILL.md` | **20** |

The global copy even contained the sentence *"Consumer repos: the synced copy of
this file already carries the rewritten `scripts/.claude-skills/ship-commit.mjs`
path"* — while itself carrying the unrewritten one.

**It also violated this repo's own collision rule.** AGENTS.md states: *never
ship the same skill name in two discovered roots.* VS Code Copilot (1.109+)
discovers `.github/skills/`, `.claude/skills/` and `.agents/skills/` in a
workspace, plus the personal roots `~/.copilot/skills`, `~/.claude/skills` and
`~/.agents/skills` — and precedence between roots is **not documented**. Shipping
15 skills into `~/.claude/skills` while every synced consumer carried the same 15
names in `.claude/skills/` was 15 collisions with undefined resolution.

## 3. Retired surfaces

| Surface | Directory | Retired | Why |
|---|---|---|---|
| `copilot` | `.github/skills/` | 2026-07-28 | Prompt-file/skill namespace collision; see [refactor-skill-governance.md](../plans/refactor-skill-governance.md) |
| `claude` | `~/.claude/skills/` | 2026-07-30 | Layout-agnostic location for layout-dependent content (§2) |
| `agents` | `<repo>/.agents/skills/` | 2026-07-30 | Same unrewritten-path defect, plus a second discovered root duplicating every `.claude/skills/` name |
| `both` | — | 2026-07-30 | Alias for two retired surfaces |

[`resolveSkillTargets`](../../scripts/lib/install/surface-paths.mjs) **throws**
for all of them rather than returning an empty array. A silent `[]` is
indistinguishable from "this surface legitimately has zero targets", so a future
caller would inherit a silent no-op.

`install-skills.mjs` no longer installs anything. Its remaining job is
`--uninstall-legacy`.

## 4. Migrating off a retired surface

```bash
node scripts/install-skills.mjs --uninstall-legacy
```

Receipt-driven and bounded: the delete set comes from
[`inspectLegacySurfaces`](../../scripts/lib/install/legacy-surfaces.mjs), never
from reading the directory, so a skill **you** wrote in `~/.claude/skills/` is
unreachable by construction rather than by a filter. Four outcomes:

| Outcome | Meaning | Receipt after | Exit |
|---|---|---|---|
| `clean` | no receipt, or no surviving members | unchanged | 0 |
| `complete` | every member removed | removed | 0 |
| `partial` | some skipped (user-modified) or already absent | **rewritten to the survivors** | 0, each skip printed |
| `failed` | transaction error | unchanged | 1 |

A `partial` run is a **success with a report**, not a silent pass. The receipt is
rewritten rather than deleted because it is the only authoritative
bounded-membership record for the file still on disk; dropping it would orphan
that file permanently.

**Directories this run empties are removed too** (added 2026-07-30). Deleting
only the receipt-listed *files* left the tree behind — a `complete` run cleared
all 56 managed files and still left 15 empty skill skeletons, which reads as "the
cleanup did not work". This is **not** "also delete directories under the root":
the candidate set is exactly the parent of each file the transaction actually
deleted, each is removed only while it is empty, and the walk stops at the first
directory holding anything the run did not delete — a skill of yours, a member
skipped as modified, or a subdirectory that failed to prune. The surface root
itself (`~/.claude/skills/`) always survives; nothing here can prove this bundle
created it.

`.github/skills/` is **not** cleanable this way — it predates receipts, so there
is no record proving what the bundle put there, and deleting an unrecorded tree
would be exactly the unbounded enumeration the rule above forbids.
[`check-stale-skill-surface.mjs`](../../scripts/check-stale-skill-surface.mjs)
detects it and tells you to remove it by hand.

## 5. Installing

One command per audience:

| You are | Command |
|---|---|
| Adopting the bundle in any repo (or updating it) | `npx github:Lbstrydom/claude-engineering-skills <dir>` |
| Working in this repo, deploying to one other repo | `npm run sync -- --target-path <dir>` |
| The maintainer, syncing every registered consumer | `npm run sync` |

`CONSUMER_REPOS` in [`consumer-repos.mjs`](../../scripts/lib/consumer-repos.mjs)
is the maintainer's convenience list, **not** a gate on who may install.

[`install.mjs`](../../install.mjs) is a thin bootstrapper: it resolves the bundle
source from `package.json`'s `repository.url` (never from `git remote` — `npx
github:…` may run an unpacked tarball, and deriving the source from the execution
context would let whatever repo you are standing in decide what gets installed),
pins a `--ref` to an immutable SHA, caches under `~/.claude-engineering-skills/`,
and then delegates. It owns no file lists.

## 6. Editor coverage after retirement

| Editor | Reads | Covered by |
|---|---|---|
| Claude Code | project `.claude/skills/` | committed here; synced elsewhere |
| VS Code Copilot 1.109+ | `.claude/skills/` (workspace root) | same |
| Cursor | `.claude/skills/` | same |
| Windsurf | `.claude/skills/` | same |
| Any terminal | n/a | `node scripts/<runner>.mjs` here, `scripts/.claude-skills/<runner>.mjs` in a consumer |

The only case that loses skills is a repo with neither a committed nor a synced
copy — where they were **already broken**, because they cited runners that did not
exist there. No skill beats a skill that confidently names a nonexistent path;
that is what cost a session its audit gates.

---

Design record: [repo-scoped-skill-surfaces-and-installer.md](../plans/repo-scoped-skill-surfaces-and-installer.md).
