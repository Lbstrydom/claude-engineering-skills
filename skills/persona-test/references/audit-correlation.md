---
summary: Pre-test audit enrichment + post-test persona↔audit correlation emission — full rules.
---

# Audit Correlation Protocol

When `audit_link = true` and `repo_name` is set, persona-test reads recent
audit findings to enrich exploration, then emits correlation rows that
become ground-truth labels for the audit's bandit reward function.

This is the highest-leverage cross-skill interaction — every correlation
row shifts how the audit weights its prompt-variant selection.

## Pre-test enrichment (Phase 0d)

Fetch recent HIGH + MEDIUM findings for this repo from the audit-loop
database **through the CLI** — never hand-write a curl. The M4 migration
removed the supabase-js / PostgREST anon-read path; the CLI resolves the DSN,
joins `audit_findings → audit_runs` for this repo, and degrades to an empty
list (`cloud:false` or unknown repo) without erroring. Run it from the repo
root (the same cwd as every other `cross-skill.mjs` call):

```bash
node scripts/cross-skill.mjs get-recent-findings --limit 20
```

It resolves the **canonical repo identity from cwd** (stable `repo_uuid` →
`audit_repos.id`), so it matches the audit findings regardless of the
bare-vs-`owner/repo` display name — no `--repo` needed. (`--repo <owner/repo>`
is available only as a fallback for cross-repo queries from a non-repo cwd.)

The response is `{ ok, cloud, findings: [{ id, runId, severity, category, file,
detail, createdAt }] }`. Call `findings` the **audit candidates** set — each
row's `id` and `runId` are what post-test correlation emission points at. When
`cloud` is false or `findings` is empty, skip enrichment and proceed (no audit
context this run).

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

## Post-test correlation emission (Phase 6b — AUTOMATIC since 2026-07-13)

**This is no longer an agent-discretionary step.** `record-persona-session`
(Phase 6) runs the correlator itself, immediately after the session commits,
and writes `persona_audit_correlations` rows for every P0/P1 finding — the
classification rules and finding-hash formula below describe what the
correlator DOES, for understanding the data and for the manual-repair path;
you do not execute them by hand during a normal run. Source of truth:
[`scripts/lib/persona/audit-correlator.mjs`](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/scripts/lib/persona/audit-correlator.mjs).

### Classification rules (as implemented by the auto-correlator)

| Persona finding | Audit candidate | Severity relation | correlation_type |
|---|---|---|---|
| Overlap Coefficient ≥ 0.5 (file-path + keyword tokens) OR exact `semanticId` hit | Yes | Audit severity matches persona severity | `confirmed_hit` |
| Matches a candidate | Yes | Audit was LOW/MEDIUM, persona is P0 | `severity_understated` |
| No candidate scores ≥ threshold, but ≥1 candidate run existed | No | — | `audit_missed` |
| Zero candidate audit runs in the last 14 days (and no exact commit match) | — | — | **nothing emitted** — not evidence of a miss |

`severity_overstated` and `audit_false_positive` are **never auto-emitted** —
both require human judgment (a flagged issue that couldn't be reproduced, or
an audit finding whose severity a human judges too high) and remain
manual-CLI-only.

### Finding hash (`personaFindingHash`, matcher v1)

**Corrected 2026-07-13** — the formula below replaces an earlier, never-live
version of this doc that specified a different (and never-implemented)
`sha256(element + observed + code)` scheme. `persona_finding_hash` is
computed via the shared `semanticId()` function (the same one audit findings
use, `scripts/lib/findings.mjs`) over the real production finding shape
(`{fix, code, step, element, expected, observed, confidence}` — `code` IS the
severity, "P0".."P3"; there is no separate `category` field):

```js
semanticId({ section: finding.element, category: finding.code, detail: finding.observed })
// → 8-char hex, e.g. "f4803010"
```

Exported as `personaFindingHash(finding)` from `audit-correlator.mjs` — call
THIS function for a manual repair's hash, never hand-compute it, so it
matches the auto-emitted row byte-for-byte.

### Manual repair / reverse-direction emission

For a manual correction or an `audit_false_positive`, call the CLI directly
(graceful no-op when cloud is off):

```bash
node scripts/cross-skill.mjs record-correlation --json '{
  "personaSessionId": "<persona_session_id from Phase 6>",
  "personaFindingHash": "<personaFindingHash(finding) — see above>",
  "personaSeverity": "P0" | "P1" | "P2" | "P3",
  "auditFindingId": "<uuid from audit candidates, or null for audit_missed>",
  "auditRunId": "<uuid from audit candidate, or null>",
  "correlationType": "confirmed_hit" | "audit_missed" | "audit_false_positive" | "severity_understated" | "severity_overstated",
  "matchScore": <0.0-1.0 similarity, or omit>,
  "matchRationale": "<one-line reason: \"shared file src/routes/wines.js + keyword overlap 3/5\">"
}'
```

Supplying a real `auditFindingId` here automatically retires any stale
auto-emitted `audit_missed` row for the same `(session, hash)` pair — the
store does this in one transaction, so a repair actually repairs the ground
truth rather than leaving a contradictory second row.

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

No further work needed in this skill — `/audit-code` and `/audit-plan` pick
up the signal on their next run.
