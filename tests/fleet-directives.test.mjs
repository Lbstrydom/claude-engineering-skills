/**
 * @fileoverview /fleet — directive records and the host sidecar (plan
 * docs/plans/fleet-consumer-feedback-oct.md §2.4; wine items 9-10, storyline 4).
 *
 * Pinned: the closed vocabulary (merge/push are not expressible), the reason
 * grammar, version dispatch (a newer record is listed, never acted on, and never
 * makes the SESSION registry incomplete), bounded active reads, append-only acks,
 * archive-by-move, and that an old reader of `sessions/`/`trains/` is unaffected.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_CAP, DirectiveSchema, ackDirective, classifyDirective, isOpenFor, newDirectiveId, readDirectives, readHosts, sweepDirectives,
  writeDirective, writeHost,
} from '../scripts/lib/fleet/directives.mjs';
import { listTrains, readSessions } from '../scripts/lib/fleet/registry.mjs';
import { tmpRoot, cleanupFleetRoots } from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const NOW = new Date('2026-10-09T12:00:00Z');
const d = (over = {}) => ({
  schemaVersion: 1, id: newDirectiveId(NOW), to: 'feat', kind: 'release', reason: { kind: 'pr-merged', ref: '#12' }, by: 'main',
  createdAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(), acks: [], ...over,
});
const fleet = () => { const dir = path.join(tmpRoot(), 'fleet'); fs.mkdirSync(dir, { recursive: true }); return dir; };

describe('schema — the closed vocabulary is the boundary', () => {
  it('merge, push, override and delete are not expressible', () => {
    for (const kind of ['merge', 'push', 'override', 'delete']) assert.equal(DirectiveSchema.safeParse(d({ kind })).success, false, kind);
    for (const kind of ['pause', 'resume', 'rebase', 'release', 'rerun-ready']) assert.equal(DirectiveSchema.safeParse(d({ kind, reason: { kind: 'note', note: 'x' } })).success, true, kind);
  });
  it('reason refs are validated per kind; a note needs no ref; an ISO hold ref with colons is fine', () => {
    const ok = (reason) => DirectiveSchema.safeParse(d({ reason })).success;
    assert.equal(ok({ kind: 'pr-merged', ref: '#12' }), true);
    assert.equal(ok({ kind: 'pr-merged', ref: '12' }), false);
    assert.equal(ok({ kind: 'hold', ref: '2026-10-09T11:00:00.000Z' }), true);
    assert.equal(ok({ kind: 'hold', ref: 'yesterday' }), false);
    assert.equal(ok({ kind: 'train', ref: 't-20261009120000-abcd' }), true);
    assert.equal(ok({ kind: 'note', note: 'see: thread' }), true);
    assert.equal(ok({ kind: 'note' }), false);
    assert.equal(ok({ kind: 'pr-merged' }), false, 'a non-note reason needs its ref');
  });
});

describe('version dispatch — the next release\'s record is visible, never actionable', () => {
  it('unknown schemaVersion or unknown kind → unsupported; garbage → invalid', () => {
    assert.ok(classifyDirective({ ...d(), schemaVersion: 2 }).unsupported);
    assert.ok(classifyDirective({ ...d(), kind: 'nudge' }).unsupported);
    assert.ok(classifyDirective({ schemaVersion: 1, id: 'x' }).invalid);
    assert.ok(classifyDirective(d()).directive);
  });
  it('readDirectives lists unsupported records apart; the session registry and trains stay complete', () => {
    const dir = fleet();
    writeDirective(dir, d());
    const act = path.join(dir, 'directives', 'active');
    fs.writeFileSync(path.join(act, 'd-20991231000000-ffff.json'), JSON.stringify({ ...d(), id: 'd-20991231000000-ffff', schemaVersion: 2 }));
    fs.mkdirSync(path.join(dir, 'hosts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hosts', 'zzz.json'), JSON.stringify({ schemaVersion: 9 }));
    fs.mkdirSync(path.join(dir, 'serial'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'serial', 't-20261009120000-abcd.json'), '{}');
    const r = readDirectives(dir);
    assert.equal(r.active.length, 1);
    assert.equal(r.unsupported.length, 1);
    assert.equal(readSessions(dir).complete, true, 'new directories never touch the session registry');
    assert.equal(listTrains(dir).complete, true, 'nor the trains listing');
    assert.equal(readHosts(dir).skipped.length, 1);
  });
});

describe('bounded active read', () => {
  it(`more than ${ACTIVE_CAP} active records → complete:false, never "all read"`, () => {
    const dir = fleet();
    const act = path.join(dir, 'directives', 'active');
    fs.mkdirSync(act, { recursive: true });
    for (let i = 0; i <= ACTIVE_CAP; i += 1) {
      const id = `d-20261009${String(i).padStart(6, '0')}-0000`;
      fs.writeFileSync(path.join(act, `${id}.json`), JSON.stringify(d({ id })));
    }
    const r = readDirectives(dir);
    assert.equal(r.complete, false);
    assert.equal(r.active.length, ACTIVE_CAP);
  });
});

describe('acks and archive', () => {
  it('ack is append-only and per recipient; a second ack is a no-op; a stranger cannot ack an addressed directive', () => {
    const dir = fleet();
    const x = writeDirective(dir, d());
    assert.equal(ackDirective(dir, x.id, { session: 'other', at: NOW.toISOString(), outcome: 'done' }).ok, false);
    const a = ackDirective(dir, x.id, { session: 'feat', at: NOW.toISOString(), outcome: 'done' });
    assert.deepEqual([a.ok, a.changed, a.directive.acks.length], [true, true, 1]);
    assert.equal(ackDirective(dir, x.id, { session: 'feat', at: NOW.toISOString(), outcome: 'declined' }).changed, false);
  });
  it('an ack refuses a file whose embedded id differs from its name (C2-R1-H4)', () => {
    const dir = fleet();
    const act = path.join(dir, 'directives', 'active');
    fs.mkdirSync(act, { recursive: true });
    fs.writeFileSync(path.join(act, 'd-20261009120000-aaaa.json'), JSON.stringify(d({ id: 'd-20261009120000-bbbb' })));
    assert.match(ackDirective(dir, 'd-20261009120000-aaaa', { session: 'feat', at: NOW.toISOString(), outcome: 'done' }).reason, /holds directive/);
  });
  it('the sweep reaches records past the checkpoint cap (C2-R1-M10)', () => {
    const dir = fleet();
    const act = path.join(dir, 'directives', 'active');
    fs.mkdirSync(act, { recursive: true });
    for (let i = 0; i <= ACTIVE_CAP; i += 1) {
      const id = `d-20261009${String(i).padStart(6, '0')}-0000`;
      fs.writeFileSync(path.join(act, `${id}.json`), JSON.stringify(d({ id, expiresAt: '2026-10-09T11:00:00Z' })));
    }
    assert.equal(sweepDirectives(dir, NOW).length, ACTIVE_CAP + 1);
  });
  it('an unsupported record is never rewritten by an ack', () => {
    const dir = fleet();
    const id = 'd-20991231000000-aaaa';
    const act = path.join(dir, 'directives', 'active');
    fs.mkdirSync(act, { recursive: true });
    const body = JSON.stringify({ ...d({ id }), schemaVersion: 2 });
    fs.writeFileSync(path.join(act, `${id}.json`), body);
    assert.equal(ackDirective(dir, id, { session: 'feat', at: NOW.toISOString(), outcome: 'done' }).ok, false);
    assert.equal(fs.readFileSync(path.join(act, `${id}.json`), 'utf8'), body);
  });
  it('sweep MOVES expired and answered directives to archive/<yyyy-mm>; an unanswered "all" stays until it expires', () => {
    const dir = fleet();
    const answered = writeDirective(dir, d({ id: 'd-20261009120000-0001' }));
    ackDirective(dir, answered.id, { session: 'feat', at: NOW.toISOString(), outcome: 'done' });
    writeDirective(dir, d({ id: 'd-20261009120000-0002', expiresAt: '2026-10-09T11:00:00Z' }));
    writeDirective(dir, d({ id: 'd-20261009120000-0003', to: 'all' }));
    assert.deepEqual(sweepDirectives(dir, NOW).sort(), ['d-20261009120000-0001', 'd-20261009120000-0002']);
    const r = readDirectives(dir, { archive: true });
    assert.deepEqual(r.active.map((x) => x.id), ['d-20261009120000-0003']);
    assert.equal(r.archived.length, 2, 'moved, never deleted');
  });
  it('isOpenFor: addressed, unexpired, unacked', () => {
    const x = d({ to: 'all' });
    assert.equal(isOpenFor(x, 'any', NOW), true);
    assert.equal(isOpenFor({ ...x, acks: [{ session: 'any', at: 'x', outcome: 'done' }] }, 'any', NOW), false);
    assert.equal(isOpenFor(d({ to: 'feat' }), 'other', NOW), false);
  });
});

describe('host sidecar', () => {
  it('round-trips by session id and is keyed like session records', () => {
    const dir = fleet();
    writeHost(dir, { id: 'feat/a', hostSession: 'local_abc123', at: NOW.toISOString() });
    assert.deepEqual(readHosts(dir).hosts, { 'feat/a': 'local_abc123' });
  });
});
