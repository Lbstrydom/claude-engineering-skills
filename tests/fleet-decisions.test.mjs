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
    assert.equal(readWords('-', stdin('a\r\nb\n')), 'a\r\nb');
  });
});

describe('audit B-R1 regressions (decisions)', () => {
  const rec = (dir, id, extra = {}) => writeRecord(dir, { schemaVersion: 1, kind: 'decision', id, at: NOW.toISOString(), scope: 'record-catchup', words: 'w', recordedBy: { session: 's', hostSession: null }, expiresAt: null, ...extra });
  it('H2/H8: an uninterpretable record (could be a revocation) makes every decision inactive', () => {
    for (const bad of [JSON.stringify({ schemaVersion: 2, kind: 'revocation' }), '{not json', JSON.stringify({ schemaVersion: 1, kind: 'revocation', id: 'rev-x' })]) {
      const dir = tmp();
      const id = newDecisionId(NOW);
      rec(dir, id);
      assert.equal(activeDecision(dir, id, 'record-catchup', NOW).ok, true);
      fs.writeFileSync(path.join(decisionsDir(dir), 'rev-20261116000000-0000.json'), bad);
      assert.match(activeDecision(dir, id, 'record-catchup', NOW).reason, /could not be interpreted/);
    }
  });
  it('H5: a calendar-invalid --expires is refused', () => {
    assert.throws(() => cmdDecision(ctx(tmp()), { '--scope': 'note', '--words-file': '-', '--expires': '2027-02-30T12:00:00Z' }, ['record'], stdin('w')), /real calendar date/);
    assert.equal(cmdDecision(ctx(tmp()), { '--scope': 'note', '--words-file': '-', '--expires': '2027-02-28T12:00:00Z' }, ['record'], stdin('w')).ok, true);
  });
  it('M2: only one trailing terminator is dropped; the rest is exact', () => {
    assert.equal(readWords('-', stdin('a\r\nb\n\n')), 'a\r\nb\n');
  });
  it('M5: list surfaces registry usage against the cap', () => {
    const dir = tmp();
    rec(dir, newDecisionId(NOW));
    assert.match(cmdDecision(ctx(dir), {}, ['list']).text, /registry: 1\/5000 records/);
  });
});

describe('audit B-R2 regressions (decisions)', () => {
  it('M1/M3/M5: list shows no decision as active when the registry is unusable', () => {
    const dir = tmp();
    const r = cmdDecision(ctx(dir), { '--scope': 'record-catchup', '--words-file': '-' }, ['record'], stdin('ok'));
    assert.match(cmdDecision(ctx(dir), {}, ['list']).text, /record-catchup {2}active/);
    fs.writeFileSync(path.join(decisionsDir(dir), 'rev-20261116000000-0000.json'), '{garbage');
    const text = cmdDecision(ctx(dir), {}, ['list']).text;
    assert.match(text, new RegExp(`${r.decision.id} {2}record-catchup {2}INDETERMINATE`));
    assert.match(text, /could not be interpreted/);
  });
  it('M2: multiline CRLF words are stored exactly', () => {
    const r = cmdDecision(ctx(tmp()), { '--scope': 'note', '--words-file': '-' }, ['record'], stdin('line one\r\nline two\r\n'));
    assert.equal(r.decision.words, 'line one\r\nline two');
  });
});
