/**
 * GOLDEN behaviour lock for suppressReRaises (fix-lifecycle plan, R1-audit M5).
 * Written BEFORE `matchesLedgerEntry`/`ledgerFindingSimilarity` are extracted —
 * the extraction must leave every classification below byte-identical. If this
 * suite goes red after the refactor, the matcher semantics drifted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suppressReRaises } from '../scripts/lib/ledger.mjs';

const entry = (o) => ({
  topicId: o.topicId, pass: o.pass, category: o.category, section: o.section,
  detailSnapshot: o.detail, affectedFiles: o.affectedFiles,
  adjudicationOutcome: o.adjudicationOutcome ?? 'dismissed',
  remediationState: o.remediationState ?? 'pending',
  ruling: o.ruling ?? 'overrule', source: 'session',
});
const finding = (o) => ({
  category: o.category, section: o.section, detail: o.detail,
  _pass: o.pass, _primaryFile: o.file, _hash: o.hash ?? o.section,
});

test('same-pass fuzzy match on an unchanged-scope dismissed entry → suppressed', () => {
  const ledger = { entries: [entry({
    topicId: 't1', pass: 'backend', category: 'Null deref', section: 'src/a.mjs:10',
    detail: 'possible null dereference on user input in the parse path',
    affectedFiles: ['src/a.mjs'], adjudicationOutcome: 'dismissed',
  })] };
  const findings = [finding({
    category: 'Null deref', section: 'src/a.mjs:10',
    detail: 'possible null dereference on user input in the parse path',
    pass: 'backend', file: 'src/a.mjs',
  })];
  const r = suppressReRaises(findings, ledger, { changedFiles: [] });
  assert.equal(r.suppressed.length, 1, 'unchanged-scope match must suppress');
  assert.equal(r.kept.length, 0);
  assert.equal(r.reopened.length, 0);
});

// Deliberately retargeted 2026-08-14 from a `dismissed` entry to a FIXED one.
// This suite locks MATCHER semantics (see the header), and the matcher is
// unchanged — but reopen-on-touch is no longer uniform across outcomes: a fixed
// entry still reopens mechanically (regression detection must not depend on the
// model noticing), while a dismissed one now requires the re-raise to declare
// itself. Exercising the fixed path keeps this test measuring what it was
// written to measure; the dismissed path is asserted both ways below.
test('same match but scope changed → reopened, not suppressed (FIXED entry)', () => {
  const ledger = { entries: [entry({
    topicId: 't1', pass: 'backend', category: 'Null deref', section: 'src/a.mjs:10',
    detail: 'possible null dereference on user input in the parse path',
    affectedFiles: ['src/a.mjs'], adjudicationOutcome: 'accepted', remediationState: 'fixed',
  })] };
  const findings = [finding({
    category: 'Null deref', section: 'src/a.mjs:10',
    detail: 'possible null dereference on user input in the parse path',
    pass: 'backend', file: 'src/a.mjs',
  })];
  const r = suppressReRaises(findings, ledger, { changedFiles: ['src/a.mjs'] });
  assert.equal(r.reopened.length, 1, 'changed scope must reopen a FIXED entry');
  assert.equal(r.suppressed.length, 0);
});

test('a DISMISSED entry on changed scope needs a declaration to reopen', () => {
  const mk = (extra = {}) => ({
    ledger: { entries: [entry({
      topicId: 't1', pass: 'backend', category: 'Null deref', section: 'src/a.mjs:10',
      detail: 'possible null dereference on user input in the parse path',
      affectedFiles: ['src/a.mjs'], adjudicationOutcome: 'dismissed',
    })] },
    findings: [{ ...finding({
      category: 'Null deref', section: 'src/a.mjs:10',
      detail: 'possible null dereference on user input in the parse path',
      pass: 'backend', file: 'src/a.mjs',
    }), ...extra }],
  });
  const undeclared = mk();
  const a = suppressReRaises(undeclared.findings, undeclared.ledger, { changedFiles: ['src/a.mjs'] });
  assert.equal(a.reopened.length, 0, 'a touch alone must not re-litigate a disproof');
  assert.equal(a.suppressed.length, 1);
  assert.match(a.suppressed[0].reason, /declared=no/);

  const declared = mk({ is_reopened: true });
  const b = suppressReRaises(declared.findings, declared.ledger, { changedFiles: ['src/a.mjs'] });
  assert.equal(b.reopened.length, 1, 'a declared reopen must still get through');
});

test('no file overlap → kept (never a candidate)', () => {
  const ledger = { entries: [entry({
    topicId: 't1', pass: 'backend', category: 'Null deref', section: 'src/a.mjs:10',
    detail: 'possible null dereference on user input in the parse path',
    affectedFiles: ['src/a.mjs'], adjudicationOutcome: 'dismissed',
  })] };
  const findings = [finding({
    category: 'Null deref', section: 'src/OTHER.mjs:10',
    detail: 'possible null dereference on user input in the parse path',
    pass: 'backend', file: 'src/OTHER.mjs',
  })];
  const r = suppressReRaises(findings, ledger, { changedFiles: [] });
  assert.equal(r.kept.length, 1, 'no file overlap → kept');
  assert.equal(r.suppressed.length, 0);
});

test('cross-pass low similarity → kept (below the 0.8 cross-pass bar)', () => {
  const ledger = { entries: [entry({
    topicId: 't1', pass: 'frontend', category: 'Some entirely different concern', section: 'src/a.mjs:10',
    detail: 'a totally unrelated wording about layout spacing and colors',
    affectedFiles: ['src/a.mjs'], adjudicationOutcome: 'dismissed',
  })] };
  const findings = [finding({
    category: 'Null deref', section: 'src/a.mjs:99',
    detail: 'possible null dereference on user input in the parse path',
    pass: 'backend', file: 'src/a.mjs',
  })];
  const r = suppressReRaises(findings, ledger, { changedFiles: [] });
  assert.equal(r.kept.length, 1, 'cross-pass below 0.8 → kept');
  assert.equal(r.suppressed.length, 0);
});

test('fixed unchanged-scope entry suppresses a re-raise (the fix-lifecycle-relevant branch)', () => {
  const ledger = { entries: [entry({
    topicId: 't1', pass: 'backend', category: 'Null deref', section: 'src/a.mjs:10',
    detail: 'possible null dereference on user input in the parse path',
    affectedFiles: ['src/a.mjs'], adjudicationOutcome: 'accepted', remediationState: 'fixed',
  })] };
  const findings = [finding({
    category: 'Null deref', section: 'src/a.mjs:10',
    detail: 'possible null dereference on user input in the parse path',
    pass: 'backend', file: 'src/a.mjs',
  })];
  const r = suppressReRaises(findings, ledger, { changedFiles: [] });
  assert.equal(r.suppressed.length, 1, 'a fixed entry with unchanged scope suppresses (never shown as active)');
});
