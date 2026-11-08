/**
 * Known-answer canary in audit rounds (docs/plans/test-campaign-controls.md §2.2, §7.2).
 * Load-bearing: with AUDIT_CANARY=1 a round whose planted pass does not name the planted
 * defect is INCOMPLETE (blind), never clean; the canary finding never reaches `findings`;
 * flag unset ⇒ byte-identical.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXTURE_DIR, BACKEND_FILE, mkFinding, EMPTY_BACKEND, EMPTY_FRONTEND, defaultResponses,
} from './helpers/multi-pass-audit-fixtures.mjs';

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
const _prior = {
  MODEL_CATALOG_REFRESH: process.env.MODEL_CATALOG_REFRESH, LEARNING_DISABLE: process.env.LEARNING_DISABLE,
  AUDIT_DB_URL: process.env.AUDIT_DB_URL, AUDIT_NO_PREFLIGHT: process.env.AUDIT_NO_PREFLIGHT, AUDIT_CANARY: process.env.AUDIT_CANARY,
};
process.env.MODEL_CATALOG_REFRESH = 'skip';
process.env.LEARNING_DISABLE = '1';
process.env.AUDIT_DB_URL = '';
process.env.AUDIT_NO_PREFLIGHT = '1';
delete process.env.AUDIT_CANARY;
process.on('exit', () => {
  for (const [k, v] of Object.entries(_prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const {
  createCanary, createRoundCanary, citesCanary, namesCanaryDefect, canaryBlocksEvidence,
  applyCanaryToUnsupportedPipeline, CANARY_ELIGIBLE_PASSES,
} = await import('../scripts/lib/audit/canary.mjs');
const { formatAuditSummaryLine } = await import('../scripts/lib/audit/findings-pipeline.mjs');
const { MECHANICAL_WAVES } = await import('../scripts/lib/mechanical-waves.mjs');
const audit = await import('../scripts/openai-audit.mjs');
const { runMultiPassCodeAudit } = audit.__testExports;

const ON = { AUDIT_CANARY: '1' };
const built = () => ({ system: 'S', messages: [{ role: 'user', content: 'brief' }, { role: 'user', content: '## Code\nreal code' }] });
const DEFECT = 'Authorization check uses assignment (=) instead of comparison, so every user is treated as admin role';

describe('planting', () => {
  it('flag unset ⇒ plant is the identity and there is no outcome', () => {
    const rc = createRoundCanary({});
    const b = built();
    assert.equal(rc.plant(b, { passName: 'backend' }), b);
    assert.equal(rc.outcome(), null);
  });
  it('plants into every eligible pass, map-reduce unit 1 only, never probe or ineligible passes', () => {
    const rc = createRoundCanary(ON, { seed: 's' });
    const has = (r) => r.messages.at(-1).content.includes(rc.canary.path);
    for (const p of CANARY_ELIGIBLE_PASSES) assert.ok(has(rc.plant(built(), { passName: p })), p);
    assert.ok(has(rc.plant(built(), { passName: 'backend', unitLabel: 'Audit Unit 1/3 (4 files)' })));
    assert.ok(!has(rc.plant(built(), { passName: 'backend', unitLabel: 'Audit Unit 2/3 (4 files)' })));
    assert.ok(!has(rc.plant(built(), { passName: 'backend', unitLabel: 'probe' })));
    for (const p of ['structure', 'wiring', 'sustainability', 'quickfix']) assert.ok(!has(rc.plant(built(), { passName: p })), p);
    // the cacheable prefix (system + msg #1) is untouched
    const out = rc.plant(built(), { passName: 'backend' });
    assert.equal(out.system, 'S');
    assert.equal(out.messages[0].content, 'brief');
  });
  it('the canary is not a wave', () => {
    assert.ok(!MECHANICAL_WAVES.includes('canary'));
  });
});

describe('detection contract', () => {
  const c = createCanary({ seed: 'x' });
  it('requires the canary file AND the defect named as an assignment', () => {
    // The PRODUCER shape (ProducerFindingSchema) has no `file`: location is `section`. A `file`-only matcher read
    // every real report as a miss on the first live run — these assertions are what would have caught it.
    assert.ok(citesCanary({ section: `${c.path}:4` }, c));
    assert.ok(citesCanary({ section: `canOpenAdminConsole in ${c.path}` }, c));
    assert.ok(citesCanary({ file: c.path }, c), 'a pipeline-derived file field also matches');
    assert.ok(!citesCanary({ section: `${BACKEND_FILE}:1` }, c));
    assert.ok(!citesCanary({ file: BACKEND_FILE }, c));
    assert.ok(namesCanaryDefect({ category: 'Authorization', detail: DEFECT }));
    assert.ok(!namesCanaryDefect({ category: 'Naming', detail: 'function name canOpenAdminConsole is unclear' }));
    assert.ok(!namesCanaryDefect({ category: 'Style', detail: 'Use a named constant for the admin role comparison' }));
  });
});

describe('resolve', () => {
  const plantBoth = () => {
    const rc = createRoundCanary(ON, { seed: 'r' });
    rc.plant(built(), { passName: 'backend' });
    rc.plant(built(), { passName: 'frontend' });
    return rc;
  };
  const res = (findings, extra = {}) => ({ result: { findings }, ...extra });

  it('detected in every planted pass ⇒ detected, canary findings stripped, others kept', () => {
    const rc = plantBoth();
    const p = rc.canary.path;
    const real = mkFinding({ detail: 'real one' });
    const results = [res([{ section: `${p}:4`, detail: DEFECT }, real]), res([{ section: `${p}:4`, category: 'Security', detail: DEFECT }])];
    const o = rc.resolve(results, ['backend', 'frontend']);
    assert.equal(o.status, 'detected');
    assert.deepEqual(results[0].result.findings, [real]);
    assert.equal(results[1].result.findings.length, 0);
    assert.equal(canaryBlocksEvidence(o), false);
  });
  it('missing in one of two planted passes ⇒ missed (and still stripped)', () => {
    const rc = plantBoth();
    const results = [res([{ section: `${rc.canary.path}:4`, detail: DEFECT }]), res([{ section: `${rc.canary.path}:2`, detail: 'rename this function' }])];
    const o = rc.resolve(results, ['backend', 'frontend']);
    assert.equal(o.status, 'missed');
    assert.deepEqual(o.missedIn, ['frontend']);
    assert.equal(results[1].result.findings.length, 0);
    assert.equal(canaryBlocksEvidence(o), true);
  });
  it('a failed planted pass ⇒ pass-failed; nothing planted ⇒ not-planted; both block evidence', () => {
    const rc = createRoundCanary(ON, { seed: 'f' });
    rc.plant(built(), { passName: 'backend' });
    assert.equal(rc.resolve([res([], { failed: true })], ['backend']).status, 'pass-failed');
    const none = createRoundCanary(ON, { seed: 'n' });
    const o = none.resolve([], []);
    assert.equal(o.status, 'not-planted');
    assert.equal(canaryBlocksEvidence(o), true);
  });
  it('never mutates a shared result object', () => {
    const rc = plantBoth();
    const shared = Object.freeze({ findings: Object.freeze([{ section: `${rc.canary.path}:4`, detail: DEFECT }]) });
    const envelope = { result: shared };
    rc.resolve([envelope], ['backend']);
    assert.equal(shared.findings.length, 1);
    assert.equal(envelope.result.findings.length, 0);
  });
  it('tiered pipeline with the flag on ⇒ unsupported-pipeline + INCOMPLETE; flag off ⇒ untouched', () => {
    const r = applyCanaryToUnsupportedPipeline({ verdict: 'PASS' }, ON);
    assert.equal(r.verdict, 'INCOMPLETE');
    assert.equal(r._canary.status, 'unsupported-pipeline');
    assert.equal(r._convergence.converged, false);
    assert.equal(applyCanaryToUnsupportedPipeline({ verdict: 'PASS' }, {}).verdict, 'PASS');
  });
});

describe('summary line', () => {
  it('a blocking canary names itself and never prints the counts first', () => {
    const line = formatAuditSummaryLine({
      verdict: 'INCOMPLETE', high: 0, medium: 0, low: 0, passesTotal: 5, failedPasses: [],
      canary: { status: 'missed', missedIn: ['backend'], failedIn: [] },
    });
    assert.match(line, /^Verdict: INCOMPLETE — the planted canary defect was not reported by backend/);
    assert.doesNotMatch(line, /^Verdict: INCOMPLETE \| H:0/);
  });
  it('a detected canary does not change a clean line', () => {
    const line = formatAuditSummaryLine({ verdict: 'PASS', high: 0, medium: 0, low: 0, canary: { status: 'detected' } });
    assert.match(line, /^Verdict: PASS \| H:0 M:0 L:0/);
  });
});

// ── Orchestration: the real runMultiPassCodeAudit with a stub client ─────────
const PLAN = `# Canary fixture plan\n\nImplement \`${BACKEND_FILE}\` and \`${FIXTURE_DIR}/src/components/Widget.jsx\`.\n`;
const OPTS = { passFilter: ['structure', 'wiring', 'backend', 'frontend', 'sustainability', 'quickfix'], noTools: true, noDebtLedger: true, scopeMode: 'plan', noLedger: true };
const CANARY_PATH_RE = /### (src\/access\/console-guard-[0-9a-f]+\.mjs)/;

function stub(responses, seen) {
  return {
    responses: {
      parse: async (params) => {
        const name = params?.text?.format?.name;
        const prompt = JSON.stringify(params?.input ?? '');
        seen.push({ name, planted: CANARY_PATH_RE.test(prompt) });
        const h = responses[name];
        if (h === undefined) throw new Error(`stub: unexpected ${name}`);
        const result = typeof h === 'function' ? h(prompt) : h;
        return { status: 'completed', output: [], output_parsed: result,
          usage: { input_tokens: 100, output_tokens: 50, prompt_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 } } };
      },
    },
  };
}
const reportCanary = (empty) => (prompt) => {
  const m = prompt.match(CANARY_PATH_RE);
  return m ? { ...empty, findings: [mkFinding({ id: 'C1', severity: 'HIGH', category: 'Authorization', section: `${m[1]}:4`, detail: DEFECT })] } : empty;
};

describe('orchestration (runMultiPassCodeAudit, stub client)', () => {
  it('flag off ⇒ no canary in any prompt and no _canary key', async () => {
    delete process.env.AUDIT_CANARY;
    const seen = [];
    const r = await runMultiPassCodeAudit(stub(defaultResponses(), seen), PLAN, '', false, null, '', OPTS);
    assert.ok(seen.every((s) => !s.planted));
    assert.equal('_canary' in r, false);
    assert.equal(r.verdict, 'PASS');
  });
  it('flag on, auditor reports the defect ⇒ detected, canary finding absent from findings, verdict unaffected', async () => {
    process.env.AUDIT_CANARY = '1';
    try {
      const seen = [];
      const r = await runMultiPassCodeAudit(stub(defaultResponses({
        backend_pass: reportCanary(EMPTY_BACKEND), frontend_pass: reportCanary(EMPTY_FRONTEND),
      }), seen), PLAN, '', false, null, '', OPTS);
      assert.deepEqual(seen.filter((s) => s.planted).map((s) => s.name).sort(), ['backend_pass', 'frontend_pass']);
      assert.equal(r._canary.status, 'detected');
      assert.ok(r.findings.every((f) => !String(f.file || f.section).includes('console-guard-')));
      assert.equal(r.verdict, 'PASS');
    } finally { delete process.env.AUDIT_CANARY; }
  });
  it('flag on, auditor blind ⇒ INCOMPLETE and not converged', async () => {
    process.env.AUDIT_CANARY = '1';
    try {
      const r = await runMultiPassCodeAudit(stub(defaultResponses({ backend_pass: reportCanary(EMPTY_BACKEND) }), []), PLAN, '', false, null, '', OPTS);
      assert.equal(r._canary.status, 'missed');
      assert.deepEqual(r._canary.missedIn, ['frontend']);
      assert.equal(r.verdict, 'INCOMPLETE');
      assert.equal(r._convergence?.converged, false);
      assert.match(r._convergence.reason, /^canary-missed$/);
    } finally { delete process.env.AUDIT_CANARY; }
  });
  it('flag on, no eligible pass runs ⇒ not-planted ⇒ INCOMPLETE', async () => {
    process.env.AUDIT_CANARY = '1';
    try {
      const r = await runMultiPassCodeAudit(stub(defaultResponses(), []), PLAN, '', false, null, '', { ...OPTS, passFilter: ['structure'] });
      assert.equal(r._canary.status, 'not-planted');
      assert.equal(r.verdict, 'INCOMPLETE');
    } finally { delete process.env.AUDIT_CANARY; }
  });
});
