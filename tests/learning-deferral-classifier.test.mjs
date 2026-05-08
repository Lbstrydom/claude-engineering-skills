import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDeferralEvidence,
  parseAcceptV1Markers,
  isAutoDeferrableClass,
  isForbiddenClass,
  AUTO_DEFERRABLE_CLASSES,
  FORBIDDEN_CLASSES,
  _internals,
} from '../scripts/lib/audit/deferral-classifier.mjs';

// ── parseAcceptV1Markers ──────────────────────────────────────────────────

describe('deferral-classifier / parseAcceptV1Markers', () => {
  it('extracts simple marker', () => {
    const md = '# Title\n<!-- audit:accept-v1: src/foo.js :: stable v1 file -->\nbody';
    const out = parseAcceptV1Markers(md);
    assert.deepEqual(out, [{ fileGlob: 'src/foo.js', reason: 'stable v1 file' }]);
  });

  it('extracts multiple markers', () => {
    const md = `
<!-- audit:accept-v1: src/legacy/**/*.js :: legacy area, frozen -->
<!-- audit:accept-v1: scripts/x.mjs :: external script -->
`;
    const out = parseAcceptV1Markers(md);
    assert.equal(out.length, 2);
    assert.equal(out[0].fileGlob, 'src/legacy/**/*.js');
    assert.equal(out[1].reason, 'external script');
  });

  it('returns [] for empty/null input', () => {
    assert.deepEqual(parseAcceptV1Markers(null), []);
    assert.deepEqual(parseAcceptV1Markers(''), []);
    assert.deepEqual(parseAcceptV1Markers('# no markers here'), []);
  });
});

// ── globMatch (via classifier) ─────────────────────────────────────────────

describe('deferral-classifier / globMatch', () => {
  const { globMatch } = _internals;

  it('matches exact path', () => {
    assert.equal(globMatch('src/foo.js', 'src/foo.js'), true);
  });

  it('matches single-star pattern', () => {
    assert.equal(globMatch('src/*.js', 'src/foo.js'), true);
    assert.equal(globMatch('src/*.js', 'src/sub/foo.js'), false);
  });

  it('matches double-star pattern', () => {
    assert.equal(globMatch('src/**/*.js', 'src/foo.js'), true);
    assert.equal(globMatch('src/**/*.js', 'src/sub/foo.js'), true);
    assert.equal(globMatch('src/**/*.js', 'src/sub/deep/foo.js'), true);
  });

  it('rejects non-match', () => {
    assert.equal(globMatch('src/*.js', 'lib/foo.js'), false);
  });
});

// ── classifyDeferralEvidence — gates ──────────────────────────────────────

describe('deferral-classifier / scope-mode gate', () => {
  it('returns null in --scope full regardless of evidence', () => {
    const finding = { category: 'style', primary_file: 'src/x.js' };
    const ctx = { scopeMode: 'full', changedFiles: ['lib/y.js'] };
    assert.equal(classifyDeferralEvidence(finding, ctx), null);
  });

  it('returns null in --scope plan regardless of evidence', () => {
    const finding = { category: 'style', primary_file: 'src/x.js' };
    const ctx = { scopeMode: 'plan', changedFiles: ['lib/y.js'] };
    assert.equal(classifyDeferralEvidence(finding, ctx), null);
  });

  it('only --scope diff allows auto-deferral', () => {
    const finding = { category: 'style', primary_file: 'src/x.js' };
    const ctx = { scopeMode: 'diff', changedFiles: ['lib/y.js'] };
    const r = classifyDeferralEvidence(finding, ctx);
    assert.ok(r);
    assert.equal(r.class, 'out-of-scope');
  });
});

describe('deferral-classifier / class allowlist', () => {
  it('forbidden classes never auto-defer', () => {
    for (const cat of FORBIDDEN_CLASSES) {
      const ctx = { scopeMode: 'diff', changedFiles: ['x.js'] };
      const finding = { category: cat, primary_file: 'lib/y.js' };
      assert.equal(classifyDeferralEvidence(finding, ctx), null,
        `${cat} should not auto-defer even with out-of-scope evidence`);
    }
  });

  it('non-allowlisted, non-forbidden classes do not auto-defer', () => {
    const ctx = { scopeMode: 'diff', changedFiles: ['x.js'] };
    const finding = { category: 'misc-other', primary_file: 'lib/y.js' };
    assert.equal(classifyDeferralEvidence(finding, ctx), null);
  });

  it('allowlisted classes can auto-defer with evidence', () => {
    for (const cat of AUTO_DEFERRABLE_CLASSES) {
      const ctx = { scopeMode: 'diff', changedFiles: ['changed.js'] };
      const finding = { category: cat, primary_file: 'unchanged.js' };
      const r = classifyDeferralEvidence(finding, ctx);
      assert.ok(r, `${cat} should classify`);
      assert.equal(r.class, 'out-of-scope');
    }
  });
});

describe('deferral-classifier / SCM evidence priority', () => {
  it('accepted-v1 plan marker takes priority over out-of-scope', () => {
    const planContent = '<!-- audit:accept-v1: src/legacy.js :: frozen -->';
    const ctx = {
      scopeMode: 'diff',
      changedFiles: ['other.js'],
      planContent,
    };
    const finding = { category: 'style', primary_file: 'src/legacy.js' };
    const r = classifyDeferralEvidence(finding, ctx);
    assert.equal(r.class, 'accepted-v1');
    assert.equal(r.evidence.type, 'plan-marker');
  });

  it('out-of-scope when file not in changed list', () => {
    const ctx = {
      scopeMode: 'diff',
      changedFiles: ['a.js', 'b.js'],
    };
    const finding = { category: 'style', primary_file: 'c.js' };
    const r = classifyDeferralEvidence(finding, ctx);
    assert.equal(r.class, 'out-of-scope');
  });

  it('rigor-pressure when same hash in 2 DIFFERENT rounds (modern shape)', () => {
    const ctx = {
      scopeMode: 'diff',
      changedFiles: ['a.js'],
      priorRoundHashes: [
        new Set(['hash-A', 'hash-X']),  // round n-1
        new Set(['hash-B', 'hash-X']),  // round n
      ],
    };
    const finding = {
      category: 'style',
      primary_file: 'a.js',
      _hash: 'hash-X',
    };
    const r = classifyDeferralEvidence(finding, ctx);
    assert.equal(r.class, 'rigor-pressure');
    assert.equal(r.evidence.verifiedDistinctRounds, true);
  });

  it('rigor-pressure NOT triggered when only seen in 1 round (modern shape)', () => {
    const ctx = {
      scopeMode: 'diff',
      changedFiles: ['a.js'],
      priorRoundHashes: [
        new Set(['hash-X']),  // n-1 only
        new Set(['hash-Y']),  // n
      ],
    };
    const finding = { category: 'style', primary_file: 'a.js', _hash: 'hash-X' };
    const r = classifyDeferralEvidence(finding, ctx);
    assert.equal(r, null);
  });

  it('audit-fix H2: rigor-pressure NOT triggered by 2× same hash within ONE round (modern shape)', () => {
    // Sets dedupe automatically; in the legacy flat-array form, two duplicates
    // would have falsely tripped the rule.  This test pins down the per-round
    // structural requirement.
    const ctx = {
      scopeMode: 'diff',
      changedFiles: ['a.js'],
      priorRoundHashes: [
        ['hash-X'],          // round n-1: only X
        ['hash-Y', 'hash-Z'], // round n: no X
      ],
    };
    const finding = { category: 'style', primary_file: 'a.js', _hash: 'hash-X' };
    const r = classifyDeferralEvidence(finding, ctx);
    assert.equal(r, null);
  });

  it('audit-fix H3: empty changedFiles=[] does NOT trigger out-of-scope', () => {
    // Prior implementation treated [] as authoritative → mass-mis-classified.
    // Now [] is treated as "unknown" so we fall through other gates.
    const ctx = {
      scopeMode: 'diff',
      changedFiles: [],
      priorRoundHashes: [],
    };
    const finding = { category: 'style', primary_file: 'lib/y.js' };
    const r = classifyDeferralEvidence(finding, ctx);
    assert.equal(r, null, 'empty changedFiles must not trip out-of-scope');
  });
});

describe('deferral-classifier / introspection helpers', () => {
  it('isAutoDeferrableClass / isForbiddenClass behave correctly', () => {
    assert.equal(isAutoDeferrableClass('style'), true);
    assert.equal(isAutoDeferrableClass('security'), false);
    assert.equal(isForbiddenClass('security'), true);
    assert.equal(isForbiddenClass('style'), false);
  });

  it('AUTO_DEFERRABLE and FORBIDDEN sets are disjoint', () => {
    for (const cat of AUTO_DEFERRABLE_CLASSES) {
      assert.equal(FORBIDDEN_CLASSES.includes(cat), false, `${cat} should not be in both sets`);
    }
  });
});

describe('deferral-classifier / robustness', () => {
  it('returns null on null/missing input', () => {
    assert.equal(classifyDeferralEvidence(null, { scopeMode: 'diff' }), null);
    assert.equal(classifyDeferralEvidence({ category: 'style' }, null), null);
  });

  it('handles missing primary_file gracefully', () => {
    const ctx = { scopeMode: 'diff', changedFiles: ['a.js'] };
    const finding = { category: 'style' };
    // Without primary_file, no out-of-scope evidence path → returns null.
    assert.equal(classifyDeferralEvidence(finding, ctx), null);
  });
});
