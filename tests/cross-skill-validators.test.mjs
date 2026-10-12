/**
 * @fileoverview The cursor value-domain validators shared by `final-review-pending` and the two
 * /ship nudge readers (`scripts/lib/cross-skill/validators.mjs`).
 *
 * The defect pinned here (audit round 3 on the keyset change): `isPgTimestamptzText` accepted a
 * timestamp with NO UTC offset. It validated with `Date.parse` in the PROCESS timezone while the
 * query binds the same text through `::timestamptz` in the SESSION timezone, so a hand-made
 * `--after` cursor could start the keyset at a shifted instant and still look valid. Postgres'
 * `timestamptz::text` always emits an offset, so every cursor the commands issue is unaffected.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isPgTimestamptzText } from '../scripts/lib/cross-skill/validators.mjs';
import { encodeNudgeCursor, decodeNudgeCursor } from '../scripts/lib/cross-skill/commands/ship.mjs';
import { encodeQueueCursor, decodeQueueCursor } from '../scripts/lib/cross-skill/commands/final-review.mjs';

const F1 = '11111111-1111-4111-8111-111111111111';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('isPgTimestamptzText requires an explicit UTC offset', () => {
  it('accepts every offset shape Postgres or a caller can emit, with and without a fraction', () => {
    for (const good of [
      '2026-09-13 10:00:00.000001+00', '2026-09-13 10:00:00+00', '2026-09-13 10:00:00-05',
      '2026-09-13 10:00:00+05:30', '2026-09-13 10:00:00+0530', '2026-09-13T10:00:00Z', '2026-09-13T10:00:00.5Z',
    ]) assert.equal(isPgTimestamptzText(good), true, `must accept ${good}`);
  });

  it('refuses a timestamp with no offset — it would be read in two different timezones', () => {
    for (const bad of [
      '2026-09-13 10:00:00', '2026-09-13 10:00:00.000001', '2026-09-13T10:00:00', '2026-09-13T10:00:00.123456',
    ]) assert.equal(isPgTimestamptzText(bad), false, `must refuse ${bad}`);
  });

  it('control: the calendar check still refuses an impossible date that DOES carry an offset', () => {
    assert.equal(isPgTimestamptzText('2026-02-30 10:00:00+00'), false);
  });

  it('a year below 1000 is a real date: the calendar round-trip must zero-pad the year', () => {
    // `getUTCFullYear()` is 1 for year 0001; unpadded, `'1-01-01'` is never a prefix of
    // `'0001-01-01 …'`, so a valid timestamp was refused (fail-safe, but wrong).
    for (const good of ['0001-01-01 00:00:00+00', '0999-12-31 23:59:59.999999+00', '0100-06-15T12:00:00Z'])
      assert.equal(isPgTimestamptzText(good), true, `must accept ${good}`);
    assert.equal(isPgTimestamptzText('0001-02-30 00:00:00+00'), false, 'control: an impossible low-year date is still refused');
  });
});

describe('every cursor decoder refuses an offset-less timestamp as BAD_INPUT, and accepts the same instant with one', () => {
  const isBadInput = (e) => e.code === 'BAD_INPUT';

  it('list-unlocked-fixes cursor', () => {
    const tzless = b64({ v: 1, kind: 'unlocked', fixedAt: '2026-09-13 10:00:00.000001', findingId: F1 });
    assert.throws(() => decodeNudgeCursor('unlocked', tzless), isBadInput);
    assert.deepEqual(
      decodeNudgeCursor('unlocked', encodeNudgeCursor('unlocked', { fixed_at_cursor: '2026-09-13 10:00:00.000001+00', audit_finding_id: F1 })),
      { fixedAt: '2026-09-13 10:00:00.000001+00', findingId: F1 });
  });

  it('list-unremediated-acceptances cursor', () => {
    const tzless = b64({ v: 1, kind: 'unremediated', severityRank: 0, acceptedAt: '2026-09-13 10:00:00', findingId: F1 });
    assert.throws(() => decodeNudgeCursor('unremediated', tzless), isBadInput);
    assert.deepEqual(
      decodeNudgeCursor('unremediated', encodeNudgeCursor('unremediated', { severity: 'HIGH', accepted_at_cursor: '2026-09-13 10:00:00+00', audit_finding_id: F1 })),
      { severityRank: 0, acceptedAt: '2026-09-13 10:00:00+00', findingId: F1 });
  });

  it('final-review-pending cursor', () => {
    const base = { severityRank: 3, fingerprint: 'abcd1234', runId: '00000000-0000-4000-8000-000000000001', findingId: F1 };
    assert.throws(() => decodeQueueCursor(encodeQueueCursor({ ...base, createdAt: '2026-09-13 10:00:00.123456' })), isBadInput);
    assert.equal(decodeQueueCursor(encodeQueueCursor({ ...base, createdAt: '2026-09-13 10:00:00.123456+00' })).createdAt, '2026-09-13 10:00:00.123456+00');
  });
});
