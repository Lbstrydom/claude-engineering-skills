---
name: skills
description: |
  Quick reference for every available skill in this repo — name, one-line
  purpose, triggers, usage examples — without having to open each
  individual SKILL.md document.
  Triggers on: "/skills", "list skills", "what skills do you have",
  "show all skills", "skill cheatsheet", "skills help",
  "show me the skills", "what can you do".
  Usage:
    /skills                           — Compact reference table for all skills
    /skills <name>                    — Full detail for one skill (e.g. /skills explain)
    /skills --search "<term>"         — Filter by name/description match
disable-model-invocation: true
---

# Skill Quick Reference

A discoverable, always-current reference for every skill in this bundle.
Reads directly from `skills/*​/SKILL.md` frontmatter so the listing can
never drift from reality — the same file Claude Code parses to register
each skill.

This skill itself does NOT modify code. Pure read-and-render.

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

## Step 0 — Pick the mode

| Input | Mode |
|---|---|
| `/skills` (no argument) | **List all** — compact table of every skill |
| `/skills <skill-name>` | **Detail** — full description, triggers, usage for one skill |
| `/skills --search "<term>"` | **Filter** — show only skills whose name/description/triggers/usage contain the term (case-insensitive) |

If `<skill-name>` doesn't match an existing skill, the helper suggests
near-matches. Skill names are the directory names under `skills/`
(e.g. `audit-code`, `explain`, `persona-test`).

---

## Step 1 — Invoke the helper

```bash
# List all skills
node scripts/skills-help.mjs

# Detail for one skill
node scripts/skills-help.mjs <skill-name>

# Filter by search term
node scripts/skills-help.mjs --search "<term>"
```

The helper auto-detects whether to render a compact table, a per-skill
detail block, or a filtered list, and emits Markdown by default. Output
is read-only — no files written unless `--out <path>` is passed.

---

## Step 2 — Render the result

The helper output is already Markdown. Pass it through verbatim — do
NOT re-summarise (the user asked for the reference; don't paraphrase).

If the helper exits non-zero with "skill not found", surface the
suggestion line as-is and stop.

---

## Output format reference

### Compact list

```
# Available skills (N total)

| Skill | One-liner |
|---|---|
| `/audit-code` | Iteratively audit code against a plan with GPT + Gemini final gate. |
| `/brainstorm` 🔒 | Multi-LLM concept-level brainstorming. |
| ... |

🔒 = `disable-model-invocation: true` — skill must be invoked explicitly via `/<name>`
(Claude will not auto-trigger it).
```

### Detail (e.g. `/skills explain`)

```
# /explain

Explain WHY a piece of code is structured the way it is.

**Triggers on:**
- why is this
- explain this code
- ...

**Usage:**
\`\`\`
/explain <file>                Explain the file's purpose + history
/explain --history "<topic>"   "Did we already solve this?" — cross-source search
\`\`\`

**Full SKILL.md:** `skills/explain/SKILL.md`
```

---

## When to use this vs. typing `/`

- **Type `/` in Claude** — for autocomplete on a skill you already know
  the name of (fastest single-skill lookup)
- **Run `/skills`** — when you want to discover what's available, refresh
  your memory on a skill's options, or share a quick reference with a
  teammate (the output is copy-pasteable)
- **Open the SKILL.md directly** — when you need the full "how it works"
  body (this skill only renders the frontmatter contract)

---

## Sources

- `skills/*​/SKILL.md` frontmatter — the canonical truth read by both Claude
  Code AND this helper. If `/skills` shows wrong info, the SKILL.md
  itself is wrong (not the helper).
- `.claude/skills/` mirror is intentionally ignored — that's the
  generated copy, not authoritative.

## Cost

Zero external calls. Pure local file scan. Sub-100ms even with 50+ skills.
