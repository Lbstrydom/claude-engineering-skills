/**
 * @fileoverview Tier 2 (deterministic seam) — `--resume` call records.
 * Plan: docs/plans/sashiko-audit-improvements.md §3.3.
 *
 * Proof (red→green): without call records a quota stop re-pays every finished pass. Here a fake client loses the
 * `wiring` call to a 429 and succeeds for the rest; the resumed run must make live calls ONLY for `wiring`, and each
 * identity field changed alone must force that call live (a replay hiding a changed model/prompt/route is the failure).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { callGPT, safeCallGPT, effectiveRequestFor, setModel, wireModel } from '../scripts/lib/audit/llm-helpers.mjs';
import {
  configureCallRecords, resumeSummary, _resetCallRecordsForTests, requestKeyFor, canonicalJson, pruneCallRecords,
  lookupCallRecord, writeCallRecord, CALL_RECORD_ROOT_REL,
} from '../scripts/lib/audit/call-record.mjs';

const Schema = z.object({ findings: z.array(z.string()) }).strict();
const USAGE = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const TREE = 'a'.repeat(40);
const ID = { auditedTree: TREE, auditSessionId: 'audit-code-1-2', auditRound: 1 };

/** A client that records the user prompt of every live call; `failFor` prompts throw a non-retryable error. */
function client({ failFor = [] } = {}) {
  const calls = [];
  return {
    calls,
    responses: {
      parse: async (params) => {
        const prompt = params.input.map((m) => m.content).join('|');
        calls.push(prompt);
        if (failFor.some((f) => prompt.includes(f))) { const e = new Error('rate limited'); e.status = 429; throw e; }
        return { status: 'completed', output: [], output_parsed: { findings: [prompt.slice(-6)] }, usage: USAGE, model: 'served-model' };
      },
    },
  };
}
const optsFor = (userText, extra = {}) => ({
  system: 'you audit code', messages: [{ role: 'user', content: userText }],
  schema: Schema, schemaName: 'test_pass', reasoning: 'low', maxTokens: 500, timeoutMs: 5000, maxRetries: 0, passName: 'p', ...extra,
});
const call = (openai, userText, extra = {}) => callGPT(openai, optsFor(userText, extra));

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'call-record-')); _resetCallRecordsForTests(); });
afterEach(() => { _resetCallRecordsForTests(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const cfg = (over = {}) => configureCallRecords({ repoRoot: root, identity: ID, env: {}, ...over });

describe('call records: record, replay, identity', () => {
  it('RED→GREEN: a resumed round replays finished passes and goes live only for the lost one', async () => {
    assert.equal(cfg().ok, true);
    const first = client({ failFor: ['WIRING'] });
    const a = await safeCallGPT(first, optsFor('STRUCTURE'), { findings: [] });
    const b = await safeCallGPT(first, optsFor('WIRING'), { findings: [] });
    assert.equal(a.failed, undefined);
    assert.equal(b.failed, true);

    assert.equal(cfg({ resume: true }).ok, true);
    const second = client();
    const a2 = await call(second, 'STRUCTURE');
    const b2 = await call(second, 'WIRING');
    assert.equal(a2.replayed, true, 'finished pass replays');
    assert.equal(a2.usage.input_tokens, 0, 'a replay spends nothing');
    assert.equal(b2.replayed, undefined, 'lost pass goes live');
    assert.deepEqual(second.calls.map((c) => c.includes('WIRING')), [true], 'the client saw only the lost pass');
    const sum = resumeSummary();
    assert.equal(sum.resumed, true);
    assert.equal(sum.replayedCalls, 1);
    assert.equal(sum.liveCalls, 1);
  });

  it('without --resume nothing is replayed even though records exist', async () => {
    cfg(); await call(client(), 'ONE');
    cfg();                                     // same identity, resume false
    const c = client(); const r = await call(c, 'ONE');
    assert.equal(r.replayed, undefined); assert.equal(c.calls.length, 1);
  });

  it('each identity field changed alone forces the call live', async () => {
    cfg(); await call(client(), 'BASE');
    const variants = {
      'prompt byte': () => call(client(), 'BASF'),
      'schema name': () => call(client(), 'BASE', { schemaName: 'other_pass' }),
      'max tokens': () => call(client(), 'BASE', { maxTokens: 501 }),
      'reasoning': () => call(client(), 'BASE', { reasoning: 'medium' }),
      'system prompt': () => call(client(), 'BASE', { system: 'different' }),
    };
    for (const [name, run] of Object.entries(variants)) {
      cfg({ resume: true });
      const r = await run();
      assert.equal(r.replayed, undefined, `${name} must not replay`);
    }
    cfg({ resume: true });
    assert.equal((await call(client(), 'BASE')).replayed, true, 'control: unchanged request replays');
  });

  it('the route is part of the key: same model string on azure vs openai is two requests', () => {
    const e = effectiveRequestFor({ system: 's', messages: [{ role: 'user', content: 'u' }], schema: Schema, schemaName: 'x' });
    const openai = requestKeyFor({ route: e.route, request: e.requestParams });
    const azure = requestKeyFor({ route: { ...e.route, transport: 'azure', endpoint: 'https://x.openai.azure.com', deployment: 'd' }, request: e.requestParams });
    const otherDeployment = requestKeyFor({ route: { ...e.route, transport: 'azure', endpoint: 'https://x.openai.azure.com', deployment: 'e' }, request: e.requestParams });
    assert.notEqual(openai.requestKey, azure.requestKey);
    assert.notEqual(azure.requestKey, otherDeployment.requestKey);
  });

  it('identity isolation: another round or SID with identical prompts replays nothing', async () => {
    cfg(); await call(client(), 'SAME');
    // (i) no directory of its own -> refused, not a silent fresh run
    assert.match(cfg({ resume: true, identity: { ...ID, auditRound: 3 } }).reason, /nothing to resume/);
    assert.match(cfg({ resume: true, identity: { ...ID, auditSessionId: 'other' } }).reason, /nothing to resume/);
    // (ii) records copied into another round's directory carry the wrong identity in their envelope -> every lookup misses
    const base = path.join(root, CALL_RECORD_ROOT_REL, TREE);
    fs.cpSync(path.join(base, 'audit-code-1-2-r1'), path.join(base, 'audit-code-1-2-r3'), { recursive: true });
    cfg({ resume: true, identity: { ...ID, auditRound: 3 } });
    const c = client(); const r = await call(c, 'SAME');
    assert.equal(r.replayed, undefined); assert.equal(c.calls.length, 1);
  });

  it('refuses resume with no tree, no session or no round; recording is simply off for a fresh run', () => {
    assert.match(cfg({ resume: true, identity: { ...ID, auditedTree: null } }).reason, /identity unavailable/);
    assert.match(cfg({ resume: true, identity: { ...ID, auditSessionId: null } }).reason, /session id or round/);
    assert.match(cfg({ resume: true, identity: { ...ID, auditRound: null } }).reason, /session id or round/);
    assert.equal(cfg({ identity: { ...ID, auditedTree: null } }).ok, true);
    assert.equal(resumeSummary(), null);
  });

  it('refuses resume when AUDIT_CALL_RECORD=0 disables records', () => {
    assert.match(configureCallRecords({ repoRoot: root, identity: ID, resume: true, env: { AUDIT_CALL_RECORD: '0' } }).reason, /AUDIT_CALL_RECORD=0/);
  });
});

describe('call records: what is never recorded and what reads as a miss', () => {
  it('never records a failed call, a truncated response or a schema failure', async () => {
    cfg();
    await safeCallGPT(client({ failFor: ['BOOM'] }), optsFor('BOOM'), { findings: [] });
    const truncated = { responses: { parse: async () => ({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: USAGE }) } };
    await call(truncated, 'TRUNC').catch(() => {});
    const dir = path.join(root, CALL_RECORD_ROOT_REL, TREE, 'audit-code-1-2-r1');
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('a truncated file, a renamed record and a result that fails the current schema are misses', async () => {
    cfg(); await call(client(), 'GOOD');
    const dir = path.join(root, CALL_RECORD_ROOT_REL, TREE, 'audit-code-1-2-r1');
    const [file] = fs.readdirSync(dir);
    const key = file.replace('.json', '');
    const good = fs.readFileSync(path.join(dir, file), 'utf8');

    cfg({ resume: true });
    fs.writeFileSync(path.join(dir, file), good.slice(0, 20));
    assert.equal(lookupCallRecord(key, Schema), null, 'truncated');

    fs.writeFileSync(path.join(dir, file), good.replace(key, 'f'.repeat(64)));
    assert.equal(lookupCallRecord(key, Schema), null, 'key fields do not hash to the name');

    fs.writeFileSync(path.join(dir, file), good);
    assert.notEqual(lookupCallRecord(key, Schema), null, 'control: the untouched record hits');
    assert.equal(lookupCallRecord(key, z.object({ other: z.string() }).strict()), null, 'fails the current schema');
  });

  it('a write failure degrades to a live call, is counted, and never fails the audit', async () => {
    cfg();
    const dir = path.join(root, CALL_RECORD_ROOT_REL, TREE, 'audit-code-1-2-r1');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.writeFileSync(dir, 'a file where the directory should be');   // every write now fails
    const r = await call(client(), 'X');
    assert.equal(r.result.findings.length, 1);
    assert.equal(resumeSummary().recordWriteFailures, 1);
  });
});

describe('call records: review hardening (audit r1)', () => {
  it('the record never stores the prompt text (only its hash)', async () => {
    cfg(); await call(client(), 'SECRET-SOURCE-EXCERPT');
    const dir = path.join(root, CALL_RECORD_ROOT_REL, TREE, 'audit-code-1-2-r1');
    const text = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
    assert.ok(!text.includes('SECRET-SOURCE-EXCERPT'), 'prompt text must not be persisted');
    assert.match(text, /inputSha256/);
  });

  it('two clients on different base URLs are two routes (H2)', () => {
    const o = { system: 's', messages: [{ role: 'user', content: 'u' }], schema: Schema, schemaName: 'x' };
    const a = requestKeyFor({ route: effectiveRequestFor(o, { baseURL: 'https://a.example/v1' }).route });
    const b = requestKeyFor({ route: effectiveRequestFor(o, { baseURL: 'https://b.example/v1' }).route });
    assert.notEqual(a.requestKey, b.requestKey);
  });

  it('a different model and a different schema shape force the call live', async () => {
    cfg(); await call(client(), 'MODELCASE');
    const before = wireModel();
    try {
      setModel('some-other-model'); cfg({ resume: true });
      assert.equal((await call(client(), 'MODELCASE')).replayed, undefined, 'model changed');
    } finally { setModel(before); }
    cfg({ resume: true });
    const Other = z.object({ findings: z.array(z.string()), extra: z.string().nullable() }).strict();
    assert.equal((await call(client(), 'MODELCASE', { schema: Other })).replayed, undefined, 'schema content changed under the same name');
    cfg({ resume: true });
    assert.equal((await call(client(), 'MODELCASE')).replayed, true, 'control');
  });

  it('a schema-invalid provider response is never recorded', async () => {
    cfg();
    const bad = { responses: { parse: async () => ({ status: 'completed', output: [], output_parsed: { findings: 'not-an-array' }, usage: USAGE }) } };
    await assert.rejects(call(bad, 'BADSHAPE'), /findings is string/);
    const dir = path.join(root, CALL_RECORD_ROOT_REL, TREE, 'audit-code-1-2-r1');
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('an empty directory, junk files and a corrupt record are not resumable (M6)', () => {
    cfg();                                               // creates the directory, records nothing
    assert.match(cfg({ resume: true }).reason, /nothing to resume/);
    const dir = path.join(root, CALL_RECORD_ROOT_REL, TREE, 'audit-code-1-2-r1');
    fs.writeFileSync(path.join(dir, 'junk.json'), '{}');
    fs.writeFileSync(path.join(dir, 'f'.repeat(64) + '.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'e'.repeat(64) + '.json'), JSON.stringify({ requestKey: 'e'.repeat(64), auditedTree: TREE, auditSessionId: 'other', auditRound: 1, response: { result: {} } }));
    assert.match(cfg({ resume: true }).reason, /nothing to resume/);
  });

  it('an unreadable record file (not just a bad directory) is reported (r3)', () => {
    cfg(); fs.writeFileSync(path.join(root, CALL_RECORD_ROOT_REL, TREE, 'audit-code-1-2-r1', 'd'.repeat(64) + '.json'), '{}');
    const realRead = fs.readFileSync;
    fs.readFileSync = (f, ...a) => { if (String(f).endsWith('d'.repeat(64) + '.json')) { const e = new Error('denied'); e.code = 'EACCES'; throw e; } return realRead(f, ...a); };
    try { assert.match(cfg({ resume: true }).reason, /EACCES reading a record/); } finally { fs.readFileSync = realRead; }
  });

  it('an unreadable (non-directory) record path is reported, not folded into empty', () => {
    cfg();
    const dir = path.join(root, CALL_RECORD_ROOT_REL, TREE, 'audit-code-1-2-r1');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.writeFileSync(dir, 'a file where the directory should be');
    assert.match(cfg({ resume: true }).reason, /unreadable|unusable/);
  });

  it('a write touches the tree directory so an active audit stays newest (M1/M5)', async () => {
    cfg();
    const tree = path.join(root, CALL_RECORD_ROOT_REL, TREE);
    const old = new Date(Date.now() - 3600_000); fs.utimesSync(tree, old, old);
    await call(client(), 'HEARTBEAT');
    assert.ok(fs.statSync(tree).mtimeMs > old.getTime() + 1000);
  });
});

describe('call records: retention and concurrency', () => {
  it('keeps the newest N trees and never prunes the current one, even when it is the oldest', () => {
    const rootDir = path.join(root, CALL_RECORD_ROOT_REL);
    for (let i = 0; i < 7; i++) {
      const d = path.join(rootDir, `tree${i}`); fs.mkdirSync(d, { recursive: true });
      const t = new Date(Date.now() - (7 - i) * 60_000); fs.utimesSync(d, t, t);
    }
    pruneCallRecords(rootDir, 'tree0', 5);
    const left = fs.readdirSync(rootDir).sort();
    assert.equal(left.length, 6, '5 newest + the protected current tree');
    assert.ok(left.includes('tree0'));
    assert.ok(!left.includes('tree1'));
  });

  it('two attempts writing the same key concurrently leave a parseable record', async () => {
    cfg();
    await Promise.all([call(client(), 'RACE'), call(client(), 'RACE')]);
    cfg({ resume: true });
    assert.equal((await call(client(), 'RACE')).replayed, true);
  });

  it('canonicalJson is key-order independent', () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
});
