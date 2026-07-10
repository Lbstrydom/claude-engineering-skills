/**
 * Tier-1 tests for the V2 evidence contract (tiered-recall pipeline, Cluster A).
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phases 1-2.
 * Covers: V1/V2 schema compatibility (round-1 finding #10), the
 * normalizeFindingEvidence single-normalizer contract, conditional evidence
 * enforcement at the producer boundary, and prompt composition (legacy
 * PASS_PROMPTS byte-stability + V2 contract/obligation injection).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProducerFindingV2Schema,
  PersistedFindingV2Schema,
  PersistedFindingSchema,
  FindingSchema,
  EvidenceAnchorSchema,
  normalizeFindingEvidence,
} from '../scripts/lib/schemas.mjs';
import {
  PASS_PROMPTS,
  EVIDENCE_CONTRACT_BLOCK,
  POSITIVE_OBLIGATIONS_BLOCK,
  buildV2PassPrompt,
} from '../scripts/lib/prompt-seeds.mjs';

const BASE_FINDING = {
  id: 'H1',
  severity: 'HIGH',
  category: 'Transaction Safety',
  section: 'src/services/foo.js',
  detail: 'Multi-step write lacks a transaction boundary.',
  risk: 'Partial writes on failure.',
  recommendation: 'Wrap both writes in one transaction.',
  is_quick_fix: false,
  is_mechanical: false,
  principle: 'Transaction Safety',
};
const CLASSIFICATION = { sonarType: 'BUG', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'test-model' };
const ANCHOR = {
  diffPathId: 'src/services/foo.js',
  oldFile: 'src/services/foo.js',
  newFile: 'src/services/foo.js',
  fileStatus: 'modified',
  side: 'head',
  startLine: 10,
  endLine: 12,
  quote: 'await db.insert(a); await db.insert(b);',
  headSha: 'abc1234',
};

describe('EvidenceAnchorSchema', () => {
  it('accepts a well-formed anchor incl. WORKTREE headSha', () => {
    assert.ok(EvidenceAnchorSchema.safeParse({ ...ANCHOR, headSha: 'WORKTREE' }).success);
  });
  it('rejects an empty quote (content-verification would be vacuous)', () => {
    assert.equal(EvidenceAnchorSchema.safeParse({ ...ANCHOR, quote: '' }).success, false);
  });
  it('rejects startLine > endLine (audit M8)', () => {
    const r = EvidenceAnchorSchema.safeParse({ ...ANCHOR, startLine: 20, endLine: 10 });
    assert.equal(r.success, false);
    assert.ok(r.error.issues.some((i) => i.path.includes('startLine')));
  });
  it('rejects an added file cited on the base side (audit M8 — nothing to cite there)', () => {
    const r = EvidenceAnchorSchema.safeParse({ ...ANCHOR, fileStatus: 'added', side: 'base' });
    assert.equal(r.success, false);
  });
  it('rejects a deleted file cited on the head side (audit M8 — nothing to cite there)', () => {
    const r = EvidenceAnchorSchema.safeParse({ ...ANCHOR, fileStatus: 'deleted', side: 'head' });
    assert.equal(r.success, false);
  });
  it('accepts an added file cited on the head side, and a deleted file on the base side', () => {
    assert.ok(EvidenceAnchorSchema.safeParse({ ...ANCHOR, fileStatus: 'added', side: 'head' }).success);
    assert.ok(EvidenceAnchorSchema.safeParse({ ...ANCHOR, fileStatus: 'deleted', side: 'base' }).success);
  });
  it('rejects renamed/copied with either path missing (audit round-2b finding #H4)', () => {
    assert.equal(EvidenceAnchorSchema.safeParse({ ...ANCHOR, fileStatus: 'renamed', oldFile: null }).success, false);
    assert.equal(EvidenceAnchorSchema.safeParse({ ...ANCHOR, fileStatus: 'copied', newFile: null }).success, false);
  });
  it('rejects added without newFile, and deleted without oldFile', () => {
    assert.equal(EvidenceAnchorSchema.safeParse({ ...ANCHOR, fileStatus: 'added', side: 'head', newFile: null }).success, false);
    assert.equal(EvidenceAnchorSchema.safeParse({ ...ANCHOR, fileStatus: 'deleted', side: 'base', oldFile: null }).success, false);
  });
  it('rejects modified with both paths null', () => {
    assert.equal(EvidenceAnchorSchema.safeParse({ ...ANCHOR, fileStatus: 'modified', oldFile: null, newFile: null }).success, false);
  });
});

describe('ProducerFindingV2Schema — conditional evidence enforcement', () => {
  it('accepts commission with anchor', () => {
    const r = ProducerFindingV2Schema.safeParse({
      ...BASE_FINDING, classification: CLASSIFICATION, evidenceType: 'commission', anchor: ANCHOR,
    });
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  });
  it('rejects commission WITHOUT anchor', () => {
    const r = ProducerFindingV2Schema.safeParse({
      ...BASE_FINDING, classification: CLASSIFICATION, evidenceType: 'commission',
    });
    assert.equal(r.success, false);
    assert.ok(r.error.issues.some((i) => i.path.includes('anchor')));
  });
  it('accepts omission with triggerAnchor + causalChain', () => {
    const r = ProducerFindingV2Schema.safeParse({
      ...BASE_FINDING, classification: CLASSIFICATION, evidenceType: 'omission',
      triggerAnchor: ANCHOR, causalChain: 'schema changed → invalidation obligated → searched cache module → absent',
    });
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  });
  it('rejects omission missing triggerAnchor or causalChain', () => {
    const r = ProducerFindingV2Schema.safeParse({
      ...BASE_FINDING, classification: CLASSIFICATION, evidenceType: 'omission',
    });
    assert.equal(r.success, false);
    const paths = r.error.issues.map((i) => i.path.join('.'));
    assert.ok(paths.includes('triggerAnchor'));
    assert.ok(paths.includes('causalChain'));
  });
  it('rejects a finding with no evidenceType at the V2 producer boundary', () => {
    const r = ProducerFindingV2Schema.safeParse({ ...BASE_FINDING, classification: CLASSIFICATION });
    assert.equal(r.success, false);
  });
});

describe('V1/V2 persisted compatibility (round-1 finding #10)', () => {
  it('a legacy V1 finding (no evidence fields) validates via PersistedFindingV2Schema', () => {
    assert.ok(PersistedFindingV2Schema.safeParse(BASE_FINDING).success);
  });
  it('a V2 finding round-trips through PersistedFindingV2Schema without stripping evidence', () => {
    const r = PersistedFindingV2Schema.safeParse({
      ...BASE_FINDING, evidenceType: 'commission', anchor: ANCHOR,
    });
    assert.ok(r.success);
    assert.equal(r.data.evidenceType, 'commission');
    assert.equal(r.data.anchor.quote, ANCHOR.quote);
  });
  it('the pre-existing PersistedFindingSchema still accepts V1 findings (unchanged)', () => {
    assert.ok(PersistedFindingSchema.safeParse(BASE_FINDING).success);
  });
  it('audit H4 fix: the CANONICAL FindingSchema alias itself accepts V2 evidence without stripping it', () => {
    const r = FindingSchema.safeParse({ ...BASE_FINDING, evidenceType: 'commission', anchor: ANCHOR });
    assert.ok(r.success, JSON.stringify(r.error?.issues));
    assert.equal(r.data.evidenceType, 'commission');
    assert.equal(r.data.anchor.quote, ANCHOR.quote);
  });
  it('PersistedFindingV2Schema and PersistedFindingSchema are the same schema post-fold (no drift risk)', () => {
    assert.equal(PersistedFindingV2Schema, PersistedFindingSchema);
  });
});

describe('normalizeFindingEvidence — the single downstream normalizer', () => {
  it('V1 finding → missing', () => {
    assert.equal(normalizeFindingEvidence(BASE_FINDING).evidenceStatus, 'missing');
  });
  it('commission with anchor → commission', () => {
    const n = normalizeFindingEvidence({ ...BASE_FINDING, evidenceType: 'commission', anchor: ANCHOR });
    assert.equal(n.evidenceStatus, 'commission');
    assert.equal(n.anchor.quote, ANCHOR.quote);
    assert.equal(n.triggerAnchor, null);
  });
  it('omission with triggerAnchor + causalChain → omission', () => {
    const n = normalizeFindingEvidence({
      ...BASE_FINDING, evidenceType: 'omission', triggerAnchor: ANCHOR, causalChain: 'x → y → z → absent',
    });
    assert.equal(n.evidenceStatus, 'omission');
    assert.equal(n.triggerAnchor.quote, ANCHOR.quote);
    assert.equal(n.anchor, null);
  });
  it('MALFORMED V2 (commission, no anchor) degrades to missing — never throws (read-time tolerance)', () => {
    assert.equal(normalizeFindingEvidence({ ...BASE_FINDING, evidenceType: 'commission' }).evidenceStatus, 'missing');
  });
  it('audit H5 fix: a STRUCTURALLY INVALID anchor (start>end) degrades to missing, not truthy-accepted', () => {
    const n = normalizeFindingEvidence({
      ...BASE_FINDING, evidenceType: 'commission', anchor: { ...ANCHOR, startLine: 99, endLine: 1 },
    });
    assert.equal(n.evidenceStatus, 'missing');
  });
  it('audit H5 fix: a triggerAnchor with a side/fileStatus mismatch degrades an omission to missing', () => {
    const n = normalizeFindingEvidence({
      ...BASE_FINDING, evidenceType: 'omission',
      triggerAnchor: { ...ANCHOR, fileStatus: 'deleted', side: 'head' },
      causalChain: 'x → y → z → absent',
    });
    assert.equal(n.evidenceStatus, 'missing');
  });
  it('null / non-object input → missing, never throws', () => {
    assert.equal(normalizeFindingEvidence(null).evidenceStatus, 'missing');
    assert.equal(normalizeFindingEvidence('x').evidenceStatus, 'missing');
  });
});

describe('buildV2PassPrompt — prompt composition (Phases 1-2)', () => {
  it('legacy PASS_PROMPTS stay byte-stable (no evidence-contract text — the live pipeline is unaffected until Cluster D)', () => {
    for (const p of Object.values(PASS_PROMPTS)) {
      assert.ok(!p.includes('Evidence contract'), 'legacy prompt must not carry the V2 contract');
    }
  });
  it('every V2 pass prompt carries the evidence contract', () => {
    for (const pass of ['structure', 'wiring', 'backend', 'frontend', 'sustainability']) {
      assert.ok(buildV2PassPrompt(pass).includes(EVIDENCE_CONTRACT_BLOCK));
    }
  });
  it('positive obligations appear on backend + sustainability ONLY', () => {
    assert.ok(buildV2PassPrompt('backend').includes(POSITIVE_OBLIGATIONS_BLOCK));
    assert.ok(buildV2PassPrompt('sustainability').includes(POSITIVE_OBLIGATIONS_BLOCK));
    for (const pass of ['structure', 'wiring', 'frontend']) {
      assert.ok(!buildV2PassPrompt(pass).includes(POSITIVE_OBLIGATIONS_BLOCK));
    }
  });
  it('unknown pass name still yields a usable prompt with the contract', () => {
    const p = buildV2PassPrompt('nonexistent-pass');
    assert.ok(p.includes('nonexistent-pass'));
    assert.ok(p.includes(EVIDENCE_CONTRACT_BLOCK));
  });
});
