---
summary: 'Migration guide: switch a repo from CLAUDE.md-canonical to AGENTS.md-canonical.'
---

# Canonical Flip Migration — Reference

For repos that started life with `CLAUDE.md` as the single canonical project
context (typical for Claude-only projects pre-2026). Flipping to
`AGENTS.md`-canonical lets Copilot, Cursor, Windsurf, Codex CLI, and Gemini CLI
read the same content natively without symlinks.

## When to flip

- The repo has at least one teammate using a non-Claude AI tool.
- OR the repo is being open-sourced — `AGENTS.md` is the public standard.
- OR `CLAUDE.md` is starting to drift from the README's project description
  because the audience for both is converging.

When NOT to flip:
- Solo Claude-only repo with no plans for cross-tool collaboration.
- Repo without any AI assistance at all.

## Pre-flight

```bash
ls AGENTS.md CLAUDE.md 2>&1
wc -l AGENTS.md CLAUDE.md 2>&1
git log --oneline -5 -- AGENTS.md CLAUDE.md
```

Three states:

| State | AGENTS.md | CLAUDE.md | Action |
|---|---|---|---|
| A | absent | full canonical | Flip needed |
| B | stale copy | full canonical | Flip + drift fix |
| C | full canonical | slim addendum | Already flipped — verify with `node scripts/check-context-drift.mjs --strict` |
| D | both empty | both empty | Use `/init` instead of this skill |

## Flip steps

### Step 1: write AGENTS.md from CLAUDE.md content

```bash
cp CLAUDE.md AGENTS.md
```

Then edit AGENTS.md:

1. Change first heading from `# CLAUDE.md - <project>` to `# AGENTS.md — <project>`.
2. Add a brief intro blockquote:
   ```markdown
   > **Canonical project context for all AI coding agents.** Read by Claude Code,
   > Copilot, Cursor, Windsurf, Codex CLI, Gemini CLI. Claude users — see
   > [CLAUDE.md](./CLAUDE.md) for Claude Code-specific addenda; everything below
   > is shared.
   ```
3. Remove any genuinely Claude-specific sections (move them aside for Step 2).

### Step 2: replace CLAUDE.md with a slim addendum

Replace the entire CLAUDE.md content with:

```markdown
# CLAUDE.md — Claude Code-Specific Addendum

@./AGENTS.md

> **Shared project context lives in [AGENTS.md](./AGENTS.md).** Edit shared
> rules there, not here. This file holds Claude Code-only material that
> doesn't apply to other agents.

## Claude Code-only Notes

<paste any Claude-specific sections you set aside in Step 1>
```

Target: ≤80 lines (the default `maxClaudeMdLines` cap).

### Step 3: update brief generators

Any script that reads CLAUDE.md programmatically should be updated to read
AGENTS.md first. The audit's brief generator is at
`scripts/lib/context.mjs` — its `INSTRUCTION_FILE_CANDIDATES` array determines
search order:

```javascript
const INSTRUCTION_FILE_CANDIDATES = [
  'AGENTS.md',
  'CLAUDE.md',
  'Agents.md',                           // legacy mixed-case (case-sensitive FS)
  '.github/copilot-instructions.md',
];
```

Order matters: AGENTS.md first, CLAUDE.md as fallback for legacy repos.

### Step 4: verify

```bash
node scripts/check-context-drift.mjs --strict
# Expect: "OK  No context drift detected."

git diff AGENTS.md CLAUDE.md scripts/lib/context.mjs
# Review the diff before committing
```

### Step 5: commit and push

```bash
git add AGENTS.md CLAUDE.md scripts/lib/context.mjs
git commit -m "ai-context: flip canonical from CLAUDE.md to AGENTS.md"
```

## Edge cases

### CLAUDE.md is already very short

If `wc -l CLAUDE.md` is already ≤80 lines, the file is likely already a slim
addendum. Inspect:

- If it has no `@./AGENTS.md` import → add it.
- If it has only Claude-only headings → add the import; you're done.
- If AGENTS.md is missing or empty → write AGENTS.md fresh from project
  knowledge, leave CLAUDE.md as-is plus the import.

### CLAUDE.md has Claude-only material mixed with shared content

Common case. Triage by heading:

- Headings in the default allowlist (`Slash Commands`, `Hooks`, `Memory`,
  `Local Overrides`) → keep in CLAUDE.md.
- Everything else → move to AGENTS.md.

### Subdirectory CLAUDE.md files

In monorepos, you may find `packages/foo/CLAUDE.md`. Two options:

- Convert each to a slim addendum + `@./AGENTS.md` (if you also have
  `packages/foo/AGENTS.md`).
- Or, simpler: rename `packages/foo/CLAUDE.md` to `packages/foo/AGENTS.md`
  (Copilot and Claude both auto-discover sub-directory AGENTS.md). Drop the
  CLAUDE.md.

### Tests reference CLAUDE.md content

Some tests assert specific strings in CLAUDE.md (e.g. dependency versions).
Update test fixtures to match the new layout:
- If the assertion is about shared content → check AGENTS.md.
- If the assertion is about Claude-only content → check CLAUDE.md (the slim
  version).

## Rollback

If anything goes wrong:

```bash
git checkout HEAD~1 -- AGENTS.md CLAUDE.md scripts/lib/context.mjs
```

The flip is reversible by reverting one commit.
