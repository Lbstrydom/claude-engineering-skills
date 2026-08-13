#!/usr/bin/env node
/**
 * @fileoverview CLI facade for the cross-skill data loop.
 *
 * Skills (/ux-lock, /persona-test, /ship) invoke this script instead of raw curl.
 * It handles Supabase auth, repo resolution, JSON I/O, and graceful no-op
 * when cloud store is unavailable — giving every skill a single, testable
 * persistence entrypoint.
 *
 * Usage:
 *   node scripts/cross-skill.mjs <subcommand> [--json <payload>]
 *
 * Subcommands:
 *   upsert-plan                 — register a plan artefact, print plan UUID
 *   record-regression-spec      — /ux-lock writes a new Playwright spec
 *   record-regression-spec-run  — append a pass/fail run to a spec
 *   record-correlation          — /persona-test links a finding to an audit row
 *   record-ship-event           — /ship writes its outcome
 *   list-unlocked-fixes         — /ship reads fixes that need a regression spec
 *   list-unremediated-acceptances — /ship reads accepted findings never remediated
 *   list-recent-p0s             — /ship reads persona-test open P0s (existing query, promoted here)
 *   audit-effectiveness         — dashboard rollup (user-visible precision/recall)
 *   whoami                      — print repo_id + cloud-mode status, for diagnostics
 *
 * All commands read their payload from `--json <inline>` or stdin.
 * All output is single-line JSON for downstream skill-markdown parsing.
 * @module scripts/cross-skill
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { checkFindingGrounding, formatGroundingNote } from './lib/audit/finding-grounding.mjs';

import {
  initLearningStore,
  isCloudEnabled,
  upsertPlan,
  updatePlanStatus,
  getPlanIdByPath,
  recordRegressionSpec,
  recordRegressionSpecRun,
  recordPersonaAuditCorrelation,
  getCandidateAuditFindings,
  getExistingCorrelationHashesForSession,
  recordPlanVerificationRun,
  recordPlanVerificationItems,
  readPlanSatisfaction,
  readPersistentPlanFailures,
  getUnlockedFixes,
  findUnlockedFixInRepo,
  countUnlockedFixes,
  countAgedUnlockedFixes,
  countAgedUnremediatedAcceptances,
  countAcceptedPermanent,
  getUnremediatedAcceptances,
  countUnremediatedAcceptances,
  resolveNudgePage,
  readAuditEffectiveness,
  listPersonasForApp,
  upsertPersona,
  recordPersonaSession,
  getPersonaSessionsByRepo,
  getPersonaSessionsByUrl,
  getRecentFindingsByRepo,
  getReachabilityEvidence,
  isPersonaCloudEnabled,
  // Architectural memory (Phase A)
  upsertRepoByUuid,
  getRepoIdByUuid,
  resolveRepoForStore,
  resolveRepoForStoreResult,
  getRepoIdByName,
  listRepoIds,
  openRefreshRun,
  publishRefreshRun,
  abortRefreshRun,
  getActiveSnapshot,
  getBandCalibration,
  recordSymbolDefinitions,
  recordSymbolIndex,
  recordSymbolEmbedding,
  recordLayeringViolations,
  setActiveEmbeddingModel,
  callNeighbourhoodRpc,
  computeDriftScore,
  listSymbolsForSnapshot,
  listLayeringViolationsForSnapshot,
  // Phase 1 — adaptive-learning-v1
  insertLearningDecision,
  backfillLearningOutcome,
  // Shadow final-review A/B (docs/plans/final-review-shadow-reviewer.md)
  getFinalReviewStats,
  adjudicateFinalReviewFinding,
  recordFinalReviewFix,
  // Determinism follow-ups WS1 — deterministic outcome finalize
  recordAdjudicationEvent,
  updatePassStatsPostDeliberation,
  updateRunMeta,
  auditRunExists,
  // Model-A/B/C experiment harness (Cluster C)
  getModelAbAdjudicationQueue,
  applyModelAbAdjudication,
  getModelAbEffectiveness,
  getModelAbFindingScores,
  getModelAbArmCost,
  cumulativeSpendEur,
} from './learning-store.mjs';
import { evaluateDecision, DECISION_CONSTANTS } from './lib/model-ab-decision.mjs';
import { auditShadowConfig } from './lib/config.mjs';
import { finalizeRoundOutcomes } from './lib/finalize-outcomes.mjs';
import { semanticId } from './lib/findings.mjs';
import { shellQuoteSingle, shellQuoteLabel } from './lib/shell-quote.mjs';
import { isControlMarkerDetail } from './lib/audit/control-markers.mjs';
import { getLearningStats } from './lib/learning/stats.mjs';
import { emit, assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { classifyReadPath, classifyTestPath } from './lib/path-validation.mjs';
import { validateCountFields } from './lib/command-input.mjs';
import { resolveRepoScope, reconcileRepoIdentity } from './lib/repo-scope.mjs';
import {
  classifyFinalReviewOutcome, summariseCounts, orderItems, isActionable, renderFinalReviewCard,
} from './lib/final-review-credit.mjs';
import { resolveRepoIdentity, persistRepoIdentity } from './lib/repo-identity.mjs';
import { getNeighbourhoodForIntent } from './lib/neighbourhood-query.mjs';
import { detectRepoStack, detectPythonEnvironmentManager } from './lib/repo-stack.mjs';
import { StackProfileSchema, ReachabilityEvidenceRequestSchema, ReachabilityEvidenceResponseSchema } from './lib/schemas.mjs';
import { recommendSkills, renderRecommendationCard } from './lib/skill-recommender.mjs';
import { resolvePreviewGate } from './lib/cycle/topology.mjs';
import { cycleConfig, dbConfig } from './lib/config.mjs';
import { decideCorrelations, isP0OrP1, MATCHER_VERSION, personaFindingHash } from './lib/persona/audit-correlator.mjs';
import { buildPersonaSessionId } from './lib/persona-test/session-id.mjs';
import { recordNavAuditRun, listNavAuditRunHistory } from './lib/store/nav-audit.mjs';
import { getCommand, registryCommandNames } from './lib/cross-skill/registry.mjs';
import { dispatch } from './lib/cross-skill/dispatch.mjs';
import { computeShadowOverlap } from './lib/model-eval/shadow-overlap.mjs';
import { firstSeenFromHistory } from './lib/nav/drift.mjs';
import { z } from 'zod';

// ── Arg parsing ─────────────────────────────────────────────────────────────

const [subcommand, ...rest] = process.argv.slice(2);

/**
 * Union of every flag ANY subcommand of this dispatcher reads.
 *
 * `assertKnownFlags` validates flag NAMES only — it ignores bare positionals,
 * so the `<subcommand>` word and the `quality <verb>` / `arm-eval-toggle on|off`
 * sub-verbs pass through untouched. Per-subcommand validation (required flags,
 * value shapes, mutual exclusion) stays with each handler, which knows its own
 * semantics; this list only refuses a flag NO subcommand could ever read.
 *
 * Why the guard matters here: `learning-weekly-review` and
 * `learning-backfill-outcomes` both carry `--dry-run` over a MUTATING default,
 * so a typo'd `--dry-runn` used to be silently dropped and the real write ran.
 *
 * Grouped by subcommand. Some subcommands forward `rest` wholesale to another
 * CLI (`friction-log` → friction-log.mjs, `learning-replay` → learning/replay.mjs),
 * so those CLIs' own flags are included too.
 */
const KNOWN_FLAGS = [
  // ── Global / payload ──────────────────────────────────────────────────────
  '--json', '--stdin', '--help', '--selfcheck-relocation',
  // Registry introspection (conformance/ratchet suites read the running CLI's
  // registry-vs-legacy split through this; same family as selfcheck).
  '--inventory-json',
  // ── Shared identity / scoping flags (many subcommands) ────────────────────
  '--repo', '--repo-id', '--repo-uuid', '--limit', '--offset', '--format', '--out', '--cwd',
  // ── backlog grouping (list-unremediated-acceptances) ──────────────────────
  // `--group-by work-unit` clusters the page into refactor-sized units;
  // `--work-unit <key>` pulls one unit's rows.
  '--group-by', '--work-unit', '--no-llm-labels',
  // ── plan-satisfaction ─────────────────────────────────────────────────────
  '--plan-id',
  // ── final-review-stats / final-review-adjudicate / final-review-record-fix ─
  '--queue-limit', '--worksheet', '--run-id', '--fingerprint', '--action', '--bucket',
  // final-review-pending: --render emits the card text instead of JSON
  '--render', '--page-size',
  // lock-with-test: record a unit/integration test as a finding's regression lock
  '--finding', '--test', '--description',
  '--commit', '--state',
  // ── model-ab-adjudicate ───────────────────────────────────────────────────
  '--suggestions', '--canonical', '--actor',
  // ── arm-eval-{run,decision,stats,adjudicate,toggle,maybe-capture,export} ──
  '--experiment', '--task', '--budget-eur', '--phase', '--seed', '--all-repos',
  // list-unlocked-fixes: read past the 14-day nudge window (see cmdListUnlockedFixes)
  '--all-ages',
  '--session-id', '--ranked', '--reviewer', '--all',
  // ── finalize-outcomes ─────────────────────────────────────────────────────
  '--ledger', '--result', '--round',
  // ── persona readers (list-personas / get-persona-sessions-by-{repo,url}) ──
  '--url', '--p0-only', '--select',
  // ── get-reachability-evidence ─────────────────────────────────────────────
  '--since-days',
  // ── get-recent-findings ───────────────────────────────────────────────────
  '--severity',
  // ── persona-outcomes label / backfill-hash ────────────────────────────────
  // `--report-path` is read by cmdPersonaOutcomes (backfill-hash) but was never
  // registered, so assertKnownFlags rejected the flag before the handler could
  // see it — the subcommand could not run at all (code-audit R3-M4).
  '--session', '--hash', '--outcome', '--rationale', '--by', '--report-path',
  // ── recommend-skills (also reads shared '--url' declared above) ──────────
  '--changed', '--just-ran', '--max', '--plan-lenses', '--findings',
  // ── detect-stack ──────────────────────────────────────────────────────────
  '--include-env-manager',
  // ── resolve-repo-identity ─────────────────────────────────────────────────
  '--persist',
  // ── list-layering-violations-for-snapshot ─────────────────────────────────
  '--refresh-id',
  // ── quality <add|mirror|digest|link|session-review> ───────────────────────
  '--title', '--scope-tags', '--scope-tag', '--cost', '--name',
  '--files', '--file', '--symbols', '--symbol', '--body',
  '--repo-scoped', '--window-days', '--min-similarity',
  '--memory', '--kind', '--ref', '--window-hours',
  // ── get-friction-neighbourhood / get-incident-neighbourhood ───────────────
  '--prompt', '--k',
  // ── upstream <report|list|ack|fix|wont-fix|drain> ─────────────────────────
  // (--title, --body, --severity, --commit, --state, --limit, --out, --worksheet
  //  are already declared above and shared with other subcommands)
  '--affected-path', '--id', '--note', '--before',
  // ── write-spill <status|drain> (durable audit-store writes) ───────────────
  '--cap',
  // `--paths` is deliberately NOT here. An older acceptance criterion
  // (docs/plans/security/PLAN.md) shows `get-incident-neighbourhood --paths a,b`,
  // but `arch-memory-planning-anchor.md` R3-M1 later fixed the interface as
  // `--json '{"targetPaths":[…]}'` — "No `--paths` csv form" — and the handler
  // reads the payload. Allowlisting it would make the CLI ACCEPT the flag and
  // silently drop it: precisely the defect this guard exists to stop, and worse
  // than rejecting it, because the doc-following caller gets no signal. The
  // stale criterion has been corrected instead.
  // ── learning-backfill-outcomes ────────────────────────────────────────────
  '--dry-run', '--skip-drain', '--skip-resolve', '--rebuild-stats',
  // ── learning-quickfix-stats ───────────────────────────────────────────────
  '--bootstrap',
  // ── learning-replay (forwards `rest` to scripts/learning/replay.mjs) ──────
  '--policy', '--baseline', '--since',
];

function parsePayload() {
  const jsonIdx = rest.indexOf('--json');
  if (jsonIdx >= 0) {
    return JSON.parse(rest[jsonIdx + 1] || '{}');
  }
  const stdinIdx = rest.indexOf('--stdin');
  if (stdinIdx >= 0) {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  }
  // Also accept bare JSON as the last arg (common when skills interpolate)
  if (rest.length > 0 && rest[rest.length - 1].startsWith('{')) {
    return JSON.parse(rest[rest.length - 1]);
  }
  return {};
}

function argOption(name) {
  const idx = rest.indexOf(`--${name}`);
  if (idx < 0) return null;
  return rest[idx + 1] || null;
}

/** Comma-split a single `--name a,b,c` flag into a trimmed list. */
function argList(name) {
  const v = argOption(name);
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/** Collect EVERY occurrence of a repeatable `--name v` flag. */
function argAll(name) {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === `--${name}` && rest[i + 1] != null) out.push(rest[i + 1]);
  }
  return out;
}

/** Presence of a boolean `--flag`. */
function hasFlag(name) { return rest.includes(`--${name}`); }

/**
 * Emit a structured error + exit. Default exit code is 2 (BAD_INPUT /
 * validation failure) per the cross-skill CLI contract. Exceptions use
 * exit 1 and go through main()'s catch directly without this helper.
 */
function emitError(code, message, extra = {}, exitCode = 2) {
  emit({ ok: false, error: { code, message, ...extra } });
  process.exit(exitCode);
}

// ── Repo + commit resolution ────────────────────────────────────────────────

function currentCommitSha() {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return null; }
}

function currentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return null; }
}

/**
 * Resolve the STABLE storage repo id (`audit_repos.id`) for a cross-skill write.
 *
 * Cluster A (§2.1): resolve via the repo_uuid identity so `plans`,
 * `persona_audit_correlations`, `ship_events`, etc. attach to the SAME canonical
 * row the audit/learning path uses — instead of a fragmented fingerprint row or
 * NULL. Priority: explicit `repoId` → explicit `repoUuid` lookup →
 * resolveRepoForStore (current repo's identity).
 *
 * Returns `null` in any of: store disabled; an explicit `repoUuid` that does not
 * resolve to a row (genuine not-found — authoritative, we do NOT silently fall
 * back to the current repo); current-repo resolution fails. Callers treat null
 * as "no repo scope" — the cross-skill tables all accept NULL repo_id.
 *
 * A TRANSIENT DB error resolving an explicit `repoUuid` is NOT treated as
 * not-found: it fails the command closed (`emitError`) rather than silently
 * downgrading to an unscoped (`repo_id` null) write — see the strict lookup.
 */
async function resolveRepoId(payload) {
  if (payload.repoId) return payload.repoId;
  // An EXPLICIT repoUuid is authoritative. A genuine not-found → null (we never
  // redirect to the current repo). But a TRANSIENT lookup failure must NOT be
  // swallowed as null — that downgrades this explicit-repo write to an unscoped
  // write. Use the strict lookup and fail closed on a real DB error.
  if (payload.repoUuid) {
    let repo;
    try {
      repo = await getRepoIdByUuid(payload.repoUuid, { strict: true });
    } catch (err) {
      return emitError(
        'REPO_RESOLVE_FAILED',
        `repoUuid ${payload.repoUuid} lookup failed (transient DB error) — refusing an unscoped write rather than silently dropping repo scope: ${err.message}`,
        {}, 1,
      );
    }
    // A repoUuid that resolves to NOTHING is a wrong assertion, not "no scope".
    // Returning null here handed an unscoped `repo_id` to writers that accept
    // one — so a caller who named a specific repository, and named it wrongly,
    // got a successfully-written row belonging to no repository, reported as
    // `{ok:true}`. Same reasoning as `resolveShipNudgeScope`'s unknown-repo-id
    // branch: the operator asserted something specific and it is wrong, so say
    // so. (The transient-failure branch above already fails closed; this is the
    // not-found half it left open.)
    if (!repo?.id) {
      return emitError(
        'UNKNOWN_REPO',
        `repoUuid ${payload.repoUuid} does not resolve to any audit_repos row — refusing to write an unscoped row `
        + 'for an explicitly named repository. It is NOT "no repo scope"; the identity you supplied is unknown.',
        {}, 1,
      );
    }
    return repo.id;
  }
  // No explicit identity → resolve from the current repo (mints/finds canonical).
  //
  // Use the DISCRIMINATED resolver. The null-returning `resolveRepoForStore`
  // collapses three different facts into one value — cloud-off, genuinely
  // unresolvable, and a thrown DB error — and this function's result goes
  // straight into writers. Treating the third as "no repo scope" writes a row
  // with `repo_id = NULL` that no repo-scoped read will ever return again, and
  // reports it as `{ok:true}`: a permanent, silent data loss caused by a
  // transient failure. That is the same defect the explicit-`repoUuid` branch
  // above already fails closed on; this branch simply had not been fixed yet.
  const ref = await resolveRepoForStoreResult({}).catch(
    (err) => ({ kind: 'error', error: err?.message ?? String(err) }),
  );
  if (ref.kind === 'error') {
    return emitError(
      'REPO_RESOLVE_FAILED',
      `repo identity lookup failed (${ref.error}) — refusing an unscoped write rather than silently dropping repo scope. `
      + 'This is a transient store failure, NOT a repo without an identity; retry once the store is reachable.',
      {}, 1,
    );
  }
  // 'cloud-off' and 'unresolved' are genuine absences: the cross-skill tables all
  // accept a NULL repo_id, and callers that require a scope check for it.
  return ref.kind === 'resolved' ? ref.repoRowId : null;
}

// ── Subcommands ─────────────────────────────────────────────────────────────

// cmdUpsertPlan moved to scripts/lib/cross-skill/commands/plans.mjs (registry).

// cmdUpdatePlanStatus moved to scripts/lib/cross-skill/commands/plans.mjs (registry).

// cmdRecordRegressionSpec moved to scripts/lib/cross-skill/commands/ship.mjs (registry).

// cmdRecordRegressionSpecRun moved to scripts/lib/cross-skill/commands/ship.mjs (registry).

// cmdRecordCorrelation moved to scripts/lib/cross-skill/commands/persona.mjs (registry).

// cmdRecordPlanVerifyRun moved to scripts/lib/cross-skill/commands/plan-verify.mjs (registry).

// cmdRecordPlanVerifyItems moved to scripts/lib/cross-skill/commands/plan-verify.mjs (registry).

// cmdPlanSatisfaction moved to scripts/lib/cross-skill/commands/plans.mjs (registry).

const NAV_AUDIT_RUN_SCOPES = ['full', 'diff'];

// cmdRecordNavAuditRun moved to scripts/lib/cross-skill/commands/misc.mjs (registry).

// cmdGetNavFirstSeen moved to scripts/lib/cross-skill/commands/misc.mjs (registry).

// cmdRecordShipEvent moved to scripts/lib/cross-skill/commands/ship.mjs (registry).

/**
 * Resolve the repository scope for the /ship-nudge readers — the unlocked-fix
 * backlog (Step 0.5b), its lock worksheet, and the unremediated-acceptance
 * backlog (Step 0.5e). All of them print a number the operator reads as
 * "obligations belonging to THIS repo", so all of them scope identically.
 *
 * **Order is the contract — it short-circuits, and explicit operator intent is
 * evaluated BEFORE ambient inference.** Putting `--all-repos` last (the first
 * draft) made it unreachable: ambient identity resolves inside any git repo, so
 * the chain terminated before the flag was ever read, and the flag was silently
 * ignored — the very defect this function exists to fix, reproduced in its fix.
 *
 *   1. `--all-repos`      → explicit global, self-labelled in the output
 *   2. `--repo-id <uuid>` → scope to it
 *   3. `--repo <slug>`    → resolve slug → repo_id; unknown slug is an ERROR
 *   4. ambient identity   → scope to this repo (the new default)
 *   5. unresolvable       → measured:false + reason; NEVER global
 *
 * @returns {Promise<{mode:'repo'|'all-repos'|'unresolved', repoId:string|null, slug:string|null, measured:boolean, reason:string|null, error?:string}>}
 */
// resolveShipNudgeScope moved to scripts/lib/cross-skill/commands/ship.mjs (registry).

/** The store-scope argument for a resolved scope (D18 explicit-scope contract). */
const storeScopeFor = (scope) => (scope.mode === 'all-repos' ? { allRepos: true } : { repoId: scope.repoId });

/**
 * `--limit` / `--offset` for the capped /ship-nudge readers.
 *
 * `--limit` is a globally-registered flag, so `assertKnownFlags` accepted it on
 * these subcommands long before any handler read it: it parsed, it validated, and
 * it did nothing. That is the accepted-and-inert shape this CLI has now been bitten
 * by three times (`--repo` ignored in favour of `--repo-id`, `--report-path`
 * unregistered, and this). The store clamps the values; passing them through
 * unparsed keeps one owner for the bounds.
 */
const pageArgsFromFlags = () => ({ limit: argOption('limit'), offset: argOption('offset') });

// cmdListUnlockedFixes moved to scripts/lib/cross-skill/commands/ship.mjs (registry).

// cmdListUnremediatedAcceptances moved to scripts/lib/cross-skill/commands/ship.mjs (registry).

// cmdAuditEffectiveness moved to scripts/lib/cross-skill/commands/misc.mjs (registry).

// ── Shadow final-review A/B (docs/plans/final-review-shadow-reviewer.md) ──────

/**
 * Pre-fetch disconfirming evidence for one queued finding.
 *
 * Best-effort by contract: this decorates a review surface, so any failure
 * (unreadable file, path outside the repo) must degrade to "no note" rather
 * than break the worksheet the operator is waiting on.
 *
 * @param {{primary_file?: string, detail_snapshot?: string}} f
 * @returns {string} note, or '' when the finding is clean / uncheckable
 */
// groundingNoteFor moved to scripts/lib/cross-skill/commands/final-review.mjs (registry).

// cmdFinalReviewStats moved to scripts/lib/cross-skill/commands/final-review.mjs (registry).

// cmdFinalReviewAdjudicate moved to scripts/lib/cross-skill/commands/final-review.mjs (registry).

/**
 * Findings awaiting credit — the READ that makes `/ship`'s nudge possible.
 *
 * `final-review-{adjudicate,record-fix}` have existed, tested, since the shadow
 * A/B closed. Nothing called them: no SKILL.md referenced either, so
 * `user_action` stayed null and credit landed only in source comments. This
 * command is the missing half — a discriminated, versioned result a shell caller
 * can act on.
 *
 * **Three states, exit 0 for all of them.** `ready` / `disabled` /
 * `unavailable` — because `/ship` must continue through every one of them. A
 * credit nudge that can fail a ship is worse than no nudge.
 *
 * `--render --commit <sha>` returns the finished card TEXT instead of JSON, so
 * the skill has one shell command to run and print. Same renderer either way:
 * the unit-tested function and the text the operator sees cannot drift.
 *
 * The `unavailable` diagnostic is a CODE from a closed set — never `err.message`,
 * whose contents can include a DSN or key.
 */
// cmdFinalReviewPending moved to scripts/lib/cross-skill/commands/final-review.mjs (registry).

/**
 * Record that an accepted final-review finding was actually FIXED.
 *
 * The closing edge of the shadow A/B loop. `final-review-adjudicate` writes the
 * adjudication axis (accepted/dismissed); nothing could write the remediation
 * axis for these findings, because the only `remediation_state` writer projects
 * from the /audit-code ledger, which final-review findings never enter. That
 * made "accepted but never fixed" — the strongest argument against keeping the
 * second gate — an artifact of missing plumbing rather than a measurement.
 *
 * Deliberately separate from `--action`: accepted and fixed are orthogonal axes
 * (AGENTS.md two-axis model), and collapsing them would make "accepted, fix
 * pending" unrepresentable.
 */
// cmdFinalReviewRecordFix moved to scripts/lib/cross-skill/commands/final-review.mjs (registry).

// ── Model-A/B/C experiment harness (Cluster C) ──────────────────────────────

/**
 * Blinded human adjudication queue + writeback (plan decision 5a, mirrors
 * final-review-adjudicate). With no --action → PRESENTS the blinded queue
 * (source_model hidden; likely-equivalents adjacent). With --action →
 * writes the outcome (`accepted|dismissed|duplicate|not-actionable`);
 * `duplicate` needs --canonical <fingerprint>.
 */
// cmdModelAbAdjudicate moved to scripts/lib/cross-skill/commands/model-eval.mjs (registry).

/** Aggregate scorer rows + the cost–quality FRONTIER + cumulative spend vs budget (D7). */
// cmdModelAbStats moved to scripts/lib/cross-skill/commands/model-eval.mjs (registry).

// ── Unified arm-evaluation framework (plan-authoring + brainstorm) ───────────
// Thin handlers over scripts/lib/arm-eval/* (orchestration lives there, not in
// this facade). All graceful no-op when cloud is off.

/** Run ONE arm-eval session (produce → judge → cross-check → persist). Spends. */
// cmdArmEvalRun moved to scripts/lib/cross-skill/commands/model-eval.mjs (registry).

/** Two-level verdict for an experiment (gate → paired-delta rank + τ anchor + frontier). */
// cmdArmEvalDecision moved to scripts/lib/cross-skill/commands/model-eval.mjs (registry).

/** Leaderboard aggregate rows (repo-scoped unless --all-repos). */
// cmdArmEvalStats moved to scripts/lib/cross-skill/commands/model-eval.mjs (registry).

/** Blinded human spot-check: present a session's outputs (arm hidden), or record a ranking. */
// cmdArmEvalAdjudicate moved to scripts/lib/cross-skill/commands/model-eval.mjs (registry).

/**
 * (Re)generate the committed session archive under docs/arm-eval/sessions/.
 * `--session-id <id>` for one session, `--all` (+ --repo-id / --all-repos) for
 * every session. Blinding rule lives in lib/arm-eval/export.mjs — a
 * prospective session without a human ranking exports BLINDED.
 */
// cmdArmEvalExport moved to scripts/lib/cross-skill/commands/model-eval.mjs (registry).

/**
 * One-command experiment toggle: `arm-eval-toggle on|off|status [--budget-eur N]`.
 * `on` → shadow arms B,C activate for /audit-code + /audit-plan, and /plan +
 * /brainstorm start capturing arm-eval sessions. `off` → everything inert.
 * Explicit AUDIT_MODEL_SHADOW env always wins over the toggle (kill switch).
 */
// cmdArmEvalToggle moved to scripts/lib/cross-skill/commands/model-eval.mjs (registry).

/**
 * Conditional capture hook for /plan and /brainstorm (toggle-gated, silent
 * no-op when off — safe to call unconditionally from the skills). When the
 * toggle is on, runs ONE arm-eval session for the given experiment + task
 * under the toggle's budget.
 */
// cmdArmEvalMaybeCapture moved to scripts/lib/cross-skill/commands/model-eval.mjs (registry).

/** Best-effort repo UUID for capture attribution; null when unresolvable. */
/**
 * The ambient repo **UUID** (v5) — NOT `audit_repos.id` (v4).
 *
 * Renamed 2026-07-31: it was called `resolveRepoIdentityQuiet` and three call sites
 * bound its result to a variable named `repoId` and queried on it. Those queries match
 * nothing and report an authoritative empty result for a repo that was never queried.
 * Callers must translate via `resolveRepoScope` — the name now says which id it is.
 */
/**
 * Resolve a v4 `audit_repos.id` for a command, from `--repo-id` or ambient identity.
 *
 * Every call site that previously did `argOption('repo-id') || await resolveRepoUuidQuiet()`
 * was mixing the two id spaces — the fallback returned a v5 uuid that then went into a
 * query keyed on the v4 id. Five sites did this, and each one reported a clean empty
 * result for a repo it never actually queried.
 *
 * @returns {Promise<{ok: true, repoId: string|null} | {ok: false, code: string, message: string}>}
 *   `repoId: null` means "no ambient identity" — callers proceed unscoped exactly as
 *   before. `ok:false` distinguishes unknown-repo and lookup-failure, which must NEVER
 *   render as an empty-but-clean result.
 */
/**
 * Resolve the repo scope for a command whose DOCUMENTED flag is `--repo <name>`,
 * so that flag actually decides which repo is read or written.
 *
 * The bug this replaces, found in TWO commands independently: the repo was read
 * from two unrelated sources — `repoName` from `--repo`, and `repoId` from
 * `resolveScopedRepoId()` / `resolveRepoForStore({})`, neither of which ever
 * looks at `--repo`. Both stores then prefer the id:
 *
 *   - `persona-outcomes` (`store/persona-outcomes.mjs`) uses `repo_id` when
 *     non-null and only falls back to `repo_name`, so `--repo other/repo`
 *     queried THIS repo and labelled the answer with the other repo's name.
 *     `backfill-hash` is MUTATING, so it would migrate this repo's rows under
 *     the other repo's name in its log line.
 *   - `get-persona-sessions-by-repo` (`store/persona.mjs`) requires BOTH
 *     (`WHERE repo_name = $1 AND (repo_id = $3 OR repo_id IS NULL)`), so a
 *     foreign `--repo` returned `rows: []` **with `scopedByRepoId: true`** —
 *     an authoritative empty result, for a repo that has sessions, wearing a
 *     field that asserts it was correctly scoped. Measured 2026-08-12 against
 *     the live store from a `claude-engineering-skills` checkout.
 *
 * ONE resolver for both: a second copy is how the two drifted in the first
 * place. Precedence is explicit-beats-ambient, and the two explicit forms may
 * not disagree — a conflict is an error, never a silent winner.
 *
 * @param {string} repoName - the value of `--repo` (already required by caller)
 * @returns {Promise<{ok:true, repoId:string|null} | {ok:false, code:string, message:string}>}
 */
async function resolveRequestedRepoScope(repoName) {
  const explicitId = argOption('repo-id');
  // Cloud-off resolves nothing by name; report that as the callers' documented
  // `cloud:false` path rather than as an unknown repo.
  if (!await isCloudEnabled()) return { ok: true, repoId: explicitId || null };

  // A thrown lookup is NOT "this repo does not exist". Swallowing it to null
  // sent the caller `UNKNOWN_REPO — expected an owner/repo slug present in
  // audit_repos`, i.e. told them their correct repo name was wrong because the
  // store was unreachable. Same failure-state collapse as F7/F9, reproduced in
  // the fix for F4 — which is exactly how this family keeps regenerating.
  let byName;
  try {
    byName = await getRepoIdByName(repoName);
  } catch (err) {
    return { ok: false, code: 'REPO_LOOKUP_FAILED',
      message: `could not resolve repo "${repoName}" (${err.message}) — the store was unreachable, `
        + 'so this is NOT an unknown repo and NOT an empty result; nothing was measured.' };
  }

  if (explicitId && byName && explicitId !== byName) {
    return { ok: false, code: 'REPO_SCOPE_CONFLICT',
      message: `--repo "${repoName}" resolves to ${byName} but --repo-id says ${explicitId} — `
        + 'these name different repositories; pass only one.' };
  }
  // An unresolvable `--repo` is an error EVEN WITH a valid `--repo-id`. Letting
  // the id win silently accepted a `--repo` naming a repo that does not exist,
  // which is the same "asserted something specific, and it was wrong" case the
  // conflict branch above refuses. (Audit r2 caught this in the first version
  // of this very function.)
  if (!byName) {
    return { ok: false, code: 'UNKNOWN_REPO',
      message: `unknown repo "${repoName}" — expected an owner/repo slug present in audit_repos. `
        + 'It is NOT an empty result; nothing was measured.' };
  }
  return { ok: true, repoId: explicitId || byName };
}

async function resolveScopedRepoId() {
  const scope = await resolveRepoScope({
    explicitRepoId: argOption('repo-id') || null,
    resolveRepoUuid: resolveRepoUuidQuiet,
    getRepoIdByUuid: (uuid, opts) => getRepoIdByUuid(uuid, opts),
  });
  switch (scope.kind) {
    case 'scoped':        return { ok: true, repoId: scope.repoId };
    case 'no-identity':   return { ok: true, repoId: null };
    case 'unknown-repo':
      return { ok: false, code: 'UNKNOWN_REPO',
        message: `no audit_repos row for this checkout (repo_uuid ${scope.repoUuid}) — `
          + 'run `cross-skill.mjs resolve-repo-identity --persist`, or pass --repo-id' };
    default:
      return { ok: false, code: 'REPO_RESOLVE_FAILED',
        message: `repo lookup failed (${scope.error}) — refusing an unscoped query` };
  }
}

async function resolveRepoUuidQuiet() {
  try {
    const { resolveRepoIdentity } = await import('./lib/repo-identity.mjs');
    const r = await resolveRepoIdentity();
    return r?.repoUuid || null;
  } catch { return null; }
}

/** Two-level decision: quality GATE → weighted-quality RANK + recall + frontier (D5–D8). */
// cmdModelAbDecision moved to scripts/lib/cross-skill/commands/model-eval.mjs (registry).

/**
 * Deterministic outcome capture (Determinism follow-ups WS1 Phase 2). The
 * orchestrator (audit-loop.mjs / /cycle Step 3C) calls this ONCE after the
 * audit converges, with the unified `--run-id`, the final adjudicated
 * `--ledger`, and the final-round `--result` (for the finding set). It joins
 * ledger → findings by fingerprint, drives the existing outcome sync (the same
 * path the manual Step 3.5b uses), then reconciles: any finding the ledger
 * never adjudicated is flagged `needs_triage` (never silently dark-dropped).
 *
 * Idempotent by construction — the underlying writes set state by
 * (run_id, fingerprint) / delete+insert, so a retry after a crash converges to
 * the same state. (Strict single-transaction wrapping is deliberately deferred:
 * each underlying write is individually idempotent, so a mid-finalize crash
 * self-heals on the next deterministic re-run — the §1.5-gated property is
 * idempotency, which holds.)
 *
 * Graceful (§1.3b R2-H2): AUDIT_DB_URL unset → local-only no-op (safe to call
 * unconditionally). Cloud configured but the run_id genuinely absent → hard
 * error (the orchestrator threaded a bad id).
 */
// cmdFinalizeOutcomes moved to scripts/lib/cross-skill/commands/plans.mjs (registry).

// ── Persona-test subcommands (replace curl blocks in persona-test SKILL.md) ──

const ListPersonasRequestSchema = z.object({
  url: z.url(),
});

// cmdListPersonas moved to scripts/lib/cross-skill/commands/persona.mjs (registry).

const AddPersonaRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  appUrl: z.url(),
  appName: z.string().optional(),
  notes: z.string().optional(),
  repoName: z.string().optional(),
});

// cmdAddPersona moved to scripts/lib/cross-skill/commands/persona.mjs (registry).

const RecordPersonaSessionRequestSchema = z.object({
  // OPTIONAL since WS-C2 — omit it and the CLI mints a collision-resistant id
  // via buildPersonaSessionId (the single oracle). Pass one explicitly ONLY to
  // re-post an existing session: session_id is the idempotency key, so a
  // supplied value is honoured verbatim, legacy weak ids included.
  sessionId: z.string().min(1).optional(),
  persona: z.string().min(1),
  url: z.url(),
  focus: z.string().optional(),
  browserTool: z.string().min(1),
  stepsTaken: z.number().int().nonnegative().optional(),
  verdict: z.enum(['Ready for users', 'Needs work', 'Blocked']),
  p0Count: z.number().int().nonnegative().optional(),
  p1Count: z.number().int().nonnegative().optional(),
  p2Count: z.number().int().nonnegative().optional(),
  p3Count: z.number().int().nonnegative().optional(),
  avgConfidence: z.number().min(0).max(1).optional(),
  findings: z.array(z.any()).optional(),
  reportMd: z.string().optional(),
  debriefMd: z.string().optional(),
  commitSha: z.string().optional(),
  deploymentId: z.string().optional(),
  repoName: z.string().optional(),
  repoId: z.string().optional(),
  personaId: z.string().optional(),
  // WS1 — deterministic persona<->audit correlator. Default ON; the caller
  // (persona-test skill) can pass `false` when audit_link context isn't
  // resolvable, matching today's opt-in gate.
  autoCorrelate: z.boolean().default(true),
  // LENIENT at the request boundary (Gemini1-H2/Gemini2-M2): a malformed or
  // over-length clickPath entry must NOT fail the whole session record. The cap
  // (40), per-entry ClickPathStepSchema validation + drop-invalid, and the
  // sanitize/redact controls all live in recordPersonaSession (store/persona.mjs).
  clickPath: z.array(z.unknown()).optional(),
});

// cmdRecordPersonaSession moved to scripts/lib/cross-skill/commands/persona.mjs (registry).

/**
 * WS1 — deterministic persona<->audit correlator orchestration. Runs
 * automatically after the session row commits (the invocation the agent
 * already makes for `record-persona-session` — no separate discretionary
 * step). ALWAYS returns a structured summary (never throws to the caller,
 * never silently no-ops) so `attempted: false` + a `reason` and
 * `attempted: true` + a real failure are both externally visible, per
 * docs/plans/persona-nav-feedback-recovery.md WS1.
 * @returns {Promise<object>} correlationSummary
 */
// runAutoCorrelate moved to scripts/lib/cross-skill/commands/persona.mjs (registry).

// cmdPersonaOutcomes (WS4 outcome labels) moved to scripts/lib/cross-skill/commands/persona.mjs (registry).

// ── Persona session readers (post-RLS-hardening — service-role only) ──────
//
// Replaces curl-with-anon-key reads in:
//   skills/persona-test/references/{interop,session-history}.md
//   skills/plan/SKILL.md (Phase 1 pre-step)
//   skills/ship/SKILL.md (Step 0.5a)
// after the 20260507 RLS hardening. Anon reads are blocked at the policy
// boundary; this CLI surface is now the only supported read path.

const GetPersonaSessionsByRepoSchema = z.object({
  repoName: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  p0Only: z.boolean().optional(),
  select: z.array(z.string().min(1)).optional(),
});

// cmdGetPersonaSessionsByRepo moved to scripts/lib/cross-skill/commands/persona.mjs (registry).

/**
 * get-reachability-evidence — per-persona reached destinations for /nav-audit
 * --bootstrap seeding. Cloud-off / reader-error both degrade to `{personas:[]}`
 * (the store already swallows DB errors), so --bootstrap never aborts (R1-M5/R2-H2).
 */
// cmdGetReachabilityEvidence moved to scripts/lib/cross-skill/commands/persona.mjs (registry).

/**
 * À-la-carte "what's worth running next" advisor (skill-recommender.mjs). Gathers
 * the signals — changed files (git, or `--changed`), live-URL env, audit findings
 * (`--findings <file>`, highest signal), plan lenses (`--plan-lenses`), and the
 * idempotent ux-lock signal (`unlocked_fixes` view) — and emits the ranked, capped,
 * possibly-empty recommendation set + a human card. Deterministic, nudge-not-gate,
 * silent when nothing fits.
 */
// cmdRecommendSkills moved to scripts/lib/cross-skill/commands/ship.mjs (registry).

/**
 * preview-gate — resolve the deploy-topology gate for /cycle Step 5 from `PREVIEW_GATE_MODE`
 * (config SSoT). The executable seam the cycle SKILL CALLS (never re-implements the decision in
 * prose). Prints {mode, action, message}; `--format human` prints a one-line directive.
 */
// cmdPreviewGate moved to scripts/lib/cross-skill/commands/ship.mjs (registry).

/** Changed files vs HEAD (tracked) + untracked. Empty on any git failure. */
// gitChangedFiles moved to scripts/lib/cross-skill/commands/ship.mjs (registry).

// /persona-test Phase 0d pre-test enrichment: recent HIGH/MEDIUM audit
// findings for a repo, so the persona explores known-fragile flows with
// sharper Reflect judgement. Replaces the dead PostgREST curl (M4 removed
// supabase-js). Graceful empty result when cloud is off or the repo is
// unknown — the skill treats `[]` as "no audit context", never an error.
// cmdGetRecentFindings moved to scripts/lib/cross-skill/commands/persona.mjs (registry).

const GetPersonaSessionsByUrlSchema = z.object({
  url: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  select: z.array(z.string().min(1)).optional(),
});

// cmdGetPersonaSessionsByUrl moved to scripts/lib/cross-skill/commands/persona.mjs (registry).

// cmdDetectStack moved to scripts/lib/cross-skill/commands/misc.mjs (registry).

// cmdWhoami moved to scripts/lib/cross-skill/commands/misc.mjs (registry).

// ── Architectural Memory subcommands (Phase A) ──────────────────────────────

// cmdGetActiveRefreshId moved to scripts/lib/cross-skill/commands/arch-query.mjs (registry).

// cmdGetIncidentNeighbourhood moved to scripts/lib/cross-skill/commands/arch-query.mjs (registry).

// ── Friction-feedback loop (plan: friction-feedback-loop.md) ────────────────
// `quality` sub-dispatches to add/mirror/digest/link/session-review; the
// implementations live in lib/friction/commands.mjs (thin-dispatcher discipline,
// R1-MED). Every command returns the C8 shape; ok:false = argv/contract error.

// cmdQuality moved to scripts/lib/cross-skill/commands/quality.mjs (registry).

// ── Upstream issue reports (plan: upstream-issue-reports.md) ────────────────
// `upstream` sub-dispatches to report/list/ack/fix/wont-fix/drain; the
// implementations live in lib/upstream/commands.mjs (thin-dispatcher
// discipline, same shape as `quality`).

/** Read the report body from stdin — multiline prose must never be an argv string. */
// readStdinBody moved to scripts/lib/cross-skill/commands/quality.mjs (registry).

// cmdUpstream moved to scripts/lib/cross-skill/commands/quality.mjs (registry).

// ── Durable audit-store writes (plan: audit-store-write-durability.md) ──────

/**
 * `write-spill status | drain` — the operator surface over the write-spill queue.
 *
 * The queue holds audit-store writes that failed with the store unreachable. It
 * drains on its own at the start of the next audit run; this command exists for
 * the case where the operator wants to see the backlog, or clear it without
 * running an audit.
 *
 * TWO THINGS MAKE THIS MORE THAN A WRAPPER:
 *
 *  1. The registry is PROCESS-LOCAL, and this is a fresh process. Without
 *     importing `audit-store-writers.mjs` here the drain would find zero
 *     handlers and quarantine every artifact it was asked to replay — the
 *     bootstrap contradiction the plan's R2 gate caught. `drainSpill` refuses to
 *     start on an empty registry, so the failure is loud either way, but the
 *     import is what makes it work.
 *  2. `unavailable` is NOT `drained: 0`. An explicit drain that could not run is
 *     an error to the caller who asked for it, not a footnote on a success
 *     envelope — the same rule `upstream drain` above follows.
 */
// cmdWriteSpill moved to scripts/lib/cross-skill/commands/misc.mjs (registry).

// cmdGetFrictionNeighbourhood moved to scripts/lib/cross-skill/commands/misc.mjs (registry).

// cmdComputeTargetDomains moved to scripts/lib/cross-skill/commands/arch-query.mjs (registry).

// cmdGetCallersForFile moved to scripts/lib/cross-skill/commands/arch-query.mjs (registry).

/**
 * Same-run overlap between a shadow reviewer and the pipeline's own audit
 * passes — the marginal-value check for any reviewer A/B. See
 * scripts/lib/model-eval/shadow-overlap.mjs for how to read the result
 * (notably: it measures WITHIN-run overlap only).
 *
 * Payload: {"runIds": ["<uuid>", ...], "shadowPass": "final-review-shadow"}
 */
// cmdShadowOverlap moved to scripts/lib/cross-skill/commands/final-review.mjs (registry).

/**
 * Record a unit/integration test as the regression lock for an audit finding.
 *
 * REUSES `recordRegressionSpec` — a `unit-test` row has the identical shape to
 * an `audit-loop-fix` one (spec_path carries the test path), so a sibling
 * writer would be duplication. What lives HERE and not in the store layer is
 * the disk check: the store has no business touching the filesystem, and the
 * claim being verified ("this test file exists") is a CLI-boundary fact.
 *
 * The refusal is the point. A row saying "tests/foo.test.mjs locks finding X"
 * is a CLAIM, and closing 119 obligations by matching `primary_file` to a
 * same-named test would have moved the number while proving nothing — file
 * existence is not coverage, and a same-named file is not even existence. So:
 * the path must resolve inside the repo, and `--description` is required so
 * the operator states what the test actually pins. Neither check proves
 * semantic coverage; together they refuse the cheapest ways to fake it.
 *
 * Flags: --finding (audit_finding_id uuid), --test (repo-relative path),
 * --description (what the test pins). Angle-bracket syntax is avoided even
 * here so a copied line stays PowerShell-safe.
 */
// cmdLockWithTest moved to scripts/lib/cross-skill/commands/ship.mjs (registry).

/**
 * Operator worksheet for the unlocked-code backlog.
 *
 * Emits markdown with REAL values and pasteable commands (never
 * `<angle-brackets>` — PowerShell reserves `<`, so a bracketed example is
 * unpasteable on the platform this repo is developed on).
 *
 * The suggested test is a FILENAME HEURISTIC and is labelled as one. It searches
 * `tests/**` for a file named after `primary_file`'s basename and reports what it
 * found. It does NOT establish that the test covers the finding — that judgement
 * is the operator's, which is why this emits a queue for review instead of
 * writing rows.
 *
 * The search replaced a single `tests/<base>.test.mjs` guess (reported from
 * wine-cellar-app 2026-08-01). That guess encodes THIS repo's flat layout and
 * extension; a consumer using `tests/unit/**\/<name>.test.js` got "none found —
 * write one" for findings whose test already existed, and following the
 * worksheet would have produced duplicate suites.
 */
// cmdLockWithTestWorksheet moved to scripts/lib/cross-skill/commands/ship.mjs (registry).

// cmdGetNeighbourhood moved to scripts/lib/cross-skill/commands/arch-query.mjs (registry).

// cmdOpenRefreshRun moved to scripts/lib/cross-skill/commands/arch-refresh.mjs (registry).

// cmdPublishRefreshRun moved to scripts/lib/cross-skill/commands/arch-refresh.mjs (registry).

// cmdAbortRefreshRun moved to scripts/lib/cross-skill/commands/arch-refresh.mjs (registry).

// cmdRecordSymbolDefinitions moved to scripts/lib/cross-skill/commands/arch-refresh.mjs (registry).

// cmdRecordSymbolIndex moved to scripts/lib/cross-skill/commands/arch-refresh.mjs (registry).

// cmdRecordSymbolEmbedding moved to scripts/lib/cross-skill/commands/arch-refresh.mjs (registry).

// cmdRecordLayeringViolations moved to scripts/lib/cross-skill/commands/arch-refresh.mjs (registry).

// cmdSetActiveEmbeddingModel moved to scripts/lib/cross-skill/commands/arch-refresh.mjs (registry).

// cmdListSymbolsForSnapshot moved to scripts/lib/cross-skill/commands/arch-query.mjs (registry).

// cmdListLayeringViolationsForSnapshot moved to scripts/lib/cross-skill/commands/arch-query.mjs (registry).

// cmdComputeDriftScore moved to scripts/lib/cross-skill/commands/arch-query.mjs (registry).

// cmdResolveRepoIdentity moved to scripts/lib/cross-skill/commands/arch-query.mjs (registry).

// ── Phase 1 — adaptive-learning-v1 subcommands ─────────────────────────────

/**
 * Generic decision recorder.  Used by external skills/scripts that don't want
 * to import scripts/lib/learning/decision-logger.mjs directly (e.g. shell
 * pipelines).  Validates input shape, derives decision_key, inserts row.
 */
// cmdLearningRecord moved to scripts/lib/cross-skill/commands/misc.mjs (registry).

/**
 * Stats snapshot for human inspection or weekly review.  Currently emits
 * counts of pending_triage_findings + no_brainer_recommendations + stale
 * clusters per repo.  Phase 2 extends with quickfix-pattern stats.
 */
// cmdLearningStats moved to scripts/lib/cross-skill/commands/learning.mjs (registry).

/**
 * Weekly review — delegates to scripts/learning/weekly-review.mjs.
 * Provides a stable cross-skill subcommand surface so package.json and
 * the GH workflow can invoke `cross-skill.mjs learning-weekly-review`
 * uniformly.
 */
// cmdLearningWeeklyReview moved to scripts/lib/cross-skill/commands/learning.mjs (registry).

/**
 * Backfill quickfix outcomes — Phase 2.  Drains the local hits JSONL into
 * `learning_decisions`, then resolves outcomes for unresolved hits older
 * than 30 minutes by examining current file state.  Optionally rebuilds
 * the `quickfix-pattern-stats.json` cache afterward (--rebuild-stats).
 */
// cmdLearningBackfillOutcomes moved to scripts/lib/cross-skill/commands/learning.mjs (registry).

/**
 * Friction-log capture — `audit:wtf <message>`.  Quick-write CLI for
 * real-time operator annoyance.  Plan: friction-log-and-digest-v1.md.
 */
// cmdFrictionLog moved to scripts/lib/cross-skill/commands/misc.mjs (registry).

/**
 * Replay CLI bridge — Phase 3.  Wraps `scripts/learning/replay.mjs` so
 * package.json + workflow scripts can route through cross-skill.mjs
 * uniformly.  Forwards all positional + flag args to the CLI runner.
 */
// cmdLearningReplay moved to scripts/lib/cross-skill/commands/learning.mjs (registry).

/**
 * Quickfix-stats CLI bridge — Phase 2.  Wraps
 * `scripts/lib/learning/quickfix-stats.mjs` so package.json + workflow
 * scripts route through cross-skill.mjs uniformly.
 */
// cmdLearningQuickfixStats moved to scripts/lib/cross-skill/commands/learning.mjs (registry).

// ── Dispatcher ──────────────────────────────────────────────────────────────

// ── Dispatch ────────────────────────────────────────────────────────────────
//
// The legacy `commands` map is GONE (Phase 5). Every one of the 71 subcommands
// is a registry entry now, so this file no longer holds a second dispatch
// surface that could disagree with the first. The conservation law the
// migration ran under (`registry ∪ legacy = INVENTORY`, disjoint) collapses to
// `registry === INVENTORY`, which is what the ratchet asserts from here on.
const commands = Object.freeze({});

async function main() {
  // Global flag validation stays for EVERY invocation during migration: it is
  // a superset acceptor (registry commands' flags remain listed in
  // KNOWN_FLAGS until Phase 5 retires it), and the registry path then applies
  // the STRICTER per-command validation inside dispatch(). Deleted with the
  // legacy map in Phase 5.
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'cross-skill.mjs' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    // Sorted union of both dispatch surfaces — a migrated command must not
    // vanish from help. (Sorted, not map-order: names MOVE between the maps
    // during migration, and a stable order beats an order that shuffles per
    // cohort. The help listing is a human surface; nothing parses it.)
    const names = [...Object.keys(commands), ...registryCommandNames()].sort();
    process.stdout.write(
      'Usage: node scripts/cross-skill.mjs <subcommand> [--json <payload>|--stdin]\n\n' +
      'Subcommands:\n' +
      names.map(k => `  ${k}`).join('\n') + '\n'
    );
    process.exit(0);
  }
  // Introspection for the registry conformance/ratchet suites: the registry
  // and legacy name sets, as the RUNNING CLI sees them — the conservation law
  // (`registry ∪ legacy = INVENTORY`, disjoint) is asserted against this, not
  // against source text. Diagnostic surface, same family as
  // --selfcheck-relocation.
  if (process.argv.includes('--inventory-json')) {
    process.stdout.write(`${JSON.stringify({
      registry: registryCommandNames().sort(),
      legacy: Object.keys(commands).sort(),
    })}\n`);
    process.exit(0);
  }
  // Registry path (docs/plans/cross-skill-command-registry.md D1): a name in
  // the registry is served here ONLY — a loader failure is a hard error,
  // never a fallback to the legacy map (falling back would mask a real loader
  // defect as working legacy behaviour).
  if (getCommand(subcommand)) {
    const r = await dispatch(process.argv, {});
    if (r.envelope) emit(r.envelope);
    process.exit(r.exitCode);
  }
  const handler = commands[subcommand];
  if (!handler) {
    emitError('UNKNOWN_SUBCOMMAND', `Unknown subcommand: ${subcommand}`, {
      validSubcommands: [...Object.keys(commands), ...registryCommandNames()].sort(),
    });
    // emitError exited — unreachable, but kept as belt-and-braces
    return;
  }
  try {
    await handler();
  } catch (err) {
    emit({ ok: false, error: { code: 'EXCEPTION', message: err.message, stack: err.stack } });
    process.exit(1);
  }
}

main();
