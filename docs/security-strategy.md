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

<!-- incident:start id="INC-002" -->
### Destructive integration tests wiped the production Supabase store

**Description**:

`tests/db-setup.test.mjs` and `tests/db-withtx.test.mjs`'s integration
suites swap `process.env.AUDIT_DB_URL = AUDIT_DB_TEST_URL` for their
duration and run `DROP SCHEMA public CASCADE` in `beforeEach` to reset
between test cases. The only gate was "is `AUDIT_DB_TEST_URL` **set**" —
never "is it actually a disposable database". On 2026-07-14,
`AUDIT_DB_TEST_URL` resolved to the real production DSN when these tests
ran (the exact process that ran them was never pinned down). The shared
Supabase project (`uahjjdelnnpfmaqjrwoz`, backing all three repos —
claude-engineering-skills, wine-cellar-app, ai-organiser) was wiped from
~30 tables to a single leftover `drift_test` table. Root-caused via
Supabase's raw Postgres logs (not guessed): a clean `DROP SCHEMA CASCADE`
→ rebuild sequence matching the integration suite's own test list exactly,
cut off right after the last test created `drift_test`. Schema was restored
via `node scripts/setup-postgres.mjs --migrate` (deterministic, from
committed migrations); the underlying data — every `audit_runs`/
`audit_findings`/persona/bandit-state/tiered-shadow-observation/
`model_eval_runs` row across all three repos — is permanently lost (the
operator explicitly chose to restore the schema rather than pursue
Supabase Point-in-Time Recovery).

**Affected paths**: `tests/db-setup.test.mjs`, `tests/db-withtx.test.mjs`,
`scripts/lib/db/client.mjs`.

**Mitigation**: `scripts/lib/db/client.mjs::assertDisposableDbUrl(testUrl,
{productionUrl})` runs before any pool reset in both suites' `before()`
hooks, rejecting (a) any Supabase-hosted host (`*.supabase.co`/
`*.supabase.com` — a genuine disposable test DB is never Supabase-hosted in
this repo's design) and (b) a test URL identical to the real `AUDIT_DB_URL`
even on a non-Supabase host.

Mitigation form: `manual` (regression-locked by
`tests/db-dsn-validation.test.mjs`; live-repro-verified by re-running the
exact incident scenario post-fix — the `before()` hook now fails immediately,
zero destructive queries issued).

**Lessons learned**:

- An env-gate that checks "is this variable **set**" is not a safety gate —
  it only proves intent to run, never that the target is safe to destroy.
  Any test that runs `DROP`/`CASCADE`/schema-reset against an
  operator-supplied DSN must positively verify the DSN looks disposable
  (host pattern, or explicit non-equality with the real production DSN)
  before the first destructive statement, not just check the variable's
  presence.
- Discoverable pre-existing debt made root-causing this harder than it
  needed to be: the `debt_summary` view referenced throughout this repo's
  own tooling (`check-setup.mjs`) had never actually been captured in a
  migration — only hardcoded as a "create by hand if missing" SQL hint —
  so the schema restore silently didn't recreate it either, and both
  consumer repos' setup checks started failing on a second, unrelated gap
  the same incident exposed. Anything the setup tooling checks for should
  be a real, committed migration, not an informal hint.
<!-- incident:end -->

