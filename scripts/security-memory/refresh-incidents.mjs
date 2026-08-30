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
import '../lib/load-env.mjs';
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
  recordSecurityEvents,
} from '../learning-store.mjs';
import { resolveRepoIdentity, persistRepoIdentity } from '../lib/repo-identity.mjs';
import { redactSecrets } from '../lib/secret-patterns.mjs';
import { preWriteSecretGate } from '../lib/security/secret-classifier.mjs';
import { symbolIndexConfig, azureConfig } from '../lib/config.mjs';
import { embedText, resolveEmbedProfile } from '../lib/embed-text.mjs';
import { parseSecurityStrategy } from './parse-strategy.mjs';
import { classifyMitigation, runSemgrepIfNeeded } from './incident-status.mjs';
import { emit } from '../lib/cli-io.mjs';
import { assertRepoRoot } from '../lib/assert-repo-root.mjs';

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

// Current branch name for the audit trail (best-effort; 'unknown' on detached
// HEAD / non-git). Distinct from isOnDefaultBranch() which decides sweep gating.
function currentBranchName(cwd) {
  try {
    const b = gitArgs(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return b || 'unknown';
  } catch { return 'unknown'; }
}

// Who ran the refresh — git config user.name, falling back to the OS user.
function gitWho(cwd) {
  try {
    const name = gitArgs(cwd, ['config', 'user.name']);
    if (name) return name;
  } catch { /* git config unset — fall through */ }
  return process.env.USER || process.env.USERNAME || null;
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

async function generateEmbedding(text, modelId, dim) {
  // Provider routing + empty/dim validation live in embed-text.mjs (Azure
  // OpenAI when the work profile is active, else Gemini). Same VECTOR(768)
  // writer contract as before — embedText throws on empty/dim-mismatch.
  const { result } = await embedText(text, { dim, model: modelId });
  return result;
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertRepoRoot(import.meta.url);
  const repoRoot = path.resolve(process.cwd());
  const strategyAbs = path.join(repoRoot, STRATEGY_PATH);

  // R1-H5: missing markdown → noop exit 0
  if (!fs.existsSync(strategyAbs)) {
    logInfo(`no ${STRATEGY_PATH} — security memory not bootstrapped (run /security-strategy bootstrap)`);
    emit({ ok: true, skipped: 'no-strategy-file' });
    process.exit(0);
  }

  await initLearningStore();
  if (!await isCloudEnabled()) {
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
  // `requestModel` is what we SEND (bare Azure deployment, or the concrete
  // Gemini id); `provenanceId` is the endpoint-qualified identity we PERSIST.
  // They are different strings under Azure and conflating them is the bug this
  // replaced: recording the bare `azureConfig.embedDeployment` made a
  // deployment-name collision across two Azure RESOURCES look like one vector
  // space, and left this index's provenance in a format the arch index — which
  // has used `resolveEmbedProfile()` since it was introduced — cannot match.
  // Found by the final reviewer (2026-08-30) as the third caller that never
  // adopted the unifying helper; `symbol-index/embed.mjs` carries the same pair.
  const embedProfile = resolveEmbedProfile({
    concreteModel: active?.activeEmbeddingModel || symbolIndexConfig.embedModel,
  });
  const requestModel = embedProfile.requestModel;
  const modelToUse = embedProfile.provenanceId;
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

  // Embedding provider is resolved inside embed-text.mjs (Azure work profile
  // or Gemini). Require at least one to be configured before doing work.
  if (!azureConfig.active && !process.env.GEMINI_API_KEY) {
    throw new Error('No embedding provider — set GEMINI_API_KEY or the Azure work profile (AZURE_OPENAI_ENDPOINT).');
  }

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
  const branch = currentBranchName(repoRoot);
  const who = gitWho(repoRoot);

  const semgrepCache = new Map();
  const toUpsert = [];
  const embedFailures = [];
  // Audit-trail events (security_strategy_events) collected this run; written
  // once after the upsert + sweep. Back-port: docs/plans/security/PLAN.md §4.2.
  const auditEvents = [];
  const refused = [];

  for (const inc of parsed) {
    const prior = existingByIncidentId.get(inc.incident_id);

    // ── Secret pre-write gate (back-port: docs/plans/security/PLAN.md §4.4) ──
    // REFUSE on high-confidence secret shapes (the incident is NOT indexed —
    // forcing the operator to fix the markdown). REDACT low-confidence PII into
    // the STORED value (description + lessons), not just the embedding text, so
    // a leaked email never lands in the DB. Run per stored field.
    const gd = preWriteSecretGate(inc.description || '');
    const gl = preWriteSecretGate(inc.lessons_learned || '');
    if (!gd.ok || !gl.ok) {
      const refusedEvents = [...(gd.ok ? [] : gd.events), ...(gl.ok ? [] : gl.events)];
      for (const ev of refusedEvents) {
        auditEvents.push({
          incident_id: inc.incident_id, event_kind: 'refused_secret',
          branch, commit_sha: headSha, who, detail: ev.detail,
        });
      }
      const detail = gd.ok ? gl.detail : gd.detail;
      refused.push({ incident_id: inc.incident_id, detail });
      logWarn(`REFUSED ${inc.incident_id}: ${detail}`);
      continue;
    }
    // Apply redactions to the stored values + log the redaction events.
    inc.description = gd.content;
    inc.lessons_learned = gl.content;
    for (const ev of [...gd.events, ...gl.events]) {
      auditEvents.push({
        incident_id: inc.incident_id, event_kind: 'redacted_secret',
        branch, commit_sha: headSha, who, detail: ev.detail,
      });
    }
    const wasRedacted = gd.kind === 'redacted' || gl.kind === 'redacted';

    const fingerprintChanged = !prior || prior.source_fingerprint !== inc.source_fingerprint;
    const modelChanged = !prior || prior.embedding_model !== modelToUse || prior.embedding_dim !== dimToUse;
    const needsEmbed = fingerprintChanged || modelChanged;

    let embedding = null;
    let embedError = null;
    if (needsEmbed) {
      try {
        const text = redactSecrets(`${inc.description} ${inc.lessons_learned || ''}`).text;
        // requestModel, NOT modelToUse: the latter is the endpoint-qualified
        // provenance we persist, and sending it as a Gemini model id would 404.
        embedding = await generateEmbedding(text, requestModel, dimToUse);
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

    // Audit trail: record meaningful changes only — a new row → 'inserted',
    // a fingerprint change → 'updated'. An idempotent re-upsert (same
    // fingerprint) emits nothing, keeping the trail signal-rich.
    if (!prior) {
      auditEvents.push({
        incident_id: inc.incident_id, event_kind: 'inserted',
        branch, commit_sha: headSha, who, detail: { status, redacted: wasRedacted },
      });
    } else if (fingerprintChanged) {
      auditEvents.push({
        incident_id: inc.incident_id, event_kind: 'updated',
        branch, commit_sha: headSha, who, detail: { status, redacted: wasRedacted },
      });
    }
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
      for (const rid of removedIds) {
        auditEvents.push({
          incident_id: rid, event_kind: 'marked_historical',
          branch, commit_sha: headSha, who, detail: { reason: 'absent-from-default-markdown' },
        });
      }
      logInfo(`sweep: marked ${swept} removed-from-markdown as historical: ${removedIds.join(', ')}`);
    }
  }

  // Audit-trail write (best-effort, non-fatal). Deviation from the kit's
  // single withTx: events land after the upsert+sweep succeed rather than in
  // the same transaction. A trail-write failure logs but does not fail the run
  // — the incident index is the source of truth; the trail is supplementary.
  if (auditEvents.length > 0) {
    try {
      const { recorded } = await recordSecurityEvents(repoId, auditEvents);
      logInfo(`recorded ${recorded} audit-trail event(s)`);
    } catch (err) {
      logWarn(`audit-trail write failed (non-fatal): ${err.message}`);
    }
  }

  if (refused.length > 0) {
    logWarn(`${refused.length} incident(s) REFUSED (high-confidence secret) — NOT indexed. Fix docs/security-strategy.md:`);
    for (const r of refused) logWarn(`  - ${r.incident_id}: ${r.detail}`);
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
    refused: refused.length,
    redacted: auditEvents.filter(e => e.event_kind === 'redacted_secret').length,
    embedFailures: embedFailures.length,
    swept,
    sweepBlockedBy,
    onDefaultBranch: onDefault,
  });
  // Non-zero exit so CI catches a half-built index: embed failures (R2-H6) OR
  // a refused secret (a real incident kept OUT of the index — must not pass
  // silently; back-port hardening of the original exit contract).
  process.exit((embedFailures.length > 0 || refused.length > 0) ? 2 : 0);
}

main().catch(err => {
  process.stderr.write(`security-refresh: fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
