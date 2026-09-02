---
summary: Per-rule severity, fix recipes, and the Claude-only heading allowlist for ctx/* rules.
---

# Drift Rules — Reference

The drift detector (`scripts/check-context-drift.mjs`) emits findings using
SARIF-shaped finding records: `{ ruleId, severity, file, line, message, semanticId }`.

## Rule catalogue

### `ctx/missing-import` — HIGH

CLAUDE.md must contain `@./AGENTS.md` (or `@AGENTS.md` / `@/AGENTS.md`) within
the first 30 lines. Without it, Claude reads only the slim addendum and misses
the shared project context.

**Fix recipe**: insert `@./AGENTS.md` on its own line near the top of CLAUDE.md,
typically immediately after the title h1 and any blockquote intro.

### `ctx/non-allowlist-heading` — HIGH

CLAUDE.md has an h2 heading that is not in the Claude-only allowlist. The
allowlist is policy: only headings that are genuinely Claude-specific belong
in CLAUDE.md.

**Default allowlist:**
- `Claude Code-only Notes`
- `Claude-only Notes`
- `Slash Commands`
- `Hooks`
- `Local Overrides`
- `Memory`
- `Memory & the \`#\`-key`

**Fix recipe**: move the offending section to AGENTS.md (preferred for shared
content), or, if it is genuinely Claude-specific, add the heading to a custom
allowlist by creating `.claude-context-allowlist.json` at repo root:

```json
{
  "allowlist": ["Claude Code-only Notes", "Claude-only Notes",
                "Slash Commands", "Hooks", "Local Overrides", "Memory",
                "My Custom Heading"]
}
```

### `ctx/shared-section-drift` — HIGH

The same `## Heading` appears in both AGENTS.md and CLAUDE.md with different
bodies. AGENTS.md wins for shared content; CLAUDE.md should not duplicate.

**Fix recipe**: delete the section from CLAUDE.md. If the CLAUDE.md version
contains a useful detail not in AGENTS.md, merge that detail into AGENTS.md
first, then delete from CLAUDE.md.

Body comparison is whitespace-tolerant (blank lines and runs of spaces are
collapsed) so cosmetic edits do not trigger findings.

### `ctx/oversized-claude-md` — MEDIUM

CLAUDE.md exceeds the size cap (default 80 lines). A slim addendum should be
≤80 lines; longer files almost always contain shared content that belongs in
AGENTS.md.

**Fix recipe**: identify the largest non-allowlisted h2 sections and move them
to AGENTS.md. To raise the cap (rare), set `maxClaudeMdLines` in
`.claude-context-allowlist.json`.

## Severity → exit code mapping

| Severity | Default exit | --strict exit |
|---|---:|---:|
| HIGH | 1 | 1 |
| MEDIUM only | 2 | 1 |
| (none) | 0 | 0 |

## Subdirectory behaviour

The detector checks `(AGENTS.md, CLAUDE.md)` pairs **per directory**. Root
`./AGENTS.md` + `./CLAUDE.md` is the typical case. In monorepos,
`packages/foo/AGENTS.md` is also auto-discovered, but a sibling
`packages/foo/CLAUDE.md` is **not** required. If a subdirectory has both,
the same rule set applies to that directory's pair.

## Customisation

Configure via `.claude-context-allowlist.json` at repo root. Schema (Zod-validated):

```json
{
  "allowlist": ["string", "string"],
  "maxClaudeMdLines": 80
}
```

In `--strict` mode (what this skill always passes), invalid config
files cause hard failure rather than silent fallback to defaults. Local
exploration runs without `--strict` and forgive malformed config with a
warning.

## Fence-awareness

Section extraction follows CommonMark fence rules: headings inside fenced code
blocks (``` or ~~~ delimited) are not parsed as document structure. Closing
fence must use the same character as opening AND have length ≥ opening length.
Tests cover ``` / ~~~ / 4-backtick / 5-backtick variants.
