/**
 * @fileoverview The pre-authorised ship decision (scripts/lib/ship-preauth.mjs) and its supporting records: the
 * final-review marker (scripts/lib/audit/gate-evidence.mjs) and the AI-Ship-Authority trailer (commit-trailers.mjs).
 * Plan: docs/plans/fleet-chips-and-merge-friction.md section 2.2b.
 *
 * Tier 1 (deterministic module): a table in which each condition fails ALONE with its own reason, one row in which all hold,
 * and the direction the check must NOT fire (an ordinary file passes). Unknown facts refuse; none is ever read as a pass.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluatePreauthorisedShip, isMigrationPath, isPolicyPath, isSensitivePath, gatherChangedPaths, renderPreauthConditions,
} from '../scripts/lib/ship-preauth.mjs';
import {
  buildFinalReviewMarker, writeFinalReviewMarker, readFinalReviewMarker, FINAL_REVIEW_RELPATH,
} from '../scripts/lib/final-review-marker.mjs';
import { formatTrailerBlock, composeFinalMessage, findReservedTrailers } from '../scripts/lib/commit-trailers.mjs';

const RUN = '981fc79a-0fbb-447a-a294-b0c0217dab71';
const OTHER_RUN = '11111111-2222-4333-8444-555555555555';
const TREE = 'ca77e929e43535fdee278229eed00a08cde80f59';
const OTHER_TREE = '4ca9f5a05945f5495eae1f6b4128406a3af46ab9';

const evidence = (extra = {}) => ({ runId: RUN, auditedTree: TREE, round: 4, auditedBranch: 'claude/x', ...extra });
const finalReview = (extra = {}) => ({ ok: true, marker: { runId: RUN, auditedTree: TREE, round: 4, verdict: 'APPROVE', ts: '2026-10-15T07:00:00.000Z', ...extra } });
const convergence = (extra = {}) => ({ roundConvergedAfter: 4, ...extra });

/** Facts under which every condition holds. */
const GOOD = () => ({
  gate: 'converged', noTests: false, convergence: convergence(), evidence: evidence(), currentBranch: 'claude/x',
  finalReview: finalReview(), changedPaths: ['scripts/lib/foo.mjs', 'tests/foo.test.mjs', 'docs/plans/x.md'],
});

const only = (v, id) => v.conditions.find((c) => c.id === id);
const failing = (v) => v.conditions.filter((c) => !c.ok).map((c) => c.id);

describe('evaluatePreauthorisedShip: all conditions hold', () => {
  it('passes, reporting one satisfied row per condition', () => {
    const v = evaluatePreauthorisedShip(GOOD());
    assert.equal(v.ok, true, v.refusals.join('\n'));
    assert.deepEqual(v.conditions.map((c) => c.id), ['gate', 'audit-converged', 'final-review', 'sensitive-path', 'migration', 'repo-policy']);
    assert.deepEqual(failing(v), []);
    assert.equal(v.refusals.length, 0);
  });

  it('`passed` is as acceptable as `converged`', () => {
    assert.equal(evaluatePreauthorisedShip({ ...GOOD(), gate: 'passed' }).ok, true);
  });
});

describe('evaluatePreauthorisedShip: each condition fails ALONE with its own reason', () => {
  const cases = [
    ['gate', { gate: 'waived' }, /waived/],
    ['gate', { gate: 'not-run' }, /not-run/],
    ['gate', { gate: null }, /null/],
    ['gate', { noTests: true }, /--no-tests/],
    ['audit-converged', { convergence: null }, /no audit_runs row could be read/],
    ['audit-converged', { convergence: null, convergenceWhy: 'the store query failed (ECONNREFUSED)' }, /ECONNREFUSED/],
    ['audit-converged', { convergence: convergence({ roundConvergedAfter: null }) }, /did not converge/],
    ['audit-converged', { evidence: evidence({ auditedBranch: 'claude/other' }) }, /branch "claude\/other"/],
    ['audit-converged', { evidence: evidence({ auditedBranch: null }) }, /branch identity is unknown/],
    ['audit-converged', { currentBranch: null }, /branch identity is unknown/],
    ['audit-converged', { currentBranch: '' }, /branch identity is unknown/],
    ['audit-converged', { evidence: evidence({ auditedBranch: null }), currentBranch: null }, /branch identity is unknown/],
    ['final-review', { evidence: null }, /no gate-evidence marker/],
    ['final-review', { finalReview: { ok: false, reason: 'absent' } }, /absent/],
    ['final-review', { finalReview: null }, /not read/],
    ['final-review', { finalReview: finalReview({ verdict: 'CONCERNS' }) }, /CONCERNS, not APPROVE/],
    ['final-review', { finalReview: finalReview({ runId: OTHER_RUN }) }, /approval is for run 11111111/],
    ['final-review', { finalReview: finalReview({ auditedTree: OTHER_TREE }) }, /different audited tree/],
    ['final-review', { finalReview: finalReview({ round: 3 }) }, /round 3, the audit evidence is round 4/],
    ['final-review', { evidence: evidence({ round: null }) }, /no round/],
    ['sensitive-path', { changedPaths: ['scripts/a.mjs', '.env'] }, /sensitive.*\.env/],
    ['migration', { changedPaths: ['supabase/migrations/20261015_x.sql'] }, /migration/],
    ['migration', { changedPaths: ['scripts/migrations/001.sql'] }, /migration/],
    ['repo-policy', { changedPaths: ['.github/workflows/release.yml'] }, /\.github/],
    ['repo-policy', { changedPaths: ['CODEOWNERS'] }, /CODEOWNERS/],
    ['repo-policy', { changedPaths: ['docs/CODEOWNERS'] }, /CODEOWNERS/],
    ['repo-policy', { changedPaths: ['.test-tiers.json'] }, /\.test-tiers\.json/],
  ];
  for (const [id, override, why] of cases) {
    it(`${id}: ${JSON.stringify(Object.keys(override))} -> refused, naming ${id} and only ${id}`, () => {
      const v = evaluatePreauthorisedShip({ ...GOOD(), ...override });
      assert.equal(v.ok, false);
      assert.ok(failing(v).includes(id), `${id} must be refused; refused: ${failing(v)}`);
      assert.match(only(v, id).reason, why);
      // `final-review` and `audit-converged` legitimately share inputs with each other; the path rows never fail from them.
      for (const other of ['sensitive-path', 'migration', 'repo-policy']) {
        if (other !== id) assert.equal(only(v, other).ok, true, `${other} must not fail because of ${id}`);
      }
    });
  }
});

describe('evaluatePreauthorisedShip: unknown is never a pass', () => {
  it('unresolvable changed paths fail all three path rows', () => {
    const v = evaluatePreauthorisedShip({ ...GOOD(), changedPaths: null });
    assert.deepEqual(failing(v), ['sensitive-path', 'migration', 'repo-policy']);
  });

  it('an EMPTY change set is refused, not read as clean (vacuous-pass guard)', () => {
    const v = evaluatePreauthorisedShip({ ...GOOD(), changedPaths: [] });
    assert.deepEqual(failing(v), ['sensitive-path', 'migration', 'repo-policy']);
    assert.match(only(v, 'migration').reason, /nothing to ship/);
  });

  it('a call with no facts at all refuses every condition', () => {
    const v = evaluatePreauthorisedShip({});
    assert.equal(v.ok, false);
    assert.deepEqual(failing(v), ['gate', 'audit-converged', 'final-review', 'sensitive-path', 'migration', 'repo-policy']);
  });

  it('gateDeferred (the preflight) reads the gate row as checked-at-commit but still judges everything else', () => {
    const v = evaluatePreauthorisedShip({ ...GOOD(), gate: undefined, gateDeferred: true });
    assert.equal(only(v, 'gate').ok, true);
    assert.match(only(v, 'gate').reason, /checked at commit/);
    assert.equal(evaluatePreauthorisedShip({ ...GOOD(), gate: undefined, gateDeferred: true, finalReview: null }).ok, false);
    // ...and --no-tests is refused even in the preflight.
    assert.equal(only(evaluatePreauthorisedShip({ ...GOOD(), gateDeferred: true, noTests: true }), 'gate').ok, false);
  });

  it('approval of tree A followed by convergence on tree B is refused (the binding the store column cannot give)', () => {
    const v = evaluatePreauthorisedShip({ ...GOOD(), evidence: evidence({ auditedTree: OTHER_TREE }) });
    assert.match(only(v, 'final-review').reason, /different audited tree/);
  });
});

describe('path predicates', () => {
  it('migration: any `migrations` directory, but not a file merely named like one', () => {
    for (const p of ['supabase/migrations/a.sql', 'scripts/migrations/a.sql', 'db/migrations/x/y.sql', 'Supabase\\Migrations\\a.sql']) assert.equal(isMigrationPath(p), true, p);
    for (const p of ['scripts/migrations.mjs', 'docs/migrations-guide.md', 'scripts/lib/migrate.mjs']) assert.equal(isMigrationPath(p), false, p);
  });

  it('repo-policy: .github, both CODEOWNERS locations and .test-tiers.json, case- and slash-insensitive', () => {
    for (const p of ['.github/workflows/x.yml', '.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', '.test-tiers.json', '.GitHub\\workflows\\x.yml', './CODEOWNERS']) assert.equal(isPolicyPath(p), true, p);
    for (const p of ['scripts/github.mjs', 'docs/codeowners-guide.md', 'src/CODEOWNERS', 'tests/test-tiers.test.mjs', 'github/x.yml']) assert.equal(isPolicyPath(p), false, p);
  });

  it('sensitive: delegates to the single classifier; an ordinary source file is not', () => {
    assert.equal(isSensitivePath('.env'), true);
    assert.equal(isSensitivePath('scripts/lib/foo.mjs'), false);
    // generatedNoise is a DIFFERENT category and is not sensitive.
    assert.equal(isSensitivePath('package-lock.json'), false);
  });
});

describe('gatherChangedPaths', () => {
  const runner = (table) => (args) => {
    const key = args.join(' ');
    for (const [pattern, res] of table) if (key.startsWith(pattern)) return res;
    return { status: 1, stdout: '' };
  };

  it('diffs the merge base against the tree with --no-renames, so BOTH ends of a rename are listed', () => {
    const seen = [];
    const run = (args) => {
      seen.push(args.join(' '));
      if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'refs/remotes/origin/main\n' };
      if (args[0] === 'merge-base') return { status: 0, stdout: 'abc123\n' };
      return { status: 0, stdout: 'CODEOWNERS\0docs/OWNERS\0' };
    };
    assert.deepEqual(gatherChangedPaths(run, 'deadbeef'), ['CODEOWNERS', 'docs/OWNERS']);
    assert.ok(seen.some((c) => c === 'diff --name-only --no-renames -z abc123 deadbeef'), seen.join('\n'));
    // and the renamed-away CODEOWNERS is a policy path, so the ship is refused:
    const v = evaluatePreauthorisedShip({ ...GOOD(), changedPaths: ['CODEOWNERS', 'docs/OWNERS'] });
    assert.ok(failing(v).includes('repo-policy'));
  });

  it('falls back from origin/HEAD to origin/main ONLY, never to a local main, and returns null when no merge base resolves', () => {
    const calls = [];
    const run = (args) => { calls.push(args.join(' ')); return { status: 1, stdout: '' }; };
    assert.equal(gatherChangedPaths(run, 'tree'), null);
    assert.ok(calls.some((c) => c === 'merge-base HEAD origin/main'));
    assert.equal(calls.some((c) => c === 'merge-base HEAD main'), false, "a local main can differ from the remote's: an unverified base is a refusal, not a substitute");
    // ...and a local main that WOULD resolve is not consulted when the remote refs are unavailable:
    const onlyLocal = (args) => (args.join(' ') === 'merge-base HEAD main' ? { status: 0, stdout: 'deadbeef' } : { status: 1, stdout: '' });
    assert.equal(gatherChangedPaths(onlyLocal, 'tree'), null);
    assert.equal(gatherChangedPaths(runner([['symbolic-ref', { status: 1 }], ['merge-base HEAD origin/main', { status: 0, stdout: 'b\n' }], ['diff', { status: 1 }]]), 'tree'), null, 'a failed diff is null, never []');
    assert.equal(gatherChangedPaths(runner([['merge-base', { status: 0, stdout: 'b\n' }]]), null), null, 'no tree is null');
  });
});

describe('renderPreauthConditions', () => {
  it('prints one line per condition, REFUSED rows marked', () => {
    const lines = renderPreauthConditions(evaluatePreauthorisedShip({ ...GOOD(), changedPaths: ['.github/x.yml'] }));
    assert.equal(lines.length, 6);
    assert.equal(lines.filter((l) => l.includes('REFUSED')).length, 1);
    assert.match(lines.find((l) => l.includes('REFUSED')), /repo-policy/);
  });
});

describe('final-review marker', () => {
  const EV = { runId: RUN, auditedTree: TREE, round: 4 };

  it('builds only from evidence that can identify the review (no partial marker)', () => {
    assert.deepEqual(Object.keys(buildFinalReviewMarker({ evidence: EV, verdict: 'APPROVE' })).sort(), ['auditedTree', 'round', 'runId', 'ts', 'verdict']);
    for (const bad of [
      { evidence: null, verdict: 'APPROVE' },
      { evidence: { ...EV, runId: 'x' }, verdict: 'APPROVE' },
      { evidence: { ...EV, auditedTree: 'nope' }, verdict: 'APPROVE' },
      { evidence: { ...EV, round: null }, verdict: 'APPROVE' },
      { evidence: { ...EV, round: 1.5 }, verdict: 'APPROVE' },
      { evidence: EV, verdict: 'MAYBE' },
      { evidence: EV, verdict: undefined },
    ]) assert.equal(buildFinalReviewMarker(bad), null, JSON.stringify(bad));
  });

  it('round-trips through write and read, and absent / malformed / unreadable are three distinct reasons', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-review-'));
    try {
      assert.deepEqual(readFinalReviewMarker(dir), { ok: false, reason: 'absent' });
      const w = writeFinalReviewMarker({ repoRoot: dir, evidence: EV, verdict: 'APPROVE' });
      assert.equal(w.written, true);
      const r = readFinalReviewMarker(dir);
      assert.equal(r.ok, true);
      assert.deepEqual({ ...r.marker, ts: null }, { runId: RUN, auditedTree: TREE, round: 4, verdict: 'APPROVE', ts: null });

      fs.writeFileSync(path.join(dir, FINAL_REVIEW_RELPATH), '{not json');
      assert.deepEqual(readFinalReviewMarker(dir), { ok: false, reason: 'malformed' });
      fs.writeFileSync(path.join(dir, FINAL_REVIEW_RELPATH), JSON.stringify({ runId: RUN, auditedTree: TREE, round: '4', verdict: 'APPROVE', ts: 'x' }));
      assert.deepEqual(readFinalReviewMarker(dir), { ok: false, reason: 'malformed' }, 'a string round / bad ts must not read as a marker');

      const throwing = { readFileSync: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; } };
      assert.deepEqual(readFinalReviewMarker(dir, { fsMod: throwing }), { ok: false, reason: 'unreadable' });
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a failed write is reported, never thrown, and an unidentifiable review writes nothing', () => {
    const w = writeFinalReviewMarker({ repoRoot: os.tmpdir(), evidence: EV, verdict: 'APPROVE', log: () => {}, adapters: { atomicWriteFileSync: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); } } });
    assert.deepEqual([w.written, w.reason], [false, 'write-failed']);
    const none = writeFinalReviewMarker({ repoRoot: os.tmpdir(), evidence: { ...EV, round: null }, verdict: 'APPROVE', log: () => {} });
    assert.deepEqual([none.written, none.reason], [false, 'evidence-cannot-identify-the-review']);
  });

  it('end to end: a marker the writer produced satisfies the ship check; one from another round does not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-review-e2e-'));
    try {
      writeFinalReviewMarker({ repoRoot: dir, evidence: EV, verdict: 'APPROVE' });
      assert.equal(evaluatePreauthorisedShip({ ...GOOD(), finalReview: readFinalReviewMarker(dir) }).ok, true);
      // The audit then advances to round 5: the gate-evidence marker is rewritten, the old approval stops matching.
      const v = evaluatePreauthorisedShip({ ...GOOD(), evidence: evidence({ round: 5 }), finalReview: readFinalReviewMarker(dir) });
      assert.match(only(v, 'final-review').reason, /round 4, the audit evidence is round 5/);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('AI-Ship-Authority trailer', () => {
  const V = { skill: 'ship', models: ['claude'], gate: 'converged', runId: RUN };

  it('appears only when shipAuthority is exactly launch-prompt, as the last trailer', () => {
    const lines = formatTrailerBlock({ ...V, shipAuthority: 'launch-prompt' });
    assert.equal(lines.at(-1), 'AI-Ship-Authority: launch-prompt');
    assert.equal(formatTrailerBlock(V).some((l) => l.startsWith('AI-Ship-Authority')), false);
    for (const bad of ['user', 'LAUNCH-PROMPT', true, '']) {
      assert.equal(formatTrailerBlock({ ...V, shipAuthority: bad }).some((l) => l.startsWith('AI-Ship-Authority')), false, String(bad));
    }
  });

  it('survives composeFinalMessage into a parseable trailer block', () => {
    const msg = composeFinalMessage('feat: x\n\nbody\n', { ...V, shipAuthority: 'launch-prompt' });
    assert.match(msg, /\nAI-Ship-Authority: launch-prompt\n$/);
    assert.equal(findReservedTrailers(msg).some((t) => t.key === 'AI-Ship-Authority'), true);
  });

  it('a hand-typed AI-Ship-Authority in the message is a reserved trailer (the helper is its only writer)', () => {
    const typed = 'feat: x\n\nbody\n\nAI-Ship-Authority: launch-prompt\n';
    assert.equal(findReservedTrailers(typed).length, 1);
  });
});

describe('final-review marker lifecycle fails closed (audit R2 H1/H3)', () => {
  const EV = { runId: RUN, auditedTree: TREE, round: 4 };
  const withDir = (fn) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'final-review-lc-')); try { return fn(d); } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } };

  it('APPROVE then REJECT for the same identity: the file now says REJECT and the ship check refuses', () => withDir((d) => {
    writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'APPROVE' });
    writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'REJECT' });
    const r = readFinalReviewMarker(d);
    assert.equal(r.marker.verdict, 'REJECT');
    assert.match(only(evaluatePreauthorisedShip({ ...GOOD(), finalReview: r }), 'final-review').reason, /REJECT, not APPROVE/);
  }));

  it('APPROVE then a FAILED replacement: the approval is gone (absent), never left readable', () => withDir((d) => {
    writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'APPROVE' });
    const w = writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'CONCERNS', log: () => {}, adapters: { atomicWriteFileSync: () => { throw Object.assign(new Error('x'), { code: 'ENOSPC' }); } } });
    assert.deepEqual([w.written, w.reason], [false, 'write-failed']);
    assert.deepEqual(readFinalReviewMarker(d), { ok: false, reason: 'absent' });
    assert.equal(evaluatePreauthorisedShip({ ...GOOD(), finalReview: readFinalReviewMarker(d) }).ok, false);
  }));

  it('APPROVE then a review whose evidence cannot identify it: the old approval is removed too', () => withDir((d) => {
    writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'APPROVE' });
    const w = writeFinalReviewMarker({ repoRoot: d, evidence: { ...EV, round: null }, verdict: 'APPROVE', log: () => {} });
    assert.equal(w.reason, 'evidence-cannot-identify-the-review');
    assert.equal(readFinalReviewMarker(d).reason, 'absent');
  }));

  it('a previous marker that cannot be removed is reported, not hidden', () => withDir((d) => {
    writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'APPROVE' });
    const w = writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'REJECT', log: () => {}, adapters: { unlinkSync: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); } } });
    assert.deepEqual([w.written, w.reason], [false, 'stale-marker-not-removable']);
  }));
});

describe('gatherChangedPaths: the authoritative default branch is never swapped for another (audit R2 H2/H4)', () => {
  const seq = (table) => { const calls = []; const run = (args) => { calls.push(args.join(' ')); for (const [k, v] of table) if (args.join(' ').startsWith(k)) return v; return { status: 1, stdout: '' }; }; return { run, calls }; };

  it('origin/HEAD names develop but its merge base fails: null, and origin/main is NOT tried', () => {
    const { run, calls } = seq([['symbolic-ref', { status: 0, stdout: 'refs/remotes/origin/develop\n' }], ['merge-base HEAD origin/develop', { status: 1, stdout: '' }], ['merge-base HEAD origin/main', { status: 0, stdout: 'abc\n' }], ['diff', { status: 0, stdout: 'a.mjs\0' }]]);
    assert.equal(gatherChangedPaths(run, 'tree'), null);
    assert.equal(calls.some((c) => c === 'merge-base HEAD origin/main'), false);
  });

  it('origin/HEAD names develop and resolves: develop is the base', () => {
    const { run, calls } = seq([['symbolic-ref', { status: 0, stdout: 'refs/remotes/origin/develop\n' }], ['merge-base HEAD origin/develop', { status: 0, stdout: 'dev1\n' }], ['diff', { status: 0, stdout: 'a.mjs\0' }]]);
    assert.deepEqual(gatherChangedPaths(run, 'tree'), ['a.mjs']);
    assert.ok(calls.includes('diff --name-only --no-renames -z dev1 tree'));
  });

  it('origin/HEAD unavailable: origin/main is the only fallback', () => {
    const { run, calls } = seq([['merge-base HEAD origin/main', { status: 0, stdout: 'm1\n' }], ['diff', { status: 0, stdout: 'a.mjs\0' }]]);
    assert.deepEqual(gatherChangedPaths(run, 'tree'), ['a.mjs']);
    assert.ok(calls.includes('merge-base HEAD origin/main'));
  });
});
