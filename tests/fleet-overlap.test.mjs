/**
 * @fileoverview /fleet Phase 2 — the pure decision core. No git, no fs, a frozen
 * `now` everywhere (one clock value, never two reads). Plan §9 Tier 1.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import micromatch from 'micromatch';
import {
  validateClaimPattern, validateClaimPatterns, patternsIntersect, fileOverlap, duplicatePatches,
  liveness, isLive, decideClaim, claimMode, approvable, proposeLandingOrder, buildStatus,
  worstResult, checkBlocksApproval, deriveDone, MAX_SEGMENT_CHARS, MAX_PATTERN_SEGMENTS,
} from '../scripts/lib/fleet/overlap.mjs';
import { renderStatus, renderClaimVerdict, renderApprovable } from '../scripts/lib/fleet/render.mjs';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const H = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const OID = (c) => c.repeat(40);

function session(over = {}) {
  const id = over.id ?? 'feat/a';
  return {
    schemaVersion: 1, rev: 1, id,
    source: { kind: 'branch', branch: id, repo: null, prNumber: null, headRepo: null, headRef: id, baseRef: 'main' },
    worktree: null, intent: 'do a thing', paths: [], state: 'working', gen: 1, startOid: OID('0'),
    waitingOn: [], ready: null, knownOverlaps: [],
    leaseExpiresAt: iso(NOW + H), updatedAt: iso(NOW), createdAt: iso(NOW - H), ...over,
  };
}

describe('claim-pattern grammar', () => {
  it('accepts the closed grammar', () => {
    for (const p of ['src/a.mjs', 'src/**', 'src/*.mjs', 'a?c', '**/x.js', '.github/*', '**']) {
      assert.equal(validateClaimPattern(p).ok, true, p);
    }
  });
  it('rejects {} [] ! ( ) leading / and .. — naming the character', () => {
    const cases = [['{a,b}', '{'], ['[x]', '['], ['!x', '!'], ['(a)', '('], ['/abs', 'leading'], ['../x', '..'], ['a/../b', '..'], ['a**b', '**'], ['a//b', 'empty'], ['', 'non-empty'], ['a\\b', '\\']];
    for (const [p, frag] of cases) {
      const r = validateClaimPattern(p);
      assert.equal(r.ok, false, p);
      assert.ok(r.reason.includes(frag), `${p}: ${r.reason}`);
    }
    assert.equal(validateClaimPatterns(['ok', '{x}']).ok, false);
    assert.equal(validateClaimPatterns('nope').ok, false);
  });
});

describe('patternsIntersect', () => {
  it('worked examples from the plan', () => {
    assert.equal(patternsIntersect('src/*.mjs', 'src/a*.mjs'), 'intersect');
    assert.equal(patternsIntersect('src/*.mjs', 'src/lib/**'), 'disjoint');
    assert.equal(patternsIntersect('src/**/x.js', 'src/x.js'), 'intersect'); // ** at zero segments
    assert.equal(patternsIntersect('src/a/**', 'src/b/**'), 'disjoint');
    assert.equal(patternsIntersect('**', 'anything/at/all'), 'intersect');
    assert.equal(patternsIntersect('a?c', 'abd'), 'disjoint');
    assert.equal(patternsIntersect('src/export/**', 'src/export/csv.mjs'), 'intersect');
    assert.equal(patternsIntersect('*.md', 'docs/*.md'), 'disjoint');
  });
  it('out-of-grammar input is unknown, never disjoint', () => {
    assert.equal(patternsIntersect('{a,b}', 'a'), 'unknown');
    assert.equal(patternsIntersect('a', '/a'), 'unknown');
  });

  // Seeded property check over a small EXHAUSTIVE corpus. Two independent oracles:
  //  * an own path-vs-pattern matcher with the documented grammar semantics — exactness
  //    (DP says intersect <=> some path matches both);
  //  * micromatch with the options fileOverlap uses — soundness (a path micromatch matches
  //    on both sides must never be called disjoint).
  // They differ in one place, pinned below: picomatch does not let a trailing `/**` match
  // its own prefix when the prefix segment contains `*` ("aa" vs "a*/**"). That under-matches
  // only a FILE named exactly the directory prefix, so the engine's answer (intersect) is the
  // conservative one.
  it('property: agrees with brute-force matching (exact vs grammar oracle, sound vs micromatch)', () => {
    let seed = 0x5eed1234;
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
    const segs = [];
    for (const len of [1, 2, 3]) {
      const gen = (q) => { if (q.length === len) { segs.push(q); return; } gen(`${q}a`); gen(`${q}b`); };
      gen('');
    }
    const corpus = [];
    for (const s1 of segs) {
      corpus.push(s1);
      for (const s2 of segs) {
        corpus.push(`${s1}/${s2}`);
        for (const s3 of segs) corpus.push(`${s1}/${s2}/${s3}`);
      }
    }
    const segRe = (seg) => new RegExp('^' + [...seg].map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c)).join('') + '$');
    const matchSegs = (pat, path) => {
      if (!pat.length) return path.length === 0;
      if (pat[0] === '**') return matchSegs(pat.slice(1), path) || (path.length > 0 && matchSegs(pat, path.slice(1)));
      return path.length > 0 && segRe(pat[0]).test(path[0]) && matchSegs(pat.slice(1), path.slice(1));
    };
    const own = (pattern) => (f) => matchSegs(pattern.split('/'), f.split('/'));
    const mm = new Map();
    const mmatch = (q) => { if (!mm.has(q)) mm.set(q, micromatch.matcher(q, { dot: true, nocase: false })); return mm.get(q); };
    const segPool = ['a', 'b', '*', '?', 'a*', '*b', '?a', 'a?', '*a*', '**', '**'];
    const randPattern = () => Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => pick(segPool)).join('/');
    let intersects = 0; let disjoints = 0;
    for (let n = 0; n < 400; n += 1) {
      const a = randPattern(); const b = randPattern();
      const oa = own(a); const ob = own(b);
      const witness = corpus.some((f) => oa(f) && ob(f));
      const got = patternsIntersect(a, b);
      assert.notEqual(got, 'unknown', `${a} / ${b}`);
      assert.equal(got === 'intersect', witness, `${a} vs ${b}: DP=${got}, brute-force witness=${witness}`);
      const ma = mmatch(a); const mb = mmatch(b);
      if (corpus.some((f) => ma(f) && mb(f))) assert.equal(got, 'intersect', `unsound vs micromatch: ${a} vs ${b}`);
      if (witness) intersects += 1; else disjoints += 1;
    }
    assert.ok(intersects > 40 && disjoints > 40, `corpus must exercise both outcomes (${intersects}/${disjoints})`);
  });
  it('documented picomatch divergence: trailing /** after a starred segment; engine stays conservative', () => {
    assert.equal(micromatch.isMatch('aa', 'a*/**', { dot: true }), false);
    assert.equal(patternsIntersect('a*/**', 'aa'), 'intersect');
    assert.equal(micromatch.isMatch('src', 'src/**', { dot: true }), true);
  });
});

describe('fileOverlap', () => {
  it('** matches zero segments and dotfiles are matched by * (agreeing with patternsIntersect)', () => {
    assert.deepEqual(fileOverlap(['src/a.mjs', 'src/x/b.mjs', 'lib/c.mjs'], ['src/**/*.mjs']), ['src/a.mjs', 'src/x/b.mjs']);
    assert.deepEqual(fileOverlap(['.github/ci.yml', 'src/a'], ['.github/*']), ['.github/ci.yml']);
    assert.equal(patternsIntersect('.github/*', '.github/ci.yml'), 'intersect');
    // The grammar's `*` matches a leading-dot name; micromatch's default would not.
    assert.deepEqual(fileOverlap(['src/.env', '.github/.keep', 'src/a'], ['src/*', '.github/*']), ['src/.env', '.github/.keep', 'src/a']);
    assert.equal(patternsIntersect('src/*', 'src/.env'), 'intersect');
    assert.deepEqual(fileOverlap(['SRC/a.js'], ['src/*.js']), [], 'case-exact');
    assert.deepEqual(fileOverlap([], ['a']), []);
    assert.deepEqual(fileOverlap(['a'], []), []);
  });
});

describe('duplicatePatches', () => {
  it('groups equal non-null patch-ids only', () => {
    const g = duplicatePatches([{ id: 'b', patchId: 'p1' }, { id: 'a', patchId: 'p1' }, { id: 'c', patchId: 'p2' }, { id: 'd', patchId: null }, { id: 'e', patchId: null }]);
    assert.deepEqual(g, [{ patchId: 'p1', ids: ['a', 'b'] }]);
  });
});

describe('liveness (frozen clock)', () => {
  const lease = (ms) => ({ state: 'working', leaseExpiresAt: iso(ms) });
  it('unexpired lease is live; lease boundary is strict', () => {
    assert.equal(liveness(lease(NOW + 1), { now: NOW }).live, true);
    assert.equal(liveness(lease(NOW), { now: NOW }).live, false, 'lease == now is expired');
  });
  it('expired lease and no activity => stale, does not block', () => {
    const r = liveness(lease(NOW - H), { now: NOW, leaseMs: 4 * H, tipCommitAt: NOW - 5 * H });
    assert.deepEqual(r, { live: false, reason: 'stale', futureDatedTipIgnored: false });
  });
  it('expired lease + commit inside the window => live by branch activity', () => {
    assert.deepEqual(liveness(lease(NOW - H), { now: NOW, leaseMs: 4 * H, tipCommitAt: NOW - 2 * H }), { live: true, reason: 'branch-activity', futureDatedTipIgnored: false });
  });
  it('tip exactly at the window edge is not activity', () => {
    assert.equal(isLive(lease(NOW - H), { now: NOW, leaseMs: 4 * H, tipCommitAt: NOW - 4 * H }), false);
  });
  it('a tip within the skew allowance counts; one beyond it is ignored and reported', () => {
    assert.equal(isLive(lease(NOW - H), { now: NOW, tipCommitAt: NOW + 4 * 60_000 }), true);
    const r = liveness(lease(NOW - H), { now: NOW, tipCommitAt: NOW + 24 * H });
    assert.equal(r.live, false);
    assert.equal(r.futureDatedTipIgnored, true);
  });
  it('terminal states are never live, whatever the lease says', () => {
    for (const state of ['done', 'abandoned']) {
      assert.deepEqual(liveness({ state, leaseExpiresAt: iso(NOW + H) }, { now: NOW, tipCommitAt: NOW }), { live: false, reason: 'terminal', futureDatedTipIgnored: false });
    }
  });
  it('requires now', () => { assert.throws(() => liveness(lease(NOW), {}), /now/); });
});

describe('decideClaim — every verdict branch', () => {
  const other = (over = {}, extra = {}) => ({ session: session({ id: 'feat/other', paths: ['src/export/**'], intent: 'export csv', ...over }), live: true, changedFiles: [], ...extra });
  const claim = { id: 'feat/new', intent: 'something else', paths: ['src/export/csv.mjs'] };

  it('new + conflicting live claim => blocked (ok:false)', () => {
    const v = decideClaim({ claim, mode: 'new', others: [other()], complete: true });
    assert.equal(v.ok, false);
    assert.equal(v.verdict, 'blocked');
    assert.equal(v.conflicts[0].with, 'feat/other');
    assert.deepEqual(v.conflicts[0].via, ['paths']);
  });
  it('new + no conflict => ok', () => {
    const v = decideClaim({ claim: { ...claim, paths: ['docs/**'] }, mode: 'new', others: [other()], complete: true });
    assert.deepEqual([v.ok, v.verdict, v.conflicts.length], [true, 'ok', 0]);
  });
  it('adopt + conflict => warn, still ok', () => {
    const v = decideClaim({ claim, mode: 'adopt', others: [other()], complete: true });
    assert.deepEqual([v.ok, v.verdict], [true, 'warn']);
  });
  it('!complete refuses BOTH modes, even with no conflicts', () => {
    for (const mode of ['new', 'adopt']) {
      const v = decideClaim({ claim, mode, others: [], complete: false });
      assert.deepEqual([v.ok, v.verdict, v.reason], [false, 'refused', 'registry incomplete']);
    }
  });
  it('identical normalised intent conflicts even with no paths', () => {
    const v = decideClaim({ claim: { id: 'x', intent: '  Export   CSV ', paths: [] }, mode: 'new', others: [other()], complete: true });
    assert.equal(v.verdict, 'blocked');
    assert.deepEqual(v.conflicts[0].via, ['intent']);
  });
  it('empty intents never match each other', () => {
    const v = decideClaim({ claim: { id: 'x', intent: '', paths: [] }, mode: 'new', others: [other({ intent: '', paths: [] })], complete: true });
    assert.equal(v.verdict, 'ok');
  });
  it('observed changed files of another session that match my paths conflict', () => {
    const v = decideClaim({ claim: { id: 'x', intent: 'z', paths: ['lib/**'] }, mode: 'new', others: [other({ paths: [] }, { changedFiles: ['lib/q.mjs'] })], complete: true });
    assert.equal(v.verdict, 'blocked');
    assert.deepEqual(v.conflicts[0].files, ['lib/q.mjs']);
  });
  it('stale, terminal and same-id sessions never conflict', () => {
    const others = [other({}, { live: false }), other({ state: 'done' }), other({ id: 'feat/new' })];
    assert.equal(decideClaim({ claim, mode: 'new', others, complete: true }).verdict, 'ok');
  });
  it('known overlaps (either side) are reported as known and do not block', () => {
    const a = decideClaim({ claim: { ...claim, knownOverlaps: [{ with: 'feat/other' }] }, mode: 'new', others: [other()], complete: true });
    assert.deepEqual([a.verdict, a.conflicts[0].known], ['ok', true]);
    const b = decideClaim({ claim, mode: 'new', others: [other({ knownOverlaps: [{ with: 'feat/new' }] })], complete: true });
    assert.deepEqual([b.verdict, b.conflicts[0].known], ['ok', true]);
  });
  it('unknown mode throws', () => { assert.throws(() => decideClaim({ claim, mode: 'x', others: [], complete: true })); });
  it('claimMode: no record or a terminal record is new; non-terminal is adopt', () => {
    assert.equal(claimMode(null), 'new');
    assert.equal(claimMode({ state: 'done' }), 'new');
    assert.equal(claimMode({ state: 'abandoned' }), 'new');
    for (const s of ['working', 'ready', 'blocked']) assert.equal(claimMode({ state: s }), 'adopt');
  });
});

describe('approvable (the single approval gate)', () => {
  const good = () => ({
    phase: 'tested', result: 'green', candidate: { oid: OID('c'), tree: OID('d') },
    testCommand: [{ name: 'default', stage: 'pre-land', command: ['npm', 'test'] }], checkResults: [],
  });
  it('tested + green => yes', () => { assert.equal(approvable(good()).ok, true); });
  it('approved only after a push-pending reconcile', () => {
    assert.equal(approvable({ ...good(), phase: 'approved' }).ok, false);
    assert.equal(approvable({ ...good(), phase: 'approved', reconciledFrom: 'push-pending' }).ok, true);
  });
  it('red / dirty / none => never, naming the state', () => {
    for (const result of ['red', 'dirty', 'none']) {
      const r = approvable({ ...good(), result });
      assert.equal(r.ok, false, result);
      assert.ok(r.reason.includes(result), r.reason);
    }
  });
  it('non-tested phases => never, naming the phase', () => {
    for (const phase of ['snapshot', 'applying', 'conflict', 'diverged', 'abandoned', 'landed', 'push-pending', 'awaiting-merge']) {
      const r = approvable({ ...good(), phase });
      assert.equal(r.ok, false, phase);
      assert.ok(r.reason.includes(phase) || phase === 'conflict', r.reason);
    }
  });
  it('missing candidate => no', () => {
    assert.equal(approvable({ ...good(), candidate: null }).ok, false);
    assert.equal(approvable({ ...good(), candidate: { oid: OID('c') } }).ok, false);
    assert.equal(approvable(null).ok, false);
  });
  it('green-after-rerun needs --accept-rerun and says so', () => {
    const m = { ...good(), result: 'green-after-rerun' };
    const refused = approvable(m);
    assert.equal(refused.ok, false);
    assert.equal(refused.needsAcceptRerun, true);
    const accepted = approvable(m, { acceptRerun: true });
    assert.equal(accepted.ok, true);
    assert.match(accepted.note, /first run failed; passed on rerun/);
  });
  it('tiers: every pre-land tier must be green; post-merge tiers do not gate', () => {
    const tiers = [
      { name: 'fast', stage: 'pre-land', command: ['a'] }, { name: 'full', stage: 'pre-land', command: ['b'] },
      { name: 'packaged', stage: 'post-merge', command: ['c'] },
    ];
    const ok = { ...good(), testCommand: tiers, tierResults: [{ name: 'fast', result: 'green' }, { name: 'full', result: 'green' }] };
    assert.equal(approvable(ok).ok, true, 'post-merge tier has no result and does not gate');
    const red = { ...ok, tierResults: [{ name: 'fast', result: 'green' }, { name: 'full', result: 'red' }] };
    const r = approvable(red);
    assert.equal(r.ok, false);
    assert.match(r.reason, /full/);
    const missing = { ...ok, tierResults: [{ name: 'fast', result: 'green' }] };
    assert.match(approvable(missing).reason, /full.*no recorded result/);
    // A manifest.result that claims green cannot launder a red tier.
    assert.equal(approvable({ ...red, result: 'green' }).ok, false);
    // A tier that passed only on rerun makes the whole train need --accept-rerun.
    const rerun = { ...ok, tierResults: [{ name: 'fast', result: 'green-after-rerun' }, { name: 'full', result: 'green' }] };
    assert.equal(approvable(rerun).needsAcceptRerun, true);
    assert.equal(approvable(rerun, { acceptRerun: true }).ok, true);
    // The `{tiers}` form is accepted too.
    assert.equal(approvable({ ...ok, testCommand: { tiers } }).ok, true);
  });
  it('checks: block finding or check-failed on a block check => never; warn only discloses', () => {
    const blockFinding = [{ name: 'sem', severity: 'block', status: 'findings', findings: [{ level: 'block', message: 'x' }] }];
    const failed = [{ name: 'sem', severity: 'block', status: 'check-failed', reason: 'timeout' }];
    const warnFailed = [{ name: 'sem', severity: 'warn', status: 'check-failed', reason: 'timeout' }];
    assert.equal(approvable({ ...good(), checkResults: blockFinding }).ok, false);
    assert.match(approvable({ ...good(), checkResults: failed }).reason, /failed to run/);
    assert.equal(approvable({ ...good(), checkResults: warnFailed }).ok, true);
    // negative control: the same check, exiting clean with no findings => approvable
    assert.equal(approvable({ ...good(), checkResults: [{ name: 'sem', severity: 'block', status: 'ok', findings: [] }] }).ok, true);
    assert.equal(checkBlocksApproval(undefined), null);
  });
  it('worstResult ranks dirty > red > none > rerun > green', () => {
    assert.equal(worstResult(['green', 'red', 'green-after-rerun']), 'red');
    assert.equal(worstResult(['green', 'dirty', 'red']), 'dirty');
    assert.equal(worstResult(['green']), 'green');
  });
});

describe('proposeLandingOrder', () => {
  const it0 = (id, over = {}) => ({ id, ready: true, overlapCount: 0, readyAt: iso(NOW), waitingOn: [], ...over });
  it('ready first, then fewest overlaps, then oldest ready, then id', () => {
    const { order } = proposeLandingOrder([
      it0('d', { ready: false }), it0('c', { overlapCount: 2 }), it0('b', { readyAt: iso(NOW - H) }), it0('a'), it0('e'),
    ]);
    assert.deepEqual(order, ['b', 'a', 'e', 'c', 'd']);
  });
  it('is deterministic regardless of input order', () => {
    const items = ['x', 'y', 'z', 'w'].map((id) => it0(id));
    const o1 = proposeLandingOrder(items).order;
    const o2 = proposeLandingOrder([...items].reverse()).order;
    assert.deepEqual(o1, o2);
    assert.deepEqual(o1, ['w', 'x', 'y', 'z']);
  });
  it('a waiting session lands after the session it waits on', () => {
    const { order, cycles } = proposeLandingOrder([
      it0('a', { waitingOn: [{ kind: 'session', ref: 'z' }] }), it0('b'), it0('z'),
    ]);
    assert.deepEqual(order, ['b', 'z', 'a']);
    assert.deepEqual(cycles, []);
  });
  it('non-session or out-of-set waits do not reorder', () => {
    const { order } = proposeLandingOrder([it0('a', { waitingOn: [{ kind: 'human', ref: 'louis' }, { kind: 'session', ref: 'gone' }] }), it0('b')]);
    assert.deepEqual(order, ['a', 'b']);
  });
  it('a two-session waiting cycle is reported and broken deterministically by id', () => {
    const items = [it0('a', { waitingOn: [{ kind: 'session', ref: 'b' }] }), it0('b', { waitingOn: [{ kind: 'session', ref: 'a' }] })];
    const r1 = proposeLandingOrder(items);
    const r2 = proposeLandingOrder([...items].reverse());
    assert.deepEqual(r1.cycles, [['a', 'b']]);
    assert.deepEqual(r1, r2);
    assert.deepEqual(r1.order, ['a', 'b']);
  });
});

describe('deriveDone', () => {
  const s = session({ id: 'feat/a', gen: 2, rev: 5, ready: { oid: OID('a'), at: iso(NOW) }, state: 'ready' });
  const landed = (over = {}) => ({ trainId: 't-20261005120000-abcd', phase: 'landed', sources: [{ id: 'feat/a', gen: 2, rev: 5, oid: OID('a'), ...over }] });
  const obs = (over = {}) => ({ observedOid: OID('a'), branchGone: false, tipObserved: true, ...over });
  it('done when gen/rev/ready match and the observed tip equals the manifest oid', () => {
    assert.equal(deriveDone(s, [landed()], obs()).done, true);
  });
  it('done when the source branch is gone (post-merge deletion)', () => {
    assert.equal(deriveDone(s, [landed()], obs({ observedOid: null, branchGone: true })).done, true);
  });
  it('NOT done when the tip moved on after landing without any fleet command', () => {
    const r = deriveDone(s, [landed()], obs({ observedOid: OID('b') }));
    assert.equal(r.done, false);
    assert.match(r.note, /newer commits/);
  });
  it('NOT done when rev moved, gen differs, tip unobservable, or train not landed', () => {
    assert.equal(deriveDone({ ...s, rev: 6 }, [landed()], obs()).done, false);
    assert.equal(deriveDone({ ...s, gen: 3 }, [landed()], obs()).done, false);
    assert.equal(deriveDone(s, [landed()], obs({ tipObserved: false })).done, false);
    assert.equal(deriveDone(s, [{ ...landed(), phase: 'awaiting-merge' }], obs()).done, false);
  });
});

describe('buildStatus (the read-only join)', () => {
  const branches = (list) => ({ queried: true, branches: list });
  const br = (name, over = {}) => ({ name, oid: OID('a'), tipTime: NOW - 10 * 60_000, ahead: 1, behind: 0, ...over });
  const base = () => ({
    now: NOW, base: { name: 'main', freshness: null },
    registry: { sessions: [], invalid: [], complete: true },
    worktrees: { queried: true, worktrees: [{ path: 'C:/r', branch: 'main', missing: false, prunable: false }] },
    branches: branches([br('main', { ahead: 0 })]),
    prs: { queried: false, reason: 'gh not authenticated', prs: [] },
    changed: {}, patchIds: {}, trains: [], hold: null,
  });

  it('untracked branches appear as untracked; gh unqueried is carried, not emptied', () => {
    const st = buildStatus({ ...base(), branches: branches([br('main', { ahead: 0 }), br('feat/x'), br('idle', { ahead: 0 })]) });
    assert.deepEqual(st.items.map((i) => [i.id, i.state]), [['feat/x', 'untracked']]);
    assert.deepEqual(st.sources.prs, { queried: false, complete: false, limit: undefined, reason: 'gh not authenticated' });
    assert.match(renderStatus(st), /PRs: not queried \(gh not authenticated\)/);
  });
  it('a tracked session joins its branch; expired lease + no activity is stale', () => {
    const s = session({ id: 'feat/a', leaseExpiresAt: iso(NOW - H) });
    const st = buildStatus({ ...base(), registry: { sessions: [s], invalid: [], complete: true }, branches: branches([br('main', { ahead: 0 }), br('feat/a', { tipTime: NOW - 9 * H })]) });
    assert.equal(st.items[0].stale, true);
    assert.match(st.items[0].display, /stale/);
    const live = buildStatus({ ...base(), registry: { sessions: [s], invalid: [], complete: true }, branches: branches([br('main', { ahead: 0 }), br('feat/a', { tipTime: NOW - H })]) });
    assert.equal(live.items[0].live, true);
    assert.equal(live.items[0].liveReason, 'branch-activity');
  });
  it('future-dated tip is ignored and reported', () => {
    const s = session({ id: 'feat/a', leaseExpiresAt: iso(NOW - H) });
    const st = buildStatus({ ...base(), registry: { sessions: [s], invalid: [], complete: true }, branches: branches([br('feat/a', { tipTime: NOW + 24 * H })]) });
    assert.equal(st.items[0].live, false);
    assert.ok(st.items[0].notes.includes('future-dated commit ignored'));
  });
  it('ready whose head moved shows stale and is excluded from the landing order', () => {
    const s = session({ id: 'feat/a', state: 'ready', ready: { oid: OID('b'), at: iso(NOW - H) } });
    const st = buildStatus({ ...base(), registry: { sessions: [s], invalid: [], complete: true }, branches: branches([br('feat/a', { oid: OID('a') })]) });
    assert.equal(st.items[0].display, 'ready (stale — head moved)');
    assert.deepEqual(st.landingOrder, []);
  });
  it('overlaps (shared changed files), duplicates (patch-id), known overlaps', () => {
    const sa = session({ id: 'feat/a', paths: ['src/**'] }); const sb = session({ id: 'feat/b', paths: ['lib/**'] });
    const st = buildStatus({
      ...base(), registry: { sessions: [sa, sb], invalid: [], complete: true },
      branches: branches([br('feat/a'), br('feat/b')]),
      changed: { 'feat/a': { queried: true, files: ['x.js', 'y.js'] }, 'feat/b': { queried: true, files: ['y.js', 'z.js'] } },
      patchIds: { 'feat/a': { queried: true, patchId: 'p' }, 'feat/b': { queried: true, patchId: 'p' } },
    });
    const a = st.items.find((i) => i.id === 'feat/a');
    assert.deepEqual(a.overlaps, [{ with: 'feat/b', via: ['files'], files: ['y.js'], known: false }]);
    assert.deepEqual(a.duplicates, ['feat/b']);
    assert.match(renderStatus(st), /DUPLICATE patch with feat\/b/);
    const known = buildStatus({
      ...base(), registry: { sessions: [{ ...sa, knownOverlaps: [{ with: 'feat/b' }] }, sb], invalid: [], complete: true },
      branches: branches([br('feat/a'), br('feat/b')]),
      changed: { 'feat/a': { queried: true, files: ['y.js'] }, 'feat/b': { queried: true, files: ['y.js'] } },
    });
    assert.equal(known.items[0].overlaps[0].known, true);
  });
  it('derived done from a landed train; a later commit keeps it active; never mutates facts', () => {
    const s = session({ id: 'feat/a', state: 'ready', gen: 1, rev: 3, ready: { oid: OID('a'), at: iso(NOW) } });
    const train = { trainId: 't-20261005110000-ffff', phase: 'landed', sources: [{ id: 'feat/a', gen: 1, rev: 3, oid: OID('a') }] };
    const facts = { ...base(), registry: { sessions: [s], invalid: [], complete: true }, branches: branches([br('feat/a', { oid: OID('a') })]), trains: [train] };
    const frozen = JSON.stringify(facts);
    const done = buildStatus(facts);
    assert.equal(done.items[0].state, 'done');
    assert.equal(JSON.stringify(facts), frozen, 'buildStatus must not mutate its input');
    const moved = buildStatus({ ...facts, branches: branches([br('feat/a', { oid: OID('f') })]) });
    assert.equal(moved.items[0].state, 'ready');
    assert.ok(moved.items[0].notes.some((n) => /newer commits/.test(n)));
    // Branch tip unobservable (branches not queried): never derive done from absence.
    const blind = buildStatus({ ...facts, branches: { queried: false, reason: 'git failed', branches: [] } });
    assert.notEqual(blind.items[0].state, 'done');
  });
  it('waiting: human first, unblocked? derived for terminal/missing/landed refs', () => {
    const waitsHuman = session({ id: 'z', waitingOn: [{ kind: 'human', ref: 'louis', note: 'approve design', since: iso(NOW) }] });
    const onDone = session({ id: 'm', waitingOn: [{ kind: 'session', ref: 'dead', since: iso(NOW) }, { kind: 'session', ref: 'ghost', since: iso(NOW) }, { kind: 'train', ref: 't-20261005110000-ffff', since: iso(NOW) }] });
    const dead = session({ id: 'dead', state: 'done' });
    const st = buildStatus({
      ...base(), registry: { sessions: [onDone, dead, waitsHuman], invalid: [], complete: true },
      branches: branches([br('z'), br('m'), br('dead')]),
      trains: [{ trainId: 't-20261005110000-ffff', phase: 'landed', sources: [] }],
    });
    assert.equal(st.items[0].id, 'z', 'needs-the-human items sort first');
    const m = st.items.find((i) => i.id === 'm');
    assert.deepEqual(m.waitingOn.map((w) => w.unblocked), ['unblocked?', 'unblocked?', 'unblocked?']);
    assert.match(renderStatus(st), /WAITING: human:louis — approve design/);
  });
  it('open PRs with no local counterpart are shown remote-only, never dropped', () => {
    const pr = { number: 9, title: 'fork work', headRef: 'f', headOid: OID('9'), baseRef: 'main', isCrossRepository: true, checks: { state: 'none', total: 0 } };
    const st = buildStatus({ ...base(), prs: { queried: true, prs: [pr] } });
    assert.equal(st.items[0].display, 'remote-only — not landable by fleet');
  });
  it('incomplete registry renders the banner naming the damage', () => {
    const st = buildStatus({ ...base(), registry: { sessions: [], invalid: [{ file: 'bad.json', reason: 'schema' }], complete: false } });
    assert.equal(st.registry.complete, false);
    assert.match(renderStatus(st), /registry incomplete: 1 record unreadable — claims may be missing/);
  });
  it('a missing worktree directory is flagged on the session', () => {
    const s = session({ id: 'feat/a', worktree: 'C:/gone' });
    const st = buildStatus({
      ...base(), registry: { sessions: [s], invalid: [], complete: true }, branches: branches([br('feat/a')]),
      worktrees: { queried: true, worktrees: [{ path: 'C:/gone', branch: 'feat/a', missing: true, prunable: true }] },
    });
    assert.equal(st.items[0].worktreeState, 'missing');
  });
});

describe('renderers', () => {
  it('claim verdicts name the stop condition and conflicts', () => {
    const v = decideClaim({
      claim: { id: 'x', intent: 'i', paths: ['src/a.mjs'] }, mode: 'new', complete: true,
      others: [{ session: session({ id: 'o', paths: ['src/*.mjs'] }), live: true }],
    });
    const text = renderClaimVerdict(v, { id: 'x' });
    assert.match(text, /BLOCKED for x/);
    assert.match(text, /o: paths/);
    assert.match(renderClaimVerdict({ ok: false, verdict: 'refused', conflicts: [], reason: 'registry incomplete' }), /REFUSED.*repair --quarantine/);
    assert.match(renderApprovable({ ok: false, reason: 'train is landed' }), /NOT approvable: train is landed/);
  });
});

describe('claim grammar is an allowlist shared with micromatch', () => {
  it('rejects a double quote and every other non-allowlisted character, naming it', () => {
    for (const ch of ['"', "'", '\\', '`', '$', '^', '|', ';', ':', '<', '>', '{', '}', '[', ']', '(', ')', '!', '&', '\n', '\t']) {
      const r = validateClaimPattern(`src/a${ch}b.mjs`);
      assert.equal(r.ok, false, JSON.stringify(ch));
      assert.ok(r.reason.includes(JSON.stringify(ch)), r.reason);
    }
    assert.equal(validateClaimPattern('src/say"hi".mjs').ok, false);
  });
  it('accepts unicode letters/digits and the ASCII literal set', () => {
    for (const p of ['src/é.mjs', 'docs/日本語/*.md', 'a b/c', 'x_y-z.v1', 'a@b+c=d,e~f#g%h', 'dir/ünï*']) {
      assert.equal(validateClaimPattern(p).ok, true, p);
    }
  });
  it('conformance: every accepted literal is a literal to micromatch AND to patternsIntersect', () => {
    const lits = ['_', '.', '-', ' ', '@', '+', '=', ',', '~', '#', '%', 'é', '7'];
    for (const c of lits) {
      const lit = `x${c}y`;
      assert.equal(validateClaimPattern(`d/${lit}`).ok, true, c);
      assert.equal(micromatch.isMatch(`d/${lit}`, `d/${lit}`, { dot: true, nocase: false }), true, `micromatch literal ${c}`);
      assert.deepEqual(fileOverlap([`d/${lit}`, 'd/xy'], [`d/${lit}`]), [`d/${lit}`]);
      assert.equal(patternsIntersect(`d/${lit}`, `d/x*y`), 'intersect', c);
      assert.equal(patternsIntersect(`d/${lit}`, `d/${lit}z`), 'disjoint', c);
      assert.equal(patternsIntersect(`d/${lit}`, `d/x?y`), 'intersect', c);
    }
  });
  it('conformance (seeded): over accepted patterns with special literals, an intersect-implied overlap never contradicts micromatch', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
    const segPool = ['a', 'b', '.', '-', '#', '%', 'a.b', '*', '?', 'a*', '*b', '**'];
    const files = [];
    for (const x of ['a', 'b', '.', '-', '#', '%', 'a.b', 'ab', 'ba']) for (const y of ['a', 'b', '.', '-', 'a.b', 'ab']) { files.push(x, `${x}/${y}`, `${x}/${y}/a`); }
    for (let n = 0; n < 300; n += 1) {
      const mkp = () => Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => pick(segPool)).join('/');
      const a = mkp(); const b = mkp();
      if (!validateClaimPattern(a).ok || !validateClaimPattern(b).ok) continue;
      const both = files.filter((f) => micromatch.isMatch(f, a, { dot: true, nocase: false }) && micromatch.isMatch(f, b, { dot: true, nocase: false }));
      if (both.length) assert.equal(patternsIntersect(a, b), 'intersect', `${a} vs ${b} share ${both[0]} under micromatch`);
    }
  });
});

// History: the DP memo key was `i*1024+j`, which aliased (1,0) onto (0,1024) for a segment past 1024
// characters. The keys are now `"i,j"` strings (collision-free by construction), and since the size
// bounds (MAX_SEGMENT_CHARS / MAX_PATTERN_SEGMENTS) no pattern that large reaches the DP at all: it is
// refused at claim time and answers 'unknown' here. The correctness checks therefore run AT the limits.
describe('DP correctness at the size limits (memo keys, and the old >1024 sizes now refused)', () => {
  it('the old >1024-character / >1024-segment inputs are refused as "unknown", not computed', () => {
    assert.equal(patternsIntersect('*abc', `${'z'.repeat(1100)}abc`), 'unknown');
    assert.equal(patternsIntersect('**/x', `${'z/'.repeat(1100)}x`), 'unknown');
  });
  it('a segment at the limit: the match sits near the far end of the segment', () => {
    const n = MAX_SEGMENT_CHARS - 3;
    assert.equal(patternsIntersect('*abc', `${'z'.repeat(n)}abc`), 'intersect');
    assert.equal(patternsIntersect('*abc', `${'z'.repeat(n)}abd`), 'disjoint');
    assert.equal(patternsIntersect(`${'a'.repeat(n - 10)}*`, `${'a'.repeat(n)}b`), 'intersect');
  });
  it('a path at the segment limit with ** at the front', () => {
    const n = MAX_PATTERN_SEGMENTS - 1;
    assert.equal(patternsIntersect('**/x', `${'z/'.repeat(n - 1)}x`), 'intersect');
    assert.equal(patternsIntersect('**/x', `${'z/'.repeat(n - 1)}y`), 'disjoint');
  });
});

describe('status surfaces incomplete inventories', () => {
  const baseFacts = () => ({
    now: NOW, base: { name: 'main' }, registry: { sessions: [], invalid: [], complete: true },
    worktrees: { queried: true, worktrees: [] }, branches: { queried: true, branches: [] },
    prs: { queried: true, complete: true, limit: 200, prs: [] }, changed: {}, patchIds: {}, trains: [],
  });
  it('complete + empty => (nothing in flight)', () => {
    assert.match(renderStatus(buildStatus(baseFacts())), /\(nothing in flight\)/);
  });
  it('partial + empty never says nothing in flight: lists what was not fully queried', () => {
    const truncated = renderStatus(buildStatus({ ...baseFacts(), prs: { queried: true, complete: false, limit: 200, reason: 'PR list may be truncated at 200', prs: [] } }));
    assert.doesNotMatch(truncated, /nothing in flight/);
    assert.match(truncated, /nothing found — but 1 source was not fully queried: PRs \(may be truncated at 200\)/);
    assert.match(truncated, /PR list may be truncated at 200/);
    const partialBranches = renderStatus(buildStatus({ ...baseFacts(), branches: { queried: true, partial: true, branches: [] }, registry: { sessions: [], invalid: [{ file: 'x.json', reason: 'bad' }], complete: false } }));
    assert.match(partialBranches, /2 sources were not fully queried: branches \(partial counts\), registry/);
    const noPrs = renderStatus(buildStatus({ ...baseFacts(), prs: { queried: false, reason: 'gh not installed', prs: [] } }));
    assert.match(noPrs, /nothing found — but 1 source was not fully queried: PRs/);
  });
  it('unavailable: git facts unreadable', () => {
    const t = renderStatus(buildStatus({ ...baseFacts(), worktrees: { queried: false, reason: 'git failed' }, branches: { queried: false, reason: 'git failed' } }));
    assert.match(t, /inventory unavailable/);
    assert.doesNotMatch(t, /nothing in flight|nothing found/);
  });
  it('a truncated PR list is flagged even when items exist', () => {
    const facts = { ...baseFacts(), branches: { queried: true, branches: [{ name: 'feat/x', oid: OID('a'), tipTime: NOW, ahead: 1, behind: 0 }] },
      prs: { queried: true, complete: false, limit: 200, reason: 'PR list may be truncated at 200', prs: [] } };
    const st = buildStatus(facts);
    assert.equal(st.sources.prs.complete, false);
    assert.match(renderStatus(st), /PRs: PR list may be truncated at 200/);
  });
});

describe('astral (supplementary-plane) characters', () => {
  const A = '\u{1D49C}'; // MATHEMATICAL SCRIPT CAPITAL A — a letter, two UTF-16 units
  it('is accepted by the grammar and matched literally by all three engines', () => {
    assert.equal(validateClaimPattern(`src/${A}.mjs`).ok, true);
    assert.deepEqual(fileOverlap([`src/${A}.mjs`, 'src/a.mjs'], [`src/${A}.mjs`]), [`src/${A}.mjs`]);
    assert.equal(patternsIntersect(`src/${A}.mjs`, `src/${A}.mjs`), 'intersect');
    assert.equal(patternsIntersect(`src/${A}.mjs`, 'src/a.mjs'), 'disjoint');
    assert.equal(patternsIntersect('src/*.mjs', `src/${A}.mjs`), 'intersect');
  });
  it('? is exactly ONE code point for the DP', () => {
    assert.equal(patternsIntersect('src/?.mjs', `src/${A}.mjs`), 'intersect');
    assert.equal(patternsIntersect(`src/?b.mjs`, `src/${A}b.mjs`), 'intersect');
    assert.equal(patternsIntersect('src/?.mjs', `src/${A}${A}.mjs`), 'disjoint');
  });
  it('documented divergence: micromatch counts ? in UTF-16 units; the engine is conservative there', () => {
    const o = { dot: true, nocase: false };
    assert.equal(micromatch.isMatch(`src/${A}.mjs`, 'src/?.mjs', o), false, 'micromatch: one ? does NOT match an astral char');
    assert.equal(micromatch.isMatch(`src/${A}.mjs`, 'src/??.mjs', o), true, 'micromatch: two ?? do');
    // The engine must never say disjoint where micromatch could match.
    assert.equal(patternsIntersect('src/??.mjs', `src/${A}.mjs`), 'intersect');
    assert.equal(patternsIntersect('src/?.mjs', `src/${A}.mjs`), 'intersect');
  });
});
