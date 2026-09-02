---
summary: 'Step-by-step: bring drifted AGENTS.md and CLAUDE.md back into alignment safely.'
---

# Reconcile Playbook — Reference

When `node scripts/check-context-drift.mjs --strict` reports findings, follow this playbook to bring
the repo back into alignment without losing genuine content.

## Pre-flight

1. Confirm the working tree is clean enough to revert: `git status --short`.
2. Capture the current state of both files:
   ```bash
   wc -l AGENTS.md CLAUDE.md
   diff AGENTS.md CLAUDE.md | head -200
   ```
3. Capture findings: `node scripts/check-context-drift.mjs --format json > /tmp/drift.json`.

## Decision tree per finding

### `ctx/missing-import`

Single-line fix. Add `@./AGENTS.md` near the top of CLAUDE.md:

```diff
 # CLAUDE.md — Claude Addendum

+@./AGENTS.md
+
 ## Claude Code-only Notes
```

No conflict possible — apply directly.

### `ctx/non-allowlist-heading`

Three sub-cases:

1. **Section is genuinely Claude-only** (slash-command list, hook reference,
   `~/.claude/` config). Add the heading to the allowlist:
   ```json
   { "allowlist": [..., "My Heading"] }
   ```
2. **Section is shared content that drifted from AGENTS.md** — move to
   AGENTS.md if not already there, then delete from CLAUDE.md.
3. **Section is shared content NOT in AGENTS.md** — first move it to
   AGENTS.md (preserve content), then delete from CLAUDE.md.

### `ctx/shared-section-drift`

Same h2 heading exists in both files with different bodies. The auditor's
job is preserving information, not just clearing the warning:

1. Compare the two bodies side by side: `diff <(grep -A 50 '## Heading' AGENTS.md) <(grep -A 50 '## Heading' CLAUDE.md)`
2. Pick the canonical version (usually AGENTS.md is most-recent if it was
   updated as part of normal content edits; CLAUDE.md is most-recent if a
   developer added shared content in the wrong file).
3. If CLAUDE.md has details AGENTS.md lacks, merge them into AGENTS.md first.
4. Delete the section from CLAUDE.md.

### `ctx/oversized-claude-md`

Indicates accumulated drift. Run the per-finding flow for every non-allowlist
heading first; the size finding usually resolves automatically once the
shared-content sections are extracted.

If still oversized after moving shared content, inspect the remaining
allowlisted content — it may have been over-elaborated. Slim where possible,
or raise `maxClaudeMdLines` if the content is genuinely necessary.

## Conflict resolution

When CLAUDE.md and AGENTS.md both have the same heading and **both have valuable
content not in the other**, this is a merge conflict, not drift. Resolve manually:

1. Open both files in a diff viewer.
2. Compose the merged section in AGENTS.md (canonical destination).
3. Delete the heading from CLAUDE.md.
4. Verify with `node scripts/check-context-drift.mjs --strict`.

## Verification

After applying changes:

```bash
node scripts/check-context-drift.mjs --strict
# Expect: "OK  No context drift detected." with exit 0
```

If still failing, the diff is partial. Re-run `--format json` to see what
remains.

## Rollback

Reconciliation only edits markdown files. To revert:

```bash
git checkout HEAD -- AGENTS.md CLAUDE.md
```

No loss of behaviour — the underlying scripts are unchanged.
