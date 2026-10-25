/**
 * @fileoverview The ONE hand-maintained list of bundle entry points, shared by
 * `sync-to-repos.mjs` (the sync) and `sync-inventory.mjs` (the isolation
 * verifier, relocation guard and dependency derivation). Both import these
 * arrays - there is no second copy to keep in lock-step (proposal 689c: adding
 * a shipped CLI used to need two edits and failed only after a main merge).
 *
 * Leaf module: no imports, no path arithmetic, so the source-only CLI and the
 * synced library can both load it. The comments below are the authoritative
 * rationale for each entry.
 *
 * @module scripts/lib/sync-entry-lists
 */

/**
 * Core audit-runtime entry points — directly-invoked scripts + the quickfix
 * hook. Their transitive import closure is the shared core every consumer
 * repo needs.
 */
export const CORE_ENTRY = [
  'scripts/openai-audit.mjs',
  // /cycle Step 3C's per-cluster scope pre-flight. Shipped because the SKILL.md
  // that names it is synced: a documented command whose tooling is absent where
  // it runs is the shape AGENTS.md records as defect class (4).
  'scripts/cycle-cluster-scope.mjs',
  // /cycle Step 0.5's cross-plan coordination check (`--check-deps`, upstream
  // report f5ac366f) and /plan Phase 7's documented convention for declaring
  // it. Same reason as cycle-cluster-scope.mjs above: both synced SKILL.md
  // files name this command.
  'scripts/check-plan-status.mjs',
  'scripts/gemini-review.mjs',
  'scripts/bandit.mjs',
  'scripts/learning-store.mjs',
  'scripts/cross-skill.mjs',
  'scripts/phase7-check.mjs',
  'scripts/shared.mjs',
  'scripts/check-sync.mjs',
  'scripts/check-setup.mjs',
  'scripts/check-audit-tool-version.mjs',
  'scripts/cache-hitrate-check.mjs',
  // The unknown-flag gate. Shipped because the REMEDY it recommends
  // (`assertKnownFlags`, in the already-synced lib/cli-io.mjs) was reaching
  // consumers while the DIAGNOSTIC that locates their own instances was not —
  // so an adopter received the fix with no way to find what needed fixing, and
  // learned the gate existed only because a sibling repo named it (reported
  // 2026-07-20). Consumers should pass `--baseline <file>`; see the module
  // header for why the upstream baseline is wrong for them.
  'scripts/check-cli-flags.mjs',
  // Sibling of check-cli-flags: the npm `--`-swallow gate. Same reason to ship
  // it — the remedy (write `npm run x -- --flag`) is useless without the
  // DIAGNOSTIC that finds a consumer's own broken commands, and this class bit
  // the consumer that reported #57. Its BASELINE is EMPTY (not upstream-shaped),
  // so unlike check-cli-flags it needs no `--baseline <file>` to be adoptable;
  // its scope-exclusions (docs/plans, docs/research, status.md) apply verbatim
  // in a consumer. Import closure is ./lib/cli-io.mjs, already synced above.
  'scripts/check-npm-run-args.mjs',
  // Third in the same family, and the same failure: TWO synced skills instruct
  // `npm run context:check` — /ship Step 4 and every mode of
  // /ai-context-management — while the script implementing it stayed
  // source-repo-only. A consumer wired the npm script against the isolated
  // path it *should* live at, and got `Cannot find module` repo-wide (reported
  // 2026-08-11; the npm script had been dead since 2026-08-03). Adoptable
  // as-is: config (`.claude-context-allowlist.json`) is optional and the
  // defaults are topology rules, not upstream-shaped baselines — a consumer
  // that wants a different cap sets `maxAgentsMdChars` there. Import closure
  // (lib/claudemd/*, lib/markdown-fence-tracker.mjs) is walked automatically.
  'scripts/check-context-drift.mjs',
  'scripts/brainstorm-round.mjs',
  // /fleet — multi-session coordination CLI (status/claim/land). Walker pulls
  // the lib/fleet/ closure automatically; the skill names it by this path.
  'scripts/fleet.mjs',
  'scripts/explain-history.mjs',
  'scripts/skills-help.mjs',
  // One-shot fit-check diagnostic — labels each skill FITS/PARTIAL/MISMATCH
  // for the consumer's repo shape. Auto-fires once after first sync (see
  // post-sync hook); re-runnable any time as `npm run skills:fit-check`.
  // Walker pulls in the lib/fit-check/ closure automatically.
  'scripts/skills-fit-check.mjs',
  'scripts/requirements.mjs',
  'scripts/audit-metrics.mjs',
  'scripts/write-code-outcomes.mjs',
  // Assembles the final-review transcript both MANDATORY gates consume
  // (/audit-plan Step 6, /audit-code Step 7). Ships because the SKILL.md step
  // that runs it ships: a consumer reported (2026-08-08) that following the
  // skill literally died on `File not found` for a transcript no step produced,
  // and hand-assembled one instead. Walker pulls in lib/audit/transcript.mjs.
  'scripts/build-audit-transcript.mjs', 'scripts/audit-structural-card.mjs', // the card CLI the audit skills name (round cap); lock-step with sync-inventory
  // The `.audit/` sweeper. Two synced shared references (gemini-gate.md,
  // ledger-format.md) promised `.audit/` is "gitignored + swept … in this repo
  // and in every consumer" and named `npm run audit:clean` — an alias no
  // consumer has, over a script that was not shipped, so the retention window
  // those references rely on (newest 25 transcripts) held nowhere but here.
  // Dry-run by default, allowlist-only. Same defect class as the transcript
  // builder above. Keep in lock-step with lib/sync-inventory.mjs.
  'scripts/audit-clean.mjs',
  // Writes adjudication-ledger entries from a triage map (/audit-plan and
  // /audit-code Step 3.5). Replaced a heredoc recipe that imported
  // `../../scripts/shared.mjs` — a specifier the command rewriter cannot
  // relocate, so the documented step could not run in a consumer at all.
  'scripts/write-ledger-entries.mjs',
  // Step 5.0b's full-scope detector census. An ENTRY POINT nothing imports:
  // convergence.mjs takes the detector RESULT as a parameter, so the import
  // walker never reaches this file and it was absent from every consumer while
  // /audit-code told them to run it. Authoritative list here; keep
  // sync-inventory.mjs in lock-step.
  'scripts/lib/audit/detector.mjs',
  'scripts/build-dashboard.mjs',
  // postgres-parity M4 — setup CLI ships to consumer repos so downstream
  // users can apply the schema to their own DB without cloning this repo.
  // Walker pulls in the lib/db/ closure (client.mjs / query.mjs / rpc.mjs /
  // errors.mjs) automatically.
  'scripts/setup-postgres.mjs',
  // Companion diagnostic — list public tables without RLS enabled. Useful
  // for consumer repos to audit their Supabase project's exposure after a
  // migration. Same lib/db/ closure as setup-postgres.mjs.
  'scripts/check-rls.mjs',
  // Strengthen-only main-branch protection: sets "require branches up to date
  // before merging" on a consumer's EXISTING status-check ruleset, closing the
  // stale-baseline ratchet failure class. A standalone CLI nothing imports; it
  // carries --selfcheck-relocation AND is in CLI_SMOKE_SET, so it ships to
  // consumers (a cloned consumer self-applies via `npm run protect:main:apply`).
  // Walker pulls in lib/branch-protection.mjs automatically.
  'scripts/ensure-branch-protection.mjs',
  // Self-hosted-runner fallback doctor — for a consumer whose GHE org
  // disables GitHub-hosted Actions runners, tests whether THIS identity can
  // register a self-hosted runner on THIS repo and prints the choice (setup
  // recipe, or the local-maintenance-checks pre-push-hook fallback). A
  // standalone CLI nothing imports. Walker pulls in lib/runner-fallback.mjs
  // automatically.
  'scripts/actions-runner-doctor.mjs',
  // Scheduled-workflow cadence doctor — asks GitHub whether a repo's crons
  // actually ran and passed, narrowed by triggering event. A standalone CLI
  // nothing imports, so the walker cannot discover it; consumers need it
  // because a cron that stops firing is invisible everywhere else. Spawned by
  // maintenance-checks.mjs's `workflow-cadence` entry, and in CLI_SMOKE_SET.
  // Authoritative list is sync-to-repos.mjs; keep sync-inventory.mjs in lock-step.
  'scripts/workflow-cadence-doctor.mjs',
  // One-shot operator reconcile of fragmented audit_repos rows in the shared
  // store. A standalone CLI nothing imports, but it carries --selfcheck-relocation
  // AND is in the relocation guard's CLI_SMOKE_SET (which asserts consumer
  // presence) — so it MUST ship, or gate 4 fails in every consumer. The walker
  // pulls its lib/db/ closure automatically. (Was missing → both consumers
  // failed the relocation smoke; declared here to restore consistency.)
  'scripts/reconcile-repo-identity.mjs',
  // Tiered-recall shadow-validation report CLI (Close-out) — a standalone
  // operator diagnostic nothing imports, so the walker can't discover it;
  // consumers need it to read THEIR OWN .audit/tiered-shadow-log.jsonl
  // before Phase 14's production-flip decision. Also in CLI_SMOKE_SET.
  'scripts/tiered-shadow-report.mjs',
  // Deterministic /ship commit helper — validates + appends the AI-*
  // provenance trailer block and performs the commit (docs/reference/commit-provenance.md).
  // /ship SKILL.md shells it, nothing imports it. Walker pulls in
  // lib/commit-trailers.mjs (+ its sensitive-paths closure). Also in CLI_SMOKE_SET.
  'scripts/ship-commit.mjs',
  // Test-evidence record/check CLI (Cluster C); nothing imports it, so declared here. In CLI_SMOKE_SET.
  'scripts/test-evidence.mjs',
  '.claude/hooks/quickfix-scan.mjs',
  // Session-start advisory: a retired skill surface on the machine can shadow
  // the repo-scoped copy. Registered in the SYNCED .claude/settings.json, so it
  // must ship too -- it was registered everywhere and shipped nowhere until
  // 2026-08-20. Walker pulls in lib/install/legacy-surfaces.mjs.
  '.claude/hooks/legacy-surface-advisory.mjs',
  // PreToolUse Bash nudge toward the Grep tool. Zero imports, fully portable.
  // Same registered-but-unshipped bug as the advisory above.
  '.claude/hooks/bash-grep-nudge.mjs',
  // PostToolUse parse-check for edited .mjs files. Self-contained apart from
  // lib/sensitive-paths.mjs, which it resolves across BOTH tooling layouts
  // (see the hook's header). Also in sync-inventory.mjs — keep in lock-step.
  '.claude/hooks/syntax-check.mjs',
  // Persona-test consistency mode CLIs (docs/plans/persona-test-consistency-mode.md).
  // Both are user-invoked CLIs; the import-graph walker pulls in their
  // transitive lib closure (scripts/lib/persona-test/* + scripts/lib/ux-lock/*)
  // automatically.
  'scripts/persona-consistency-run.mjs',
  // Deterministic /ux-lock runner (WS2): runs authored regression/verify specs
  // and records the run rows in one deterministic call. The walker pulls in its
  // scripts/lib/playwright-runner.mjs + scripts/lib/plan-criteria-parser.mjs
  // closure automatically.
  'scripts/ux-lock-run.mjs',
  // Consumer-invoked CLI: builds a consumer's .persona-test/surfaces.json from
  // colocated *.persona-test.json fragments, validated against our
  // SurfaceManifestSchema. Lives upstream so every consumer shares one merge +
  // collision-detection + validation impl; the walker pulls in its
  // lib/persona-test/schemas.mjs import automatically.
  'scripts/build-surfaces-manifest.mjs',
  // /nav-audit CLI: static navigation / IA audit + --verify live mode. A new
  // top-level entry imported by nothing, so it must be declared here; the walker
  // pulls in its scripts/lib/nav/** closure (ast, extract, adapters/*, model,
  // findings, drift, render, verify, approot, …) automatically. `playwright` is a
  // runtime dynamic import (external pkg), so the static walker stops there.
  'scripts/nav-audit.mjs',
  // /visual-audit CLI — closure walker pulls lib/visual/** + the playwright
  // dynamic import in extract.mjs (external pkg, walker stops there).
  'scripts/visual-audit.mjs',
  // GREEN≠REALIZED Cluster A efficacy-lints CLI — closure walker pulls lib/efficacy-lints.mjs
  // + its model-resolver / glob-match / sensitive-paths closure. Lock-step with sync-inventory.mjs.
  'scripts/efficacy-lints-check.mjs',
  // Citation re-resolver — re-reads every pinned `path:line (sha)` in a document
  // at the commit it was read at and reports ok/moved/drifted/unresolvable. A new
  // top-level entry imported by nothing, so it must be declared here; the walker
  // pulls in its scripts/lib/doc-citations.mjs + lib/cli-io.mjs closure
  // automatically. It shells out to `git` with cwd = the repo root, which in a
  // consumer is that consumer's own root — the citations it checks are the
  // consumer's. Shipped 2026-08-07 AFTER the shared reference that names it had
  // already synced without it: the reference told consumers to run a script no
  // consumer layout had, which is the helper-path-drift class filed as
  // wine-cellar-app 2026-07-19 §4 and caught by /ship Step 6.8's first real run.
  'scripts/check-doc-citations.mjs',
  'scripts/sync-status.mjs', // consumer git-status ownership triage; see the file's own header
  // Local weekly-maintenance replica of the 5 GH Actions cron workflows
  // (docs/runbooks/local-maintenance-checks.md) — opt-in, default-OFF, invoked
  // opportunistically from the pre-push hook. Spawns each replicated check
  // as a subprocess, so memory-health.mjs + check-model-freshness.mjs +
  // context-staleness.mjs must ship too — none were previously an entry
  // point here (a real gap this feature closes; they were unreachable in
  // any consumer before now). context-staleness.mjs specifically was added
  // to the CHECKS list after this comment was written and never added here
  // — exactly the "silent divergence" risk the module's own header warns
  // about; caught 2026-07-22 when enabling the opt-in for the first time in
  // wine-cellar-app produced a live MODULE_NOT_FOUND.
  'scripts/maintenance-checks.mjs',
  'scripts/memory-health.mjs',
  'scripts/concern-telemetry-report.mjs', // concern-report maintenance check
  'scripts/check-model-freshness.mjs',
  'scripts/context-staleness.mjs',
  'scripts/debt-health-check.mjs',
  // Three more checks maintenance-checks.mjs spawns WITHOUT `sourceRepoOnly`,
  // so they are meant to run in a consumer. They were spawned by this synced
  // runner while declared nowhere — a MODULE_NOT_FOUND per check, the class
  // this file's comment above already records from the 2026-07-22 incident.
  // `check-accepted-debt.mjs` stays OUT deliberately (sourceRepoOnly, and its
  // registry is hardcoded to THIS repo's AGENTS.md rows).
  'scripts/debt-ledger-claims-check.mjs',
  'scripts/debt-capture-trail-check.mjs',
  'scripts/slice-recurrence-check.mjs',
  // Local-vs-store debt reconciler — consumers carry the same divergence.
  'scripts/debt-reconcile.mjs',
  // Per-ship backlog snapshot the synced /ship SKILL.md tells the operator to
  // run. Consumers carry the same standing queues, and a documented command
  // whose tooling is absent where it runs is defect class (4) in AGENTS.md.
  // Resolves its sibling readers relative to its OWN directory, so it works
  // unchanged under the consumer's scripts/.claude-skills/ layout.
  'scripts/backlog-snapshot.mjs',
  // Remediation-state verification reconciler
  // (docs/plans/remediation-state-verification-reconciler.md) — a standalone
  // CLI nothing imports, spawned as a subprocess both by
  // scripts/maintenance-checks.mjs's `remediation-reconcile` CHECKS entry
  // (same shape as its siblings just above — declare or it MODULE_NOT_FOUNDs
  // in every consumer, exactly the 2026-07-22 wine-cellar-app incident this
  // comment block already records once) and by /ship Step 0.5e's best-effort
  // capped call. The walker pulls in its scripts/lib/remediation-verification.mjs
  // + sensitive-paths.mjs + vcs.mjs closure automatically. Also in
  // CLI_SMOKE_SET (sync-isolation-verify.mjs).
  'scripts/remediation-reconcile.mjs',
  // Reached only via `await import('./lib/redact.mjs')` in cross-skill.mjs
  // + learning-store.mjs (dynamic specifier — walker cannot follow).
  // Required at runtime for candidate-write redaction.
  'scripts/lib/redact.mjs',
  // Arm-eval framework — reached only via dynamic imports in cross-skill.mjs
  // (arm-eval-run/-decision/-stats/-adjudicate/-toggle/-maybe-capture) and
  // openai-audit.mjs (toggle-aware shadow activation), so the walker cannot
  // follow. Declaring run.mjs + decision.mjs + toggle.mjs + the store lets the
  // walker pull the static closure (experiments, judge, intent-context,
  // cross-checks, plan-seed, producers/*) automatically.
  'scripts/lib/arm-eval/run.mjs',
  'scripts/lib/arm-eval/decision.mjs',
  'scripts/lib/arm-eval/toggle.mjs',
  'scripts/lib/store/arm-eval.mjs',
  // Documented injection point — consumers wire their preferred provider
  // adapter at runtime; no static caller in this repo so the walker
  // doesn't pull it in. Ship explicitly.
  'scripts/lib/persona-test/semantic-compare.mjs',
  // CLI-invoked from skills/persona-test/SKILL.md Phase 1a and
  // skills/click-test/SKILL.md Phase 3 as `node scripts/lib/device-presets.mjs
  // prep|prep-matrix ...` — bash-shelled, not statically imported, so the
  // walker cannot reach it. Required at runtime for device-profile
  // emulation (the contracts both SKILL.mds tell the LLM to consume verbatim).
  'scripts/lib/device-presets.mjs',
  // The consumer-friction doctor CLI (consumer-friction-doctor plan) — the
  // single door for every known adoption-friction failure class. A new
  // top-level entry imported by nothing, so it must be declared here; the
  // walker pulls in its lib/doctor/** closure automatically (doctor.mjs does
  // NOT itself import lib/disowned-paths.mjs — no probe needs it today).
  'scripts/doctor.mjs',
  // `ignoredUntrackedPaths`, extracted out of lib/claudemd/file-scanner.mjs so
  // the doctor and the context-drift scanner share one oracle instead of two
  // copies (D4). Declared explicitly (closes R1-H6) rather than relying on
  // file-scanner.mjs's own transitive closure (via check-context-drift.mjs,
  // already declared) to carry it — a runtime dependency this load-bearing
  // should not depend on being reached by coincidence through an unrelated entry.
  'scripts/lib/disowned-paths.mjs',
  // Loaded by .claude/hooks/legacy-surface-advisory.mjs through a COMPUTED
  // two-layout candidate path (path.join + pathToFileURL), so the static import
  // walker cannot reach it. Without this entry the hook ships but its inspector
  // does not, and loadInspector() returns null -- the advisory is silently dead,
  // which is the exact failure being fixed. Keep in lock-step across both files.
  'scripts/lib/install/legacy-surfaces.mjs',
];

/**
 * Learning + prompt-refinement entry points (full suite only).
 */
export const LEARNING_ENTRY = [
  'scripts/refine-prompts.mjs',
  'scripts/evolve-prompts.mjs',
  'scripts/meta-assess.mjs',
];

/**
 * Architectural-memory entry points (per docs/plans/architectural-memory.md):
 * ts-morph symbol extraction, dep-cruiser layering, Haiku summaries, Gemini
 * embeddings, drift sweep, retention prune, plus security-incident memory.
 *
 * Consumer needs: `dependency-cruiser` + `ts-morph` devDependencies,
 * SUPABASE_AUDIT_SERVICE_ROLE_KEY in .env, and one `npm run arch:refresh:full`
 * to populate. See the architectural-memory plan §8 Adoption.
 */
export const ARCH_ENTRY = [
  'scripts/symbol-index/extract.mjs',
  'scripts/symbol-index/summarise.mjs',
  'scripts/symbol-index/embed.mjs',
  'scripts/symbol-index/refresh.mjs',
  'scripts/symbol-index/render-mermaid.mjs',
  'scripts/symbol-index/drift.mjs',
  'scripts/symbol-index/duplicates.mjs',
  'scripts/symbol-index/prune.mjs',
  'scripts/symbol-index/spike-extract.mjs',
  'scripts/symbol-index/summarise-domains.mjs',
  'scripts/arch-intent-bootstrap.mjs',
  'scripts/security-memory/parse-strategy.mjs',
  'scripts/security-memory/incident-status.mjs',
  'scripts/security-memory/refresh-incidents.mjs',
  // arch-intent language adapters are loaded via `import(`./adapters/${k}.mjs`)`
  // in adapter-contract.mjs — a computed specifier the import-graph walker
  // cannot follow, so each adapter seeds the closure as its own entry point
  // (its transitive deps are then walked normally).
  'scripts/lib/arch-intent/adapters/js-ts.mjs',
  'scripts/lib/arch-intent/adapters/java.mjs',
  'scripts/lib/arch-intent/adapters/python.mjs',
  'scripts/lib/arch-intent/adapters/postgres.mjs',
];

/**
 * Sync-isolation infrastructure (Phase 1 of the scripts/.claude-skills/
 * isolation work). These modules ship to consumers so the verifier and
 * migration helper exist at the post-hydration path. Without this, the
 * consumer can't run `sync-isolation-verify` or `remove-legacy-synced`.
 */
export const SYNC_ISOLATION_ENTRY = [
  'scripts/lib/sync-path-map.mjs',
  'scripts/lib/sync-rewriter.mjs',
  'scripts/lib/sync-gitignore.mjs',
  // NOTE: sync-inventory.mjs intentionally OMITTED — it imports
  // consumer-repos.mjs which uses `path.resolve(import.meta.dirname, '..', '..')`
  // to find the source repo's parent directory. That's source-only logic
  // (consumers don't have ai-organiser as a sibling). The verifier's
  // --selfcheck-inventory mode is source-side only and never runs on the
  // consumer; the runtime gates use buildOwnedSourceTailsFromConsumerManifest
  // from sync-rewriter.mjs to derive ownership without source-side state.
  'scripts/lib/sync-isolation-verify.mjs',
  'scripts/lib/npm-script-enumerator.mjs',
  'scripts/lib/remove-legacy-synced.mjs',
  // Gate 2B reads the consumer's `.sync-overrides.json` so a DECLARED
  // divergence is reported as held rather than as a hash mismatch. This list
  // is hand-maintained, not a walked closure — `sync-gitignore.mjs` and
  // `npm-script-enumerator.mjs` above are here for the same reason, each an
  // import of the verifier — so an undeclared import ships a verifier that
  // dies on MODULE_NOT_FOUND in every consumer while this repo stays green.
  // That is the exact trap the CLI_SMOKE_SET note further up records happening
  // for months. Its own closure is `sync-path-map.mjs`, already listed.
  'scripts/lib/sync-overrides.mjs',
];

/**
 * Debt-tracking entry points. Universal as of 2026-07-26 — previously
 * gated to `repoName === 'wine-cellar-app'` with no rationale on record,
 * which meant ai-organiser got debt CAPTURE (openai-audit.mjs statically
 * imports lib/debt-memory.mjs, so that path is in CORE_ENTRY's closure for
 * every consumer) but none of the follow-up tooling: no debt-resolve.mjs,
 * no debt-review.mjs, no debt-budget-check.mjs. `.audit/tech-debt.json`
 * would grow there with literally no way to inspect or close an entry.
 * Phase D is a generic /audit-code feature, not wine-specific — every
 * consumer that runs /audit-code accumulates a ledger and needs this suite.
 */
export const DEBT_ENTRY = [
  'scripts/setup-permissions.mjs',
  'scripts/write-plan-outcomes.mjs',
  'scripts/write-ledger-r1.mjs',
  'scripts/debt-auto-capture.mjs',
  'scripts/debt-backfill.mjs',
  'scripts/debt-budget-check.mjs',
  'scripts/debt-pr-comment.mjs',
  'scripts/debt-resolve.mjs',
  'scripts/debt-review.mjs', 'scripts/debt-ledger-migrate.mjs', // the latter: per-entry ledger move
];

