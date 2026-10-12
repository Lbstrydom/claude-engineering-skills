/**
 * @fileoverview Keyset paging for the two /ship-nudge readers
 * (`list-unlocked-fixes`, `list-unremediated-acceptances`).
 *
 * The /ship workflow is "verify each row, then close it", and closing a row
 * removes it from the view. `--offset N` counts positions in a set that has
 * since shrunk, so after closing k rows of page 1, `--offset 20` skipped k
 * unread rows — while /ship's own SKILL.md told the operator its pages "neither
 * repeat nor skip a row" (audit finding 5fbd8fec). `--after <cursor>` names a
 * position in the ORDER, which a removed row cannot move.
 *
 * This file pins the command half (cursor in, cursor out, refusals) with stub
 * deps. The SQL half — that the predicate really continues strictly after the
 * cursor against Postgres, and that closing rows between reads skips nothing —
 * is `ship-nudge-keyset-db.test.mjs`, which needs a disposable database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  listUnlockedFixesCmd, listUnremediatedAcceptancesCmd, encodeNudgeCursor, decodeNudgeCursor,
} from '../scripts/lib/cross-skill/commands/ship.mjs';

const F1 = '11111111-1111-4111-8111-111111111111';
const F2 = '22222222-2222-4222-8222-222222222222';
const TS = '2026-09-13 10:00:00.000001+00';

const accRow = (id, severity, ts = TS) => ({ audit_finding_id: id, severity, accepted_at_cursor: ts });
const fixRow = (id, ts = TS) => ({ audit_finding_id: id, severity: 'HIGH', fixed_at_cursor: ts });

function makeCtx({ flags = {}, rows = [], limit = 2, seen = [] } = {}) {
  return {
    seen,
    cloud: { enabled: true },
    flag: (n) => flags[n] ?? null,
    hasFlag: (n) => flags[n] === true,
    payload: () => ({}),
    resolveScope: async () => ({ kind: 'scoped', repoId: 'repo-1', slug: 'owner/repo' }),
    deps: {
      resolveNudgePage: () => ({ limit, offset: 0 }),
      getUnremediatedAcceptances: async (_s, page) => { seen.push(page); return rows; },
      countUnremediatedAcceptances: async () => ({ total: 9, code: 9, plan: 0 }),
      countAgedUnremediatedAcceptances: async () => ({ agedOut: 0, byMode: {}, bySeverity: {}, notYetDue: 0, prePractice: 0, practiceStart: null }),
      countAcceptedPermanent: async () => 0,
      getUnlockedFixes: async (_s, page) => { seen.push(page); return rows; },
      countUnlockedFixes: async () => ({ total: 9, code: 9, plan: 0 }),
      countAgedUnlockedFixes: async () => ({ agedOut: 0, byMode: {}, prePractice: 0, practiceStart: null }),
      getRecordedSpecPaths: async () => [],
    },
  };
}

describe('cursor encoding', () => {
  it('round-trips both kinds, carrying the microsecond timestamp TEXT verbatim', () => {
    const u = decodeNudgeCursor('unlocked', encodeNudgeCursor('unlocked', fixRow(F1)));
    assert.deepEqual(u, { fixedAt: TS, findingId: F1 });
    const a = decodeNudgeCursor('unremediated', encodeNudgeCursor('unremediated', accRow(F2, 'MEDIUM')));
    assert.deepEqual(a, { severityRank: 1, acceptedAt: TS, findingId: F2 });
  });

  it('a cursor from one reader is refused by the other', () => {
    const c = encodeNudgeCursor('unlocked', fixRow(F1));
    assert.throws(() => decodeNudgeCursor('unremediated', c), (e) => e.code === 'BAD_INPUT');
  });

  for (const [label, raw] of [
    ['undecodable', '%%%not-base64%%%'],
    ['an impossible calendar date', Buffer.from(JSON.stringify({ v: 1, kind: 'unlocked', fixedAt: '2026-02-30 10:00:00+00', findingId: F1 })).toString('base64url')],
    ['a non-uuid id', Buffer.from(JSON.stringify({ v: 1, kind: 'unlocked', fixedAt: TS, findingId: 'x' })).toString('base64url')],
    ['an out-of-range severity rank', Buffer.from(JSON.stringify({ v: 1, kind: 'unremediated', severityRank: 7, acceptedAt: TS, findingId: F1 })).toString('base64url')],
  ]) {
    it(`refuses ${label} as BAD_INPUT — never a silent first page`, () => {
      const kind = label.includes('severity') ? 'unremediated' : 'unlocked';
      assert.throws(() => decodeNudgeCursor(kind, raw), (e) => e.code === 'BAD_INPUT');
    });
  }
});

describe('the commands thread --after to the store and hand back nextCursor', () => {
  it('list-unremediated-acceptances: a full page yields the LAST row as the next cursor', async () => {
    const out = await listUnremediatedAcceptancesCmd(makeCtx({ rows: [accRow(F1, 'HIGH'), accRow(F2, 'MEDIUM')] }));
    assert.deepEqual(decodeNudgeCursor('unremediated', out.nextCursor), { severityRank: 1, acceptedAt: TS, findingId: F2 });
  });

  it('…and that cursor, passed back as --after, reaches the store decoded', async () => {
    const seen = [];
    const cursor = encodeNudgeCursor('unremediated', accRow(F2, 'MEDIUM'));
    await listUnremediatedAcceptancesCmd(makeCtx({ flags: { after: cursor }, seen }));
    assert.deepEqual(seen[0].after, { severityRank: 1, acceptedAt: TS, findingId: F2 });
  });

  it('a short page is the end: nextCursor is null', async () => {
    const out = await listUnremediatedAcceptancesCmd(makeCtx({ rows: [accRow(F1, 'HIGH')] }));
    assert.equal(out.nextCursor, null);
  });

  it('list-unlocked-fixes threads the same contract', async () => {
    const seen = [];
    const out = await listUnlockedFixesCmd(makeCtx({ rows: [fixRow(F1), fixRow(F2)], seen }));
    assert.deepEqual(decodeNudgeCursor('unlocked', out.nextCursor), { fixedAt: TS, findingId: F2 });
    assert.equal(seen[0].after, null, 'no --after → first page');
  });

  it('--after with --offset is refused: two answers to "where does the page start"', async () => {
    const cursor = encodeNudgeCursor('unlocked', fixRow(F1));
    await assert.rejects(
      () => listUnlockedFixesCmd(makeCtx({ flags: { after: cursor, offset: '20' } })),
      (e) => e.code === 'BAD_INPUT',
    );
  });
});

// A reader's default is to swallow a query error and return `[]`. For a cursor walk that is
// the worst answer: an empty page reads as "no more rows", so a transient store error mid-walk
// ends the walk and the unread tail is silently never examined. The list commands therefore ask
// the reader to throw (`strict`) and surface the failure — with NO nextCursor to mistake for an end.
describe('a failed page read is a FAILURE, never the end of the list', () => {
  const failing = async () => { throw new Error('connection terminated unexpectedly'); };
  const isStoreReadFailure = (e) => e.code === 'STORE_READ_FAILED'
    && e.exitCode === 1
    && e.extra.measured === false
    && e.extra.reason === 'store-read-failed'
    && !('nextCursor' in e.extra)
    && /connection terminated unexpectedly/.test(e.message);

  const COMMANDS = [
    { name: 'list-unlocked-fixes', run: listUnlockedFixesCmd, reader: 'getUnlockedFixes', cursor: encodeNudgeCursor('unlocked', fixRow(F1)) },
    { name: 'list-unremediated-acceptances', run: listUnremediatedAcceptancesCmd, reader: 'getUnremediatedAcceptances', cursor: encodeNudgeCursor('unremediated', accRow(F1, 'HIGH')) },
  ];

  for (const { name, run, reader, cursor } of COMMANDS) {
    for (const [page, flags] of [['first page', {}], ['continuation page (--after)', { after: cursor }]]) {
      it(`${name}, ${page}: a reader error is STORE_READ_FAILED, not an empty page`, async () => {
        const ctx = makeCtx({ flags });
        ctx.deps[reader] = failing;
        await assert.rejects(() => run(ctx), isStoreReadFailure);
      });
    }

    it(`${name}: asks the reader to throw (strict) — without that the reader swallows the error`, async () => {
      const seen = [];
      await run(makeCtx({ seen }));
      assert.equal(seen[0].strict, true);
    });

    it(`${name}: CONTROL — a reader that genuinely returns no rows is still a clean end (ok, nextCursor null)`, async () => {
      const out = await run(makeCtx({ rows: [] }));
      assert.equal(out.ok, true);
      assert.equal(out.measured, true);
      assert.equal(out.nextCursor, null);
    });
  }
});

// The SKILL.md example is what an agent copies. A placeholder that does not decode makes the
// documented command fail BAD_INPUT on the first try — and nothing else reads that prose.
describe('skills/ship/SKILL.md: the documented --after example is a cursor the command accepts', () => {
  const skill = readFileSync(new URL('../skills/ship/SKILL.md', import.meta.url), 'utf8');

  it('list-unremediated-acceptances: every --after literal decodes', () => {
    const examples = [...skill.matchAll(/list-unremediated-acceptances[^\n]*--after\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    assert.ok(examples.length > 0, 'no --after example found — the probe cannot see (vacuous-pass guard)');
    for (const raw of examples) assert.doesNotThrow(() => decodeNudgeCursor('unremediated', raw), `example cursor ${raw}`);
  });
});
