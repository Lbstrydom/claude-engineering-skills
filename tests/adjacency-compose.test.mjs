/**
 * @fileoverview Tier-1 tests for the adjacency report + composer.
 * Plan: docs/plans/adjacency-check-containment.md §D5 / §D9a (Cluster C, Phase 5).
 *
 * The load-bearing pins here are the ones the plan audit extracted before any
 * code existed:
 *   - R2-H2: incompleteness produced AFTER the detector returned (formatting,
 *     bouncer) must still reach the result and forbid `clean`.
 *   - Round-2 H4 (duplication lineage): the model must not be able to author
 *     the convergence flag.
 *   - R3-H2: no raw unsafe excerpt may reach the composed result / cache / --out.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { composeAdjacencyResult } from '../scripts/lib/audit/adjacency-compose.mjs';
import {
  formatCandidatesForPrompt,
  runAdjacencyBouncer,
  mapDecisionsToFindings,
  deriveFindingsFromAdjacencyReport,
  buildAdjacencyIncompleteFinding,
  buildAdjacencyFailedFinding,
  _resetAdjacencyIdCounter,
} from '../scripts/lib/audit/adjacency-report.mjs';
import { ADJACENCY_STATES, INCOMPLETENESS_KINDS } from '../scripts/lib/audit/adjacency-state.mjs';

const BOUNDS = { maxCandidateChars: 8000, maxPromptChars: 60000, maxCandidates: 25 };

const ev = (id = 'e1', over = {}) => ({
  id,
  canonicalPath: 'scripts/lib/x.mjs',
  egressClassification: { category: null },
  span: { startLine: 10, endLine: 12 },
  conditionSpan: { startLine: 5, endLine: 5 },
  containerLine: 5,
  payload: { safe: true, statementText: 'doWork(outerThing);', conditionText: 'ledger.entries.length > 0' },
  dependence: 'independent',
  ...over,
});

const facts = (over = {}) => ({
  coverage: { containersEnumerated: 2, statementsJudged: 9 },
  candidates: [],
  incompleteness: [],
  threw: null,
  ...over,
});

beforeEach(() => _resetAdjacencyIdCounter());

describe('R2-H2 PIN: late-stage incompleteness reaches the result', () => {
  test('FORMATTING-stage incompleteness forbids clean', () => {
    // The precise staleness bug: this record is produced after the detector
    // returned, so a state computed inside the detector could never see it.
    const composed = composeAdjacencyResult({
      analysis: facts(),
      bouncer: {
        ok: true,
        decisions: [],
        includedIds: [],
        incompleteness: [{ kind: INCOMPLETENESS_KINDS.EXCERPT_UNRESOLVABLE, scope: 'a.mjs', detail: 'too big' }],
      },
    });
    assert.notEqual(composed.result.state, ADJACENCY_STATES.CLEAN);
    assert.equal(composed.result.incompleteness.length, 1);
    assert.equal(composed.findings.length, 1, 'the incompleteness must emit its own control finding');
  });

  test('BOUNCER failure is itself a coverage fact', () => {
    const composed = composeAdjacencyResult({
      analysis: facts(),
      bouncer: { ok: false, reason: 'timeout', includedIds: ['e1'], incompleteness: [] },
    });
    assert.notEqual(composed.result.state, ADJACENCY_STATES.CLEAN);
    assert.ok(composed.result.incompleteness.some((i) => i.kind === 'bouncer-degraded'));
  });

  test('candidates AND late incompleteness → BOTH emit findings', () => {
    const composed = composeAdjacencyResult({
      analysis: facts({ candidates: [ev('e1')] }),
      bouncer: {
        ok: true,
        decisions: [{ candidateId: 'e1', decision: 'keep', severity: 'HIGH', rationale: 'consumer outside reads it' }],
        includedIds: ['e1'],
        incompleteness: [{ kind: INCOMPLETENESS_KINDS.ENUMERATION_BOUND, scope: 'b.mjs', detail: 'cap' }],
      },
    });
    const cats = composed.findings.map((f) => f.category);
    assert.ok(cats.some((c) => c.includes('trapped')), 'the real finding must survive');
    assert.ok(cats.some((c) => c.includes('coverage incomplete')), 'the coverage gap must also be reported');
  });

  test('a genuinely clean run emits NO findings — with real coverage behind it', () => {
    // MIRROR: without this the suite could pass by always emitting something.
    const composed = composeAdjacencyResult({ analysis: facts() });
    assert.equal(composed.result.state, ADJACENCY_STATES.CLEAN);
    assert.equal(composed.findings.length, 0);
    assert.ok(composed.result.coverage.containersEnumerated > 0);
  });
});

describe('the model cannot author the convergence flag', () => {
  test('is_quick_fix/is_mechanical are hardcoded, ignoring anything the model sends', () => {
    const rogue = [{
      candidateId: 'e1', decision: 'keep', severity: 'HIGH', rationale: 'x',
      is_quick_fix: false, is_mechanical: false, // a model trying to dodge convergence
    }];
    const mapped = mapDecisionsToFindings(rogue, [ev('e1')], ['e1']);
    assert.ok(mapped.ok);
    assert.equal(mapped.findings[0].is_quick_fix, true);
    assert.equal(mapped.findings[0].is_mechanical, false, 'false only because a rationale was supplied');
  });

  test('completeness violations route the WHOLE set to the fallback', () => {
    const evidence = [ev('e1'), ev('e2')];
    for (const bad of [
      [{ candidateId: 'e1', decision: 'keep', severity: 'MEDIUM', rationale: 'x' }],                    // missing e2
      [{ candidateId: 'e1', decision: 'keep', severity: 'MEDIUM', rationale: 'x' },
       { candidateId: 'e1', decision: 'drop', severity: 'MEDIUM', rationale: 'y' },
       { candidateId: 'e2', decision: 'drop', severity: 'MEDIUM', rationale: 'z' }],                     // duplicate
      [{ candidateId: 'ghost', decision: 'keep', severity: 'MEDIUM', rationale: 'x' }],                  // unknown
    ]) {
      const mapped = mapDecisionsToFindings(bad, evidence, ['e1', 'e2']);
      assert.equal(mapped.ok, false, 'a partial judgement is not a judgement');
    }
  });

  test('G1 PIN: a completeness violation is RECORDED as incompleteness, not just fallen back on', () => {
    // Found by the consolidated Gemini gate. The mapper used to run inside
    // finding-derivation — i.e. AFTER buildAdjacencyState — so a model that
    // omitted a candidate id degraded silently to the deterministic fallback:
    // plausible findings came out, and nothing anywhere recorded that the
    // judgement stage had failed. That is this wave's own defect class.
    const composed = composeAdjacencyResult({
      analysis: facts({ candidates: [ev('e1'), ev('e2')] }),
      bouncer: {
        ok: true, // the CALL succeeded…
        decisions: [{ candidateId: 'e1', decision: 'keep', severity: 'MEDIUM', rationale: 'x' }], // …but e2 is missing
        includedIds: ['e1', 'e2'],
        incompleteness: [],
      },
    });
    const degraded = composed.result.incompleteness.filter((i) => i.kind === 'bouncer-degraded');
    assert.equal(degraded.length, 1, 'the incomplete judgement must be recorded as a coverage fact');
    assert.match(degraded[0].detail, /incomplete judgement/);
    assert.ok(
      composed.findings.some((f) => /coverage incomplete/.test(f.category)),
      'and it must emit a control finding, not just alter which findings are produced',
    );
  });

  test('MIRROR: a COMPLETE bouncer response records no degradation', () => {
    // Without this, the pin above could pass by always recording degradation.
    const composed = composeAdjacencyResult({
      analysis: facts({ candidates: [ev('e1')] }),
      bouncer: {
        ok: true,
        decisions: [{ candidateId: 'e1', decision: 'drop', severity: 'MEDIUM', rationale: 'reports on the branch' }],
        includedIds: ['e1'],
        incompleteness: [],
      },
    });
    assert.equal(composed.result.incompleteness.length, 0);
    assert.equal(composed.result.state, ADJACENCY_STATES.FINDINGS, 'a candidate existed even though it was dropped');
    assert.equal(composed.findings.length, 0, 'a clean drop emits nothing');
  });

  test('a partial bouncer response degrades to the fallback, never to silence', () => {
    const composed = composeAdjacencyResult({
      analysis: facts({ candidates: [ev('e1'), ev('e2')] }),
      bouncer: {
        ok: true,
        decisions: [{ candidateId: 'e1', decision: 'keep', severity: 'MEDIUM', rationale: 'x' }], // e2 missing
        includedIds: ['e1', 'e2'],
        incompleteness: [],
      },
    });
    const candidateFindings = composed.findings.filter((f) => /trapped/.test(f.category));
    assert.equal(candidateFindings.length, 2, 'both candidates fall back to MEDIUM rather than one being dropped');
    for (const f of candidateFindings) assert.equal(f.severity, 'MEDIUM');
    // …and the degradation itself is separately reported (G1) — the fallback is
    // the right BEHAVIOUR, but it must never be the whole story.
    assert.ok(composed.findings.some((f) => /coverage incomplete/.test(f.category)));
  });

  test('the deterministic fallback never emits HIGH', () => {
    for (const f of deriveFindingsFromAdjacencyReport([ev('e1'), ev('e2')], ['e1', 'e2'])) {
      assert.equal(f.severity, 'MEDIUM', 'HIGH requires model judgement');
    }
  });
});

describe('R3-H2 PIN: no unsafe payload leaves the process', () => {
  test('unsafe evidence is never placed in the prompt', () => {
    const unsafe = ev('e1', { payload: { safe: false, reason: 'payload-tripped-egress-scan' } });
    const { prompt, includedIds } = formatCandidatesForPrompt([unsafe], { bounds: BOUNDS });
    assert.equal(includedIds.length, 0);
    assert.equal(prompt, '');
  });

  test('the composed result carries NO raw text for withheld evidence', () => {
    // Deep-scan the serialised result — the shape the pass cache and --out JSON
    // actually persist. Inspecting the formatter would not prove this.
    const secret = 'sk-live-DEADBEEF-not-a-real-key';
    const withheld = ev('e1', { payload: { safe: false, reason: 'payload-tripped-egress-scan' } });
    const composed = composeAdjacencyResult({
      analysis: facts({
        candidates: [withheld],
        incompleteness: [{ kind: INCOMPLETENESS_KINDS.EXCERPT_UNRESOLVABLE, scope: 'a.mjs', detail: 'withheld — content tripped the egress scan' }],
      }),
    });
    const serialised = JSON.stringify(composed);
    assert.ok(!serialised.includes(secret));
    assert.ok(!serialised.includes('statementText'), 'a withheld payload has no text field at all');
    assert.ok(composed.findings.length >= 1, 'refusal stays VISIBLE as a control finding');
  });

  test('a detector-contract violation THROWS rather than silently dropping', () => {
    assert.throws(() => formatCandidatesForPrompt([{ id: 'x' }], { bounds: BOUNDS }), /detector contract violated/);
  });

  test('control findings never carry raw error text', () => {
    const f = buildAdjacencyFailedFinding('ENOENT: /home/user/.ssh/id_rsa not found');
    assert.ok(!JSON.stringify(f).includes('id_rsa'), 'a raw error can carry paths or credentials');
    assert.match(f.detail, /ADJACENCY_DETECTOR_FAILED/);
  });
});

describe('the bouncer never makes a pointless call', () => {
  test('zero eligible candidates → NO model call', async () => {
    let calls = 0;
    const r = await runAdjacencyBouncer(
      [ev('e1', { payload: { safe: false, reason: 'unsafe' } })],
      { bounds: BOUNDS, callLlm: async () => { calls += 1; return { decisions: [] }; } },
    );
    assert.equal(calls, 0, 'an empty prompt is a paid no-op');
    assert.equal(r.ok, true);
    assert.deepEqual(r.decisions, []);
  });

  test('every transport failure maps to ok:false, never a throw', async () => {
    for (const boom of [
      async () => { throw new Error('timeout'); },
      async () => ({ notDecisions: true }),
      async () => null,
    ]) {
      const r = await runAdjacencyBouncer([ev('e1')], { bounds: BOUNDS, callLlm: boom });
      assert.equal(r.ok, false);
      assert.equal(typeof r.reason, 'string');
    }
  });

  test('an over-long response is rejected against the operator bound', async () => {
    const r = await runAdjacencyBouncer([ev('e1')], {
      bounds: { ...BOUNDS, maxCandidates: 1 },
      callLlm: async () => ({ decisions: new Array(5).fill({ candidateId: 'e1', decision: 'drop', severity: 'MEDIUM', rationale: 'x' }) }),
    });
    assert.equal(r.ok, false);
  });

  test('a candidate over the per-candidate budget becomes incompleteness, not a silent drop', () => {
    const huge = ev('e1', { payload: { safe: true, statementText: 'x'.repeat(9000), conditionText: 'c' } });
    const { includedIds, incompleteness } = formatCandidatesForPrompt([huge], { bounds: BOUNDS });
    assert.equal(includedIds.length, 0);
    assert.equal(incompleteness[0].kind, INCOMPLETENESS_KINDS.EXCERPT_UNRESOLVABLE);
  });
});

describe('structural invariants', () => {
  test('THE GREP GUARD: buildAdjacencyState is called from exactly ONE place', () => {
    // What keeps D9a true under future edits. Mirrors the repo's existing
    // `new Anthropic()` migration guard.
    const root = path.join(import.meta.dirname, '..', 'scripts');
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '.claude-skills') walk(p); continue; }
        if (!entry.name.endsWith('.mjs')) continue;
        const src = fs.readFileSync(p, 'utf-8');
        // Count CALLS, not the definition or the import.
        if (/(?<!function\s)\bbuildAdjacencyState\s*\(/.test(src) && !p.endsWith('adjacency-state.mjs')) {
          hits.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    assert.deepEqual(hits, [path.join('lib', 'audit', 'adjacency-compose.mjs')],
      `buildAdjacencyState must be called only by the composer; found: ${hits.join(', ')}`);
  });

  test('THE NO-FS PIN: adjacency-report.mjs performs no filesystem access', () => {
    // "Read once" is a property of the module graph here, not a promise in a
    // docblock. The duplication wave's second read needed a Gemini gate to
    // catch a drifted re-classification; there is no second read to drift here.
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts/lib/audit/adjacency-report.mjs'), 'utf-8');
    assert.ok(!/from ['"]node:fs['"]/.test(src), 'report layer must not import fs');
    assert.ok(!/resolveAndClassify|scanEgressPayload/.test(src), 'egress judgement is a property of the evidence, not recomputed here');
  });

  test('every incompleteness kind maps to a control finding', () => {
    for (const kind of Object.values(INCOMPLETENESS_KINDS)) {
      const f = buildAdjacencyIncompleteFinding({ kind, scope: 'a.mjs', detail: 'd' });
      assert.equal(f.is_quick_fix, true, `${kind} must block convergence`);
      assert.match(f.detail, new RegExp(kind));
    }
  });
});
