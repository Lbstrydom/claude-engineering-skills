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
import { execSync } from 'node:child_process';

import {
  initLearningStore,
  isCloudEnabled,
  upsertPlan,
  updatePlanStatus,
  recordRegressionSpec,
  recordRegressionSpecRun,
  recordPersonaAuditCorrelation,
  recordShipEvent,
  recordPlanVerificationRun,
  recordPlanVerificationItems,
  readPlanSatisfaction,
  readPersistentPlanFailures,
  getUnlockedFixes,
  readAuditEffectiveness,
  listPersonasForApp,
  upsertPersona,
  recordPersonaSession,
  getPersonaSessionsByRepo,
  getPersonaSessionsByUrl,
  isPersonaCloudEnabled,
  // Architectural memory (Phase A)
  upsertRepoByUuid,
  getRepoIdByUuid,
  openRefreshRun,
  publishRefreshRun,
  abortRefreshRun,
  getActiveSnapshot,
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
  readPendingTriageFindings,
  readNoBrainerRecommendations,
  readStaleClusters,
  getRepoIdByName,
} from './learning-store.mjs';
import { resolveRepoIdentity, persistRepoIdentity } from './lib/repo-identity.mjs';
import { getNeighbourhoodForIntent } from './lib/neighbourhood-query.mjs';
import { detectRepoStack, detectPythonEnvironmentManager } from './lib/repo-stack.mjs';
import { StackProfileSchema } from './lib/schemas.mjs';
import { z } from 'zod';

// ── Arg parsing ─────────────────────────────────────────────────────────────

const [subcommand, ...rest] = process.argv.slice(2);

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

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

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
 * Best-effort repo lookup — we already have a fingerprint-based upsert in
 * learning-store, but the skills don't always have a profile built. For now,
 * caller passes repoId explicitly OR we skip (cross-skill tables all allow
 * repo_id NULL). The more robust path is to let the audit-loop orchestrator
 * be the sole producer of audit_repos rows, and have the skills reference
 * by name via a side query.
 */
async function resolveRepoId(payload) {
  if (payload.repoId) return payload.repoId;
  // Leave null — the schema accepts it. When audit-loop has run, it will have
  // produced an audit_repos row whose id the skills can query by name, but for
  // MVP we rely on explicit passing from /audit-loop and let the others use null.
  return null;
}

// ── Subcommands ─────────────────────────────────────────────────────────────

async function cmdUpsertPlan() {
  const p = parsePayload();
  if (!p.path || !p.skill) return emitError('BAD_INPUT', 'path and skill are required');
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, planId: null });
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
  emit({ ok: !!planId, cloud: true, planId });
}

async function cmdUpdatePlanStatus() {
  const p = parsePayload();
  if (!p.planId || !p.status) return emitError('BAD_INPUT', 'planId and status are required');
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false });
  await updatePlanStatus(p.planId, p.status);
  emit({ ok: true, cloud: true });
}

async function cmdRecordRegressionSpec() {
  const p = parsePayload();
  if (!p.specPath || !p.description || !p.sourceKind) {
    return emitError('BAD_INPUT', 'specPath, description, sourceKind are required');
  }
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, specId: null });
  const repoId = await resolveRepoId(p);
  const specId = await recordRegressionSpec(repoId, {
    specPath: p.specPath,
    description: p.description,
    commitSha: p.commitSha || currentCommitSha(),
    assertionCount: p.assertionCount,
    domContractTypes: p.domContractTypes,
    sourceKind: p.sourceKind,
    sourceFindingId: p.sourceFindingId,
    sourceFindingType: p.sourceFindingType,
  });
  emit({ ok: !!specId, cloud: true, specId });
}

async function cmdRecordRegressionSpecRun() {
  const p = parsePayload();
  if (!p.specId || typeof p.passed !== 'boolean') {
    return emitError('BAD_INPUT', 'specId and passed (bool) are required');
  }
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false });
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
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false });
  await recordPersonaAuditCorrelation(p.personaSessionId, {
    personaFindingHash: p.personaFindingHash,
    personaSeverity: p.personaSeverity,
    auditFindingId: p.auditFindingId,
    auditRunId: p.auditRunId,
    correlationType: p.correlationType,
    matchScore: p.matchScore,
    matchRationale: p.matchRationale,
  });
  emit({ ok: true, cloud: true });
}

async function cmdRecordPlanVerifyRun() {
  const p = parsePayload();
  if (!p.planId || typeof p.totalCriteria !== 'number') {
    return emitError('BAD_INPUT', 'planId and totalCriteria (number) are required');
  }
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, runId: null });
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
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, inserted: 0 });
  await recordPlanVerificationItems(p.runId, p.planId, p.items);
  emit({ ok: true, cloud: true, inserted: p.items.length });
}

async function cmdPlanSatisfaction() {
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, row: null, persistentFailures: [] });
  const planId = argOption('plan-id');
  if (!planId) return emitError('BAD_INPUT', '--plan-id is required');
  const [row, persistent] = await Promise.all([
    readPlanSatisfaction(planId),
    readPersistentPlanFailures(planId),
  ]);
  emit({ ok: true, cloud: true, row, persistentFailures: persistent });
}

async function cmdRecordShipEvent() {
  const p = parsePayload();
  if (!p.outcome) return emitError('BAD_INPUT', 'outcome is required');
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false });
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

async function cmdListUnlockedFixes() {
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, rows: [] });
  const repoId = argOption('repo-id');
  const rows = await getUnlockedFixes(repoId);
  emit({ ok: true, cloud: true, rows });
}

async function cmdAuditEffectiveness() {
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, row: null });
  const repoId = argOption('repo-id');
  if (!repoId) return emitError('BAD_INPUT', '--repo-id is required');
  const row = await readAuditEffectiveness(repoId);
  emit({ ok: true, cloud: true, row });
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
  sessionId: z.string().min(1),
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
  personaId: z.string().optional(),
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

  const result = await recordPersonaSession(parsed.data);
  emit({ ok: !!result.sessionId, cloud: true, ...result });
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
  const { stack, pythonFramework, detectedFrom } = detectRepoStack(cwd);
  const profile = {
    ok: true,
    stack,
    pythonFramework,
    environmentManager: includeEnvManager ? detectPythonEnvironmentManager(cwd) : null,
    detectedFrom,
  };
  const parsed = StackProfileSchema.safeParse(profile);
  if (!parsed.success) {
    return emitError('SCHEMA_VIOLATION', 'detect-stack produced invalid profile', { issues: parsed.error.issues });
  }
  emit(parsed.data);
}

async function cmdWhoami() {
  await initLearningStore();
  emit({
    ok: true,
    cloud: isCloudEnabled(),
    commitSha: currentCommitSha(),
    branch: currentBranch(),
    supabaseConfigured: !!process.env.SUPABASE_AUDIT_URL,
    serviceRoleConfigured: !!process.env.SUPABASE_AUDIT_SERVICE_ROLE_KEY,
  });
}

// ── Architectural Memory subcommands (Phase A) ──────────────────────────────

async function cmdGetActiveRefreshId() {
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, refreshId: null });
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
  if (!isCloudEnabled()) {
    return emit({
      ok: true, cloud: false, records: [], totalCandidatesConsidered: 0,
      freshnessWarning: null,
      hint: 'cloud disabled — security memory unavailable',
    });
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
  if (!isCloudEnabled()) {
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

async function cmdGetNeighbourhood() {
  const p = parsePayload();
  await initLearningStore();
  if (!isCloudEnabled()) {
    return emit({
      ok: true, cloud: false, refreshId: null, records: [], totalCandidatesConsidered: 0,
      truncated: false, hint: 'cloud disabled — run `npm run arch:refresh` to enable',
    });
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
  if (!p.refreshId) return emitError('BAD_INPUT', 'refreshId required');
  await initLearningStore();
  try {
    await abortRefreshRun({ refreshId: p.refreshId, reason: p.reason });
    emit({ ok: true, cloud: true });
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
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, rows: [] });
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
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, rows: [] });
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
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, drift: null });
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
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, decisionKey: null });

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
  const repoName = p.repoName || process.env.LEARNING_REPO_NAME || null;
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, stats: null });

  let repoId = p.repoId || null;
  if (!repoId && repoName) repoId = await getRepoIdByName(repoName);
  if (!repoId) return emit({ ok: true, cloud: true, repoId: null, stats: { unknownRepo: true } });

  const [triage, noBrainer, stale] = await Promise.all([
    readPendingTriageFindings({ repoId, limit: 1000 }),
    readNoBrainerRecommendations({ repoId, limit: 1000 }),
    readStaleClusters({ repoId, limit: 1000 }),
  ]);

  emit({
    ok: true,
    cloud: true,
    repoId,
    repoName: repoName || null,
    stats: {
      pendingTriageCount: triage.length,
      noBrainerCount: noBrainer.length,
      staleClusterCount: stale.length,
    },
  });
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
    repoId:       argOption('repo-id') || null,
    dryRun:       rest.includes('--dry-run'),
    skipDrain:    rest.includes('--skip-drain'),
    skipResolve:  rest.includes('--skip-resolve'),
    rebuildStats: rest.includes('--rebuild-stats'),
  });
  emit(result);
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
  'record-correlation': cmdRecordCorrelation,
  'record-ship-event': cmdRecordShipEvent,
  'record-plan-verify-run': cmdRecordPlanVerifyRun,
  'record-plan-verify-items': cmdRecordPlanVerifyItems,
  'plan-satisfaction': cmdPlanSatisfaction,
  'list-unlocked-fixes': cmdListUnlockedFixes,
  'audit-effectiveness': cmdAuditEffectiveness,
  'detect-stack': cmdDetectStack,
  'list-personas': cmdListPersonas,
  'add-persona': cmdAddPersona,
  'record-persona-session': cmdRecordPersonaSession,
  'get-persona-sessions-by-repo': cmdGetPersonaSessionsByRepo,
  'get-persona-sessions-by-url': cmdGetPersonaSessionsByUrl,
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
};

async function main() {
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
