#!/usr/bin/env node
/**
 * @fileoverview Refresh the security_incidents Supabase index from
 * docs/security-strategy.md. Plan: docs/plans/security-memory-v1.md §4.C.
 *
 * Steps:
 *   1. Read + parse markdown (pure parser).
 *   2. Diff against existing DB rows by source_fingerprint.
 *   3. For new/changed: redact + Gemini-embed, run semgrep status check.
 *   4. UPSERT into security_incidents.
 *   5. (default branch only — R-Gemini-r2-G2) Sweep removed-from-md as historical.
 *
 * Behaviour matrix (R1-H3, R1-H5):
 *   - markdown missing → log + exit 0, no DB writes
 *   - cloud disabled  → log + exit 0
 *   - feature branch  → UPSERT only, NO sweep (avoid thrashing)
 *   - default branch  → UPSERT + sweep
 *
 * @module scripts/security-memory/refresh-incidents
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  initLearningStore,
  isCloudEnabled,
  getRepoIdByUuid,
  upsertRepoByUuid,
  getActiveSnapshot,
  recordSecurityIncidents,
  getSecurityIncidentsByRepo,
  markIncidentsHistorical,
} from '../learning-store.mjs';
import { resolveRepoIdentity, persistRepoIdentity } from '../lib/repo-identity.mjs';
import { redactSecrets } from '../lib/secret-patterns.mjs';
import { symbolIndexConfig } from '../lib/config.mjs';
import { parseSecurityStrategy } from './parse-strategy.mjs';
import { classifyMitigation, runSemgrepIfNeeded } from './incident-status.mjs';
import { emit } from '../lib/cli-io.mjs';

const STRATEGY_PATH = 'docs/security-strategy.md';

function logInfo(msg) { process.stderr.write(`  [security-refresh] ${msg}\n`); }
function logWarn(msg) { process.stderr.write(`  [security-refresh] WARN ${msg}\n`); }

// All git invocations use execFileSync + argv array (R3-M2): never
// shell-interpolate values that originate from git output (ref names,
// symbolic-ref output) — those are not guaranteed shell-safe.
function gitArgs(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

function gitHeadSha(cwd) {
  try { return gitArgs(cwd, ['rev-parse', 'HEAD']); }
  catch { return 'unknown'; }
}

function isOnDefaultBranch(cwd) {
  // R-Gemini-r2-G2 + R3-H2 + R3-M4: identify "on default branch" by
  // BRANCH NAME first (the common case), and only fall back to a SHA
  // comparison when HEAD is detached (CI checkouts). SHA-equality alone
  // would wrongly return true for a fresh feature branch whose tip
  // happens to equal main's tip (just-branched-off, no commits yet).
  let defaultBranch = null;
  try {
    const ref = gitArgs(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    defaultBranch = ref.replace(/^origin\//, '');
  } catch { /* fall through to fallback */ }
  if (!defaultBranch) {
    for (const candidate of ['main', 'master']) {
      try {
        gitArgs(cwd, ['show-ref', '--verify', `refs/heads/${candidate}`]);
        defaultBranch = candidate;
        break;
      } catch { /* try next */ }
    }
    if (!defaultBranch) defaultBranch = 'main';
  }

  // Branch-name path
  let currentBranch = null;
  try { currentBranch = gitArgs(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']); }
  catch { return false; }
  if (currentBranch && currentBranch !== 'HEAD') {
    return currentBranch === defaultBranch;
  }

  // Detached-HEAD path: only here do we trust SHA equality, and only
  // against refs/remotes/origin/<defaultBranch> (the canonical published
  // tip). Local refs/heads/<defaultBranch> can drift; the remote ref is
  // the unambiguous "default branch tip" that CI checked out.
  let headSha;
  try { headSha = gitArgs(cwd, ['rev-parse', 'HEAD']); }
  catch { return false; }
  try {
    const remoteSha = gitArgs(cwd, ['rev-parse', `refs/remotes/origin/${defaultBranch}`]);
    return remoteSha === headSha;
  } catch { return false; }
}

// R2-H5: v1 storage is fixed at VECTOR(768). Any dim != 768 must error
// out at the writer rather than silently fail at INSERT time.
const SECURITY_EMBED_DIM_V1 = 768;

async function generateEmbedding(ai, text, modelId, dim) {
  const resp = await ai.models.embedContent({
    model: modelId,
    contents: text,
    config: { outputDimensionality: dim },
  });
  const vec = resp.embeddings?.[0]?.values || resp.embedding?.values || null;
  // R2-H4: validate writer contract — non-empty array, exact dim match.
  // RPC filters embedding IS NOT NULL, so a silently-null persist (R2-H6)
  // would make the row invisible to retrieval.
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error(`embedding API returned empty/invalid vector (model=${modelId})`);
  }
  if (vec.length !== dim) {
    throw new Error(`embedding dim mismatch: got ${vec.length}, expected ${dim} (model=${modelId})`);
  }
  return vec;
}

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const strategyAbs = path.join(repoRoot, STRATEGY_PATH);

  // R1-H5: missing markdown → noop exit 0
  if (!fs.existsSync(strategyAbs)) {
    logInfo(`no ${STRATEGY_PATH} — security memory not bootstrapped (run /security-strategy bootstrap)`);
    emit({ ok: true, skipped: 'no-strategy-file' });
    process.exit(0);
  }

  await initLearningStore();
  if (!isCloudEnabled()) {
    logInfo('cloud disabled — skipping');
    emit({ ok: true, cloud: false, skipped: 'cloud-disabled' });
    process.exit(0);
  }

  const identity = resolveRepoIdentity(repoRoot);
  persistRepoIdentity(identity.repoUuid, repoRoot);
  const repoRow = await upsertRepoByUuid({
    repoUuid: identity.repoUuid,
    name: identity.name,
    remoteUrl: identity.remoteUrl,
  });
  const repoId = repoRow.id;

  // R2-L3: single source of truth — symbolIndexConfig provides the
  // resolved-and-validated model+dim. Active snapshot wins (per-repo
  // override) but the fallback is the same value the QUERY path uses,
  // so writer and reader can never silently drift.
  const active = await getActiveSnapshot(repoId);
  const modelToUse = active?.activeEmbeddingModel || symbolIndexConfig.embedModel;
  const dimToUse = active?.activeEmbeddingDim || symbolIndexConfig.embedDim;

  // R2-H5: v1 storage hard-coded to VECTOR(768). Hard-fail before any
  // network call rather than silently fail at INSERT.
  if (dimToUse !== SECURITY_EMBED_DIM_V1) {
    throw new Error(
      `security-incidents storage requires embedding_dim=${SECURITY_EMBED_DIM_V1} ` +
      `(got ${dimToUse} from active snapshot or env). ` +
      `v2 will lift this restriction; for now align ARCH_INDEX_EMBED_DIM and the active snapshot to 768.`
    );
  }

  // R2-M8/M9: instantiate Gemini client ONCE at process startup, not per-row.
  const { GoogleGenAI } = await import('@google/genai');
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  // Parse markdown
  const markdownText = fs.readFileSync(strategyAbs, 'utf-8');
  const { incidents: parsed, threatModel, warnings } = parseSecurityStrategy(markdownText);
  for (const w of warnings) {
    logWarn(`${w.kind} at line ${w.line}: ${w.snippet}`);
  }
  logInfo(`parsed ${parsed.length} incidents${threatModel ? ' + threat model' : ''}`);

  // Diff against existing DB rows by source_fingerprint
  const existing = await getSecurityIncidentsByRepo(repoId);
  const existingByIncidentId = new Map(existing.map(r => [r.incident_id, r]));
  const onDefault = isOnDefaultBranch(repoRoot);
  const headSha = gitHeadSha(repoRoot);

  const semgrepCache = new Map();
  const toUpsert = [];
  const embedFailures = [];

  for (const inc of parsed) {
    const prior = existingByIncidentId.get(inc.incident_id);
    const fingerprintChanged = !prior || prior.source_fingerprint !== inc.source_fingerprint;
    const modelChanged = !prior || prior.embedding_model !== modelToUse || prior.embedding_dim !== dimToUse;
    const needsEmbed = fingerprintChanged || modelChanged;

    let embedding = null;
    let embedError = null;
    if (needsEmbed) {
      try {
        const text = redactSecrets(`${inc.description} ${inc.lessons_learned || ''}`).text;
        embedding = await generateEmbedding(aiClient, text, modelToUse, dimToUse);
      } catch (err) {
        embedError = err.message;
        logWarn(`embed failed for ${inc.incident_id}: ${err.message}`);
      }
    }

    // R2-H6: incident_neighbourhood RPC filters on embedding IS NOT NULL,
    // so a row persisted with null embedding silently disappears from
    // retrieval. Skip the row + collect for end-of-run failure reporting.
    const finalEmbedding = embedding || prior?.embedding || null;
    if (!finalEmbedding) {
      embedFailures.push({ incident_id: inc.incident_id, reason: embedError || 'no embedding produced and no prior row' });
      continue;
    }

    // Status resolution
    const semgrepResult = runSemgrepIfNeeded({
      repoRoot,
      mitigationRef: inc.mitigation_ref,
      mitigationKind: inc.mitigation_kind,
      fingerprintCache: semgrepCache,
      repoHeadSha: headSha,
    });
    const { status } = classifyMitigation({
      mitigation_kind: inc.mitigation_kind,
      semgrepRunResult: semgrepResult,
    });

    toUpsert.push({
      incident_id: inc.incident_id,
      description: inc.description,
      affected_paths: inc.affected_paths,
      mitigation_ref: inc.mitigation_ref,
      mitigation_kind: inc.mitigation_kind,
      lessons_learned: inc.lessons_learned,
      embedding: finalEmbedding,
      embedding_model: embedding ? modelToUse : (prior?.embedding_model || null),
      embedding_dim: embedding ? dimToUse : (prior?.embedding_dim || null),
      source_fingerprint: inc.source_fingerprint,
      status,
      status_check_at: new Date().toISOString(),
    });
  }

  if (toUpsert.length > 0) {
    await recordSecurityIncidents(repoId, toUpsert);
    logInfo(`upserted ${toUpsert.length} incidents`);
  }

  // R2-H7: a parser warning on missing-id or missing-description means the
  // parsed set is NOT an authoritative incident inventory — the source
  // markdown has malformed blocks that may correspond to active incidents.
  // Sweeping under those conditions can falsely archive a real incident.
  // Block sweep until the markdown is clean.
  const PARSE_BLOCKING_WARNINGS = new Set(['missing-id', 'missing-description', 'duplicate-id']);
  const blockingWarnings = warnings.filter(w => PARSE_BLOCKING_WARNINGS.has(w.kind));

  // R-Gemini-r2-G2: sweep ONLY on default branch AND only on a clean parse
  let swept = 0;
  let sweepBlockedBy = null;
  if (!onDefault) {
    logInfo('feature branch — sweep skipped (default-branch-only)');
    sweepBlockedBy = 'feature-branch';
  } else if (blockingWarnings.length > 0) {
    logWarn(`sweep blocked: ${blockingWarnings.length} parser warning(s) of types ${[...new Set(blockingWarnings.map(w => w.kind))].join(', ')} — fix docs/security-strategy.md before sweep can run`);
    sweepBlockedBy = 'parser-warnings';
  } else {
    const parsedIds = new Set(parsed.map(i => i.incident_id));
    const removedIds = existing
      .filter(r => !parsedIds.has(r.incident_id) && r.status !== 'historical')
      .map(r => r.incident_id);
    if (removedIds.length > 0) {
      await markIncidentsHistorical(repoId, removedIds);
      swept = removedIds.length;
      logInfo(`sweep: marked ${swept} removed-from-markdown as historical: ${removedIds.join(', ')}`);
    }
  }

  if (embedFailures.length > 0) {
    logWarn(`${embedFailures.length} incident(s) NOT persisted due to embed failures:`);
    for (const f of embedFailures) logWarn(`  - ${f.incident_id}: ${f.reason}`);
  }

  emit({
    ok: true,
    cloud: true,
    repoId,
    parsed: parsed.length,
    upserted: toUpsert.length,
    embedFailures: embedFailures.length,
    swept,
    sweepBlockedBy,
    onDefaultBranch: onDefault,
  });
  // R2-H6: if any incident failed to embed AND we have parser warnings,
  // surface a non-zero exit so CI catches half-built indexes.
  process.exit(embedFailures.length > 0 ? 2 : 0);
}

main().catch(err => {
  process.stderr.write(`security-refresh: fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
