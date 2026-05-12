/**
 * @fileoverview Tests for the unified findings post-processing pipeline.
 *   - fingerprint stability (different removers → different fingerprint per R3/H1)
 *   - ledger suppression via exact-fingerprint match
 *   - accept-v1 glob suppression
 *   - returns separate survivors + suppressed lists (no I/O — Gemini-R4/H1)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processFindings, findingFingerprint } from '../scripts/lib/audit/findings-pipeline.mjs';

function orphanFinding(overrides = {}) {
  return {
    severity: 'MEDIUM',
    kind: 'orphan-introduced',
    subKind: 'left-orphan',
    file: 'src/foo.mjs',
    allRemovedCallers: ['src/main.mjs'],
    priorCallers: ['src/main.mjs'],
    testCallers: [],
    rationale: 'Lost all incoming imports',
    ...overrides,
  };
}

describe('findingFingerprint', () => {
  it('left-orphan fingerprint includes ALL removers, not just truncated display', () => {
    // Two findings same file, same kind, DIFFERENT remover sets → different fingerprint.
    const f1 = orphanFinding({ allRemovedCallers: ['src/a.mjs', 'src/b.mjs'] });
    const f2 = orphanFinding({ allRemovedCallers: ['src/c.mjs', 'src/d.mjs'] });
    assert.notEqual(findingFingerprint(f1), findingFingerprint(f2));
  });

  it('left-orphan fingerprint stable across runs (same inputs → same hash)', () => {
    const f1 = orphanFinding({ allRemovedCallers: ['src/b.mjs', 'src/a.mjs'] }); // unsorted input
    const f2 = orphanFinding({ allRemovedCallers: ['src/a.mjs', 'src/b.mjs'] }); // sorted
    // Pipeline sorts before hashing → fingerprints match
    assert.equal(findingFingerprint(f1), findingFingerprint(f2));
  });

  it('born-orphan fingerprint over {kind, subKind, file} only (no remover noise)', () => {
    const f1 = { ...orphanFinding(), subKind: 'born-orphan', allRemovedCallers: [] };
    const f2 = { ...orphanFinding(), subKind: 'born-orphan', allRemovedCallers: ['ignored'] };
    assert.equal(findingFingerprint(f1), findingFingerprint(f2));
  });

  it('different file → different fingerprint', () => {
    const f1 = orphanFinding({ file: 'src/a.mjs' });
    const f2 = orphanFinding({ file: 'src/b.mjs' });
    assert.notEqual(findingFingerprint(f1), findingFingerprint(f2));
  });

  it('generic finding (non-orphan) also fingerprintable', () => {
    const f = { kind: 'wiring', severity: 'HIGH', section: 'src/x.mjs', detail: 'unused export' };
    const fp = findingFingerprint(f);
    assert.match(fp, /^[a-f0-9]{8}$/);
  });
});

describe('processFindings — ledger suppression', () => {
  it('drops findings whose fingerprint matches a dismissed ledger entry', () => {
    const finding = orphanFinding();
    const fp = findingFingerprint(finding);
    const ledger = {
      entries: [
        { fingerprint: fp, adjudicationOutcome: 'dismissed', topicId: 'unrelated-topic' },
      ],
    };
    const r = processFindings([finding], { ledger });
    assert.equal(r.survivors.length, 0);
    assert.equal(r.suppressed.length, 1);
    assert.equal(r.suppressed[0].suppressedBy, 'ledger');
  });

  it('drops findings matched via topicId (fallback for older ledger entries)', () => {
    const finding = orphanFinding();
    const fp = findingFingerprint(finding);
    const ledger = {
      entries: [{ topicId: fp, adjudicationOutcome: 'dismissed' }],
    };
    const r = processFindings([finding], { ledger });
    assert.equal(r.survivors.length, 0);
  });

  it('keeps findings when no ledger match', () => {
    const finding = orphanFinding();
    const ledger = { entries: [{ fingerprint: 'unrelated', adjudicationOutcome: 'dismissed' }] };
    const r = processFindings([finding], { ledger });
    assert.equal(r.survivors.length, 1);
    assert.equal(r.suppressed.length, 0);
  });

  it('keeps findings when ledger entry is pending (not dismissed)', () => {
    const finding = orphanFinding();
    const fp = findingFingerprint(finding);
    const ledger = { entries: [{ fingerprint: fp, adjudicationOutcome: 'accepted' }] };
    const r = processFindings([finding], { ledger });
    assert.equal(r.survivors.length, 1);
  });

  it('handles null ledger gracefully', () => {
    const r = processFindings([orphanFinding()], { ledger: null });
    assert.equal(r.survivors.length, 1);
  });
});

describe('processFindings — accept-v1 marker suppression', () => {
  it('drops findings whose file matches an accept-v1 glob', () => {
    const finding = orphanFinding({ file: 'src/plugins/plugin-a.mjs' });
    const planContent = `# Plan
<!-- audit:accept-v1: src/plugins/plugin-* :: dynamically loaded -->
`;
    const r = processFindings([finding], { planContent });
    assert.equal(r.survivors.length, 0);
    assert.equal(r.suppressed.length, 1);
    assert.equal(r.suppressed[0].suppressedBy, 'accept-v1');
    assert.equal(r.suppressed[0].acceptReason, 'dynamically loaded');
  });

  it('keeps findings when no marker matches', () => {
    const finding = orphanFinding({ file: 'src/foo.mjs' });
    const planContent = `<!-- audit:accept-v1: src/legacy/** :: WIP migration -->`;
    const r = processFindings([finding], { planContent });
    assert.equal(r.survivors.length, 1);
  });

  it('handles plan with no markers', () => {
    const r = processFindings([orphanFinding()], { planContent: '# Plan\nNo markers.' });
    assert.equal(r.survivors.length, 1);
  });

  it('handles null planContent', () => {
    const r = processFindings([orphanFinding()], { planContent: null });
    assert.equal(r.survivors.length, 1);
  });

  it('Gemini-final-gate fix: accept-v1 does NOT suppress non-orphan findings on matching file (cross-pass leak prevention)', () => {
    // A non-orphan finding (e.g. LLM-pass security/architecture) lands on
    // a file with an accept-v1 glob marker added for orphan suppression.
    // The pipeline MUST pass through the non-orphan finding unchanged.
    const orphan = orphanFinding({ file: 'src/foo.mjs' });
    const security = {
      kind: 'security',
      severity: 'HIGH',
      file: 'src/foo.mjs',
      section: 'src/foo.mjs:42',
      detail: 'SQL injection risk',
      category: 'Security',
    };
    const planContent = `<!-- audit:accept-v1: src/foo.mjs :: known orphan -->`;
    const r = processFindings([orphan, security], { planContent });
    assert.equal(r.survivors.length, 1, 'security finding must survive');
    assert.equal(r.survivors[0].kind, 'security');
    assert.equal(r.suppressed.length, 1, 'only the orphan finding should be suppressed');
    assert.equal(r.suppressed[0].kind, 'orphan-introduced');
    assert.equal(r.suppressed[0].suppressedBy, 'accept-v1');
  });
});

describe('processFindings — pure-data contract', () => {
  it('returns separate survivors + suppressed lists (Gemini-R4/H1)', () => {
    const f1 = orphanFinding({ file: 'src/a.mjs' });
    const f2 = orphanFinding({ file: 'src/b.mjs' });
    const fp1 = findingFingerprint(f1);
    const ledger = { entries: [{ fingerprint: fp1, adjudicationOutcome: 'dismissed' }] };
    const r = processFindings([f1, f2], { ledger });
    assert.equal(r.survivors.length, 1);
    assert.equal(r.survivors[0].file, 'src/b.mjs');
    assert.equal(r.suppressed.length, 1);
    assert.equal(r.suppressed[0].file, 'src/a.mjs');
  });

  it('empty input → empty output', () => {
    const r = processFindings([], {});
    assert.deepEqual(r.survivors, []);
    assert.deepEqual(r.suppressed, []);
  });

  it('survivors carry _fingerprint field for downstream use', () => {
    const r = processFindings([orphanFinding()], {});
    assert.match(r.survivors[0]._fingerprint, /^[a-f0-9]{8}$/);
  });

  it('does not perform I/O (no fs/path side effects)', () => {
    // Spec-level test: the function only takes data and returns data.
    const r = processFindings([orphanFinding()], { ledger: null, planContent: null });
    assert.deepEqual(Object.keys(r).sort((a, b) => a.localeCompare(b)), ['suppressed', 'survivors']);
  });
});
