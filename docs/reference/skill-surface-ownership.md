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

### Retired tooling

Retiring the surfaces stranded the tools that only described them.

| Tool | Retired | Replacement |
|---|---|---|
| `scripts/check-skill-updates.mjs` | 2026-07-30 (deleted) | see below |
| `node .audit-loop/bootstrap.mjs check` | 2026-07-30 | — (sub-command removed) |
| `scripts/lib/install/merge.mjs` | 2026-07-30 (deleted) | — (nothing writes `.github/copilot-instructions.md`) |
| `scripts/lib/install/gitignore.mjs` | 2026-07-30 (deleted) | [`sync-gitignore.mjs`](../../scripts/lib/sync-gitignore.mjs) `updateManagedBlock` |

The last two were orphaned by the retirement rather than described by it. `merge.mjs`
built a managed block for `.github/copilot-instructions.md`; nothing writes that file
now, and the block it emitted advertised two commands this table retires.
`gitignore.mjs` lost its only caller when `install.mjs` became a bootstrapper — the
managed-gitignore concern moved to the sync engine, which is §1's single-writer rule
applied to `.gitignore` as well. Both were **deleted rather than kept for reuse**: a
module with no caller cannot be shown to still work, and the next reader would have
spent their time repairing the dead commands inside them.

`check-skill-updates` hashed the files listed in an install receipt and reported
drift. Every surface that wrote a receipt is now retired, so the receipts it read
are legacy artefacts and reporting on them is
[`inspectLegacySurfaces`](../../scripts/lib/install/legacy-surfaces.mjs)' job —
the single oracle §4 describes, which the three callers share precisely so they
cannot disagree about what "still there" means.

**It was deleted rather than repointed at `scripts/.sync-manifest.json`**, which
is the tempting move: "is my synced bundle current?" is the question operators
actually have now. That question already has a complete owner —
[`sync-isolation-verify.mjs`](../../scripts/lib/sync-isolation-verify.mjs)
Gate 2B (*hydration-on-disk manifest hash check*) runs from the consumer side,
reads the consumer's own manifest as source of truth, and is itself synced to
consumers. A second answer to it would be two writers for one question, which is
the same defect as §1's two-writers-for-one-directory, one level up. Repointing
would also not have been a repoint: the tool's machinery is receipt-shaped
(per-file SHAs against a receipt, plus a `--gitignore --fix` loop), so it would
have been a rewrite into a duplicate of a tool that already exists.

So the questions split cleanly, each with one owner:

| Question | Ask |
|---|---|
| Is my synced bundle current? | `node scripts/.claude-skills/lib/sync-isolation-verify.mjs` (consumer) · `npm run sync:dry` (source) |
| Do I still have a retired surface to clean up? | `node scripts/install-skills.mjs --uninstall-legacy` |
| Is a stale `.github/skills/` shadowing my skills? | `node scripts/check-stale-skill-surface.mjs` |

## 3b. Where each check is enforced, and why the levels differ

Three questions, three enforcement levels. The level is chosen by **what kind of
state the check reads**, not by how much the answer matters:

| Check | Reads | Level | Why |
|---|---|---|---|
| A name we deploy is shadowed in `.github/skills/` or `.agents/skills/` | **repo** state | **BLOCKS** — `check-stale-skill-surface --gate` (source), `sync-to-repos` (refuses to claim a successful sync), `sync-isolation-verify` gate 8 (consumer-side, continuous) | Deterministic and fixable by changing the repo. Two developers on one commit get the same answer; CI sees it. |
| A retired surface survives in `~/.claude/skills/` | **machine** state | **ADVISORY** — [`.claude/hooks/legacy-surface-advisory.mjs`](../../.claude/hooks/legacy-surface-advisory.mjs) at session start, plus a line in `npm run check` | Not commit state. Two developers on one commit get *different* answers, CI never sees it, and blocking a push would stop unrelated work without removing the shadow. |
| A consumer's own skills collide with each other | **their** content | **REPORTED, never gated** | Not ours to police. Gating on content nobody here can act on is how a gate earns a permanent `--no-verify`. |

**The session-start advisory is the interesting one.** `npm run check` reports the
same fact, but only at PUSH time — and the harm happens at READ time, when an
agent resolves a skill from the stale root and every runner path in it is wrong
for the repo it is standing in. That is the incident that started this work: the
session concluded "the tooling is not installed" and skipped its audit gates.
Telling the operator at the end of a session they already wasted is worth little.

It fires **once per session** (sentinel keyed on `session_id` under the gitignored
`.audit/`), is **silent when clean**, costs ~100–150ms of Node startup, and never
blocks — `exit 0` on every path including malformed input. `LEGACY_SURFACE_HOOK_DISABLE=1`
opts out.

It exists even though the current bundle has no writer that can create the tree,
because that is only true of machines running current code: a developer on a
pre-2026-07-30 checkout still has the old installer and `.githooks/post-merge`,
and a `git pull` there recreates it. "Nothing can produce this state" was the same
assumption that let the original defect run undetected for months.

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

## 7. The skill-file contract on the surviving surface

Condensed out of AGENTS.md 2026-08-10; the invariants themselves stay resident
there, this is the evidence and the history.

`.claude/skills/**` is committed here and is the **single Copilot-native
surface**. `.github/skills/<name>/` was a previously-generated mirror, deprecated
in Phase 4 of ai-context-sync (at the time, no documented AI tool read it).

**Updated 2026-07-21 (Copilot-compat audit).** VS Code Copilot's Agent Skills
(GA + default-on since VS Code 1.109, Jan 2026) natively discovers THREE
workspace roots — `.github/skills/`, `.claude/skills/`, `.agents/skills/` — plus
the personal dirs `~/.copilot/skills`, `~/.claude/skills`, `~/.agents/skills`.
Collision precedence between roots is **NOT officially documented** (the earlier
"`.github/skills` wins" claim traces only to third-party sources), so the robust
rule is *never ship the same skill name in two discovered roots*.

Keeping `.github/skills` deleted stays load-bearing: a stale resurrected copy is
an undefined-behavior collision against the fresh `.claude/skills` copies. Found
live in ai-organiser 2026-07-21 — a 2025-era leftover shadowed 3 skills. Sync
deliberately never deletes it in consumers, so **check `.github/skills/` AND
`.agents/skills/` when a consumer's Copilot behaves oddly.**

### Frontmatter contract (enforced by `skills:check`)

| Field | Rule | Violation |
|---|---|---|
| `name` | must equal the directory name and match `^[a-z0-9-]{1,64}$` | **silent skip** |
| `description` | required, **max 1024 chars** | gate failure |
| trigger phrases | no two skills may advertise the same *literal* phrase | gate failure |

Keep trigger phrases in the `description`; move Usage/Examples syntax into the
SKILL body (`Full command syntax: see the Usage section in this skill.`).

**The budget half of that claim was fiction until 2026-08-04**: only `name` was
enforced (poison-tested), while `investigate` 1257 / `explain` 1152 / `ux-lock`
1062 sat over the cap with `skills:check` green — a stated-but-unenforced gate,
the class the gate-honesty suite exists to catch.
[`check-skill-descriptions.mjs`](../../scripts/check-skill-descriptions.mjs) now
enforces the budget **and** the duplicate-trigger-phrase rule (one live clash:
`"verify the plan"` in both audit-plan and ux-lock).

**Exact-match only, deliberately**: fuzzy matching was measured at 47 cross-skill
noise pairs (Jaccard ≥ 0.5, mostly one shared word) and rejected. Semantic overlap
has no oracle — declare the discriminator in BOTH descriptions instead (*topic* →
`/explain --history`, *claim* → `/investigate`).

### Adjacent editor-config surfaces

- Copilot also reads `CLAUDE.md` + `AGENTS.md` + `.github/copilot-instructions.md`
  (all default-on) — mind duplication cost when editing.
- **`.github/prompts/*.prompt.md` was RETIRED 2026-07-21**: since VS Code 1.109
  skills surface as `/name` slash commands in the SAME namespace as prompt files,
  same-basename shims collided with their own skills (and half pointed at
  non-existent CLIs). **Do not re-introduce a `.github/prompts` generator.**
- MCP: VS Code reads `.vscode/mcp.json`, **NOT** Claude's `.mcp.json` — keep the
  two mirrored when adding servers.

### `--keep-github-skills` removed entirely (2026-07-28)

From `regenerate-skill-copies.mjs`, `install-skills.mjs`, and `sync-to-repos.mjs`
alike ([refactor-skill-governance.md](../plans/refactor-skill-governance.md)).
None of the three write paths can resurrect `.github/skills/` any more;
`regenerate-skill-copies.mjs` now actively **deletes** a pre-existing tree in this
repo, and [`check-stale-skill-surface.mjs`](../../scripts/check-stale-skill-surface.mjs)
remains the drift backstop for a consumer-repo copy created by other means.

---

Design record: [repo-scoped-skill-surfaces-and-installer.md](../plans/repo-scoped-skill-surfaces-and-installer.md).
