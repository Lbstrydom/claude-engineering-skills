/**
 * Tests for scripts/lib/requirements/context.mjs — getRequirementsContext.
 * Plan: docs/plans/requirements-layer.md — Plan-Phase B (AC9, §9 context).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcile, writeLedger } from '../scripts/lib/requirements/ledger.mjs';
import { getRequirementsContext } from '../scripts/lib/requirements/context.mjs';

/** A RequirementCandidate governing `file`, with a content-unique id. */
function cand(over = {}) {
  const file = over.file || 'src/a.mjs';
  const assertion = over.assertion || 'The value is always validated before use.';
  return {
    id: over.id || `REQ-correctness-${(over.hash || 'aaaaaaaa')}`,
    assertion,
    kind: over.kind || 'correctness',
    checkable: true,
    provenance: [{ file, anchor: 'fn' }],
    appliesTo: over.appliesTo || [],
    evidence: { code: [], tests: [] },
    seenInRuns: over.seenInRuns ?? 2,
    confidence: over.confidence || 'high',
  };
}
const gap = (id, g = 'none', conflictsWith = []) => ({ requirementId: id, gap: g, conflictsWith, rationale: 't' });

/** Build a temp baseDir with a reconciled ledger written to .requirements/. */
function withLedger({ candidates, coveredFiles, gapAssessments = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-ctx-'));
  const ledger = reconcile({ candidates, coveredFiles, gapAssessments });
  writeLedger(ledger, { baseDir: dir });
  return dir;
}

describe('getRequirementsContext — ledger presence', () => {
  it('ledger absent → empty block, degraded:true', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-ctx-'));
    const r = getRequirementsContext({ targetPaths: ['src/a.mjs'], baseDir: dir });
    assert.equal(r.block, '');
    assert.equal(r.degraded, true);
    assert.equal(r.indexCount, 0);
  });

  it('emits the derived index for every requirement', () => {
    const dir = withLedger({
      candidates: [cand({ hash: 'aaaaaaaa' }), cand({ hash: 'bbbbbbbb', file: 'src/b.mjs', assertion: 'A second invariant.' })],
      coveredFiles: ['src/a.mjs', 'src/b.mjs'],
      gapAssessments: [gap('REQ-correctness-aaaaaaaa'), gap('REQ-correctness-bbbbbbbb')],
    });
    const r = getRequirementsContext({ targetPaths: [], baseDir: dir });
    assert.equal(r.indexCount, 2);
    assert.equal(r.degraded, false);
    assert.match(r.block, /<requirements_rubric>/);
  });
});

describe('getRequirementsContext — in-scope computation (audit H3)', () => {
  it('a direct provenance.file match puts the requirement in the enforced rubric', () => {
    const dir = withLedger({
      candidates: [cand({ hash: 'aaaaaaaa' })],
      coveredFiles: ['src/a.mjs'],
      gapAssessments: [gap('REQ-correctness-aaaaaaaa')],
    });
    const r = getRequirementsContext({ targetPaths: ['src/a.mjs'], baseDir: dir });
    assert.equal(r.inScopeCount, 1);
    assert.match(r.block, /In-scope invariants \(enforce\)/);
    assert.match(r.block, /validated before use/);
  });

  it('a non-matching target leaves the requirement in the index only', () => {
    const dir = withLedger({
      candidates: [cand({ hash: 'aaaaaaaa' })],
      coveredFiles: ['src/a.mjs'],
      gapAssessments: [gap('REQ-correctness-aaaaaaaa')],
    });
    const r = getRequirementsContext({ targetPaths: ['src/unrelated.mjs'], baseDir: dir });
    assert.equal(r.inScopeCount, 0);
    assert.match(r.block, /\(none directly in scope\)/);
  });

  it('forward-transitive: a target importing a governed file is in-scope (audit G3)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-ctx-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'governed.mjs'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'src', 'consumer.mjs'), "import { x } from './governed.mjs';\n");
    const ledger = reconcile({
      candidates: [cand({ hash: 'aaaaaaaa', file: 'src/governed.mjs' })],
      coveredFiles: ['src/governed.mjs'],
      gapAssessments: [gap('REQ-correctness-aaaaaaaa')],
    });
    writeLedger(ledger, { baseDir: dir });
    const r = getRequirementsContext({ targetPaths: ['src/consumer.mjs'], baseDir: dir });
    assert.equal(r.inScopeCount, 1, 'requirement reached transitively via import');
  });
});

describe('getRequirementsContext — status gating + coverage', () => {
  it('a needs-review requirement never enters the enforced rubric (audit G1)', () => {
    const dir = withLedger({
      candidates: [cand({ hash: 'aaaaaaaa' })],
      coveredFiles: ['src/a.mjs'],
      gapAssessments: [gap('REQ-correctness-aaaaaaaa', 'contradictory', ['REQ-correctness-bbbbbbbb'])],
    });
    const r = getRequirementsContext({ targetPaths: ['src/a.mjs'], baseDir: dir });
    assert.equal(r.inScopeCount, 0, 'needs-review is not enforced');
    assert.match(r.block, /needs-review/, 'but still visible in the index');
  });

  it('reports uncoveredTargets for files outside coveredFiles (audit R2-H2)', () => {
    const dir = withLedger({
      candidates: [cand({ hash: 'aaaaaaaa' })],
      coveredFiles: ['src/a.mjs'],
      gapAssessments: [gap('REQ-correctness-aaaaaaaa')],
    });
    const r = getRequirementsContext({ targetPaths: ['src/a.mjs', 'src/new.mjs'], baseDir: dir });
    assert.deepEqual(r.uncoveredTargets, ['src/new.mjs']);
    assert.match(r.block, /not yet extracted/);
  });
});

describe('getRequirementsContext — budget degradation (audit L1)', () => {
  it('under budget pressure the index collapses but in-scope full text survives', () => {
    const candidates = [cand({ hash: 'aaaaaaaa' })];
    const gaps = [gap('REQ-correctness-aaaaaaaa')];
    // 12 out-of-scope requirements to bloat the index.
    for (let i = 0; i < 12; i++) {
      const h = String(i).padStart(8, '0');
      candidates.push(cand({ hash: h, file: `src/extra${i}.mjs`, assertion: `Extra invariant number ${i} that is reasonably long to consume tokens.` }));
      gaps.push(gap(`REQ-correctness-${h}`));
    }
    const covered = candidates.map((c) => c.provenance[0].file);
    const dir = withLedger({ candidates, coveredFiles: covered, gapAssessments: gaps });
    const r = getRequirementsContext({ targetPaths: ['src/a.mjs'], baseDir: dir, maxTokens: 120 });
    assert.match(r.block, /validated before use/, 'in-scope full text is never dropped first');
    assert.match(r.block, /summarised — budget/, 'the index collapsed to per-kind summary');
    assert.ok(r.tokensEst <= 120 + 20, 'block respects the budget (± truncation slack)');
  });
});
