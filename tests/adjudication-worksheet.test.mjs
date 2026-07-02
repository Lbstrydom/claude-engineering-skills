/**
 * @fileoverview Tier-1 tests for the adjudication worksheet renderer — the
 * recurrence guard for "review queue = raw JSON + <placeholder> docs" (failed
 * the operator twice: final-review shadow queue, model-ab blinded queue).
 * The load-bearing invariants: paste-ready commands (no placeholders EVER),
 * duplicate-adjacent sorting, and an empty queue that says so explicitly.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { renderAdjudicationWorksheet } from '../scripts/lib/adjudication-worksheet.mjs';

const RUN = '93580799-977d-4fef-9465-fbe4be47213c';

function item(overrides = {}) {
  return {
    runId: RUN,
    fingerprint: 'e476d966',
    severity: 'HIGH',
    stage: 'oss-gen',
    category: 'Boundary Condition Error',
    file: '_calib/spend-guard.mjs / reserve()',
    detail: 'The guard `if (spent >= capEur)` only checks the current total spent.',
    ...overrides,
  };
}

const BASE = {
  title: 'Test worksheet',
  actions: ['accepted', 'dismissed'],
  commandFor: (it, a) => `node scripts/cross-skill.mjs model-ab-adjudicate --run-id ${it.runId} --fingerprint ${it.fingerprint} --action ${a}`,
};

describe('renderAdjudicationWorksheet — paste-ready invariants', () => {
  test('commands embed REAL run-id + fingerprint; no <placeholder> tokens anywhere in the output', () => {
    const md = renderAdjudicationWorksheet({ ...BASE, items: [item()] });
    assert.match(md, new RegExp(`--run-id ${RUN} --fingerprint e476d966 --action accepted`));
    assert.doesNotMatch(md, /<[a-z_-]+>/i, 'placeholder-looking tokens defeat the module purpose (PowerShell reserves <)');
  });

  test('a commandFor that emits a placeholder throws loudly at render time', () => {
    assert.throws(
      () => renderAdjudicationWorksheet({ ...BASE, items: [item()], commandFor: () => 'node x.mjs --run-id <id>' }),
      /placeholder-looking/,
    );
  });

  test('items sort by (file, category) so likely-duplicates sit adjacent', () => {
    const items = [
      item({ fingerprint: 'cccccccc', file: 'zzz.mjs', category: 'Z' }),
      item({ fingerprint: 'aaaaaaaa', file: '_calib/spend-guard.mjs', category: 'Boundary Condition Error' }),
      item({ fingerprint: 'bbbbbbbb', file: '_calib/spend-guard.mjs', category: 'Boundary Condition Error' }),
    ];
    const md = renderAdjudicationWorksheet({ ...BASE, items });
    const a = md.indexOf('aaaaaaaa');
    const b = md.indexOf('bbbbbbbb');
    const c = md.indexOf('cccccccc');
    assert.ok(a >= 0 && b >= 0 && c >= 0);
    assert.ok(a < b && b < c, 'same-file same-category items must be adjacent, unrelated file last');
  });

  test('empty queue renders an explicit EMPTY note, never a blank document', () => {
    const md = renderAdjudicationWorksheet({ ...BASE, items: [] });
    assert.match(md, /Queue is EMPTY/);
    assert.match(md, /nothing was silently omitted/i);
  });

  test('duplicate how-to appears only when the queue supports it', () => {
    const withDup = renderAdjudicationWorksheet({
      ...BASE, items: [item()],
      actions: ['accepted', 'dismissed', 'duplicate'],
      duplicateHowTo: { action: 'duplicate', canonicalHint: '--canonical ROOT_FINGERPRINT' },
    });
    assert.match(withDup, /## Duplicates/);
    assert.match(withDup, /--canonical ROOT_FINGERPRINT/);
    const without = renderAdjudicationWorksheet({ ...BASE, items: [item()] });
    assert.doesNotMatch(without, /## Duplicates/);
  });

  test('pure: no clock use — generatedAt only appears when the caller supplies it', () => {
    const md = renderAdjudicationWorksheet({ ...BASE, items: [item()] });
    assert.doesNotMatch(md, /Generated:/);
    const stamped = renderAdjudicationWorksheet({ ...BASE, items: [item()], generatedAt: '2026-07-02T00:00:00Z' });
    assert.match(stamped, /Generated: 2026-07-02T00:00:00Z/);
  });
});
