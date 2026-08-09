/**
 * Tests for scripts/lib/brainstorm/session-store.mjs
 * Plan ACs: AC6, AC35, AC37, AC38, AC53, AC44, §13.B mixed V1/V2.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendSession, loadSession, pruneOldSessions, summariseRound, __test__ } from '../scripts/lib/brainstorm/session-store.mjs';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-session-'));
}

function mkV2Envelope({ topic = 't', sid = 'sid-x' } = {}) {
  return {
    topic, redactionCount: 0, resolvedModels: { openai: 'gpt-x' },
    providers: [{ provider: 'openai', state: 'success', text: 'ok', errorMessage: null, httpStatus: null, usage: null, latencyMs: 0, estimatedCostUsd: null }],
    totalCostUsd: 0,
    sid,
    capturedAt: new Date().toISOString(),
    schemaVersion: 2,
    // Arch-context fields — WriteSchema (validated by appendSession) requires them.
    archContextAttached: false, archContextChars: 0, archContextWarning: null,
  };
}

describe('appendSession + loadSession round-trip', () => {
  it('appends to a new session, assigns round=0', async () => {
    const root = mkTmp();
    const r = await appendSession({ sid: 's1', envelope: mkV2Envelope({ sid: 's1' }), root });
    assert.equal(r.round, 0);
    const loaded = loadSession('s1', { root });
    assert.equal(loaded.rounds.length, 1);
    assert.equal(loaded.rounds[0].round, 0);
    assert.equal(loaded.rounds[0].topic, 't');
  });

  it('appends sequentially — rounds 0, 1, 2', async () => {
    const root = mkTmp();
    for (let i = 0; i < 3; i++) {
      const r = await appendSession({ sid: 's2', envelope: mkV2Envelope({ sid: 's2', topic: `t${i}` }), root });
      assert.equal(r.round, i);
    }
    const loaded = loadSession('s2', { root });
    assert.deepEqual(loaded.rounds.map(r => r.round), [0, 1, 2]);
  });

  it('AC53 — concurrent appends to same sid produce distinct rounds', async () => {
    const root = mkTmp();
    const promises = Array.from({ length: 5 }, (_, i) =>
      appendSession({ sid: 's3', envelope: mkV2Envelope({ sid: 's3', topic: `t${i}` }), root })
    );
    const results = await Promise.all(promises);
    const rounds = results.map(r => r.round).sort((a, b) => a - b);
    assert.deepEqual(rounds, [0, 1, 2, 3, 4], 'rounds must be unique 0..4 with no duplicates');
  });
});

describe('loadSession — V1 → V2 normalisation (§13.B)', () => {
  it('V1 line (no schemaVersion) gets file-index round + _synthesised', () => {
    const root = mkTmp();
    fs.mkdirSync(path.join(root), { recursive: true });
    const file = __test__.sessionPath('legacy', root);
    const v1Line = JSON.stringify({
      topic: 'legacy-1', redactionCount: 0, resolvedModels: {},
      providers: [], totalCostUsd: 0,
    });
    fs.writeFileSync(file, v1Line + '\n');
    const loaded = loadSession('legacy', { root });
    assert.equal(loaded.rounds.length, 1);
    assert.equal(loaded.rounds[0].round, 0);
    assert.equal(loaded.rounds[0].schemaVersion, 2);
    assert.deepEqual(loaded.rounds[0]._synthesised.fields, ['sid', 'round', 'schemaVersion', 'capturedAt']);
  });

  it('multiple V1 lines get distinct file-index rounds 0,1,2 (not all collapsed to 0)', () => {
    const root = mkTmp();
    const file = __test__.sessionPath('multi', root);
    const v1Line = (i) => JSON.stringify({
      topic: `t${i}`, redactionCount: 0, resolvedModels: {},
      providers: [], totalCostUsd: 0,
    });
    fs.writeFileSync(file, [v1Line(0), v1Line(1), v1Line(2)].join('\n') + '\n');
    const loaded = loadSession('multi', { root });
    assert.equal(loaded.rounds.length, 3);
    assert.deepEqual(loaded.rounds.map(r => r.round), [0, 1, 2]);
  });

  it('AC53 mixed V1/V2 — appending to a 3-V1-line session yields V2 with round=3', async () => {
    const root = mkTmp();
    const file = __test__.sessionPath('mixed', root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const v1Line = (i) => JSON.stringify({ topic: `v1-${i}`, redactionCount: 0, resolvedModels: {}, providers: [], totalCostUsd: 0 });
    fs.writeFileSync(file, [v1Line(0), v1Line(1), v1Line(2)].join('\n') + '\n');
    const r = await appendSession({ sid: 'mixed', envelope: mkV2Envelope({ sid: 'mixed', topic: 'v2-new' }), root });
    assert.equal(r.round, 3);
    const loaded = loadSession('mixed', { root });
    assert.equal(loaded.rounds.length, 4);
    assert.equal(loaded.rounds[3].round, 3);
    assert.equal(loaded.rounds[3].topic, 'v2-new');
  });
});

describe('loadSession — invalid line quarantine (AC44)', () => {
  it('skips invalid lines + quarantines them; valid lines preserved', () => {
    const root = mkTmp();
    const file = __test__.sessionPath('q1', root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const validLine = JSON.stringify({
      topic: 'good', redactionCount: 0, resolvedModels: {}, providers: [], totalCostUsd: 0,
      sid: 'q1', round: 0, schemaVersion: 2, capturedAt: new Date().toISOString(),
    });
    const invalidLine = '{not-valid-json';
    fs.writeFileSync(file, [validLine, invalidLine, validLine].join('\n') + '\n');
    const loaded = loadSession('q1', { root });
    assert.equal(loaded.rounds.length, 2);  // 2 valid
    assert.equal(loaded.invalidCount, 1);
    const quarantineFile = __test__.quarantinePath('q1', root);
    assert.ok(fs.existsSync(quarantineFile), 'quarantine file should exist');
  });
});

describe('summariseRound — deterministic head/tail', () => {
  it('truncates long provider responses', () => {
    const round = mkV2Envelope({ sid: 's', topic: 'x' });
    round.round = 0;
    round.providers[0].text = 'a'.repeat(1000);
    const out = summariseRound(round);
    assert.ok(out.length < 1000, 'summary must be shorter than full text');
    assert.match(out, /…/, 'must include ellipsis marker for truncation');
  });
});

describe('pruneOldSessions — best-effort housekeeping', () => {
  it('does nothing on empty dir', async () => {
    const root = mkTmp();
    const n = await pruneOldSessions(30, { root });
    assert.equal(n, 0);
  });

  it('respects 24h sentinel — second call within 24h is a no-op', async () => {
    const root = mkTmp();
    fs.mkdirSync(root, { recursive: true });
    // Create one stale session
    const file = __test__.sessionPath('old', root);
    fs.writeFileSync(file, '{}\n');
    const oldMtime = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, oldMtime, oldMtime);
    const n1 = await pruneOldSessions(30, { root });
    assert.ok(n1 >= 0);
    // Sentinel created — second call within 24h should skip
    const n2 = await pruneOldSessions(30, { root });
    assert.equal(n2, 0);
  });
});

// ── __test__.appendQuarantine — failure contract (atomic-write-adoption plan) ──
// Deterministic, cross-platform fault: point root's ancestor at a FILE, not a
// directory. atomicWriteFileSync's internal mkdirSync then throws ENOTDIR
// every time, on every platform — no OS permissions involved.

describe('appendQuarantine — failure contract', () => {
  it('does not throw and logs a WARN when the write fails', () => {
    const parent = mkTmp();
    const blocker = path.join(parent, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const root = path.join(blocker, 'nested');

    const originalWrite = process.stderr.write;
    let warned = '';
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      assert.doesNotThrow(() => {
        __test__.appendQuarantine('sid1', [{ lineIdx: 0, raw: 'bad', reason: 'test' }], root);
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.match(warned, /cannot prepare quarantine dir/);
  });

  it('does not throw and logs a WARN when an existing quarantine file cannot be read (EISDIR)', () => {
    const root = mkTmp();
    fs.mkdirSync(root, { recursive: true });
    // qPath exists but as a directory, not a file — fs.readFileSync throws
    // EISDIR deterministically, exercising the OTHER pre-existing swallow
    // path (independent of the ensureDir fix above and of the
    // atomicWriteFileSync delegation, which the guard test + the existing
    // happy-path suite already cover).
    const qPath = __test__.quarantinePath('sid2', root);
    fs.mkdirSync(qPath, { recursive: true });

    const originalWrite = process.stderr.write;
    let warned = '';
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      assert.doesNotThrow(() => {
        __test__.appendQuarantine('sid2', [{ lineIdx: 0, raw: 'bad', reason: 'test' }], root);
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.match(warned, /cannot read quarantine/);
  });
});

// ── Phase 4: the §2 three-way schemaVersion table ──────────────────────────
//
// docs/plans/learning-persona-quickfix-honest-failure.md §2 item 4. The old
// branch was two-way in effect: `=== 2` -> V2, numeric `> 2` -> quarantine,
// EVERYTHING ELSE -> V1 synthesis. So `"3"`, `null`, `false`, `{}` and `[]`
// were routed down the V1 path and stamped `_synthesised` — a record the
// loader could not interpret was accepted AND affirmatively mislabelled as a
// legacy record it is not. Key-absence is the correct V1 test: across the 43
// live records in .brainstorm/sessions/, 0 lack the key and 43 carry exactly
// 2, and a V1 writer never wrote the field at all.

function mkBaseLine(extra) {
  return JSON.stringify({
    topic: 'x', redactionCount: 0, resolvedModels: {}, providers: [],
    totalCostUsd: 0, sid: 'sv', round: 0, capturedAt: new Date().toISOString(),
    ...extra,
  });
}

function quietLoad(line, sid = 'sv') {
  const root = mkTmp();
  const file = __test__.sessionPath(sid, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, line + '\n');
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    return { loaded: loadSession(sid, { root }), root };
  } finally {
    process.stderr.write = originalWrite;
  }
}

describe('loadSession — schemaVersion three-way table (plan section 2, item 4)', () => {
  const UNSUPPORTED = [
    ['numeric 3', 3],
    ['string "3"', '3'],
    ['null', null],
    ['false', false],
    ['an object', {}],
    ['an array', []],
  ];

  for (const [label, value] of UNSUPPORTED) {
    it(`quarantines ${label} instead of mislabelling it as a synthesised V1`, () => {
      const { loaded, root } = quietLoad(mkBaseLine({ schemaVersion: value }));
      assert.equal(loaded.rounds.length, 0, `${label} must not be interpreted`);
      assert.equal(loaded.invalidCount, 1);
      assert.equal(
        loaded.synthesisedCount, 0,
        'a record the loader cannot interpret must NOT be counted as a synthesised V1',
      );
      const q = fs.readFileSync(__test__.quarantinePath('sv', root), 'utf-8');
      assert.match(
        q, /unsupported-schema-version/,
        'the reason must name the unsupported version, not blame the JSON',
      );
    });
  }

  it('a key-absent record is still synthesised as V1 (backward compat)', () => {
    const { loaded } = quietLoad(mkBaseLine({}));
    assert.equal(loaded.rounds.length, 1);
    assert.equal(loaded.synthesisedCount, 1);
    assert.deepEqual(
      loaded.rounds[0]._synthesised.fields,
      ['sid', 'round', 'schemaVersion', 'capturedAt'],
    );
  });

  it('schemaVersion 2 is validated as V2 and never stamped _synthesised', () => {
    const { loaded } = quietLoad(mkBaseLine({ schemaVersion: 2 }));
    assert.equal(loaded.rounds.length, 1);
    assert.equal(loaded.synthesisedCount, 0);
    assert.equal(
      loaded.rounds[0]._synthesised, undefined,
      '_synthesised must be stamped ONLY on records genuinely synthesised from V1',
    );
  });
});

// ── Phase 4: appendQuarantine is locked and never lies ─────────────────────
//
// R1-H1: an append-only design does NOT close this race. O_APPEND serialises
// appends against other APPENDS to the same inode; it gives no protection
// against the trim, which reads a snapshot then rename()s a replacement over
// the file. An append landing after the trim's read but before its rename
// goes to the OLD inode and vanishes. So every mutation participates in ONE
// lock, and a caller that cannot acquire it is TOLD so rather than being let
// believe it recorded something.

function holdQuarantineLock(sid, root) {
  fs.mkdirSync(path.dirname(__test__.sessionPath(sid, root)), { recursive: true });
  // A live holder — our own pid, so the stale-recovery path cannot fire and
  // this is genuine contention rather than an abandoned lock.
  fs.writeFileSync(__test__.quarantineLockPath(sid, root), JSON.stringify({
    pid: process.pid, token: 'held-by-someone-else', acquiredAt: new Date().toISOString(),
  }));
}

function quietly(fn) {
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try { return fn(); } finally { process.stderr.write = originalWrite; }
}

describe('appendQuarantine — typed, non-throwing contention contract', () => {
  it('returns {recorded:true, count} on the uncontended path', () => {
    const root = mkTmp();
    const r = quietly(() => __test__.appendQuarantine(
      'lock-ok', [{ lineIdx: 0, raw: 'x', reason: 'test' }], root,
    ));
    assert.equal(r.recorded, true);
    assert.equal(typeof r.count, 'number');
  });

  it('declines with {recorded:false, reason:"lock-contention"} while the lock is held', () => {
    const root = mkTmp();
    const sid = 'lock-contended';
    holdQuarantineLock(sid, root);
    const qPath = __test__.quarantinePath(sid, root);
    const before = JSON.stringify({ lineIdx: 0, raw: 'pre-existing', reason: 'earlier' }) + '\n';
    fs.writeFileSync(qPath, before);

    const r = quietly(() => __test__.appendQuarantine(
      sid, [{ lineIdx: 1, raw: 'y', reason: 'test' }], root,
    ));

    assert.equal(r.recorded, false, 'it must not claim to have recorded a line it did not write');
    assert.equal(r.reason, 'lock-contention');
    assert.equal(
      fs.readFileSync(qPath, 'utf-8'), before,
      'a declined append must leave the file byte-intact',
    );
  });

  it('never throws on contention (the caller contract is never-throw)', () => {
    const root = mkTmp();
    const sid = 'lock-nothrow';
    holdQuarantineLock(sid, root);
    quietly(() => assert.doesNotThrow(
      () => __test__.appendQuarantine(sid, [{ lineIdx: 0, raw: 'z', reason: 'r' }], root),
    ));
  });

  it('enforces the cap inside the same critical section as the append', () => {
    const root = mkTmp();
    const sid = 'cap';
    const cap = __test__.QUARANTINE_CAP;
    quietly(() => {
      for (let i = 0; i < cap + 10; i += 1) {
        __test__.appendQuarantine(sid, [{ lineIdx: i, raw: 'x', reason: 'r' }], root);
      }
    });
    const lines = fs.readFileSync(__test__.quarantinePath(sid, root), 'utf-8')
      .split('\n').filter(Boolean);
    assert.equal(lines.length, cap, 'the cap must hold — trim is not a separate unlocked pass');
    // Survivors must be the NEWEST, proving the trim kept the tail.
    assert.equal(JSON.parse(lines[lines.length - 1]).lineIdx, cap + 9);
  });

  it('loadSession surfaces a declined quarantine write in its warning line', () => {
    const root = mkTmp();
    const sid = 'q-declined';
    const file = __test__.sessionPath(sid, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not-valid-json\n');
    holdQuarantineLock(sid, root);

    let warned = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      loadSession(sid, { root });
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.match(
      warned, /lock-contention|not recorded/,
      'silently dropping the quarantine line is exactly the lie this plan removes',
    );
  });
});
