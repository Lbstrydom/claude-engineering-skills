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

test('same match but scope changed → reopened, not suppressed', () => {
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
  const r = suppressReRaises(findings, ledger, { changedFiles: ['src/a.mjs'] });
  assert.equal(r.reopened.length, 1, 'changed scope must reopen');
  assert.equal(r.suppressed.length, 0);
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
