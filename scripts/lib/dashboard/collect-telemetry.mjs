/**
 * @fileoverview Telemetry-data collector for the dashboard. Gathers audit
 * metrics (Supabase + local), the requirements ledger, and learning-decision
 * counts into one object plus a per-source status map. Secret-redacts any
 * free text before it reaches the page (docs/plans/local-dashboard.md §2.5).
 *
 * @module scripts/lib/dashboard/collect-telemetry
 */
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { fetchCloudMetrics, computeLocalMetrics } from '../../audit-metrics.mjs';
import { getLearningStats } from '../learning/stats.mjs';
import { redactSecrets } from '../sanitizer.mjs';

const DAYS = 30;
const MAX_REQ_ITEMS = 200;

/** Build a Supabase client from env, or null when unconfigured. */
function makeClient() {
  const url = process.env.SUPABASE_AUDIT_URL;
  const key = process.env.SUPABASE_AUDIT_ANON_KEY;
  return url && key ? createClient(url, key) : null;
}

/** Aggregate raw `audit_pass_stats` rows into per-pass totals. */
function aggregatePasses(passStats) {
  const byPass = {};
  for (const ps of passStats) {
    const name = ps.pass_name || 'unknown';
    if (!byPass[name]) byPass[name] = { name, runs: 0, raised: 0, accepted: 0, dismissed: 0 };
    const p = byPass[name];
    p.runs += 1;
    p.raised += ps.findings_raised || 0;
    p.accepted += ps.findings_accepted || 0;
    p.dismissed += ps.findings_dismissed || 0;
  }
  return Object.values(byPass).sort((a, b) => b.runs - a.runs);
}

/** Collect the audit-runs section. */
async function collectAuditRuns(sb) {
  const local = computeLocalMetrics(DAYS);
  const localPart = { total: local.total, labeled: local.labeled };
  let cloud = null;
  try {
    cloud = await fetchCloudMetrics(sb, DAYS);
  } catch (err) {
    return {
      data: { cloud: false, runCount: 0, labeledCount: 0, passes: [], local: localPart },
      status: { status: 'unexpected-error', detail: redactSecrets(`cloud metrics query failed: ${err.message}`) },
    };
  }
  if (!cloud) {
    const empty = !local.total;
    return {
      data: { cloud: false, runCount: 0, labeledCount: 0, passes: [], local: localPart },
      status: empty
        ? { status: 'missing-optional', detail: 'no cloud store and no local outcomes' }
        : { status: 'ok', detail: 'local-only' },
    };
  }
  return {
    data: {
      cloud: true,
      runCount: cloud.runs.length,
      labeledCount: cloud.labeled.length,
      passes: aggregatePasses(cloud.passStats),
      local: localPart,
    },
    status: { status: 'ok', detail: '' },
  };
}

/** Collect the requirements section from the committed ledger. */
function collectRequirements(root) {
  const rel = '.requirements/ledger.json';
  let raw;
  try { raw = fs.readFileSync(path.join(root, rel), 'utf-8'); }
  catch (err) {
    // ENOENT = the optional ledger is simply absent; any other read fault
    // (EACCES, …) is a real I/O failure, not "missing-optional".
    const status = err.code === 'ENOENT'
      ? { status: 'missing-optional', detail: 'no requirements ledger' }
      : { status: 'unexpected-error', detail: redactSecrets(`${rel} unreadable: ${err.message}`) };
    return { data: { present: false, total: 0, active: 0, truncated: false, items: [] }, status };
  }
  try {
    const ledger = JSON.parse(raw);
    const reqs = Array.isArray(ledger.requirements) ? ledger.requirements : [];
    const items = reqs.slice(0, MAX_REQ_ITEMS).map((r) => ({
      id: String(r.id || ''),
      kind: String(r.kind || 'unknown'),
      statement: redactSecrets(String(r.assertion || r.statement || '')).slice(0, 280),
      status: String(r.status || 'unknown'),
    }));
    return {
      data: {
        present: true,
        total: reqs.length,
        active: reqs.filter((r) => r.status === 'active').length,
        truncated: reqs.length > MAX_REQ_ITEMS,
        items,
      },
      status: { status: 'ok', detail: '' },
    };
  } catch (err) {
    return {
      data: { present: false, total: 0, active: 0, truncated: false, items: [] },
      status: { status: 'invalid', detail: redactSecrets(`ledger.json malformed: ${err.message}`) },
    };
  }
}

/** Collect the learning section via the shared accessor. */
async function collectLearning() {
  try {
    // getLearningStats is pure — the caller owns the env fallback.
    const r = await getLearningStats({ repoName: process.env.LEARNING_REPO_NAME || null });
    const s = r.stats || { pendingTriageCount: 0, noBrainerCount: 0, staleClusterCount: 0 };
    return {
      data: { cloud: r.cloud, ...s },
      status: r.status,
    };
  } catch (err) {
    return {
      data: { cloud: false, pendingTriageCount: 0, noBrainerCount: 0, staleClusterCount: 0 },
      status: { status: 'unexpected-error', detail: redactSecrets(`learning stats failed: ${err.message}`) },
    };
  }
}

/**
 * Collect the full telemetry-data object.
 * @param {{git?: {baseSha: string}}} [opts]
 * @returns {Promise<object>} a TelemetryData object (validate before render)
 */
export async function collectTelemetry(opts = {}) {
  const root = process.cwd();
  const git = opts.git || { baseSha: 'unknown' };
  const sb = makeClient();

  const [auditRuns, learning] = await Promise.all([collectAuditRuns(sb), collectLearning()]);
  const requirements = collectRequirements(root);

  return {
    kind: 'telemetry',
    provenance: {
      generatedAt: new Date().toISOString(),
      baseSha: git.baseSha,
      mode: auditRuns.data.cloud ? 'supabase' : 'local-only',
    },
    sources: {
      auditRuns: auditRuns.status,
      requirements: requirements.status,
      learning: learning.status,
    },
    auditRuns: auditRuns.data,
    requirements: requirements.data,
    learning: learning.data,
  };
}

// Internal exports for tests — collectRequirements is a pure file read, so
// it is fixturable; aggregatePasses is pure.
export const __test__ = { collectRequirements, aggregatePasses };
