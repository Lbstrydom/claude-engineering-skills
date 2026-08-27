/**
 * @fileoverview A session file may only yield records belonging to that session.
 *
 * Guards the audit finding "Missing owner/session scoping": the session path's
 * `sid` is the row-scope key, but a schema-valid V2 record was accepted purely
 * on `BrainstormEnvelopeV2Schema` — which validates that `sid` is a non-empty
 * string, never that it is THIS session's. A record naming a different session
 * (a copied file, a mis-targeted append, a backup restored under the wrong name)
 * was loaded into this session's rounds and shifted every subsequent round
 * number, so the corruption was silent and cumulative rather than visible.
 *
 * Quarantined rather than dropped: the mismatch stays inspectable, which is the
 * same treatment this loader already gives structurally-invalid records.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSession } from '../scripts/lib/brainstorm/session-store.mjs';

let root;
beforeEach(() => {
  // `root` IS the session directory (see sessionDir()), not its parent.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-sid-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

const SID = 'session-alpha';

/** A schema-valid V2 envelope; only `sid` and `round` vary per case. */
const envelopeObj = (sid, round) => ({
  topic: 'a topic', redactionCount: 0, resolvedModels: { openai: 'gpt-x' },
  providers: [{
    provider: 'openai', state: 'success', text: 'ok', errorMessage: null,
    httpStatus: null, usage: null, latencyMs: 0, estimatedCostUsd: null,
  }],
  totalCostUsd: 0, sid, round,
  capturedAt: '2026-08-11T00:00:00.000Z', schemaVersion: 2,
  archContextAttached: false, archContextChars: 0, archContextWarning: null, debateSkipped: null,
});
const envelope = (sid, round) => JSON.stringify(envelopeObj(sid, round));

function write(lines) {
  fs.writeFileSync(path.join(root, `${SID}.jsonl`), `${lines.join('\n')}\n`);
}

describe('loadSession — a foreign sid is not this session\'s data', () => {
  it('does not load a schema-valid record belonging to another session', () => {
    write([envelope(SID, 0), envelope('session-beta', 1), envelope(SID, 2)]);
    const out = loadSession(SID, { root });
    const sids = out.rounds.map((r) => r.sid);
    assert.ok(!sids.includes('session-beta'), `a foreign record reached the rounds: ${JSON.stringify(sids)}`);
    assert.equal(out.rounds.length, 2, 'only this session\'s two records may load');
  });

  it('counts the foreign record as invalid rather than dropping it silently', () => {
    write([envelope(SID, 0), envelope('session-beta', 1)]);
    const out = loadSession(SID, { root });
    assert.ok(out.invalidCount >= 1, 'a discarded record must be reported, not vanish');
  });

  // Vacuous-pass guard: a loader that rejected everything, or that ignored the
  // file entirely, would satisfy both assertions above.
  it('loads every record that DOES belong to this session (negative control)', () => {
    write([envelope(SID, 0), envelope(SID, 1), envelope(SID, 2)]);
    const out = loadSession(SID, { root });
    assert.equal(out.rounds.length, 3);
    assert.equal(out.invalidCount, 0, 'the fence must not fire on the normal path');
  });

  // The two rejections are DIFFERENT paths and must stay distinguishable: the
  // schema already requires `sid`, so an absent one is `v2-schema-invalid`,
  // while a present-but-foreign one is `sid-mismatch`. If the new fence had
  // subsumed the schema case, an operator reading the quarantine file would be
  // told the wrong thing about why their record was dropped.
  it('reports a mismatched sid distinctly from a missing one', () => {
    write([envelope('session-beta', 0)]);
    loadSession(SID, { root });
    const mismatch = fs.readFileSync(path.join(root, `${SID}.quarantine.jsonl`), 'utf8');
    assert.match(mismatch, /sid-mismatch/);

    fs.rmSync(path.join(root, `${SID}.quarantine.jsonl`), { recursive: true, maxRetries: 3, retryDelay: 50 });
    const { sid: _drop, ...rest } = envelopeObj(SID, 0);
    write([JSON.stringify(rest)]);
    loadSession(SID, { root });
    const missing = fs.readFileSync(path.join(root, `${SID}.quarantine.jsonl`), 'utf8');
    assert.match(missing, /v2-schema-invalid/);
    assert.ok(!/sid-mismatch/.test(missing), 'an absent sid is not a contradicted sid');
  });
});
