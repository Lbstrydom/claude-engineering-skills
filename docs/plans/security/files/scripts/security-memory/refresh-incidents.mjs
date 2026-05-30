#!/usr/bin/env node
/**
 * @fileoverview Refresh the `security_incidents` Postgres index from
 * docs/security-strategy.md. Plan: docs/plans/security-strategy-postgres-port.md
 * §4.3 / §4.5 / §6 Phase 3.
 *
 * Pipeline:
 *   1. Read + parse the markdown (pure parser).
 *   2. Pre-write secret gate per incident (refuse high-confidence, redact PII).
 *   3. Diff against existing rows by source_fingerprint.
 *   4. For changed rows: Azure-embed (when pgvector available) + semgrep status.
 *   5. UPSERT incidents + audit-trail events atomically (withTx).
 *   6. Sweep removed-from-markdown → historical (ONLY on main, clean parse).
 *
 * Behaviour matrix:
 *   - markdown missing → exit 0, no DB writes
 *   - cloud disabled   → exit 0
 *   - feature branch   → UPSERT only, NO sweep
 *   - main/master      → UPSERT + sweep (when parse is clean)
 *
 * Exit codes:
 *   0 = success
 *   1 = fatal (Postgres write failure, missing commit_sha, bad classification)
 *   2 = pgvector available AND ≥1 incident failed to embed (half-built index)
 *
 * @module scripts/security-memory/refresh-incidents
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { getPool } from '../lib/db/client.mjs';
import { withTx } from '../lib/db/query.mjs';
import { isCloudEnabled } from '../lib/store/repo.mjs';
import {
  resolveSecurityRepoId,
  getSecurityIncidentsByRepo,
  recordSecurityIncidents,
  markIncidentsHistorical,
  recordStrategyEvents,
} from '../lib/store/security.mjs';
import { parseSecurityStrategy } from './parse-strategy.mjs';
import { classifyMitigation, runSemgrepIfNeeded } from './incident-status.mjs';
import { preWriteSecretGate } from '../lib/security/secret-classifier.mjs';
import { pgvectorAvailable, securityEmbeddingColumnExists } from '../lib/security/pgvector-check.mjs';
import { azureEmbed, embedDeployment, SECURITY_EMBED_DIM } from '../lib/security/azure-embed.mjs';
import { securityRepoName } from '../lib/security/repo-name.mjs';

const STRATEGY_PATH = 'docs/security-strategy.md';
const VALID_CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
const EMBEDDING_MODEL_TAG = `azure-openai/${embedDeployment()}-${SECURITY_EMBED_DIM}`;

function logInfo(msg) { process.stderr.write(`  [security-refresh] ${msg}\n`); }
function logWarn(msg) { process.stderr.write(`  [security-refresh] WARN ${msg}\n`); }
function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    }
  }
  return flags;
}

function git(args, fallback = null) {
  try {
    return execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
}

function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], null);
}

function currentCommitSha() {
  return git(['log', '-1', '--format=%H'], null);
}

function gitUser() {
  return process.env.GIT_AUTHOR_NAME || git(['config', 'user.name'], null) || process.env.USER || process.env.USERNAME || null;
}


async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const repoRoot = path.resolve(process.cwd());
  // path.resolve honours an absolute --strategy and resolves a relative one
  // against repoRoot (path.join would mis-concatenate an absolute path).
  const strategyAbs = path.resolve(repoRoot, flags.strategy || STRATEGY_PATH);

  if (!fs.existsSync(strategyAbs)) {
    logInfo(`no ${STRATEGY_PATH} — security memory not bootstrapped (run /security-strategy bootstrap)`);
    emit({ ok: true, skipped: 'no-strategy-file' });
    return 0;
  }

  if (!await isCloudEnabled()) {
    logInfo('cloud disabled (AUDIT_DB_URL unset) — skipping');
    emit({ ok: true, cloud: false, skipped: 'cloud-disabled' });
    return 0;
  }

  const pool = await getPool();
  const hasVector = await pgvectorAvailable(pool);
  const embeddingsOn = hasVector && await securityEmbeddingColumnExists(pool);
  if (hasVector && !embeddingsOn) {
    logWarn('pgvector installed but security_incidents.embedding column absent — re-run db:setup-postgres. Proceeding path-only.');
  } else if (!hasVector) {
    logInfo('pgvector not installed — embeddings skipped; retrieval falls back to path overlap.');
  }

  // Run-level classification / compliance defaults (validated up front).
  const runClassification = (flags.classification || 'INTERNAL').toUpperCase();
  if (!VALID_CLASSIFICATIONS.includes(runClassification)) {
    throw new Error(`--classification must be one of ${VALID_CLASSIFICATIONS.join(', ')} (got: ${runClassification})`);
  }
  const runComplianceTags = typeof flags['compliance-tags'] === 'string'
    ? flags['compliance-tags'].split(',').map(t => t.trim()).filter(Boolean)
    : ['wartsila-security'];

  const branch = currentBranch() || 'unknown';
  const headSha = currentCommitSha();
  const fallbackCommit = flags.commit || headSha || null;
  const who = gitUser();
  const onMain = branch === 'main' || branch === 'master';

  const repoId = await resolveSecurityRepoId(securityRepoName(repoRoot));

  // Parse markdown.
  const markdownText = fs.readFileSync(strategyAbs, 'utf-8');
  const { incidents: parsed, threatModel, warnings } = parseSecurityStrategy(markdownText);
  for (const w of warnings) logWarn(`${w.kind} at line ${w.line}: ${w.snippet}`);
  logInfo(`parsed ${parsed.length} incident(s)${threatModel ? ' + threat model' : ''}`);

  const existing = await getSecurityIncidentsByRepo(repoId);
  const existingById = new Map(existing.map(r => [r.incident_id, r]));

  const semgrepCache = new Map();
  const batchWithEmbed = [];   // includeEmbedding: true
  const batchNoEmbed = [];     // includeEmbedding: false
  const events = [];
  const failedEmbeds = [];
  const refused = [];

  for (const inc of parsed) {
    // ── Pre-write secret gate (description + lessons individually) ──
    const descGate = preWriteSecretGate(inc.description);
    const lessGate = preWriteSecretGate(inc.lessons_learned || '');
    const gateEvents = [...descGate.events, ...lessGate.events];

    if (!descGate.ok || !lessGate.ok) {
      const detail = [descGate.ok ? null : descGate.detail, lessGate.ok ? null : lessGate.detail]
        .filter(Boolean).join(' | ');
      logWarn(`REFUSED ${inc.incident_id}: ${detail}`);
      for (const e of gateEvents) {
        events.push({ incident_id: inc.incident_id, event_kind: e.event_kind, branch, commit_sha: fallbackCommit, who, detail: e.detail });
      }
      refused.push({ incident_id: inc.incident_id, detail });
      continue;
    }

    const description = descGate.content;
    const lessons = inc.lessons_learned ? lessGate.content : null;
    for (const e of gateEvents) {
      events.push({ incident_id: inc.incident_id, event_kind: e.event_kind, branch, commit_sha: fallbackCommit, who, detail: e.detail });
    }

    // ── commit_sha (NOT NULL): per-incident → --commit → HEAD ──
    const commitSha = inc.commit_sha || fallbackCommit;
    if (!commitSha) {
      throw new Error(`commit_sha required for ${inc.incident_id}: run inside a git repo or pass --commit <sha>, or add a **Commit** field`);
    }
    if (!inc.commit_sha && !flags.commit && headSha) {
      logWarn(`${inc.incident_id}: no **Commit** field — provenance falls back to HEAD (${headSha.slice(0, 8)}), which may be unrelated to this incident.`);
    }

    // ── per-incident classification / compliance (markdown wins, else run default) ──
    const classification = (inc.classification || runClassification).toUpperCase();
    if (!VALID_CLASSIFICATIONS.includes(classification)) {
      throw new Error(`${inc.incident_id}: invalid Classification "${classification}" — must be one of ${VALID_CLASSIFICATIONS.join(', ')}`);
    }
    const complianceTags = (inc.compliance_tags && inc.compliance_tags.length) ? inc.compliance_tags : runComplianceTags;

    // ── change detection ──
    const prior = existingById.get(inc.incident_id);
    const fingerprintChanged = !prior || prior.source_fingerprint !== inc.source_fingerprint;
    const modelChanged = embeddingsOn && (!prior || prior.embedding_model !== EMBEDDING_MODEL_TAG || !prior.embedding_dim);
    // Resurrect a previously-swept incident the moment it reappears in the
    // markdown, even when its text (fingerprint) is unchanged — otherwise it
    // would stay 'historical' forever.
    const priorHistorical = prior && prior.status === 'historical';
    const needFreshEmbed = embeddingsOn && (fingerprintChanged || modelChanged);
    const shouldUpsert = !prior || fingerprintChanged || modelChanged || priorHistorical;
    if (!shouldUpsert) continue;

    // ── status resolution ──
    const semgrepResult = runSemgrepIfNeeded({
      repoRoot,
      mitigationRef: inc.mitigation_ref,
      mitigationKind: inc.mitigation_kind,
      fingerprintCache: semgrepCache,
      repoHeadSha: headSha || 'unknown',
    });
    const { status } = classifyMitigation({ mitigation_kind: inc.mitigation_kind, semgrepRunResult: semgrepResult });

    const base = {
      incident_id: inc.incident_id,
      description,
      affected_paths: inc.affected_paths,
      mitigation_ref: inc.mitigation_ref,
      mitigation_kind: inc.mitigation_kind,
      lessons_learned: lessons,
      commit_sha: commitSha,
      classification,
      compliance_tags: complianceTags,
      source_fingerprint: inc.source_fingerprint,
      status,
      status_check_at: new Date().toISOString(),
    };

    if (needFreshEmbed) {
      // Text or model changed (or brand-new) → compute a fresh vector.
      let embedding = null;
      try {
        const text = `${description}\n${lessons || ''}`.trim();
        embedding = await azureEmbed(text);
        base.embedding_model = EMBEDDING_MODEL_TAG;
        base.embedding_dim = embedding.length;
      } catch (err) {
        failedEmbeds.push({ incident_id: inc.incident_id, reason: err.message });
        logWarn(`embed failed for ${inc.incident_id}: ${err.message}`);
        base.embedding_model = null;
        base.embedding_dim = null;
      }
      base.embedding = embedding;
      batchWithEmbed.push(base);
    } else {
      // No embed needed (embeddings off, OR a resurrect / metadata-only change
      // whose text is unchanged). Omit the `embedding` column so any existing
      // vector is PRESERVED, and carry the prior model/dim tags forward.
      base.embedding_model = prior?.embedding_model ?? null;
      base.embedding_dim = prior?.embedding_dim ?? null;
      batchNoEmbed.push(base);
    }

    events.push({
      incident_id: inc.incident_id,
      event_kind: prior ? 'updated' : 'inserted',
      branch, commit_sha: commitSha, who, detail: { status, classification },
    });
  }

  // ── Sweep decision ──
  const PARSE_BLOCKING = new Set(['missing-id', 'missing-description', 'duplicate-id']);
  const blockingWarnings = warnings.filter(w => PARSE_BLOCKING.has(w.kind));
  let swept = 0;
  let sweepBlockedBy = null;
  let removedIds = [];
  if (!onMain) {
    sweepBlockedBy = 'feature-branch';
    logInfo(`feature branch "${branch}" — sweep skipped (sweep gated to main).`);
  } else if (blockingWarnings.length > 0) {
    sweepBlockedBy = 'parser-warnings';
    logWarn(`sweep blocked: ${blockingWarnings.length} parser warning(s) — fix ${STRATEGY_PATH} before sweep can run.`);
  } else {
    const parsedIds = new Set(parsed.map(i => i.incident_id));
    removedIds = existing
      .filter(r => !parsedIds.has(r.incident_id) && r.status !== 'historical')
      .map(r => r.incident_id);
  }

  // ── Atomic write: incidents + events + sweep ──
  // Deliberately one transaction (all-or-nothing): events must be inserted in
  // the SAME transaction as the incident upsert. Embeddings (network) are
  // computed BEFORE this block, so the tx stays short. v1 scale is <~100
  // incidents/repo — a single tx is correct and cheap; revisit chunked commits
  // only if a repo's incident count grows into the thousands.
  await withTx(async () => {
    if (batchWithEmbed.length) await recordSecurityIncidents(repoId, batchWithEmbed, { includeEmbedding: true });
    if (batchNoEmbed.length) await recordSecurityIncidents(repoId, batchNoEmbed, { includeEmbedding: false });
    if (removedIds.length) {
      await markIncidentsHistorical(repoId, removedIds);
      for (const id of removedIds) {
        events.push({ incident_id: id, event_kind: 'marked_historical', branch, commit_sha: headSha, who, detail: { reason: 'absent-from-main-markdown' } });
      }
      swept = removedIds.length;
    }
    if (events.length) await recordStrategyEvents(repoId, events);
  });

  const upserted = batchWithEmbed.length + batchNoEmbed.length;
  if (upserted) logInfo(`upserted ${upserted} incident(s)`);
  if (swept) logInfo(`sweep: marked ${swept} historical: ${removedIds.join(', ')}`);
  if (refused.length) logWarn(`${refused.length} incident(s) refused (high-confidence secret).`);
  if (failedEmbeds.length) logWarn(`${failedEmbeds.length} incident(s) failed to embed.`);

  emit({
    ok: true,
    cloud: true,
    repoId,
    branch,
    onMain,
    embeddings: embeddingsOn ? 'on' : 'off',
    parsed: parsed.length,
    upserted,
    refused: refused.length,
    embedFailures: failedEmbeds.length,
    swept,
    sweepBlockedBy,
  });

  // Exit 2 only when embeddings were expected but some failed (half-built index).
  return (embeddingsOn && failedEmbeds.length > 0) ? 2 : 0;
}

main()
  .then(async (code) => {
    try { const p = await getPool(); if (p) await p.end(); } catch { /* ignore */ }
    process.exit(code ?? 0);
  })
  .catch(async (err) => {
    process.stderr.write(`security-refresh: fatal: ${err.stack || err.message}\n`);
    try { const p = await getPool(); if (p) await p.end(); } catch { /* ignore */ }
    process.exit(1);
  });
