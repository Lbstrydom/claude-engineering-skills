/**
 * @fileoverview The column-probe cache holds SCHEMA OBSERVATIONS only.
 *
 * `column-probes.mjs` promises that "only a DEFINITIVE answer is cached". A probe
 * that never ran because the cloud store was off is not an observation, so caching
 * its `false` made "not asked" outlive the store coming up: every later call in the
 * process read "column absent" and the writers silently dropped that column.
 * No database needed — `manyFn` / `cloudFn` are the module's own seams.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  probeColumnExistence, columnExists, detectClassificationColumns,
  _resetRunReadColumnCache, _resetClassificationColumnCache,
} from '../scripts/lib/store/column-probes.mjs';

beforeEach(() => {
  _resetRunReadColumnCache();
  _resetClassificationColumnCache();
});

const present = async () => [];
const absent = async () => { throw Object.assign(new Error('column "x" does not exist'), { code: '42703' }); };
const flaky = async () => { throw Object.assign(new Error('connection reset'), { code: '57P01' }); };
const on = async () => true;
const off = async () => false;

function counting(fn) {
  const wrapped = async (...a) => { wrapped.calls += 1; return fn(...a); };
  wrapped.calls = 0;
  return wrapped;
}

test('cloud off is answered but NOT cached: the same column probes for real once the store is up', async () => {
  assert.deepEqual(await probeColumnExistence('audit_findings', 'bucket', present, off), { present: false, definitive: true });
  assert.deepEqual(await probeColumnExistence('audit_findings', 'bucket', present, on), { present: true, definitive: true },
    'a cached cloud-off false would have answered absent here without probing');
});

test('NEGATIVE CONTROL: a CONFIRMED-absent column IS cached (the cache still works)', async () => {
  const many = counting(absent);
  assert.deepEqual(await probeColumnExistence('audit_findings', 'bucket', many, on), { present: false, definitive: true });
  const afterFirst = many.calls;
  assert.ok(afterFirst >= 1, 'vacuous-pass guard: the probe must actually have run');
  assert.deepEqual(await probeColumnExistence('audit_findings', 'bucket', many, on), { present: false, definitive: true });
  assert.equal(many.calls, afterFirst, 'the second call is served from the cache');
});

test('an exhausted TRANSIENT probe is unresolved and is not cached either', async () => {
  assert.deepEqual(await probeColumnExistence('audit_findings', 'bucket', flaky, on), { present: false, definitive: false });
  assert.deepEqual(await probeColumnExistence('audit_findings', 'bucket', present, on), { present: true, definitive: true },
    'the next call re-probes rather than reusing the blip');
  assert.equal(await columnExists('audit_findings', 'bucket', present, on), true);
});

test('detectClassificationColumns: cloud off is not cached; a later cloud-on call probes', async () => {
  assert.equal(await detectClassificationColumns(present, off), false);
  assert.equal(await detectClassificationColumns(present, on), true,
    'a cached false from the cloud-off call would have been returned here');
});

test('detectClassificationColumns: a confirmed-absent answer is cached', async () => {
  const many = counting(absent);
  assert.equal(await detectClassificationColumns(many, on), false);
  const afterFirst = many.calls;
  assert.ok(afterFirst >= 1);
  assert.equal(await detectClassificationColumns(many, on), false);
  assert.equal(many.calls, afterFirst);
});
