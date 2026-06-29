# Security Strategy

> Source-of-truth for proactive security memory. Indexed by
> `npm run security:refresh` into Supabase `security_incidents`, then
> consulted by `/plan` Phase 0.5c whenever planning touches paths that
> historically had security issues.
>
> **Lifecycle**: this file is created empty when the repo opts in to
> security memory and is populated incrementally by the
> `/security-strategy` skill (`bootstrap` for the threat model + first
> incidents; `add-incident` thereafter). Refresh treats it as the
> authoritative inventory of *known* incidents — anything not present
> here gets swept to `historical` on the default branch (sweep is gated
> behind a clean parse — see `scripts/security-memory/refresh-incidents.mjs`).

## Threat model

<!-- Filled in by `/security-strategy bootstrap`. Describe: who attacks
this repo, what assets matter, which trust boundaries exist, which
classes of bug are unacceptable. Keep it tight — 5–10 sentences. -->

_(no threat model recorded yet — run `/security-strategy bootstrap`)_

## Incidents

<!-- Each incident is a markdown block bounded by these EXACT HTML comment
markers (parse-strategy.mjs only recognises this form):

  <!~~ incident:start id="INC-002" ~~>
  ### Title
  **Description**: ...
  **Affected paths**: a, b
  **Mitigation**: manual
  **Lessons learned**: ...
  <!~~ incident:end ~~>

(replace ~~ with -- ; shown escaped so this comment doesn't self-close.)
Keep them in chronological order, oldest first.

Required: the `incident:start`/`incident:end` markers + every field label
MUST end with a colon (`**Description**:`) — a colon-less `**Description**`
parses as missing. Required fields: id (start marker) + Description.
Optional fields: Affected paths, Mitigation, Lessons learned.

Mitigation forms recognised by parse-strategy.mjs:
  - semgrep:my-local-rule           → semgrep/my-local-rule.yml
  - semgrep:p/owasp-top-ten         → registry ruleset
  - semgrep:r/python.lang.security…  → registry rule
  - scripts/path/to/check.mjs       → file-ref (manual verification)
  - manual                          → human-only verification
-->

<!-- incident:start id="INC-001" -->
### Symlink-bypass of sensitive-path classifier

**Description**:

The lexical sensitive-path classifier (`scripts/lib/sensitive-paths.mjs::classifyPath`)
matched on the visible string `repo/notes.txt`. A symlink whose target
resolved into `~/.ssh/id_rsa`, `secrets/db.yaml`, or any other sensitive
location was therefore not classified as sensitive — every consumer of
the classifier (egress gate, symbol indexer, audit-loop file walker)
would have read the resolved target without redaction. No live incident
was observed in production, but the class of attack was documented in
the WS3 audit cycles as a recurring HIGH finding.

**Affected paths**: `scripts/lib/sensitive-paths.mjs`,
`scripts/lib/sensitive-egress-gate.mjs`, `scripts/symbol-index/extract.mjs`.

**Mitigation**: `scripts/lib/sensitive-paths.mjs::resolveAndClassify`
calls `fs.realpathSync` on every candidate path, then RE-classifies the
canonical target. Symlinks resolving outside `repoRoot` return
`escapedRepo: true` / `category: 'sensitive'`. Broken symlinks /
unresolvable paths return `resolutionFailed: true` / `category: 'sensitive'`
(fail-closed). `gateSymbolForEgress` adopts this when its caller provides
`repoRoot` (extract.mjs already does); pre-WS-CANON lexical-only behaviour
is preserved for callers that don't yet pass `repoRoot`.

Mitigation form: `manual` (regression-locked by
`tests/sensitive-paths-canonical.test.mjs`).

**Lessons learned**:

- Path classification on lexical strings is necessary but not sufficient
  when the filesystem can rewrite a name to a different target. Anywhere
  we make a security decision based on a path, the path MUST be
  canonicalised before classification.
- The `extract.mjs::extractSymbols` body-read already used `safeReadFile`
  (which canonicalises via realpath) but `gateSymbolForEgress` saw the
  pre-resolution `rel` — a layering inconsistency that hid the issue.
  Unifying classification + read on the same canonical path closes that
  gap.
- Fail-closed on resolution errors: a missing or unresolvable target is
  treated as sensitive. Never "I couldn't classify it so I'll allow it."

<!-- incident:end -->

