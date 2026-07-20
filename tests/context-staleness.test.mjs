/**
 * Tier 1 (deterministic seam) — the pure staleness core.
 * Plan/rationale: scripts/lib/context-staleness.mjs header.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  citationsInLine,
  computeStaleness,
  ackKey,
  unverifiableReason,
  DEFAULT_THRESHOLD_DAYS,
} from '../scripts/lib/context-staleness.mjs';

const KNOWN = new Set([
  'scripts/learning-store.mjs',
  'scripts/cross-skill.mjs',
  'scripts/lib/model-resolver.mjs',
  'scripts/openai-audit.mjs',
  'tests/sensitive-egress.test.mjs',
]);
const resolve = (p) => KNOWN.has(p);

const d = (iso) => new Date(iso);

describe('citationsInLine', () => {
  test('finds a backticked qualified path', () => {
    assert.deepEqual(
      citationsInLine('see `scripts/cross-skill.mjs` for detail', resolve),
      ['scripts/cross-skill.mjs'],
    );
  });

  test('finds a markdown-link path', () => {
    assert.deepEqual(
      citationsInLine('All calls go through [x](scripts/lib/model-resolver.mjs).', resolve),
      ['scripts/lib/model-resolver.mjs'],
    );
  });

  // The grammar the stale "Script Responsibilities" bullets actually used.
  test('resolves a bolded BARE module name against scripts/ then scripts/lib/', () => {
    assert.deepEqual(
      citationsInLine('- **learning-store.mjs**: Cloud persistence via Supabase', resolve),
      ['scripts/learning-store.mjs'],
    );
    assert.deepEqual(
      citationsInLine('- **model-resolver.mjs** does the thing', resolve),
      ['scripts/lib/model-resolver.mjs'],
    );
  });

  test('ignores a path that does not resolve — no invented citations', () => {
    assert.deepEqual(citationsInLine('see `scripts/ghost.mjs`', resolve), []);
    assert.deepEqual(citationsInLine('- **ghost.mjs** is great', resolve), []);
  });

  test('ignores prose with no citation at all', () => {
    assert.deepEqual(citationsInLine('This is a design rule about testing.', resolve), []);
  });

  test('de-duplicates a path cited twice on one line', () => {
    const line = '`scripts/cross-skill.mjs` and again `scripts/cross-skill.mjs`';
    assert.deepEqual(citationsInLine(line, resolve), ['scripts/cross-skill.mjs']);
  });
});

describe('computeStaleness', () => {
  const base = {
    lines: [
      '- **learning-store.mjs**: Cloud persistence via Supabase',   // stale
      'writes go through `scripts/cross-skill.mjs`',                // fresh
      'plain prose with no citation',
    ],
    lineDates: [d('2026-04-01'), d('2026-07-19'), d('2026-01-01')],
    pathDates: new Map([
      ['scripts/learning-store.mjs', d('2026-07-15')],
      ['scripts/cross-skill.mjs', d('2026-07-20')],
    ]),
    resolve,
  };

  test('flags a line whose cited code moved long after it did', () => {
    const r = computeStaleness(base);
    assert.equal(r.flagged.length, 1);
    assert.equal(r.flagged[0].lineNumber, 1);
    assert.equal(r.flagged[0].path, 'scripts/learning-store.mjs');
    assert.ok(r.flagged[0].driftDays > 100, `expected >100d, got ${r.flagged[0].driftDays}`);
  });

  test('does NOT flag a line whose code moved only just after it', () => {
    const r = computeStaleness(base);
    assert.ok(!r.flagged.some((x) => x.path === 'scripts/cross-skill.mjs'));
  });

  // Direction matters: code changing BEFORE the prose is not staleness.
  test('code older than the line is never drift', () => {
    const r = computeStaleness({
      ...base,
      lineDates: [d('2026-07-20'), d('2026-07-20'), d('2026-07-20')],
    });
    assert.equal(r.rows.length, 0);
  });

  test('rows are ranked worst-first', () => {
    const r = computeStaleness({
      lines: ['a `scripts/cross-skill.mjs`', 'b `scripts/openai-audit.mjs`'],
      lineDates: [d('2026-07-01'), d('2026-01-01')],
      pathDates: new Map([
        ['scripts/cross-skill.mjs', d('2026-07-10')],
        ['scripts/openai-audit.mjs', d('2026-07-10')],
      ]),
      resolve,
    });
    assert.ok(r.rows[0].driftDays > r.rows[1].driftDays);
  });

  // `rows` is every line with ANY drift; `flagged` is the subset over the
  // threshold. Keeping both means raising the threshold hides nothing — it
  // only changes what gets a human's attention.
  test('the threshold narrows `flagged` without discarding `rows`', () => {
    const wide = computeStaleness({ ...base, thresholdDays: 1 });
    assert.equal(wide.flagged.length, 2, 'both drifting lines are over a 1-day bar');

    const narrow = computeStaleness({ ...base, thresholdDays: 999 });
    assert.equal(narrow.flagged.length, 0);
    assert.equal(narrow.rows.length, 2, 'still reported, just not flagged');
  });

  test('a line with no recorded date is skipped, not crashed on', () => {
    const r = computeStaleness({ ...base, lineDates: [null, null, null] });
    assert.equal(r.rows.length, 0);
    assert.equal(r.coverage.datedLines, 0);
  });
});

describe('acknowledgements', () => {
  const one = {
    lines: ['- **learning-store.mjs**: Cloud persistence via Supabase'],
    lineDates: [d('2026-04-01')],
    pathDates: new Map([['scripts/learning-store.mjs', d('2026-07-15')]]),
    resolve,
  };

  test('an acked line moves out of flagged into suppressed', () => {
    const key = ackKey(one.lines[0], 'scripts/learning-store.mjs');
    const r = computeStaleness({ ...one, acked: new Set([key]) });
    assert.equal(r.flagged.length, 0);
    assert.equal(r.suppressed.length, 1);
  });

  /**
   * The property that stops this becoming a rotting allowlist: the key is the
   * line's TEXT, so editing the line voids its ack automatically. A changed
   * line has by definition been re-examined.
   */
  test('an ack SELF-INVALIDATES when the line text changes', () => {
    const key = ackKey(one.lines[0], 'scripts/learning-store.mjs');
    const edited = { ...one, lines: ['- **learning-store.mjs**: a barrel over lib/store/'] };
    const r = computeStaleness({ ...edited, acked: new Set([key]) });
    assert.equal(r.suppressed.length, 0, 'the old ack must not carry over');
    assert.equal(r.flagged.length, 1, 'the edited line is re-flagged for review');
  });

  test('an ack is line-number independent, so reflowing the file keeps it', () => {
    const key = ackKey(one.lines[0], 'scripts/learning-store.mjs');
    const shifted = {
      ...one,
      lines: ['header', '', ...one.lines],
      lineDates: [d('2026-07-20'), d('2026-07-20'), d('2026-04-01')],
    };
    const r = computeStaleness({ ...shifted, acked: new Set([key]) });
    assert.equal(r.suppressed.length, 1);
  });
});

describe('gate honesty — a run that checked nothing must not read clean', () => {
  test('zero citing lines is unverifiable, not healthy', () => {
    const r = computeStaleness({
      lines: ['prose', 'more prose'],
      lineDates: [d('2026-01-01'), d('2026-01-01')],
      pathDates: new Map(),
      resolve,
    });
    assert.equal(r.flagged.length, 0, 'nothing flagged…');
    assert.match(unverifiableReason(r.coverage), /citation grammar matched nothing/);
  });

  test('zero line dates is unverifiable — the blame adapter returned nothing', () => {
    const r = computeStaleness({
      lines: ['a `scripts/cross-skill.mjs`'],
      lineDates: [null],
      pathDates: new Map([['scripts/cross-skill.mjs', d('2026-07-20')]]),
      resolve,
    });
    assert.match(unverifiableReason(r.coverage), /blame adapter/);
  });

  test('an empty file is unverifiable', () => {
    const r = computeStaleness({ lines: [], lineDates: [], pathDates: new Map(), resolve });
    assert.match(unverifiableReason(r.coverage), /empty or unreadable/);
  });

  test('a genuinely conclusive run returns no reason', () => {
    const r = computeStaleness({
      lines: ['a `scripts/cross-skill.mjs`'],
      lineDates: [d('2026-07-19')],
      pathDates: new Map([['scripts/cross-skill.mjs', d('2026-07-20')]]),
      resolve,
    });
    assert.equal(unverifiableReason(r.coverage), null);
  });
});

test('the default threshold is the documented 60 days', () => {
  assert.equal(DEFAULT_THRESHOLD_DAYS, 60);
});
