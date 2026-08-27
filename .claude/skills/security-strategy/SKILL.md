---
name: security-strategy
description: |
  On-demand maintenance of the per-repo security memory: bootstrap an
  initial threat model + add/append incidents to docs/security-strategy.md
  with proper marker comments, then refresh the Supabase index. NEVER
  gates planning — /plan reads the resulting memory automatically via
  Phase 0.5b.
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
`docs/security-strategy.md`. After any edit, it triggers
`npm run security:refresh --if-present` so the Supabase embedding index
stays current. `--if-present` matters here: sync never merges npm scripts
into a consumer's `package.json`, so the script can legitimately be absent
even though the markdown file exists — a bare `npm run security:refresh`
throws an avoidable `Missing script` error on such a repo.

The skill is **on-demand only** — it never blocks `/cycle`, `/plan`, or
`/ship`. The planner (Phase 0.5b) consults the memory via the cross-skill
bridge regardless of whether this skill has run recently.

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
parallel template — so changes to the template's structure (parser
sections, comment markers, header text) only need to happen in one
place and bootstrap stays automatically in sync.

If the file is already populated (the threat-model placeholder text
"_(no threat model recorded yet" is absent), ask: "File appears already
bootstrapped — overwrite the threat-model section, or skip to add-incident?"
On overwrite, take a `.bak` copy first.

Otherwise interview the user briefly:
- "What does this app/repo handle? (1-2 sentences)" → assets
- "Who is the realistic attacker model? (drive-by/insider/state-level)" → actors
- "Compliance regime that applies, if any? (PCI / GDPR / SOC2 / HIPAA / none)"
- "Top 1-2 security concerns you currently have for this repo, in plain English"

Then **read the existing checked-in template** at
`docs/security-strategy.md`, replace the `## Threat model` body
between the heading and `## Incidents` with a paragraph synthesising
the user's answers (Assets / Actors / Compliance / Concerns), and
write back via the round-trip parse + atomicWriteFileSync protocol
(R3-M4):
1. Read current file; locate `## Threat model` … `## Incidents` span.
2. Substitute the body, leave headings + the `## Incidents` placeholder
   comments untouched.
3. Pass full new content through `parseSecurityStrategy()` — assert no
   parse warnings; if any, fail loudly and don't write.
4. Call `atomicWriteFileSync('docs/security-strategy.md', content)`.

Then run `npm run security:refresh --if-present` and surface its summary line.

---

## Step 1b — ADD or ADD_FROM_COMMIT

Determine the incident's `id`: scan existing markdown for highest
`INC-NNN`, increment by 1. Pad to 3 digits (`INC-001`, `INC-002`, …).

For ADD_FROM_COMMIT: pre-fill from `git show <sha>`:
- description: commit subject line (sanitised — no AI co-authoring trailers)
- affected_paths: `git show --name-only <sha>` filtered to source files
- mitigation_ref: try to detect: if commit added a Semgrep rule under
  `semgrep/`, reference it; else "manual"
- lessons_learned: empty initially — prompt user to fill in

For interactive ADD, prompt the user for each field with examples.

**Write protocol** (R3-M4):
1. Read current `docs/security-strategy.md`.
2. Insert the new incident block at the END of the `## Incidents`
   section, BEFORE any `## Historical incidents` heading if present.
3. The block format:
   ```markdown
   <!-- incident:start id="INC-NNN" -->
   **Description**: <text>

   **Affected paths**: `<path1>`, `<path2>`

   **Mitigation**: `<semgrep:rule-id | scripts/path | manual>`

   **Lessons learned**: <text>
   <!-- incident:end -->
   ```
4. **Round-trip parse** the new full file content via
   `parseSecurityStrategy()` — assert the new entry appears in
   `incidents[]` with non-null `description` AND no parse warnings
   reference the new ID.
5. Only on round-trip success → `atomicWriteFileSync()`.
6. Run `npm run security:refresh --if-present` and surface result summary.
7. If round-trip fails → output the parsed warnings, do NOT write,
   ask the user to revise.

---

## Step 2 — Surface results

```
═══════════════════════════════════════
  /security-strategy — DONE
  Mode: <BOOTSTRAP | ADD | ADD_FROM_COMMIT>
  File: docs/security-strategy.md (<N> incidents total)
  Refresh: <upserted N, swept M, on-default-branch=Y/N>
═══════════════════════════════════════
```

If on a feature branch and the user added an incident, gently note:
"Incidents from feature branches UPSERT but don't trigger sweep — the
canonical retired-set updates when the default branch refreshes."

---

## Hard rules

- **Never write `docs/security-strategy.md` without round-trip parse first.** A malformed entry that the parser silently skips is worse than a noisy warning.
- **Never include real secrets** (API keys, passwords, payment data) in the markdown — even though `redactSecrets()` runs before egress, the markdown itself goes to PR review and git history.
- **Never inflate the threat model**. Real assets + realistic actors only. A false threat model misleads /plan worse than no threat model.
- **One incident per security-relevant fix** — not per CVE in a third-party dep, not per Dependabot bump. Genuine post-incident learning material.
