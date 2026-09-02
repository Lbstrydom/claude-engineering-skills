---
name: ai-context-management
description: |
  Manage AGENTS.md and CLAUDE.md alignment across a repo so Claude, Copilot,
  Cursor, Windsurf, and other AI agents share the same project context.
  Detects drift, reconciles manually-introduced divergence, and migrates legacy
  CLAUDE.md-canonical repos to AGENTS.md-canonical.
  Triggers on: "audit AGENTS.md", "check context drift", "AGENTS.md vs CLAUDE.md",
  "fix context drift", "migrate to AGENTS.md",
  "context sync", "what tools read which file", "ai-context-management".
  Usage: /ai-context-management audit          — Score drift + report findings
  Usage: /ai-context-management reconcile      — Apply patches to fix drift
  Usage: /ai-context-management migrate        — Flip legacy repo to AGENTS.md canonical
---

# AI Context Management

Keep `AGENTS.md` (canonical, shared) and `CLAUDE.md` (slim, Claude-only addendum)
aligned across a repo, so Claude, Copilot (which reads `.claude/skills` +
`AGENTS.md` natively), and other agents share one project context.

**Input**: `$ARGUMENTS` — `audit | reconcile | migrate`
(plus optional `--repo <path>` for cross-repo invocation).

<!-- host-contract: input-acquisition; grammar=subcommand; empty=default -->

**Where `$ARGUMENTS` comes from** — orchestrator-supplied input first, else
the host's verbatim invocation suffix, else the span of the user's **current**
message naming this skill or its subject. Never inferred from surrounding
conversation. This site is `subcommand`; on empty input, default to `audit` — it is read-only and writes nothing, so it is the safe default. `reconcile` and `migrate` write files and are never defaulted into.
Full contract: `references/input-acquisition.md`.


> **Worktree preflight** — in a linked git worktree the synced tooling tree
> `scripts/.claude-skills/` is absent — it is gitignored, so `git worktree add`
> does not populate it, and every command below that uses it dies on a bare
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first.
>
> If this repo defines no such script, it has not adopted the remedy yet. Add
> this entry to its `package.json` `scripts` and run it — it copies the tooling
> tree in from the main checkout, and leans on nothing but node and git:
>
> "skills:hydrate": "node -e \"const{execFileSync}=require('node:child_process'),p=require('node:path'),f=require('node:fs');const main=p.dirname(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim());const dir='scripts/.claude-skills';const src=p.join(main,dir);if(p.resolve(dir)===p.resolve(src)){console.log('[hydrate] main checkout - nothing to do');process.exit(0)}if(!f.existsSync(src)){console.error('[hydrate] no tooling at '+src+' - re-sync the main checkout first');process.exit(1)}f.cpSync(src,dir,{recursive:true});console.log('[hydrate] copied '+src)\""
>
> Rationale (source repo only — `docs/runbooks/` is not synced to consumers):
> `docs/runbooks/consumer-adoption.md` §"Linked git worktrees".

---

## Step 0 — Parse Mode

| Input | Mode | Effect |
|---|---|---|
| `audit` | AUDIT | Run `node scripts/check-context-drift.mjs --strict`; report findings; no writes |
| `reconcile` | RECONCILE | Detect drift, propose patch, apply after confirmation |
| `migrate` | MIGRATE | Convert legacy CLAUDE.md-canonical → AGENTS.md-canonical |
| (no args) | AUDIT | Default to audit |

For `reconcile` and `migrate`, **never write files without user confirmation** —
present the proposed patch first, ask for `apply` / `cancel`, then act.

---

## Step 1 — AUDIT Mode

Run the drift detector and summarise findings.

```bash
node scripts/check-context-drift.mjs --strict 2>&1
```

Exit codes: `0` = no findings, `1` = HIGH (blocking), `2` = MEDIUM only.

For each finding, show:
- Rule ID (e.g. `ctx/missing-import`)
- Severity (HIGH / MEDIUM)
- File and line
- Single-sentence why-it-matters (from the rule's documentation)

Detailed rule reference + severity rubric: `references/drift-rules.md`.

---

## Step 2 — RECONCILE Mode

Goal: bring `AGENTS.md` and `CLAUDE.md` into alignment, preserving any genuine
Claude-only content in CLAUDE.md.

Steps:

1. Run `node scripts/check-context-drift.mjs --format json > .audit/drift.json` to get structured findings.
2. For each finding:
   - `ctx/missing-import` → propose adding `@./AGENTS.md` near top of CLAUDE.md.
   - `ctx/non-allowlist-heading` → propose moving the section to AGENTS.md and removing from CLAUDE.md.
   - `ctx/shared-section-drift` → propose deleting from CLAUDE.md (AGENTS.md wins for shared content).
   - `ctx/oversized-claude-md` → identify the largest non-allowlisted sections; propose moving them.
3. Show a unified diff of proposed changes.
4. Wait for `apply` confirmation.
5. Apply via Edit tool.
6. Re-run `node scripts/check-context-drift.mjs --strict` to confirm green.

Full step-by-step playbook with conflict resolution: `references/reconcile-playbook.md`.

---

## Step 3 — MIGRATE Mode

For repos that currently use `CLAUDE.md` as the canonical project context (legacy
single-file pattern). Flips to `AGENTS.md`-canonical so the wider AI ecosystem
(Copilot, Cursor, Windsurf, Codex) reads the same content.

Steps:

1. Detect current state:
   - `AGENTS.md` exists? Drift vs CLAUDE.md?
   - `CLAUDE.md` is canonical (full content) vs slim addendum?
2. If `CLAUDE.md` is canonical and `AGENTS.md` is missing/drifted:
   - Propose: copy CLAUDE.md → AGENTS.md (rename heading)
   - Propose: replace CLAUDE.md with `@./AGENTS.md` import + Claude-only addendum
3. Show diff. Wait for confirmation. Apply.
4. Run `node scripts/check-context-drift.mjs --strict` to verify alignment.
5. Update brief generators that read CLAUDE.md to also/preferably read AGENTS.md
   (see `scripts/lib/context.mjs` `INSTRUCTION_FILE_CANDIDATES` for the pattern).

Migration playbook with edge cases: `references/canonical-flip.md`.

---

## Step 4 — Status Card

After every mode, emit a compact status card:

```
═══════════════════════════════════════
  AI-CONTEXT-MANAGEMENT — <MODE> — Done
  HIGH: 0  MEDIUM: 0  Files updated: 2
  AGENTS.md: 349 lines  CLAUDE.md: 41 lines
  Next: node scripts/check-context-drift.mjs --strict (verify) | git diff (review)
═══════════════════════════════════════
```

---

## Key Principles

1. **AGENTS.md is canonical** — shared content lives there; CLAUDE.md is a slim
   addendum that imports it. Reverse only for legacy single-file Claude-only repos.
2. **Never write without confirmation** in `reconcile` and `migrate` modes —
   show the diff first.
3. **Preserve Claude-only content** — items in the allowlist (`Slash Commands`,
   `Hooks`, `Memory`, `Local Overrides`, `Claude-only Notes`, etc.) stay in
   CLAUDE.md.
4. **Subdirectory AGENTS.md is fine** — for monorepos. No sibling CLAUDE.md
   required at sub-paths.
5. **Drift detection runs on every push** — in the source repo the detector runs
   from the pre-push hook (as part of its `npm run check`), not from CI. A
   consumer wires it into its own pre-push if it wants the same gate. The
   `.github/workflows/context-drift.yml` workflow was retired in `c12e2178`
   along with the other push-triggered check workflows.

---

## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/input-acquisition.md` | Where a skill's arguments come from on any host, and what to do when there are none. | Reading $ARGUMENTS on a host that does not substitute it, or deciding what empty input means at a site. |
| `references/drift-rules.md` | Per-rule severity, fix recipes, and the Claude-only heading allowlist for ctx/* rules. | A finding's rule ID is unfamiliar, OR you need to extend the allowlist for a custom heading. |
| `references/reconcile-playbook.md` | Step-by-step: bring drifted AGENTS.md and CLAUDE.md back into alignment safely. | RECONCILE mode is firing AND a finding has competing edits in both files. |
| `references/canonical-flip.md` | Migration guide: switch a repo from CLAUDE.md-canonical to AGENTS.md-canonical. | MIGRATE mode is firing on a legacy single-file repo. |
| `examples/slim-claude-md.md` | Canonical 30-line CLAUDE.md template after AGENTS.md flip. | Producing a slim CLAUDE.md from scratch in MIGRATE mode. |
| `examples/well-formed-agents-md.md` | 100-150 line AGENTS.md exemplar with reasoned rules and standard sections. | A repo has no AGENTS.md and you're producing one from project knowledge. |
| `examples/monorepo-layout.md` | Root + per-package AGENTS.md layout for monorepos. | The repo has multiple packages and you're deciding where AGENTS.md goes. |
