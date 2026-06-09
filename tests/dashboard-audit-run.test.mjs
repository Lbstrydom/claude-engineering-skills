/**
 * @fileoverview Tests for the read-only audit-run findings viewer
 * (docs/plans/dashboard-audit-run-viewer.md).
 *
 * Cluster A scope (this commit): the store read-query contract — the
 * highest-risk part (§9, M6). A fake `{one, many, isCloudEnabled}` query
 * client (no live DB) asserts SQL targeting, raw→domain mapping, ordering
 * clause presence, column-probe omission, and the null-vs-[] distinction.
 *
 * Cluster B will extend this file with collector + renderer + presenter cases.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getRunFindings,
  getRunMeta,
  _resetRunReadColumnCache,
} from '../scripts/lib/store/runs-findings.mjs';
import { collectAuditRun } from '../scripts/lib/dashboard/collect-audit-run.mjs';
import { presentFinding, resolveStatusToken } from '../scripts/lib/dashboard/audit-run-presenter.mjs';
import { renderDocument } from '../scripts/lib/dashboard/render.mjs';

const PROVENANCE = { generatedAt: '2026-06-10T00:00:00Z', baseSha: 'abc1234', mode: 'audit-run', dirty: false };
const ASSETS = { css: '', js: '' };

function domainFinding(over = {}) {
  return {
    id: 'f1', fingerprint: 'fp1', pass: 'backend', severity: 'HIGH', category: 'security',
    file: 'src/a.js', detail: 'a finding', round: 1, adjudication: null, remediation: null, ...over,
  };
}

/**
 * Build a fake query client. The probe queries (`… LIMIT 0`) are answered
 * from `presentColumns` — keyed `<table>.<col>` so a column present on one
 * table but absent on another is modelled correctly (not by bare column name).
 * Data queries return the canned rows. Every call is recorded so the test can
 * assert SQL text + bound params. An absent column throws a realistic
 * undefined-column error (`code: '42703'`), matching what `pg` raises.
 */
function makeFakeClient({
  findingsRows = [],
  metaRow = null,
  presentColumns = new Set(),
  cloud = true,
} = {}) {
  const calls = [];
  const probeRe = /SELECT\s+"?(\w+)"?\s+FROM\s+(\w+)\s+LIMIT 0/i;
  const many = async (sql, params) => {
    calls.push({ sql, params });
    const m = probeRe.exec(sql);
    if (m) {
      const [, col, table] = m;
      if (presentColumns.has(`${table}.${col}`)) return [];
      const err = new Error(`column "${col}" of relation "${table}" does not exist`);
      err.code = '42703';
      throw err;
    }
    return findingsRows;
  };
  const one = async (sql, params) => {
    calls.push({ sql, params });
    return metaRow;
  };
  const isCloudEnabled = async () => cloud;
  return { one, many, isCloudEnabled, calls };
}

const ALL_FINDING_OPTIONAL = new Set(['audit_findings.adjudication_outcome', 'audit_findings.remediation_state']);
const ALL_META_OPTIONAL = new Set([
  'audit_runs.round_converged_after', 'audit_runs.commit_sha', 'audit_runs.branch', 'audit_runs.plan_id',
]);

describe('getRunFindings — store read-query contract', () => {
  beforeEach(() => _resetRunReadColumnCache());

  it('returns null only when cloud is disabled (no query attempted)', async () => {
    const fake = makeFakeClient({ cloud: false });
    const out = await getRunFindings('run-1', fake);
    assert.equal(out, null);
    // No query (probe or data) is issued when cloud is off.
    assert.equal(fake.calls.length, 0);
  });

  it('returns [] for a run with zero findings (distinct from null)', async () => {
    const fake = makeFakeClient({ findingsRows: [], presentColumns: ALL_FINDING_OPTIONAL });
    const out = await getRunFindings('run-empty', fake);
    assert.deepEqual(out, []);
  });

  it('binds run_id=$1 to audit_findings and orders by severity', async () => {
    const fake = makeFakeClient({ findingsRows: [], presentColumns: ALL_FINDING_OPTIONAL });
    await getRunFindings('run-xyz', fake);
    const dataCall = fake.calls.find((c) => !/LIMIT 0/i.test(c.sql));
    assert.ok(dataCall, 'a data query was issued');
    assert.match(dataCall.sql, /FROM audit_findings/);
    assert.match(dataCall.sql, /WHERE run_id = \$1/);
    assert.match(dataCall.sql, /ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END/);
    assert.deepEqual(dataCall.params, ['run-xyz']);
  });

  it('maps raw columns to the domain shape (detail null→"", file nullable)', async () => {
    const fake = makeFakeClient({
      presentColumns: ALL_FINDING_OPTIONAL,
      findingsRows: [
        {
          id: 'f1',
          finding_fingerprint: 'fp-1',
          pass_name: 'backend',
          severity: 'HIGH',
          category: 'security',
          primary_file: 'src/a.js',
          detail_snapshot: 'SQL injection risk',
          round_raised: 2,
          created_at: '2026-06-09T00:00:00Z',
          adjudication_outcome: 'accepted',
          remediation_state: 'fixed',
        },
        {
          id: 'f2',
          finding_fingerprint: 'fp-2',
          pass_name: 'structure',
          severity: 'LOW',
          category: 'style',
          primary_file: null,
          detail_snapshot: null,
          round_raised: 1,
          created_at: '2026-06-09T00:00:01Z',
          adjudication_outcome: null,
          remediation_state: null,
        },
      ],
    });
    const out = await getRunFindings('run-1', fake);
    assert.deepEqual(out[0], {
      id: 'f1',
      fingerprint: 'fp-1',
      pass: 'backend',
      severity: 'HIGH',
      category: 'security',
      file: 'src/a.js',
      detail: 'SQL injection risk',
      round: 2,
      adjudication: 'accepted',
      remediation: 'fixed',
    });
    assert.equal(out[1].file, null, 'null primary_file maps to null');
    assert.equal(out[1].detail, '', 'null detail_snapshot maps to ""');
    assert.equal(out[1].adjudication, null);
    assert.equal(out[1].remediation, null);
  });

  it('omits adjudication_outcome/remediation_state when the probe reports them absent', async () => {
    const fake = makeFakeClient({ presentColumns: new Set(), findingsRows: [] });
    await getRunFindings('run-1', fake);
    const dataCall = fake.calls.find((c) => !/LIMIT 0/i.test(c.sql));
    assert.doesNotMatch(dataCall.sql, /adjudication_outcome/);
    assert.doesNotMatch(dataCall.sql, /remediation_state/);
    // Base columns still present.
    assert.match(dataCall.sql, /detail_snapshot/);
  });

  it('includes the optional columns when the probe reports them present', async () => {
    const fake = makeFakeClient({ presentColumns: ALL_FINDING_OPTIONAL, findingsRows: [] });
    await getRunFindings('run-1', fake);
    const dataCall = fake.calls.find((c) => !/LIMIT 0/i.test(c.sql));
    assert.match(dataCall.sql, /adjudication_outcome/);
    assert.match(dataCall.sql, /remediation_state/);
  });

  it('a transient probe error does NOT poison the column cache (re-probes next call)', async () => {
    // Model a connectivity blip on the FIRST adjudication_outcome probe (a
    // transient code, NOT 42703), then recovery: the column actually exists.
    // A poisoned cache would omit it forever; the fix must re-probe it on the
    // next call. We count probes of adjudication_outcome specifically.
    _resetRunReadColumnCache();
    let adjProbes = 0;
    const probeRe = /SELECT\s+"?(\w+)"?\s+FROM\s+(\w+)\s+LIMIT 0/i;
    const transient = async (sql) => {
      const m = probeRe.exec(sql);
      if (m) {
        const col = m[1];
        if (col === 'adjudication_outcome') {
          adjProbes++;
          if (adjProbes === 1) {
            const err = new Error('connection terminated unexpectedly');
            err.code = '57P01'; // admin_shutdown — transient, NOT undefined-column
            throw err;
          }
        }
        return []; // every other probe (and the recovered adjudication probe) → present
      }
      return [];
    };
    const deps = { many: transient, isCloudEnabled: async () => true };
    await getRunFindings('run-1', deps); // adjProbes → 1 (threw, not cached)
    await getRunFindings('run-1', deps); // adjProbes → 2 (re-probed because not poisoned)
    assert.equal(adjProbes, 2, 'adjudication_outcome was re-probed rather than cached false after a transient error');
  });

  it('domain rows still carry null adjudication/remediation when columns absent', async () => {
    const fake = makeFakeClient({
      presentColumns: new Set(),
      findingsRows: [{
        id: 'f1', finding_fingerprint: 'fp', pass_name: 'wiring', severity: 'MEDIUM',
        category: 'bug', primary_file: 'x.js', detail_snapshot: 'd', round_raised: 1,
        created_at: 't',
      }],
    });
    const out = await getRunFindings('run-1', fake);
    assert.equal(out[0].adjudication, null);
    assert.equal(out[0].remediation, null);
  });
});

describe('getRunMeta — store read-query contract', () => {
  beforeEach(() => _resetRunReadColumnCache());

  it('returns null when cloud is disabled', async () => {
    const fake = makeFakeClient({ cloud: false });
    assert.equal(await getRunMeta('run-1', fake), null);
    assert.equal(fake.calls.length, 0);
  });

  it('returns null when the run row is absent (→ run_not_found)', async () => {
    const fake = makeFakeClient({ metaRow: null, presentColumns: ALL_META_OPTIONAL });
    assert.equal(await getRunMeta('missing', fake), null);
  });

  it('binds id=$1 to audit_runs and maps fields to the domain shape', async () => {
    const fake = makeFakeClient({
      presentColumns: ALL_META_OPTIONAL,
      metaRow: {
        id: 'run-1',
        plan_file: 'docs/plans/x.md',
        mode: 'code',
        rounds: 4,
        gemini_verdict: 'APPROVE',
        total_findings: 7,
        round_converged_after: 3,
        commit_sha: 'abc123',
        branch: 'main',
        plan_id: 'plan-uuid',
        created_at: '2026-06-09T00:00:00Z',
      },
    });
    const out = await getRunMeta('run-1', fake);
    const dataCall = fake.calls.find((c) => !/LIMIT 0/i.test(c.sql));
    assert.match(dataCall.sql, /FROM audit_runs WHERE id = \$1/);
    assert.deepEqual(dataCall.params, ['run-1']);
    assert.deepEqual(out, {
      id: 'run-1',
      planFile: 'docs/plans/x.md',
      mode: 'code',
      rounds: 4,
      geminiVerdict: 'APPROVE',
      totalFindings: 7,
      roundConvergedAfter: 3,
      commitSha: 'abc123',
      branch: 'main',
      planId: 'plan-uuid',
      createdAt: '2026-06-09T00:00:00Z',
    });
  });

  it('probe-guards later-migration columns (un-migrated store still returns a row)', async () => {
    const fake = makeFakeClient({
      presentColumns: new Set(), // no optional columns
      metaRow: { id: 'run-1', plan_file: 'p', mode: 'code', rounds: 1, gemini_verdict: null, total_findings: 0, created_at: 't' },
    });
    const out = await getRunMeta('run-1', fake);
    const dataCall = fake.calls.find((c) => !/LIMIT 0/i.test(c.sql));
    assert.doesNotMatch(dataCall.sql, /round_converged_after/);
    assert.doesNotMatch(dataCall.sql, /commit_sha/);
    // Domain fields still present (null), so downstream never reads undefined.
    assert.equal(out.roundConvergedAfter, null);
    assert.equal(out.commitSha, null);
    assert.equal(out.planId, null);
  });
});

// ── Cluster B: presenter ─────────────────────────────────────────────────

describe('audit-run-presenter — domain → UI tokens (M7)', () => {
  it('maps severity to closed band class + token', () => {
    assert.equal(presentFinding(domainFinding({ severity: 'HIGH' })).sevClass, 'sev-high');
    assert.equal(presentFinding(domainFinding({ severity: 'MEDIUM' })).sevClass, 'sev-med');
    assert.equal(presentFinding(domainFinding({ severity: 'LOW' })).sevClass, 'sev-low');
    assert.equal(presentFinding(domainFinding({ severity: 'HIGH' })).sevToken, 'HIGH');
  });

  it('defensively falls back to grey band + raw label for an unknown severity', () => {
    const p = presentFinding(domainFinding({ severity: 'CRITICAL' }));
    assert.equal(p.sevClass, 'sev-low');
    assert.equal(p.sevToken, 'LOW');
    assert.equal(p.sevLabel, 'CRITICAL');
  });

  it('buckets an unknown pass to "other" but keeps the raw label', () => {
    const p = presentFinding(domainFinding({ pass: 'Structure' }));
    assert.equal(p.passToken, 'structure'); // case-normalised, in the closed set
    const q = presentFinding(domainFinding({ pass: 'weird-pass' }));
    assert.equal(q.passToken, 'other');
    assert.equal(q.passLabel, 'weird-pass');
  });

  it('statusToken precedence: remediation_state wins over adjudication_outcome', () => {
    assert.equal(resolveStatusToken({ remediation: 'fixed', adjudication: 'accepted' }), 'fixed');
    assert.equal(resolveStatusToken({ remediation: null, adjudication: 'dismissed' }), 'dismissed');
    assert.equal(resolveStatusToken({ remediation: null, adjudication: null }), 'none');
    assert.equal(resolveStatusToken({ remediation: 'bogus', adjudication: 'accepted' }), 'accepted');
  });

  it('null file → "No file" label, file passes through otherwise', () => {
    assert.equal(presentFinding(domainFinding({ file: null })).fileLabel, 'No file');
    assert.equal(presentFinding(domainFinding({ file: 'x/y.js' })).fileLabel, 'x/y.js');
  });
});

// ── Cluster B: collector (injected store stubs, no live DB) ───────────────

describe('collectAuditRun — discriminated status codes', () => {
  const stubs = (over) => ({
    isCloudEnabled: async () => true,
    getRunMeta: async () => ({ id: 'run-1', planFile: 'p', mode: 'code', rounds: 1, geminiVerdict: 'APPROVE', totalFindings: 1, roundConvergedAfter: null, commitSha: null, branch: null, planId: null, createdAt: '2026-06-10T00:00:00Z' }),
    getRunFindings: async () => [domainFinding()],
    getAuditRunConvergence: async () => null,
    ...over,
  });

  it('cloud_disabled when isCloudEnabled() is false (getRunMeta never called)', async () => {
    let metaCalled = false;
    const { data, status } = await collectAuditRun({
      runId: 'run-1', provenance: PROVENANCE,
      deps: stubs({ isCloudEnabled: async () => false, getRunMeta: async () => { metaCalled = true; return null; } }),
    });
    assert.equal(status.code, 'cloud_disabled');
    assert.equal(data.src.status, 'cloud_disabled');
    assert.equal(metaCalled, false);
  });

  it('run_not_found when getRunMeta returns null', async () => {
    const { data, status } = await collectAuditRun({
      runId: 'run-x', provenance: PROVENANCE, deps: stubs({ getRunMeta: async () => null }),
    });
    assert.equal(status.code, 'run_not_found');
    assert.equal(data.auditRun.runId, 'run-x');
  });

  it('ok with [] for a run with zero findings', async () => {
    const { data, status } = await collectAuditRun({
      runId: 'run-1', provenance: PROVENANCE, deps: stubs({ getRunFindings: async () => [] }),
    });
    assert.equal(status.code, 'ok');
    assert.deepEqual(data.auditRun.findings, []);
  });

  it('ok with presented rows for a run with findings', async () => {
    const { data, status } = await collectAuditRun({
      runId: 'run-1', provenance: PROVENANCE, deps: stubs(),
    });
    assert.equal(status.code, 'ok');
    assert.equal(data.auditRun.findings.length, 1);
    assert.equal(data.auditRun.findings[0].sevClass, 'sev-high'); // presenter ran
  });

  it('query_error when the store throws', async () => {
    const { data, status } = await collectAuditRun({
      runId: 'run-1', provenance: PROVENANCE,
      deps: stubs({ getRunMeta: async () => { throw new Error('boom'); } }),
    });
    assert.equal(status.code, 'query_error');
    assert.match(data.src.detail, /redacted/i); // raw error not leaked
  });

  it('convergence falls back to getAuditRunConvergence when roundConvergedAfter is null (G1)', async () => {
    const { data } = await collectAuditRun({
      runId: 'run-1', provenance: PROVENANCE,
      deps: stubs({ getRunFindings: async () => [], getAuditRunConvergence: async () => ({ roundConvergedAfter: 3 }) }),
    });
    assert.equal(data.auditRun.convergedAfter, 3);
  });
});

// ── Cluster B: pure renderDocument (no I/O, no browser) ───────────────────

function auditRunData(over = {}) {
  return {
    kind: 'audit-run',
    provenance: PROVENANCE,
    src: { status: 'ok', detail: '' },
    auditRun: {
      runId: 'run-1', meta: null, convergedAfter: null,
      findings: [
        presentFinding(domainFinding({ id: 'f1', severity: 'HIGH', pass: 'backend', file: 'src/a.js', detail: 'high one' })),
        presentFinding(domainFinding({ id: 'f2', severity: 'LOW', pass: 'structure', file: 'src/b.js', detail: 'low one' })),
      ],
    },
    ...over,
  };
}

describe('renderDocument(audit-run) — pure render contract (§9)', () => {
  it('renders severity bands + data-severity attributes', () => {
    const html = renderDocument(auditRunData(), 'audit-run', ASSETS);
    assert.match(html, /class="finding-row sev-high"/);
    assert.match(html, /data-severity="HIGH"/);
    assert.match(html, /data-severity="LOW"/);
  });

  it('filter chips are real <button type="button"> with aria-pressed', () => {
    const html = renderDocument(auditRunData(), 'audit-run', ASSETS);
    assert.match(html, /<button type="button" class="filter-chip"[^>]*aria-pressed="false"/);
    assert.match(html, /data-filter-group="severity"/);
  });

  it('escapes finding detail containing <script> (XSS contract)', () => {
    const data = auditRunData();
    data.auditRun.findings = [presentFinding(domainFinding({ detail: '<script id="xss">alert(1)</script>' }))];
    const html = renderDocument(data, 'audit-run', ASSETS);
    assert.doesNotMatch(html, /<script id="xss">/);
    assert.match(html, /&lt;script id=&quot;xss&quot;&gt;/);
  });

  it('sets the data-dashboard-kind root only on the ok page', () => {
    assert.match(renderDocument(auditRunData(), 'audit-run', ASSETS), /data-dashboard-kind="audit-run"/);
  });

  it('cloud_disabled renders an AUDIT_DB_URL panel, no findings table', () => {
    const html = renderDocument(auditRunData({ src: { status: 'cloud_disabled', detail: '' }, auditRun: { runId: 'run-1', meta: null, convergedAfter: null, findings: [] } }), 'audit-run', ASSETS);
    assert.match(html, /AUDIT_DB_URL/);
    assert.doesNotMatch(html, /findings-table/);
  });

  it('run_not_found renders the run id, no table', () => {
    const html = renderDocument(auditRunData({ src: { status: 'run_not_found', detail: '' }, auditRun: { runId: 'run-zzz', meta: null, convergedAfter: null, findings: [] } }), 'audit-run', ASSETS);
    assert.match(html, /run-zzz not found/);
  });

  it('run_not_found escapes a malicious runId (emptyPanel escapes its message — no self-XSS)', () => {
    // Gemini final review flagged a suspected unescaped CLI runId here; verified
    // false-positive — ui.emptyPanel escapes its message internally. Locked so it
    // stays that way and a maintainer never "fixes" it into a double-escape.
    const html = renderDocument(auditRunData({
      src: { status: 'run_not_found', detail: '' },
      auditRun: { runId: '<script id="xss">alert(1)</script>', meta: null, convergedAfter: null, findings: [] },
    }), 'audit-run', ASSETS);
    assert.doesNotMatch(html, /<script id="xss">/);
    assert.match(html, /&lt;script id=&quot;xss&quot;&gt;/);
  });

  it('query_error renders a warning panel', () => {
    const html = renderDocument(auditRunData({ src: { status: 'query_error', detail: 'Findings query failed (redacted).' }, auditRun: { runId: 'run-1', meta: null, convergedAfter: null, findings: [] } }), 'audit-run', ASSETS);
    assert.match(html, /query failed/i);
  });

  it('zero-findings ok with convergence asserts "converged after round N" (M5)', () => {
    const html = renderDocument(auditRunData({ auditRun: { runId: 'run-1', meta: null, convergedAfter: 3, findings: [] } }), 'audit-run', ASSETS);
    assert.match(html, /converged after round 3/);
  });

  it('back-nav links resolve up one level (../) from the nested page (G1)', () => {
    const html = renderDocument(auditRunData(), 'audit-run', ASSETS);
    assert.match(html, /href="\.\.\/index\.html"/);
    assert.match(html, /href="\.\.\/telemetry\.html"/);
  });
});
