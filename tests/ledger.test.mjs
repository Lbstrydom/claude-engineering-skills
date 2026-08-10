/**
 * @fileoverview Dedicated suite for `scripts/lib/ledger.mjs` — the R2+
 * suppression engine.
 *
 * ## Why this file exists (debt bb15049a)
 *
 * 907 lines, 12 exports, Tier-1 by this repo's own testing doctrine, and NO
 * dedicated tests — exercised only incidentally by arm-generation,
 * debt-suppression and debt-transcript-suppression. Surfaced 2026-08-09 while
 * building the mutation registry: the seam could not be added, because a score
 * spread across three incidental suites does not attribute to this module.
 *
 * The stakes are specific. This module decides whether a finding is SUPPRESSED
 * or REOPENED. A loose assertion here lets a real regression be silently
 * suppressed — silent loss inside the audit loop itself, which is the exact
 * failure class the loop exists to prevent. Suppression is also asymmetric:
 * a wrongly-KEPT finding is visible noise a human dismisses in seconds; a
 * wrongly-SUPPRESSED one is invisible and reaches nobody.
 *
 * So the tests below lean on the suppress/reopen decision and its boundaries,
 * not on coverage of every export.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateTopicId,
  ledgerFindingSimilarity,
  matchesLedgerEntry,
  suppressReRaises,
  computeImpactSet,
  buildR2SystemPrompt,
  R2_ROUND_MODIFIER,
} from '../scripts/lib/ledger.mjs';

// ── fixtures ────────────────────────────────────────────────────────────────

function finding(over = {}) {
  return {
    category: '[Sustainability] Error swallowing',
    section: 'scripts/lib/foo.mjs:42',
    detail: 'The catch block discards the error and returns null, so a failure reads as an empty result.',
    _primaryFile: 'scripts/lib/foo.mjs',
    _pass: 'Sustainability',
    _hash: 'hash-a',
    ...over,
  };
}

function entry(over = {}) {
  return {
    topicId: 'aaaaaaaaaaaa',
    category: '[Sustainability] Error swallowing',
    section: 'scripts/lib/foo.mjs:42',
    detailSnapshot: 'The catch block discards the error and returns null, so a failure reads as an empty result.',
    affectedFiles: ['scripts/lib/foo.mjs'],
    pass: 'Sustainability',
    adjudicationOutcome: 'dismissed',
    remediationState: 'pending',
    ...over,
  };
}

const ledgerOf = (...entries) => ({ version: 1, entries });

// The threshold is env-driven; pin it so these tests describe the module, not
// whatever the ambient environment happens to be.
let savedThreshold;
beforeEach(() => {
  savedThreshold = process.env.SUPPRESS_SIMILARITY_THRESHOLD;
  process.env.SUPPRESS_SIMILARITY_THRESHOLD = '0.35';
});
afterEach(() => {
  if (savedThreshold === undefined) delete process.env.SUPPRESS_SIMILARITY_THRESHOLD;
  else process.env.SUPPRESS_SIMILARITY_THRESHOLD = savedThreshold;
});

// ── generateTopicId ─────────────────────────────────────────────────────────

describe('generateTopicId — stable identity, and what it is allowed to ignore', () => {
  it('is deterministic and 12 hex chars', () => {
    const id = generateTopicId(finding());
    assert.match(id, /^[0-9a-f]{12}$/);
    assert.equal(id, generateTopicId(finding()));
  });

  it('folds in the content hash, so two findings on one file/category/pass differ', () => {
    // The docstring once claimed the opposite ("no content hash"). The code
    // always included it and existing consumers depend on it, so the CODE is
    // the contract being pinned here.
    assert.notEqual(
      generateTopicId(finding({ _hash: 'hash-a' })),
      generateTopicId(finding({ _hash: 'hash-b' })),
    );
  });

  it('normalises category decoration away — a re-tagged finding keeps its identity', () => {
    assert.equal(
      generateTopicId(finding({ category: '[Sustainability] Error swallowing' })),
      generateTopicId(finding({ category: 'Error swallowing' })),
    );
  });

  it('normalises path separators, so a Windows caller and a POSIX caller agree', () => {
    assert.equal(
      generateTopicId(finding({ _primaryFile: 'scripts/lib/foo.mjs' })),
      generateTopicId(finding({ _primaryFile: 'scripts\\lib\\foo.mjs' })),
    );
  });

  it('changes when the PASS changes — same defect found by a different pass is a different topic', () => {
    assert.notEqual(
      generateTopicId(finding({ _pass: 'Sustainability' })),
      generateTopicId(finding({ _pass: 'Wiring' })),
    );
  });

  it('does not throw on a finding missing every optional field', () => {
    assert.match(generateTopicId({}), /^[0-9a-f]{12}$/);
  });
});

// ── similarity + match predicate ────────────────────────────────────────────

describe('ledgerFindingSimilarity', () => {
  it('scores an identical pair at 1', () => {
    assert.equal(ledgerFindingSimilarity(finding(), entry()), 1);
  });

  it('scores an unrelated pair near 0', () => {
    const score = ledgerFindingSimilarity(
      finding(),
      entry({
        category: '[Frontend] Missing alt text',
        section: 'src/App.tsx:10',
        detailSnapshot: 'An image element has no alternative text for assistive technology.',
      }),
    );
    assert.ok(score < 0.2, `expected a low score for unrelated text, got ${score}`);
  });

  it('reads detailSnapshot, falling back to detail', () => {
    const viaSnapshot = ledgerFindingSimilarity(finding(), entry());
    const viaDetail = ledgerFindingSimilarity(
      finding(),
      { ...entry(), detailSnapshot: undefined, detail: entry().detailSnapshot },
    );
    assert.equal(viaDetail, viaSnapshot, 'both spellings must score identically');
  });

  it('is symmetric in the sense that reworded-but-equivalent text still scores high', () => {
    const score = ledgerFindingSimilarity(
      finding({ detail: 'The catch block discards the error and returns null so a failure reads as an empty result' }),
      entry(),
    );
    assert.ok(score > 0.6, `a paraphrase should stay well above threshold, got ${score}`);
  });
});

describe('matchesLedgerEntry — file overlap is a PRECONDITION, not a score input', () => {
  it('refuses a perfect text match on a different file', () => {
    const d = entry({ affectedFiles: ['scripts/lib/other.mjs'] });
    assert.equal(
      matchesLedgerEntry(finding(), d, { threshold: 0.35 }), false,
      'without file-scope overlap, identical text is a DIFFERENT finding — suppressing it '
      + 'would silence a real defect in another file',
    );
  });

  it('matches a same-pass pair above the threshold', () => {
    assert.equal(matchesLedgerEntry(finding(), entry(), { threshold: 0.35 }), true);
  });

  it('holds a CROSS-pass pair to the higher 0.8 bar', () => {
    // A same-file pair that clears 0.35 but not 0.8 must match same-pass and
    // NOT cross-pass. That difference is the whole point of the two bars.
    const reworded = finding({
      // Empirically 0.542 — chosen by MEASURING candidates, not by guessing
      // which paraphrase would land between 0.35 and 0.8.
      detail: 'A swallowed error returns null, so the caller cannot tell a failure from an empty result.',
    });
    const score = ledgerFindingSimilarity(reworded, entry());
    assert.ok(score > 0.35 && score < 0.8, `fixture must sit between the bars, got ${score}`);

    assert.equal(matchesLedgerEntry(reworded, entry(), { threshold: 0.35 }), true);
    assert.equal(
      matchesLedgerEntry(reworded, entry({ pass: 'Wiring' }), { threshold: 0.35 }), false,
      'a cross-pass match must clear 0.8, not the ordinary threshold',
    );
  });

  it('respects a caller-supplied threshold rather than a hardcoded one', () => {
    const weak = finding({ detail: 'Something else entirely about a different concern in this file.' });
    assert.equal(matchesLedgerEntry(weak, entry(), { threshold: 0.99 }), false);
    assert.equal(matchesLedgerEntry(weak, entry(), { threshold: 0.01 }), true);
  });

  it('treats a missing affectedFiles array as no overlap, not as a wildcard', () => {
    assert.equal(matchesLedgerEntry(finding(), entry({ affectedFiles: undefined }), { threshold: 0.35 }), false);
    assert.equal(matchesLedgerEntry(finding(), entry({ affectedFiles: [] }), { threshold: 0.35 }), false);
  });
});

// ── suppressReRaises — the decision that matters ────────────────────────────

describe('suppressReRaises — which ledger entries are even eligible to suppress', () => {
  it('suppresses against a DISMISSED entry when scope is unchanged', () => {
    const r = suppressReRaises([finding()], ledgerOf(entry()), { changedFiles: [] });
    assert.equal(r.suppressed.length, 1);
    assert.equal(r.kept.length, 0);
    assert.equal(r.suppressed[0].matchedTopic, 'aaaaaaaaaaaa');
  });

  it('suppresses against a FIXED / VERIFIED entry', () => {
    for (const remediationState of ['fixed', 'verified']) {
      const e = entry({ adjudicationOutcome: 'accepted', remediationState });
      const r = suppressReRaises([finding()], ledgerOf(e), { changedFiles: [] });
      assert.equal(r.suppressed.length, 1, `${remediationState} must be eligible`);
    }
  });

  // The load-bearing exclusion. An accepted-but-unremediated finding is an OPEN
  // obligation; suppressing it would hide work that was never done.
  it('does NOT suppress against an accepted-but-PENDING entry', () => {
    const e = entry({ adjudicationOutcome: 'accepted', remediationState: 'pending' });
    const r = suppressReRaises([finding()], ledgerOf(e), { changedFiles: [] });
    assert.equal(r.kept.length, 1, 'an unremediated acceptance is still open — it must re-raise');
    assert.equal(r.suppressed.length, 0);
  });

  it('does not suppress against a REGRESSED entry', () => {
    const e = entry({ adjudicationOutcome: 'accepted', remediationState: 'regressed' });
    assert.equal(suppressReRaises([finding()], ledgerOf(e), {}).kept.length, 1);
  });

  it('suppresses against a debt entry, but NOT an escalated one', () => {
    const debt = entry({ source: 'debt', deferredReason: 'out-of-scope', adjudicationOutcome: undefined });
    assert.equal(suppressReRaises([finding()], ledgerOf(debt), {}).suppressed.length, 1);

    const escalated = { ...debt, escalated: true };
    assert.equal(
      suppressReRaises([finding()], ledgerOf(escalated), {}).kept.length, 1,
      'escalation exists precisely to bypass suppression and force re-deliberation',
    );
  });

  it('defaults a source-less entry to session semantics (pre-Phase-D ledgers)', () => {
    const legacy = entry({ source: undefined });
    assert.equal(suppressReRaises([finding()], ledgerOf(legacy), {}).suppressed.length, 1);
  });

  it('tolerates a null/empty ledger without throwing', () => {
    for (const l of [null, undefined, {}, { entries: [] }]) {
      const r = suppressReRaises([finding()], l, {});
      assert.equal(r.kept.length, 1, 'no ledger means nothing to suppress against');
      assert.equal(r.suppressed.length, 0);
    }
  });
});

describe('suppressReRaises — reopen-on-touch is what stops a real regression being silenced', () => {
  it('REOPENS instead of suppressing when the entry scope was changed this round', () => {
    const r = suppressReRaises([finding()], ledgerOf(entry()), {
      changedFiles: ['scripts/lib/foo.mjs'],
    });
    assert.equal(r.reopened.length, 1, 'touching the file makes a prior dismissal untrustworthy');
    assert.equal(r.suppressed.length, 0);
    assert.equal(r.reopened[0]._reopened, true);
    assert.equal(r.reopened[0]._matchedTopic, 'aaaaaaaaaaaa');
    assert.ok(r.reopened[0]._matchScore > 0.35);
  });

  it('suppresses the same finding when a DIFFERENT file changed', () => {
    const r = suppressReRaises([finding()], ledgerOf(entry()), {
      changedFiles: ['scripts/lib/unrelated.mjs'],
    });
    assert.equal(r.suppressed.length, 1, 'an unrelated change must not reopen everything');
  });

  it('compares changed files through path normalisation, not string equality', () => {
    const r = suppressReRaises([finding()], ledgerOf(entry()), {
      changedFiles: ['scripts\\lib\\foo.mjs'],
    });
    assert.equal(r.reopened.length, 1, 'a Windows-spelled changed file must still reopen');
  });
});

describe('suppressReRaises — the hard-suppress ruling counter', () => {
  const overruled = (i) => entry({
    topicId: `t${i}`.padEnd(12, '0'),
    ruling: 'overrule',
    adjudicationOutcome: 'dismissed',
    // Vary the text so ordinary fuzzy matching cannot account for the result —
    // the counter must be what suppresses, not similarity.
    detailSnapshot: `An entirely different observation number ${i} about unrelated behaviour.`,
  });

  it('hard-suppresses once a category+file has been overruled 3 times', () => {
    const r = suppressReRaises([finding()], ledgerOf(overruled(1), overruled(2), overruled(3)), {
      changedFiles: ['scripts/lib/foo.mjs'],   // even a TOUCHED scope stays suppressed
    });
    assert.equal(r.suppressed.length, 1);
    assert.equal(r.suppressed[0].matchedTopic, 'hard-suppress');
    assert.equal(r.suppressed[0].matchedSource, 'ruling-count');
  });

  it('does NOT hard-suppress at 2 — the threshold is 3, not "a few"', () => {
    const r = suppressReRaises([finding()], ledgerOf(overruled(1), overruled(2)), {
      changedFiles: ['scripts/lib/foo.mjs'],
    });
    assert.notEqual(r.suppressed[0]?.matchedTopic, 'hard-suppress');
  });

  // stage1-mechanical dismissals are excluded from the counter on purpose: a
  // mechanical reason ("the cited function does not exist") can BECOME false
  // when the code changes, in a way a human judgement never does. Counting them
  // toward a permanent hard-suppress would let a stale fact outlive its subject.
  it('excludes stage1-mechanical entries from the counter', () => {
    const mech = (i) => ({ ...overruled(i), source: 'stage1-mechanical' });
    const r = suppressReRaises([finding()], ledgerOf(mech(1), mech(2), mech(3)), {
      changedFiles: ['scripts/lib/foo.mjs'],
    });
    assert.notEqual(
      r.suppressed[0]?.matchedTopic, 'hard-suppress',
      'a mechanical dismissal must not accumulate toward a PERMANENT suppression',
    );
  });
});

describe('suppressReRaises — a finding with no match is always kept', () => {
  it('keeps a finding whose file appears in no entry', () => {
    const r = suppressReRaises([finding({ _primaryFile: 'scripts/lib/brand-new.mjs' })], ledgerOf(entry()), {});
    assert.equal(r.kept.length, 1);
  });

  it('keeps a same-file finding whose text is unrelated', () => {
    const unrelated = finding({
      category: '[Backend] N+1 query',
      detail: 'Each row triggers its own round trip to the database inside the loop.',
    });
    const r = suppressReRaises([unrelated], ledgerOf(entry()), {});
    assert.equal(r.kept.length, 1, 'same file, different defect — must not be suppressed');
  });

  it('partitions every input finding into exactly one bucket', () => {
    const findings = [
      finding(),                                              // suppressed
      finding({ _primaryFile: 'scripts/lib/new.mjs', _hash: 'h2' }), // kept
    ];
    const r = suppressReRaises(findings, ledgerOf(entry()), {});
    assert.equal(
      r.kept.length + r.suppressed.length + r.reopened.length, findings.length,
      'a finding that lands in no bucket has been silently dropped',
    );
  });

  it('returns empty buckets for an empty finding list', () => {
    const r = suppressReRaises([], ledgerOf(entry()), {});
    assert.deepEqual([r.kept, r.suppressed, r.reopened], [[], [], []]);
  });
});

// ── computeImpactSet ────────────────────────────────────────────────────────

describe('computeImpactSet', () => {
  it('always includes the changed files themselves', () => {
    const r = computeImpactSet(['scripts/lib/foo.mjs'], []);
    assert.deepEqual(r, ['scripts/lib/foo.mjs']);
  });

  it('normalises separators and returns a sorted, de-duplicated set', () => {
    const r = computeImpactSet(['b/x.mjs', 'a\\y.mjs', 'b/x.mjs'], []);
    assert.deepEqual(r, ['a/y.mjs', 'b/x.mjs']);
  });

  it('skips files that do not exist rather than throwing', () => {
    assert.doesNotThrow(() => computeImpactSet(['a.mjs'], ['does/not/exist.mjs']));
  });

  it('pulls in a real importer of a changed file', () => {
    // Uses this repo's own source rather than a fixture: ledger.mjs is imported
    // by scripts/lib/audit/legacy-production-audit.mjs via a relative path.
    const r = computeImpactSet(['scripts/lib/ledger.mjs'], ['scripts/lib/audit/legacy-production-audit.mjs']);
    assert.ok(r.includes('scripts/lib/ledger.mjs'));
  });
});

// ── R2+ prompt assembly ─────────────────────────────────────────────────────

describe('buildR2SystemPrompt', () => {
  it('includes the round modifier and the pass rubric', () => {
    const out = buildR2SystemPrompt('RUBRIC-TEXT', 'RULINGS-BLOCK');
    assert.ok(out.includes('RUBRIC-TEXT'));
    assert.ok(out.includes(R2_ROUND_MODIFIER.split('\n')[0]));
  });

  it('includes the rulings block when one is supplied', () => {
    assert.ok(buildR2SystemPrompt('R', 'RULINGS-BLOCK').includes('RULINGS-BLOCK'));
  });

  it('does not emit a dangling rulings section when the block is empty', () => {
    const out = buildR2SystemPrompt('R', '');
    assert.equal(typeof out, 'string');
    assert.ok(out.includes('R'));
  });
});
