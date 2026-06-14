---
summary: Pre-test audit enrichment + post-test persona↔audit correlation emission — full rules.
---

# Audit-Loop Correlation Protocol

When `audit_link = true` and `repo_name` is set, persona-test reads recent
audit findings to enrich exploration, then emits correlation rows that
become ground-truth labels for audit-loop's bandit reward function.

This is the highest-leverage cross-skill interaction — every correlation
row shifts how audit-loop weights its prompt-variant selection.

## Pre-test enrichment (Phase 0d)

Fetch recent HIGH + MEDIUM findings for this repo from the audit-loop
database **through the CLI** — never hand-write a curl. The M4 migration
removed the supabase-js / PostgREST anon-read path; the CLI resolves the DSN,
joins `audit_findings → audit_runs` for this repo, and degrades to an empty
list (`cloud:false` or unknown repo) without erroring:

```bash
node scripts/cross-skill.mjs get-recent-findings --repo "$PERSONA_TEST_REPO_NAME" --limit 20
```

The response is `{ ok, cloud, findings: [{ id, runId, severity, category, file,
detail, createdAt }] }`. Call `findings` the **audit candidates** set — each
row's `id` and `runId` are what post-test correlation emission points at. When
`cloud` is false or `findings` is empty, skip enrichment and proceed (no audit
context this run).

> **Repo-name match matters.** `--repo` must be the name the **audit loop**
> registered the repo under (git-remote `owner/repo`, e.g.
> `Lbstrydom/wine-cellar-app`), which can differ from a bare
> `PERSONA_TEST_REPO_NAME`. If this returns empty while you know audits exist,
> that bare-vs-`owner/repo` mismatch is the cause — it's the known
> repo-identity-fragmentation issue tracked in the learning-store signal-
> recovery work, not a fault in this call. Pass the `owner/repo` form to match.

Add a **Known Code Fragilities** section to the persona mental model in
Phase 2 (after the main profile):

```
Known code fragilities (from recent audit):
  • src/routes/wines.js — missing error handling on POST (audit HIGH, Apr 13)
  • src/services/wine/sourceEnrichment.js — incorrect db.prepare() usage (audit HIGH, Apr 13)
  [etc.]
```

**How this enriches exploration**: the persona doesn't mechanically target
these files — but knowing the code is fragile in certain areas biases the
Reflect step to look harder for symptoms in those flows. A persona exploring
"add a wine" naturally hits wines.js; knowing it has a recent HIGH means a
hang or silent failure should be flagged with higher confidence.

**Important**: do not mention "the code has a bug here" to the persona —
they wouldn't know that. Let the fragility knowledge sharpen your Reflect
judgement silently.

## Post-test correlation emission (Phase 6b)

For every P0 or P1 persona finding, classify its relationship to an audit
candidate and emit a correlation row.

### Classification rules

| Persona finding | Audit candidate | Severity relation | correlation_type |
|---|---|---|---|
| Matches file/keywords in a candidate | Yes | Audit severity matches persona severity | `confirmed_hit` |
| Matches a candidate | Yes | Audit was LOW/MEDIUM, persona is P0/P1 | `severity_understated` |
| Matches a candidate | Yes | Audit was HIGH, persona is P2/P3 | `severity_overstated` |
| No file/keyword match to any candidate | No | — | `audit_missed` |

If an earlier audit explicitly **dismissed** a finding that the persona is
now hitting, emit `audit_missed` — the dismissal was premature.

### Finding hash

Compute a stable hash of the persona finding so the same observation
dedupes across sessions:

```
sha256(element + '|' + observed.slice(0,120) + '|' + code).slice(0,16)
```

### Emit

For each P0/P1 finding, call the CLI (graceful no-op when cloud is off):

```bash
node scripts/cross-skill.mjs record-correlation --json '{
  "personaSessionId": "<persona_session_id from Phase 6>",
  "personaFindingHash": "<hash>",
  "personaSeverity": "P0" | "P1" | "P2" | "P3",
  "auditFindingId": "<uuid from audit candidates, or null for audit_missed>",
  "auditRunId": "<uuid from audit candidate, or null>",
  "correlationType": "confirmed_hit" | "audit_missed" | "audit_false_positive" | "severity_understated" | "severity_overstated",
  "matchScore": <0.0-1.0 similarity>,
  "matchRationale": "<one-line reason: \"shared file src/routes/wines.js + keyword overlap 3/5\">"
}'
```

### Reverse direction — audit false positives

For any audit candidate that was **not** matched by any persona finding
but covered a user-facing code path the persona *should* have encountered
(based on its focus area), emit `audit_false_positive` with:

- `auditFindingId` set to the candidate's id
- `personaFindingHash` set to a synthetic `"noop-<audit_id>"` hash

Be conservative — only emit when the persona clearly walked the code path
(you saw the element/flow, but nothing went wrong).

## What happens downstream

The rows immediately feed the `audit_effectiveness` view and the
`computeReward` function in `scripts/bandit.mjs`:

| correlation_type | Reward for the audit finding |
|---|---|
| `confirmed_hit` | 1.0 × persona-severity weight |
| `severity_understated` | 0.9 × persona-severity weight |
| `severity_overstated` | 0.3 × persona-severity weight |
| `audit_false_positive` | 0.0 (strong negative) |
| `audit_missed` | 0.0 (pass-level negative pressure) |

Persona severity weight: P0=1.0, P1=0.85, P2=0.6, P3=0.4.

No further work needed in this skill — `/audit-loop` picks up the signal
on its next run.
