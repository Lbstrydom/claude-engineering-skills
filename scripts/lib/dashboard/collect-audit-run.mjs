/**
 * @fileoverview Collector for the read-only audit-run findings viewer
 * (docs/plans/dashboard-audit-run-viewer.md §7.0). Resolves a runId (CLI
 * `--run`, else `.audit/last-audit-run.json`), queries the durable cloud
 * store, and returns a `{ data, status }` envelope with a DISCRIMINATED
 * `status.code`. Unlike collect-telemetry there is NO "partial local
 * fallback" — audit findings have no local source, so absence is always one
 * of the discrete codes, never a half-rendered page (§ collector result model).
 *
 * Resolution order (M1, G3): resolve the runId FIRST (independent of cloud —
 * it both names the output file and gates writability). No id → a CLI-only
 * code (missing/invalid pointer): `data` is null and build-dashboard prints to
 * stderr + exits non-zero, writing no HTML. With an id in hand, check cloud
 * (off → cloud_disabled, kept distinct from run_not_found since getRunMeta is
 * never called when cloud is off), else getRunMeta (null → run_not_found) +
 * getRunFindings, wrapping any store throw as query_error. Every id-resolved
 * code renders an HTML panel AND writes a file (no unreachable UI).
 *
 * @module scripts/lib/dashboard/collect-audit-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { getRunFindings, getRunMeta, getAuditRunConvergence } from '../store/runs-findings.mjs';
import { isCloudEnabled } from '../store/repo.mjs';
import { redactSecrets } from '../sanitizer.mjs';
import { presentFindings } from './audit-run-presenter.mjs';

const POINTER_PATH = path.join(process.cwd(), '.audit', 'last-audit-run.json');

/**
 * Resolve the runId from an explicit arg or the durable pointer file.
 * @param {string|undefined} explicit
 * @returns {{ runId: string|null, code: string|null }}
 */
export function resolveRunId(explicit) {
  if (explicit != null && String(explicit).trim()) {
    return { runId: String(explicit).trim(), code: null };
  }
  let raw;
  try {
    raw = fs.readFileSync(POINTER_PATH, 'utf-8');
  } catch {
    return { runId: null, code: 'missing_run_pointer' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { runId: null, code: 'invalid_run_pointer' };
  }
  if (!parsed || typeof parsed.runId !== 'string' || !parsed.runId.trim()) {
    return { runId: null, code: 'invalid_run_pointer' };
  }
  return { runId: parsed.runId.trim(), code: null };
}

function coerceTs(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Coerce a domain meta row into the schema shape (timestamps → ISO strings). */
function coerceMeta(meta) {
  if (!meta) return null;
  return { ...meta, createdAt: coerceTs(meta.createdAt) };
}

function makeData(statusCode, { runId, meta, findings, convergedAfter }, provenance, detail) {
  return {
    kind: 'audit-run',
    provenance,
    src: { status: statusCode, detail: detail || '' },
    auditRun: {
      runId,
      meta: meta || null,
      findings: findings || [],
      convergedAfter: convergedAfter ?? null,
    },
  };
}

/**
 * @param {{ runId?: string, provenance: object, deps?: object }} opts
 *   `provenance` is built by build-dashboard (it owns generatedAt + git).
 *   `deps` is an optional dependency-injection seam for unit tests.
 * @returns {Promise<{ data: object|null, status: { code: string } }>}
 */
export async function collectAuditRun({ runId: explicitRunId, provenance = {}, deps = {} } = {}) {
  const {
    getRunMeta: getMeta = getRunMeta,
    getRunFindings: getFindings = getRunFindings,
    getAuditRunConvergence: getConvergence = getAuditRunConvergence,
    isCloudEnabled: cloudEnabled = isCloudEnabled,
  } = deps;

  const { runId, code } = resolveRunId(explicitRunId);
  // No id resolved → CLI-only states (G3): no HTML, no file. build-dashboard
  // turns these into a stderr message + non-zero exit.
  if (code) return { data: null, status: { code } };

  // Cloud off → distinct from run_not_found (getRunMeta is never called — M1).
  if (!await cloudEnabled()) {
    return {
      data: makeData('cloud_disabled', { runId, meta: null, findings: [], convergedAfter: null }, provenance),
      status: { code: 'cloud_disabled' },
    };
  }

  // State machine (§7.0): metadata existence is validated BEFORE the dependent
  // findings query is issued — a missing run short-circuits to run_not_found
  // without a wasted findings query. Both reads share the query_error catch
  // (a store throw in either is the same degraded outcome). The stderr message
  // is redacted (a connection/auth error could otherwise echo a credential —
  // the UI detail is already a fixed redacted string).
  let meta, rawFindings;
  try {
    meta = await getMeta(runId);
    if (meta == null) {
      return {
        data: makeData('run_not_found', { runId, meta: null, findings: [], convergedAfter: null }, provenance),
        status: { code: 'run_not_found' },
      };
    }
    rawFindings = await getFindings(runId);
  } catch (err) {
    process.stderr.write(`  [dashboard] audit-run query failed: ${redactSecrets(String(err && err.message ? err.message : err))}\n`);
    return {
      data: makeData('query_error', { runId, meta: null, findings: [], convergedAfter: null }, provenance,
        'Findings query failed (redacted).'),
      status: { code: 'query_error' },
    };
  }

  // Convergence signal (G1): a present-and-non-null round_converged_after is
  // authoritative; otherwise consult getAuditRunConvergence rather than
  // inferring convergence from a zero finding count. A lookup failure is
  // non-fatal (it only affects the zero-findings empty-state subtitle) but is
  // logged rather than swallowed silently.
  let convergedAfter = meta.roundConvergedAfter ?? null;
  if (convergedAfter == null) {
    try {
      const c = await getConvergence(runId);
      convergedAfter = c?.roundConvergedAfter ?? null;
    } catch (err) {
      process.stderr.write(`  [dashboard] audit-run convergence lookup failed (non-fatal): ${redactSecrets(String(err && err.message ? err.message : err))}\n`);
      convergedAfter = null;
    }
  }

  return {
    data: makeData('ok', {
      runId,
      meta: coerceMeta(meta),
      findings: presentFindings(rawFindings || []),
      convergedAfter,
    }, provenance),
    status: { code: 'ok' },
  };
}
