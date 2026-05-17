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
