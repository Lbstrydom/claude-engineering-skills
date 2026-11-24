---
summary: How persona-test interacts with /ship-checked, /plan, and /audit-code/audit-plan — integration contracts.
---

# Engineering Skills Interplay

persona-test integrates with the other skills in this bundle. Each contract
is optional — the skill degrades gracefully when a sibling is absent.

## /ship-checked — Pre-Push UX Gate

Before committing and pushing, `/ship-checked` surfaces unresolved persona P0s as a
non-blocking warning, via the cross-skill bridge (which holds the
service-role key — anon reads were locked down in the 20260507 RLS
hardening). The bridge resolves the repo itself (`--repo` ->
`PERSONA_TEST_REPO_NAME`, read from `.env` by the CLI -> the ambient
`git remote` identity), so `/ship-checked` runs it bare. A shell-expanded
`--repo "$PERSONA_TEST_REPO_NAME"` is what made this gate silently blind in
every consumer that had not exported the variable into its shell (measured
2026-09-07):

```bash
node scripts/cross-skill.mjs get-persona-sessions-by-repo --limit 1 --p0-only
```

Read `measured` before any count — `measured:false` means no repo resolved and
nothing was read, which is NOT "no P0s".

If recent P0s exist, `/ship-checked` adds to `status.md`:

```markdown
### UX Status
⚠ 2 unresolved P0s from persona test 3 days ago (Pieter, "adding a bottle")
Resolve before next user-facing release.
```

This is **non-blocking** — `/ship-checked` continues. The debrief (`debrief_md`) from
the most recent session can also be appended as a "User Perspective" section.

## /plan — Pre-Plan Context

When planning a new feature, `/plan` benefits from knowing what
persona tests have already found. At the start of Phase 1 (codebase
exploration) it queries via the cross-skill bridge (service-role only
post-RLS-hardening), letting the bridge resolve the repo:

```bash
node scripts/cross-skill.mjs get-persona-sessions-by-repo --limit 5 --select persona,focus,verdict,findings,debrief_md
```

Filter for sessions whose `focus` overlaps with the feature being planned.
Inject matching P0/P1 findings into the Context Summary as **known
user-visible pain points** — prevents the plan from re-solving already-known
UX problems, and raises priority on code paths persona testing has flagged
as fragile.

## /audit-code — Gemini Arbiter Context + Bandit Reward

In the final review step (Step 7), the Gemini arbiter receives a transcript
of all Claude-GPT deliberations. When the cloud store is on (`AUDIT_DB_URL`
set — persona sessions live in the same Postgres store post-M4),
`/audit-code` appends to the transcript:

```json
{
  "persona_test_context": {
    "recent_p0s": [...],
    "recurring_issues": [...],
    "last_verdict": "Needs work"
  }
}
```

This signals that code findings with confirmed user-visible symptoms should
be treated as higher-priority than theoretical concerns.

**Bandit reward augmentation**: persona-audit correlation rows (emitted by
Phase 6b — see `audit-correlation.md`) become ground-truth labels for
audit-code's Thompson Sampling. A `confirmed_hit` correlation on P0 raises
the reward for the finding's prompt variant; an `audit_missed` correlation
lowers it.

## /ux-lock — Spec the Fix

When a persona session turns up a P0 and the user fixes it, the pattern is:

1. Fix the bug in code
2. Commit the fix
3. Run `/ux-lock <commit-or-description>` to generate a Playwright regression
   spec that locks in the DOM contract the fix established

This prevents the fix from silently regressing. `/ux-lock` records
`source_kind: 'persona-test-p0'` on the generated spec so the audit trail
links back to the persona session that triggered it.

## /ship-checked — status.md Persona Section Template

When `/ship-checked` detects a recent persona session, it appends:

```markdown
### Persona Test Status — <date>
- **Last run**: <persona> on <url> (<N> days ago)
- **Verdict**: <verdict>
- **P0s**: <n> | **P1s**: <n>
- **Top finding**: <P0 or P1 description>
- **Debrief**: <first 100 words of debrief_md>...
```
