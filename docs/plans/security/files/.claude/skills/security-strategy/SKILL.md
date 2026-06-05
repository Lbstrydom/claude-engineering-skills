---
name: security-strategy
description: |
  On-demand maintenance of the per-repo security memory: bootstrap an
  initial threat model + add/append incidents to docs/security-strategy.md
  with proper marker comments, then log the operation to the Postgres
  security_incident_log audit table. NEVER gates planning — /plan reads
  docs/security-strategy.md directly via Phase 0.5b.
  Triggers on: "security strategy", "add security incident", "draft
  incident", "/security-strategy", "bootstrap security memory".
  Usage:
    /security-strategy bootstrap         — interview to seed initial threat model + first incident
    /security-strategy add-incident      — interactive draft of one new incident entry
    /security-strategy add-incident from-commit <sha>  — pre-fill from commit subject + changed files
disable-model-invocation: true
---

# /security-strategy — proactive security memory maintenance

This skill maintains the **markdown source-of-truth** at
`docs/security-strategy.md`. After any edit, it logs the operation to the
Postgres `security_incident_log` table for governance and audit trail.

The skill is **on-demand only** — it never blocks `/cycle`, `/plan`, or
`/ship`. The planner (Phase 0.5b) reads `docs/security-strategy.md`
directly — no vector index needed.

---

## Step 0 — Parse Mode

| Input | Mode |
|---|---|
| `/security-strategy bootstrap` | **BOOTSTRAP** — first-time seed of threat model + optional first incident |
| `/security-strategy add-incident` | **ADD** — interactive draft of one new incident |
| `/security-strategy add-incident from-commit <sha>` | **ADD_FROM_COMMIT** — pre-fill from a security-relevant commit |

If no mode given → ask the user which one.

---

## Step 1a — BOOTSTRAP

The repo template at `docs/security-strategy.md` is the canonical
skeleton. Bootstrap fills in placeholders rather than emitting a
parallel template — so changes to the template's structure (marker
headings, comment markers) only need to happen in one place and
bootstrap stays automatically in sync.

If the file is already populated (the threat-model placeholder text
"_(no threat model recorded yet" is absent), ask: "File appears already
bootstrapped — overwrite the threat-model section, or skip to add-incident?"
On overwrite, take a `.bak` copy first.

Otherwise interview the user briefly:
- "What does this app/repo handle? (1-2 sentences)" → assets
- "Who is the realistic attacker model? (drive-by/insider/state-level)" → actors
- "Compliance regime that applies? (ISO-27001 / GDPR / NIS2 / internal-only / none)"
- "Top 1-2 security concerns you currently have for this repo, in plain English"

Then **read the existing template** at `docs/security-strategy.md`,
replace the body between `<!-- threat-model:start -->` and
`<!-- threat-model:end -->` with a paragraph synthesising the user's
answers (Assets / Actors / Compliance / Concerns), and write back:

1. Read current file; locate the `<!-- threat-model:start -->` … `<!-- threat-model:end -->` span.
2. Substitute the body, leave headings + markers untouched.
3. Re-read the written file and verify the threat-model section contains
   real content (placeholder text gone).
4. Run:
   ```
   npm run security:log -- --incident-id bootstrap --mode bootstrap \
     --classification INTERNAL --compliance-tags org-security
   ```

---

## Step 1b — ADD or ADD_FROM_COMMIT

Determine the incident's `id`: scan existing markdown for highest
`INC-NNN`, increment by 1. Pad to 3 digits (`INC-001`, `INC-002`, …).

For ADD_FROM_COMMIT: pre-fill from `git show <sha>`:
- description: commit subject line (sanitised — no AI co-authoring trailers)
- affected_paths: `git show --name-only <sha>` filtered to source files
- classification: infer from changed paths —
  `scripts/lib/db/`, auth, credentials → **CONFIDENTIAL**; else **INTERNAL**
- compliance_tags: always include `org-security`; add `org-data`
  if JSONB/PII columns changed; add `org-access` if auth paths changed
- commit_sha: `<sha>` (full 40-char SHA — REQUIRED in this mode)
- mitigation_ref: if commit added a Semgrep rule under `semgrep/`,
  reference it; else "manual"
- lessons_learned: empty initially — prompt user to fill in

For interactive ADD, prompt the user for each field with examples.

**Write protocol**:
1. Read current `docs/security-strategy.md`.
2. Insert the new incident block at the END of the `## Incidents`
   section, BEFORE `<!-- incidents-list:end -->`.
3. The block format:
   ```markdown
   <!-- incident:start id="INC-NNN" -->
   **Description**: <text>

   **Affected paths**: `<path1>`, `<path2>`

   **Classification**: INTERNAL | CONFIDENTIAL | RESTRICTED | PUBLIC

   **Compliance tags**: `org-security` [, `org-data`, `org-access`]

   **Mitigation**: `<semgrep:rule-id | scripts/path | manual>`

   **Commit**: `<full-40-char-sha>` (required for from-commit; strongly recommended for add)

   **Lessons learned**: <text>
   <!-- incident:end -->
   ```
4. **Round-trip verify**: re-read the written file and confirm
   `<!-- incident:start id="INC-NNN" -->` is present with non-empty
   Description and a valid Classification value. If check fails → do NOT
   proceed to step 5; output what is wrong and ask the user to revise.
5. Run:
   ```
   npm run security:log -- --incident-id INC-NNN \
     --mode <add|add-from-commit> \
     --classification <value> \
     --compliance-tags org-security \
     --commit-sha <sha-or-omit>
   ```
6. Check current branch — if NOT main/master, surface the branch-gate
   notice below.

**Branch-gate notice** (non-main branches):
> Draft branch: INC-NNN is recorded in the markdown but the Postgres audit
> trail marks branch=`<name>`. The incident becomes canonical once merged to main.

---

## Step 2 — Surface results

```
═══════════════════════════════════════
  /security-strategy — DONE
  Mode: <BOOTSTRAP | ADD | ADD_FROM_COMMIT>
  File: docs/security-strategy.md (<N> incidents total)
  Classification: <value>  |  Tags: <compliance_tags>
  Audit trail: Postgres security_incident_log — branch=<name>, on-main=<Y/N>
═══════════════════════════════════════
```

---

## Hard rules

- **Never write `docs/security-strategy.md` without round-trip verify first.** A malformed entry that the verify step silently misses is worse than a noisy warning.
- **Never include real secrets** (API keys, passwords, credentials) in the markdown — the file is committed to git and visible in PR reviews and history.
- **Never inflate the threat model**. Real assets + realistic actors only. A false threat model misleads /plan worse than no threat model.
- **One incident per security-relevant fix** — not per CVE in a third-party dep, not per Dependabot bump. Genuine post-incident learning material.
- **Classification defaults to INTERNAL**. Never set PUBLIC for this repo without explicit user confirmation — this is a corporate environment.
- **`commit_sha` is mandatory** for `add-from-commit` mode. For interactive `add`, prompt for it — omit only when there is genuinely no associated commit.
- **`org-security` tag is always required** in compliance_tags. Add additional tags only when clearly applicable.
- **Postgres audit trail is hard-fail on DB-unavailable**: `npm run security:log` exits non-zero (exit 1) when Postgres is unreachable — a compliance audit trail must not silently report success. The markdown write itself is the source of truth; if logging fails, surface the error and retry once Postgres is reachable. Do NOT treat a logging failure as success.
