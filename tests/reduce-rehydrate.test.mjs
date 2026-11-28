/**
 * REDUCE must never rewrite a MAP finding's text (upstream aa0298f2).
 *
 * Before the fix, `buildReducePayload` sent REDUCE an 11-field view with
 * `detail` cut to 200 characters, and `runMapReducePass` returned whatever
 * REDUCE regenerated from that view. So even a perfectly faithful REDUCE
 * could only hand back truncated findings missing `risk`, `recommendation`,
 * `principle`, `is_mechanical` and `classification`.
 *
 * Now REDUCE answers with DECISIONS keyed by payload refs, and every output
 * finding is rebuilt from the full MAP object. These tests drive the REAL
 * `runMapReducePass` through the real `callGPT` boundary with a stubbed client.
 *
 * Negative control: the stub's REDUCE leg answers in whichever contract the
 * request asks for. Asked for the old `PassFindingsSchema` shape, it echoes
 * the payload's findings back verbatim — the best any model could do under the
 * old contract — and the byte-for-byte assertion fails (red at 067057e9).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MODEL_CATALOG_REFRESH = 'skip';
process.env.LEARNING_DISABLE = '1';
process.env.AUDIT_DB_URL = '';
process.env.AUDIT_NO_PREFLIGHT = '1';

const { runMapReducePass } = await import('../scripts/lib/audit/map-reduce-scheduler.mjs');
const { ReduceStatus } = await import('../scripts/lib/schemas.mjs');

const OK_USAGE = {
  input_tokens: 10, output_tokens: 5,
  prompt_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 1 },
};

const LONG_DETAIL = 'The REDUCE payload cut this detail. '.repeat(12).trim(); // ~430 chars, > 200
const FULL = (o = {}) => ({
  id: 'H1', severity: 'HIGH', category: 'Missing Error Handling', section: 'unit0.mjs:1',
  detail: LONG_DETAIL,
  risk: 'A failure here is swallowed and the caller reads success.',
  recommendation: 'Propagate the error with its category and assert the caller handles it.',
  is_quick_fix: false, is_mechanical: true,
  principle: 'Error Handling (#15)',
  importance: 'important', pre_existing: false, newly_reachable: false,
  classification: { sonarType: 'BUG', effort: 'MEDIUM', sourceKind: 'MODEL', sourceName: 'test-stub' },
  lineQuote: 'export const unit0 = 0;',
  is_reopened: false,
  ...o,
});

function mkFixtureFiles(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reduce-rehydrate-'));
  const files = [];
  for (let i = 0; i < n; i++) {
    const p = path.join(dir, `unit${i}.mjs`);
    fs.writeFileSync(p, `export const unit${i} = ${i};\n`, 'utf-8');
    files.push(p);
  }
  return { dir, files };
}
const buildPromptForUnit = (unit, i, total, unitLabel) =>
  ({ system: 'sys', messages: [{ role: 'user', content: unitLabel }] });

/** The JSON array the scheduler embedded in the REDUCE user prompt. */
function payloadFrom(params) {
  const user = (params.input ?? []).find(m => m.role === 'user')?.content ?? '';
  const start = user.indexOf('[');
  const end = user.lastIndexOf(']');
  return JSON.parse(user.slice(start, end + 1));
}

/**
 * @param {(i:number) => object[]} mapFindings  findings MAP unit i returns
 * @param {(payload: object[], params: object) => object} reduce  REDUCE answer
 */
function makeStub(mapFindings, reduce) {
  return {
    responses: {
      parse: async (params) => {
        const name = params?.text?.format?.name;
        if (name.startsWith('map_')) {
          const i = Number(name.split('_').pop());
          return { status: 'completed', output: [], usage: OK_USAGE,
            output_parsed: { pass_name: 'mrtest', quick_fix_warnings: [], summary: 'ok', findings: mapFindings(i) } };
        }
        if (name.startsWith('reduce_')) {
          return { status: 'completed', output: [], usage: OK_USAGE, output_parsed: reduce(payloadFrom(params), params) };
        }
        throw new Error(`unexpected schemaName: ${name}`);
      },
    },
  };
}

/** Whether the REDUCE request asks for the decision contract (has `merge_groups`). */
const asksForDecisions = (params) =>
  JSON.stringify(params?.text?.format?.schema ?? {}).includes('merge_groups');

/** Old contract: echo the payload's findings back unchanged (a perfectly faithful model). */
const echoOld = (payload) => ({ pass_name: 'mrtest', findings: payload, quick_fix_warnings: [], summary: 'echo' });

async function run(mapFindings, reduce, nUnits = 2) {
  const { dir, files } = mkFixtureFiles(nUnits);
  try {
    return await runMapReducePass(makeStub(mapFindings, reduce), files, 'mrtest', buildPromptForUnit, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

/** Every field the MAP finding carried, compared on the MAP finding's own keys. */
function assertSurvived(out, original) {
  for (const [k, v] of Object.entries(original)) {
    assert.deepEqual(out[k], v, `field ${k} must survive REDUCE byte for byte`);
  }
}

describe('REDUCE rebuilds findings from MAP by reference (aa0298f2)', () => {
  it('a >200-char MAP finding with every field survives REDUCE unchanged — merged into, and untouched', async () => {
    const keep = FULL({ id: 'H1', section: 'unit0.mjs:1' });
    const dupe = FULL({ id: 'H1', section: 'unit1.mjs:1', detail: 'Same issue, worded differently in unit 1.', severity: 'MEDIUM' });
    const other = FULL({ id: 'M1', severity: 'MEDIUM', section: 'unit1.mjs:2', category: 'Naming', detail: `Other: ${LONG_DETAIL}` });
    const result = await run(
      (i) => (i === 0 ? [structuredClone(keep)] : [structuredClone(dupe), structuredClone(other)]),
      (payload, params) => {
        if (!asksForDecisions(params)) return echoOld(payload);
        const refOf = (sec) => payload.find(p => p.section === sec).ref;
        return {
          pass_name: 'mrtest',
          merge_groups: [{ keep_ref: refOf('unit0.mjs:1'), duplicate_refs: [refOf('unit1.mjs:1')], reason: 'same issue' }],
          severity_elevations: [], systemic_findings: [], quick_fix_warnings: [], summary: 'merged',
        };
      },
    );
    const findings = result.result.findings;
    const outKeep = findings.find(f => f.section === 'unit0.mjs:1');
    const outOther = findings.find(f => f.section === 'unit1.mjs:2');
    assert.ok(outKeep, 'the kept finding is present');
    assert.ok(outOther, 'a finding REDUCE never mentioned is present');
    assertSurvived(outKeep, keep);
    assertSurvived(outOther, other);
    assert.equal(findings.some(f => f.section === 'unit1.mjs:1'), false, 'the merged duplicate leaves the output');
    assert.equal(outKeep._reduce.mergedFrom.length, 1);
    assert.equal(outKeep._reduce.mergedFrom[0].reason, 'reduce-merge');
    assertSurvived(outKeep._reduce.mergedFrom[0].finding, dupe);
    assert.equal(result.result._executionMeta?.reduceStatus, undefined, 'a clean REDUCE carries no degradation');
  });

  it('an unknown ref fails loudly: parse_error, raw MAP findings preserved intact', async () => {
    const a = FULL({ id: 'H1', section: 'unit0.mjs:1' });
    const b = FULL({ id: 'H1', section: 'unit1.mjs:1', category: 'Other' });
    const result = await run(
      (i) => [structuredClone(i === 0 ? a : b)],
      (payload, params) => {
        if (!asksForDecisions(params)) return echoOld(payload);
        return {
          pass_name: 'mrtest',
          merge_groups: [{ keep_ref: 'F999', duplicate_refs: [payload[0].ref], reason: 'x' }],
          severity_elevations: [], systemic_findings: [], quick_fix_warnings: [], summary: 'bad',
        };
      },
    );
    assert.equal(result.result._executionMeta?.reduceStatus, ReduceStatus.PARSE_ERROR);
    const findings = result.result.findings;
    assert.equal(findings.length, 2, 'both raw MAP findings preserved');
    assertSurvived(findings.find(f => f.section === 'unit0.mjs:1'), a);
    assertSurvived(findings.find(f => f.section === 'unit1.mjs:1'), b);
  });

  it('an old-shape PassFindingsSchema answer fails the decision schema -> parse_error, raw findings kept', async () => {
    const a = FULL({ section: 'unit0.mjs:1' });
    const b = FULL({ section: 'unit1.mjs:1', category: 'Other' });
    const result = await run((i) => [structuredClone(i === 0 ? a : b)], echoOld);
    assert.equal(result.result._executionMeta?.reduceStatus, ReduceStatus.PARSE_ERROR);
    assertSurvived(result.result.findings.find(f => f.section === 'unit0.mjs:1'), a);
  });

  it('two unmerged findings sharing category|section|detail collapse LOSSLESSLY: one _hash, the other kept whole', async () => {
    const a = FULL({ section: 'shared.mjs:1', recommendation: 'Fix it one way.' });
    const b = FULL({ section: 'shared.mjs:1', recommendation: 'Fix it another way.',
      classification: { sonarType: 'CODE_SMELL', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'test-stub' } });
    const result = await run(
      (i) => [structuredClone(i === 0 ? a : b)],
      (payload, params) => (asksForDecisions(params)
        ? { pass_name: 'mrtest', merge_groups: [], severity_elevations: [], systemic_findings: [], quick_fix_warnings: [], summary: 'none' }
        : echoOld(payload)),
    );
    assert.equal(result.result._executionMeta?.reduceStatus, undefined);
    const findings = result.result.findings;
    assert.equal(findings.length, 1, 'one identity, one output finding — no _hash collision downstream');
    const recs = [findings[0].recommendation, ...findings[0]._reduce.mergedFrom.map(m => m.finding.recommendation)].sort();
    assert.deepEqual(recs, ['Fix it another way.', 'Fix it one way.'], 'neither remedy is lost');
    assert.equal(findings[0]._reduce.mergedFrom[0].reason, 'identical-identity');
  });

  it('the failure path preserves identical-identity findings losslessly too (unknown ref)', async () => {
    const a = FULL({ section: 'shared.mjs:1', recommendation: 'Fix it one way.' });
    const b = FULL({ section: 'shared.mjs:1', recommendation: 'Fix it another way.' });
    const result = await run(
      (i) => [structuredClone(i === 0 ? a : b)],
      (payload, params) => (asksForDecisions(params)
        ? { pass_name: 'mrtest', merge_groups: [], severity_elevations: [{ ref: 'F42', severity: 'HIGH', reason: 'x' }], systemic_findings: [], quick_fix_warnings: [], summary: 'bad' }
        : echoOld(payload)),
    );
    assert.equal(result.result._executionMeta?.reduceStatus, ReduceStatus.PARSE_ERROR);
    const [only] = result.result.findings;
    const recs = [only.recommendation, ...only._reduce.mergedFrom.map(m => m.finding.recommendation)].sort();
    assert.deepEqual(recs, ['Fix it another way.', 'Fix it one way.']);
  });

  it('identical-identity twins collapse BEFORE REDUCE, so a systemic finding inherits the twin\'s gating tags', async () => {
    const nitSrc = FULL({ id: 'H1', section: 'shared.mjs:1', importance: 'nit', is_quick_fix: false });
    const twin = FULL({ id: 'H2', section: 'shared.mjs:1', importance: 'important', is_quick_fix: true, recommendation: 'band-aid' });
    const other = FULL({ id: 'M1', severity: 'MEDIUM', section: 'other.mjs:1', category: 'Other', importance: 'nit', is_quick_fix: false });
    let seen = null;
    const result = await run(
      (i) => (i === 0 ? [structuredClone(nitSrc)] : [structuredClone(twin), structuredClone(other)]),
      (payload, params) => {
        if (!asksForDecisions(params)) return echoOld(payload);
        seen = payload;
        const shared = payload.find(p => p.section === 'shared.mjs:1').ref;
        const o = payload.find(p => p.section === 'other.mjs:1').ref;
        return {
          pass_name: 'mrtest', merge_groups: [], severity_elevations: [],
          systemic_findings: [{ source_refs: [shared, o], severity: 'HIGH', category: 'c', section: 's',
            detail: 'd', risk: 'r', recommendation: 'rec', is_quick_fix: false, principle: 'p' }],
          quick_fix_warnings: [], summary: 's',
        };
      },
    );
    assert.equal(seen.filter(p => p.section === 'shared.mjs:1').length, 1, 'REDUCE sees one ref per identity');
    const sys = result.result.findings.find(f => f._reduce?.systemic);
    assert.ok(sys, 'systemic finding applied');
    assert.equal(sys.importance, 'important');
    assert.equal(sys.is_quick_fix, true);
  });

  it('a REDUCE merge into a collapsed survivor APPENDS provenance: the twin and the duplicate both stay whole', async () => {
    const a1 = FULL({ id: 'H1', section: 'shared.mjs:1', recommendation: 'twin one' });
    const a2 = FULL({ id: 'H2', section: 'shared.mjs:1', recommendation: 'twin two' });
    const b = FULL({ id: 'H3', section: 'b.mjs:1', category: 'Other', recommendation: 'dup' });
    const result = await run(
      (i) => (i === 0 ? [structuredClone(a1)] : [structuredClone(a2), structuredClone(b)]),
      (payload, params) => {
        if (!asksForDecisions(params)) return echoOld(payload);
        const keep = payload.find(p => p.section === 'shared.mjs:1').ref;
        const dup = payload.find(p => p.section === 'b.mjs:1').ref;
        return { pass_name: 'mrtest', merge_groups: [{ keep_ref: keep, duplicate_refs: [dup], reason: 'same' }],
          severity_elevations: [], systemic_findings: [], quick_fix_warnings: [], summary: 's' };
      },
    );
    const [only] = result.result.findings;
    assert.equal(result.result.findings.length, 1);
    const kept = [only, ...only._reduce.mergedFrom.map(m => m.finding)].map(f => f.recommendation).sort();
    assert.deepEqual(kept, ['dup', 'twin one', 'twin two'], 'nothing merged is lost');
    assert.deepEqual(only._reduce.mergedFrom.map(m => m.reason).sort(), ['identical-identity', 'reduce-merge']);
  });

  it('a collapsed survivor speaks for its twins\' units: a cross-unit pattern is not rejected as single-unit', async () => {
    // Unit 0 reports A and B; unit 1 reports only A. A collapses onto unit 0's copy,
    // but its twin's unit still counts, so a systemic finding over A + B spans 2 units.
    const a = FULL({ id: 'H1', section: 'shared.mjs:1' });
    const bFinding = FULL({ id: 'M1', severity: 'MEDIUM', section: 'b.mjs:1', category: 'Other' });
    let seen = null;
    const result = await run(
      (i) => (i === 0 ? [structuredClone(a), structuredClone(bFinding)] : [structuredClone(a)]),
      (payload, params) => {
        if (!asksForDecisions(params)) return echoOld(payload);
        seen = payload;
        return { pass_name: 'mrtest', merge_groups: [], severity_elevations: [],
          systemic_findings: [{ source_refs: payload.map(p => p.ref), severity: 'HIGH', category: 'c', section: 's',
            detail: 'd', risk: 'r', recommendation: 'rec', is_quick_fix: false, principle: 'p' }],
          quick_fix_warnings: [], summary: 's' };
      },
    );
    assert.deepEqual(seen.find(p => p.section === 'shared.mjs:1')._mapUnits, [0, 1], 'the view names both units');
    assert.equal(result.result._executionMeta?.reduceStatus, undefined, 'accepted, not a violation');
    assert.ok(result.result.findings.some(f => f._reduce?.systemic));
  });

  it('a systemic finding is added and its sources stay; elevation raises severity only', async () => {
    const a = FULL({ id: 'M1', severity: 'MEDIUM', section: 'unit0.mjs:1' });
    const b = FULL({ id: 'M1', severity: 'MEDIUM', section: 'unit1.mjs:1', category: 'Other' });
    const result = await run(
      (i) => [structuredClone(i === 0 ? a : b)],
      (payload, params) => {
        if (!asksForDecisions(params)) return echoOld(payload);
        const [r0, r1] = payload.map(p => p.ref);
        return {
          pass_name: 'mrtest', merge_groups: [],
          severity_elevations: [{ ref: r0, severity: 'HIGH', reason: 'pattern' }],
          systemic_findings: [{ source_refs: [r0, r1], severity: 'HIGH', category: 'Error handling', section: 'unit0.mjs, unit1.mjs',
            detail: 'Both units swallow errors.', risk: 'r', recommendation: 'rec', is_quick_fix: false, principle: 'p' }],
          quick_fix_warnings: [], summary: 'systemic',
        };
      },
    );
    const findings = result.result.findings;
    assert.equal(findings.length, 3, 'two sources + one systemic');
    const sys = findings.find(f => f._reduce?.systemic);
    assert.equal(sys.category, '[SYSTEMIC] Error handling');
    assert.equal(sys.classification.sourceKind, 'MODEL');
    assert.notEqual(sys.classification.sourceName, 'test-stub', 'the producer is the REDUCE model, not a source');
    assert.equal(sys.id, 'S1');
    const elevatedOut = findings.find(f => f.section === 'unit0.mjs:1');
    assert.equal(elevatedOut.severity, 'HIGH');
    assert.equal(elevatedOut._reduce.severityFrom, 'MEDIUM');
    const { severity: _s, ...restA } = a;
    assertSurvived(elevatedOut, restA);
    assertSurvived(findings.find(f => f.section === 'unit1.mjs:1'), b);
  });
});

// ── Pure applier + payload ──────────────────────────────────────────────────

const { buildReducePayload, applyReduceDecisions, REDUCE_VIEW_TRUNCATION_MARKER } = await import('../scripts/lib/robustness.mjs');

function payloadOf(findings, budget) {
  return buildReducePayload(findings, budget);
}
const decide = (o = {}) => ({ merge_groups: [], severity_elevations: [], systemic_findings: [], ...o });

describe('buildReducePayload — view only, never the output', () => {
  it('sends the full detail (no 200-char cut) and assigns refs in severity order', () => {
    const p = payloadOf([FULL({ id: 'L1', severity: 'LOW', _mapUnit: 0 }), FULL({ id: 'H1', _mapUnit: 1 })]);
    const view = JSON.parse(p.json);
    assert.deepEqual(view.map(v => [v.ref, v.id]), [['F1', 'H1'], ['F2', 'L1']]);
    assert.equal(view[0].detail, LONG_DETAIL);
    assert.equal(p.refToFinding.get('F1').id, 'H1');
  });

  it('over budget: tail findings are excluded from the view and returned for pass-through', () => {
    const fs3 = [FULL({ id: 'H1', _mapUnit: 0 }), FULL({ id: 'L1', severity: 'LOW', _mapUnit: 1 }), FULL({ id: 'L2', severity: 'LOW', _mapUnit: 2 })];
    const p = payloadOf(fs3, 1200);
    assert.ok(p.json.length <= 1200);
    assert.ok(p.includedCount < 3);
    assert.equal(p.excludedFindings.length, 3 - p.includedCount);
    const r = applyReduceDecisions(decide(), p);
    assert.equal(r.ok, true);
    assert.equal(r.findings.length, 3, 'nothing vanishes');
    for (const f of r.findings.filter(x => x._reduce?.excluded)) assert.equal(f._reduce.excluded, 'budget');
    assert.equal(r.stats.excluded, p.excludedFindings.length);
  });

  it('a lone oversized finding gets a MARKED view cut; the output keeps the full detail', () => {
    const big = FULL({ detail: 'x'.repeat(600), _mapUnit: 0 });
    const p = payloadOf([big], 500);
    assert.equal(p.degraded, false);
    assert.ok(p.json.length <= 500);
    assert.ok(JSON.parse(p.json)[0].detail.endsWith(REDUCE_VIEW_TRUNCATION_MARKER));
    assert.deepEqual(p.truncatedViewRefs, ['F1']);
    assert.equal(applyReduceDecisions(decide(), p).findings[0].detail, 'x'.repeat(600));
  });

  it('an escape-heavy detail (every char doubles in JSON) is still cut to fit, not degraded', () => {
    const quotes = FULL({ detail: '"'.repeat(2000), _mapUnit: 0 });
    const p = payloadOf([quotes], 1500);
    assert.equal(p.degraded, false);
    assert.ok(p.json.length <= 1500);
    const cutDetail = JSON.parse(p.json)[0].detail;
    assert.ok(cutDetail.endsWith(REDUCE_VIEW_TRUNCATION_MARKER));
    // Largest fitting prefix: one more character would not fit.
    const prefix = cutDetail.length - REDUCE_VIEW_TRUNCATION_MARKER.length;
    const view = JSON.parse(p.json)[0];
    const longer = JSON.stringify([{ ...view, detail: '"'.repeat(prefix + 1) + REDUCE_VIEW_TRUNCATION_MARKER }], null, 2);
    assert.ok(longer.length > 1500);
  });

  it('the view carries recommendation, so REDUCE can tell two remedies apart', () => {
    const p = payloadOf([FULL({ _mapUnit: 0 })]);
    assert.equal(JSON.parse(p.json)[0].recommendation, FULL().recommendation);
  });

  it('a large oversized set is cut to the longest fitting prefix (binary search), in severity order', () => {
    const many = Array.from({ length: 3000 }, (_, i) => FULL({ id: `L${i}`, severity: i < 10 ? 'HIGH' : 'LOW', _mapUnit: i % 7, section: `f${i}` }));
    const t0 = Date.now();
    const p = payloadOf(many, 20_000);
    assert.ok(Date.now() - t0 < 5000, 'bounded work');
    assert.ok(p.json.length <= 20_000);
    const view = JSON.parse(p.json);
    assert.equal(view.length, p.includedCount);
    assert.ok(view.slice(0, Math.min(10, view.length)).every(v => v.severity === 'HIGH'), 'HIGH findings are kept first');
    // Longest prefix: adding the next view would not fit.
    const next = JSON.stringify([...view, { ...view[0], ref: 'Fx' }], null, 2);
    assert.ok(next.length > 20_000);
    assert.equal(p.excludedFindings.length, 3000 - p.includedCount);
  });

  it('an impossible budget is degraded and every finding is returned as excluded', () => {
    const p = payloadOf([FULL({ _mapUnit: 0 })], 10);
    assert.equal(p.degraded, true);
    assert.equal(p.includedCount, 0);
    assert.equal(p.excludedFindings.length, 1);
  });
});

describe('collapseIdenticalFindings — lossless, never demotes', async () => {
  const { collapseIdenticalFindings } = await import('../scripts/lib/robustness.mjs');
  const { semanticId } = await import('../scripts/lib/findings.mjs');
  it('a nit sorting first still surfaces as important when an identical important finding collapses into it', () => {
    const nit = FULL({ id: 'H1', importance: 'nit', recommendation: 'one' });
    const imp = FULL({ id: 'H2', importance: 'important', recommendation: 'two' });
    const [only, ...rest] = collapseIdenticalFindings([nit, imp], semanticId);
    assert.equal(rest.length, 0);
    assert.equal(only.id, 'H1', 'id order decides the survivor');
    assert.equal(only.importance, 'important');
    assert.equal(only._reduce.importanceFrom, 'nit');
    assert.equal(only._reduce.mergedFrom[0].finding, imp, 'kept whole');
    assert.equal(nit.importance, 'nit', 'inputs are not mutated');
  });

  it('a quick-fix twin flags the collapsed survivor', () => {
    const clean = FULL({ id: 'H1', is_quick_fix: false, recommendation: 'one' });
    const bandaid = FULL({ id: 'H2', is_quick_fix: true, recommendation: 'two' });
    const [only] = collapseIdenticalFindings([clean, bandaid], semanticId);
    assert.equal(only.is_quick_fix, true);
    assert.equal(only._reduce.quickFixFrom, false);
  });
});

describe('applyReduceDecisions — all-or-nothing contract', () => {
  const two = () => payloadOf([FULL({ id: 'H1', _mapUnit: 0 }), FULL({ id: 'M1', severity: 'MEDIUM', _mapUnit: 1, section: 'b' })]);
  const sys = (refs, o = {}) => ({ source_refs: refs, severity: 'HIGH', category: 'c', section: 's', detail: 'd', risk: 'r', recommendation: 'rec', is_quick_fix: false, principle: 'p', ...o });
  const violation = (p, d, re) => {
    const r = applyReduceDecisions(d, p);
    assert.equal(r.ok, false, 'must be rejected');
    assert.ok(r.violations.some(v => re.test(v)), `expected a violation matching ${re}, got ${JSON.stringify(r.violations)}`);
  };

  it('rejects an unknown ref anywhere', () => {
    violation(two(), decide({ severity_elevations: [{ ref: 'F9', severity: 'HIGH', reason: 'x' }] }), /unknown ref "F9"/);
  });
  it('rejects a lowering', () => {
    violation(two(), decide({ severity_elevations: [{ ref: 'F1', severity: 'LOW', reason: 'x' }] }), /lowered HIGH -> LOW/);
  });
  it('rejects a ref used in two merge groups', () => {
    const p = payloadOf([FULL({ _mapUnit: 0 }), FULL({ _mapUnit: 1, section: 'b' }), FULL({ _mapUnit: 2, section: 'c' })]);
    violation(p, decide({ merge_groups: [
      { keep_ref: 'F1', duplicate_refs: ['F2'], reason: 'x' },
      { keep_ref: 'F3', duplicate_refs: ['F2'], reason: 'y' },
    ] }), /F2 is already used/);
  });
  it('rejects an empty merge and a keep_ref listed as its own duplicate', () => {
    violation(two(), decide({ merge_groups: [{ keep_ref: 'F1', duplicate_refs: [], reason: 'x' }] }), /duplicate_refs is empty/);
    violation(two(), decide({ merge_groups: [{ keep_ref: 'F1', duplicate_refs: ['F1'], reason: 'x' }] }), /own duplicate/);
  });
  it('rejects elevating a merged-away ref', () => {
    violation(two(), decide({
      merge_groups: [{ keep_ref: 'F1', duplicate_refs: ['F2'], reason: 'x' }],
      severity_elevations: [{ ref: 'F2', severity: 'HIGH', reason: 'x' }],
    }), /merged away/);
  });
  it('rejects a systemic finding with a repeated ref, or with sources from one unit', () => {
    violation(two(), decide({ systemic_findings: [sys(['F1', 'F1'])] }), /repeats a ref/);
    const sameUnit = payloadOf([FULL({ _mapUnit: 0 }), FULL({ _mapUnit: 0, section: 'b' })]);
    violation(sameUnit, decide({ systemic_findings: [sys(['F1', 'F2'])] }), /one MAP unit/);
  });
  it('applies nothing when any decision is bad', () => {
    const r = applyReduceDecisions(decide({
      merge_groups: [{ keep_ref: 'F1', duplicate_refs: ['F2'], reason: 'fine' }],
      severity_elevations: [{ ref: 'F7', severity: 'HIGH', reason: 'bad' }],
    }), two());
    assert.equal(r.ok, false);
    assert.equal(r.findings, undefined);
  });

  it('a merge keeps the kept MAP object, takes the group max severity and records provenance', () => {
    const p = payloadOf([FULL({ id: 'M1', severity: 'MEDIUM', _mapUnit: 0 }), FULL({ id: 'H1', _mapUnit: 1, section: 'b' })]);
    // F1 = H1 (HIGH sorts first), F2 = M1
    const r = applyReduceDecisions(decide({ merge_groups: [{ keep_ref: 'F2', duplicate_refs: ['F1'], reason: 'same' }] }), p);
    assert.equal(r.ok, true);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].id, 'M1');
    assert.equal(r.findings[0].severity, 'HIGH');
    assert.equal(r.findings[0]._reduce.mergedFrom.length, 1);
    assert.equal(r.findings[0]._reduce.mergedFrom[0].ref, 'F1');
    assert.equal(r.findings[0]._reduce.mergedFrom[0].finding, p.refToFinding.get('F1'), 'the duplicate is kept whole');
    assert.equal(r.findings[0].detail, LONG_DETAIL);
  });

  it('an untouched finding is the SAME object (nothing copied, nothing rewritten)', () => {
    const p = two();
    const r = applyReduceDecisions(decide(), p);
    assert.equal(r.findings[0], p.refToFinding.get('F1'));
  });

  it('systemic construction: unique S id, effort max, classification from the highest-severity CLASSIFIED source', () => {
    const p = payloadOf([
      FULL({ id: 'H1', _mapUnit: 0, classification: undefined, importance: 'nit' }),
      FULL({ id: 'S1', severity: 'MEDIUM', _mapUnit: 1, section: 'b', importance: 'nit',
        classification: { sonarType: 'CODE_SMELL', effort: 'EASY', sourceKind: 'LINTER', sourceName: 'eslint' } }),
      FULL({ id: 'L1', severity: 'LOW', _mapUnit: 2, section: 'c', importance: 'important',
        classification: { sonarType: 'BUG', effort: 'MAJOR', sourceKind: 'MODEL', sourceName: 'gpt' } }),
    ]);
    const r = applyReduceDecisions(decide({ systemic_findings: [sys(['F1', 'F2', 'F3'])] }), p, { reducerName: 'gpt-reduce' });
    assert.equal(r.ok, true);
    const s = r.findings.find(f => f._reduce?.systemic);
    assert.equal(s.id, 'S2', 'S1 is taken by a MAP finding in this pass');
    assert.deepEqual(s.classification, { sonarType: 'CODE_SMELL', effort: 'MAJOR', sourceKind: 'MODEL', sourceName: 'gpt-reduce' },
      'sonarType + effort are inherited; the producer is the REDUCE model, never a source tool');
    assert.equal(s._reduce.classificationDerivedFrom.ref, 'F2', 'H1 is unclassified, so the MEDIUM classified source is primary');
    assert.equal(s._reduce.classificationDerivedFrom.id, 'S1');
    assert.equal(s.importance, 'important');
    assert.equal(s.is_quick_fix, false, 'no source is a band-aid');
    assert.equal(s.is_mechanical, false);
    assert.equal(r.findings.length, 4, 'all three sources stay');
  });

  it('REDUCE may RAISE a systemic is_quick_fix over clean sources, never clear one', () => {
    const p = payloadOf([FULL({ _mapUnit: 0 }), FULL({ _mapUnit: 1, section: 'b' })]);
    const r = applyReduceDecisions(decide({ systemic_findings: [sys(['F1', 'F2'], { is_quick_fix: true })] }), p);
    assert.equal(r.findings.find(f => f._reduce?.systemic).is_quick_fix, true);
  });

  it('rejects a systemic finding whose source is merged away in the same answer', () => {
    const p = payloadOf([FULL({ _mapUnit: 0 }), FULL({ _mapUnit: 1, section: 'b' }), FULL({ _mapUnit: 2, section: 'c' })]);
    violation(p, decide({
      merge_groups: [{ keep_ref: 'F1', duplicate_refs: ['F2'], reason: 'x' }],
      systemic_findings: [sys(['F2', 'F3'])],
    }), /merged away; a systemic finding's instances must stay/);
  });

  it('a merge never demotes importance: an important duplicate promotes a nit survivor', () => {
    const p = payloadOf([FULL({ id: 'H1', _mapUnit: 0, importance: 'nit' }), FULL({ id: 'H2', _mapUnit: 1, section: 'b', importance: 'important' })]);
    const r = applyReduceDecisions(decide({ merge_groups: [{ keep_ref: 'F1', duplicate_refs: ['F2'], reason: 'same' }] }), p);
    assert.equal(r.findings[0].importance, 'important');
    assert.equal(r.findings[0]._reduce.importanceFrom, 'nit');
  });

  it('a merge never hides a quick fix: a true duplicate flags the survivor', () => {
    const p = payloadOf([FULL({ id: 'H1', _mapUnit: 0, is_quick_fix: false }), FULL({ id: 'H2', _mapUnit: 1, section: 'b', is_quick_fix: true })]);
    const r = applyReduceDecisions(decide({ merge_groups: [{ keep_ref: 'F1', duplicate_refs: ['F2'], reason: 'same' }] }), p);
    assert.equal(r.findings[0].is_quick_fix, true);
    assert.equal(r.findings[0]._reduce.quickFixFrom, false);
  });

  it('systemic tags read the post-merge group: an important or quick-fix duplicate of a source counts', () => {
    const p = payloadOf([
      FULL({ id: 'H1', _mapUnit: 0, importance: 'nit', is_quick_fix: false }),
      FULL({ id: 'H2', _mapUnit: 1, section: 'b', importance: 'important', is_quick_fix: true }),
      FULL({ id: 'H3', _mapUnit: 2, section: 'c', importance: 'nit', is_quick_fix: false }),
    ]);
    const r = applyReduceDecisions(decide({
      merge_groups: [{ keep_ref: 'F1', duplicate_refs: ['F2'], reason: 'same' }],
      systemic_findings: [sys(['F1', 'F3'])],
    }), p);
    assert.equal(r.ok, true);
    const s = r.findings.find(f => f._reduce?.systemic);
    assert.equal(s.importance, 'important');
    assert.equal(s.is_quick_fix, true);
  });

  it('a systemic pattern over a quick-fix source is itself flagged a quick fix', () => {
    const p = payloadOf([FULL({ _mapUnit: 0, is_quick_fix: true }), FULL({ _mapUnit: 1, section: 'b' })]);
    const r = applyReduceDecisions(decide({ systemic_findings: [sys(['F1', 'F2'])] }), p);
    assert.equal(r.findings.find(f => f._reduce?.systemic).is_quick_fix, true);
  });

  it('a duplicate merged into a cited source counts toward the span AND supplies a missing classification', () => {
    // F1, F2 from unit 0; F3 (unit 1, classified) is merged into F1. Systemic over F1 + F2.
    const p = payloadOf([
      FULL({ id: 'H1', _mapUnit: 0, section: 'a', classification: undefined }),
      FULL({ id: 'H2', _mapUnit: 0, section: 'b', classification: undefined }),
      FULL({ id: 'H3', _mapUnit: 1, section: 'c', classification: { sonarType: 'BUG', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'x' } }),
    ]);
    const r = applyReduceDecisions(decide({
      merge_groups: [{ keep_ref: 'F1', duplicate_refs: ['F3'], reason: 'same' }],
      systemic_findings: [sys(['F1', 'F2'])],
    }), p, { reducerName: 'gpt-reduce' });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    const s = r.findings.find(f => f._reduce?.systemic);
    assert.equal(s.classification.sonarType, 'BUG');
    assert.deepEqual(s._reduce.classificationDerivedFrom, { ref: 'F1', id: 'H3', _mapUnit: 1 });
  });

  it('a classified twin hidden by the pre-REDUCE collapse supplies the classification', async () => {
    const { collapseIdenticalFindings } = await import('../scripts/lib/robustness.mjs');
    const { semanticId } = await import('../scripts/lib/findings.mjs');
    const collapsed = collapseIdenticalFindings([
      FULL({ id: 'H1', _mapUnit: 0, section: 'a', classification: undefined }),
      FULL({ id: 'H2', _mapUnit: 1, section: 'a', classification: { sonarType: 'VULNERABILITY', effort: 'MAJOR', sourceKind: 'MODEL', sourceName: 'x' } }),
      FULL({ id: 'M1', severity: 'MEDIUM', _mapUnit: 0, section: 'b', classification: undefined }),
    ], semanticId);
    const p = payloadOf(collapsed);
    const r = applyReduceDecisions(decide({ systemic_findings: [sys(['F1', 'F2'])] }), p);
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.equal(r.findings.find(f => f._reduce?.systemic).classification.sonarType, 'VULNERABILITY');
  });

  it('systemic classification is null when no source has one', () => {
    const p = payloadOf([FULL({ _mapUnit: 0, classification: undefined }), FULL({ _mapUnit: 1, section: 'b', classification: undefined })]);
    const r = applyReduceDecisions(decide({ systemic_findings: [sys(['F1', 'F2'])] }), p);
    assert.equal(r.findings.find(f => f._reduce?.systemic).classification, null);
  });
});

// ── Prompt ↔ EMITTED schema ─────────────────────────────────────────────────

describe('REDUCE prompt names only fields the emitted decision schema can carry', async () => {
  const { z } = await import('zod');
  const { zodTextFormat } = await import('openai/helpers/zod');
  const { ReduceDecisionSchema } = await import('../scripts/lib/audit/map-reduce-scheduler.mjs');
  const { REDUCE_SYSTEM_PROMPT } = await import('../scripts/lib/code-analysis.mjs');
  const emitted = z.toJSONSchema(ReduceDecisionSchema);
  const itemOf = (key) => emitted.properties[key].items;

  it('every top-level decision list the prompt names is a required property', () => {
    for (const key of ['merge_groups', 'severity_elevations', 'systemic_findings']) {
      assert.ok(REDUCE_SYSTEM_PROMPT.includes(key), `prompt names ${key}`);
      assert.ok(emitted.properties[key], `${key} is an emitted property`);
      assert.ok(emitted.required.includes(key), `${key} is required`);
    }
  });

  it('every per-item field the prompt names is an emitted, required item property', () => {
    const named = {
      merge_groups: ['keep_ref', 'duplicate_refs'],
      severity_elevations: ['ref', 'severity'],
      systemic_findings: ['source_refs', 'category', 'section', 'detail', 'risk', 'recommendation', 'is_quick_fix', 'principle'],
    };
    for (const [list, fields] of Object.entries(named)) {
      for (const field of fields) {
        assert.ok(REDUCE_SYSTEM_PROMPT.includes(field), `prompt names ${field}`);
        assert.ok(itemOf(list).properties[field], `${list}[].${field} is emitted`);
        assert.ok(itemOf(list).required.includes(field), `${list}[].${field} is required`);
      }
    }
  });

  it('the prompt no longer asks REDUCE to preserve a field it is never shown', () => {
    assert.equal(/PRESERVE the `classification`/.test(REDUCE_SYSTEM_PROMPT), false);
  });

  it('converts through the provider handoff the scheduler actually makes', () => {
    assert.doesNotThrow(() => zodTextFormat(ReduceDecisionSchema, 'reduce_test'));
  });
});
