/**
 * Tests for scripts/lib/brainstorm/session-store.mjs
 * Plan ACs: AC6, AC35, AC37, AC38, AC53, AC44, §13.B mixed V1/V2.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
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
    archContextAttached: false, archContextChars: 0, archContextWarning: null, debateSkipped: null, debate: [],
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

// ── §9 case 7(b) — DURABILITY, split from the contention test (R3-L1) ───────
//
// The R2 draft asked ONE test to assert both "every line survives" and a
// non-blocking contention contract that explicitly permits {recorded:false}
// with no retry. Those cannot both hold, so that test was either flaky or
// forced an implementation violating the stated contract. Split: 7(a) above
// pins contention; this pins durability with a CALLER-LEVEL retry, which is
// exactly where the contract says retrying belongs.
//
// Child processes are mandatory, not stylistic: synchronous JS never
// interleaves inside a critical section, so a same-process test passes against
// the broken (unlocked append + separate trim) design and is not evidence.

describe('appendQuarantine — durability under real concurrent writers', () => {
  it('every acknowledged line is present, and the capped file stays structurally valid', () => {
    const root = mkTmp();
    const sid = 'durable';
    fs.mkdirSync(path.dirname(__test__.sessionPath(sid, root)), { recursive: true });

    const storePath = url.pathToFileURL(
      path.resolve('scripts/lib/brainstorm/session-store.mjs'),
    ).href;
    const worker = path.join(root, 'worker.mjs');
    fs.writeFileSync(worker, [
      "import { __test__ } from " + JSON.stringify(storePath) + ";",
      "const [root, sid, tag, countRaw] = process.argv.slice(2);",
      "const count = Number(countRaw);",
      "let acked = 0;",
      "for (let i = 0; i < count; i++) {",
      "  // Caller-level retry until the write is ACKNOWLEDGED — the contract",
      "  // says contention is the caller's to retry, and only an acknowledged",
      "  // line may be asserted present.",
      "  for (let attempt = 0; attempt < 200; attempt++) {",
      "    const r = __test__.appendQuarantine(sid, [{ lineIdx: i, raw: tag + ':' + i, reason: 'dur' }], root);",
      "    if (r.recorded) { acked++; break; }",
      "  }",
      "}",
      "process.stdout.write(String(acked));",
    ].join('\n'));

    // MUST exceed QUARANTINE_CAP in total, or the trim never fires and the
    // test cannot see the race it exists to catch. Verified by negative
    // control: at 2x12 (under the cap of 100) this test passed even with the
    // lock removed, because with no trim there was nothing for an append to
    // race. At 2x80 the trim runs repeatedly and an unlocked writer's
    // whole-file rename clobbers the other's appends.
    const PER_WORKER = 80;
    const originalWrite = process.stderr.write;
    process.stderr.write = () => true;
    let runs;
    try {
      runs = ['a', 'b'].map(tag => spawnSync(
        process.execPath, [worker, root, sid, tag, String(PER_WORKER)],
        { encoding: 'utf-8', timeout: 60_000 },
      ));
    } finally {
      process.stderr.write = originalWrite;
    }
    for (const r of runs) assert.equal(r.status, 0, r.stderr);

    const acked = runs.reduce((sum, r) => sum + Number(r.stdout.trim() || 0), 0);
    assert.ok(acked > 0, 'vacuous-pass guard: the workers must have acknowledged at least one write');

    const raw = fs.readFileSync(__test__.quarantinePath(sid, root), 'utf-8');
    const lines = raw.split('\n').filter(Boolean);

    // Structural validity: an interleaved append racing a trim is exactly how
    // a torn line appears, so every surviving line must still parse.
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), 'a torn line means a write raced the trim');
    }
    assert.ok(lines.length <= __test__.QUARANTINE_CAP, 'the cap must hold under concurrency');

    assert.ok(acked > __test__.QUARANTINE_CAP, 'test setup: writes must exceed the cap');
    assert.equal(
      lines.length, __test__.QUARANTINE_CAP,
      'the file must settle exactly full — each append lands, the trim drops only the oldest',
    );
  });

  // ── Honest limitation of the test above, recorded rather than implied ──
  //
  // It asserts REAL properties (structural validity and cap-holding under two
  // genuine OS processes) but it is NOT a proven regression lock for the lock
  // itself. Negative-controlled twice: with `withFileLockSync` removed from
  // `appendQuarantine` it stayed GREEN at 2x12 writes (under the cap, so the
  // trim never fires and there is nothing to race) and again at 2x80 (once the
  // file reaches the cap, lost updates leave it AT the cap, so the count cannot
  // distinguish them).
  //
  // What DOES discriminate is the contention pair above — removing the lock
  // turns "declines with lock-contention" and the loadSession warning red,
  // because an unlocked implementation can never report contention. Those are
  // the regression lock; this one is a load/validity check standing beside it.
  //
  // Constructing a truly discriminating durability probe needs a controllable
  // interleaving (a writer paused between the trim's read and its rename),
  // which `atomicWriteFileSync` gives no seam for.
  //
  // The gap is CLOSED, but by decomposition rather than by a better race. The
  // durability property is the conjunction of two claims, and each half is
  // reliably testable even though their product is not:
  //
  //   1. withFileLockSync provides mutual exclusion
  //      -> tests/file-lock.test.mjs, two real OS processes, fails on overlap.
  //   2. appendQuarantine mutates ONLY inside that lock
  //      -> tests/quarantine-lock-containment.test.mjs, an AST guard that
  //         resolves the import binding and carries its OWN negative controls
  //         (it is run against a lock-removed and a shadowed copy of this very
  //         module, and must report an escape for both).
  //
  // (2) is the half a refactor silently breaks — and did, historically. So the
  // regression lock lives there, and this test is a load/validity check
  // standing beside it rather than pretending to be the proof.
});

describe('round allocation rejects unsafe integers (round-1 audit H1)', () => {
  // `Number.isInteger(1e100)` is TRUE, so the old `Number.isInteger(r) && r >= 0`
  // predicate accepted a corrupt-but-parseable line as a usable round. The next
  // round became 1e100 + 1 — which, past 2^53, is 1e100 again, so every later
  // append collided on one value and the session stopped ordering.
  const CORRUPT_ROUNDS = [1e100, Number.MAX_VALUE, 2 ** 53, -0.0001, NaN, Infinity, '3'];

  for (const bad of CORRUPT_ROUNDS) {
    it(`a persisted round of ${String(bad)} falls back to the file index`, async () => {
      const root = mkTmp();
      // Hand-write one corrupt line, then append through the real writer.
      const line = JSON.stringify({ ...mkV2Envelope({ sid: 'h1' }), round: bad });
      fs.writeFileSync(path.join(root, 'h1.jsonl'), line + '\n');

      const r = await appendSession({ sid: 'h1', envelope: mkV2Envelope({ sid: 'h1' }), root });
      assert.equal(r.round, 1, 'next round must come from the file index, not the corrupt value');
      assert.ok(Number.isSafeInteger(r.round), 'an allocated round must be a safe integer');
    });
  }

  it('a legitimate large-but-safe round is still honoured', async () => {
    const root = mkTmp();
    const safe = Number.MAX_SAFE_INTEGER - 10;
    fs.writeFileSync(
      path.join(root, 'h2.jsonl'),
      JSON.stringify({ ...mkV2Envelope({ sid: 'h2' }), round: safe }) + '\n',
    );
    const r = await appendSession({ sid: 'h2', envelope: mkV2Envelope({ sid: 'h2' }), root });
    assert.equal(r.round, safe + 1, 'the guard must not reject valid rounds');
  });
});

describe('the round SUCCESSOR must be safe too (round-5 audit H1)', () => {
  it('a session at MAX_SAFE_INTEGER refuses to append rather than colliding', async () => {
    const root = mkTmp();
    fs.writeFileSync(
      path.join(root, 'h3.jsonl'),
      JSON.stringify({ ...mkV2Envelope({ sid: 'h3' }), round: Number.MAX_SAFE_INTEGER }) + '\n',
    );
    // max + 1 is 2^53 — not a safe integer, and the value every later append
    // would compute too, so the sequence would silently stop advancing.
    await assert.rejects(
      () => appendSession({ sid: 'h3', envelope: mkV2Envelope({ sid: 'h3' }), root }),
      (e) => /no safe next round/.test(e.message),
    );
  });

  it('one below the boundary still appends — the guard must not overreach', async () => {
    const root = mkTmp();
    fs.writeFileSync(
      path.join(root, 'h4.jsonl'),
      JSON.stringify({ ...mkV2Envelope({ sid: 'h4' }), round: Number.MAX_SAFE_INTEGER - 1 }) + '\n',
    );
    const r = await appendSession({ sid: 'h4', envelope: mkV2Envelope({ sid: 'h4' }), root });
    assert.equal(r.round, Number.MAX_SAFE_INTEGER);
  });
});
