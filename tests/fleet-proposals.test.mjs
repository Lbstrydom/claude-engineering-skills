/**
 * @fileoverview The findings intake queue (docs/plans/fleet-proposals-queue.md): schema, store, outcomes, the
 * read-result contract, the one summary line, grouping, originator attribution and the `blockedBy` recheck.
 * Tier 1 (deterministic module): every refusal is shown, and the rules that must not fire are shown not to.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupFleetRoots, tmpRoot } from './helpers/fleet-repo.mjs';
import {
  FINAL_STATES, HISTORY_MAX, proposalIdExists, MAX_RECORD_BYTES, PROPOSALS_CAP, PROPOSAL_STALE_DAYS, ProposalSchema, applyOutcome, archiveProposal, groupByTheme,
  isBranchName, newProposal, originatedBy, parseBlockedBy, parsePrRef, proposalsLine, proposalsQuiet, proposalsSummary, readProposals,
  recheckBlockedBy, sweepStranded, transitionProposal, writeProposal,
} from '../scripts/lib/fleet/proposals.mjs';

after(cleanupFleetRoots);

const T0 = '2026-10-01T10:00:00.000Z';
const DAY = 86_400_000;
const idN = (n) => `p-20261001100000-${n.toString(16).padStart(4, '0')}`;
const mk = (n, over = {}) => newProposal({
  id: idN(n), what: `finding ${n}`, where: 'scripts/x.mjs', why: 'because', originator: { id: 'sess-a', branch: 'b-a' }, at: T0, ...over,
});
const dirOf = () => tmpRoot('fleet-prop-');
const store = (dir) => path.join(dir, 'proposals');
const activeFiles = (dir) => fs.readdirSync(store(dir)).filter((n) => n.endsWith('.json'));
const closedFiles = (dir) => {
  const c = path.join(store(dir), 'closed');
  return fs.existsSync(c) ? fs.readdirSync(c).flatMap((m) => fs.readdirSync(path.join(c, m))) : [];
};

describe('schema', () => {
  it('accepts a minimal record and the full one', () => {
    assert.equal(mk(1).state, 'pending');
    const full = mk(2, { evidence: 'log line', theme: 'gate-cost', blockedBy: { kind: 'pr', ref: '#9', repo: 'o/n' } });
    assert.equal(ProposalSchema.parse(full).blockedBy.repo, 'o/n');
  });
  it('rejects each missing or malformed required field', () => {
    for (const bad of [{ what: '' }, { where: ' '.repeat(0) }, { why: undefined }, { what: 'a\nb' }, { what: 'x'.repeat(601) }, { theme: 'Bad Theme' }, { theme: '-x' }]) {
      assert.throws(() => mk(3, bad), `${JSON.stringify(bad).slice(0, 40)}`);
    }
    assert.throws(() => ProposalSchema.parse({ ...mk(4), extra: 1 }), 'strict: unknown keys are refused');
    assert.throws(() => ProposalSchema.parse({ ...mk(5), id: 'p-1' }));
  });
  it('state must equal the last history entry, and history needs a pending first entry and a detail on every outcome', () => {
    const p = mk(6);
    assert.throws(() => ProposalSchema.parse({ ...p, state: 'queued' }), /state must equal/);
    assert.throws(() => ProposalSchema.parse({ ...p, state: 'queued', history: [...p.history, { at: T0, state: 'queued', by: 'x' }] }), /needs a detail/);
    assert.throws(() => ProposalSchema.parse({ ...p, history: [{ at: T0, state: 'queued', by: 'x', detail: 'd' }], state: 'queued' }), /first history entry/);
  });
  it('nothing may follow a final state', () => {
    const p = mk(7);
    const h = [...p.history, { at: T0, state: 'done', by: 'x', detail: '#1' }, { at: T0, state: 'queued', by: 'x', detail: 'again' }];
    assert.throws(() => ProposalSchema.parse({ ...p, state: 'queued', history: h }), /nothing may follow/);
  });
});

describe('input parsing', () => {
  it('PR references: #N, N, and a URL that keeps its repository', () => {
    assert.deepEqual(parsePrRef('#12'), { ok: true, ref: '#12' });
    assert.deepEqual(parsePrRef('12'), { ok: true, ref: '#12' });
    assert.deepEqual(parsePrRef('https://github.com/o/n/pull/7'), { ok: true, ref: '#7', repo: 'o/n' });
    for (const bad of ['', '0', '#0', 'abc', '12x', 'https://github.com/o/n/issues/7']) assert.equal(parsePrRef(bad).ok, false, bad);
  });
  it('--blocked-by: a PR first, else a bare branch name; anything else is refused', () => {
    assert.deepEqual(parseBlockedBy('#5').value, { kind: 'pr', ref: '#5' });
    assert.deepEqual(parseBlockedBy('claude/zen-sanderson-9ba76a').value, { kind: 'branch', ref: 'claude/zen-sanderson-9ba76a' });
    assert.deepEqual(parseBlockedBy('https://github.com/o/n/pull/3').value, { kind: 'pr', ref: '#3', repo: 'o/n' });
    for (const bad of ['', '  ', '-x', 'refs/heads/x', 'a b', 'a..b', 'topic~1', 'topic^', 'topic^2', 'topic@{1}', 'topic@{upstream}', 'a:b', 'a?b', 'a*b', 'a[b', 'a\b', '/x', 'x/', 'x.', 'a//b', '.hidden', 'a/.b', 'x.lock', 'a/x.lock/b', '@']) {
      assert.equal(parseBlockedBy(bad).ok, false, JSON.stringify(bad));
      assert.equal(isBranchName(bad), false, `${bad} (the persisted-record validator agrees)`);
    }
    for (const good of ['main', 'claude/fleet-proposals', 'claude/zen-sanderson-9ba76a', 'feature/a.b-c_d', 'v1.2']) assert.equal(isBranchName(good), true, good);
    assert.throws(() => mk(1, { blockedBy: { kind: 'branch', ref: 'topic~1' } }), 'a stored record cannot carry revision syntax either');
  });
});

describe('outcomes', () => {
  const at = '2026-10-02T10:00:00.000Z';
  it('each outcome needs its reason or ref; none is accepted empty', () => {
    const p = mk(1);
    for (const state of ['folded', 'queued', 'declined', 'done']) {
      assert.equal(applyOutcome(p, { state, detail: '  ', by: 'c', at }).ok, false, state);
      assert.equal(applyOutcome(p, { state, by: 'c', at }).ok, false, state);
    }
    assert.equal(applyOutcome(p, { state: 'pending', detail: 'x', by: 'c', at }).ok, false, 'pending is not an outcome');
  });
  it('done takes a PR reference (normalised) and rejects free text', () => {
    assert.equal(applyOutcome(mk(1), { state: 'done', detail: '12', by: 'c', at }).record.history.at(-1).detail, '#12');
    assert.equal(applyOutcome(mk(1), { state: 'done', detail: 'https://github.com/o/n/pull/4', by: 'c', at }).record.history.at(-1).detail, 'o/n#4');
    assert.match(applyOutcome(mk(1), { state: 'done', detail: 'it is fixed', by: 'c', at }).reason, /PR reference/);
  });
  it('transition matrix: pending/queued -> anything; folded -> queued|declined|done; final is final', () => {
    const queued = applyOutcome(mk(1), { state: 'queued', detail: 'waiting for a slot', by: 'c', at }).record;
    assert.equal(applyOutcome(queued, { state: 'queued', detail: 'still waiting', by: 'c', at }).ok, true, 're-queue with a new reason');
    const folded = applyOutcome(queued, { state: 'folded', detail: 'sess-b', by: 'c', at }).record;
    assert.equal(applyOutcome(folded, { state: 'folded', detail: 'sess-c', by: 'c', at }).ok, false, 'fold twice');
    for (const s of ['queued', 'declined', 'done']) assert.equal(applyOutcome(folded, { state: s, detail: s === 'done' ? '#1' : 'x', by: 'c', at }).ok, true, s);
    for (const f of FINAL_STATES) {
      const fin = applyOutcome(mk(1), { state: f, detail: f === 'done' ? '#1' : 'no', by: 'c', at }).record;
      for (const s of ['folded', 'queued', 'declined', 'done']) assert.match(applyOutcome(fin, { state: s, detail: s === 'done' ? '#2' : 'x', by: 'c', at }).reason, /already/, `${f} -> ${s}`);
    }
  });
  it('history is bounded at 50 with the last slot reserved for a final outcome (exact boundary)', () => {
    let p = mk(1);
    let n = 1;
    while (applyOutcome(p, { state: 'queued', detail: `r${n}`, by: 'c', at }).ok) { p = applyOutcome(p, { state: 'queued', detail: `r${n}`, by: 'c', at }).record; n += 1; }
    assert.equal(p.history.length, HISTORY_MAX - 1, 'non-final transitions stop at 49 entries');
    assert.match(applyOutcome(p, { state: 'queued', detail: 'x', by: 'c', at }).reason, /nearly full/);
    assert.match(applyOutcome(p, { state: 'folded', detail: 'x', by: 'c', at }).reason, /nearly full/);
    const closed = applyOutcome(p, { state: 'done', detail: '#1', by: 'c', at });
    assert.equal(closed.ok, true, 'a final outcome is still accepted at the 50th entry');
    assert.equal(closed.record.history.length, HISTORY_MAX);
  });
});

describe('the store', () => {
  it('writes, refuses an existing id, and round-trips through readProposals', () => {
    const dir = dirOf();
    writeProposal(dir, mk(1));
    assert.throws(() => writeProposal(dir, mk(1)), /already exists/);
    const r = readProposals(dir);
    assert.equal(r.records.length, 1);
    assert.equal(r.complete, true);
  });
  it('a missing directory is a MEASURED zero; an unlistable one is unmeasured (never zero)', () => {
    const dir = dirOf();
    const none = readProposals(dir);
    assert.deepEqual([none.complete, none.unmeasured, none.records.length], [true, false, 0]);
    assert.equal(proposalsLine(proposalsSummary(none, Date.parse(T0)), 'fleet'), 'proposals: none pending');
    fs.writeFileSync(store(dir), 'a file where the directory should be');
    const bad = readProposals(dir);
    assert.equal(bad.unmeasured, true);
    const line = proposalsLine(proposalsSummary(bad, Date.parse(T0)), 'fleet');
    assert.match(line, /^proposals: unmeasured \(/);
    assert.ok(!/none pending|\b0\b/.test(line), 'control: an unreadable store must never read as zero');
  });
  it('invalid, unsupported and oversized records are diagnostics, never dropped and never rewritten', () => {
    const dir = dirOf();
    writeProposal(dir, mk(1));
    fs.writeFileSync(path.join(store(dir), idN(2) + '.json'), '{ not json');
    fs.writeFileSync(path.join(store(dir), idN(3) + '.json'), JSON.stringify({ ...mk(3), schemaVersion: 2 }));
    fs.writeFileSync(path.join(store(dir), idN(4) + '.json'), JSON.stringify({ ...mk(4), id: idN(9) }));
    fs.writeFileSync(path.join(store(dir), idN(5) + '.json'), JSON.stringify({ ...mk(5), pad: 'x'.repeat(MAX_RECORD_BYTES) }));
    const before = fs.readFileSync(path.join(store(dir), idN(3) + '.json'), 'utf8');
    const r = readProposals(dir);
    assert.equal(r.records.length, 1);
    assert.equal(r.complete, false);
    assert.equal(r.unsupported.length, 1);
    assert.deepEqual(r.unreadable.map((u) => u.file).sort(), [idN(2), idN(4), idN(5)].map((i) => `${i}.json`).sort());
    assert.match(r.unreadable.find((u) => u.file.startsWith(idN(5))).reason, /larger than 64 KiB/);
    assert.match(r.unreadable.find((u) => u.file.startsWith(idN(4))).reason, /does not match the filename/);
    const t = transitionProposal(dir, idN(3), { state: 'queued', detail: 'x', by: 'c', at: T0 });
    assert.equal(t.ok, false);
    assert.equal(fs.readFileSync(path.join(store(dir), idN(3) + '.json'), 'utf8'), before, 'an unsupported record is not rewritten');
  });
  it('past the active cap the read is truncated and incomplete, never a short list', () => {
    const dir = dirOf();
    for (let i = 1; i <= 5; i += 1) writeProposal(dir, mk(i));
    const r = readProposals(dir, { cap: 3 });
    assert.deepEqual([r.records.length, r.truncated, r.complete], [3, true, false]);
    assert.match(proposalsLine(proposalsSummary(r, Date.parse(T0)), 'fleet'), /≥3 pending.*read truncated/);
    assert.equal(PROPOSALS_CAP, 2000);
  });
});

describe('closing: one commit point, idempotent archival', () => {
  const change = { state: 'done', detail: '#5', by: 'coord', at: '2026-10-03T00:00:00.000Z' };
  it('done commits the final state then moves the file to closed/<yyyy-mm>/ (never deleted)', () => {
    const dir = dirOf();
    writeProposal(dir, mk(1));
    const r = transitionProposal(dir, idN(1), change);
    assert.deepEqual([r.ok, r.archived], [true, true]);
    assert.deepEqual(activeFiles(dir), []);
    assert.deepEqual(closedFiles(dir), [`${idN(1)}.json`]);
    assert.ok(fs.existsSync(path.join(store(dir), 'closed', '2026-10', `${idN(1)}.json`)));
    assert.equal(readProposals(dir).records.length, 0, 'active reads never see a closed record');
    const all = readProposals(dir, { closed: true });
    assert.deepEqual(all.records.map((p) => [p.id, p.state, p.closed]), [[idN(1), 'done', true]]);
  });
  it('a refused re-transition names the final state and changes nothing (control: the record is intact)', () => {
    const dir = dirOf();
    writeProposal(dir, mk(1));
    transitionProposal(dir, idN(1), change);
    const again = transitionProposal(dir, idN(1), { ...change, state: 'queued', detail: 'x' });
    assert.equal(again.ok, false);
    assert.match(again.reason, /already done/);
    assert.equal(readProposals(dir, { closed: true }).records[0].history.length, 2);
  });
  it('a rename failure AFTER the commit is a success with archivalPending; the record is not counted open; the next sweep archives it', () => {
    const dir = dirOf();
    writeProposal(dir, mk(1));
    writeProposal(dir, mk(2));
    const failing = () => { throw new Error('EPERM: rename blocked'); };
    const r = transitionProposal(dir, idN(1), change, { rename: failing });
    assert.equal(r.ok, true);
    assert.equal(r.archived, false);
    assert.match(r.archivalPending, /EPERM/);
    const read = readProposals(dir);
    assert.equal(read.records.find((p) => p.id === idN(1)).state, 'done', 'the commit landed');
    assert.equal(proposalsSummary(read, Date.parse(T0)).pending, 1, 'a stranded final record is not open');
    const stuck = sweepStranded(dir, { rename: failing });
    assert.deepEqual([stuck.moved.length, stuck.failed.length], [0, 1]);
    assert.deepEqual(activeFiles(dir).sort(), [`${idN(1)}.json`, `${idN(2)}.json`], 'one failing record blocks nothing else');
    const healed = sweepStranded(dir);
    assert.deepEqual(healed.moved, [idN(1)]);
    assert.deepEqual(closedFiles(dir), [`${idN(1)}.json`]);
  });
  it('an --all read that sees one id in both directories keeps the closed copy once', () => {
    const dir = dirOf();
    writeProposal(dir, mk(1));
    const fin = applyOutcome(mk(1), change).record;
    fs.mkdirSync(path.join(store(dir), 'closed', '2026-10'), { recursive: true });
    fs.writeFileSync(path.join(store(dir), 'closed', '2026-10', `${idN(1)}.json`), JSON.stringify(fin));
    const r = readProposals(dir, { closed: true });
    assert.deepEqual(r.records.map((p) => [p.id, p.state, p.closed]), [[idN(1), 'done', true]]);
  });
  it('lifetime growth cannot hide a pending proposal: closed records are outside the active cap', () => {
    const dir = dirOf();
    for (let i = 1; i <= 6; i += 1) { writeProposal(dir, mk(i)); transitionProposal(dir, idN(i), change); }
    writeProposal(dir, mk(7));
    const r = readProposals(dir, { cap: 3 });
    assert.deepEqual([r.records.map((p) => p.id), r.complete, r.truncated], [[idN(7)], true, false]);
    assert.equal(readProposals(dir, { closed: true }).records.length, 7);
  });
  it('archiveProposal is idempotent and reports a missing source rather than throwing', () => {
    const dir = dirOf();
    const fin = applyOutcome(mk(1), change).record;
    assert.equal(archiveProposal(dir, fin).archived, false);
    writeProposal(dir, fin);
    assert.equal(archiveProposal(dir, fin).archived, true);
    assert.equal(archiveProposal(dir, fin).archived, true, 'already closed is still success');
  });
});

describe('the summary line (one builder for status and next)', () => {
  const s = (records, extra = {}) => proposalsSummary({ records, complete: true, truncated: false, unmeasured: false, unreadable: [], unsupported: [], ...extra }, Date.parse(T0) + 4 * DAY);
  it('counts pending, queued and folded; oldest is the oldest PENDING; stale means pending past 3 days', () => {
    const q = { ...mk(2), state: 'queued', history: [...mk(2).history, { at: T0, state: 'queued', by: 'c', detail: 'r' }] };
    const sum = s([mk(1), mk(3, { at: new Date(Date.parse(T0) + 3.5 * DAY).toISOString() }), q]);
    assert.deepEqual([sum.pending, sum.queued, sum.oldestPendingDays, sum.stalePending], [2, 1, 4, 1]);
    assert.equal(proposalsLine(sum, 'fleet'), `proposals: 2 pending, oldest 4d (1 queued) — 1 pending more than ${PROPOSAL_STALE_DAYS}d: triage with \`fleet proposals\``);
  });
  it('none pending is said, quiet only when nothing is open at all', () => {
    assert.equal(proposalsLine(s([]), 'fleet'), 'proposals: none pending');
    assert.equal(proposalsQuiet(s([])), true);
    const q = { ...mk(2), state: 'queued', history: [...mk(2).history, { at: T0, state: 'queued', by: 'c', detail: 'r' }] };
    assert.equal(proposalsLine(s([q]), 'fleet'), 'proposals: none pending (1 queued)');
    assert.equal(proposalsQuiet(s([q])), false);
  });
  it('an incomplete read prints lower bounds and names the cause; it is never quiet', () => {
    const sum = s([mk(1)], { complete: false, unreadable: [{ file: 'x', reason: 'y' }, { file: 'z', reason: 'y' }] });
    assert.equal(proposalsLine(sum, 'fleet'), 'proposals: ≥1 pending, oldest ≥4d — 1 pending more than 3d: triage with `fleet proposals` — 2 record(s) unreadable; `fleet proposals` names them');
    assert.equal(proposalsQuiet(s([], { complete: false })), false);
    assert.match(proposalsLine(s([], { complete: false, unreadable: [{ file: 'x', reason: 'y' }] }), 'fleet'), /none pending among the records read/);
  });
  it('the 3-day flag is a strict threshold', () => {
    const exactly = proposalsSummary({ records: [mk(1)], complete: true, truncated: false, unmeasured: false, unreadable: [], unsupported: [] }, Date.parse(T0) + 3 * DAY);
    assert.equal(exactly.stalePending, 0);
    assert.equal(proposalsSummary({ records: [mk(1)], complete: true, truncated: false, unmeasured: false, unreadable: [], unsupported: [] }, Date.parse(T0) + 3 * DAY + 1).stalePending, 1);
  });
});

describe('grouping and attribution', () => {
  it('groups by theme alphabetically with (no theme) last, each oldest first', () => {
    const g = groupByTheme([mk(1), mk(2, { theme: 'zeta' }), mk(3, { theme: 'alpha', at: '2026-10-05T00:00:00.000Z' }), mk(4, { theme: 'alpha' })]);
    assert.deepEqual(g.map((x) => x.theme), ['alpha', 'zeta', '(no theme)']);
    assert.deepEqual(g[0].items.map((p) => p.id), [idN(4), idN(3)]);
  });
  it('originatedBy matches the originator id only, and only pending ones', () => {
    const other = mk(2, { originator: { id: 'sess-b', branch: 'b-a' } });
    const queued = { ...mk(3), state: 'queued', history: [...mk(3).history, { at: T0, state: 'queued', by: 'c', detail: 'r' }] };
    assert.deepEqual(originatedBy([mk(1), other, queued], 'sess-a').map((p) => p.id), [idN(1)]);
    assert.deepEqual(originatedBy([mk(1), other, queued], 'b-a').map((p) => p.id), [], 'the creation branch is provenance, never matched');
  });
});

describe('blockedBy recheck: a label from facts, never a scheduler', () => {
  const gh = (j, status = 0) => (args) => { gh.calls.push(args); return { status, stdout: JSON.stringify(j), stderr: 'boom' }; };
  gh.calls = [];
  const proposals = (b) => [mk(1, { blockedBy: b })];
  const key = (b) => (b.kind === 'pr' ? `pr:${b.repo ?? ''}${b.ref}` : `branch:${b.ref}`);
  const never = () => { throw new Error('unexpected git call'); };

  it('PR: merged -> resolved, closed -> closed-unmerged, open -> waiting; a foreign-repo URL is asked with --repo', () => {
    for (const [state, want] of [['MERGED', 'resolved'], ['CLOSED', 'closed-unmerged'], ['OPEN', 'waiting']]) {
      gh.calls = [];
      const b = { kind: 'pr', ref: '#7', repo: 'other/repo' };
      const m = recheckBlockedBy(proposals(b), { ghRun: gh({ state }), gitRun: never, baseBranch: 'main' });
      assert.equal(m.get(key(b)).state, want, state);
      assert.deepEqual(gh.calls[0], ['pr', 'view', '7', '--repo', 'other/repo', '--json', 'state,mergedAt']);
    }
    gh.calls = [];
    recheckBlockedBy(proposals({ kind: 'pr', ref: '#7' }), { ghRun: gh({ state: 'OPEN' }), gitRun: never, baseBranch: 'main' });
    assert.ok(!gh.calls[0].includes('--repo'), 'a bare #N asks this repository');
  });
  it('PR: every failure is unknown, never resolved', () => {
    const b = { kind: 'pr', ref: '#7' };
    const run = (ghRun) => recheckBlockedBy(proposals(b), { ghRun, gitRun: never, baseBranch: 'main' }).get(key(b));
    assert.equal(run(() => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }), status: null })).text, 'unknown (gh not installed)');
    assert.match(run(gh({}, 1)).text, /^unknown \(gh pr view exited 1: boom\)/);
    assert.match(run(() => ({ status: 0, stdout: 'not json' })).text, /unparseable/);
    assert.match(run(gh({ state: 'DRAFT' })).text, /unexpected PR state/);
    for (const r of [run(() => ({ error: new Error('t'), status: null })), run(gh({}, 1))]) assert.equal(r.state, 'unknown');
  });

  const oid = (c) => c.repeat(40);
  const gitWith = (table) => (args) => {
    const key = args.join(' ');
    for (const [pat, res] of table) if (key.includes(pat)) return { ok: res.status === 0, status: res.status, stdout: res.out ?? '', reason: res.status === 0 ? null : `git exited ${res.status}` };
    return { ok: false, status: 1, stdout: '', reason: 'git exited 1' };
  };
  const B = { kind: 'branch', ref: 'feat' };
  const run = (table, base = 'main') => recheckBlockedBy(proposals(B), { ghRun: never, gitRun: gitWith(table), baseBranch: base }).get(key(B));

  it('branch: ancestor of the base -> resolved; not an ancestor -> waiting; neither namespace present -> gone', () => {
    const present = [['refs/heads/feat^', { status: 0, out: oid('a') }], ['refs/heads/main^', { status: 0, out: oid('b') }], ['refs/remotes/origin/main^', { status: 0, out: oid('b') }]];
    assert.equal(run([...present, ['--is-ancestor', { status: 0 }]]).state, 'resolved');
    assert.equal(run([...present, ['--is-ancestor', { status: 1 }]]).state, 'waiting');
    assert.equal(run([['refs/heads/main^', { status: 0, out: oid('b') }]]).state, 'gone');
  });
  it('branch: merged into origin/<base> but not the local base counts as merged', () => {
    const t = [['refs/heads/feat^', { status: 0, out: oid('a') }], ['refs/heads/main^', { status: 0, out: oid('b') }], ['refs/remotes/origin/main^', { status: 0, out: oid('c') }],
      [`${oid('a')} ${oid('b')}`, { status: 1 }], [`${oid('a')} ${oid('c')}`, { status: 0 }]];
    assert.equal(run(t).state, 'resolved');
  });
  it('branch: an unresolvable base, an unknown base, or a git failure is unknown, never resolved', () => {
    const tip = ['refs/heads/feat^', { status: 0, out: oid('a') }];
    assert.match(run([tip]).text, /base main does not resolve/);
    assert.match(run([tip], null).text, /base branch is not known/);
    assert.match(run([['refs/heads/feat^', { status: null }]]).text, /^unknown/);
    assert.equal(run([tip, ['refs/heads/main^', { status: 0, out: oid('b') }], ['--is-ancestor', { status: 128 }]]).state, 'unknown');
  });
  it('distinct blockers are probed once each and capped at 20; the rest are unknown, not unchecked-and-resolved', () => {
    const many = Array.from({ length: 22 }, (_, i) => mk(i + 1, { blockedBy: { kind: 'pr', ref: `#${i + 1}` } }));
    gh.calls = [];
    const m = recheckBlockedBy([...many, mk(30, { blockedBy: { kind: 'pr', ref: '#1' } })], { ghRun: gh({ state: 'OPEN' }), gitRun: never, baseBranch: 'main' });
    assert.equal(gh.calls.length, 20);
    assert.match(m.get('pr:#22').text, /not checked: more than 20/);
    assert.equal(m.get('pr:#22').state, 'unknown');
  });
});

describe('persistence contract (code audit round 1)', () => {
  it('writers enforce the reader\'s serialized-byte limit (multibyte text), so no record can be written that reads back unreadable', () => {
    const dir = dirOf();
    writeProposal(dir, mk(1));
    const wide = '\u20ac'.repeat(500); // 3 bytes each: 500 chars is inside the text limit, 1500 bytes is not small
    let last;
    let n = 0;
    do { last = transitionProposal(dir, idN(1), { state: 'queued', detail: wide, by: 'c', at: T0 }); n += 1; } while (last.ok && n < 60);
    assert.equal(last.ok, false, 'a non-final transition that would use the closing entry\'s reserve is refused');
    assert.match(last.reason, /60 KiB limit for a queued record.*4 KiB stay free so it can always be closed/);
    const closed = transitionProposal(dir, idN(1), { state: 'done', detail: '#9', by: 'c'.repeat(200), at: T0 });
    assert.equal(closed.ok, true, 'a record filled to the non-final limit can still be closed');
    const r = readProposals(dir);
    assert.equal(r.complete, true, 'control: every record the writer accepted is readable');
    assert.equal(readProposals(dir, { closed: true }).records[0].state, 'done');
    const archived = fs.readdirSync(path.join(store(dir), 'closed', T0.slice(0, 7)));
    assert.ok(Buffer.byteLength(fs.readFileSync(path.join(store(dir), 'closed', T0.slice(0, 7), archived[0]), 'utf8')) <= MAX_RECORD_BYTES);
  });
  it('an id is unique across active AND closed records, and a collision carries a stable code', () => {
    const dir = dirOf();
    writeProposal(dir, mk(1));
    assert.throws(() => writeProposal(dir, mk(1)), { code: 'EPROPOSAL_EXISTS' });
    transitionProposal(dir, idN(1), { state: 'done', detail: '#5', by: 'c', at: '2026-10-03T00:00:00.000Z' });
    assert.deepEqual(activeFiles(dir), [], 'control: the first record now lives only in closed/');
    assert.throws(() => writeProposal(dir, mk(1)), { code: 'EPROPOSAL_EXISTS' }, 'reuse after archival is refused');
  });
  it('uniqueness that cannot be established is a refusal, never "unused" (fail closed)', () => {
    const dir = dirOf();
    writeProposal(dir, mk(1));
    transitionProposal(dir, idN(1), { state: 'done', detail: '#5', by: 'c', at: '2026-10-03T00:00:00.000Z' });
    assert.equal(proposalIdExists(dir, idN(1)), true, 'control: the probe finds an archived id');
    assert.equal(proposalIdExists(dir, idN(9)), false, 'control: and an unused one');
    const real = fs.readdirSync;
    try {
      fs.readdirSync = (p, ...a) => { if (String(p).endsWith('closed')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return real(p, ...a); };
      assert.throws(() => proposalIdExists(dir, idN(9)), { code: 'EPROPOSAL_UNVERIFIABLE' });
      assert.throws(() => writeProposal(dir, mk(9)), { code: 'EPROPOSAL_UNVERIFIABLE' });
    } finally { fs.readdirSync = real; }
    assert.equal(proposalIdExists(dir, idN(9)), false, 'restored');
  });
  it('archival never replaces a closed record with a different one', () => {
    const dir = dirOf();
    const fin = applyOutcome(mk(1), { state: 'done', detail: '#5', by: 'c', at: '2026-10-03T00:00:00.000Z' }).record;
    writeProposal(dir, fin);
    fs.mkdirSync(path.join(store(dir), 'closed', '2026-10'), { recursive: true });
    fs.writeFileSync(path.join(store(dir), 'closed', '2026-10', `${idN(1)}.json`), 'older closed copy');
    const a = archiveProposal(dir, fin);
    assert.equal(a.archived, false);
    assert.match(a.reason, /not overwritten/);
    assert.equal(fs.readFileSync(path.join(store(dir), 'closed', '2026-10', `${idN(1)}.json`), 'utf8'), 'older closed copy');
  });
  it('a transition refuses a record whose embedded id differs from its filename (same rule as the reader)', () => {
    const dir = dirOf();
    fs.mkdirSync(store(dir), { recursive: true });
    fs.writeFileSync(path.join(store(dir), `${idN(1)}.json`), JSON.stringify(mk(2)));
    const before = fs.readFileSync(path.join(store(dir), `${idN(1)}.json`), 'utf8');
    const r = transitionProposal(dir, idN(1), { state: 'queued', detail: 'x', by: 'c', at: T0 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /embedded id does not match the filename/);
    assert.equal(fs.readFileSync(path.join(store(dir), `${idN(1)}.json`), 'utf8'), before);
  });
  it('timestamps are canonical UTC ISO, so the archive month is always derivable', () => {
    for (const bad of ['10/13/2026', '2026-10-13', 'Tue Oct 13 2026 10:00:00 GMT', '2026-10-13T10:00:00+02:00', '2026-13-01T00:00:00Z']) {
      assert.throws(() => mk(1, { at: bad }), bad);
    }
    assert.doesNotThrow(() => mk(1, { at: '2026-10-13T10:00:00Z' }));
    assert.doesNotThrow(() => mk(1, { at: '2026-10-13T10:00:00.123Z' }));
  });
  it('a record with an empty history is an isolated diagnostic, not an exception that takes the read down', () => {
    const dir = dirOf();
    writeProposal(dir, mk(1));
    fs.writeFileSync(path.join(store(dir), `${idN(2)}.json`), JSON.stringify({ ...mk(2), history: [] }));
    let r;
    assert.doesNotThrow(() => { r = readProposals(dir); });
    assert.deepEqual(r.records.map((p) => p.id), [idN(1)]);
    assert.equal(r.unreadable.length, 1);
  });
  it('a file that vanishes between listing and opening is not evidence of closure: found closed it is skipped, otherwise the read is incomplete (active-only AND --all)', () => {
    const dir = dirOf();
    writeProposal(dir, mk(1));
    const ghost = `${idN(8)}.json`;
    const real = fs.readdirSync;
    const withGhost = (fn) => {
      try {
        fs.readdirSync = (p, ...a) => { const r = real(p, ...a); return String(p).endsWith('proposals') ? [...r, ghost] : r; };
        return fn();
      } finally { fs.readdirSync = real; }
    };
    for (const closed of [false, true]) {
      const r = withGhost(() => readProposals(dir, { closed }));
      assert.equal(r.complete, false, `closed:${closed} - a vanished file with no closed copy makes the read incomplete`);
      assert.deepEqual(r.unreadable.map((u) => u.file), [ghost]);
      assert.deepEqual(r.records.map((p) => p.id), [idN(1)], 'control: the real record is still read');
    }
    // Now give the ghost a closed copy: it was genuinely just closed.
    writeProposal(dir, mk(8));
    transitionProposal(dir, idN(8), { state: 'done', detail: '#5', by: 'c', at: '2026-10-03T00:00:00.000Z' });
    for (const closed of [false, true]) {
      const r = withGhost(() => readProposals(dir, { closed }));
      assert.equal(r.complete, true, `closed:${closed} - found closed, the vanished entry is simply not open`);
      assert.deepEqual(r.unreadable, []);
    }
  });
  it('PR identity keeps the host: github.com is implicit, any other host is part of --repo', () => {
    assert.deepEqual(parsePrRef('https://github.com/o/n/pull/7'), { ok: true, ref: '#7', repo: 'o/n' });
    assert.deepEqual(parsePrRef('https://git.corp.example.com/team/app/pull/7'), { ok: true, ref: '#7', repo: 'git.corp.example.com/team/app' });
    const b = { kind: 'pr', ref: '#7', repo: 'git.corp.example.com/team/app' };
    assert.doesNotThrow(() => mk(1, { blockedBy: b }));
    const calls = [];
    recheckBlockedBy([mk(1, { blockedBy: b })], { ghRun: (a) => { calls.push(a); return { status: 0, stdout: '{"state":"OPEN"}' }; }, gitRun: () => { throw new Error('no git'); }, baseBranch: 'main' });
    assert.deepEqual(calls[0], ['pr', 'view', '7', '--repo', 'git.corp.example.com/team/app', '--json', 'state,mergedAt']);
    assert.equal(applyOutcome(mk(1), { state: 'done', detail: 'https://git.corp.example.com/team/app/pull/9', by: 'c', at: T0 }).record.history.at(-1).detail, 'git.corp.example.com/team/app#9');
  });
  it('branch recheck: resolved only when EVERY existing tip is in a base (a divergent local tip keeps it waiting)', () => {
    const oid = (c) => c.repeat(40);
    const B = { kind: 'branch', ref: 'feat' };
    const git = (merged) => (args) => {
      const k = args.join(' ');
      const res = (status, out = '') => ({ ok: status === 0, status, stdout: out, reason: status === 0 ? null : 'x' });
      if (k.includes('refs/heads/feat^')) return res(0, oid('a'));
      if (k.includes('refs/remotes/origin/feat^')) return res(0, oid('d'));
      if (k.includes('refs/heads/main^')) return res(0, oid('b'));
      if (k.includes('refs/remotes/origin/main^')) return res(1);
      if (k.includes('--is-ancestor')) return res(merged.some((m) => k.includes(m)) ? 0 : 1);
      return res(1);
    };
    const run = (merged) => recheckBlockedBy([mk(1, { blockedBy: B })], { ghRun: () => { throw new Error('no gh'); }, gitRun: git(merged), baseBranch: 'main' }).get('branch:feat').state;
    assert.equal(run([oid('a'), oid('d')]), 'resolved');
    assert.equal(run([oid('d')]), 'waiting', 'the local tip is not in the base');
    assert.equal(run([oid('a')]), 'waiting', 'the origin tip is not in the base');
  });
  it('a base that could not be loaded says why instead of reading as "absent"', () => {
    const B = { kind: 'branch', ref: 'feat' };
    const m = recheckBlockedBy([mk(1, { blockedBy: B })], { ghRun: () => { throw new Error('no gh'); }, gitRun: () => { throw new Error('no git'); }, baseBranch: null, baseError: 'fleet config could not be loaded: bad json' });
    assert.equal(m.get('branch:feat').text, 'unknown (fleet config could not be loaded: bad json)');
  });
});
