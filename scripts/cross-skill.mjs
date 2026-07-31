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
  listConsistencyCandidates,
  promoteRegressionSpec,
  recordPersonaAuditCorrelation,
  getCandidateAuditFindings,
  getExistingCorrelationHashesForSession,
  recordShipEvent,
  recordPlanVerificationRun,
  recordPlanVerificationItems,
  readPlanSatisfaction,
  readPersistentPlanFailures,
  getUnlockedFixes,
  findUnlockedFixInRepo,
  countUnlockedFixes,
  getUnremediatedAcceptances,
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
  // Phase 3 WS-PIPE1 — persona_test_candidates aggregation table.
  upsertPersonaTestCandidate,
  listPersonaTestCandidates,
  markPersonaTestCandidateProposed,
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
import { isControlMarkerDetail } from './lib/audit/control-markers.mjs';
import { getLearningStats } from './lib/learning/stats.mjs';
import { emit, assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import {
  classifyFinalReviewOutcome, summariseCounts, orderItems, isActionable, renderFinalReviewCard,
} from './lib/final-review-credit.mjs';
import { resolveRepoIdentity, persistRepoIdentity } from './lib/repo-identity.mjs';
import { getNeighbourhoodForIntent } from './lib/neighbourhood-query.mjs';
import { detectRepoStack, detectPythonEnvironmentManager } from './lib/repo-stack.mjs';
import { StackProfileSchema, ReachabilityEvidenceRequestSchema, ReachabilityEvidenceResponseSchema } from './lib/schemas.mjs';
import { recommendSkills, renderRecommendationCard } from './lib/skill-recommender.mjs';
import { resolvePreviewGate } from './lib/cycle/topology.mjs';
import { cycleConfig } from './lib/config.mjs';
import { decideCorrelations, MATCHER_VERSION, personaFindingHash } from './lib/persona/audit-correlator.mjs';
import { buildPersonaSessionId } from './lib/persona-test/session-id.mjs';
import { recordNavAuditRun, listNavAuditRunHistory } from './lib/store/nav-audit.mjs';
import { upsertPersonaFindingOutcome, getPersonaOutcomesSummary, getActionablePersonaOutcomeItems, resolveLabelTarget } from './lib/store/persona-outcomes.mjs';
import { backfillPersonaFindingHashV2 } from './lib/store/persona-outcomes-hash-backfill.mjs';
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
  // ── Shared identity / scoping flags (many subcommands) ────────────────────
  '--repo', '--repo-id', '--repo-uuid', '--limit', '--format', '--out', '--cwd',
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
    return repo?.id ?? null;
  }
  // No explicit identity → resolve from the current repo (mints/finds canonical).
  const ref = await resolveRepoForStore({}).catch(() => null);
  return ref?.repoRowId ?? null;
}

// ── Subcommands ─────────────────────────────────────────────────────────────

async function cmdUpsertPlan() {
  const p = parsePayload();
  if (!p.path || !p.skill) return emitError('BAD_INPUT', 'path and skill are required');
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, planId: null });
  const repoId = await resolveRepoId(p);
  const planId = await upsertPlan(repoId, {
    path: p.path,
    skill: p.skill,
    status: p.status,
    principlesCited: p.principlesCited,
    focusAreas: p.focusAreas,
    commitSha: p.commitSha || currentCommitSha(),
    checksum: p.checksum,
  });
  // Deterministic arm-eval capture (toggle-gated; detached) — fires when the
  // plan skill includes the original task text in this upsert payload, so
  // capture is part of PERSISTING the plan rather than a skippable trailing
  // step. No-op when the per-repo toggle is off. The audit-time upsertPlan
  // (openai-audit.mjs) carries no taskText, so only the plan-authoring flow
  // triggers a capture.
  if (p.taskText && String(p.taskText).trim()) {
    try {
      const { maybeFireArmEvalCaptureDetached } = await import('./lib/arm-eval/capture-trigger.mjs');
      maybeFireArmEvalCaptureDetached({ experimentType: 'plan-authoring', task: p.taskText });
    } catch { /* never block plan persistence on capture */ }
  }
  emit({ ok: !!planId, cloud: true, planId });
}

async function cmdUpdatePlanStatus() {
  const p = parsePayload();
  if (!p.planId && !p.path) {
    return emitError('BAD_INPUT', 'one of planId or path is required (path is usually what you know)');
  }
  if (!p.status) return emitError('BAD_INPUT', 'status is required');
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false });

  // `path` is the ergonomic entry point: this command exists to be typed by a
  // human deciding a plan is done, and nobody knows a plan by its UUID.
  let planId = p.planId;
  let resolvedPath = null;
  if (!planId) {
    const repoId = await resolveRepoId(p);
    const found = await getPlanIdByPath(repoId, p.path);
    if (!found.ok) return emitError('PLAN_NOT_RESOLVED', found.message, {}, 1);
    planId = found.planId;
    resolvedPath = found.path;
  }

  // Report the STORE's answer, not a blanket ok. `updatePlanStatus` returns
  // rowCount 0 for a stale id, an RLS-filtered row, or an invalid status —
  // emitting `{ok:true}` regardless would report a phantom write.
  const res = await updatePlanStatus(planId, p.status);
  if (!res.ok) {
    return emitError('STATUS_NOT_UPDATED',
      `no row updated for planId=${planId} — stale id, invalid status, or RLS`, {}, 1);
  }
  emit({ ok: true, cloud: true, planId, path: resolvedPath, status: p.status });
}

async function cmdRecordRegressionSpec() {
  const p = parsePayload();
  if (!p.sourceKind || !p.description) {
    return emitError('BAD_INPUT', 'sourceKind and description are required');
  }
  // Resolves Gemini-final-G1: defense-in-depth pre-egress redaction at the
  // cross-skill CLI boundary. learning-store.recordRegressionSpec ALSO
  // redacts (R1 fix), but redacting at the boundary too means future
  // callers / future learning-store refactors can't bypass it. Idempotent
  // — applying redact twice is harmless (patterns already replaced won't
  // match again).
  if (p.sourceKind === 'persona-consistency-candidate' || p.sourceKind === 'persona-consistency-locked') {
    try {
      const { redactObject } = await import('./lib/redact.mjs');
      if (p.witnessSnapshot !== undefined && p.witnessSnapshot !== null) {
        p.witnessSnapshot = redactObject(p.witnessSnapshot).redacted;
      }
      if (p.contradictionPayload !== undefined && p.contradictionPayload !== null) {
        p.contradictionPayload = redactObject(p.contradictionPayload).redacted;
      }
      if (p.journeyContext !== undefined && p.journeyContext !== null) {
        p.journeyContext = redactObject(p.journeyContext).redacted;
      }
    } catch (err) {
      return emitError('REDACT_FAILED', `pre-egress redact threw: ${err.message}`);
    }
  }
  // Conditional specPath requirement by sourceKind (Gemini-R6-G2 fix).
  const isCandidate = p.sourceKind === 'persona-consistency-candidate';
  const isLocked    = p.sourceKind === 'persona-consistency-locked';
  if (!isCandidate && !p.specPath) {
    return emitError('BAD_INPUT', 'specPath is required for non-candidate source_kind');
  }
  if (isCandidate) {
    if (!p.candidateFingerprint) {
      return emitError('BAD_INPUT', 'candidate rows require candidateFingerprint');
    }
    if (!p.witnessSnapshot || !p.contradictionPayload || !p.journeyContext) {
      return emitError('BAD_INPUT',
        'candidate rows require witnessSnapshot, contradictionPayload, journeyContext');
    }
  }
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, specId: null });
  const repoId = await resolveRepoId(p);
  // Resolves R1-H3 — repo scoping enforced at the CLI boundary. Both
  // candidate AND locked rows require a resolved repoId; without it the
  // partial unique index has no anchor and concurrent runs can silently
  // produce duplicate-fingerprint rows (Postgres NULL-distinct trap).
  if ((isCandidate || isLocked) && !repoId) {
    return emitError('BAD_INPUT',
      'consistency rows (candidate or locked) require a resolved repoId — run resolve-repo-identity --persist first');
  }
  const specId = await recordRegressionSpec(repoId, {
    specPath: p.specPath ?? null,
    description: p.description,
    commitSha: p.commitSha || currentCommitSha(),
    assertionCount: p.assertionCount,
    domContractTypes: p.domContractTypes,
    sourceKind: p.sourceKind,
    sourceFindingId: p.sourceFindingId,
    sourceFindingType: p.sourceFindingType,
    candidateFingerprint: p.candidateFingerprint,
    witnessSnapshot: p.witnessSnapshot,
    contradictionPayload: p.contradictionPayload,
    journeyContext: p.journeyContext,
  });
  emit({ ok: !!specId, cloud: true, specId });
}

async function cmdListConsistencyCandidates() {
  const p = parsePayload();
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, candidates: [] });
  const repoId = await resolveRepoId(p);
  if (!repoId) {
    return emitError('BAD_INPUT', 'repoId could not be resolved; pass repoId or repoUuid');
  }
  const rows = await listConsistencyCandidates(repoId, {
    sinceTs: p.sinceTs,
    limit: p.limit,
  });
  emit({ ok: true, cloud: true, candidates: rows });
}

async function cmdPromoteRegressionSpec() {
  const p = parsePayload();
  if (!p.specId || !p.specPath || !p.promotedBy) {
    return emitError('BAD_INPUT', 'specId, specPath, promotedBy are required');
  }
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, rowsAffected: 0 });
  const r = await promoteRegressionSpec(p.specId, {
    specPath: p.specPath,
    promotedBy: p.promotedBy,
    candidateFingerprint: p.candidateFingerprint,
  });
  emit({ ok: r.ok, cloud: true, rowsAffected: r.rowsAffected });
}

// ── Phase 3 WS-PIPE1 — persona_test_candidates ─────────────────────────────

async function cmdUpsertPersonaTestCandidate() {
  const p = parsePayload();
  if (!p.repoName || !p.fingerprint || !p.canaryName || !p.surfaceId || !p.severity) {
    return emitError('BAD_INPUT',
      'repoName, fingerprint, canaryName, surfaceId, severity are required');
  }
  if (!['P0', 'P1', 'P2', 'P3'].includes(p.severity)) {
    return emitError('BAD_INPUT', `severity must be one of P0..P3 (got ${p.severity})`);
  }
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false });
  const r = await upsertPersonaTestCandidate({
    repoName: p.repoName,
    fingerprint: p.fingerprint,
    canaryName: p.canaryName,
    surfaceId: p.surfaceId,
    severity: p.severity
  });
  emit({ ok: r.ok, cloud: r.cloud, occurrences: r.occurrences, firstSeen: r.firstSeen, lastSeen: r.lastSeen });
}

async function cmdListPersonaTestCandidates() {
  const p = parsePayload();
  if (!p.repoName) return emitError('BAD_INPUT', 'repoName is required');
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, candidates: [] });
  const rows = await listPersonaTestCandidates({
    repoName: p.repoName,
    ageDays: p.ageDays,
    occurrencesFloor: p.occurrencesFloor,
    severityFloor: p.severityFloor
  });
  emit({ ok: true, cloud: true, candidates: rows });
}

async function cmdMarkPersonaTestCandidateProposed() {
  const p = parsePayload();
  if (!p.repoName || !p.fingerprint) {
    return emitError('BAD_INPUT', 'repoName and fingerprint are required');
  }
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, rowsAffected: 0 });
  const r = await markPersonaTestCandidateProposed({
    repoName: p.repoName,
    fingerprint: p.fingerprint
  });
  emit({ ok: r.ok, cloud: r.cloud, rowsAffected: r.rowsAffected });
}

async function cmdRecordRegressionSpecRun() {
  const p = parsePayload();
  if (!p.specId || typeof p.passed !== 'boolean') {
    return emitError('BAD_INPUT', 'specId and passed (bool) are required');
  }
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false });
  await recordRegressionSpecRun(p.specId, {
    passed: p.passed,
    commitSha: p.commitSha || currentCommitSha(),
    capturedRegression: p.capturedRegression,
    durationMs: p.durationMs,
    errorMessage: p.errorMessage,
    runContext: p.runContext,
  });
  emit({ ok: true, cloud: true });
}

async function cmdRecordCorrelation() {
  const p = parsePayload();
  if (!p.personaSessionId || !p.personaFindingHash || !p.personaSeverity || !p.correlationType) {
    return emitError('BAD_INPUT', 'personaSessionId, personaFindingHash, personaSeverity, correlationType required');
  }
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false });
  const result = await recordPersonaAuditCorrelation(p.personaSessionId, {
    personaFindingHash: p.personaFindingHash,
    personaSeverity: p.personaSeverity,
    auditFindingId: p.auditFindingId,
    auditRunId: p.auditRunId,
    correlationType: p.correlationType,
    matchScore: p.matchScore,
    matchRationale: p.matchRationale,
  });
  if (!result.ok) return emitError('WRITE_FAILED', result.error || 'correlation write failed');
  emit({ ok: true, cloud: true });
}

async function cmdRecordPlanVerifyRun() {
  const p = parsePayload();
  if (!p.planId || typeof p.totalCriteria !== 'number') {
    return emitError('BAD_INPUT', 'planId and totalCriteria (number) are required');
  }
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, runId: null });
  const runId = await recordPlanVerificationRun({
    planId: p.planId,
    specId: p.specId,
    commitSha: p.commitSha || currentCommitSha(),
    url: p.url,
    totalCriteria: p.totalCriteria,
    passedCount: p.passedCount || 0,
    failedCount: p.failedCount || 0,
    skippedCount: p.skippedCount || 0,
    durationMs: p.durationMs,
    runContext: p.runContext || 'ux-lock-verify',
  });
  emit({ ok: !!runId, cloud: true, runId });
}

async function cmdRecordPlanVerifyItems() {
  const p = parsePayload();
  if (!p.runId || !p.planId || !Array.isArray(p.items) || p.items.length === 0) {
    return emitError('BAD_INPUT', 'runId, planId, and non-empty items array are required');
  }
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, inserted: 0 });
  await recordPlanVerificationItems(p.runId, p.planId, p.items);
  emit({ ok: true, cloud: true, inserted: p.items.length });
}

async function cmdPlanSatisfaction() {
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, row: null, persistentFailures: [] });
  const planId = argOption('plan-id');
  if (!planId) return emitError('BAD_INPUT', '--plan-id is required');
  const [row, persistent] = await Promise.all([
    readPlanSatisfaction(planId),
    readPersistentPlanFailures(planId),
  ]);
  emit({ ok: true, cloud: true, row, persistentFailures: persistent });
}

const NAV_AUDIT_RUN_SCOPES = ['full', 'diff'];

async function cmdRecordNavAuditRun() {
  // /nav-audit run telemetry (WS2, docs/plans/persona-nav-feedback-recovery.md).
  // Idempotent by (repoId, headSha, scope) — see scripts/lib/store/nav-audit.mjs.
  const p = parsePayload();
  if (!p.headSha) return emitError('BAD_INPUT', 'headSha is required');
  if (!Array.isArray(p.driftKeys)) return emitError('BAD_INPUT', 'driftKeys (array) is required');
  // Absent scope normalizes to 'full'; an UNKNOWN scope is rejected, never
  // silently folded in (the store's UNIQUE constraint depends on this being
  // one of exactly two closed values — see the migration's NOT NULL note).
  const scope = p.scope ?? 'full';
  if (!NAV_AUDIT_RUN_SCOPES.includes(scope)) {
    return emitError('BAD_INPUT', `scope must be one of ${NAV_AUDIT_RUN_SCOPES.join('|')}, got "${scope}"`);
  }
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false });
  const repoId = await resolveRepoId(p);
  if (!repoId) return emit({ ok: true, cloud: true, status: 'unavailable', note: 'no resolvable repo identity' });
  const result = await recordNavAuditRun({
    repoId, headSha: p.headSha, scope,
    driftKeys: p.driftKeys,
    findingCounts: p.findingCounts ?? null,
    verifySummary: p.verifySummary ?? null,
    toolVersion: p.toolVersion ?? null,
  });
  emit({ ok: result.status !== 'failed', cloud: true, ...result });
}

async function cmdGetNavFirstSeen() {
  const p = parsePayload();
  if (!Array.isArray(p.driftKeys) || p.driftKeys.length === 0) {
    return emitError('BAD_INPUT', 'driftKeys (non-empty array) is required');
  }
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, firstSeen: {} });
  const repoId = await resolveRepoId(p);
  if (!repoId) return emit({ ok: true, cloud: true, firstSeen: {} });
  const history = await listNavAuditRunHistory({ repoId, sinceDays: p.sinceDays ?? undefined });
  if (!history.ok) return emit({ ok: false, cloud: true, firstSeen: {}, error: history.error });
  const lookup = firstSeenFromHistory(history.rows);
  const firstSeen = {};
  for (const key of p.driftKeys) { const v = lookup(key); if (v) firstSeen[key] = v; }
  emit({ ok: true, cloud: true, firstSeen, truncated: history.truncated });
}

async function cmdRecordShipEvent() {
  const p = parsePayload();
  if (!p.outcome) return emitError('BAD_INPUT', 'outcome is required');
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false });
  const repoId = await resolveRepoId(p);
  await recordShipEvent(repoId, {
    commitSha: p.commitSha || currentCommitSha(),
    branch: p.branch || currentBranch(),
    outcome: p.outcome,
    blockReasons: p.blockReasons,
    openP0Count: p.openP0Count,
    openP1Count: p.openP1Count,
    missingSpecCount: p.missingSpecCount,
    overriddenByUser: p.overriddenByUser,
    overrideFlag: p.overrideFlag,
    stackDetected: p.stackDetected,
    framework: p.framework,
    durationMs: p.durationMs,
  });
  emit({ ok: true, cloud: true });
}

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
async function resolveShipNudgeScope() {
  const allRepos = hasFlag('all-repos');
  const repoIdArg = argOption('repo-id');
  const slugArg = argOption('repo');

  if (allRepos && (repoIdArg || slugArg)) {
    return { mode: 'unresolved', repoId: null, slug: null, measured: false, reason: 'conflicting-scope',
      error: '--all-repos cannot be combined with --repo/--repo-id — pick one.' };
  }
  if (allRepos) return { mode: 'all-repos', repoId: null, slug: null, measured: true, reason: null };

  if (repoIdArg) {
    // An id absent from `audit_repos` used to be trusted verbatim, so it read
    // as `measured:true` with a count of ZERO — an authoritative "no
    // obligations" for a repo that was never queried. That false zero is not
    // hypothetical either: it is how the consumer incident got its final
    // number. The operator had passed the ARCH-MEMORY repo uuid (the v5 id in
    // `.audit-loop/repo-id`, e.g. 25aa2cdf-…) while these views key on
    // `audit_repos.id` (a v4 row id, e.g. 22865de8-…). Both name the same repo
    // — they are two columns of the same row — so the id looked entirely
    // plausible and the zero it produced was believed.
    const known = await listRepoIds().catch(() => []);
    if (known.length === 0) {
      // Cannot confirm the id against the store; refuse to report a number
      // rather than emit one we cannot stand behind.
      return { mode: 'unresolved', repoId: null, slug: null, measured: false, reason: 'repo-id-unverifiable',
        error: 'could not read audit_repos to verify --repo-id — refusing to report a count that cannot be attributed.' };
    }
    if (known.includes(repoIdArg)) {
      return { mode: 'repo', repoId: repoIdArg, slug: null, measured: true, reason: null };
    }
    // Accept the arch-memory uuid too, translated — it is the id an operator
    // most plausibly has to hand, and silently rejecting it teaches nothing.
    const viaUuid = await getRepoIdByUuid(repoIdArg).catch(() => null);
    if (viaUuid?.id) {
      return { mode: 'repo', repoId: viaUuid.id, slug: viaUuid.name ?? null, measured: true, reason: null };
    }
    return { mode: 'unresolved', repoId: null, slug: null, measured: false, reason: 'unknown-repo-id',
      error: `unknown --repo-id "${repoIdArg}" — not an audit_repos.id nor a known repo_uuid. ` +
        'It is NOT an empty backlog; nothing was measured.' };
  }

  if (slugArg) {
    // An explicitly-named repo that does not exist is an ERROR: the operator
    // asserted something specific and it is wrong. Silently widening (or
    // silently returning zero) is how the original bug read as plausible.
    const rowId = await getRepoIdByName(slugArg).catch(() => null);
    if (!rowId) {
      return { mode: 'unresolved', repoId: null, slug: slugArg, measured: false, reason: 'unknown-repo',
        error: `unknown repo "${slugArg}" — expected an owner/repo slug present in audit_repos.` };
    }
    return { mode: 'repo', repoId: rowId, slug: slugArg, measured: true, reason: null };
  }

  // Ambient identity. Unresolvable is a NON-error (nothing was asserted), but it
  // is `measured:false` — never a zero that reads as "no obligations".
  const ref = await resolveRepoForStore({}).catch(() => null);
  if (ref?.repoRowId) return { mode: 'repo', repoId: ref.repoRowId, slug: ref.name ?? null, measured: true, reason: null };
  return { mode: 'unresolved', repoId: null, slug: null, measured: false, reason: 'repo-identity-unresolvable' };
}

/** The store-scope argument for a resolved scope (D18 explicit-scope contract). */
const storeScopeFor = (scope) => (scope.mode === 'all-repos' ? { allRepos: true } : { repoId: scope.repoId });

async function cmdListUnlockedFixes() {
  await initLearningStore();
  if (!await isCloudEnabled()) {
    return emit({ ok: true, cloud: false, scope: { mode: 'unresolved', repoId: null, slug: null },
      measured: false, reason: 'cloud-off', rows: [], shown: 0, total: 0, byMode: { total: 0, code: 0, plan: 0 } });
  }
  const scope = await resolveShipNudgeScope();
  if (scope.error) return emit({ ok: false, cloud: true, error: scope.error, reason: scope.reason });

  // `measured:false` is NOT "zero obligations" — it is "nothing was measured".
  // Collapsing the two is exactly how a foreign 207 and a local 0 both looked
  // like ordinary numbers.
  if (!scope.measured) {
    return emit({ ok: true, cloud: true, scope: { mode: scope.mode, repoId: null, slug: scope.slug },
      measured: false, reason: scope.reason, rows: [], shown: 0, total: 0, byMode: { total: 0, code: 0, plan: 0 } });
  }

  const storeScope = storeScopeFor(scope);
  const rows = await getUnlockedFixes(storeScope);
  // `rows` is capped at 20 by the view query, so its length is NOT the
  // obligation count — reporting it as one undercounted 232 as "20" for weeks.
  // `byMode.plan` is surfaced separately because a plan finding can never carry
  // a regression spec; folding it into one total makes an unactionable half of
  // the backlog read as work.
  const byMode = await countUnlockedFixes(storeScope);
  emit({
    ok: true, cloud: true,
    scope: { mode: scope.mode, repoId: scope.repoId, slug: scope.slug },
    measured: true, reason: null,
    rows, shown: rows.length, total: byMode.total, byMode,
  });
}

async function cmdListUnremediatedAcceptances() {
  await initLearningStore();
  if (!await isCloudEnabled()) {
    return emit({ ok: true, cloud: false, scope: { mode: 'unresolved', repoId: null, slug: null },
      measured: false, reason: 'cloud-off', rows: [] });
  }
  // Same scope chain as list-unlocked-fixes. This handler read `--repo-id`
  // alone until 2026-07-30, so a flagless /ship Step 0.5e — which is exactly
  // how the skill invokes it — reported another repo's accepted-but-unfixed
  // findings as this one's.
  const scope = await resolveShipNudgeScope();
  if (scope.error) return emit({ ok: false, cloud: true, error: scope.error, reason: scope.reason });
  if (!scope.measured) {
    return emit({ ok: true, cloud: true, scope: { mode: scope.mode, repoId: null, slug: scope.slug },
      measured: false, reason: scope.reason, rows: [] });
  }
  const rows = await getUnremediatedAcceptances(storeScopeFor(scope));
  emit({
    ok: true, cloud: true,
    scope: { mode: scope.mode, repoId: scope.repoId, slug: scope.slug },
    measured: true, reason: null, rows,
  });
}

async function cmdAuditEffectiveness() {
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, row: null });
  const repoId = argOption('repo-id');
  if (!repoId) return emitError('BAD_INPUT', '--repo-id is required');
  const row = await readAuditEffectiveness(repoId);
  emit({ ok: true, cloud: true, row });
}

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
function groundingNoteFor(f) {
  try {
    const root = process.cwd();
    const res = checkFindingGrounding({
      detail: f.detail_snapshot || '',
      primaryFile: f.primary_file || '',
      readFile: (rel) => {
        const p = path.resolve(root, rel);
        // Containment: `primary_file` is model-authored text, so it is not a
        // trusted path source.
        if (!p.startsWith(path.resolve(root))) return null;
        return readFileSync(p, 'utf8');
      },
    });
    return formatGroundingNote(res);
  } catch { return ''; }
}

async function cmdFinalReviewStats() {
  await initLearningStore();
  const repoName = argOption('repo');
  if (!repoName) return emitError('BAD_INPUT', '--repo <name> is required');
  const limitFlag = argOption('queue-limit');
  const res = await getFinalReviewStats(repoName, limitFlag ? { queueLimit: Number(limitFlag) } : {});
  // --worksheet: same human-grade surface as model-ab-adjudicate (this queue was
  // the FIRST raw-JSON adjudication failure — see lib/adjudication-worksheet.mjs).
  if (process.argv.includes('--worksheet') && res.ok) {
    const { renderAdjudicationWorksheet } = await import('./lib/adjudication-worksheet.mjs');
    const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
    const pending = (res.shadowOnlyQueue || []).filter((f) => !f.user_action);
    const md = renderAdjudicationWorksheet({
      title: `Final-review shadow-only spot-check — repo ${repoName}`,
      introLines: [
        'Findings the SHADOW final reviewer raised that the primary did not. Accepting one is evidence the second gate earns its keep (pre-registered stopping rule in AGENTS.md).',
      ],
      items: pending.map((f) => ({
        runId: f.run_id, fingerprint: f.finding_fingerprint, severity: f.severity,
        category: f.category, file: f.primary_file, detail: f.detail_snapshot,
        groundingNote: groundingNoteFor(f),
      })),
      actions: ['accepted', 'dismissed'],
      // `--bucket shadow-only` is explicit, not implied: this queue is
      // shadow-only by construction, and stating it means the documented
      // operator flow can never hit the ambiguous-bucket refusal if the same
      // fingerprint later also appears as a primary finding.
      commandFor: (it, a) => `node scripts/cross-skill.mjs final-review-adjudicate --run-id ${it.runId} --fingerprint ${it.fingerprint} --action ${a} --bucket shadow-only`,
      generatedAt: new Date().toISOString(),
    });
    const dir = existsSync('docs/arm-eval') ? 'docs/arm-eval/worksheets' : '.audit';
    const out = argOption('out') || `${dir}/final-review-adjudication-worksheet.md`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(out, md);
    process.stderr.write(`  [final-review-stats] worksheet: ${pending.length} pending finding(s) → ${out}\n`);
    return emit({ ok: true, cloud: res.cloud, count: pending.length, worksheet: out });
  }
  emit(res);
}

async function cmdFinalReviewAdjudicate() {
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: false, cloud: false, updated: 0 });
  const runId = argOption('run-id');
  const fingerprint = argOption('fingerprint');
  const action = argOption('action');
  if (!runId || !fingerprint || !action) {
    return emitError('BAD_INPUT', '--run-id <id> --fingerprint <hash> --action <accepted|dismissed> are all required');
  }
  if (action !== 'accepted' && action !== 'dismissed') {
    return emitError('BAD_INPUT', `--action must be 'accepted' or 'dismissed', got '${action}'`);
  }
  // --bucket is optional. Omitted → the store resolves it, refusing rather than
  // guessing when a fingerprint spans several buckets. `primary` / `none` name
  // the NULL bucket, which is what a non-shadow final-review finding carries.
  // `argOption` returns NULL for an absent flag, never `undefined` — so the
  // `undefined` test made the omitted-bucket branch UNREACHABLE, and every
  // caller that omitted `--bucket` silently got `{bucket: null}`, i.e. "scope to
  // the PRIMARY bucket" rather than the documented "let the store resolve it".
  // A shadow-only finding then matched 0 rows. Its sibling
  // `cmdFinalReviewRecordFix` already tests `=== null` correctly; this is that
  // copy-paste divergence, found by the code audit on the exact command the
  // /ship credit card points operators at (R1-H3).
  const rawBucket = argOption('bucket');
  const opts = rawBucket === null ? {}
    : { bucket: (rawBucket === 'primary' || rawBucket === 'none') ? null : rawBucket };
  const res = await adjudicateFinalReviewFinding(runId, fingerprint, action, opts);
  // A 0-row adjudication is a FAILURE, not a quiet success. Reporting ok:true
  // there is how a hardcoded bucket filter went unnoticed: every primary
  // finding "adjudicated" fine and nothing changed.
  if (!res.ok) {
    const hint = res.reason === 'ambiguous-bucket'
      ? ` — fingerprint spans buckets [${(res.buckets || []).map((b) => b ?? 'primary').join(', ')}]; re-run with --bucket <name>`
      : res.reason === 'no-match-in-bucket'
        ? ` — no row in that bucket; present in [${(res.buckets || []).map((b) => b ?? 'primary').join(', ')}]`
        : '';
    return emitError('ADJUDICATION_FAILED', `${res.reason || 'unknown'}${hint}`, {
      updated: 0, cloud: res.cloud, buckets: res.buckets,
    });
  }
  emit(res);
}

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
async function cmdFinalReviewPending() {
  const repoName = argOption('repo');
  if (!repoName) return emitError('BAD_INPUT', '--repo <name> is required');
  const wantRender = process.argv.includes('--render');
  const commitSha = argOption('commit') || null;
  const pageSize = Math.min(Math.max(Number(argOption('page-size') || 10) || 10, 1), 50);

  const done = (result) => {
    if (!wantRender) return emit(result);
    const text = renderFinalReviewCard(result, { commitSha });
    if (text) process.stdout.write(`${text}\n`);
    return undefined; // exit 0 with no JSON — the card IS the output
  };

  let res;
  try {
    await initLearningStore();
    if (!await isCloudEnabled()) return done({ schemaVersion: 1, state: 'disabled' });
    res = await getFinalReviewStats(repoName, { queueLimit: 50 });
  } catch {
    // Boundary classifier: any thrown failure becomes ONE literal. The error
    // object never reaches the result.
    return done({ schemaVersion: 1, state: 'unavailable', diagnostic: 'CLOUD_UNREACHABLE' });
  }
  if (!res?.ok) {
    const diagnostic = res?.error === 'NOT_MIGRATED' ? 'NOT_MIGRATED' : 'CLOUD_UNREACHABLE';
    return done({ schemaVersion: 1, state: 'unavailable', diagnostic });
  }
  if (!Array.isArray(res.shadowOnlyQueue) || !Array.isArray(res.actionablePairs)) {
    return done({ schemaVersion: 1, state: 'unavailable', diagnostic: 'MALFORMED_RESPONSE' });
  }

  const counts = summariseCounts(res.actionablePairs);
  const items = orderItems(res.shadowOnlyQueue)
    .map((r) => ({ ...r, classification: classifyFinalReviewOutcome(r) }))
    .filter((r) => isActionable(r.classification))
    .slice(0, pageSize)
    // Display-safe projection ONLY — `detail_snapshot` is deliberately dropped:
    // it is free-form model prose and has no place in a ship card.
    .map((r) => ({
      run_id: r.run_id, finding_fingerprint: r.finding_fingerprint, bucket: 'shadow-only',
      classification: r.classification, severity: r.severity, category: r.category,
      user_action: r.user_action ?? null, remediation_state: r.remediation_state ?? null,
      primary_file: r.primary_file ?? null, created_at: r.created_at ?? null,
    }));

  return done({ schemaVersion: 1, state: 'ready', cloud: true, repo: repoName, counts, shownCount: items.length, items });
}

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
async function cmdFinalReviewRecordFix() {
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: false, cloud: false, updated: 0 });
  const runId = argOption('run-id');
  const fingerprint = argOption('fingerprint');
  if (!runId || !fingerprint) {
    return emitError('BAD_INPUT', '--run-id <id> and --fingerprint <hash> are both required');
  }
  const rawBucket = argOption('bucket');
  const opts = {
    commitSha: argOption('commit'),
    ...(argOption('state') ? { state: argOption('state') } : {}),
    ...(rawBucket === null ? {} : { bucket: (rawBucket === 'primary' || rawBucket === 'none') ? null : rawBucket }),
  };
  const res = await recordFinalReviewFix(runId, fingerprint, opts);
  if (!res.ok) {
    const hint = res.reason === 'ambiguous-bucket'
      ? ` — fingerprint spans buckets [${(res.buckets || []).map((b) => b ?? 'primary').join(', ')}]; re-run with --bucket <name>`
      : res.reason === 'dismissed-cannot-be-fixed'
        ? ' — this finding was adjudicated `dismissed`; recording a fix for a non-issue is incoherent'
        : '';
    return emitError('RECORD_FIX_FAILED', `${res.reason || 'unknown'}${hint}`, {
      updated: 0, cloud: res.cloud, buckets: res.buckets,
    });
  }
  emit(res);
}

// ── Model-A/B/C experiment harness (Cluster C) ──────────────────────────────

/**
 * Blinded human adjudication queue + writeback (plan decision 5a, mirrors
 * final-review-adjudicate). With no --action → PRESENTS the blinded queue
 * (source_model hidden; likely-equivalents adjacent). With --action →
 * writes the outcome (`accepted|dismissed|duplicate|not-actionable`);
 * `duplicate` needs --canonical <fingerprint>.
 */
async function cmdModelAbAdjudicate() {
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: false, cloud: false });
  const action = argOption('action');
  if (!action) {
    // Present the blinded queue.
    const runId = argOption('run-id');
    const limit = Number(argOption('limit')) || 50;
    const q = await getModelAbAdjudicationQueue({ runId, limit });
    // Adjudication is a HUMAN activity by design (the scorer's anti-circularity),
    // so the human surface is the DEFAULT: the listing writes the paste-ready
    // markdown worksheet. `--json` is the escape hatch for scripts. (The raw-JSON
    // default failed the operator twice — see lib/adjudication-worksheet.mjs.)
    if (!process.argv.includes('--json')) {
      const { renderAdjudicationWorksheet } = await import('./lib/adjudication-worksheet.mjs');
      const { writeFileSync, mkdirSync, existsSync, readFileSync } = await import('node:fs');
      // --suggestions <file>: advisory pre-judgments (blinded-adjudicator output),
      // a JSON map { fingerprint: {action, why, canonical?} }. Rendered per item
      // with the command pre-filled to the suggestion — the human confirms by
      // pasting or overrides by editing; the file itself never writes rulings.
      let suggestions = {};
      const sugPath = argOption('suggestions');
      if (sugPath) {
        try { suggestions = JSON.parse(readFileSync(sugPath, 'utf8')); }
        catch (err) { return emitError('BAD_INPUT', `--suggestions ${sugPath}: ${err.message}`); }
      }
      const md = renderAdjudicationWorksheet({
        title: `Model-A/B/C blinded adjudication${runId ? ` — run ${runId.slice(0, 8)}…` : ''}`,
        introLines: [
          'Blinded: arm identity is hidden; the `stage` tag (oss-gen/gpt-round/gemini) is a pipeline stage, not an arm.',
          'Your confirmed rulings are the scorer\'s ONLY ground truth (anti-circularity).',
          ...(sugPath ? [`Suggested verdicts loaded from ${sugPath} — advisory only, you confirm or override each.`] : []),
        ],
        items: q.items.map((f) => ({
          runId: f.run_id, fingerprint: f.finding_fingerprint, severity: f.severity,
          stage: f.stage, category: f.category, file: f.primary_file, detail: f.detail_snapshot,
          suggestion: suggestions[f.finding_fingerprint] || undefined,
        })),
        actions: ['accepted', 'dismissed', 'not-actionable', 'duplicate'],
        duplicateHowTo: { action: 'duplicate', canonicalHint: '--canonical ROOT_FINGERPRINT' },
        commandFor: (it, a, canonical) => `node scripts/cross-skill.mjs model-ab-adjudicate --run-id ${it.runId} --fingerprint ${it.fingerprint} --action ${a}${canonical ? ` --canonical ${canonical}` : ''}`,
        generatedAt: new Date().toISOString(),
      });
      // Discoverable home next to the arm-eval session archives (gitignored —
      // Category-A volatile state); .audit/ fallback for repos without docs/arm-eval.
      const dir = existsSync('docs/arm-eval') ? 'docs/arm-eval/worksheets' : '.audit';
      const out = argOption('out') || `${dir}/model-ab-adjudication-worksheet.md`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(out, md);
      process.stderr.write(`  [model-ab-adjudicate] worksheet: ${q.items.length} pending finding(s) → ${out}\n  (raw queue JSON: add --json)\n`);
      return emit({ ok: true, cloud: q.cloud, blinded: true, count: q.items.length, worksheet: out });
    }
    return emit({ ok: true, cloud: q.cloud, blinded: true, count: q.items.length, queue: q.items });
  }
  const validActions = new Set(['accepted', 'dismissed', 'duplicate', 'not-actionable']);
  if (!validActions.has(action)) {
    return emitError('BAD_INPUT', `--action must be one of ${[...validActions].join('|')}, got '${action}'`);
  }
  const runId = argOption('run-id');
  const fingerprint = argOption('fingerprint');
  if (!runId || !fingerprint) return emitError('BAD_INPUT', '--run-id and --fingerprint are required with --action');
  const canonicalFingerprint = argOption('canonical');
  if (action === 'duplicate' && !canonicalFingerprint) {
    return emitError('BAD_INPUT', "--action duplicate requires --canonical <fingerprint>");
  }
  try {
    const res = await applyModelAbAdjudication({ runId, fingerprint, action, canonicalFingerprint, actor: argOption('actor') });
    emit({ ok: true, ...res });
  } catch (err) {
    emitError('EXCEPTION', err.message);
  }
}

/** Aggregate scorer rows + the cost–quality FRONTIER + cumulative spend vs budget (D7). */
async function cmdModelAbStats() {
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: false, cloud: false, rows: [] });
  const runId = argOption('run-id');
  const eff = await getModelAbEffectiveness({ runId });
  const findings = await getModelAbFindingScores({ runId });
  const costs = await getModelAbArmCost({});
  // Reuse the decision evaluator purely for its per-arm frontier + recall
  // (the efficiency headlines: €/accepted-weighted, €/accepted-HIGH).
  const decision = evaluateDecision(findings.rows, costs.rows, DECISION_CONSTANTS);
  const spentEur = await cumulativeSpendEur({ activeTtlMs: auditShadowConfig.reservationTtlMs });
  emit({
    ok: true, cloud: eff.cloud, rows: eff.rows,
    frontier: decision.arms,          // per-arm score/recall/€-frontier
    status: decision.status,
    distinctAssignments: decision.distinctAssignments,
    budget: { spentEur, capEur: auditShadowConfig.budgetEur },
  });
}

// ── Unified arm-evaluation framework (plan-authoring + brainstorm) ───────────
// Thin handlers over scripts/lib/arm-eval/* (orchestration lives there, not in
// this facade). All graceful no-op when cloud is off.

/** Run ONE arm-eval session (produce → judge → cross-check → persist). Spends. */
async function cmdArmEvalRun() {
  await initLearningStore();
  const experimentType = argOption('experiment');
  const task = argOption('task');
  if (!experimentType || !task) return emitError('BAD_INPUT', '--experiment <plan-authoring|brainstorm> --task "<text>" required');
  const budgetFlag = Number.parseFloat(argOption('budget-eur'));
  const repoId = argOption('repo-id') || null;
  const phase = argOption('phase') || 'prospective';
  const seed = argOption('seed') ? Number.parseInt(argOption('seed'), 10) : null;
  try {
    // --budget-eur omitted → config default (€300, ARM_EVAL_BUDGET_EUR to
    // override). The library seam still refuses null — the CLI is where the
    // operator-facing default lives.
    const { armEvalConfig } = await import('./lib/config.mjs');
    const budgetCapEur = Number.isFinite(budgetFlag) && budgetFlag > 0 ? budgetFlag : armEvalConfig.budgetEur;
    const { runArmEvalSession } = await import('./lib/arm-eval/run.mjs');
    const r = await runArmEvalSession({ experimentType, task, repoId, phase, seed, budgetCapEur });
    emit({ ok: r.state === 'ran', ...r });
  } catch (err) { emitError('EXCEPTION', err.message); }
}

/** Two-level verdict for an experiment (gate → paired-delta rank + τ anchor + frontier). */
async function cmdArmEvalDecision() {
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: false, cloud: false });
  const experimentType = argOption('experiment');
  if (!experimentType) return emitError('BAD_INPUT', '--experiment required');
  const repoId = argOption('repo-id') || null;
  const allRepos = hasFlag('all-repos');
  const phase = argOption('phase') || 'prospective';
  try {
    const { getSessionsForDecision } = await import('./lib/store/arm-eval.mjs');
    const { evaluateArmEval } = await import('./lib/arm-eval/decision.mjs');
    const { getExperiment } = await import('./lib/arm-eval/experiments.mjs');
    const exp = getExperiment(experimentType);
    const { sessions, cloud } = await getSessionsForDecision({ experimentType, repoId, allRepos, phase });
    const decision = evaluateArmEval({ experimentType, baselineArm: exp.baselineArm, sessions });
    emit({ ok: true, cloud, ...decision });
  } catch (err) { emitError('EXCEPTION', err.message); }
}

/** Leaderboard aggregate rows (repo-scoped unless --all-repos). */
async function cmdArmEvalStats() {
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: false, cloud: false, rows: [] });
  const experimentType = argOption('experiment') || null;
  const repoId = argOption('repo-id') || null;
  const allRepos = hasFlag('all-repos');
  try {
    const { getArmEvalLeaderboard } = await import('./lib/store/arm-eval.mjs');
    const lb = await getArmEvalLeaderboard({ experimentType, repoId, allRepos });
    emit({ ok: true, cloud: lb.cloud, rows: lb.rows });
  } catch (err) { emitError('EXCEPTION', err.message); }
}

/** Blinded human spot-check: present a session's outputs (arm hidden), or record a ranking. */
async function cmdArmEvalAdjudicate() {
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: false, cloud: false });
  const sessionId = argOption('session-id');
  if (!sessionId) return emitError('BAD_INPUT', '--session-id required');
  const ranked = argOption('ranked');   // comma-separated labels best→worst
  try {
    const store = await import('./lib/store/arm-eval.mjs');
    if (ranked) {
      const rankedLabels = ranked.split(',').map((s) => s.trim()).filter(Boolean);
      const r = await store.recordHumanRanking({ sessionId, rankedLabels, reviewer: argOption('reviewer') || null });
      // Ranking recorded → the committed archive upgrades blinded → full
      // attribution (best-effort; the DB row is canonical).
      let archived = null;
      try {
        const { exportSession } = await import('./lib/arm-eval/export.mjs');
        const ex = await exportSession(sessionId);
        archived = ex.written ? ex.file : null;
      } catch { /* non-fatal */ }
      return emit({ ok: true, ...r, recorded: rankedLabels, archived });
    }
    const q = await store.getBlindedSessionOutputs(sessionId);
    emit({ ok: true, cloud: q.cloud, blinded: true, outputs: q.outputs });
  } catch (err) { emitError('EXCEPTION', err.message); }
}

/**
 * (Re)generate the committed session archive under docs/arm-eval/sessions/.
 * `--session-id <id>` for one session, `--all` (+ --repo-id / --all-repos) for
 * every session. Blinding rule lives in lib/arm-eval/export.mjs — a
 * prospective session without a human ranking exports BLINDED.
 */
async function cmdArmEvalExport() {
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: false, cloud: false });
  const { exportSession } = await import('./lib/arm-eval/export.mjs');
  const store = await import('./lib/store/arm-eval.mjs');
  const one = argOption('session-id');
  try {
    if (one) {
      const r = await exportSession(one);
      return emit({ ok: r.written, ...r });
    }
    if (!hasFlag('all')) return emitError('BAD_INPUT', '--session-id <id> or --all required');
    const repoId = argOption('repo-id') || (await resolveRepoIdentityQuiet());
    const { ids } = await store.listSessionIds({ repoId, allRepos: hasFlag('all-repos') });
    const results = [];
    for (const sid of ids) results.push(await exportSession(sid));
    emit({ ok: true, exported: results.filter((r) => r.written).length, total: ids.length, files: results.filter((r) => r.written).map((r) => r.file) });
  } catch (err) { emitError('EXCEPTION', err.message); }
}

/**
 * One-command experiment toggle: `arm-eval-toggle on|off|status [--budget-eur N]`.
 * `on` → shadow arms B,C activate for /audit-code + /audit-plan, and /plan +
 * /brainstorm start capturing arm-eval sessions. `off` → everything inert.
 * Explicit AUDIT_MODEL_SHADOW env always wins over the toggle (kill switch).
 */
async function cmdArmEvalToggle() {
  const sub = rest.find((a) => !a.startsWith('--')) || 'status';
  const { readToggle, writeToggle, resolveShadowArmsWithToggle } = await import('./lib/arm-eval/toggle.mjs');
  if (sub === 'on' || sub === 'off') {
    const budgetFlag = Number.parseFloat(argOption('budget-eur'));
    const { armEvalConfig } = await import('./lib/config.mjs');
    const budgetEur = Number.isFinite(budgetFlag) && budgetFlag > 0 ? budgetFlag : armEvalConfig.budgetEur;
    const state = writeToggle({ enabled: sub === 'on', budgetEur: sub === 'on' ? budgetEur : null });
    const arms = resolveShadowArmsWithToggle();
    return emit({
      ok: true, toggle: state,
      activates: sub === 'on' ? {
        auditShadowArms: arms.enabled ? arms.requested : [],
        planCapture: 'plan-authoring', brainstormCapture: 'brainstorm',
        budgetEur,
      } : null,
      note: sub === 'on'
        ? 'Shadow arms + plan/brainstorm capture ACTIVE for this repo. Turn off: arm-eval-toggle off'
        : 'All experiment capture INERT for this repo.',
    });
  }
  if (sub !== 'status') return emitError('BAD_INPUT', 'usage: arm-eval-toggle on|off|status [--budget-eur N]');
  const t = readToggle();
  const arms = resolveShadowArmsWithToggle();
  emit({ ok: true, toggle: t, shadowArms: { enabled: arms.enabled, requested: arms.requested, source: arms.source } });
}

/**
 * Conditional capture hook for /plan and /brainstorm (toggle-gated, silent
 * no-op when off — safe to call unconditionally from the skills). When the
 * toggle is on, runs ONE arm-eval session for the given experiment + task
 * under the toggle's budget.
 */
async function cmdArmEvalMaybeCapture() {
  const { readToggle } = await import('./lib/arm-eval/toggle.mjs');
  const t = readToggle();
  if (!t.enabled) return emit({ ok: true, captured: false, reason: 'toggle-off' });
  const experimentType = argOption('experiment');
  const task = argOption('task');
  if (!experimentType || !task) return emitError('BAD_INPUT', '--experiment <plan-authoring|brainstorm> --task "<text>" required');
  await initLearningStore();
  const { armEvalConfig } = await import('./lib/config.mjs');
  const budgetCapEur = t.budgetEur ?? armEvalConfig.budgetEur;
  const repoId = argOption('repo-id') || (await resolveRepoIdentityQuiet());
  try {
    const { runArmEvalSession } = await import('./lib/arm-eval/run.mjs');
    const r = await runArmEvalSession({ experimentType, task, repoId, phase: 'prospective', seed: null, budgetCapEur });
    emit({ ok: r.state === 'ran', captured: r.state === 'ran', ...r });
  } catch (err) { emitError('EXCEPTION', err.message); }
}

/** Best-effort repo UUID for capture attribution; null when unresolvable. */
async function resolveRepoIdentityQuiet() {
  try {
    const { resolveRepoIdentity } = await import('./lib/repo-identity.mjs');
    const r = await resolveRepoIdentity();
    return r?.repoUuid || null;
  } catch { return null; }
}

/** Two-level decision: quality GATE → weighted-quality RANK + recall + frontier (D5–D8). */
async function cmdModelAbDecision() {
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: false, cloud: false });
  const runId = argOption('run-id');
  const findings = await getModelAbFindingScores({ runId });
  const costs = await getModelAbArmCost({});
  const decision = evaluateDecision(findings.rows, costs.rows, DECISION_CONSTANTS);
  const spentEur = await cumulativeSpendEur({ activeTtlMs: auditShadowConfig.reservationTtlMs });
  const capEur = auditShadowConfig.budgetEur;
  emit({
    ok: true, cloud: findings.cloud,
    constants: decision.constants,
    status: decision.status,
    reason: decision.reason,
    baselineArm: decision.baselineArm,
    distinctAssignments: decision.distinctAssignments,
    totalAcceptedClusters: decision.totalAcceptedClusters,
    arms: decision.arms,
    ranking: decision.ranking,
    budget: { spentEur, capEur, exhausted: capEur != null && spentEur != null && spentEur >= capEur },
  });
}

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
async function cmdFinalizeOutcomes() {
  const runId = argOption('run-id');
  const ledgerPath = argOption('ledger');
  const resultPath = argOption('result');
  const roundOpt = argOption('round');
  if (!runId || !ledgerPath || !resultPath) {
    return emitError('BAD_INPUT', '--run-id <id> --ledger <path> --result <path> are all required');
  }

  let result, ledgerRaw;
  try { result = JSON.parse(readFileSync(resultPath, 'utf8')); }
  catch (e) { return emitError('BAD_INPUT', `cannot read --result (${resultPath}): ${e.message}`); }
  try { ledgerRaw = JSON.parse(readFileSync(ledgerPath, 'utf8')); }
  catch (e) { return emitError('BAD_INPUT', `cannot read --ledger (${ledgerPath}): ${e.message}`); }

  if (!result || typeof result !== 'object' || !Array.isArray(result.findings)) {
    return emitError('BAD_INPUT', 'result file must be an object with a "findings" array');
  }
  // Ledger is { entries: [...] }; tolerate a bare array (matches write-code-outcomes).
  const ledger = Array.isArray(ledgerRaw) ? { entries: ledgerRaw } : ledgerRaw;
  if (!ledger || !Array.isArray(ledger.entries)) {
    return emitError('BAD_INPUT', 'ledger file must have an "entries" array');
  }
  const round = Number.isInteger(Number(roundOpt)) ? Number(roundOpt) : (result.round || 1);

  await initLearningStore().catch(() => { /* cloud optional */ });
  const cloud = await isCloudEnabled();

  // §R2-H2: cloud off → local-only no-op. Delegate to the shared finalize with
  // store=null so it degrades to the local `.audit/outcomes.jsonl` write.
  if (!cloud) {
    const status = await finalizeRoundOutcomes({ result, ledger, round, store: null, sid: null });
    return emit({
      ok: true, cloud: false, runId: null, round,
      labelled: status.labelled, total: status.total, needsTriage: 0, autoDismissed: 0,
      hint: 'AUDIT_DB_URL unset — local-only capture; run npm run setup:cloud to enable cloud finalize',
    });
  }

  // §R2-H2: cloud on but the run_id does not exist → hard error (bad threaded id).
  if (!await auditRunExists(runId)) {
    return emitError('UNKNOWN_RUN',
      `run_id ${runId} not found in audit_runs (cloud is configured) — was --run-id threaded correctly?`);
  }

  // Delegate to the single shared finalize (same logic as the orchestrator +
  // write-code-outcomes). Inject the explicit --run-id as the cloud key.
  const store = { recordAdjudicationEvent, updatePassStatsPostDeliberation, updateRunMeta };
  const status = await finalizeRoundOutcomes(
    { result: { ...result, _cloudRunId: runId }, ledger, round, store, sid: runId },
  );
  const { enriched, cloudOk, needsTriage, autoDismissed } = status;
  // Control-marker findings (e.g. ADJACENCY_INCOMPLETE) are routed to
  // auto_dismissed, not needs_triage — exclude them from the echoed list so
  // it doesn't claim a human needs to look at machine-generated coverage
  // noise. Mirrors the split the DB write is driven by (splitPendingFindings).
  const pending = enriched.filter(f => f.adjudicationOutcome === 'pending' && !isControlMarkerDetail(f.detail));

  const labelled = status.labelled;
  process.stderr.write(
    `  [finalize-outcomes] run ${runId}: ${labelled}/${result.findings.length} labelled · `
    + `${needsTriage} needs_triage · ${autoDismissed} auto_dismissed · cloud=${cloudOk ? 'ok' : 'failed'}\n`,
  );
  emit({
    ok: true, cloud: true, runId, round,
    labelled, total: result.findings.length, needsTriage, autoDismissed, cloudOk,
    needsTriageFindings: pending.map(f => ({
      id: f.id, fingerprint: f._hash || semanticId(f),
      severity: f.severity, section: f.section,
    })),
    // NOTE: passCounts was dropped when cmdFinalizeOutcomes was refactored onto the
    // shared finalizeRoundOutcomes (which doesn't return it) — referencing it here
    // ReferenceError'd. The per-pass counts live in audit_pass_stats; not needed in this echo.
  });
}

// ── Persona-test subcommands (replace curl blocks in persona-test SKILL.md) ──

const ListPersonasRequestSchema = z.object({
  url: z.url(),
});

async function cmdListPersonas() {
  const urlFlag = argOption('url');
  const p = urlFlag ? { url: urlFlag } : parsePayload();
  const parsed = ListPersonasRequestSchema.safeParse(p);
  if (!parsed.success) return emitError('BAD_INPUT', '--url <app_url> is required', { issues: parsed.error.issues });

  const cloud = await isPersonaCloudEnabled();
  if (!cloud) return emit({ ok: true, cloud: false, rows: [] });

  const rows = await listPersonasForApp(parsed.data.url);
  emit({ ok: true, cloud: true, rows });
}

const AddPersonaRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  appUrl: z.url(),
  appName: z.string().optional(),
  notes: z.string().optional(),
  repoName: z.string().optional(),
});

async function cmdAddPersona() {
  const p = parsePayload();
  const parsed = AddPersonaRequestSchema.safeParse(p);
  if (!parsed.success) {
    return emitError('BAD_INPUT', 'name, description, appUrl are required', { issues: parsed.error.issues });
  }

  const cloud = await isPersonaCloudEnabled();
  if (!cloud) return emit({ ok: true, cloud: false, personaId: null, existed: false });

  const { personaId, existed } = await upsertPersona(parsed.data);
  emit({ ok: !!personaId, cloud: true, personaId, existed });
}

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

async function cmdRecordPersonaSession() {
  const p = parsePayload();
  if (!p.commitSha) p.commitSha = currentCommitSha() || undefined;
  const parsed = RecordPersonaSessionRequestSchema.safeParse(p);
  if (!parsed.success) {
    return emitError('BAD_INPUT', 'session payload failed validation', { issues: parsed.error.issues });
  }

  const cloud = await isPersonaCloudEnabled();
  if (!cloud) return emit({ ok: true, cloud: false, sessionId: null, existed: false, statsUpdated: false });

  // Resolve the CANONICAL repo identity (stable repo_uuid → audit_repos.id) from
  // the runner's cwd, so the session joins natively to audit_runs/findings
  // regardless of the bare-vs-owner/repo display name. resolveRepoForStore mints
  // the canonical row if this repo has never been audited (persona is a
  // legitimate identity writer). Best-effort: a resolution failure leaves repo_id
  // null and the session still records by name.
  const data = { ...parsed.data };
  // WS-C2: mint the session_id in code when the caller omitted it. Keeps the
  // weak `persona-test-<unix>` shape the LLM used to author out of the identity
  // path entirely, without breaking re-posts (an explicit id passes through).
  const mintedSessionId = data.sessionId ? null : buildPersonaSessionId();
  if (mintedSessionId) data.sessionId = mintedSessionId;
  // Populate BOTH the canonical repo_id (native join key) and the denormalized
  // repo_name. repo_name is load-bearing, not cosmetic: the `audit_effectiveness`
  // view joins `persona_test_sessions.repo_name = audit_repos.name`, so a null
  // here silently drops the session from precision/recall entirely. Resolve when
  // EITHER is missing (a caller may pass repoId but omit the name).
  if (!data.repoId || !data.repoName) {
    const ref = await resolveRepoForStore({}).catch(() => null);
    if (ref?.repoRowId && !data.repoId) data.repoId = ref.repoRowId;
    if (ref?.name && !data.repoName) data.repoName = ref.name;
  }

  const result = await recordPersonaSession(data);
  const correlationSummary = await runAutoCorrelate(data, result.sessionId);
  // `sessionKey` is the persona_test_sessions.session_id TEXT (the idempotency
  // key); `sessionId` is the row's uuid PK, which is what downstream correlation
  // calls take. Surfacing the key lets a caller re-post the same session.
  emit({ ok: !!result.sessionId, cloud: true, ...result, sessionKey: data.sessionId, correlationSummary });
}

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
async function runAutoCorrelate(data, sessionId) {
  const base = { attempted: false, candidates: 0, exact: 0, fuzzy: 0, missed: 0, skippedExisting: 0, malformed: 0, writeFailed: 0, matcherVersion: MATCHER_VERSION };
  // A null sessionId means recordPersonaSession's OWN write failed (a
  // genuine DB error inside its catch block — cloud is already confirmed
  // on by this point) — distinct from "no repo identity", which is a
  // resolvable-input problem, not a write failure. Nothing to attach
  // correlations to either way; result.sessionId===null already surfaces
  // via the overall response's `ok: false`.
  if (!sessionId) return { ...base, reason: 'session-write-failed' };
  if (data.autoCorrelate === false) return { ...base, reason: 'disabled-by-flag' };
  if (!data.repoId) return { ...base, reason: 'no-repo-identity' };

  const p0p1 = (data.findings || []).filter((f) => f?.code === 'P0' || f?.code === 'P1');
  if (p0p1.length === 0) return { ...base, reason: 'no-p0p1-findings' };

  try {
    const candResult = await getCandidateAuditFindings({ repoId: data.repoId, exactCommitSha: data.commitSha || null });
    if (!candResult.ok) {
      process.stderr.write(`  [correlator] candidate read failed: ${candResult.error}\n`);
      return { ...base, attempted: true, reason: 'candidate-read-failed' };
    }
    if (candResult.rows.length === 0) {
      // Ground-truth integrity (WS1): a session with zero eligible audit
      // runs is NOT evidence of an audit miss — emit nothing.
      return { ...base, attempted: true, reason: 'no-candidate-runs' };
    }

    const existResult = await getExistingCorrelationHashesForSession(sessionId);
    if (!existResult.ok) {
      process.stderr.write(`  [correlator] existence check failed: ${existResult.error}\n`);
      return { ...base, attempted: true, candidates: candResult.rows.length, reason: 'existence-check-failed' };
    }

    const { emissions, skippedExisting, malformed } = decideCorrelations({
      findings: data.findings, clickPath: data.clickPath,
      candidates: candResult.rows, alreadyCorrelatedHashes: existResult.hashes,
    });
    if (malformed > 0) {
      process.stderr.write(`  [correlator] session ${sessionId}: ${malformed} P0/P1 finding(s) quarantined (missing element/observed) — not correlated\n`);
    }

    let exact = 0, fuzzy = 0, missed = 0, writeFailed = 0;
    for (const emission of emissions) {
      if (emission._tier === 'exact') exact += 1;
      else if (emission._tier === 'fuzzy') fuzzy += 1;
      else missed += 1;
      const writeResult = await recordPersonaAuditCorrelation(sessionId, emission);
      if (!writeResult.ok) {
        writeFailed += 1;
        process.stderr.write(`  [correlator] write failed for finding ${emission.personaFindingHash}: ${writeResult.error}\n`);
      }
    }

    const summary = {
      attempted: true, candidates: candResult.rows.length,
      exact, fuzzy, missed, skippedExisting, malformed, writeFailed, matcherVersion: MATCHER_VERSION,
    };
    if (writeFailed > 0) {
      process.stderr.write(`  [correlator] session ${sessionId}: ${writeFailed}/${emissions.length} correlation writes failed\n`);
    }
    return summary;
  } catch (err) {
    // Best-effort invariant (graceful degradation #16): correlator failure
    // NEVER fails the already-committed session write — but is always
    // visible via stderr + the reason union, never a silent no-op.
    process.stderr.write(`  [correlator] unexpected failure: ${err.message}\n`);
    return { ...base, attempted: true, reason: 'candidate-read-failed', error: err.message };
  }
}

// ── WS4 — durable persona-finding outcome labels ───────────────────────────
// docs/plans/persona-nav-feedback-recovery.md. Single subcommand, three
// modes (summary | label | --worksheet), mirroring the `quality <verb>`
// dispatch pattern already established in this CLI.

const PERSONA_OUTCOME_VALUES = ['fixed', 'dismissed', 'wont_fix', 'stale'];

async function cmdPersonaOutcomes() {
  const sub = rest[0];
  await initLearningStore();

  if (process.argv.includes('--worksheet')) {
    const repoName = argOption('repo');
    if (!repoName) return emitError('BAD_INPUT', '--repo <name> is required for --worksheet');
    // 88bc75e1/8993b96f: repoName alone is an ambiguous, caller-supplied
    // display string — resolve the stable repoId (same mechanism used
    // elsewhere in this file) so session selection can't land on a
    // different repo that happens to share the name. --repo-id overrides
    // when supplied; otherwise best-effort from the current git remote.
    const repoId = argOption('repo-id') || (await resolveRepoIdentityQuiet());
    const res = await getActionablePersonaOutcomeItems({ repoName, repoId });
    if (!res.ok) return emitError('STORE_ERROR', res.error || 'worksheet query failed');
    if (!res.cloud) return emit({ ok: true, cloud: false, count: 0 });
    const { renderAdjudicationWorksheet } = await import('./lib/adjudication-worksheet.mjs');
    const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
    const md = renderAdjudicationWorksheet({
      title: `Persona-finding outcome labels — repo ${repoName}`,
      introLines: [
        'Actionable P0/P1 persona findings: never labeled, OR labeled fixed/stale but' +
        ' reappearing in the latest session (a regression). Labeling a finding' +
        ' dismissed/wont_fix requires --rationale and retires any auto-emitted' +
        ' audit_missed ground truth for the same hash.',
        res.truncated
          ? `Showing 50 of more actionable findings — re-run after labeling to see the rest.`
          : '',
      ].filter(Boolean),
      items: res.items.map((it) => ({
        runId: it.sessionId, fingerprint: it.personaFindingHash, severity: it.severity,
        category: it.outcome ? `relabel (was: ${it.outcome})` : 'unlabeled',
        file: it.element, detail: it.observed,
      })),
      actions: ['fixed', 'dismissed', 'wont_fix', 'stale'],
      commandFor: (it, a) => `node scripts/cross-skill.mjs persona-outcomes label --session ${it.runId} --hash ${it.fingerprint} --outcome ${a}${(a === 'dismissed' || a === 'wont_fix') ? ' --rationale "<why>"' : ''}`,
      generatedAt: new Date().toISOString(),
    });
    const dir = existsSync('docs/arm-eval') ? 'docs/arm-eval/worksheets' : '.audit';
    const out = argOption('out') || `${dir}/persona-outcomes-worksheet.md`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(out, md);
    process.stderr.write(`  [persona-outcomes] worksheet: ${res.items.length} actionable finding(s) → ${out}\n`);
    return emit({ ok: true, cloud: true, count: res.items.length, truncated: res.truncated, worksheet: out });
  }

  if (sub === 'summary') {
    const repoName = argOption('repo') || process.env.PERSONA_TEST_REPO_NAME;
    if (!repoName) return emitError('BAD_INPUT', '--repo <name> is required (or set PERSONA_TEST_REPO_NAME)');
    // 88bc75e1/8993b96f: same repoId-primary resolution as --worksheet above.
    const repoId = argOption('repo-id') || (await resolveRepoIdentityQuiet());
    const res = await getPersonaOutcomesSummary({ repoName, repoId });
    return emit(res);
  }

  if (sub === 'label') {
    const p = parsePayload();
    const sessionId = p.sessionId ?? argOption('session');
    const hash = p.personaFindingHash ?? argOption('hash');
    const outcome = p.outcome ?? argOption('outcome');
    const rationale = p.rationale ?? argOption('rationale') ?? null;
    const labeledBy = p.labeledBy ?? argOption('by') ?? 'agent';
    if (!sessionId || !hash || !outcome) {
      return emitError('BAD_INPUT', '--session <id> --hash <h> --outcome <fixed|dismissed|wont_fix|stale> are all required');
    }
    if (!PERSONA_OUTCOME_VALUES.includes(outcome)) {
      return emitError('BAD_INPUT', `--outcome must be one of ${PERSONA_OUTCOME_VALUES.join('|')}, got "${outcome}"`);
    }
    if ((outcome === 'dismissed' || outcome === 'wont_fix') && !(rationale && rationale.trim())) {
      return emitError('BAD_INPUT', `--rationale is required for outcome "${outcome}"`);
    }
    const target = await resolveLabelTarget({ sessionId, personaFindingHash: hash });
    if (!target.ok) return emitError('BAD_INPUT', target.error);
    const result = await upsertPersonaFindingOutcome({
      repoId: target.repoId, personaFindingHash: hash, outcome,
      lastSeenSessionId: sessionId, labeledBy, rationale,
    });
    if (!result.ok) return emitError('WRITE_FAILED', result.error || 'label write failed');
    return emit({ ok: true, cloud: true });
  }

  if (sub === 'backfill-hash') {
    const repoName = argOption('repo');
    if (!repoName) return emitError('BAD_INPUT', '--repo <name> is required for backfill-hash');
    const repoId = argOption('repo-id') || (await resolveRepoIdentityQuiet());
    if (!repoId) return emitError('BAD_INPUT', 'could not resolve a repoId — pass --repo-id explicitly');
    const dryRun = process.argv.includes('--dry-run');
    const reportPath = argOption('report-path');
    const res = await backfillPersonaFindingHashV2({ repoId, dryRun, reportPath });
    if (res.alreadyCurrent) {
      process.stderr.write(`  [persona-outcomes backfill-hash] repo ${repoName}: already current, nothing to migrate\n`);
    } else {
      process.stderr.write(
        `  [persona-outcomes backfill-hash] repo ${repoName}${dryRun ? ' (dry-run)' : ''}: ` +
        `scanned=${res.scanned} recoveredThisRun=${res.recoveredThisRun} ` +
        `reconciledThisRun=${res.reconciledThisRun} ` +
        `targetAlreadyExists=${res.targetAlreadyExists} unrecoverable=${res.unrecoverable} ` +
        `ambiguous=${res.ambiguousCount}${res.ambiguousReportPath ? ` (report: ${res.ambiguousReportPath})` : ''}\n`,
      );
    }
    return emit({ ok: true, ...res });
  }

  return emitError('BAD_INPUT', 'usage: persona-outcomes <summary|label|backfill-hash> [flags] | persona-outcomes --worksheet --repo <name>');
}

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

async function cmdGetPersonaSessionsByRepo() {
  const repoFlag = argOption('repo');
  const limitFlag = argOption('limit');
  const p0OnlyFlag = rest.includes('--p0-only');
  const selectFlag = argOption('select');

  let p;
  if (repoFlag) {
    p = {
      repoName: repoFlag,
      ...(limitFlag ? { limit: Number(limitFlag) } : {}),
      ...(p0OnlyFlag ? { p0Only: true } : {}),
      ...(selectFlag ? { select: selectFlag.split(',').map(s => s.trim()).filter(Boolean) } : {}),
    };
  } else {
    p = parsePayload();
  }

  const parsed = GetPersonaSessionsByRepoSchema.safeParse(p);
  if (!parsed.success) {
    return emitError('BAD_INPUT', '--repo <name> required (optional: --limit <n>, --p0-only, --select <csv>)', { issues: parsed.error.issues });
  }

  const cloud = await isPersonaCloudEnabled();
  if (!cloud) return emit({ ok: true, cloud: false, rows: [] });

  const rows = await getPersonaSessionsByRepo(parsed.data);
  emit({ ok: true, cloud: true, rows });
}

/**
 * get-reachability-evidence — per-persona reached destinations for /nav-audit
 * --bootstrap seeding. Cloud-off / reader-error both degrade to `{personas:[]}`
 * (the store already swallows DB errors), so --bootstrap never aborts (R1-M5/R2-H2).
 */
async function cmdGetReachabilityEvidence() {
  const repoFlag = argOption('repo');
  const limitFlag = argOption('limit');
  const sinceDaysFlag = argOption('since-days');

  const p = repoFlag
    ? {
        repoName: repoFlag,
        ...(limitFlag ? { limit: Number(limitFlag) } : {}),
        ...(sinceDaysFlag ? { sinceDays: Number(sinceDaysFlag) } : {}),
      }
    : parsePayload();

  const parsed = ReachabilityEvidenceRequestSchema.safeParse(p);
  if (!parsed.success) {
    return emitError('BAD_INPUT', '--repo <name> required (optional: --limit <n> per-persona, --since-days <d>)', { issues: parsed.error.issues });
  }

  const cloud = await isPersonaCloudEnabled();
  if (!cloud) return emit({ ok: true, cloud: false, personas: [] });

  const { personas } = await getReachabilityEvidence({
    repoName: parsed.data.repoName,
    ...(parsed.data.limit ? { perPersona: parsed.data.limit } : {}),
    ...(parsed.data.sinceDays ? { sinceDays: parsed.data.sinceDays } : {}),
  });
  // Guarantee the structural contract before emission (R2-M2) — a reader drift
  // never ships a malformed payload to the nav-audit consumer; degrade to empty.
  const validated = ReachabilityEvidenceResponseSchema.safeParse({ ok: true, cloud: true, personas });
  if (!validated.success) {
    process.stderr.write('[cross-skill] reachability response failed its schema — emitting empty\n');
    return emit({ ok: true, cloud: true, personas: [] });
  }
  emit(validated.data);
}

/**
 * À-la-carte "what's worth running next" advisor (skill-recommender.mjs). Gathers
 * the signals — changed files (git, or `--changed`), live-URL env, audit findings
 * (`--findings <file>`, highest signal), plan lenses (`--plan-lenses`), and the
 * idempotent ux-lock signal (`unlocked_fixes` view) — and emits the ranked, capped,
 * possibly-empty recommendation set + a human card. Deterministic, nudge-not-gate,
 * silent when nothing fits.
 */
async function cmdRecommendSkills() {
  const csv = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
  const changedFiles = argOption('changed') ? csv(argOption('changed')) : gitChangedFiles();
  // `PERSONA_TEST_APP_URL` unset is not the same fact as "no live target" — a repo
  // that only sets the env var for CI/PR-preview but runs a normal local dev server
  // otherwise has a runnable URL this env-only check would miss. `--url` lets a
  // caller (e.g. /cycle with --persona-url) pass the actual target explicitly,
  // mirroring how every other persona-test-adjacent subcommand resolves its URL.
  const hasLiveUrl = Boolean(argOption('url') || process.env.PERSONA_TEST_APP_URL);
  const justRan = argOption('just-ran') || null;
  const max = Number.isFinite(Number(argOption('max'))) && argOption('max') ? Number(argOption('max')) : 2;
  const planLenses = csv(argOption('plan-lenses'));

  // Audit findings (tier-1 signal) from a `--findings <file>` (the `/audit-code` --out).
  let auditFindings = [];
  const findingsFile = argOption('findings');
  if (findingsFile) {
    try {
      const raw = JSON.parse(readFileSync(findingsFile, 'utf8'));
      auditFindings = Array.isArray(raw) ? raw
        : (Array.isArray(raw.findings) ? raw.findings
          : (Array.isArray(raw.allFindings) ? raw.allFindings : []));
    } catch (e) { process.stderr.write(`  [recommend] could not read --findings ${findingsFile}: ${e.message}\n`); }
  }

  // Idempotent ux-lock signal: a HIGH/P0 fix without a /ux-lock spec. Graceful when
  // cloud is off (no signal, not an error).
  let unlockedHighFix = false;
  try {
    await initLearningStore();
    const ref = await resolveRepoForStore({}).catch(() => null);
    if (ref?.repoRowId) {
      const rows = await getUnlockedFixes({ repoId: ref.repoRowId });
      unlockedHighFix = Array.isArray(rows) && rows.length > 0;
    }
  } catch { /* cloud off / store error → no ux-lock signal, proceed */ }

  const recommendations = recommendSkills({ changedFiles, hasLiveUrl, auditFindings, planLenses, unlockedHighFix, justRan, max });
  const card = renderRecommendationCard(recommendations);
  // The pool now exits-on-idle (db/client.mjs allowExitOnIdle), so this one-shot
  // CLI ends promptly without an explicit teardown.
  if (argOption('format') === 'human') { process.stdout.write(card); return; }
  emit({ ok: true, hasLiveUrl, recommendations, card });
}

/**
 * preview-gate — resolve the deploy-topology gate for /cycle Step 5 from `PREVIEW_GATE_MODE`
 * (config SSoT). The executable seam the cycle SKILL CALLS (never re-implements the decision in
 * prose). Prints {mode, action, message}; `--format human` prints a one-line directive.
 */
async function cmdPreviewGate() {
  const gate = resolvePreviewGate(cycleConfig);
  if (argOption('format') === 'human') {
    const tag = gate.action === 'halt' ? 'HALT' : gate.action === 'warn' ? 'WARN' : 'OK';
    process.stdout.write(gate.message ? `[${tag}] ${gate.message}\n` : `[OK] preview gate not_applicable — no action.\n`);
    return;
  }
  emit({ ok: true, ...gate });
}

/** Changed files vs HEAD (tracked) + untracked. Empty on any git failure. */
function gitChangedFiles() {
  const run = (cmd) => {
    try {
      return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })
        .split('\n').map((s) => s.trim()).filter(Boolean);
    } catch { return []; }
  };
  return [...new Set([...run('git diff --name-only HEAD'), ...run('git ls-files --others --exclude-standard')])];
}

// /persona-test Phase 0d pre-test enrichment: recent HIGH/MEDIUM audit
// findings for a repo, so the persona explores known-fragile flows with
// sharper Reflect judgement. Replaces the dead PostgREST curl (M4 removed
// supabase-js). Graceful empty result when cloud is off or the repo is
// unknown — the skill treats `[]` as "no audit context", never an error.
async function cmdGetRecentFindings() {
  const repoFlag = argOption('repo');
  const limitFlag = argOption('limit');
  const severityFlag = argOption('severity'); // CSV, e.g. "HIGH,MEDIUM"

  const p = (repoFlag || limitFlag || severityFlag)
    ? {
        ...(repoFlag ? { repoName: repoFlag } : {}),
        ...(limitFlag ? { limit: Number(limitFlag) } : {}),
        ...(severityFlag ? { severities: severityFlag.split(',').map(s => s.trim()).filter(Boolean) } : {}),
      }
    : parsePayload();

  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, findings: [] });

  // Identity-first: resolve the CANONICAL repo_id (stable repo_uuid →
  // audit_repos.id) from the runner's cwd, so enrichment matches the audit
  // findings regardless of the bare-vs-owner/repo display name. An explicit
  // --repo <name> is a deliberate cross-repo override and always wins — skip
  // cwd auto-resolution entirely so getRecentFindingsByRepo's own
  // repoId-then-repoName fallback resolves the REQUESTED repo, not whichever
  // repo the cwd happens to be (the bug: checking `!p.repoId` here let cwd
  // resolution silently clobber an explicit `--repo` every time, since the
  // flag only ever populates `p.repoName`).
  if (!p.repoId && !p.repoName) {
    const repoUuid = resolveRepoIdentity(process.cwd())?.repoUuid;
    const row = repoUuid ? await getRepoIdByUuid(repoUuid).catch(() => null) : null;
    if (row?.id) p.repoId = row.id;
  }
  if (!p.repoId && !p.repoName) {
    return emitError('BAD_INPUT', 'no repo identity — run from a repo root or pass --repo <name> (optional: --limit <n>, --severity HIGH,MEDIUM)');
  }

  const findings = await getRecentFindingsByRepo(p);
  emit({ ok: true, cloud: true, findings });
}

const GetPersonaSessionsByUrlSchema = z.object({
  url: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  select: z.array(z.string().min(1)).optional(),
});

async function cmdGetPersonaSessionsByUrl() {
  const urlFlag = argOption('url');
  const limitFlag = argOption('limit');
  const selectFlag = argOption('select');

  let p;
  if (urlFlag) {
    p = {
      url: urlFlag,
      ...(limitFlag ? { limit: Number(limitFlag) } : {}),
      ...(selectFlag ? { select: selectFlag.split(',').map(s => s.trim()).filter(Boolean) } : {}),
    };
  } else {
    p = parsePayload();
  }

  const parsed = GetPersonaSessionsByUrlSchema.safeParse(p);
  if (!parsed.success) {
    return emitError('BAD_INPUT', '--url <app_url> required (optional: --limit <n>, --select <csv>)', { issues: parsed.error.issues });
  }

  const cloud = await isPersonaCloudEnabled();
  if (!cloud) return emit({ ok: true, cloud: false, rows: [] });

  const rows = await getPersonaSessionsByUrl(parsed.data);
  emit({ ok: true, cloud: true, rows });
}

async function cmdDetectStack() {
  const cwd = argOption('cwd') || process.cwd();
  const includeEnvManager = rest.includes('--include-env-manager');
  const { stack, pythonFramework, detectedFrom, stackKinds } = detectRepoStack(cwd);
  const profile = {
    ok: true,
    stack,
    pythonFramework,
    environmentManager: includeEnvManager ? detectPythonEnvironmentManager(cwd) : null,
    detectedFrom,
    stackKinds: stackKinds ?? [],
  };
  const parsed = StackProfileSchema.safeParse(profile);
  if (!parsed.success) {
    return emitError('SCHEMA_VIOLATION', 'detect-stack produced invalid profile', { issues: parsed.error.issues });
  }
  emit(parsed.data);
}

async function cmdWhoami() {
  await initLearningStore();
  // M4: a single Postgres store (AUDIT_DB_URL) backs every feature. `cloud`
  // is the one source of truth — isCloudEnabled() is async (pool-presence),
  // so it MUST be awaited or it serialises as a pending Promise (`{}`). The
  // legacy supabaseConfigured/serviceRoleConfigured fields keyed off the
  // sunset SUPABASE_AUDIT_* vars (no runtime code reads them) and were
  // dropped.
  emit({
    ok: true,
    cloud: await isCloudEnabled(),
    commitSha: currentCommitSha(),
    branch: currentBranch(),
  });
}

// ── Architectural Memory subcommands (Phase A) ──────────────────────────────

async function cmdGetActiveRefreshId() {
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, refreshId: null });
  const repoUuid = argOption('repo-uuid');
  if (!repoUuid) return emitError('BAD_INPUT', '--repo-uuid required');
  const repo = await getRepoIdByUuid(repoUuid);
  if (!repo) return emit({ ok: true, cloud: true, repoFound: false, refreshId: null });
  const snap = await getActiveSnapshot(repo.id);
  emit({
    ok: true,
    cloud: true,
    repoFound: true,
    refreshId: snap?.refreshId || null,
    activeEmbeddingModel: snap?.activeEmbeddingModel || null,
    activeEmbeddingDim: snap?.activeEmbeddingDim || null,
  });
}

async function cmdGetIncidentNeighbourhood() {
  const p = parsePayload();
  await initLearningStore();
  if (!await isCloudEnabled()) {
    return emit({
      ok: true, cloud: false, records: [], totalCandidatesConsidered: 0,
      freshnessWarning: null,
      hint: 'cloud disabled — security memory unavailable',
    });
  }
  // Same provider-absent degrade as cmdGetNeighbourhood (see comment there).
  {
    const { isEmbedProviderAvailable } = await import('./lib/embed-text.mjs');
    if (!await isEmbedProviderAvailable()) {
      return emit({
        ok: true, cloud: true, records: [], totalCandidatesConsidered: 0,
        freshnessWarning: null, degraded: 'no-embed-provider',
        hint: 'no embedding provider — set GEMINI_API_KEY (or activate the Azure profile) to enable incident consultation',
      });
    }
  }
  // Resolve repoUuid: explicit takes precedence; else derive from cwd
  let repoUuid = p.repoUuid;
  if (!repoUuid) repoUuid = resolveRepoIdentity(process.cwd()).repoUuid;
  try {
    const { getIncidentNeighbourhoodForIntent } = await import('./lib/neighbourhood-query.mjs');
    const { callIncidentNeighbourhoodRpc, getMaxIncidentRefreshAt } = await import('./learning-store.mjs');
    const wrapped = await getIncidentNeighbourhoodForIntent(
      {
        getRepoIdByUuid,
        getActiveSnapshot,
        callIncidentNeighbourhoodRpc: (args) => callIncidentNeighbourhoodRpc(args),
        getMaxIncidentRefreshAt: (repoId) => getMaxIncidentRefreshAt(repoId),
      },
      { ...p, repoUuid },
    );
    // R-Gemini-G4: unwrap .result for flat CLI JSON shape
    emit({ ok: true, cloud: true, ...wrapped.result, _usage: wrapped.usage, _latencyMs: wrapped.latencyMs });
  } catch (err) {
    emitError(err.code || 'EXCEPTION', err.message, { issues: err.issues });
  }
}

// ── Friction-feedback loop (plan: friction-feedback-loop.md) ────────────────
// `quality` sub-dispatches to add/mirror/digest/link/session-review; the
// implementations live in lib/friction/commands.mjs (thin-dispatcher discipline,
// R1-MED). Every command returns the C8 shape; ok:false = argv/contract error.

async function cmdQuality() {
  const sub = rest[0];
  if (!sub || sub.startsWith('--')) {
    return emitError('BAD_INPUT', 'usage: quality <add|mirror|digest|link|session-review> [flags]');
  }
  await initLearningStore();
  const m = await import('./lib/friction/commands.mjs');
  let payload = {};
  try { payload = parsePayload(); } catch { payload = {}; }
  let result;
  switch (sub) {
    case 'add':
      result = await m.frictionAdd({
        title: payload.title ?? argOption('title'),
        scopeTags: payload.scopeTags ?? [...argList('scope-tags'), ...argAll('scope-tag')],
        cost: payload.cost ?? argOption('cost') ?? undefined,
        name: payload.name ?? argOption('name') ?? undefined,
        files: payload.files ?? [...argList('files'), ...argAll('file')],
        symbols: payload.symbols ?? [...argList('symbols'), ...argAll('symbol')],
        body: payload.body ?? argOption('body') ?? undefined,
      });
      break;
    case 'mirror':
      result = await m.frictionMirror({});
      break;
    case 'digest':
      result = await m.frictionDigest({
        repoScoped: hasFlag('repo-scoped') || payload.repoScoped === true,
        windowDays: payload.windowDays ?? (argOption('window-days') ? Number(argOption('window-days')) : undefined),
        minSimilarity: payload.minSimilarity ?? (argOption('min-similarity') ? Number(argOption('min-similarity')) : undefined),
      });
      break;
    case 'link':
      result = await m.frictionLink({
        memory: payload.memory ?? argOption('memory'),
        kind: payload.kind ?? argOption('kind'),
        ref: payload.ref ?? argOption('ref'),
      });
      break;
    case 'session-review':
      result = await m.frictionSessionReview({
        windowHours: payload.windowHours ?? (argOption('window-hours') ? Number(argOption('window-hours')) : undefined),
      });
      break;
    default:
      return emitError('BAD_INPUT', `unknown quality subcommand: ${sub}`);
  }
  emit(result);
  if (result && result.ok === false) process.exit(2);
}

// ── Upstream issue reports (plan: upstream-issue-reports.md) ────────────────
// `upstream` sub-dispatches to report/list/ack/fix/wont-fix/drain; the
// implementations live in lib/upstream/commands.mjs (thin-dispatcher
// discipline, same shape as `quality`).

/** Read the report body from stdin — multiline prose must never be an argv string. */
async function readStdinBody() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

async function cmdUpstream() {
  const sub = rest[0];
  const VERBS = ['report', 'list', 'ack', 'fix', 'wont-fix', 'drain'];
  if (!sub || !VERBS.includes(sub)) {
    return emitError('BAD_INPUT', `usage: upstream <${VERBS.join('|')}> [flags]`);
  }

  const m = await import('./lib/upstream/commands.mjs');
  const store = await import('./lib/store/upstream-issues.mjs');
  await initLearningStore();
  const cloud = await isCloudEnabled();
  const repoRoot = process.cwd();

  // Best-effort drain on EVERY verb: gated on the directory existing, so a run
  // with nothing pending costs one stat. Triggering only on report/list would
  // mean the outbox never drains on a consumer — `list` is a source-side
  // command consumers never run, and `report` is by definition rare.
  // Returns `{error}` rather than swallowing: an explicit `upstream drain` must
  // never report a success shape when the drain actually failed — that is the
  // "green having done nothing" class this repo audits its success paths for.
  // A failure on the piggybacked path is still non-fatal (it is housekeeping),
  // but it is always *reported*.
  const drainIfPending = async () => {
    if (!cloud) return { drained: 0, rejected: 0, failed: 0, skipped: 'cloud-off' };
    try {
      return await m.drainOutbox({
        repoRoot,
        recordFn: async (p) => store.recordUpstreamIssue({
          ...p, repoId: p.repoId ?? await resolveRepoId({}),
        }),
      });
    } catch (err) {
      process.stderr.write(`  [upstream] outbox drain failed: ${err.message}\n`);
      return { drained: 0, rejected: 0, failed: 0, error: err.message };
    }
  };

  try {
    if (sub === 'drain') {
      const r = await drainIfPending();
      // An explicit drain that hit an error is NOT ok — the caller asked for
      // this work specifically, so a failure is the answer, not a footnote.
      if (r.error) return emitError('DRAIN_FAILED', r.error, { cloud, ...r });
      return emit({ ok: true, cloud, ...r });
    }

    const drain = await drainIfPending();

    if (sub === 'report') {
      const body = argOption('body') ?? await readStdinBody();
      const res = await m.upstreamReport({
        repoRoot,
        repoUuid: resolveRepoIdentity(repoRoot).repoUuid,
        repoId: cloud ? await resolveRepoId({}) : null,
        title: argOption('title'),
        body,
        severity: (argOption('severity') || 'MEDIUM').toUpperCase(),
        affectedPath: argOption('affected-path'),
        actor: argOption('actor') || null,
        cloudEnabled: cloud,
        recordFn: (p) => store.recordUpstreamIssue(p),
      });
      if (!res.ok) return emitError(res.code || 'BAD_INPUT', res.errors.join('; '), { errors: res.errors });
      return emit({ ...res, drain });
    }

    if (sub === 'list') {
      const state = argOption('state') || 'open';
      const before = argOption('before')
        ? JSON.parse(Buffer.from(argOption('before'), 'base64url').toString('utf-8'))
        : null;
      const res = await m.upstreamList({
        repoRoot, state, before,
        limit: argOption('limit') ? Number(argOption('limit')) : undefined,
        repoId: argOption('repo-id') || null,
        listFn: (o) => store.listUpstreamIssues(o),
        priorFixesFn: (p, id) => store.findPriorFixes(p, id),
      });
      if (process.argv.includes('--worksheet')) {
        process.stdout.write(m.renderWorksheet(res.items || [], { state }) + '\n');
        return;
      }
      // The cursor is opaque + base64url so an operator can paste it back
      // without shell-quoting a JSON object.
      const nextCursor = res.nextCursor
        ? Buffer.from(JSON.stringify(res.nextCursor), 'utf-8').toString('base64url')
        : null;
      return emit({ ...res, nextCursor, drain });
    }

    // ack | fix | wont-fix
    const to = sub === 'ack' ? 'acknowledged' : sub === 'fix' ? 'fixed' : 'wont_fix';
    const res = await m.upstreamTransition({
      repoRoot, to,
      id: argOption('id'),
      note: argOption('note'),
      commit: argOption('commit'),
      actor: argOption('actor') || null,
      transitionFn: (a) => store.transitionUpstreamIssue(a),
    });
    if (!res.ok) {
      const code = res.code || (res.illegal ? 'ILLEGAL_TRANSITION'
        : res.notFound ? 'NOT_FOUND' : res.conflict ? 'CONFLICT' : 'EXCEPTION');
      return emitError(code, res.errors ? res.errors.join('; ') : res.error, res);
    }
    return emit(res);
  } catch (err) {
    return emitError('EXCEPTION', err.message);
  }
}

async function cmdGetFrictionNeighbourhood() {
  const p = parsePayload();
  await initLearningStore();
  const { frictionNeighbourhood } = await import('./lib/friction/commands.mjs');
  const result = await frictionNeighbourhood({
    prompt: p.prompt ?? p.intentDescription ?? argOption('prompt') ?? '',
    k: p.k ?? (argOption('k') ? Number(argOption('k')) : undefined),
  });
  emit(result);
}

async function cmdComputeTargetDomains() {
  const p = parsePayload();
  if (!p.targetPaths || !Array.isArray(p.targetPaths)) {
    return emitError('BAD_INPUT', 'targetPaths array required', {}, 1);
  }
  // Lazy import — keeps cross-skill cold-start cheap
  const { tagDomain, loadDomainRules, computeTargetDomains } =
    await import('./lib/symbol-index/domain-tagger.mjs');
  void tagDomain;
  const rules = loadDomainRules(process.cwd());
  const result = computeTargetDomains(p.targetPaths, rules);
  emit({ ok: true, ...result, ruleCount: rules.length });
}

async function cmdGetCallersForFile() {
  const p = parsePayload();
  if (typeof p.path !== 'string' || p.path.length === 0) {
    return emitError('BAD_INPUT', 'path required', {}, 1);
  }
  await initLearningStore();
  if (!await isCloudEnabled()) {
    return emit({
      ok: true, cloud: false, callers: [], callerDomains: [],
      snapshotProvenance: 'cloud-disabled',
    });
  }
  const repoUuid = resolveRepoIdentity(process.cwd()).repoUuid;
  const repo = await getRepoIdByUuid(repoUuid);
  if (!repo) {
    return emit({
      ok: true, cloud: true, callers: [], callerDomains: [],
      snapshotProvenance: 'repo-not-indexed',
    });
  }
  const snap = await getActiveSnapshot(repo.id);
  if (!snap?.refreshId) {
    return emit({
      ok: true, cloud: true, callers: [], callerDomains: [],
      snapshotProvenance: 'no-active-snapshot',
    });
  }
  // Provenance check (R1-H2 / R2-H1) — only emit caller data when the
  // snapshot's import graph is fully populated; otherwise zero-importers
  // is ambiguous and /explain should skip cross-domain reach analysis.
  const populated = snap.importGraphPopulated === true;
  if (!populated) {
    return emit({
      ok: true, cloud: true, callers: [], callerDomains: [],
      snapshotProvenance: 'pre-feature-snapshot',
    });
  }
  // Reuse loadDomainRules per R2-M3 (no inline rule reading)
  const { tagDomain, loadDomainRules } =
    await import('./lib/symbol-index/domain-tagger.mjs');
  const rules = loadDomainRules(process.cwd());

  let importers;
  try {
    const { getImportersForFiles } = await import('./learning-store.mjs');
    importers = await getImportersForFiles({
      refreshId: snap.refreshId, paths: [p.path],
    });
  } catch (err) {
    return emitError('RPC_ERROR', `getImportersForFiles failed: ${err.message}`);
  }
  const importerPaths = importers.get(p.path) || [];
  const callers = importerPaths.map(ip => ({
    importer_path: ip,
    domain: tagDomain(ip, rules),
  }));
  const callerDomains = Array.from(new Set(
    callers.map(c => c.domain).filter(d => d != null)
  )).sort();
  emit({
    ok: true, cloud: true, callers, callerDomains,
    snapshotProvenance: 'import-graph-populated',
  });
}

/**
 * Same-run overlap between a shadow reviewer and the pipeline's own audit
 * passes — the marginal-value check for any reviewer A/B. See
 * scripts/lib/model-eval/shadow-overlap.mjs for how to read the result
 * (notably: it measures WITHIN-run overlap only).
 *
 * Payload: {"runIds": ["<uuid>", ...], "shadowPass": "final-review-shadow"}
 */
async function cmdShadowOverlap() {
  const p = parsePayload();
  await initLearningStore();
  if (!await isCloudEnabled()) {
    return emit({ ok: true, cloud: false, hint: 'cloud disabled — overlap is unmeasurable locally' });
  }
  const res = await computeShadowOverlap({ runIds: p.runIds, shadowPass: p.shadowPass || 'final-review-shadow' });
  return emit({ cloud: true, ...res });
}

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
async function cmdLockWithTest() {
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, locked: false });

  if (hasFlag('worksheet')) return cmdLockWithTestWorksheet();

  const findingId = argOption('finding');
  const testPath = argOption('test');
  const description = argOption('description');
  if (!findingId || !testPath || !description) {
    // Concrete example, not `<angle-bracket>` syntax: PowerShell reserves `<`,
    // so a bracketed usage line is unpasteable on this repo's dev platform
    // (operator-doc convention, bit twice before 2026-07-02).
    return emit({ ok: false, error: 'lock-with-test needs --finding, --test and --description. Example: '
      + 'node scripts/cross-skill.mjs lock-with-test --finding a4969127-d5d0-47bb-8b2e-0acb0ed71546 '
      + '--test tests/foo.test.mjs --description "pins the NUL-delimited parse path". '
      + 'The description is mandatory: an unexplained lock is an unverifiable claim. '
      + 'Run --worksheet for the reviewed queue.' });
  }

  const { existsSync, realpathSync } = await import('node:fs');
  const nodePath = await import('node:path');
  const repoRoot = realpathSync(process.cwd());
  const abs = nodePath.resolve(repoRoot, testPath);
  // Contained-path check mirrors resolveContainedPath's intent: a lock naming
  // a file outside the repo is not evidence about this repo.
  if (!abs.startsWith(repoRoot + nodePath.sep)) {
    return emit({ ok: false, error: `refusing: "${testPath}" resolves outside the repo` });
  }
  if (!existsSync(abs)) {
    return emit({ ok: false, error: `refusing: test file "${testPath}" does not exist — a lock naming a missing file is a fake check` });
  }

  // CROSS-TENANT WRITE FENCE. This used to scan `getUnlockedFixes(null)` — an
  // arbitrary 20 cross-repo rows out of hundreds — and then adopt whatever
  // `repo_id` the matched row carried. Two defects in one line: a legitimate
  // finding usually was NOT among those 20 (so the lookup silently missed and
  // fell through), and a foreign row's repo_id could be written straight into a
  // regression spec. That is a cross-tenant MUTATION, strictly worse than the
  // cross-tenant read this change set started from.
  //
  // Now: resolve identity FIRST, look the finding up scoped to it, and take the
  // repo_id from the resolved identity — never from the fetched row.
  const ref = await resolveRepoForStore({}).catch(() => null);
  const repoId = ref?.repoRowId || null;
  if (!repoId) {
    return emit({ ok: false, error: 'refusing: repo identity unresolvable — a regression spec must be attributed to a repo, and guessing one is how another repo\'s findings got recorded.' });
  }
  const finding = await findUnlockedFixInRepo({ repoId, findingId });
  if (!finding) {
    return emit({ ok: false, error: `refusing: no unlocked finding "${findingId}" in THIS repo. If it exists elsewhere it belongs to another repository — locking it here would attribute the fix to the wrong repo.` });
  }

  const spec = await recordRegressionSpec(repoId, {
    specPath: testPath,
    description,
    sourceKind: 'unit-test',
    sourceFindingId: findingId,
    sourceFindingType: 'audit',
    assertionCount: 0,
    domContractTypes: [],
  });
  return emit({ ok: !!spec, cloud: true, locked: !!spec, findingId, testPath });
}

/**
 * Operator worksheet for the unlocked-code backlog.
 *
 * Emits markdown with REAL values and pasteable commands (never
 * `<angle-brackets>` — PowerShell reserves `<`, so a bracketed example is
 * unpasteable on the platform this repo is developed on).
 *
 * The suggested test is a FILENAME HEURISTIC and is labelled as one. It maps
 * `primary_file`'s basename to `tests/<base>.test.mjs` and reports whether that
 * file exists. It does NOT establish that the test covers the finding — that
 * judgement is the operator's, which is why this emits a queue for review
 * instead of writing rows.
 */
async function cmdLockWithTestWorksheet() {
  const { existsSync } = await import('node:fs');
  const nodePath = await import('node:path');
  // Same scope chain as list-unlocked-fixes — this is the command Step 0.5b
  // PRINTS as its own remediation, so an unscoped worksheet would hand the
  // operator another repo's findings to "fix".
  const scope = await resolveShipNudgeScope();
  if (scope.error) return emit({ ok: false, error: scope.error, reason: scope.reason });
  // PER-COMMAND SCOPE CAPABILITY (plan D21). `--all-repos` is legitimate on the
  // read-only `list-unlocked-fixes` — "show me every repo's backlog" is a real
  // operator question. It is NOT legitimate here: every row this worksheet prints
  // carries a pasteable `lock-with-test` command, and `lock-with-test` refuses a
  // finding outside the current repo (the cross-tenant write fence). A global
  // worksheet would therefore be a queue of instructions that cannot be followed
  // — the same "plausible output nobody questions" shape as the original bug.
  // Refused BEFORE any store call, so an unscoped read is never even attempted.
  if (scope.mode === 'all-repos') {
    return emit({ ok: false, reason: 'all-repos-unsupported',
      error: '--all-repos is not supported by lock-with-test --worksheet: every row it emits is a ' +
        'per-repo lock command, and lock-with-test refuses findings from another repo. ' +
        'Scope it (--repo/--repo-id, or run inside the repo), or use list-unlocked-fixes --all-repos to browse.' });
  }
  if (!scope.measured) {
    return emit({ ok: true, measured: false, reason: scope.reason, worksheet: '',
      note: 'repo scope unresolved — nothing was measured (this is NOT "no unlocked fixes").' });
  }
  const rows = (await getUnlockedFixes(storeScopeFor(scope)))
    .filter((r) => r.audit_mode === 'code');

  const lines = ['# Unlocked code fixes — regression-lock worksheet', '',
    `${rows.length} shown (query caps at 20; run \`list-unlocked-fixes\` for the true total).`,
    '',
    'The suggested test is a **filename heuristic only** — it does not prove the',
    'test covers this finding. Confirm by reading the test, then run its command.',
    'If no test covers it, write one; do NOT lock it to an unrelated file.', ''];

  for (const r of rows) {
    const base = nodePath.basename(String(r.primary_file || '')).replace(/\.mjs$/, '');
    const guess = base ? `tests/${base}.test.mjs` : null;
    const exists = guess ? existsSync(nodePath.resolve(process.cwd(), guess)) : false;
    lines.push(`## ${r.audit_finding_id}`);
    lines.push(`- file: \`${r.primary_file}\``);
    lines.push(`- category: ${r.category}`);
    lines.push(`- suggested test: ${exists ? `\`${guess}\` (exists — READ IT before locking)` : '**none found — write one**'}`);
    if (exists) {
      lines.push('', '```bash', `node scripts/cross-skill.mjs lock-with-test --finding ${r.audit_finding_id} --test ${guess} --description "pins: ${String(r.category).replace(/"/g, "'")}"`, '```');
    }
    lines.push('');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return undefined;
}

async function cmdGetNeighbourhood() {
  const p = parsePayload();
  await initLearningStore();
  if (!await isCloudEnabled()) {
    return emit({
      ok: true, cloud: false, refreshId: null, records: [], totalCandidatesConsidered: 0,
      truncated: false, hint: 'cloud disabled — run `npm run arch:refresh` to enable',
    });
  }
  // Provider-ABSENT (deterministic config state) degrades exactly like
  // cloud-disabled above — the consultation contract is "log a hint,
  // proceed greenfield", and a fresh install with a DSN but no embedding
  // provider must not read as a fatal error. Provider-ERRORS (a real call
  // failing) still surface via emitError below (2026-07-14 installer audit).
  {
    const { isEmbedProviderAvailable } = await import('./lib/embed-text.mjs');
    if (!await isEmbedProviderAvailable()) {
      return emit({
        ok: true, cloud: true, refreshId: null, records: [], totalCandidatesConsidered: 0,
        truncated: false, degraded: 'no-embed-provider',
        hint: 'no embedding provider — set GEMINI_API_KEY (or activate the Azure profile) to enable neighbourhood consultation',
      });
    }
  }
  // Resolve repoUuid: explicit takes precedence; else derive from cwd
  let repoUuid = p.repoUuid;
  if (!repoUuid) {
    repoUuid = resolveRepoIdentity(process.cwd()).repoUuid;
  }
  try {
    const out = await getNeighbourhoodForIntent({
      getRepoIdByUuid,
      getActiveSnapshot,
      getBandCalibration,
      callNeighbourhoodRpc: (args) => callNeighbourhoodRpc(args),
    }, { ...p, repoUuid });
    emit({ ok: true, cloud: true, ...out });
  } catch (err) {
    emitError(err.code || 'EXCEPTION', err.message, {
      issues: err.issues,
      expected: err.expected,
      available: err.available,
    });
  }
}

async function cmdOpenRefreshRun() {
  const p = parsePayload();
  if (!p.repoUuid || !p.mode) return emitError('BAD_INPUT', 'repoUuid and mode required');
  await initLearningStore();
  try {
    let repo = await getRepoIdByUuid(p.repoUuid);
    if (!repo) {
      const newRepo = await upsertRepoByUuid({ repoUuid: p.repoUuid, name: p.name || 'unknown' });
      if (!newRepo) return emitError('UPSERT_FAILED', 'could not create audit_repos row');
      repo = { id: newRepo.id };
    }
    const run = await openRefreshRun({
      repoId: repo.id, mode: p.mode, walkStartCommit: p.walkStartCommit,
    });
    emit({ ok: true, cloud: true, repoId: repo.id, ...run });
  } catch (err) {
    emitError(err.code || 'EXCEPTION', err.message);
  }
}

async function cmdPublishRefreshRun() {
  const p = parsePayload();
  if (!p.repoId || !p.refreshId) return emitError('BAD_INPUT', 'repoId and refreshId required');
  await initLearningStore();
  try {
    const r = await publishRefreshRun({ repoId: p.repoId, refreshId: p.refreshId });
    emit({ ok: true, cloud: true, result: r });
  } catch (err) {
    emitError(err.code || 'EXCEPTION', err.message);
  }
}

async function cmdAbortRefreshRun() {
  const p = parsePayload();
  if (!p.repoId || !p.refreshId) return emitError('BAD_INPUT', 'repoId and refreshId required');
  await initLearningStore();
  try {
    // Reflect the real outcome (shadow final-gate finding) — the same
    // false-success class already fixed for refresh-lock.mjs (round-2 L1)
    // and refresh.mjs's caller (round-4 H2): an external caller (CI,
    // another skill) that aborts a wrong-repo or already-terminal run must
    // be told so, not given an unconditional {ok:true}.
    const { aborted } = await abortRefreshRun({ refreshId: p.refreshId, repoId: p.repoId, reason: p.reason });
    emit({ ok: true, cloud: true, aborted });
  } catch (err) {
    emitError(err.code || 'EXCEPTION', err.message);
  }
}

async function cmdRecordSymbolDefinitions() {
  const p = parsePayload();
  if (!p.repoId || !Array.isArray(p.definitions)) return emitError('BAD_INPUT', 'repoId and definitions required');
  await initLearningStore();
  try {
    const map = await recordSymbolDefinitions(p.repoId, p.definitions);
    emit({ ok: true, cloud: true, definitionMap: map });
  } catch (err) {
    emitError(err.code || 'EXCEPTION', err.message);
  }
}

async function cmdRecordSymbolIndex() {
  const p = parsePayload();
  if (!p.refreshId || !p.repoId || !Array.isArray(p.rows)) {
    return emitError('BAD_INPUT', 'refreshId, repoId, rows required');
  }
  await initLearningStore();
  try {
    const n = await recordSymbolIndex(p.refreshId, p.repoId, p.rows);
    emit({ ok: true, cloud: true, inserted: n });
  } catch (err) {
    emitError(err.code || 'EXCEPTION', err.message);
  }
}

async function cmdRecordSymbolEmbedding() {
  const p = parsePayload();
  if (!p.definitionId || !p.embeddingModel || !p.dimension || !Array.isArray(p.vector)) {
    return emitError('BAD_INPUT', 'definitionId, embeddingModel, dimension, vector required');
  }
  await initLearningStore();
  try {
    await recordSymbolEmbedding(p);
    emit({ ok: true, cloud: true });
  } catch (err) {
    emitError(err.code || 'EXCEPTION', err.message);
  }
}

async function cmdRecordLayeringViolations() {
  const p = parsePayload();
  if (!p.refreshId || !p.repoId || !Array.isArray(p.violations)) {
    return emitError('BAD_INPUT', 'refreshId, repoId, violations required');
  }
  await initLearningStore();
  try {
    const n = await recordLayeringViolations(p.refreshId, p.repoId, p.violations);
    emit({ ok: true, cloud: true, inserted: n });
  } catch (err) {
    emitError(err.code || 'EXCEPTION', err.message);
  }
}

async function cmdSetActiveEmbeddingModel() {
  const p = parsePayload();
  if (!p.repoId || !p.model || !p.dim) return emitError('BAD_INPUT', 'repoId, model, dim required');
  await initLearningStore();
  try {
    await setActiveEmbeddingModel({ repoId: p.repoId, model: p.model, dim: p.dim });
    emit({ ok: true, cloud: true });
  } catch (err) {
    emitError(err.code || 'EXCEPTION', err.message);
  }
}

async function cmdListSymbolsForSnapshot() {
  const p = parsePayload();
  if (!p.refreshId) return emitError('BAD_INPUT', 'refreshId required');
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, rows: [] });
  try {
    const rows = await listSymbolsForSnapshot(p);
    emit({ ok: true, cloud: true, rows, count: rows.length });
  } catch (err) {
    emitError(err.code || 'EXCEPTION', err.message);
  }
}

async function cmdListLayeringViolationsForSnapshot() {
  const refreshId = argOption('refresh-id');
  if (!refreshId) return emitError('BAD_INPUT', '--refresh-id required');
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, rows: [] });
  try {
    const rows = await listLayeringViolationsForSnapshot(refreshId);
    emit({ ok: true, cloud: true, rows });
  } catch (err) {
    emitError(err.code || 'EXCEPTION', err.message);
  }
}

async function cmdComputeDriftScore() {
  const p = parsePayload();
  if (!p.repoId || !p.refreshId) return emitError('BAD_INPUT', 'repoId and refreshId required');
  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, drift: null });
  try {
    const drift = await computeDriftScore(p);
    emit({ ok: true, cloud: true, drift });
  } catch (err) {
    emitError(err.code || 'EXCEPTION', err.message);
  }
}

async function cmdResolveRepoIdentity() {
  const cwd = argOption('cwd') || process.cwd();
  const persist = rest.includes('--persist');
  const id = resolveRepoIdentity(cwd);
  if (persist) persistRepoIdentity(id.repoUuid, cwd);
  emit({ ok: true, ...id, persisted: persist });
}

// ── Phase 1 — adaptive-learning-v1 subcommands ─────────────────────────────

/**
 * Generic decision recorder.  Used by external skills/scripts that don't want
 * to import scripts/lib/learning/decision-logger.mjs directly (e.g. shell
 * pipelines).  Validates input shape, derives decision_key, inserts row.
 */
async function cmdLearningRecord() {
  const p = parsePayload();
  if (!p.decisionType) return emitError('BAD_INPUT', 'decisionType is required');
  if (!p.context || !p.choice) return emitError('BAD_INPUT', 'context and choice are required');

  const auditBound = p.auditRunId && Number.isInteger(p.round) && Number.isInteger(p.sequence);
  if (!auditBound && !p.externalId) {
    return emitError('BAD_INPUT', 'must provide either (auditRunId, round, sequence) OR externalId');
  }

  await initLearningStore();
  if (!await isCloudEnabled()) return emit({ ok: true, cloud: false, decisionKey: null });

  // Build decision_key the same way decision-logger does.
  const decisionKey = auditBound
    ? `${p.auditRunId}:${p.decisionType}:r${p.round}:s${p.sequence}`
    : `${p.decisionType}:${p.externalId}`;

  // Compute context_hash deterministically (same algorithm as decision-logger).
  const crypto = await import('node:crypto');
  const canonical = JSON.stringify(p.context, Object.keys(p.context).sort());
  const contextHash = crypto.createHash('sha256').update(canonical).digest('hex');

  const result = await insertLearningDecision({
    decisionKey,
    auditRunId:  p.auditRunId  ?? null,
    decisionType: p.decisionType,
    round:       p.round       ?? null,
    sequence:    p.sequence    ?? null,
    externalId:  p.externalId  ?? null,
    repoId:      p.repoId      ?? null,
    context:     p.context,
    contextHash,
    choice:      p.choice,
    outcome:     p.outcome     ?? null,
  });

  if (!result.ok) return emitError('STORE_ERROR', result.error || 'insert failed', { decisionKey });
  emit({ ok: true, cloud: true, decisionKey });
}

/**
 * Stats snapshot for human inspection or weekly review.  Currently emits
 * counts of pending_triage_findings + no_brainer_recommendations + stale
 * clusters per repo.  Phase 2 extends with quickfix-pattern stats.
 */
async function cmdLearningStats() {
  const p = parsePayload();
  // Thin wrapper over the shared accessor — argv/env/stdout concerns only.
  // The CLI (not the pure lib) owns the LEARNING_REPO_NAME env fallback.
  const r = await getLearningStats({
    repoId: p.repoId || null,
    repoName: p.repoName || process.env.LEARNING_REPO_NAME || null,
  });
  if (!r.cloud) return emit({ ok: true, cloud: false, stats: null });
  if (!r.stats) return emit({ ok: true, cloud: true, repoId: null, stats: { unknownRepo: true } });
  emit({ ok: true, cloud: true, repoId: r.repoId, repoName: r.repoName, stats: r.stats });
}

/**
 * Weekly review — delegates to scripts/learning/weekly-review.mjs.
 * Provides a stable cross-skill subcommand surface so package.json and
 * the GH workflow can invoke `cross-skill.mjs learning-weekly-review`
 * uniformly.
 */
async function cmdLearningWeeklyReview() {
  const { runWeeklyReview } = await import('./learning/weekly-review.mjs');
  const result = await runWeeklyReview({
    repoName: argOption('repo') || process.env.LEARNING_REPO_NAME || null,
    dryRun: rest.includes('--dry-run'),
    format: argOption('format') || 'json',
  });
  emit(result);
}

/**
 * Backfill quickfix outcomes — Phase 2.  Drains the local hits JSONL into
 * `learning_decisions`, then resolves outcomes for unresolved hits older
 * than 30 minutes by examining current file state.  Optionally rebuilds
 * the `quickfix-pattern-stats.json` cache afterward (--rebuild-stats).
 */
async function cmdLearningBackfillOutcomes() {
  const { runBackfill } = await import('./learning/backfill-outcomes.mjs');
  const result = await runBackfill({
    // `--repo` is accepted as well as `--repo-id`: the two entry points to
    // runBackfill disagreed on the spelling, and `--repo` is globally
    // allowlisted here for other subcommands — so
    // `learning-backfill-outcomes --repo X` passed the flag guard, resolved to
    // null, and ran the backfill UNSCOPED. Silently wrong scope on a mutating
    // command, which is the failure this file's guard is meant to prevent and
    // could not: the flag is known, just read under a different name.
    // Reproduced 2026-07-20 before the fix. The standalone
    // backfill-outcomes.mjs has always mapped `--repo` to repoId, so this makes
    // the two agree rather than inventing a third convention.
    repoId:       argOption('repo-id') || argOption('repo') || null,
    dryRun:       rest.includes('--dry-run'),
    skipDrain:    rest.includes('--skip-drain'),
    skipResolve:  rest.includes('--skip-resolve'),
    rebuildStats: rest.includes('--rebuild-stats'),
  });
  emit(result);
}

/**
 * Friction-log capture — `audit:wtf <message>`.  Quick-write CLI for
 * real-time operator annoyance.  Plan: friction-log-and-digest-v1.md.
 */
async function cmdFrictionLog() {
  const { runFrictionLog } = await import('./friction-log.mjs');
  const result = await runFrictionLog(rest);
  emit(result);
  if (!result.ok) process.exit(1);
}

/**
 * Replay CLI bridge — Phase 3.  Wraps `scripts/learning/replay.mjs` so
 * package.json + workflow scripts can route through cross-skill.mjs
 * uniformly.  Forwards all positional + flag args to the CLI runner.
 */
async function cmdLearningReplay() {
  const { runReplayCli } = await import('./learning/replay.mjs');
  const result = await runReplayCli(rest);
  // runReplayCli already wrote stdout; we just propagate the exit code via emit.
  if (result && result.ok === false) {
    emit({ ok: false, error: result.error || 'replay failed' });
    process.exit(1);
  }
}

/**
 * Quickfix-stats CLI bridge — Phase 2.  Wraps
 * `scripts/lib/learning/quickfix-stats.mjs` so package.json + workflow
 * scripts route through cross-skill.mjs uniformly.
 */
async function cmdLearningQuickfixStats() {
  const mod = await import('./lib/learning/quickfix-stats.mjs');
  const action = argOption('action') || 'stats';
  const repoId = argOption('repo-id') || null;
  if (action === 'rebuild') {
    const bootstrap = rest.includes('--bootstrap');
    const result = bootstrap
      ? await mod.rebuildFromBootstrap()
      : await mod.rebuildFromCloud({ repoId });
    emit({ ok: result.ok, action: 'rebuild', mode: bootstrap ? 'bootstrap' : 'cloud', ...result });
    return;
  }
  // Default: read the cache and emit the stats summary.
  const stats = mod.loadStats();
  const skipMap = {};
  for (const name of Object.keys(stats.patterns || {})) {
    skipMap[name] = mod.shouldSkipPattern(name, stats);
  }
  emit({
    ok: true,
    action: 'stats',
    cacheExists: !!stats._generatedAt,
    generatedAt: stats._generatedAt || null,
    patterns: stats.patterns || {},
    wouldSkip: skipMap,
  });
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

const commands = {
  'upsert-plan': cmdUpsertPlan,
  'update-plan-status': cmdUpdatePlanStatus,
  'record-regression-spec': cmdRecordRegressionSpec,
  'record-regression-spec-run': cmdRecordRegressionSpecRun,
  'list-consistency-candidates': cmdListConsistencyCandidates,
  'promote-regression-spec':     cmdPromoteRegressionSpec,
  // Phase 3 WS-PIPE1 — persona_test_candidates aggregation table.
  'upsert-persona-test-candidate':       cmdUpsertPersonaTestCandidate,
  'list-persona-test-candidates':        cmdListPersonaTestCandidates,
  'mark-persona-test-candidate-proposed': cmdMarkPersonaTestCandidateProposed,
  'record-correlation': cmdRecordCorrelation,
  'record-ship-event': cmdRecordShipEvent,
  'record-nav-audit-run': cmdRecordNavAuditRun,
  'get-nav-first-seen': cmdGetNavFirstSeen,
  'persona-outcomes': cmdPersonaOutcomes,
  'record-plan-verify-run': cmdRecordPlanVerifyRun,
  'record-plan-verify-items': cmdRecordPlanVerifyItems,
  'plan-satisfaction': cmdPlanSatisfaction,
  'list-unlocked-fixes': cmdListUnlockedFixes,
  'list-unremediated-acceptances': cmdListUnremediatedAcceptances,
  'audit-effectiveness': cmdAuditEffectiveness,
  'final-review-stats': cmdFinalReviewStats,
  'final-review-pending': cmdFinalReviewPending,
  'final-review-adjudicate': cmdFinalReviewAdjudicate,
  'final-review-record-fix': cmdFinalReviewRecordFix,
  'finalize-outcomes': cmdFinalizeOutcomes,
  // Model-A/B/C experiment harness (Cluster C)
  'model-ab-adjudicate': cmdModelAbAdjudicate,
  'model-ab-stats': cmdModelAbStats,
  'model-ab-decision': cmdModelAbDecision,
  // Unified arm-evaluation framework (plan-authoring + brainstorm)
  'arm-eval-run': cmdArmEvalRun,
  'arm-eval-decision': cmdArmEvalDecision,
  'arm-eval-stats': cmdArmEvalStats,
  'arm-eval-adjudicate': cmdArmEvalAdjudicate,
  'arm-eval-toggle': cmdArmEvalToggle,
  'arm-eval-maybe-capture': cmdArmEvalMaybeCapture,
  'arm-eval-export': cmdArmEvalExport,
  'detect-stack': cmdDetectStack,
  'list-personas': cmdListPersonas,
  'add-persona': cmdAddPersona,
  'record-persona-session': cmdRecordPersonaSession,
  'get-persona-sessions-by-repo': cmdGetPersonaSessionsByRepo,
  'get-reachability-evidence': cmdGetReachabilityEvidence,
  'recommend-skills': cmdRecommendSkills,
  'preview-gate': cmdPreviewGate,
  'get-persona-sessions-by-url': cmdGetPersonaSessionsByUrl,
  'get-recent-findings': cmdGetRecentFindings,
  'shadow-overlap':     cmdShadowOverlap,
  'lock-with-test':     cmdLockWithTest,
  'whoami': cmdWhoami,
  // Architectural memory
  'resolve-repo-identity':            cmdResolveRepoIdentity,
  'get-active-refresh-id':            cmdGetActiveRefreshId,
  'get-neighbourhood':                cmdGetNeighbourhood,
  'get-incident-neighbourhood':       cmdGetIncidentNeighbourhood,
  'compute-target-domains':           cmdComputeTargetDomains,
  'get-callers-for-file':             cmdGetCallersForFile,
  'open-refresh-run':                 cmdOpenRefreshRun,
  'publish-refresh-run':              cmdPublishRefreshRun,
  'abort-refresh-run':                cmdAbortRefreshRun,
  'record-symbol-definitions':        cmdRecordSymbolDefinitions,
  'record-symbol-index':              cmdRecordSymbolIndex,
  'record-symbol-embedding':          cmdRecordSymbolEmbedding,
  'record-layering-violations':       cmdRecordLayeringViolations,
  'set-active-embedding-model':       cmdSetActiveEmbeddingModel,
  'list-symbols-for-snapshot':        cmdListSymbolsForSnapshot,
  'list-layering-violations-for-snapshot': cmdListLayeringViolationsForSnapshot,
  'compute-drift-score':              cmdComputeDriftScore,
  // Phase 1 — adaptive-learning-v1
  'learning-record':                  cmdLearningRecord,
  'learning-stats':                   cmdLearningStats,
  'learning-weekly-review':           cmdLearningWeeklyReview,
  // Phase 2 — live quickfix learner
  'learning-backfill-outcomes':       cmdLearningBackfillOutcomes,
  'learning-quickfix-stats':          cmdLearningQuickfixStats,
  // Phase 3 — replay framework + remaining telemetry
  'learning-replay':                  cmdLearningReplay,
  // Friction log (plan: friction-log-and-digest-v1.md)
  'friction-log':                     cmdFrictionLog,
  // Friction-feedback loop (plan: friction-feedback-loop.md)
  'quality':                          cmdQuality,
  'get-friction-neighbourhood':       cmdGetFrictionNeighbourhood,
  // Upstream issue reports (plan: upstream-issue-reports.md)
  'upstream':                         cmdUpstream,
};

async function main() {
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'cross-skill.mjs' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(
      'Usage: node scripts/cross-skill.mjs <subcommand> [--json <payload>|--stdin]\n\n' +
      'Subcommands:\n' +
      Object.keys(commands).map(k => `  ${k}`).join('\n') + '\n'
    );
    process.exit(0);
  }
  const handler = commands[subcommand];
  if (!handler) {
    emitError('UNKNOWN_SUBCOMMAND', `Unknown subcommand: ${subcommand}`, {
      validSubcommands: Object.keys(commands),
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
