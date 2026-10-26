/**
 * @fileoverview Own-model decision ledger (docs/plans/own-model-decision-ledger.md):
 * the pure and filesystem halves. The Postgres halves live in
 * own-model-ledger-db.test.mjs.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  parseIngress, parsePersisted, KINDS, USAGE_SOURCES, REF_GRAMMAR,
} from '../scripts/lib/ledger/schemas.mjs';
import { shapeForRepo, contentAllowed } from '../scripts/lib/ledger/repo-shape.mjs';
import { prepareLedgerEvent, sessionHandle } from '../scripts/lib/ledger/prepare.mjs';
import {
  mintUuidV7, mintWorkItemId, uuidV5, observationEventId, isWorkItemId, workItemFromBranch, workItemFromPrBody,
} from '../scripts/lib/ledger/work-item.mjs';
import {
  writeSpool, listSpool, flushSpool, purgeLocal, readState, writeState, cachedFlag, spoolStatus,
  appendHookError, ELIGIBILITY_TTL_MS, MAX_HOOK_ERROR_LINES, ledgerEnabled, LOCK_STALE_MS,
} from '../scripts/lib/ledger/spool.mjs';
import { submitLedgerEvent } from '../scripts/lib/ledger/submit.mjs';
import { parseRevertedShas, planObservations, sweepReverts } from '../scripts/lib/ledger/sweep.mjs';
import { fleetDecisionEvent, trainMergeEvents, coordinatorFor } from '../scripts/lib/fleet/ledger-hook.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const NOW = '2026-10-26T20:00:00.000Z';
const WI = '01a179bd-3d97-739c-b15b-3eb0d65f78b2';

const decision = (over = {}) => ({
  kind: 'decision', coordinator: 'CES', actor: 'coordinator', event_at: NOW,
  payload: { options: [{ id: 'wait', label: 'Wait for CI', summary: 'proprietary plan detail' }, { id: 'go', label: 'Merge now' }], chosen_option_id: 'wait', rationale: 'because of the plan', state_summary: 'PR 12 pending' },
  ...over,
});
const prep = (raw, flag, extra = {}) => prepareLedgerEvent(raw, { repo: { id: null, name: 'o/r' }, flag, purgeGeneration: 3, ...extra });

describe('ingress and persisted contracts', () => {
  it('accepts a well-formed event of every kind', () => {
    const base = { coordinator: 'CES', actor: 'system', event_at: NOW };
    assert.ok(parseIngress({ ...base, kind: 'task', payload: { task_kind: 'chip', brief_text: 'x' } }).ok);
    assert.ok(parseIngress(decision()).ok);
    assert.ok(parseIngress({ ...base, kind: 'correction', payload: { class: 'scope', source: 'chat', proposal_text: 'a', revision_text: 'b' } }).ok);
    assert.ok(parseIngress({ ...base, kind: 'outcome', payload: { kind: 'merged', ref: 'pr:304' } }).ok);
    assert.ok(parseIngress({ ...base, kind: 'usage', payload: { source: 'chip', provider: 'anthropic', model: 'm', input_tokens: 1, output_tokens: 2, cost_usd: 0.1 } }).ok);
    assert.equal(KINDS.length, 5);
  });
  it('refuses unknown keys, bad enums and a chosen option that is not offered', () => {
    assert.equal(parseIngress({ ...decision(), surprise: 1 }).ok, false);
    assert.equal(parseIngress(decision({ coordinator: 'XYZ' })).ok, false);
    const d = decision(); d.payload.chosen_option_id = 'nope';
    assert.equal(parseIngress(d).ok, false);
  });
  it('usage can never be an audit source (audit cost comes only from audit_runs)', () => {
    assert.ok(!USAGE_SOURCES.includes('audit'));
    const u = { kind: 'usage', coordinator: 'CES', actor: 'system', event_at: NOW, payload: { source: 'audit', provider: 'p', model: 'm', input_tokens: 0, output_tokens: 0, cost_usd: 0 } };
    assert.equal(parseIngress(u).ok, false);
  });
  it('usage provider and model are closed grammars (structural fields skip redaction)', () => {
    const u = (provider, model) => parseIngress({ kind: 'usage', coordinator: 'CES', actor: 'system', event_at: NOW, payload: { source: 'chip', provider, model, input_tokens: 0, output_tokens: 0, cost_usd: 0 } }).ok;
    assert.equal(u('anthropic', 'claude-opus-5-5'), true);
    assert.equal(u('anthropic', 'openai/gpt-6.1:latest'), true);
    assert.equal(u('has space', 'm'), false);
    assert.equal(u('p', 'a model name with narrative and a key sk-abcdefghijklmnopqrstuvwxyz'), false);
  });
  it('the ref grammar is closed: no spaces, no free text', () => {
    for (const ok of ['pr:12', `sha:${'a'.repeat(40)}`, 'run:01a179bd-3d97-739c-b15b-3eb0d65f78b2', 'path:docs/plans/x.md']) assert.ok(REF_GRAMMAR.test(ok), ok);
    for (const bad of ['pr:x', 'sha:short', 'path:has space', 'free text', 'pr:12 and more']) assert.equal(REF_GRAMMAR.test(bad), false, bad);
  });
  it('a STRUCTURAL persisted event rejects narrative fields and can never be training_eligible', () => {
    const r = prep(decision(), false);
    assert.ok(r.ok);
    const withLabel = structuredClone(r.event); withLabel.payload.options[0].label = 'leak';
    assert.equal(parsePersisted(withLabel).ok, false);
    assert.equal(parsePersisted({ ...r.event, training_eligible: true }).ok, false);
  });
});

describe('repo shaping and prepare (default-deny, fail closed)', () => {
  it('false and unknown yield structure only; true and undecided keep content', () => {
    assert.deepEqual([false, 'unknown', true, null].map(contentAllowed), [false, false, true, true]);
  });
  it('`unknown` is NEVER read as undecided: it strips content and says why', () => {
    const u = prep(decision(), 'unknown').event;
    const n = prep(decision(), null).event;
    assert.equal(u.content_state, 'structural');
    assert.equal(u.eligibility_basis, 'eligibility-unknown');
    assert.equal(n.content_state, 'full');
    assert.equal(n.eligibility_basis, 'repo-flag-undecided');
  });
  it('trainable only on an explicit true', () => {
    const rows = [true, null, false, 'unknown'].map((f) => prep(decision(), f).event.training_eligible);
    assert.deepEqual(rows, [true, false, false, false]);
  });
  it('a repo-false decision keeps option ids only: label, summary, rationale and state_summary are gone', () => {
    const e = prep(decision(), false).event;
    assert.deepEqual(e.payload, { options: [{ id: 'wait' }, { id: 'go' }], chosen_option_id: 'wait' });
  });
  it('a free-text brief_ref is dropped from a structural task but a grammar ref survives', () => {
    const t = (ref) => prep({ kind: 'task', coordinator: 'STO', actor: 'chip', event_at: NOW, payload: { task_kind: 'chip', brief_ref: ref, brief_text: 'secret brief' } }, false).event.payload;
    assert.deepEqual(t('storyline phase 4 plan'), { task_kind: 'chip' });
    assert.deepEqual(t('path:docs/plans/x.md'), { task_kind: 'chip', brief_ref: 'path:docs/plans/x.md' });
  });
  it('session ids are stored as a 16-hex hash, never raw', () => {
    const e = prep(decision({ session_id: 'claude/charming-curran-0e3fca' }), true).event;
    assert.match(e.session_ref, /^[0-9a-f]{16}$/);
    assert.equal(e.session_ref, sessionHandle('claude/charming-curran-0e3fca'));
    assert.ok(!JSON.stringify(e).includes('charming-curran'));
  });
  it('a stripped event validates again on replay (separate ingress and persisted contracts)', () => {
    const e = prep(decision(), false).event;
    assert.ok(parsePersisted(JSON.parse(JSON.stringify(e))).ok);
  });
  it('a decision gets its own stable decision_id (its event id) so a later correction can reference it; other kinds do not', () => {
    const d = prep(decision(), true).event;
    assert.equal(d.decision_id, d.event_id);
    assert.equal(prep(decision({ decision_id: '11111111-1111-4111-8111-111111111111' }), true).event.decision_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(prep({ kind: 'outcome', coordinator: 'CES', actor: 'system', event_at: NOW, payload: { kind: 'merged', ref: 'pr:1' } }, true).event.decision_id, null);
  });
  it('stamps the producer-observed purge generation and the versions', () => {
    const e = prep(decision(), true).event;
    assert.equal(e.purge_generation, 3);
    assert.equal(e.schema_version, 1);
    assert.equal(e.redaction_version, 1);
  });
  it('redacts a secret in narrative text; one that survives refuses the event', () => {
    const d = decision(); d.payload.rationale = 'token sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD is here';
    const r = prep(d, true);
    if (r.ok) {
      assert.ok(!JSON.stringify(r.event).includes('sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD'));
      assert.ok(r.redactions >= 1);
    } else assert.match(r.reason, /secret-survived-redaction/);
  });
  it('an invalid ingress event is refused with a reason, never throws', () => {
    const r = prep({ kind: 'nope' }, true);
    assert.equal(r.ok, false);
    assert.equal(r.state, 'refused');
  });
});

describe('identity helpers', () => {
  it('UUIDv7 has the right shape and sorts by time', () => {
    const a = mintUuidV7(1_000_000_000_000); const b = mintUuidV7(1_000_000_000_001);
    assert.ok(isWorkItemId(a) && isWorkItemId(b));
    assert.ok(a < b);
    assert.equal(isWorkItemId(mintWorkItemId()), true);
  });
  it('UUIDv5 matches the RFC 9562 test vector', () => {
    assert.equal(uuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });
  it('the derived observation id is deterministic and parent-specific', () => {
    assert.equal(observationEventId(WI), observationEventId(WI));
    assert.notEqual(observationEventId(WI), observationEventId('01a179bd-3d97-739c-b15b-3eb0d65f78b3'));
  });
  it('workItemFromBranch and workItemFromPrBody never guess', () => {
    assert.equal(workItemFromBranch(`claude/wi-${WI}`), WI);
    assert.equal(workItemFromBranch(`feat/wi-${WI}-extra`), WI);
    assert.equal(workItemFromBranch('claude/awesome-hypatia'), null);
    assert.equal(workItemFromBranch(`wi-${WI.slice(0, 20)}`), null);
    assert.equal(workItemFromPrBody(`## What\n\nWork-Item: ${WI}\n`), WI);
    assert.equal(workItemFromPrBody('Work-Item: not-a-uuid'), null);
    assert.equal(workItemFromPrBody(null), null);
  });
});

describe('spool (filesystem)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oml-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  const ev = (over = {}) => prep(decision(), true, over).event;

  it('writes atomically (no temp files left) and lists in event_id order', () => {
    const a = ev(); const b = ev();
    assert.equal(writeSpool(dir, b).state, 'spooled');
    assert.equal(writeSpool(dir, a).state, 'spooled');
    assert.deepEqual(listSpool(dir), [`${a.event_id}.json`, `${b.event_id}.json`].sort());
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
  });
  it('refuses a write past the cap as retryable, not as a loss', () => {
    writeSpool(dir, ev());
    assert.deepEqual(writeSpool(dir, ev(), { maxFiles: 1 }), { state: 'failed-retryable', error: 'spool-full' });
  });
  it('flush deletes only settled files; an unsettled event stays for the next flush', async () => {
    const a = ev(); const b = ev(); const c = ev();
    for (const e of [a, b, c]) writeSpool(dir, e);
    const res = await flushSpool({
      dir, write: async (events) => ({ ok: true, generation: 9, receipts: events.filter((e) => e.event_id !== c.event_id).map((e) => ({ event_id: e.event_id, state: e.event_id === a.event_id ? 'persisted' : 'refused' })) }),
    });
    assert.deepEqual([res.persisted, res.refused, res.remaining], [1, 1, 1]);
    assert.deepEqual(listSpool(dir), [`${c.event_id}.json`]);
    assert.equal(readState(dir).generation, 9, 'the store contact refreshed the purge generation');
  });
  it('a failed write leaves every file in place and reports the error', async () => {
    writeSpool(dir, ev());
    const res = await flushSpool({ dir, write: async () => ({ ok: false, reason: 'cloud-off', receipts: [] }) });
    assert.equal(res.error, 'cloud-off');
    assert.equal(listSpool(dir).length, 1);
  });
  it('a corrupt file is quarantined without blocking the batch', async () => {
    const good = ev();
    writeSpool(dir, good);
    const bad = '00000000-0000-7000-8000-000000000000.json';
    fs.writeFileSync(path.join(dir, bad), '{not json');
    const res = await flushSpool({ dir, write: async (events) => ({ ok: true, receipts: events.map((e) => ({ event_id: e.event_id, state: 'persisted' })) }) });
    assert.deepEqual([res.persisted, res.quarantined], [1, 1]);
    assert.ok(fs.existsSync(path.join(dir, 'quarantine', bad)));
    assert.equal(spoolStatus(dir).quarantined, 1);
  });
  it('a valid-JSON non-event file is quarantined by the persisted contract, not written', async () => {
    writeSpool(dir, prep(decision(), true).event);
    fs.writeFileSync(path.join(dir, '00000000-0000-7000-8000-0000000000aa.json'), 'null');
    fs.writeFileSync(path.join(dir, '00000000-0000-7000-8000-0000000000ab.json'), JSON.stringify({ kind: 'task' }));
    const seen = [];
    const res = await flushSpool({ dir, write: async (events) => { seen.push(...events); return { ok: true, receipts: events.map((e) => ({ event_id: e.event_id, state: 'persisted' })) }; } });
    assert.deepEqual([res.persisted, res.quarantined, seen.length], [1, 2, 1]);
  });
  it('a held lock means another drainer is running; a stale lock is taken over', async () => {
    writeSpool(dir, ev());
    fs.writeFileSync(path.join(dir, 'flush.lock'), String(Date.now()));
    const held = await flushSpool({ dir, write: async () => { throw new Error('must not run'); } });
    assert.equal(held.locked, true);
    fs.writeFileSync(path.join(dir, 'flush.lock'), String(Date.now() - LOCK_STALE_MS - 1000));
    const res = await flushSpool({ dir, write: async (events) => ({ ok: true, receipts: events.map((e) => ({ event_id: e.event_id, state: 'duplicate' })) }) });
    assert.equal(res.duplicate, 1);
  });
  it('purge also clears orphaned temp files and unparseable quarantined files, and leaves a fresh temp file alone', () => {
    const stale = path.join(dir, '.aaaa.1.tmp'); const fresh = path.join(dir, '.bbbb.2.tmp');
    fs.writeFileSync(stale, JSON.stringify({ work_item_id: WI })); fs.writeFileSync(fresh, '{}');
    fs.utimesSync(stale, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    fs.mkdirSync(path.join(dir, 'quarantine'));
    fs.writeFileSync(path.join(dir, 'quarantine', '00000000-0000-7000-8000-0000000000cc.json'), '{corrupt');
    assert.equal(purgeLocal(dir, { workItem: WI }), 2);
    assert.ok(!fs.existsSync(stale) && fs.existsSync(fresh));
  });
  it('writeState merges under a lock: a stale writer cannot lower the generation, and the sweep cursor persists', () => {
    writeState(dir, { generation: 9 });
    writeState(dir, { generation: 3, sweepCursor: { eventAt: NOW, eventId: WI } });
    const s = readState(dir);
    assert.equal(s.generation, 9);
    assert.deepEqual(s.sweepCursor, { eventAt: NOW, eventId: WI });
    writeState(dir, { sweepCursor: null });
    assert.equal(readState(dir).sweepCursor, null);
    assert.ok(!fs.existsSync(path.join(dir, 'state.lock')), 'the lock is released');
  });
  it('purgeLocal removes spool AND quarantine copies of the scope and leaves the rest', () => {
    const mine = prep(decision({ work_item_id: WI }), true).event;
    const other = prep(decision(), true).event;
    writeSpool(dir, mine); writeSpool(dir, other);
    fs.mkdirSync(path.join(dir, 'quarantine'));
    fs.writeFileSync(path.join(dir, 'quarantine', `${mine.event_id.slice(0, 8)}-0000-7000-8000-000000000001.json`), JSON.stringify({ ...mine, event_id: 'x' }));
    assert.equal(purgeLocal(dir, { workItem: WI }), 2);
    assert.deepEqual(listSpool(dir), [`${other.event_id}.json`]);
  });
  it('the eligibility cache expires into unknown, and an observed undecided flag is not unknown', () => {
    writeState(dir, { generation: 4, repo: { name: 'o/r', flag: true, id: 'id1' } }, 1000);
    writeState(dir, { repo: { name: 'o/u', flag: null } }, 1000);
    const s = readState(dir);
    assert.equal(cachedFlag(s, 'o/r', 1000 + 5).flag, true);
    assert.equal(cachedFlag(s, 'o/u', 1000 + 5).flag, null);
    assert.equal(cachedFlag(s, 'o/r', 1000 + ELIGIBILITY_TTL_MS + 1).flag, 'unknown');
    assert.equal(cachedFlag(s, 'o/none', 1000).flag, 'unknown');
    assert.equal(s.generation, 4);
  });
  it('status reports a missing directory as UNMEASURED (null), never zero', () => {
    assert.deepEqual(spoolStatus(path.join(dir, 'nope')), { spooled: null, quarantined: null, hookErrors: null, generation: null });
    assert.equal(spoolStatus(dir).spooled, 0);
  });
  it('hook errors are bounded', () => {
    for (let i = 0; i < MAX_HOOK_ERROR_LINES + 25; i++) appendHookError(dir, `e${i}`);
    assert.equal(spoolStatus(dir).hookErrors, MAX_HOOK_ERROR_LINES);
  });
  it('LEARNING_DISABLE and OWN_MODEL_LEDGER=off both disable capture', () => {
    assert.equal(ledgerEnabled({}), true);
    assert.equal(ledgerEnabled({ LEARNING_DISABLE: '1' }), false);
    assert.equal(ledgerEnabled({ OWN_MODEL_LEDGER: 'off' }), false);
  });
});

describe('submitLedgerEvent delivery states (injected deps)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oml-sub-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  const deps = (over = {}) => ({
    resolveRepoName: () => 'o/r', isCloudEnabled: async () => true,
    lookupRepoFlag: async () => ({ id: '11111111-1111-4111-8111-111111111111', name: 'o/r', flag: true }), readPurgeGeneration: async () => 5,
    recordLedgerEvents: async (events) => ({ ok: true, generation: 5, receipts: events.map((e) => ({ event_id: e.event_id, state: 'persisted' })) }),
    ledgerDir: () => dir, ...over,
  });
  const submit = (raw, d, extra = {}) => submitLedgerEvent(raw, { cwd: dir, env: {}, nowMs: 1000, deps: d, ...extra });

  it('disabled', async () => assert.equal((await submit(decision(), deps(), { env: { LEARNING_DISABLE: '1' } })).state, 'disabled'));
  it('persisted when the store accepts, and the cache learns the flag and generation', async () => {
    const r = await submit(decision(), deps());
    assert.equal(r.state, 'persisted');
    assert.equal(r.content_state, 'full');
    assert.equal(readState(dir).generation, 5);
    assert.equal(cachedFlag(readState(dir), 'o/r', 1001).flag, true);
  });
  it('a producer-supplied repo may only restate the ambient repo (mismatch is refused)', async () => {
    assert.equal((await submit({ ...decision(), repo: 'other/repo' }, deps())).reason, 'repo-mismatch');
    assert.equal((await submit({ ...decision(), repo: 'o/r' }, deps())).state, 'persisted');
  });
  it('an explicit purge generation overrides the freshly read one', async () => {
    let stamped;
    await submit(decision(), deps({ recordLedgerEvents: async (ev) => { stamped = ev[0].purge_generation; return { ok: true, generation: 5, receipts: ev.map((e) => ({ event_id: e.event_id, state: 'persisted' })) }; } }), { purgeGeneration: 2 });
    assert.equal(stamped, 2);
  });
  it('refused (never retried) for an invalid event', async () => assert.equal((await submit({ kind: 'x' }, deps())).state, 'refused'));
  it('spooled when the store throws; the event is already shaped', async () => {
    const r = await submit(decision(), deps({ recordLedgerEvents: async () => { throw new Error('down'); } }));
    assert.equal(r.state, 'spooled');
    const [f] = listSpool(dir);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).content_state, 'full');
  });
  it('cloud off with NO cache degrades to structure and says content was dropped', async () => {
    const r = await submit(decision(), deps({ isCloudEnabled: async () => false }));
    assert.deepEqual([r.state, r.content_state, r.contentDropped], ['spooled', 'structural', true]);
  });
  it('cloud off with a fresh cache keeps content for a repo the store confirmed', async () => {
    writeState(dir, { repo: { name: 'o/r', flag: true } }, 900);
    const r = await submit(decision(), deps({ isCloudEnabled: async () => false }));
    assert.deepEqual([r.state, r.content_state, r.contentDropped], ['spooled', 'full', false]);
  });
  it('a store that is up but cannot resolve the repo reads unknown, never undecided', async () => {
    const r = await submit(decision(), deps({ lookupRepoFlag: async () => ({ flag: 'unknown' }) }));
    assert.equal(r.content_state, 'structural');
  });
  it('a store refusal (barrier) is reported as refused, not spooled', async () => {
    const r = await submit(decision(), deps({ recordLedgerEvents: async (ev) => ({ ok: true, generation: 6, receipts: ev.map((e) => ({ event_id: e.event_id, state: 'refused', reason: 'purged-scope' })) }) }));
    assert.deepEqual([r.state, r.reason], ['refused', 'purged-scope']);
    assert.equal(listSpool(dir).length, 0);
  });
  it('an unwritable spool is failed-permanent', async () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a file, not a directory');
    const r = await submit(decision(), deps({ isCloudEnabled: async () => false, ledgerDir: () => path.join(dir, 'f.txt', 'x') }));
    assert.equal(r.state, 'failed-permanent');
  });
});

describe('sweep-reverts', () => {
  const merged = (n, sha) => ({ event_id: `0000000${n}-0000-7000-8000-00000000000${n}`, payload: { kind: 'merged', ref: `pr:${n}`, merge_sha: sha }, repo_name: 'o/r', work_item_id: WI, coordinator: 'CES' });
  const A = 'a'.repeat(40); const B = 'b'.repeat(40);

  it('parses revert shas out of a git log', () => {
    assert.deepEqual([...parseRevertedShas(`h1\nRevert x\n\nThis reverts commit ${A}.\n\u0000h2\nplain\n\u0000`)], [A]);
  });
  it('reverted, clean, and unobserved are three different outcomes', () => {
    const plan = planObservations([merged(1, A), merged(2, B), merged(3, 'c'.repeat(40)), { ...merged(4, A), payload: { kind: 'merged', ref: 'pr:4' } }], {
      revertedShas: new Set([A]), contains: (s) => s !== 'c'.repeat(40), nowIso: NOW,
    });
    assert.deepEqual(plan.emit.map((e) => e.payload.kind), ['reverted', 'observed-clean']);
    assert.deepEqual(plan.unobserved.map((u) => u.reason), ['merge-sha-not-in-history', 'no-merge-sha']);
  });
  it('a derived observation id is deterministic, so two sweepers mint the same row', () => {
    const run = () => planObservations([merged(1, A)], { revertedShas: new Set(), contains: () => true, nowIso: NOW }).emit[0].event_id;
    assert.equal(run(), run());
    assert.equal(planObservations([merged(1, A)], { revertedShas: new Set(), contains: () => true, nowIso: NOW }).emit[0].parent_event_id, merged(1, A).event_id);
  });
  it('a failed fetch or shallow history emits NOTHING (unobserved, never clean)', async () => {
    const submitted = [];
    const res = await sweepReverts({ deps: { readHistory: () => ({ ok: false, reason: 'fetch-failed:offline' }), listCandidates: async () => [{ ...merged(1, A), event_at: '2026-10-01T00:00:00Z', purge_generation: '0' }], submit: async (e) => submitted.push(e), nowIso: NOW } });
    assert.equal(res.status, 'fetch-failed:offline');
    assert.equal(submitted.length, 0);
  });
  it('lists ONLY this repository (repoName is passed to the store query)', async () => {
    let seen;
    await sweepReverts({ repoName: 'o/r', deps: { listCandidates: async (o) => { seen = o; return []; }, submit: async () => ({ state: 'persisted' }) } });
    assert.equal(seen.repoName, 'o/r');
  });
  it('the history window reaches back to the OLDEST candidate, and a merge beyond the cap is left unobserved', async () => {
    let asked;
    const old = { ...merged(1, A), event_at: '2026-08-01T00:00:00Z', purge_generation: '0' };      // 86 days before NOW
    const ancient = { ...merged(2, B), event_at: '2024-01-01T00:00:00Z', purge_generation: '0' };
    const res = await sweepReverts({ deps: {
      readHistory: (cwd, o) => { asked = o.windowDays; return { ok: true, revertedShas: new Set(), contains: () => true }; },
      listCandidates: async () => [ancient, old], submit: async () => ({ state: 'persisted' }), nowIso: NOW } });
    assert.ok(asked >= 86 && asked <= 90, String(asked));
    assert.deepEqual([res.emitted, res.unobserved], [1, 1], 'the ancient merge is unobserved, never marked clean');
  });
  it('a derived observation carries its SOURCE event purge generation, not the current one', async () => {
    const got = [];
    await sweepReverts({ deps: {
      readHistory: () => ({ ok: true, revertedShas: new Set(), contains: () => true }),
      listCandidates: async () => [{ ...merged(1, A), event_at: '2026-10-01T00:00:00Z', purge_generation: '7' }],
      submit: async (e, o) => { got.push(o); return { state: 'persisted' }; }, nowIso: NOW } });
    assert.deepEqual(got, [{ purgeGeneration: 7 }]);
  });
  it('emits through submit and reports a cursor only when the page was full', async () => {
    const rows = [merged(1, A), merged(2, B)].map((r, i) => ({ ...r, event_at: `2026-10-0${i + 1}T00:00:00Z` }));
    const res = await sweepReverts({ limit: 2, deps: {
      readHistory: () => ({ ok: true, revertedShas: new Set(), contains: () => true }),
      listCandidates: async () => rows, submit: async () => ({ state: 'persisted' }), nowIso: NOW,
    } });
    assert.deepEqual([res.emitted, res.results.persisted], [2, 2]);
    assert.equal(res.next.eventId, rows[1].event_id);
  });
});

describe('fleet hooks (pure builders)', () => {
  it('only refused or pending claim/land/ready/restack produce a decision', () => {
    const mk = (verb, code) => fleetDecisionEvent(verb, null, { code, reason: 'r' }, { repoName: 'o/r', nowIso: NOW });
    assert.equal(mk('status', 'refused'), null);
    assert.equal(mk('claim', 'ok'), null);
    assert.equal(mk('land', 'refused').payload.chosen_option_id, 'refuse');
    assert.equal(mk('ready', 'pending').payload.chosen_option_id, 'wait');
    assert.deepEqual(mk('restack', 'refused').payload.options.map((o) => o.id), ['proceed', 'refuse']);
  });
  it('takes the work item from the branch and never guesses', () => {
    const withWi = fleetDecisionEvent('claim', null, { code: 'refused', branch: `claude/wi-${WI}` }, { repoName: 'o/r', nowIso: NOW });
    const without = fleetDecisionEvent('claim', null, { code: 'refused', branch: 'claude/x' }, { repoName: 'o/r', nowIso: NOW });
    assert.equal(withWi.work_item_id, WI);
    assert.equal(without.work_item_id, null);
  });
  it('the decision event is itself a valid ingress event', () => {
    assert.ok(parseIngress(fleetDecisionEvent('land', null, { code: 'refused', reason: 'not ready' }, { repoName: 'o/r', nowIso: NOW })).ok);
  });
  it('one merged outcome per landed PR with a merge sha only when well formed', () => {
    const evs = trainMergeEvents({ merges: [{ pr: 12, mergeCommit: 'd'.repeat(40) }, { pr: 13, mergeCommit: 'short' }, { pr: 'x' }] }, { repoName: 'Lbstrydom/claude-engineering-skills', nowIso: NOW, workItemOf: (n) => (n === 12 ? WI : null) });
    assert.equal(evs.length, 2);
    assert.deepEqual([evs[0].payload.ref, evs[0].payload.merge_sha, evs[0].work_item_id, evs[0].coordinator], ['pr:12', 'd'.repeat(40), WI, 'CES']);
    assert.equal(evs[1].payload.merge_sha, undefined);
    for (const e of evs) assert.ok(parseIngress(e).ok);
  });
  it('maps repos to coordinators', () => {
    assert.deepEqual(['Lbstrydom/claude-engineering-skills', 'Lbstrydom/wine-cellar-app', 'x/storyline', 'x/ai-organiser', 'x/other'].map(coordinatorFor), ['CES', 'WCA', 'STO', 'AIO', 'other']);
  });
});

describe('verb and static guards', () => {
  it('`ledger mint` works with no store and prints the conventions', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/cross-skill.mjs'), 'ledger', 'mint'], { encoding: 'utf8', env: { ...process.env, AUDIT_DB_URL: '', LEARNING_DISABLE: '1' } });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.ok(isWorkItemId(j.work_item_id));
    assert.equal(j.pr_footer, `Work-Item: ${j.work_item_id}`);
    assert.equal(j.trailer, `AI-Work-Item: ${j.work_item_id}`);
  });
  it('an unknown ledger verb is a usage error', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/cross-skill.mjs'), 'ledger', 'frobnicate'], { encoding: 'utf8', env: { ...process.env, AUDIT_DB_URL: '' } });
    assert.notEqual(r.status, 0);
  });
  it('only the store writer inserts into own_model_ledger (every producer goes through prepare + submit)', () => {
    const walk = (d, out = []) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.claude-skills') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.mjs')) out.push(p);
      }
      return out;
    };
    const sql = /\bINSERT\s+INTO\s+(?:public\.)?"?own_model_ledger"?(?![\w])/i;
    const writers = walk(path.join(ROOT, 'scripts')).map((f) => path.relative(ROOT, f).split(path.sep).join('/')).filter((r) => sql.test(fs.readFileSync(path.join(ROOT, r), 'utf8')));
    assert.deepEqual(writers, ['scripts/lib/store/own-model-ledger.mjs']);
  });
  it('the hooks never open a store connection on the fleet hot path', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/fleet/ledger-hook.mjs'), 'utf8');
    assert.ok(/isCloudEnabled: async \(\) => false/.test(src), 'spool-only deps must pin cloud off');
    assert.ok(!/store\/own-model-ledger/.test(src), 'the fleet hook must not import the store writer');
  });
});

describe('review round 2 fixes', () => {
  it('ownModelWorkItemPatch: unset is empty, a UUIDv7 passes, a malformed value is LOUD and dropped', async () => {
    const { ownModelWorkItemPatch } = await import('../scripts/lib/ledger/work-item.mjs');
    assert.deepEqual(ownModelWorkItemPatch(undefined), {});
    assert.deepEqual(ownModelWorkItemPatch(WI), { work_item_id: WI });
    const orig = process.stderr.write; let said = '';
    process.stderr.write = (c) => { said += c; return true; };
    try { assert.deepEqual(ownModelWorkItemPatch('not-a-uuid'), {}); } finally { process.stderr.write = orig; }
    assert.match(said, /NOT correlated/);
  });
  it('a DISABLED ledger does no work in either fleet hook (no git, no gh, nothing spooled)', async () => {
    const { recordFleetDecision, recordTrainLandings } = await import('../scripts/lib/fleet/ledger-hook.mjs');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oml-off-'));   // not a git repo: any git call would throw into hook-errors.log
    try {
      await recordFleetDecision('claim', null, { code: 'refused', reason: 'x' }, { cwd: d, env: { OWN_MODEL_LEDGER: 'off' } });
      await recordTrainLandings({ merges: [{ pr: 1, mergeCommit: 'a'.repeat(40) }] }, { cwd: d, processEnv: { LEARNING_DISABLE: '1' }, workItemOf: () => { throw new Error('gh must not run'); } });
      assert.deepEqual(fs.readdirSync(d), []);
    } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
  it('purge also clears a quarantined file that is valid JSON but not an event', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oml-q-'));
    try {
      fs.mkdirSync(path.join(d, 'quarantine'));
      const f = path.join(d, 'quarantine', '00000000-0000-7000-8000-0000000000dd.json');
      fs.writeFileSync(f, JSON.stringify({ kind: 'task' }));
      assert.equal(purgeLocal(d, { workItem: WI }), 1);
      assert.ok(!fs.existsSync(f));
    } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});
