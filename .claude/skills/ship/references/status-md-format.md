---
summary: status.md session-log template + update rules + persona / UX status sections.
---

# status.md — Format & Update Rules

`status.md` is the project's append-only session log. Newest entries go
at the top. Every `/ship` run appends a new entry.

## Initial creation (first `/ship` on a repo)

When `status.md` doesn't exist, create with a header:

```markdown
# Project Status Log

## <Today's Date> — <Brief Summary of Work>

### Changes
- <Bullet list of what was done, grouped logically>

### Files Affected
- <List of key files created or modified, with one-line purpose>

### Decisions Made
- <Any architectural or design decisions taken during this session>

### Next Steps
- <What remains to be done, if anything>

---
```

## Subsequent entries — append at the TOP (below the header)

So the most recent session is always the first entry a reader sees.

### Rules for the log entry

- **Be specific** — name actual files, functions, and endpoints
- **Be concise** — this is a log, not documentation
- **Include decisions** — these are valuable context for future sessions
- **Include blockers or open questions** if any remain
- **Date format**: `YYYY-MM-DD`

## Optional sections (when data available)

### UX Status (when persona-test P0s exist)

When Step 0.5a finds recent P0s, append:

```markdown
### UX Status
⚠ 2 unresolved P0s from persona test 3 days ago (Pieter, "adding a bottle")
Resolve before next user-facing release.
```

### Persona Test Status (when recent session exists)

```markdown
### Persona Test Status — <date>
- **Last run**: <persona> on <url> (<N> days ago)
- **Verdict**: <verdict>
- **P0s**: <n> | **P1s**: <n>
- **Top finding**: <P0 or P1 description>
- **Debrief**: <first 100 words of debrief_md>...
```

### Regression Lock Status (when `missing_spec_count > 0`)

```markdown
### Regression Lock Status
⚠ <n> recent HIGH-severity fix(es) have no /ux-lock spec:
  • <primary_file>: <one-line detail>
These will silently regress under future refactors.
```

### Plan Verify Status (when a plan was verified)

```markdown
### Plan Verify Status — <plan-name>
- **Last verify**: <date> (commit <sha>)
- **Satisfaction**: <pct>% (<passed>/<total> criteria)
- **Status**: <PLAN_SATISFIED | PLAN_PARTIAL | PLAN_NOT_SHIPPED>
- **Failing P0**: <first failing criterion if any>
```

### Consumer Verification — previous ship (when `.claude/tmp/ship-verification-pending.md` exists)

Step 6.8 of a PRIOR `/ship` run wrote this file instead of amending an
already-pushed status.md entry (which would force a second commit + push —
see SKILL.md Step 6.8). Step 2 of THIS run reads it, prepends it above this
session's own entry, then deletes the file:

```markdown
### Consumer Verification (previous ship)
- **Commit**: <full sha>
- **Retrieval**: <command actually run, e.g. clone-to-tempdir + `npm run check`>
- **Result**: <verified | failed | unverified — <blocked prerequisite> if unverified>
```

## Never commit these into status.md

- Raw tool output (dumps, stack traces, lint output)
- Generated file lists longer than 20 items — summarise
- Secrets, credentials, personal data
- Speculation about "what the user probably meant"
