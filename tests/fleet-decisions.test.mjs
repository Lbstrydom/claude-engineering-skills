/**
 * @fileoverview Decision records (scripts/lib/fleet/decisions.mjs, decisions-cmd.mjs). Plan: docs/plans/ship-record-catchup.md
 * §2.6. Properties: the scope vocabulary cannot express merge/push/override; records are immutable (revocation is a new
 * record); an incomplete or unsupported read never reads as active.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DECISION_SCOPES, activeDecision, classifyRecord, readDecisions, writeRecord, decisionsDir, newDecisionId,
} from '../scripts/lib/fleet/decisions.mjs';
import { cmdDecision, readWords } from '../scripts/lib/fleet/decisions-cmd.mjs';

const NOW = new Date('2026-11-16T12:00:00Z');
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-dec-')); const f = path.join(d, 'fleet'); fs.mkdirSync(f); return f; };
const ctx = (dir) => ({ dir, cwd: path.dirname(dir), now: NOW, cmd: 'fleet' });
const stdin = (t) => ({ readStdin: () => t });

describe('decisions', () => {
  it('the scope vocabulary has no merge, push or override value', () => {
    for (const s of ['merge', 'push', 'override']) assert.ok(!DECISION_SCOPES.includes(s));
    assert.throws(() => cmdDecision(ctx(tmp()), { '--scope': 'merge', '--words-file': '-' }, ['record'], stdin('x')), /not expressible/);
  });
  it('records exact words, activates, revokes with a NEW record, and never edits the original', () => {
    const dir = tmp();
    const words = 'You may commit `docs-only` record entries.\nMerges still need me.';
    const r = cmdDecision(ctx(dir), { '--scope': 'record-catchup', '--words-file': '-', '--id': 'coord' }, ['record'], stdin(`${words}\n`));
    assert.equal(r.ok, true);
    const id = r.decision.id;
    assert.equal(r.decision.words, words, 'backticks and newlines survive (stdin, never argv)');
    const before = fs.readFileSync(path.join(decisionsDir(dir), `${id}.json`), 'utf8');
    assert.equal(activeDecision(dir, id, 'record-catchup', NOW).ok, true);
    assert.match(activeDecision(dir, id, 'note', NOW).reason, /scoped record-catchup/);
    cmdDecision(ctx(dir), { '--words-file': '-' }, ['revoke', id], stdin('stop'));
    assert.match(activeDecision(dir, id, 'record-catchup', NOW).reason, /revoked/);
    assert.equal(fs.readFileSync(path.join(decisionsDir(dir), `${id}.json`), 'utf8'), before);
  });
  it('expiry, unknown ids, unsupported records and incomplete reads all refuse', () => {
    const dir = tmp();
    const id = newDecisionId(NOW);
    writeRecord(dir, { schemaVersion: 1, kind: 'decision', id, at: NOW.toISOString(), scope: 'record-catchup', words: 'w', recordedBy: { session: 's', hostSession: null }, expiresAt: '2026-11-16T13:00:00Z' });
    assert.equal(activeDecision(dir, id, 'record-catchup', NOW).ok, true);
    assert.match(activeDecision(dir, id, 'record-catchup', new Date('2026-11-16T14:00:00Z')).reason, /expired/);
    assert.match(activeDecision(dir, 'dec-20261116000000-0000', 'record-catchup', NOW).reason, /no decision/);
    assert.match(activeDecision(dir, 'nope', 'record-catchup', NOW).reason, /not a decision id/);
    assert.ok(classifyRecord({ schemaVersion: 2, id: 'x' }).unsupported);
    assert.ok(classifyRecord({ schemaVersion: 1, kind: 'decision', scope: 'merge', id: 'x' }).unsupported);
    fs.writeFileSync(path.join(decisionsDir(dir), 'dec-20261116000001-ffff.json'), JSON.stringify({ schemaVersion: 1, kind: 'decision', scope: 'merge' }));
    assert.equal(readDecisions(dir).unsupported.length, 1);
    assert.equal(readDecisions(dir, { cap: 1 }).complete, false);
  });
  it('readWords refuses empty and missing input', () => {
    assert.throws(() => readWords(undefined), /required/);
    assert.throws(() => readWords('-', stdin('\n\n')), /empty/);
    assert.equal(readWords('-', stdin('a\r\nb\n')), 'a\nb');
  });
});
