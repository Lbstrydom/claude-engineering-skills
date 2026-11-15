---
summary: Why v1 has no persistence, the R3-deferred v2 concerns, and the maintainer deployment recipe + acceptance checks.
---

# v1 scope, deferred v2 concerns, and deployment

## Phase 7 — Persistence (Out of Scope for v1)

Persisting click-test findings to the shared cross-skill store (so `/ship`
can surface P0s as pre-push warnings) is **deferred to v2**. The v1 skill
is authoritative purely from its local report — print, read, fix, re-run.

Why deferred:
- The required `node scripts/cross-skill.mjs record-click-test` subcommand
  doesn't exist yet, nor does the typed payload schema, table mapping,
  or `/ship` read path.
- Declaring "graceful no-op when subcommand missing" would ship a dead
  integration path that silently never works — worse than no integration.
- The local Phase 6 report covers the immediate use case (run, fix, ship).

**v2 work item** (when the integration matters): add a new
`record-click-test` subcommand with Zod-validated payload, decide table
strategy (new `click_test_runs` table vs reusing `regression_specs` with
a discriminator), update `/ship` to surface unresolved P0s, add tests.
Tracked in docs/plans/click-test-v2-persistence.md (planned) — file to be
created when v2 starts; not a v1 blocker.

## Out of Scope (v2) — deferred from R3 audit

These were raised by the GPT plan-auditor in R3. Each is a real concern,
but v1 ships without them because (a) the local Phase 6 report still
flags coverage gaps and (b) addressing them would require runner code
that doesn't exist yet (this is a skill spec, not a CLI).

| Concern | Why deferred | v2 mitigation |
|---|---|---|
| Dynamic-trigger classifier doesn't skip `Save/Submit/Publish/Apply` controls — could mutate state in `--with-modals` mode | The current safety regex catches obviously destructive labels (`delete`, `sign out`, etc.); state-changing labels are harder to enumerate without false positives. v1 is opt-in via `--with-modals` and users testing their own apps know which buttons are safe. | Extend regex + form-association classifier. Add a `--dry-run-dynamic` mode that lists triggers without clicking. |
| `routeStatus` vs `dynamicStatus` aggregation not fully specified — a route can be `scanned` while modal coverage failed | The Phase 6 verdict rules cover the headline case (any P0+gap → Broken+Incomplete). The deep ROUTE COVERAGE block can report both fields per route. | Split the model formally when implementing — `RouteResult = { routeStatus, findings, dynamicCoverage: { triggersTotal, triggersScanned, failureReasons[] } }` |
| Scanner-returned `severity` is trusted across the browser boundary — page could lie | Browser-side scanner is repo-controlled JS injected fresh each scan; a hostile page can't override it. If we run against attacker-controlled pages in v2, the runner should re-derive severity from `kind` (the kind → severity map is canonical in SKILL.md). | Re-derive `severity` runner-side using the taxonomy table; ignore the scanner's emitted severity. |
| Lossy handling of finding sets at 999-cap | Capping silently truncates evidence. v1 returns `scanner-error` for >999 to fail loudly; counts above the cap suggest the scanner needs a separate per-rule cap or the page has runaway templates worth investigating manually. | Per-rule caps (e.g. max 50 duplicate-id rows from one ID collision) + total cap. |
| Own-app classifier matches `*.local` which is reserved for mDNS — false positive risk | mDNS overlap is theoretical; in practice `*.local` in browser context means dev environments where cache-bust is safe. | Tighten classifier if we ever see a real collision. |
| `auth-required` detection runs after readiness gate — login-only routes may readiness-timeout first | Both classifications correctly indicate "could not scan", so the OVERALL verdict still becomes Incomplete. The reason differs but the outcome doesn't. | Run a quick `[type=password]` check immediately after `load`, before readiness polling. |
| Redaction boundary too narrow — only redacts `snippet`, not `selector` / `detail` | `selector` is structural (no PII expected); `detail` is composed by the scanner from rule descriptions (no user content). Genuine leakage path is `snippet`. | Audit each field; redact `detail` if/when the scanner starts interpolating page content. |
| `ready-selector` not validated for CSS-correctness | An invalid selector throws when used; we surface the error as `scanner-error` with the message. Pre-validation would duplicate the engine's selector parser. | Wrap user selector in try/catch with a clearer error message. |

## Integration (skill deployment)

This skill ships through the same auto-sync as every other skill in the
bundle. No manual file list needed:

- `scripts/sync-to-repos.mjs::buildSkillFiles()` enumerates `skills/*/` and
  picks up `skills/click-test/` automatically.
- The `.claude/skills/click-test/` mirror is regenerated on
  `npm run skills:regenerate`. Copilot discovers it natively (Agent Skills) —
  no separate prompt-shim surface (retired 2026-07-21).

Deployment recipe:

```bash
npm run skills:regenerate     # update .claude/skills/click-test/ mirror
npm run sync                  # push to every consumer repo in the registry
```

Both commands are idempotent and report drift / changed files in stderr.

### Deployment acceptance criteria

After running the recipe, verify ALL of these before declaring deployment complete:

1. `.claude/skills/click-test/SKILL.md` exists and matches `skills/click-test/SKILL.md`
   byte-for-byte (the generator copies, not re-formats).
2. `.claude/skills/click-test/references/dom-scanner.md` exists.
3. `npm run skills:check` passes (validates each reference file's `summary:`
   frontmatter byte-matches the parent SKILL.md's reference-index row).
4. For each consumer repo synced: `.claude/skills/click-test/SKILL.md`
   present at the consumer repo root.

If any of these fail, the deployment did NOT complete — fix the failure
and re-run rather than declaring partial success.

## Why the shared references are local generated copies

Phase 1 resolves its driver from `references/browser-tool-detection.md`, and
pre-authentication follows `references/auth-bootstrap.md`, both listed in the
table above. Both are **generated copies** — each one's header names the
canonical it came from (source repo only; the canonical is not synced to
consumers). Edit the canonical, never a copy. Both used to be cited across skill
boundaries as
`../persona-test/references/…`, which a packaged click-test would ship without:
`enumerateSkillFiles` walks a skill's OWN directory only, so the contract this
skill is told to obey could travel separately from the skill.
