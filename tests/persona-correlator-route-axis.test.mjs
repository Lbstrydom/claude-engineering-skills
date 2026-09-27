/**
 * @fileoverview The correlator's ROUTE axis (MATCHER_VERSION 2) — pure tests.
 *
 * Field report 2026-09-26 (a Streamlit consumer running /persona-test pair
 * mode): two real P1 lifecycle findings on the score-entry page correlated
 * as `audit_missed` even though an audit finding sat in the file that serves
 * that page. The persona side sees a ROUTE (`/score_entry`); the audit side
 * names a FILE (`app/views/2_score_entry.py`); the token-overlap file axis
 * scored the pair at 0.5 and demanded 70% keyword overlap to compensate.
 *
 * The fixture below is shaped from that report (route, file, and the handover
 * symptom); the numbers in the comments are what the matcher computes, so a
 * change to tokenisation that moves them fails here rather than silently
 * shifting recall. A negative control — the same finding observed on an
 * unrelated route — must still read `audit_missed`: the route axis corroborates
 * a match, it never manufactures one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchFinding, decideCorrelations, buildStepUrlLookup, personaFindingHash,
  normalizeRouteKey, routeKeysFromStepUrl, routeKeyFromPrimaryFile, MATCHER_VERSION, FUZZY_THRESHOLD,
} from '../scripts/lib/persona/audit-correlator.mjs';
import { auditFinding } from './helpers/persona-audit-fixtures.mjs';

const handoverFinding = (over = {}) => ({
  severity: 'P1', step: 4,
  element: 'Open in scorer button',
  observed: 'Handover opened a different item than the one selected before navigation.',
  fix: 'Carry the selected item id across the page switch.', confidence: 0.8,
  ...over,
});

const scoreEntryAudit = () => auditFinding({
  id: 'audit-score-entry', run_id: 'run-7', severity: 'MEDIUM', category: 'state-loss',
  primary_file: 'app/views/2_score_entry.py',
  detail_snapshot: 'Selected item id is not carried into the handover target after rerender.',
});

const clickPathTo = (url) => [
  { step: 1, action: 'navigate', url: 'https://app.example.test/', targetText: null },
  { step: 4, action: 'click', url, targetText: 'Open in scorer' },
];

describe('route keys — normalisation', () => {
  it('strips a numeric page prefix and folds punctuation/emoji', () => {
    assert.equal(normalizeRouteKey('2_score_entry'), 'score_entry');
    assert.equal(normalizeRouteKey('02-Score Entry'), 'score_entry');
    assert.equal(normalizeRouteKey('10_📊_Score_Entry'), 'score_entry');
  });
  it('reads the stem of a primary_file, and refuses a generic one', () => {
    assert.equal(routeKeyFromPrimaryFile('app/views/2_score_entry.py'), 'score_entry');
    assert.equal(routeKeyFromPrimaryFile('app\\views\\2_score_entry.py'), 'score_entry');
    assert.equal(routeKeyFromPrimaryFile('src/pages/index.tsx'), '', 'an index file serves every route — no page identity');
    assert.equal(routeKeyFromPrimaryFile('app/main.py'), '');
    assert.equal(routeKeyFromPrimaryFile(''), '');
  });
  it('reads path segments AND the page= parameter of a step URL', () => {
    assert.deepEqual([...routeKeysFromStepUrl('/score_entry')], ['score_entry']);
    assert.deepEqual([...routeKeysFromStepUrl('/?page=2_score_entry')], ['score_entry']);
    assert.ok(routeKeysFromStepUrl('/app/score-entry').has('score_entry'));
    assert.ok(routeKeysFromStepUrl('/#/score_entry').has('score_entry'), 'hash routes count');
  });
  it('never keys a redacted :param segment', () => {
    assert.deepEqual([...routeKeysFromStepUrl('/items/:param')], ['items']);
    assert.deepEqual([...routeKeysFromStepUrl('/?page=:param')], []);
  });
});

describe('matchFinding — the route axis on the field-report shape', () => {
  it('route /score_entry ↔ app/views/2_score_entry.py matches (tier: route), where token overlap alone did not', () => {
    const finding = handoverFinding();
    const stepUrls = buildStepUrlLookup(clickPathTo('https://app.example.test/score_entry'));
    const result = matchFinding(finding, personaFindingHash(finding, stepUrls), [scoreEntryAudit()], stepUrls);
    assert.ok(result, 'the route names the page the audited file serves — this must correlate');
    assert.equal(result.tier, 'route');
    // file axis 1.0 (route hit) + keyword 4/10 = 0.4 → 0.5 + 0.2 = 0.70
    assert.ok(Math.abs(result.matchScore - 0.7) < 1e-9, `expected 0.70, got ${result.matchScore}`);
    assert.ok(result.matchScore >= FUZZY_THRESHOLD);
  });

  it('the same pair WITHOUT a step on the finding abstains from the route axis — and misses, as v1 did', () => {
    // No `step` ⇒ no URL to compare, so the persona file axis is the element
    // alone: {open, scorer, button} ∩ {app, views, score, entry} = ∅ → 0.
    const finding = handoverFinding({ step: undefined });
    const stepUrls = buildStepUrlLookup(clickPathTo('https://app.example.test/score_entry'));
    assert.equal(matchFinding(finding, personaFindingHash(finding, stepUrls), [scoreEntryAudit()], stepUrls), null);
  });

  it('NEGATIVE CONTROL: the same finding observed on an unrelated route does not match', () => {
    const finding = handoverFinding();
    const stepUrls = buildStepUrlLookup(clickPathTo('https://app.example.test/settings'));
    assert.equal(matchFinding(finding, personaFindingHash(finding, stepUrls), [scoreEntryAudit()], stepUrls), null,
      'a route that names a different page must not correlate — keyword overlap alone is not enough');
  });

  it('a route hit never clears the bar without keyword corroboration (dual-signal floor holds)', () => {
    const finding = handoverFinding({ observed: 'Colour contrast of the footer links is too low.' });
    const stepUrls = buildStepUrlLookup(clickPathTo('https://app.example.test/score_entry'));
    assert.equal(matchFinding(finding, personaFindingHash(finding, stepUrls), [scoreEntryAudit()], stepUrls), null);
  });
});

describe('decideCorrelations — route vs missed emissions', () => {
  it('emits a confirmed_hit stamped with the route tier and MATCHER_VERSION 2', () => {
    const { emissions } = decideCorrelations({
      findings: [handoverFinding()],
      clickPath: clickPathTo('https://app.example.test/score_entry'),
      candidates: [scoreEntryAudit()],
      alreadyCorrelatedHashes: new Set(),
    });
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].correlationType, 'confirmed_hit');
    assert.equal(emissions[0].auditFindingId, 'audit-score-entry');
    assert.equal(emissions[0]._tier, 'route');
    assert.equal(MATCHER_VERSION, 2);
    assert.match(emissions[0].matchRationale, /^\[v2\] route tier/);
  });

  it('keeps audit_missed as the honest label when nothing genuinely matches', () => {
    const { emissions } = decideCorrelations({
      findings: [handoverFinding()],
      clickPath: clickPathTo('https://app.example.test/settings'),
      candidates: [scoreEntryAudit()],
      alreadyCorrelatedHashes: new Set(),
    });
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].correlationType, 'audit_missed');
    assert.equal(emissions[0].auditFindingId, null);
  });
});
