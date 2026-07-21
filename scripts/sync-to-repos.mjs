#!/usr/bin/env node
/**
 * @fileoverview Sync canonical audit-loop scripts + SKILL.md files from this
 * source repo to consumer repos (wine-cellar-app, ai-organiser).
 *
 * Sync is one-directional: source (claude-audit-loop) → targets.
 * Files that don't exist in the target are created; existing files are overwritten.
 * Wine-cellar-app-specific or ai-organiser-specific scripts are never touched.
 *
 * Usage:
 *   node scripts/sync-to-repos.mjs               # sync all repos
 *   node scripts/sync-to-repos.mjs --dry-run      # show what would change, no writes
 *   node scripts/sync-to-repos.mjs --target wine  # sync wine-cellar-app only
 *   node scripts/sync-to-repos.mjs --target ai    # sync ai-organiser only
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { enumerateSkillFiles, listSkillNames } from './lib/skill-packaging.mjs';
import { ensureAuditDeps } from './lib/install/deps.mjs';
import { CONSUMER_REPOS } from './lib/consumer-repos.mjs';
import { writeManifest, detectOwnershipRegression } from './lib/sync-manifest.mjs';
import { collectImportClosure } from './lib/module-graph.mjs';
import { assertRepoRoot } from './lib/assert-repo-root.mjs';
import { sourceRelToDestRel, LAYOUT_CONSTANTS } from './lib/sync-path-map.mjs';
import { rewriteCommandSurface, buildOwnedSourceTails } from './lib/sync-rewriter.mjs';
import { injectUpstreamBanner, BANNER_BODY } from './lib/sync-banner.mjs';
import { classifyOwnership, describeEvidence } from './lib/sync-ownership.mjs';
import { updateManagedBlock, parseGitignoreState } from './lib/sync-gitignore.mjs';
import { untrackNewlyIgnored } from './lib/sync-untrack.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
// Reused rather than re-parsed: env-setting owns .env key resolution (dotenv's
// last-wins semantics included), and it is pure — the caller supplies the text.
import { resolveEnvValue } from './lib/env-setting.mjs';

// `.audit/` is OURS, entirely — the directory name is our invention and only
// our tooling writes there (~30 distinct named paths, plus every skill
// invocation's `--out .audit/<session>-…` artifacts: transcripts, ledgers,
// patches, stderr logs). So the honest rule is the DIRECTORY, not a list of
// filenames.
//
// It used to be a filename enumeration, and that could not work: this repo's
// OWN `.gitignore` had grown to ~44 `.audit/…` patterns while the consumer
// block carried 2 — two divergent, both-incomplete descriptions of one set.
// Consumers nagged about whichever artifact nobody had thought to add yet
// (`plan-fp-patterns.json` was the one that surfaced it). Enumerating a set
// that grows every time a skill writes a new output file is a treadmill, and
// losing that race is silent.
//
// Contrast `.audit-loop/`, which stays PRECISE below: consumers legitimately
// TRACK `.audit-loop/migrations/*.sql`, so a blanket dir there would be wrong.
// The asymmetry is the point — `.audit/` has no tracked-artifact contract.
const MANAGED_IGNORE_PATTERNS = [
  // Generated ephemera our synced tooling produces in consumers (Category A;
  // never committed). Precise paths — NOT blanket dirs — because `dashboard/`
  // and `logs/` are names a consumer plausibly owns too. `.audit/` below is the
  // opposite case and is treated accordingly.
  'dashboard/index.html',
  'dashboard/telemetry.html',
  '.brainstorm/',
  '.skills-fit-check.json',
  'logs/mcp-*.log',
  'logs/mcp-*.log.gz',
  '.audit/',                          // ALL audit-loop runtime output (see above)
  '.audit-loop/*-observed.json',      // domain-deps / nav-graph / visual observed envelopes
  '.audit-loop/*-verify-result.json', // nav-audit / visual-audit --verify results
  '.audit-loop/*-drift-ledger.json',  // nav / visual local drift caches
  '.audit-loop/arm-eval-toggle.json', // per-repo experiment toggle (operator state, timestamped)
  '.audit-loop/last-maintenance.json', // local weekly-maintenance heartbeat (timestamped, regenerated per run)
  '.audit-loop/last-maintenance.log', // backgrounded opportunistic-run output (round-4 Gemini gate G2 fix)
  '.audit-loop/.maintenance.lock', // single-instance lock (round-4 Gemini gate G2 fix)
  // The rendered architecture map is Category A (this source repo gitignored it
  // 2026-07-20): it renders from the CLOUD symbol_index with a timestamp + commit
  // sha + refresh_id header and 33 LLM-written domain summaries, so two renders of
  // one commit are never byte-identical — every `arch:render` is a large
  // non-deterministic diff carrying no information. Ignore-only (safe: a gitignore
  // rule never touches an already-tracked file); deliberately NOT added to the
  // destructive UNTRACK_PATTERNS below — a consumer that already tracks it must be
  // untracked by an explicit per-repo human decision, never silently on sync.
  'docs/architecture-map.md',
  // The consumer sync manifest — Feature B of docs/plans/sync-ownership-from-content.md,
  // deferred there ("leave it tracked for now; revisit if the churn proves annoying,
  // and verify Gates 2A/6 first"). Both preconditions are now met: it re-dirties on
  // every sync (timestamp + commitSha), and sync-isolation-verify Gates 2A (only
  // checks scripts/.claude-skills/) and 6 (reads manifest.layout from disk) neither
  // assert it is TRACKED — the verifier reads the manifest from disk, regenerated by
  // every sync. Ownership no longer depends on it (moved to content-derived banners),
  // and tracking is precisely what exposed it to the merge-divergence footgun. Ignore-
  // only, NOT in UNTRACK_PATTERNS: an already-tracking consumer is untracked by an
  // explicit per-repo decision, never silently on sync (this was committed by DESIGN,
  // not by mistake). The SOURCE repo already gitignores its own copy.
  'scripts/.sync-manifest.json',
  // arm-eval session/worksheet exports. In THIS source repo docs/arm-eval/sessions/
  // is a *tracked* auditable experiment record; in a CONSUMER these are just local
  // runtime exports (the authoritative capture is the cloud arm_eval_* tables), so
  // they must be ignored or they nag as untracked. Flat-file globs (files are
  // timestamp-named directly under each dir) so git AND the untrack matcher — which
  // supports single-segment `*` only, no trailing-`/` dir markers — both handle them.
  'docs/arm-eval/sessions/*',
  'docs/arm-eval/worksheets/*',
];

// The allow-list for the post-sync self-heal, which runs `git rm --cached`.
// DELIBERATELY NARROW, and deliberately NOT the same list as the ignore block
// above — they are two different contracts that merely used to share a value:
//
//   ignore  = "don't nag about this"        — safe to be broad; a .gitignore
//             rule has no effect on an already-tracked file, so widening it
//             can't destroy anything.
//   untrack = "remove this from the index"  — DESTRUCTIVE, and it acts on
//             exactly the already-tracked files the ignore rule cannot touch.
//
// Widening them together is what makes broadening dangerous. Verified: a
// consumer TRACKS 8 committed files under `.audit/` (persona session captures,
// `tech-debt.json`) — deliberately kept records, not runtime churn. Had this
// list inherited the blanket `.audit/`, the next sync would have silently
// `git rm --cached`-ed all 8. Untracking someone's committed data is not sync
// bookkeeping; it needs an explicit human decision, per-file.
//
// So: add an entry here ONLY for an artifact that is unambiguously ours AND
// was demonstrably committed by mistake. Never mirror the ignore list.
const UNTRACK_PATTERNS = [
  '.audit/cache-metrics.jsonl',       // openai-audit.mjs cache hit-rate log
  '.audit/tiered-shadow-log.jsonl',   // tiered-recall shadow-validation log
  '.audit-loop/*-observed.json',
  '.audit-loop/*-verify-result.json',
  '.audit-loop/*-drift-ledger.json',
  '.audit-loop/arm-eval-toggle.json',
  '.audit-loop/last-maintenance.json',
  '.audit-loop/last-maintenance.log',
  '.audit-loop/.maintenance.lock',
  'dashboard/index.html',
  'dashboard/telemetry.html',
  '.skills-fit-check.json',
  'docs/arm-eval/sessions/*',
  'docs/arm-eval/worksheets/*',
];

const DRY_RUN = process.argv.includes('--dry-run');
const KEEP_GITHUB_SKILLS = process.argv.includes('--keep-github-skills');
const NO_PROMPT = process.argv.includes('--no-prompt');
// Recovery escape hatch for orphaned ownership records: adopt files that sit at
// a destination we intend to write but are absent from the consumer's manifest.
// Deliberately opt-in and never default — the collision guard it relaxes is the
// only thing standing between a sync and a consumer's own file. See the ABORT
// branch below for why an orphan can exist at all.
const ADOPT_ORPHANS = process.argv.includes('--adopt-orphans');

// The single banner line used as an ownership fingerprint when adopting
// orphans. `BANNER_BODY` is an ARRAY of lines — passing it straight to
// `String.includes` coerces it to a comma-joined string that never matches, so
// every synced file would falsely report "no banner". A safety signal that
// fails toward "suspicious" is still a lying diagnostic; normalise here and
// pin it in tests/sync-ownership-recording.test.mjs.
const BANNER_MARKER = Array.isArray(BANNER_BODY) ? BANNER_BODY[0] : String(BANNER_BODY);
const targetFilter = (() => {
  const idx = process.argv.indexOf('--target');
  return idx === -1 ? null : process.argv[idx + 1];
})();

const SOURCE_ROOT = path.resolve(import.meta.dirname, '..');

// ANSI colours
const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

// ── Canonical file sets ────────────────────────────────────────────────────
//
// The audit-loop deployment is NOT a hand-maintained file list. Each bundle
// declares only its ENTRY POINTS — scripts invoked directly (CLIs, hooks)
// plus the few modules reached solely via a *computed* dynamic import, which
// static analysis cannot follow. Every lib/* dependency is auto-resolved by
// walking the ESM import graph (see resolveBundle / collectImportClosure).
//
// Why: a new lib module imported by a synced script used to need a manual
// CORE_SCRIPTS entry, or the consumer repo broke at runtime with
// ERR_MODULE_NOT_FOUND. The walker eliminates that drift — the first static
// or string-literal `import` of a module pulls it into every bundle that
// reaches it, with no edit here.
//
// ASSETS are non-importable leaves (read via fs, or generated): they carry
// no import edges, so the walker cannot discover them — listed explicitly.

/**
 * Core audit-runtime entry points — directly-invoked scripts + the quickfix
 * hook. Their transitive import closure is the shared core every consumer
 * repo needs.
 */
const CORE_ENTRY = [
  'scripts/openai-audit.mjs',
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
  'scripts/brainstorm-round.mjs',
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
  '.claude/hooks/quickfix-scan.mjs',
  // Persona-test consistency mode CLIs (docs/plans/persona-test-consistency-mode.md).
  // Both are user-invoked CLIs; the import-graph walker pulls in their
  // transitive lib closure (scripts/lib/persona-test/* + scripts/lib/ux-lock/*)
  // automatically.
  'scripts/persona-consistency-run.mjs',
  'scripts/persona-consistency-promote.mjs',
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
  // Local weekly-maintenance replica of the 5 GH Actions cron workflows
  // (docs/runbooks/local-maintenance-checks.md) — opt-in, default-OFF, invoked
  // opportunistically from the pre-push hook. Spawns each replicated check
  // as a subprocess, so memory-health.mjs + check-model-freshness.mjs must
  // ship too — neither was previously an entry point here (a real gap this
  // feature closes; they were unreachable in any consumer before now).
  'scripts/maintenance-checks.mjs',
  'scripts/memory-health.mjs',
  'scripts/check-model-freshness.mjs',
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
];

/**
 * Non-importable core assets — read via fs or generated, never `import`ed,
 * so the import-graph walker cannot reach them.
 */
const CORE_ASSETS = [
  // Regenerated at the start of every `npm run sync` (see writeManifest);
  // consumer repos read it to detect stale audit-tool files vs upstream.
  'scripts/.sync-manifest.json',
  // fs-read by lib/dashboard/collect-reference.mjs (flows.json) and
  // lib/dashboard/load-assets.mjs (css/js) — never imported.
  'scripts/lib/dashboard/flows.json',
  'scripts/lib/dashboard/assets/dashboard.css',
  'scripts/lib/dashboard/assets/dashboard.js',
  // Authoritative HTML-attribute contract for persona-test consistency mode.
  // Referenced by skills/persona-test/SKILL.md Phase 3b + references/consistency-mode.md;
  // consumer-app frontend devs read it to author their data-engine-* annotations.
  'docs/reference/consistency-contract.md',
  // Tiered-pipeline OSS call budgets. `lib/oss-call-policy.mjs` reads this via
  // `new URL('./oss-call-policy.json', import.meta.url)` — a module-relative fs
  // read, so the import walker never sees it and it did not ship. The reader
  // deliberately THROWS rather than falling back to a default budget, so in a
  // consumer the tiered shadow died with
  // `[oss-call-policy] failed to read .../scripts/.claude-skills/lib/oss-call-policy.json: ENOENT`
  // and every affected run recorded `fallback_legacy` — 15 wasted observations
  // in the Phase-14 window before the cause was traced (2026-07-18).
  'scripts/lib/oss-call-policy.json',
  // postgres-parity M4 — setup-postgres.mjs reads compat-bootstrap.sql via
  // fs (the import-graph walker can't follow fs reads). Migrations are
  // similarly fs-read; ship the whole directory so `--migrate` works on
  // consumer repos without them needing this repo cloned.
  'scripts/lib/db/compat-bootstrap.sql',
  // `--adopt`'s schema contract. Same fs-read blind spot as the two above, but
  // it failed differently: `runAdopt` hard-aborts at its entrypoint when the
  // manifest is missing, so `--adopt` — the documented one-time bootstrap for a
  // pre-provisioned DB — could not run in ANY consumer repo. It lives under
  // `tests/fixtures/` here because that is where it is generated and asserted;
  // for a consumer it is pure runtime. The sync loop remaps it to
  // `.audit-loop/expected-schema.json` via sync-path-map.
  'tests/fixtures/expected-schema.json',
  ...syncMigrations(),
];

/**
 * Enumerate `supabase/migrations/*.sql` at sync time so newly-added
 * migrations ship to consumer repos automatically. Returns an empty
 * array if the directory doesn't exist (graceful — running in a
 * non-canonical repo).
 *
 * Important — destination path is `.audit-loop/migrations/<f>` in the
 * consumer repo, NOT `supabase/migrations/<f>`. This isolates audit-loop
 * infrastructure migrations from any consumer-app Supabase product
 * migrations: a careless `supabase db push` from the consumer won't pick
 * them up and apply them against the wrong Supabase project (see
 * `reference_supabase_project.md` — audit-loop uses a dedicated project).
 * The src path remap is handled by the sync loop (search for
 * `.audit-loop/migrations` in the loop body).
 */
function syncMigrations() {
  const dir = path.join(SOURCE_ROOT, 'supabase', 'migrations');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => `supabase/migrations/${f}`);
  } catch {
    return [];
  }
}

/**
 * Learning + prompt-refinement entry points (full suite only).
 */
const LEARNING_ENTRY = [
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
const ARCH_ENTRY = [
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
const SYNC_ISOLATION_ENTRY = [
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
];

/**
 * Debt-tracking entry points (full suite only).
 */
const DEBT_ENTRY = [
  'scripts/setup-permissions.mjs',
  'scripts/write-plan-outcomes.mjs',
  'scripts/write-ledger-r1.mjs',
  'scripts/debt-auto-capture.mjs',
  'scripts/debt-backfill.mjs',
  'scripts/debt-budget-check.mjs',
  'scripts/debt-pr-comment.mjs',
  'scripts/debt-resolve.mjs',
  'scripts/debt-review.mjs',
];

// ── Import-graph resolution ────────────────────────────────────────────────

/**
 * Build the repo-relative path universe under scripts/ and .claude/ — the
 * file set `resolveSpecifier` probes for extension/index resolution.
 * @param {string} root
 * @returns {Set<string>}
 */
function buildFileUniverse(root) {
  const out = new Set();
  const SKIP = new Set(['node_modules', '.git', '.audit', '.audit-loop']);
  const walk = (dir, base) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else out.add(rel);
    }
  };
  for (const top of ['scripts', '.claude']) {
    const dir = path.join(root, top);
    if (fs.existsSync(dir)) walk(dir, top);
  }
  return out;
}

const FILE_UNIVERSE = buildFileUniverse(SOURCE_ROOT);
const readSource = (rel) => {
  try { return fs.readFileSync(path.join(SOURCE_ROOT, rel), 'utf-8'); }
  catch { return null; }
};

/**
 * Resolve a bundle to its full file list: the transitive import closure of
 * its entry points, plus its non-importable assets.
 * @param {string[]} entryPoints
 * @param {string[]} [assets]
 * @returns {{files: string[], unresolved: Array<{from:string,specifier:string}>}}
 */
function resolveBundle(entryPoints, assets = []) {
  const { files, unresolved } = collectImportClosure({
    entryPoints, repoFiles: FILE_UNIVERSE, readFile: readSource,
  });
  return { files: [...new Set([...files, ...assets])], unresolved };
}

/**
 * `unresolved` entries worth surfacing — a path-like specifier that didn't
 * resolve to a repo file is a genuinely missing dependency. Specifiers
 * carrying `${`, backticks or whitespace are template-literal parser noise
 * (a regex catching a string fragment of source) and are filtered out.
 * @param {Array<{from:string,specifier:string}>} unresolved
 * @returns {Array<{from:string,specifier:string}>}
 */
function realMissingDeps(unresolved) {
  return (unresolved || []).filter(u =>
    !/[\s`${}]/.test(u.specifier)
    && (u.specifier.startsWith('./') || u.specifier.startsWith('../'))
  );
}

/**
 * Skill files synced to Claude Code (.claude/skills/). Phase B.2: replaced
 * the hardcoded SKILL.md list with allowlist-based enumeration — new skills
 * + references/ + examples/ auto-register without editing this file.
 *
 * Phase 4 of ai-context-sync: dropped the .github/skills/ surface from the
 * default since no documented tool reads it. Pass --keep-github-skills to
 * keep mirroring during the deprecation window (one minor release).
 */
function buildSkillFiles() {
  const out = [];
  const skillsDir = path.join(SOURCE_ROOT, 'skills');
  for (const name of listSkillNames(skillsDir)) {
    const skillDir = path.join(skillsDir, name);
    const files = enumerateSkillFiles(skillDir, { strict: true });
    for (const rel of files) {
      out.push(`.claude/skills/${name}/${rel}`);
      if (KEEP_GITHUB_SKILLS) out.push(`.github/skills/${name}/${rel}`);
    }
  }
  return out;
}
const SKILL_FILES = buildSkillFiles();


/** Editor config files — MCP server wiring for VSCode Copilot Chat */
const EDITOR_FILES = [
  '.vscode/mcp.json',
];

/**
 * Claude Code project hooks + settings. The arch-memory-check hook
 * auto-fires the architectural-memory pre-fix consultation on every
 * UserPromptSubmit when an intent verb is detected. Settings are
 * deep-merged into the consumer's existing .claude/settings.json (so
 * local permissions/dirs are preserved) — only the `hooks` key is
 * added/updated.
 */
const CLAUDE_CODE_FILES = [
  '.claude/hooks/arch-memory-check.sh',
  '.claude/settings.json',
];

// ── Repo configuration ─────────────────────────────────────────────────────

// Non-code surfaces — skills, editor + Claude Code config. Not importable,
// so appended after the import-graph closure. (The .github/prompts/ Copilot
// prompt-shim surface was RETIRED 2026-07-21: Copilot Agent Skills are GA and
// read .claude/skills natively, and since VS Code 1.109 skills surface as
// /name slash commands in the SAME namespace as prompt files — same-basename
// shims collided with their own skills. See the Copilot-compat audit.)
const NON_CODE_FILES = [
  ...SKILL_FILES, ...EDITOR_FILES, ...CLAUDE_CODE_FILES,
];

/**
 * Compute the synced file list for one consumer repo: the import-graph
 * closure of its entry-point bundles + core assets + non-code surfaces.
 * wine-cellar-app gets the debt suite; ai-organiser does not.
 *
 * Repo identity (name/alias/path) lives in lib/consumer-repos.mjs as the
 * single source of truth — only the file-set composition is sync-specific.
 *
 * @param {string} repoName
 * @returns {{files: string[], unresolved: Array<{from:string,specifier:string}>}}
 */
function bundleForRepo(repoName) {
  const entries = [
    ...CORE_ENTRY, ...LEARNING_ENTRY, ...ARCH_ENTRY, ...SYNC_ISOLATION_ENTRY,
    ...(repoName === 'wine-cellar-app' ? DEBT_ENTRY : []),
  ];
  const { files, unresolved } = resolveBundle(entries, CORE_ASSETS);
  return { files: [...files, ...NON_CODE_FILES], unresolved };
}

export const REPOS = CONSUMER_REPOS.map(r => {
  const { files, unresolved } = bundleForRepo(r.name);
  return { ...r, files, unresolved };
});

// ── Helpers ────────────────────────────────────────────────────────────────

function sha256(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

function unifiedDiff(srcPath, dstPath, relFile) {
  try {
    // Use git diff --no-index for a proper unified diff
    const result = execSync(
      `git diff --no-index --unified=3 "${dstPath}" "${srcPath}"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return result;
  } catch (err) {
    // git diff --no-index exits 1 when files differ (that's normal)
    if (err.stdout) return err.stdout;
    return `  (diff unavailable: ${err.message})`;
  }
}

// ── Helpers (continued) ───────────────────────────────────────────────────

/**
 * Deep merge two plain objects. Source keys overwrite target keys at every
 * level. Arrays are replaced (not concatenated). Non-object values use source.
 * Used to safely sync JSON config files without destroying local additions.
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)
        && typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

/**
 * Classify a consumer's adoption tier by whether it can RUN the `.mjs` half.
 *
 * The bundle ships two independent halves: `.claude/skills/**` (markdown, read
 * directly by Claude Code, needs no runtime) and `scripts/.claude-skills/**`
 * (`.mjs`, whose imports resolve from the CONSUMER's own node_modules — the
 * exact set is derived by `requiredDeps()` in lib/install/deps.mjs, never
 * listed by hand here; an inline list is what drifted in upstream#57). A
 * consumer with no package.json is a
 * legitimate adopter of the first half only: the target language is irrelevant
 * to the skills' value (a Python diff audits as well as a TS one), but the
 * tooling half still needs a runtime.
 *
 * Deliberately advisory, never fatal — see the caller.
 *
 * @param {string} repoPath Consumer repo root.
 * @returns {{tier: 1|2, hasPackageJson: boolean, hasNodeModules: boolean}}
 */
function classifyConsumerRuntime(repoPath) {
  const hasPackageJson = fs.existsSync(path.join(repoPath, 'package.json'));
  const hasNodeModules = fs.existsSync(path.join(repoPath, 'node_modules'));
  return { tier: hasPackageJson ? 1 : 2, hasPackageJson, hasNodeModules };
}

/**
 * Does this consumer run the Azure profile with no embedding deployment pinned?
 *
 * The gap this closes (2026-07-20): `azure:doctor` has always been able to probe
 * a resource and lock in its real deployment name, but nothing ever POINTED at
 * it, so every new Azure consumer rediscovered the need the same way — an opaque
 * 400 on the first embedding call, or a `check-setup` warning they had to run
 * separately. Adoption time is when the operator can act on it.
 *
 * Deliberately advisory and OFFLINE. It does not run the probe:
 *   - the probe is a network call authenticated as the CONSUMER; sync
 *     distributes files and should not hold another repo's credentials.
 *   - `azure-doctor`'s `.env` containment guard is rooted at `process.cwd()`,
 *     so writing a consumer's file means spawning with that cwd — fine as an
 *     operator-chosen command, wrong as a silent side effect of `npm run sync`.
 *
 * @param {string} repoPath Consumer repo root.
 * @returns {{actionable: boolean}}
 */
function assessConsumerAzureEmbed(repoPath) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(repoPath, '.env'), 'utf-8');
  } catch {
    return { actionable: false };   // no .env → nothing configured to advise on
  }
  // fileValue ONLY — never liveValue. `resolveEnvValue` also reports this
  // (source) process's env, and the source machine exporting AZURE_OPENAI_*
  // would otherwise make every consumer look Azure-active.
  const read = (key) => {
    const raw = resolveEnvValue(key, { envFileText: text }).fileValue;
    return String(raw ?? '').trim().replace(/^["']|["']$/g, '').trim();
  };
  // Mirrors config.mjs's predicate exactly: absent, empty and whitespace-only
  // all collapse to "not set", so this advice and the runtime agree.
  return { actionable: read('AZURE_OPENAI_ENDPOINT') !== '' && read('AZURE_OPENAI_EMBED_DEPLOYMENT') === '' };
}

/**
 * Every flag this CLI reads. Kept adjacent to `main()` rather than beside the
 * `process.argv.includes` constants because those are module-scope and evaluate
 * on IMPORT — throwing there would break the test that imports this module for
 * its exports.
 *
 * `--target` takes a value; `assertKnownFlags` validates NAMES only, so the
 * value is a bare positional it ignores by design.
 */
const KNOWN_FLAGS = ['--dry-run', '--keep-github-skills', '--no-prompt', '--adopt-orphans', '--target'];

async function main() {
  // This CLI WRITES INTO CONSUMER REPOS and its default is the real sync, so a
  // dropped `--dry-runn` is the exact opt-out shape that caused the three
  // incidents in check-cli-flags.mjs's header. It was unguarded until
  // 2026-07-20 and had additionally gone INVISIBLE to that gate: a comment here
  // naming `assertKnownFlags` made the name-based detector read the file as
  // already fixed, so it was reported as "baseline can shrink — fixed or gone".
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'sync-to-repos' });
  assertRepoRoot(import.meta.url);

  if (!KEEP_GITHUB_SKILLS) {
    process.stderr.write(
      '[sync] DEPRECATION: .github/skills/ surface is no longer mirrored to consumer repos.\n' +
      '  Pass --keep-github-skills to preserve mirroring during the deprecation window.\n' +
      '  Existing .github/skills/ directories in consumer repos are NOT deleted by this sync.\n'
    );
  }

  let totalNew = 0;
  let totalUpdated = 0;
  let totalUnchanged = 0;
  let totalErrors = 0;

  const targetRepos = targetFilter
    ? REPOS.filter(r => r.name === targetFilter || r.alias === targetFilter)
    : REPOS;

  if (targetFilter && targetRepos.length === 0) {
    console.error(`${R}Unknown target: "${targetFilter}"${X}`);
    const knownTargets = REPOS.map(r => r.name + ' (' + r.alias + ')').join(', ');
    console.error(`  Known: ${knownTargets}`);
    process.exit(1);
  }

  const dryRunSuffix = DRY_RUN ? ' ' + Y + '[DRY RUN]' + X : '';
  console.log(B + 'Audit-Loop Sync' + X + dryRunSuffix);
  console.log(`  Source: ${SOURCE_ROOT}`);
  console.log('');

  // Regenerate the sync manifest BEFORE copying — its hash content needs to
  // reflect what we're about to ship to consumers.  The manifest is itself
  // in CORE_ASSETS so it gets included in the file copy below.
  if (!DRY_RUN) {
    // Version-contract files = the core + arch import closure. These are the
    // files consumers must keep in lockstep. Other bundles (learning/debt)
    // are optional per-repo additions and not part of the version contract.
    const { files: manifestFiles } = resolveBundle(
      [...CORE_ENTRY, ...ARCH_ENTRY], CORE_ASSETS,
    );
    const { manifest } = writeManifest(SOURCE_ROOT, manifestFiles, {
      repo: 'Lbstrydom/claude-engineering-skills',
    });
    console.log(`  ${G}manifest${X}  scripts/.sync-manifest.json @ ${manifest.commitSha?.slice(0, 7) || '?'} (${Object.keys(manifest.files).length} files)`);
    console.log('');
  }

  for (const repo of targetRepos) {
    if (!fs.existsSync(repo.path)) {
      console.log(`${Y}Skipping ${repo.name}${X}: directory not found at ${repo.path}`);
      console.log('');
      continue;
    }

    let repoNew = 0, repoUpdated = 0, repoUnchanged = 0, repoErrors = 0;
    let repoRemaps = 0, repoRewrites = 0, repoGcDeletions = 0;

    console.log(`${B}→ ${repo.name}${X} (${repo.path})`);

    // ── Pre-flight: adoption tier (advisory) ──────────────────────────────
    // WARN, never abort. A Tier-2 consumer still gets a fully-working
    // `.claude/skills/**` half; refusing the sync would withdraw value that
    // works in order to punish a missing package.json. The failure this
    // catches is SILENCE — pre-2026-07-20 a non-Node consumer got a green
    // sync and an inert tooling tree, discoverable only by running something.
    const runtime = classifyConsumerRuntime(repo.path);
    if (runtime.tier === 2) {
      console.log(`  ${Y}tier 2${X}   no package.json — skill markdown will work; the .mjs half will be INERT here`);
      // Concrete, paste-able example — NOT a `<placeholder>`. PowerShell
      // reserves `<`, so an angle-bracket command cannot be pasted at all
      // (repo-wide operator-doc rule; this bit us twice before 2026-07-02).
      //
      // The example is deliberately `openai-audit` and NOT `arch:render`:
      // Tier 2 means no package.json, which makes detectRepoStack return
      // python/unknown, which makes symbol-index/refresh.mjs short-circuit on
      // unsupported-stack — so an arch:render example would hand a Tier-2
      // operator the ONE command that cannot work for them. (Field report
      // 2026-07-20: that is exactly the loop a Python consumer ran.)
      const srcPosix = SOURCE_ROOT.replaceAll('\\', '/');
      console.log(`  ${D}Drive the tooling from THIS repo instead — run from the consumer's root:${X}`);
      // "$PLAN_FILE" rather than a literal plan path: a non-existent
      // docs/plans/*.md literal is a broken reference (check-docs-refs), and
      // the marked-placeholder form the checker wants uses angle brackets,
      // which PowerShell cannot paste. A shell var satisfies both — and is
      // what install-prepush-hook.mjs already emits.
      console.log(`  ${D}  AUDIT_ALLOW_FOREIGN_CWD=1 node ${srcPosix}/scripts/openai-audit.mjs code "$PLAN_FILE" --scope diff${X}`);
      console.log(`  ${D}  Which lenses fit this repo: node ${srcPosix}/scripts/skills-fit-check.mjs --repo-root .${X}`);
      console.log(`  ${D}  (see docs/runbooks/consumer-adoption.md § Runtime prerequisites)${X}`);
    } else if (!runtime.hasNodeModules) {
      console.log(`  ${Y}tier 1${X}   package.json present but no node_modules — run \`npm install\` in the consumer before using the .mjs half`);
    }

    // ── Pre-flight: Azure embedding deployment (advisory) ─────────────────
    // Silent unless actionable — an advisory that fires on every sync is one
    // nobody reads. The command is cd-scoped and paste-able (no <placeholders>:
    // PowerShell reserves `<`).
    if (assessConsumerAzureEmbed(repo.path).actionable) {
      const srcPosix = SOURCE_ROOT.replaceAll('\\', '/');
      const dstPosix = repo.path.replaceAll('\\', '/');
      console.log(`  ${Y}azure${X}    AZURE_OPENAI_ENDPOINT set but AZURE_OPENAI_EMBED_DEPLOYMENT is not — embeddings will use the default guess`);
      console.log(`  ${D}Probe this resource and lock in the real deployment name:${X}`);
      console.log(`  ${D}  cd ${dstPosix} && node ${srcPosix}/scripts/azure-doctor.mjs --fix${X}`);
    }

    // ── Pre-flight: ownership-aware preflight + gitignore validation ───────
    // Build ownership set from the source-side inventory. The verifier on the
    // consumer side derives an equivalent set from the manifest; for sync
    // itself we use the source paths directly.
    const ownedSourceTails = buildOwnedSourceTails(repo.files);
    const rewriteConfig = { ownedSourceTails };

    // Read the consumer's prior manifest BEFORE any write. Used for both
    // ownership preflight (collision detection) and GC (deletions).
    const priorManifestPath = path.join(repo.path, LAYOUT_CONSTANTS.MANIFEST_PATH);
    let priorManifest = null;
    try {
      if (fs.existsSync(priorManifestPath)) {
        priorManifest = JSON.parse(fs.readFileSync(priorManifestPath, 'utf-8'));
      }
    } catch { /* corrupt prior manifest — treat as missing */ }
    const priorLayout = priorManifest?.layout || 'legacy';
    const priorFiles = priorManifest?.files || {};

    // ── Ownership-rollback detection ──────────────────────────────────────
    // The manifest is TRACKED while the files it owns are gitignored, so a
    // merge/reset/checkout rolls the ownership record backwards while the files
    // survive. Every file synced since then reads as an unowned collision and
    // aborts the whole target — the consumer silently stops receiving updates,
    // and nothing reports it at the moment the damage is done. That went
    // undetected for five weeks and recurred on a second consumer.
    //
    // The watermark is gitignored, so it does NOT move when the manifest does.
    // A prior manifest older or smaller than the watermark is therefore proof
    // the record regressed, available on the very next sync.
    //
    // Advisory only: it explains a state the collision guard already handles,
    // and a stale watermark must never block a legitimate sync.
    const watermarkPath = path.join(repo.path, LAYOUT_CONSTANTS.OWNERSHIP_WATERMARK);
    let watermark = null;
    try {
      if (fs.existsSync(watermarkPath)) {
        watermark = JSON.parse(fs.readFileSync(watermarkPath, 'utf-8'));
      }
    } catch { /* corrupt watermark — treat as missing, never block */ }
    const regression = detectOwnershipRegression(watermark, priorManifest);
    if (regression) {
      console.log(`  ${R}ownership record regressed${X} — the manifest moved backwards since our last sync.`);
      if (regression.shrankBy > 0) {
        console.log(`    ${D}files: ${regression.recordedCount} recorded → ${regression.priorCount} now (${regression.shrankBy} lost)${X}`);
      }
      if (regression.wentBackwards) {
        console.log(`    ${D}generatedAt: ${regression.recordedAt} → ${regression.priorAt}${X}`);
      }
      console.log(`    ${D}This happens when scripts/.sync-manifest.json is still TRACKED and a merge,`);
      console.log(`    reset or branch checkout reverted it while its gitignored files stayed on disk.`);
      console.log(`    Content-derived ownership already handles it (auto-adopt below); to remove the`);
      console.log(`    footgun entirely, untrack the manifest — see docs/plans/sync-ownership-from-content.md §B.${X}`);
    }

    // Pre-flight #1: gitignore managed-block well-formedness. Abort BEFORE
    // any write if the block is in a malformed state — fail-fast prevents
    // a half-installed tree paired with stale ignores.
    const giPath = path.join(repo.path, '.gitignore');
    let priorGitignore = null;
    try {
      priorGitignore = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf-8') : null;
    } catch { priorGitignore = null; }
    const giPreview = updateManagedBlock(
      priorGitignore,
      [
        // The tooling dir is layout-derived, so it stays here; everything else
        // is in MANAGED_IGNORE_PATTERNS. The block's contents used to be split
        // between that constant and an inline list right here — so "what does
        // the managed block ignore?" had no single answer, and a guard test
        // comparing the untrack allow-list against it read half the truth.
        LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR + '/',
        ...MANAGED_IGNORE_PATTERNS,
      ],
    );
    if (giPreview.action === 'abort') {
      console.log(`  ${R}ABORT${X}  .gitignore preflight: ${giPreview.error}`);
      totalErrors++;
      console.log('');
      continue;
    }

    // Pre-flight #1b: managed .gitattributes block. We write synced surfaces
    // with LF; on Windows consumers (core.autocrlf) git checks them out as CRLF
    // and reports every synced .md/.json as perpetually "modified" (EOL-only
    // churn). Pin the TRACKED synced surfaces to `eol=lf` so git stores +
    // checks them out as LF — no churn. Reuses the same content-agnostic
    // managed-block machinery as .gitignore (same marker sentinels; one block
    // per file). Precise globs only — never the consumer's own files.
    // (scripts/.claude-skills/** is gitignored, so not pinned here.)
    const gaPath = path.join(repo.path, '.gitattributes');
    let priorGitattributes = null;
    try {
      priorGitattributes = fs.existsSync(gaPath) ? fs.readFileSync(gaPath, 'utf-8') : null;
    } catch { priorGitattributes = null; }
    const gaPreview = updateManagedBlock(
      priorGitattributes,
      [
        '.claude/skills/** text eol=lf',
        '.claude/hooks/** text eol=lf',
        '.claude/settings.json text eol=lf',
        '.vscode/mcp.json text eol=lf',
        'docs/reference/consistency-contract.md text eol=lf',
        'scripts/.sync-manifest.json text eol=lf',
        '.audit-loop/migrations/** text eol=lf',
      ],
    );
    if (gaPreview.action === 'abort') {
      console.log(`  ${R}ABORT${X}  .gitattributes preflight: ${gaPreview.error}`);
      totalErrors++;
      console.log('');
      continue;
    }

    // Pre-flight #2: ownership scan. For each destination we intend to write
    // OR delete, ensure no foreign file is at that destination. Foreign =
    // exists on disk AND not present in the prior manifest under any layout
    // (legacy or isolated).
    const intendedWrites = new Map(); // dstRel → srcRel
    for (const srcRel of repo.files) {
      const dstRel = sourceRelToDestRel(srcRel);
      intendedWrites.set(dstRel, srcRel);
    }
    const inProgressJournalPath = path.join(repo.path, LAYOUT_CONSTANTS.IN_PROGRESS_JOURNAL);
    let journalDestinations = new Set();
    if (fs.existsSync(inProgressJournalPath)) {
      try {
        const journal = JSON.parse(fs.readFileSync(inProgressJournalPath, 'utf-8'));
        if (Array.isArray(journal.destinations)) {
          for (const d of journal.destinations) journalDestinations.add(d);
        }
      } catch { /* malformed journal — treat as empty */ }
    }
    const collisions = [];
    const inventoryOwned = []; // non-relocating managed surfaces absent from prior manifest
    const contentOwned = [];   // orphans proved ours by their own bytes (see sync-ownership.mjs)
    for (const [dstRel] of intendedWrites) {
      const dstAbsPath = path.join(repo.path, dstRel);
      if (!fs.existsSync(dstAbsPath)) continue;
      // Layout-aware ownership lookup: check both the destination key
      // (isolated layout) and the source-derived legacy key.
      const ownedAsIsolated = Object.prototype.hasOwnProperty.call(priorFiles, dstRel);
      const ownedAsLegacyMap = priorLayout === 'legacy' &&
        Object.prototype.hasOwnProperty.call(priorFiles, intendedWrites.get(dstRel));
      const ownedByInterruptedRun = journalDestinations.has(dstRel);
      // Inventory-ownership (root fix for incomplete legacy manifests): a file
      // we intend to write whose dest == src (a NON-relocating managed surface
      // — .claude/skills/**, .github/prompts/**, editor configs, the manifest
      // itself) is ours by namespace definition. Older sync versions never
      // recorded these in the manifest, so the prior-manifest test
      // false-positives on the first isolated migration. This is safe: those
      // paths are our exclusive managed namespace, and the two genuinely
      // co-owned configs (.claude/settings.json, .vscode/mcp.json) are written
      // via deepMerge, which preserves consumer keys regardless of this claim.
      // The relocating namespace (scripts/.claude-skills/**, dst != src) is NOT
      // covered — a foreign file there still aborts, preserving real collision
      // protection.
      const ownedByInventoryNonRelocating =
        !ownedAsIsolated && !ownedAsLegacyMap && dstRel === intendedWrites.get(dstRel);
      if (!ownedAsIsolated && !ownedAsLegacyMap && !ownedByInterruptedRun) {
        if (ownedByInventoryNonRelocating) { inventoryOwned.push(dstRel); continue; }
        // Content-derived ownership. The manifest is a TRACKED file that a
        // merge or reset can roll backwards while the gitignored files it
        // describes survive, so "absent from the manifest" is NOT evidence a
        // file is foreign. The bytes are evidence: our banner cannot be forged
        // by a consumer-authored file, and content identical to what we would
        // write makes adoption a no-op. Everything else still collides.
        const srcRel = intendedWrites.get(dstRel);
        let destContent = null;
        try { destContent = fs.readFileSync(dstAbsPath, 'utf-8'); } catch { /* fails closed */ }
        // Build the byte-identity comparand with the SAME pipeline the write
        // path uses, rather than re-deriving "is this file rewritten /
        // banner-injected?" as a second predicate — that duplicate definition
        // is exactly the drift this repo keeps paying for. For `.sql`
        // migrations both steps are no-ops, so this reduces to source bytes;
        // for tooling the banner proof fires first anyway.
        const srcContent = readSource(srcRel);
        let expected = null;
        if (srcContent !== null) {
          expected = injectUpstreamBanner(
            rewriteCommandSurface({ relPath: dstRel, content: srcContent, config: rewriteConfig }).rewritten,
            dstRel,
          );
        }
        const { provable, evidence } = classifyOwnership({
          destContent,
          sourceContent: expected,
          bannerMarker: BANNER_MARKER,
        });
        if (provable) contentOwned.push({ dstRel, evidence });
        else collisions.push(dstRel);
      }
    }
    if (inventoryOwned.length && !DRY_RUN) {
      console.log(`  ${Y}note${X}  ${inventoryOwned.length} managed-surface file(s) not in prior manifest — treating as owned (legacy manifest predates skill/prompt tracking).`);
    }
    if (contentOwned.length) {
      // Reported every run, never silent. This path exists because the manifest
      // regressed, and a silent auto-adopt would hide a recurring rollback
      // behind a clean-looking sync — trading a loud abort for a quiet
      // pathology. The regression warning above usually accompanies it.
      console.log(`  ${Y}adopt${X}  ${contentOwned.length} orphan(s) proved ours by content — ownership record had lost them:`);
      for (const { dstRel, evidence } of contentOwned.slice(0, 10)) {
        console.log(`    ${D}owned${X}  ${dstRel} ${D}(${describeEvidence(evidence)})${X}`);
      }
      if (contentOwned.length > 10) console.log(`    ${D}... ${contentOwned.length - 10} more${X}`);
    }
    if (collisions.length && ADOPT_ORPHANS) {
      // Operator override. Each orphan is reported with whether its on-disk
      // content still matches what we are about to write, because that is the
      // difference between "re-record a file we already produced" and
      // "discard whatever is there". Never inferred — the operator is told.
      console.log(`  ${Y}adopt${X}  ${collisions.length} orphan(s) — recording as owned (--adopt-orphans):`);
      for (const dstRel of collisions) {
        // Report EVIDENCE of provenance, not a content diff. Comparing against
        // raw source is useless here: outbound content is banner-injected, so
        // every relocated file would read "differs" and the operator would
        // learn to ignore the line. Our banner is the discriminating signal —
        // a consumer-authored file cannot carry it.
        let status;
        try {
          const onDisk = fs.readFileSync(path.join(repo.path, dstRel), 'utf-8');
          status = onDisk.includes(BANNER_MARKER)
            ? 'carries our upstream-owned banner — provably ours'
            : `${R}NO banner — inspect before adopting${X}${D}`;
        } catch { status = 'unreadable'; }
        console.log(`    ${Y}orphan${X}  ${dstRel} ${D}(${status})${X}`);
      }
      collisions.length = 0;   // adopted: fall through to the normal write path
    }
    if (collisions.length) {
      // Reported under --dry-run TOO. It used to be `collisions.length &&
      // !DRY_RUN`, so a dry run of a consumer that a real sync would refuse
      // outright printed a clean file-count summary — the one command an
      // operator reaches for to ask "what would this do?" could not see the
      // whole-target abort. That cost a real investigation an hour.
      console.log(`  ${R}${DRY_RUN ? 'would ABORT' : 'ABORT'}${X}  ${collisions.length} unowned collision(s); will not overwrite.`);
      for (const c of collisions.slice(0, 10)) console.log(`    ${R}collide${X}  ${c}`);
      if (collisions.length > 10) console.log(`    ${D}... ${collisions.length - 10} more${X}`);
      // These survived the content check: no banner, and not byte-identical to
      // what we would write. That is the residue the guard exists for — most
      // plausibly a real consumer file, or one of ours that was edited in place
      // (itself a governance violation worth seeing). --adopt-orphans still
      // overrides, after checking the reported paths.
      console.log(`    ${D}no banner and differs from source — inspect before adopting${X}`);
      console.log(`    ${D}if these are ours, re-run with --adopt-orphans to re-record them${X}`);
      totalErrors++;
      console.log('');
      continue;
    }

    // Pre-flight passed; write the in-progress journal so a crash here on
    // first-migration can be recognised next run.
    if (!DRY_RUN) {
      try {
        atomicWriteFileSync(
          inProgressJournalPath,
          JSON.stringify({
            startedAt: new Date().toISOString(),
            destinations: [...intendedWrites.keys()],
          }, null, 2) + '\n',
        );
      } catch (err) {
        console.log(`  ${Y}journal write failed${X}: ${err.message?.slice(0, 100)}`);
      }
    }

    // ── Per-file writes ────────────────────────────────────────────────────
    for (const srcRel of repo.files) {
      const dstRel = sourceRelToDestRel(srcRel);
      const srcPath = path.join(SOURCE_ROOT, srcRel);
      const dstPath = path.join(repo.path, dstRel);

      if (!fs.existsSync(srcPath)) {
        console.log(`  ${Y}skip${X}  ${srcRel} ${D}(not in source)${X}`);
        continue;
      }

      if (dstRel !== srcRel) repoRemaps++;

      // Read source content; apply ownership-aware command rewriter where
      // applicable. JSON files: merge with existing consumer content first,
      // then rewrite the merged tree. Text files: rewrite directly.
      let srcContent;
      try { srcContent = fs.readFileSync(srcPath, 'utf-8'); }
      catch (err) {
        console.log(`  ${R}ERR${X}  ${srcRel}: read failed: ${err.message?.slice(0, 100)}`);
        repoErrors++; totalErrors++;
        continue;
      }

      let outContent = srcContent;
      const isJson = dstRel.endsWith('.json');
      const dstExists = fs.existsSync(dstPath);

      if (isJson && dstExists) {
        // Existing deepMerge behaviour preserved for JSON; rewriter runs
        // AFTER merge on the final value (plan §2 KD #9 + Gemini v3 G4 fix).
        try {
          const src = JSON.parse(srcContent);
          const dst = JSON.parse(fs.readFileSync(dstPath, 'utf-8'));
          const merged = deepMerge(dst, src);
          outContent = JSON.stringify(merged, null, 2) + '\n';
        } catch (err) {
          console.log(`  ${R}ERR${X}  ${dstRel}: JSON merge failed: ${err.message?.slice(0, 100)}`);
          repoErrors++; totalErrors++;
          continue;
        }
      }

      const rewriteResult = rewriteCommandSurface({
        relPath: dstRel,
        content: outContent,
        config: rewriteConfig,
      });
      outContent = rewriteResult.rewritten;
      if (rewriteResult.changed) repoRewrites++;

      // Inject the "UPSTREAM-OWNED — do not edit" banner into relocated,
      // comment-capable tooling (scripts/.claude-skills/**) so an agent can't
      // open the synced copy to patch it without being told to fix upstream +
      // re-sync (consumer-deployment-hardening). No-op for tracked
      // skills/prompts and JSON. Runs BEFORE the hash so the manifest matches
      // what we write (idempotent — source is banner-free, so re-sync is a
      // no-op "unchanged").
      outContent = injectUpstreamBanner(outContent, dstRel);

      // Compute hashes against final outbound content (so the manifest's
      // hashes match what we actually write).
      const srcHash = crypto.createHash('sha256').update(outContent).digest('hex');
      const dstHash = dstExists
        ? crypto.createHash('sha256').update(fs.readFileSync(dstPath)).digest('hex')
        : null;

      if (srcHash === dstHash) {
        repoUnchanged++; totalUnchanged++;
        continue;
      }

      const isNew = dstHash === null;
      const remappedLabel = dstRel !== srcRel ? ` ${D}(was ${srcRel})${X}` : '';
      const rewriteLabel = rewriteResult.hits ? ` ${D}[${rewriteResult.hits} rewrites]${X}` : '';
      const label = isNew ? `${G}new${X}  ` : `${Y}upd${X}  `;
      console.log(`  ${label} ${dstRel}${remappedLabel}${rewriteLabel}`);

      if (DRY_RUN) {
        if (!isNew) {
          const lines = unifiedDiff(srcPath, dstPath, dstRel).split('\n');
          const preview = lines.slice(0, 40).join('\n');
          const truncated = lines.length > 40;
          console.log(preview.split('\n').map((l) => '    ' + l).join('\n'));
          if (truncated) console.log(`    ${D}... ${lines.length - 40} more lines${X}`);
        }
      } else {
        try {
          fs.mkdirSync(path.dirname(dstPath), { recursive: true });
          atomicWriteFileSync(dstPath, outContent);
        } catch (err) {
          console.log(`  ${R}ERR${X}  ${dstRel}: ${err.message}`);
          repoErrors++; totalErrors++;
          continue;
        }
      }

      if (isNew) { repoNew++; totalNew++; }
      else { repoUpdated++; totalUpdated++; }
    }

    // ── GC: delete files removed from upstream (Gemini v3 G3 fix) ──────────
    // Compute set diff: priorFiles' isolated keys MINUS intendedWrites.
    const intendedDests = new Set(intendedWrites.keys());
    const gcDeletions = [];
    // Orphans OUTSIDE the tooling dir. We sync a few files to real, TRACKED
    // consumer paths (e.g. docs/reference/consistency-contract.md). When such a
    // file is renamed upstream, GC must not delete the old copy — deleting a
    // tracked file is a commit in someone's repo, not sync bookkeeping, and the
    // consumer may have edited it. But saying NOTHING leaves a stale duplicate
    // sitting next to the live one indefinitely, silently authoritative-looking.
    // (The consistency contract survived a move into `docs/reference/` this way:
    // its pre-move copy went stale on 2026-06-29 while the real file kept
    // syncing. Naming that dead path literally here is what broke the
    // reference-integrity gate on 2026-07-18 — the note is history, not a
    // `(planned)` ref, so it is phrased without the path rather than exempted.)
    // So: advise, never act.
    const orphanedTracked = [];
    for (const priorDestRel of Object.keys(priorFiles)) {
      if (intendedDests.has(priorDestRel)) continue;
      if (priorDestRel.startsWith(`${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/`)) {
        gcDeletions.push(priorDestRel);   // gitignored + regenerable ⇒ safe to delete
      } else if (fs.existsSync(path.join(repo.path, priorDestRel))) {
        orphanedTracked.push(priorDestRel);
      }
    }
    if (orphanedTracked.length) {
      console.log(`  ${Y}↳ ${orphanedTracked.length} file(s) we no longer sync are still present${X} ${D}(likely renamed upstream; sync will NOT delete a tracked file):${X}`);
      for (const f of orphanedTracked.slice(0, 8)) {
        // Count what still CITES the orphan before suggesting its removal.
        // Naming the path alone is a trap: the first real case (the
        // consistency-contract doc, before it moved under docs/reference/) had
        // 7 inbound citations including live source comments in a consumer, so
        // a bare `git rm` would have traded a stale
        // duplicate for 7 dangling references — the exact failure the
        // reference-integrity gate exists to prevent. Generated surfaces
        // (.gitattributes) self-heal on a rename because they're derived from
        // the sync file list; hand-written prose and code comments do not.
        // So: count them here, and let the operator decide.
        let citations = 0;
        try {
          const out = execSync(`git grep -l -F -- "${f}"`, {
            cwd: repo.path, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
          });
          citations = out.split('\n').filter(l => l.trim() && l.trim() !== f).length;
        } catch { /* exit 1 = no matches; any git failure ⇒ report 0, never block */ }
        const hint = citations > 0
          ? `${Y}— ${citations} file(s) still cite it; repoint before removing${X}`
          : `${D}— no inbound citations${X}`;
        console.log(`    ${D}${f}${X} ${hint}`);
      }
    }
    if (gcDeletions.length) {
      if (DRY_RUN) {
        console.log(`  ${D}gc dry-run: ${gcDeletions.length} file(s) would be deleted${X}`);
      } else {
        for (const dRel of gcDeletions) {
          const abs = path.join(repo.path, dRel);
          try { fs.unlinkSync(abs); repoGcDeletions++; }
          catch (err) {
            if (err.code !== 'ENOENT') {
              console.log(`  ${Y}gc warn${X}  ${dRel}: ${err.message?.slice(0, 80)}`);
            }
          }
        }
        if (repoGcDeletions) console.log(`  ${D}gc: removed ${repoGcDeletions} stale file(s)${X}`);
      }
    }

    // ── Commit point: write per-consumer manifest with layout: 'isolated' ──
    //
    // This is the OWNERSHIP RECORD, not bookkeeping. Files are already on disk
    // by now; if this write does not land, they exist with nobody claiming
    // them — and the next run classifies each as an unowned collision and
    // aborts the WHOLE target, so the consumer silently stops receiving every
    // future update. A failure here is therefore a failed sync, not a warning.
    let manifestWritten = false;
    if (!DRY_RUN) {
      try {
        // For consumer-side: compute hashes of the actual DESTINATION files
        // (post-rewrite). The source-side `.sync-manifest.json` produced
        // earlier is independent and stays.
        const consumerFileMap = {};
        for (const dstRel of intendedDests) {
          const abs = path.join(repo.path, dstRel);
          if (!fs.existsSync(abs)) continue;
          const buf = fs.readFileSync(abs);
          consumerFileMap[dstRel] = 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
        }
        const consumerManifest = {
          generatedAt: new Date().toISOString(),
          repo: 'Lbstrydom/claude-engineering-skills',
          branch: 'main',
          commitSha: null,
          files: consumerFileMap,
          layout: 'isolated',
        };
        atomicWriteFileSync(priorManifestPath, JSON.stringify(consumerManifest, null, 2) + '\n');
        manifestWritten = true;
        // High-water mark for rollback detection (see the check at read time).
        // Written only after the manifest actually landed, so it never claims
        // ownership of a record that does not exist. A failure here degrades
        // detection on the NEXT run but must not fail a sync that succeeded.
        try {
          atomicWriteFileSync(
            watermarkPath,
            JSON.stringify({
              generatedAt: consumerManifest.generatedAt,
              fileCount: Object.keys(consumerFileMap).length,
            }, null, 2) + '\n',
          );
        } catch (err) {
          console.log(`  ${Y}watermark write failed${X} ${D}(rollback detection degraded next run): ${err.message?.slice(0, 80)}${X}`);
        }
      } catch (err) {
        console.log(`  ${R}manifest write FAILED${X}: ${err.message?.slice(0, 120)}`);
        console.log(`    ${D}files were written but are now unowned; the in-progress journal is`);
        console.log(`    kept so the next run adopts them. Re-run sync to reconcile.${X}`);
        repoErrors++; totalErrors++;
      }
    }

    // ── Apply managed .gitattributes block (EOL pins; preflight validated) ──
    if (!DRY_RUN && gaPreview.action !== 'noop') {
      try {
        atomicWriteFileSync(gaPath, gaPreview.content);
      } catch (err) {
        console.log(`  ${R}.gitattributes write failed${X}: ${err.message?.slice(0, 120)}`);
      }
    }

    // ── Apply managed .gitignore block (preflight already validated) ───────
    if (!DRY_RUN && giPreview.action !== 'noop') {
      try {
        atomicWriteFileSync(giPath, giPreview.content);
      } catch (err) {
        console.log(`  ${R}.gitignore write failed${X}: ${err.message?.slice(0, 120)}`);
      }
    }

    // ── Self-heal: untrack files now covered by a managed runtime-output
    // pattern. A .gitignore rule never untracks an already-committed file, so a
    // runtime output committed before its pattern existed would churn forever.
    // Scoped STRICTLY to UNTRACK_PATTERNS — deliberately NARROWER than the
    // ignore block (see the constant's note: ignoring is safe to broaden,
    // untracking is destructive and acts on committed files) —
    // and each candidate is re-confirmed via `git check-ignore`, so a
    // consumer's own file can never be swept. Idempotent + best-effort (a git
    // failure must never abort the sync). Honoured in dry-run (logs only).
    try {
      const untracked = untrackNewlyIgnored(repo.path, UNTRACK_PATTERNS, { dryRun: DRY_RUN });
      if (untracked.length) {
        const verb = DRY_RUN ? 'would untrack' : 'untracked';
        console.log(`  ${Y}↳ ${verb} ${untracked.length} now-ignored runtime file(s)${X} ${D}(git rm --cached; commit in the consumer to finish):${X}`);
        for (const f of untracked.slice(0, 8)) console.log(`    ${D}${f}${X}`);
      }
    } catch (err) {
      console.log(`  ${Y}↳ untrack-newly-ignored skipped${X}: ${err.message?.slice(0, 100)}`);
    }

    // ── Last step: delete the in-progress journal — ONLY if the ownership
    // record actually landed.
    //
    // The journal IS the recovery mechanism: next run treats its destinations
    // as `ownedByInterruptedRun`, so a sync that copied files but never
    // recorded them self-heals. Deleting it unconditionally destroyed that
    // evidence precisely when it was needed, turning a transient write failure
    // into a permanent unowned-collision that aborts every subsequent sync to
    // that consumer. Keeping it costs one stale file; deleting it early costs
    // the consumer every future update.
    if (!DRY_RUN && manifestWritten) {
      try { fs.unlinkSync(inProgressJournalPath); }
      catch (err) { if (err.code !== 'ENOENT') { /* leave dangling — next run will reconcile */ } }
    }

    const parts = [];
    if (repoNew > 0) parts.push(`${G}+${repoNew} new${X}`);
    if (repoUpdated > 0) parts.push(`${Y}~${repoUpdated} updated${X}`);
    if (repoUnchanged > 0) parts.push(`${D}${repoUnchanged} unchanged${X}`);
    if (repoRemaps > 0) parts.push(`${D}${repoRemaps} remapped${X}`);
    if (repoRewrites > 0) parts.push(`${D}${repoRewrites} rewritten${X}`);
    if (repoGcDeletions > 0) parts.push(`${D}${repoGcDeletions} gc-deleted${X}`);
    if (repoErrors > 0) parts.push(`${R}${repoErrors} errors${X}`);
    console.log(`  ${parts.join('  ')}`);

    // Surface genuinely-unresolved imports — a path-like specifier the graph
    // walker could not resolve is a real missing dependency that would crash
    // the consumer repo at runtime. Non-fatal (it may be a deliberate
    // optional-dep guard), but loud so it doesn't go unnoticed.
    const missing = realMissingDeps(repo.unresolved);
    if (missing.length) {
      console.log(`  ${Y}⚠ ${missing.length} unresolved import(s)${X} ${D}— possible missing dependency:${X}`);
      for (const m of missing.slice(0, 8)) {
        console.log(`    ${D}${m.from} → ${m.specifier}${X}`);
      }
    }

    // Post-sync: ensure audit-loop npm deps are installed. Idempotent — no-op
    // when the target already has everything. Without this step, sync can keep
    // skill + script files current forever while the scripts silently fail to
    // import at runtime because devDeps were never installed.
    if (!DRY_RUN) {
      try {
        ensureAuditDeps(repo.path, { dryRun: false, quiet: false });
      } catch (err) {
        console.log(`  ${R}deps check failed${X}: ${err.message?.slice(0, 120)}`);
      }
    }

    // Post-sync setup check — skip in dry-run (nothing was written)
    if (!DRY_RUN) {
      try {
        execSync(
          `node "${path.join(SOURCE_ROOT, 'scripts/check-setup.mjs')}" --repo-path "${repo.path}"`,
          { stdio: 'inherit', timeout: 30000 }
        );
      } catch {
        // check-setup exits 1 on failures — already printed the report, just continue
      }
    }

    // First-sync skills fit-check — fires once per consumer when the
    // sentinel report (`.skills-fit-check.json` in the consumer root) is
    // absent. Subsequent syncs skip it silently; adopters re-run any time
    // with `npm run skills:fit-check`. Best-effort, never blocks sync.
    if (!DRY_RUN) {
      const fitCheckSentinel = path.join(repo.path, '.skills-fit-check.json');
      if (!fs.existsSync(fitCheckSentinel)) {
        console.log('');
        console.log(`  ${B}First sync — running skills fit-check${X}`);
        try {
          execSync(
            `node "${path.join(SOURCE_ROOT, 'scripts/skills-fit-check.mjs')}" --repo-root "${repo.path}"`,
            { stdio: 'inherit', timeout: 15000 }
          );
        } catch {
          // Advisory diagnostic — never block the sync flow.
        }
      }
    }
    console.log('');
  }

  // Summary
  console.log('─'.repeat(40));
  if (DRY_RUN) {
    console.log(`${Y}DRY RUN complete${X} — no files written`);
    console.log(`  Would create: ${totalNew}  update: ${totalUpdated}  unchanged: ${totalUnchanged}`);
    if (totalNew + totalUpdated > 0) {
      console.log(`\nRun without --dry-run to apply.`);
    }
  } else {
    if (totalErrors > 0) {
      console.log(`${R}Sync completed with errors${X}`);
    } else {
      console.log(`${G}Sync complete${X}`);
    }
    console.log(`  Created: ${totalNew}  Updated: ${totalUpdated}  Unchanged: ${totalUnchanged}  Errors: ${totalErrors}`);
    // Hook-refresh reminder (reference-integrity-gate Cluster C, R2-H3/R16): the
    // pre-push audit hook is versioned and refreshes on `hooks:install`, but sync
    // does not re-install git hooks (opt-in, per-consumer). A consumer running an
    // older hook body picks up the v2 Status-aware plan selection only after a
    // re-install — a strict improvement, never a regression (worst case = today's
    // behaviour). Surfaced, not auto-run, so we never clobber an operator hook.
    if (!DRY_RUN) {
      // The `--` before `--target` is load-bearing, not style. Without it npm
      // eats `--target` as its own config and forwards the VALUE as a bare
      // positional, which this script ignores — so `npm run hooks:install
      // --target wine` silently installs into EVERY consumer repo instead of
      // one. Verified 2026-07-20: the no-`--` form reports both wine-cellar-app
      // and ai-organiser; the `--` form reports only the named repo. Same
      // "silently did more than you asked" family as the unknown-flag gate,
      // which cannot catch it because the flag never reaches argv at all.
      console.log(`  ${D}If a consumer uses the pre-push audit hook, re-run \`npm run hooks:install -- --target <name>\` to pick up bundle hook changes.${X}`);
    }
  }

  // D2b — sync-time shared-cloud-config trigger. Skip on dry-run, errors,
  // non-TTY, or --no-prompt. Silent on `already_current`; prompts on
  // create/update divergence. Never overwrites without operator Y.
  // Plan: docs/plans/shared-cloud-config.md §2 #5.
  // Gemini-r3 G2: stdin.isTTY added to the gate. stdout-only is unsafe in
  // CI pipelines where stdout is a pseudo-TTY (e.g. wrapped by a job
  // runner) but stdin is closed/piped — the readline prompt would hang
  // forever. Both streams must be interactive for the prompt to be safe.
  if (!DRY_RUN && totalErrors === 0 && process.stdout.isTTY && process.stdin.isTTY && !NO_PROMPT) {
    try {
      await maybePromptSharedCloudUpdate({ sourceRepoDir: SOURCE_ROOT, stdio: process.stderr });
    } catch (err) {
      // Trigger is advisory — never fail the sync over it.
      process.stderr.write(`[sync] shared-cloud-config trigger errored: ${err.message}\n`);
    }
  }

  // Dashboard reference page is no longer committed (2026-06): it embedded a
  // "built from <SHA>" banner, so rebuilding it on every push only ever
  // re-dirtied a tracked file that the hook never committed — perpetual churn
  // for an artifact nobody reads from git. It's now a local-only build (Category
  // A, gitignored), rebuilt on demand by `npm run dashboard` (serve rebuilds
  // both pages). No pre-push rebuild needed. See docs/plans/local-dashboard.md
  // §2.1 addendum + .gitignore.

  process.exit(totalErrors > 0 ? 1 : 0);
}

async function maybePromptSharedCloudUpdate({ sourceRepoDir, stdio }) {
  const { assessSharedCloudConfig, runSetupCloud, OUTCOMES } =
    await import('./lib/shared-cloud-config.mjs');
  const assessment = assessSharedCloudConfig({ sourceRepoDir });

  // Silent on `already_current` — operator only sees output when actionable.
  if (assessment.outcome === OUTCOMES.ALREADY_CURRENT) return;

  // Misconfigured → one-line advisory, never blocks sync.
  if (assessment.outcome === OUTCOMES.MISCONFIGURED) {
    stdio.write(
      `\n[sync] shared cloud config: ${assessment.reason} — skipping ` +
      `(run \`npm run setup:cloud\` for details)\n`
    );
    return;
  }

  // CREATED or UPDATED — delegate to lib's runSetupCloud, with a readline
  // prompt scoped to the sync flow.
  const readline = await import('node:readline');
  const prompt = (q) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: stdio });
    rl.question(q, (answer) => {
      rl.close();
      // R1-audit M3/M13: accept only empty (default Y) or explicit y/yes.
      const a = answer.trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes');
    });
  });
  stdio.write('\n');
  await runSetupCloud({ prompt, sourceRepoDir, stdio, autoYes: false });
}

// Test seam — exposes the sync-time D2b trigger helper so behaviour
// tests can drive it directly instead of regex-asserting source text.
export const _internals = Object.freeze({
  maybePromptSharedCloudUpdate, classifyConsumerRuntime, assessConsumerAzureEmbed,
});

// Only execute when invoked as a script (canonical-path compare). When
// imported by a test, the module's exports are available without main()
// running and clobbering consumer repos.
import { pathToFileURL } from 'node:url';
const invokedAsScript = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedAsScript) {
  main().catch((err) => {
    // A usage mistake is not a crash: print the flag diagnostic alone (no stack)
    // and exit 2, matching the other guarded CLIs. Burying "unknown flag
    // --dry-runn" under a stack trace is how an operator concludes the tool is
    // broken and re-runs it WITHOUT the flag — which is the real sync.
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`sync-to-repos: fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
