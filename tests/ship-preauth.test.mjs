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
import { spawnSync } from 'node:child_process';
import {
  evaluatePreauthorisedShip, isMigrationPath, isPolicyPath, isSensitivePath, gatherChangedPaths, renderPreauthConditions,
} from '../scripts/lib/ship-preauth.mjs';
import {
  buildFinalReviewMarker, writeFinalReviewMarker, readFinalReviewMarker, revokePreviousMarker, REVOKED_MARKER_TEXT, REVOKED_SIDECAR_RELPATH, FINAL_REVIEW_RELPATH,
  matchFinalReviewMarker, boundFinalReviewDisposition, FINAL_REVIEW_DISPOSITIONS,
} from '../scripts/lib/final-review-marker.mjs';
import { formatTrailerBlock, composeFinalMessage, findReservedTrailers } from '../scripts/lib/commit-trailers.mjs';

const RUN = '981fc79a-0fbb-447a-a294-b0c0217dab71';
const OTHER_RUN = '11111111-2222-4333-8444-555555555555';
const TREE = 'ca77e929e43535fdee278229eed00a08cde80f59';
const OTHER_TREE = '4ca9f5a05945f5495eae1f6b4128406a3af46ab9';

const evidence = (extra = {}) => ({ runId: RUN, auditedTree: TREE, round: 4, auditedBranch: 'claude/x', ...extra });
const finalReview = (extra = {}) => ({ ok: true, marker: { runId: RUN, auditedTree: TREE, round: 4, verdict: 'APPROVE', disposition: 'approve', ts: '2026-10-15T07:00:00.000Z', ...extra } });
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
    ['final-review', { finalReview: finalReview({ verdict: 'CONCERNS', disposition: 'approve_with_debt' }) }, /CONCERNS, not APPROVE/],
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
    assert.ok(calls.some((c) => c === 'merge-base HEAD refs/remotes/origin/main'));
    assert.equal(calls.some((c) => c === 'merge-base HEAD main'), false, "a local main can differ from the remote's: an unverified base is a refusal, not a substitute");
    // ...and a local main that WOULD resolve is not consulted when the remote refs are unavailable:
    const onlyLocal = (args) => (args.join(' ') === 'merge-base HEAD main' ? { status: 0, stdout: 'deadbeef' } : { status: 1, stdout: '' });
    assert.equal(gatherChangedPaths(onlyLocal, 'tree'), null);
    assert.equal(gatherChangedPaths(runner([['symbolic-ref', { status: 1 }], ['merge-base HEAD refs/remotes/origin/main', { status: 0, stdout: 'b\n' }], ['diff', { status: 1 }]]), 'tree'), null, 'a failed diff is null, never []');
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
    assert.deepEqual(Object.keys(buildFinalReviewMarker({ evidence: EV, verdict: 'APPROVE', disposition: 'approve' })).sort(), ['auditedTree', 'disposition', 'round', 'runId', 'ts', 'verdict']);
    for (const bad of [
      { evidence: null, verdict: 'APPROVE', disposition: 'approve' },
      { evidence: { ...EV, runId: 'x' }, verdict: 'APPROVE', disposition: 'approve' },
      { evidence: { ...EV, auditedTree: 'nope' }, verdict: 'APPROVE', disposition: 'approve' },
      { evidence: { ...EV, round: null }, verdict: 'APPROVE', disposition: 'approve' },
      { evidence: { ...EV, round: 1.5 }, verdict: 'APPROVE', disposition: 'approve' },
      { evidence: EV, verdict: 'MAYBE', disposition: 'approve' },
      { evidence: EV, verdict: undefined },
    ]) assert.equal(buildFinalReviewMarker(bad), null, JSON.stringify(bad));
  });

  it('round-trips through write and read, and absent / malformed / unreadable are three distinct reasons', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-review-'));
    try {
      assert.deepEqual(readFinalReviewMarker(dir), { ok: false, reason: 'absent' });
      const w = writeFinalReviewMarker({ repoRoot: dir, evidence: EV, verdict: 'APPROVE', disposition: 'approve' });
      assert.equal(w.written, true);
      const r = readFinalReviewMarker(dir);
      assert.equal(r.ok, true);
      assert.deepEqual({ ...r.marker, ts: null }, { runId: RUN, auditedTree: TREE, round: 4, verdict: 'APPROVE', disposition: 'approve', ts: null });

      fs.writeFileSync(path.join(dir, FINAL_REVIEW_RELPATH), '{not json');
      assert.deepEqual(readFinalReviewMarker(dir), { ok: false, reason: 'malformed' });
      fs.writeFileSync(path.join(dir, FINAL_REVIEW_RELPATH), JSON.stringify({ runId: RUN, auditedTree: TREE, round: '4', verdict: 'APPROVE', ts: 'x' }));
      assert.deepEqual(readFinalReviewMarker(dir), { ok: false, reason: 'malformed' }, 'a string round / bad ts must not read as a marker');

      const throwing = { readFileSync: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; } };
      assert.deepEqual(readFinalReviewMarker(dir, { fsMod: throwing }), { ok: false, reason: 'unreadable' });
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a failed write is reported, never thrown, and an unidentifiable review writes nothing', () => {
    const w = writeFinalReviewMarker({ repoRoot: os.tmpdir(), evidence: EV, verdict: 'APPROVE', disposition: 'approve', log: () => {}, adapters: { atomicWriteFileSync: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); } } });
    assert.deepEqual([w.written, w.reason], [false, 'write-failed']);
    const none = writeFinalReviewMarker({ repoRoot: os.tmpdir(), evidence: { ...EV, round: null }, verdict: 'APPROVE', disposition: 'approve', log: () => {} });
    assert.deepEqual([none.written, none.reason], [false, 'evidence-cannot-identify-the-review']);
  });

  it('end to end: a marker the writer produced satisfies the ship check; one from another round does not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-review-e2e-'));
    try {
      writeFinalReviewMarker({ repoRoot: dir, evidence: EV, verdict: 'APPROVE', disposition: 'approve' });
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

describe('final-review marker lifecycle fails closed (audit R2 H1/H3, R3 H1/H4)', () => {
  const EV = { runId: RUN, auditedTree: TREE, round: 4 };
  const withDir = (fn) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'final-review-lc-')); try { return fn(d); } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } };
  const eperm = () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); };
  const denied = (d) => evaluatePreauthorisedShip({ ...GOOD(), finalReview: readFinalReviewMarker(d) });

  it('APPROVE then REJECT for the same identity: the file now says REJECT and the ship check refuses', () => withDir((d) => {
    writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'APPROVE', disposition: 'approve' });
    writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'REJECT', disposition: 'blocked' });
    const r = readFinalReviewMarker(d);
    assert.equal(r.marker.verdict, 'REJECT');
    assert.match(only(evaluatePreauthorisedShip({ ...GOOD(), finalReview: r }), 'final-review').reason, /REJECT, not APPROVE/);
  }));

  it('APPROVE then a FAILED replacement: the approval is gone (absent), never left readable', () => withDir((d) => {
    writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'APPROVE', disposition: 'approve' });
    const w = writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'CONCERNS', disposition: 'approve_with_debt', log: () => {}, adapters: { atomicWriteFileSync: () => { throw Object.assign(new Error('x'), { code: 'ENOSPC' }); } } });
    assert.deepEqual([w.written, w.reason], [false, 'write-failed']);
    assert.deepEqual(readFinalReviewMarker(d), { ok: false, reason: 'absent' });
    assert.equal(denied(d).ok, false);
  }));

  it('APPROVE then a review whose evidence cannot identify it: the old approval is removed too', () => withDir((d) => {
    writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'APPROVE', disposition: 'approve' });
    const w = writeFinalReviewMarker({ repoRoot: d, evidence: { ...EV, round: null }, verdict: 'APPROVE', disposition: 'approve', log: () => {} });
    assert.equal(w.reason, 'evidence-cannot-identify-the-review');
    assert.equal(readFinalReviewMarker(d).reason, 'absent');
  }));

  it('END TO END: unlink fails with EPERM, so the old approval is overwritten with a tombstone and the replacement fails too: shipping is denied', () => withDir((d) => {
    writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'APPROVE', disposition: 'approve' });
    assert.equal(denied(d).ok, true, 'precondition: the approval authorises');
    const w = writeFinalReviewMarker({
      repoRoot: d, evidence: EV, verdict: 'REJECT', disposition: 'blocked', log: () => {},
      adapters: { unlinkSync: eperm, atomicWriteFileSync: () => { throw Object.assign(new Error('x'), { code: 'ENOSPC' }); } },
    });
    assert.deepEqual([w.written, w.reason], [false, 'write-failed']);
    assert.deepEqual(readFinalReviewMarker(d), { ok: false, reason: 'malformed' }, 'the tombstone reads as a marker no consumer accepts');
    assert.equal(denied(d).ok, false, 'a previous APPROVE can no longer authorise');
  }));

  it('unlink fails but the review CAN be recorded: the new verdict replaces the tombstone', () => withDir((d) => {
    writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'APPROVE', disposition: 'approve' });
    const w = writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'REJECT', disposition: 'blocked', log: () => {}, adapters: { unlinkSync: eperm } });
    assert.equal(w.written, true);
    assert.equal(readFinalReviewMarker(d).marker.verdict, 'REJECT');
  }));

  it('R3 H1 DOUBLE FAILURE with the replacement failing too: the revocation file stays and the reader refuses with reason revoked', () => withDir((d) => {
    writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'APPROVE', disposition: 'approve' });
    const guarded = (real) => (p, ...rest) => { if (String(p).endsWith('last-final-review.json')) throw Object.assign(new Error('locked'), { code: 'EPERM' }); return real(p, ...rest); };
    const w = writeFinalReviewMarker({
      repoRoot: d, evidence: EV, verdict: 'REJECT', disposition: 'blocked', log: () => {},
      adapters: { unlinkSync: guarded(fs.unlinkSync), overwriteFileSync: eperm, atomicWriteFileSync: () => { throw Object.assign(new Error('x'), { code: 'ENOSPC' }); } },
    });
    assert.equal(w.reason, 'write-failed');
    assert.ok(fs.existsSync(path.join(d, REVOKED_SIDECAR_RELPATH)), 'the shadowing file exists');
    assert.ok(fs.existsSync(path.join(d, FINAL_REVIEW_RELPATH)), 'and the OLD approval is physically still there (that is the scenario)');
    assert.deepEqual(readFinalReviewMarker(d), { ok: false, reason: 'revoked' });
    assert.equal(denied(d).ok, false, 'shipping is denied although the old APPROVE could not be touched');
  }));

  it('a later successful review removes the revocation file; a revocation file that cannot be removed keeps refusing and says so', () => withDir((d) => {
    fs.mkdirSync(path.join(d, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(d, REVOKED_SIDECAR_RELPATH), '{}');
    const stuckLogs = [];
    const stuck = writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'APPROVE', disposition: 'approve', log: (m) => stuckLogs.push(m), adapters: { unlinkSync: (p) => { if (String(p).endsWith('.revoked')) throw Object.assign(new Error('locked'), { code: 'EPERM' }); return fs.unlinkSync(p); } } });
    assert.equal(stuck.written, true);
    assert.equal(stuck.sidecarStuck, true);
    assert.match(stuckLogs.join(''), /keep refusing/);
    assert.equal(readFinalReviewMarker(d).reason, 'revoked', 'fail closed until the file is deleted');
    fs.rmSync(path.join(d, REVOKED_SIDECAR_RELPATH), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const ok = writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'APPROVE', disposition: 'approve' });
    assert.equal(ok.written, true);
    assert.equal(readFinalReviewMarker(d).ok, true);
  }));

  it('R4 H1 INTERLEAVING: a second writer cannot run inside the first one\'s critical section, so it cannot have its revocation deleted by the first\'s cleanup', () => withDir((d) => {
    writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'APPROVE', disposition: 'approve' });
    // Writer A (an older APPROVE) pauses AFTER writing and BEFORE its sidecar cleanup. Inside that window writer B (a newer
    // REJECT whose own deletes are refused) starts: it must not get to create a revocation that A's cleanup then removes.
    let b = null;
    const a = writeFinalReviewMarker({
      repoRoot: d, evidence: EV, verdict: 'APPROVE', disposition: 'approve', log: () => {},
      adapters: {
        afterWrite: () => {
          b = writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'REJECT', disposition: 'blocked', log: () => {}, adapters: { lockAttempts: 2, unlinkSync: eperm, overwriteFileSync: eperm } });
        },
      },
    });
    assert.equal(a.written, true);
    assert.deepEqual([b.written, b.reason, b.revoked], [false, 'lock-contention', false], 'B is refused the lock, and says it recorded nothing');
    assert.equal(fs.existsSync(path.join(d, REVOKED_SIDECAR_RELPATH)), false, 'B created no revocation for A to delete');
    assert.equal(fs.existsSync(path.join(d, '.audit', 'last-final-review.lock')), false, 'and the lock is released afterwards');
    // After A finishes, B can run normally and its REJECT is what stands.
    const b2 = writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'REJECT', disposition: 'blocked' });
    assert.equal(b2.written, true);
    assert.equal(readFinalReviewMarker(d).marker.verdict, 'REJECT');
  }));

  it('when the marker can be neither deleted, overwritten nor shadowed, the writer says so loudly and revoked is false (the caller must fail)', () => withDir((d) => {
    writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'APPROVE', disposition: 'approve' });
    const logged = [];
    const w = writeFinalReviewMarker({ repoRoot: d, evidence: EV, verdict: 'REJECT', disposition: 'blocked', log: (m) => logged.push(m), adapters: { unlinkSync: eperm, overwriteFileSync: eperm, createFileSync: eperm } });
    assert.deepEqual([w.written, w.reason, w.revoked], [false, 'stale-marker-not-removable', false]);
    assert.match(logged.join(''), /FATAL/);
  }));

  it('revokePreviousMarker: absent is fine, a transient EPERM is retried, a tombstone is what an in-place overwrite writes', () => withDir((d) => {
    const f = path.join(d, 'm.json');
    assert.deepEqual(revokePreviousMarker(f), { ok: true, how: 'absent' });
    fs.writeFileSync(f, '{"x":1}');
    let n = 0;
    const flaky = (p) => { if (n++ < 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); fs.unlinkSync(p); };
    assert.deepEqual(revokePreviousMarker(f, { unlink: flaky }), { ok: true, how: 'removed' });
    fs.writeFileSync(f, '{"x":1}');
    assert.deepEqual(revokePreviousMarker(f, { unlink: eperm }), { ok: true, how: 'tombstoned' });
    assert.equal(fs.readFileSync(f, 'utf8'), REVOKED_MARKER_TEXT);
  }));
});

describe('gatherChangedPaths: the authoritative default branch is never swapped for another (audit R2 H2/H4, R3 H2/H3)', () => {
  const seq = (table) => { const calls = []; const run = (args) => { calls.push(args.join(' ')); for (const [k, v] of table) if (args.join(' ').startsWith(k)) return v; return { status: 1, stdout: '' }; }; return { run, calls }; };

  it('origin/HEAD names develop but its merge base fails: null, and origin/main is NOT tried', () => {
    const { run, calls } = seq([['symbolic-ref', { status: 0, stdout: 'refs/remotes/origin/develop\n' }], ['merge-base HEAD refs/remotes/origin/develop', { status: 1, stdout: '' }], ['merge-base HEAD refs/remotes/origin/main', { status: 0, stdout: 'abc\n' }], ['diff', { status: 0, stdout: 'a.mjs\0' }]]);
    assert.equal(gatherChangedPaths(run, 'tree'), null);
    assert.equal(calls.some((c) => c.includes('origin/main')), false);
  });

  it('origin/HEAD names develop and resolves: the FULLY QUALIFIED ref is the base', () => {
    const { run, calls } = seq([['symbolic-ref', { status: 0, stdout: 'refs/remotes/origin/develop\n' }], ['merge-base HEAD refs/remotes/origin/develop', { status: 0, stdout: 'dev1\n' }], ['diff', { status: 0, stdout: 'a.mjs\0' }]]);
    assert.deepEqual(gatherChangedPaths(run, 'tree'), ['a.mjs']);
    assert.ok(calls.includes('diff --name-only --no-renames -z dev1 tree'));
  });

  it('origin/HEAD unavailable: the fully qualified origin/main is the only fallback', () => {
    const { run, calls } = seq([['merge-base HEAD refs/remotes/origin/main', { status: 0, stdout: 'm1\n' }], ['diff', { status: 0, stdout: 'a.mjs\0' }]]);
    assert.deepEqual(gatherChangedPaths(run, 'tree'), ['a.mjs']);
    assert.ok(calls.includes('merge-base HEAD refs/remotes/origin/main'));
  });

  it('REAL REPO: a LOCAL branch named origin/develop does not hide the PR (the shortened name would resolve to it)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'preauth-refs-'));
    try {
      const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); git('add', '-A'); git('commit', '-q', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/remotes/origin/develop', base);                       // the remote's default branch
      git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
      git('checkout', '-q', '-b', 'feature');
      fs.writeFileSync(path.join(repo, 'CODEOWNERS'), '* @x\n'); git('add', '-A'); git('commit', '-q', '-m', 'policy change');
      git('branch', 'origin/develop', 'HEAD');                                       // the collision: local refs/heads/origin/develop AT HEAD
      const run = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      // The instrument is real: the shortened name DOES resolve to the local branch, so its merge base is HEAD (empty diff).
      assert.equal(git('merge-base', 'HEAD', 'origin/develop'), git('rev-parse', 'HEAD'), 'the collision must exist, or this test proves nothing');
      assert.deepEqual(gatherChangedPaths(run, 'HEAD'), ['CODEOWNERS']);
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

// ── Cluster B (docs/plans/copilot-feedback-item4.md section 2.2: B1, B2, B2b) ──────────────────────────────────────────────
describe('B2b: the pre-authorised check enforces the final-review RESULT (disposition), not only the verdict word', () => {
  it('APPROVE with result blocked is REFUSED, naming the result (a required subject not received in full, a blocking finding)', () => {
    const v = evaluatePreauthorisedShip({ ...GOOD(), finalReview: finalReview({ disposition: 'blocked' }) });
    assert.equal(v.ok, false);
    assert.deepEqual(failing(v), ['final-review']);
    assert.match(only(v, 'final-review').reason, /result is blocked, not approve/);
  });

  it('approve_with_debt does not pre-authorise either (stated against the result, not inferred from the verdict)', () => {
    const v = evaluatePreauthorisedShip({ ...GOOD(), finalReview: finalReview({ verdict: 'CONCERNS', disposition: 'approve_with_debt' }) });
    assert.deepEqual(failing(v), ['final-review']);
  });

  it('a marker written before dispositions existed is refused with its OWN reason, distinct from malformed', () => {
    const legacy = finalReview();
    delete legacy.marker.disposition;
    const v = evaluatePreauthorisedShip({ ...GOOD(), finalReview: legacy });
    assert.match(only(v, 'final-review').reason, /predates dispositions: re-run the final review/);
    assert.doesNotMatch(only(v, 'final-review').reason, /malformed/);
    // ...and the reader reports such a file as well-formed with disposition null, so the refusal is reachable from disk.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-review-legacy-'));
    try {
      fs.mkdirSync(path.join(dir, '.audit'), { recursive: true });
      fs.writeFileSync(path.join(dir, FINAL_REVIEW_RELPATH), JSON.stringify({ runId: RUN, auditedTree: TREE, round: 4, verdict: 'APPROVE', ts: '2026-10-15T07:00:00.000Z' }));
      const r = readFinalReviewMarker(dir);
      assert.equal(r.ok, true);
      assert.equal(r.marker.disposition, null);
      assert.match(only(evaluatePreauthorisedShip({ ...GOOD(), finalReview: r }), 'final-review').reason, /predates dispositions/);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('approve on a bound marker is accepted (the direction the check must NOT fire)', () => {
    const v = evaluatePreauthorisedShip(GOOD());
    assert.equal(only(v, 'final-review').ok, true);
    assert.match(only(v, 'final-review').reason, /result approve/);
  });
});

describe('B1: the marker carries the disposition, and only a legal verdict/disposition pair', () => {
  const EV = { runId: RUN, auditedTree: TREE, round: 4 };

  it('the three dispositions are exactly the ones the round gate computes', () => {
    assert.deepEqual([...FINAL_REVIEW_DISPOSITIONS].sort(), ['approve', 'approve_with_debt', 'blocked']);
  });

  it('legal pairs build; a missing, unknown or contradictory disposition builds nothing (no marker without a result)', () => {
    for (const [verdict, disposition] of [['APPROVE', 'approve'], ['APPROVE', 'blocked'], ['CONCERNS', 'approve_with_debt'], ['CONCERNS_REMAINING', 'approve_with_debt'], ['CONCERNS', 'blocked'], ['REJECT', 'blocked']]) {
      assert.equal(buildFinalReviewMarker({ evidence: EV, verdict, disposition })?.disposition, disposition, `${verdict}/${disposition}`);
    }
    for (const [verdict, disposition] of [['APPROVE', undefined], ['APPROVE', null], ['APPROVE', 'approve-with-debt'], ['APPROVE', 'approve_with_debt'], ['CONCERNS', 'approve'], ['REJECT', 'approve'], ['REJECT', 'approve_with_debt']]) {
      assert.equal(buildFinalReviewMarker({ evidence: EV, verdict, disposition }), null, `${verdict}/${disposition}`);
    }
  });

  it('the reader: an unknown or contradictory disposition on disk is malformed; a legal one round-trips', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-review-disp-'));
    try {
      fs.mkdirSync(path.join(dir, '.audit'), { recursive: true });
      const put = (extra) => fs.writeFileSync(path.join(dir, FINAL_REVIEW_RELPATH), JSON.stringify({ runId: RUN, auditedTree: TREE, round: 4, verdict: 'APPROVE', ts: '2026-10-15T07:00:00.000Z', ...extra }));
      for (const disposition of ['approved', 'approve-with-debt', 1, true, 'approve_with_debt', null]) {
        put({ disposition });
        assert.deepEqual(readFinalReviewMarker(dir), { ok: false, reason: 'malformed' }, JSON.stringify(disposition));
      }
      put({ disposition: 'blocked' });
      assert.equal(readFinalReviewMarker(dir).marker.disposition, 'blocked');
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('B2: matchFinalReviewMarker is the ONE binding predicate (run + tree + round)', () => {
  it('binds when all three equal the gate evidence, and refuses each mismatch with its own reason', () => {
    assert.deepEqual(matchFinalReviewMarker(evidence(), finalReview()), { ok: true, reason: null });
    const cases = [
      [null, finalReview(), /no gate-evidence marker/],
      [evidence(), { ok: false, reason: 'revoked' }, /revoked/],
      [evidence(), null, /not read/],
      [evidence({ round: null }), finalReview(), /no round/],
      [evidence(), finalReview({ runId: OTHER_RUN }), /approval is for run 11111111/],
      [evidence(), finalReview({ auditedTree: OTHER_TREE }), /different audited tree/],
      [evidence(), finalReview({ round: 3 }), /round 3, the audit evidence is round 4/],
    ];
    for (const [ev, fr, why] of cases) {
      const m = matchFinalReviewMarker(ev, fr);
      assert.equal(m.ok, false, String(why));
      assert.match(m.reason, why);
    }
  });

  it("it is the binding only: the verdict and the disposition are the caller's policy, not part of the match", () => {
    assert.equal(matchFinalReviewMarker(evidence(), finalReview({ verdict: 'REJECT', disposition: 'blocked' })).ok, true);
  });

  it('boundFinalReviewDisposition: the disposition of a BOUND marker, else null (never a value from an unbound one)', () => {
    assert.equal(boundFinalReviewDisposition(evidence(), finalReview({ verdict: 'CONCERNS', disposition: 'approve_with_debt' })), 'approve_with_debt');
    assert.equal(boundFinalReviewDisposition(evidence(), finalReview({ disposition: 'blocked' })), 'blocked');
    assert.equal(boundFinalReviewDisposition(evidence(), finalReview({ round: 3 })), null);
    assert.equal(boundFinalReviewDisposition(null, finalReview()), null);
    assert.equal(boundFinalReviewDisposition(evidence(), { ok: false, reason: 'absent' }), null);
    const legacy = finalReview();
    delete legacy.marker.disposition;
    assert.equal(boundFinalReviewDisposition(evidence(), legacy), null, 'a legacy marker yields no trailer');
  });
});
