/**
 * @fileoverview A regression lock citing a file that does not exist reads as coverage
 * forever — upstream report `b2c9a63f` (Lbstrydom/wine-cellar-app, 2026-09-06).
 *
 * `unlocked_fixes`'s only lock predicate is `EXISTS (SELECT 1 FROM regression_specs …)`,
 * so recording a spec REMOVES the finding from the view whose entire job is surfacing
 * fixes that lack regression coverage. A dangling citation therefore discharges the
 * obligation permanently, and nothing re-raises it: the queue reports a clean backlog
 * that is not clean.
 *
 * **The read side is the primary instrument** — a citation's truth is not a property of
 * the moment it was written. Measured here the day of that fix: 3 of 235 rows cite a path
 * that no longer resolves, all three `source_kind: 'unit-test'` and all three deleted by
 * one commit (`e833b2aa`, "retire the consistency candidate promotion path"). They were
 * TRUE when recorded and invalidated later by a legitimate refactor, so a write-time check
 * would have caught zero of them. The reporter's own three were the opposite case (tests
 * on unmerged branches).
 *
 * **But not the ONLY instrument — upstream `429683ac` (2026-09-07) falsified the stronger
 * reading of that number.** Two further dangling locks from the same consumer, both
 * `source_kind: 'unit-test'`, verified in that store on 2026-09-07 (the ids are FINDING
 * ids; the spec rows are named beside them):
 *   - finding `d23094b2` (row `d4d3b2d7`) cited `builderTemplateFallbackParity.test.js`,
 *     deleted in the same PR that recorded the lock — true-when-written, consistent with
 *     the b2c9a63f population above.
 *   - finding `e473285b` (row `806ce553`, created 2026-08-29 19:11Z) cited
 *     `noV1RegistryInValidators.test.js`, deleted 16 days EARLIER on 2026-08-13 by
 *     `2e25afda` — FALSE ON ARRIVAL, and catchable by a write-time probe.
 * The known population is 1 of 5 write-time-catchable, not 0 of 3. Both locks were
 * re-pointed by the reporter on 2026-09-07 07:30Z using `repoint-regression-spec`
 * (d8cbddca), so their `spec_path` resolves today while `created_at` still dates the
 * original claim — which is exactly the distinction the read side cannot draw.
 *
 * **The mechanism is the finding, and the attribution is checkable rather than assumed.**
 * `lock-with-test` already carried `classifyTestPath` on 2026-08-29 (rev `0088db7c`), so it
 * cannot have written a lock citing an already-deleted file; `ux-lock-run.mjs` cannot write
 * a `unit-test` row at all, passing no `sourceFindingId` where the store requires one. That
 * left `record-regression-spec`, which took `sourceKind` from the caller's payload under no
 * constraint and so could mint an identical-looking `unit-test` row with no validation — the
 * validating verb's guarantee fully bypassable through its sibling, the two rows
 * indistinguishable in the store. The write half below pins the fix: claiming `unit-test`
 * now means clearing `unit-test`'s path contract, while deferred-write kinds stay permissive.
 *
 * @module tests/dangling-regression-lock
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  listUnlockedFixesCmd, recordRegressionSpecCmd, repointRegressionSpecCmd,
} from '../scripts/lib/cross-skill/commands/ship.mjs';
import { mkdtemp, sh, commitAll, rmrfBestEffort } from './helpers/fixtures.mjs';
import { CommandError } from '../scripts/lib/cross-skill/dispatch.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
/** A file that genuinely exists in this repo — this test file itself. */
const REAL_SPEC = 'tests/dangling-regression-lock.test.mjs';
const GONE_SPEC = 'tests/retired-by-a-refactor.test.mjs';

function makeCtx({ recorded = [], repoId = 'repo-1', cloud = true, payload = {} } = {}) {
  return {
    verb: 'list-unlocked-fixes',
    cloud: { enabled: cloud },
    flag: () => null,
    hasFlag: () => false,
    payload: () => payload,
    git: { commitSha: () => 'abc1234', branch: () => 'main' },
    degrade: () => ({ ok: true, cloud: false }),
    resolveScope: async () => (repoId ? { kind: 'scoped', repoId, slug: 'owner/repo' } : { kind: 'unresolved', reason: 'repo-identity-unresolvable' }),
    deps: {
      getUnlockedFixes: async () => [],
      countUnlockedFixes: async () => ({ total: 0, code: 0, plan: 0 }),
      countAgedUnlockedFixes: async () => ({ agedOut: 0, byMode: { code: 0, plan: 0 }, prePractice: 0, practiceStart: null }),
      resolveNudgePage: () => ({ limit: 20, offset: 0 }),
      getRecordedSpecPaths: async () => recorded,
      recordRegressionSpec: async () => ({ ok: true, specId: 'spec-1' }),
    },
  };
}

describe('the /ship lock nudge reports locks whose spec_path no longer resolves', () => {
  it('counts a citation naming a missing file, and leaves a real one alone', async () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, REAL_SPEC)), 'the control file must really exist');
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, GONE_SPEC)), 'the subject file must really be absent');

    const out = await listUnlockedFixesCmd(makeCtx({
      recorded: [
        { specPath: REAL_SPEC, sourceKind: 'unit-test', sourceFindingId: 'f1', createdAt: null },
        { specPath: GONE_SPEC, sourceKind: 'unit-test', sourceFindingId: 'f2', createdAt: null },
      ],
    }));
    assert.equal(out.danglingLocks.count, 1);
    assert.equal(out.danglingLocks.checked, 2);
    assert.equal(out.danglingLocks.rows[0].specPath, GONE_SPEC);
  });

  it('a clean repo reports 0 — a real measured zero, distinct from unmeasured', async () => {
    const out = await listUnlockedFixesCmd(makeCtx({
      recorded: [{ specPath: REAL_SPEC, sourceKind: 'unit-test', sourceFindingId: 'f1', createdAt: null }],
    }));
    assert.equal(out.danglingLocks.count, 0);
    assert.equal(out.danglingLocks.reason, null);
  });

  // ── The direction that must NOT read as clean ────────────────────────────
  it('cloud off is UNMEASURED (count null), never a clean zero', async () => {
    const out = await listUnlockedFixesCmd(makeCtx({ cloud: false }));
    assert.equal(out.danglingLocks.count, null, 'an unasked question must not render as a clean result');
    assert.equal(out.danglingLocks.reason, 'cloud-off');
  });

  it('an unresolved repo is UNMEASURED, and a failing read degrades to unmeasured too', async () => {
    const ctx = makeCtx({});
    ctx.deps.getRecordedSpecPaths = async () => { throw new Error('store unreachable'); };
    const out = await listUnlockedFixesCmd(ctx);
    assert.equal(out.danglingLocks.count, null);
    assert.match(out.danglingLocks.reason, /unreadable/);
    // and it must not have broken the nudge it rides on
    assert.equal(out.ok, true);
    assert.equal(out.measured, true);
  });

  it('is anchored to the REPO ROOT, not process.cwd(): the same lock reads the same from a subdirectory', async () => {
    // Measured 2026-09-13 (docs/plans/backlog-tooling-honesty.md §1 item 5): run
    // from scripts/lib/audit/ the live CLI reported 269 dangling locks against a
    // true 3, because every recorded `tests/…` path was resolved under the
    // subdirectory. A fixture repo with one real test file, read from its root
    // and from a nested directory, must agree.
    const repo = mkdtemp('ces-lock-root-');
    const prevCwd = process.cwd();
    try {
      sh(repo, 'init', '-q');
      fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
      fs.mkdirSync(path.join(repo, 'scripts', 'lib', 'audit'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'tests', 'x.test.mjs'), 'export const ok = true;\n');
      fs.writeFileSync(path.join(repo, 'scripts', 'lib', 'audit', 'keep.mjs'), '// keep\n');
      commitAll(repo, 'fixture');
      const recorded = [{ specPath: 'tests/x.test.mjs', sourceKind: 'unit-test', sourceFindingId: 'f1', createdAt: null }];

      process.chdir(repo);
      const fromRoot = await listUnlockedFixesCmd(makeCtx({ recorded }));
      process.chdir(path.join(repo, 'scripts', 'lib', 'audit'));
      const fromSubdir = await listUnlockedFixesCmd(makeCtx({ recorded }));

      assert.equal(fromRoot.danglingLocks.count, 0, 'the lock names a file that exists at the repo root');
      assert.equal(fromSubdir.danglingLocks.count, fromRoot.danglingLocks.count,
        'a subdirectory cwd must not change the answer — this is the 269-vs-3 defect in miniature');
    } finally {
      process.chdir(prevCwd);
      rmrfBestEffort(repo);
    }
  });

  it('a spec_path naming a DIRECTORY is dangling — existsSync alone would accept it', async () => {
    // The INC-001 class the shared oracle already handles: `classifyTestPath` requires a
    // regular file, so a lock naming `tests/` cannot read as evidence.
    const out = await listUnlockedFixesCmd(makeCtx({
      recorded: [{ specPath: 'tests', sourceKind: 'unit-test', sourceFindingId: 'f1', createdAt: null }],
    }));
    assert.equal(out.danglingLocks.count, 1, 'a directory is not a test file');
  });
});

describe('record-regression-spec probes the filesystem for unit-test rows ONLY', () => {
  // This NARROWS a reversal rather than undoing it, and both halves are pinned so neither
  // is silently redone.
  //
  // The reverted attempt was an UNCONDITIONAL probe. It broke the golden-envelope capture
  // (placed above the cloud-off return, so a supported degrade became a refusal) and the
  // write-outcome fixture (a synthetic `tests/x.spec.ts` asserting exit codes, not paths).
  // Repairing those to fit it would have been fitting the tests to the change, and backing
  // it out whole was right. But both breakages were collateral from the SCOPE: the capture
  // writes `audit-loop-fix` and the fixture `ux-lock`, so under the scoped check neither
  // reaches the probe at all — which is what the "must NOT fire" cases below assert, by
  // kind, on purpose.

  it('THE DIRECTION THAT MUST FIRE: a unit-test row citing a missing file is refused', async () => {
    // upstream 429683ac / e473285b: recorded sixteen days after its test was deleted.
    // `source_kind: 'unit-test'` is lock-with-test's row shape — it selects that verb's
    // upsert arbiter and is excluded from ux-lock's adoption census — so claiming it
    // through the programmatic sibling must clear the same contract.
    const ctx = makeCtx({ payload: { sourceKind: 'unit-test', description: 'pins a thing', specPath: GONE_SPEC, sourceFindingId: 'f1' } });
    await assert.rejects(() => recordRegressionSpecCmd(ctx), (err) => {
      assert.ok(err instanceof CommandError);
      assert.equal(err.code, 'BAD_INPUT');
      assert.equal(err.exitCode, 2, 'a refused input is exit 2, never the write-failure exit');
      assert.equal(err.extra.reason, 'test-file-not-found');
      return true;
    });
  });

  it('a unit-test row naming a DIRECTORY is refused too — existsSync alone would accept it', async () => {
    // The same INC-001 class the read side already covers, through the SAME oracle: a
    // second spelling would let a row be writable and dangling at once.
    const ctx = makeCtx({ payload: { sourceKind: 'unit-test', description: 'd', specPath: 'tests', sourceFindingId: 'f1' } });
    await assert.rejects(() => recordRegressionSpecCmd(ctx), /not a regular file/);
  });

  it('accepts a unit-test row whose file really exists', async () => {
    const ctx = makeCtx({ payload: { sourceKind: 'unit-test', description: 'd', specPath: REAL_SPEC, sourceFindingId: 'f1' } });
    const out = await recordRegressionSpecCmd(ctx);
    assert.equal(out.ok, true);
  });

  // ── The directions that must NOT fire ────────────────────────────────────
  // A false refusal is silent in the other direction: tooling that legitimately records
  // the intent before writing the spec would start failing, at ship time, for everyone.

  it('a deferred-write kind still accepts a path that does not resolve', async () => {
    // /ux-lock, plan-verify and manual runs write the spec AFTER recording the intent to,
    // so for them a missing path is not yet a defect — the half of the original reasoning
    // that survived. The read-side report above surfaces a real typo one ship later.
    for (const sourceKind of ['ux-lock', 'plan-verify', 'manual', 'audit-code-fix']) {
      const ctx = makeCtx({ payload: { sourceKind, description: 'pins a thing', specPath: GONE_SPEC } });
      const out = await recordRegressionSpecCmd(ctx);
      assert.equal(out.ok, true, `${sourceKind} must not be probed`);
    }
  });

  it('the two kinds the reverted attempt broke are named explicitly', async () => {
    // Asserted BY KIND rather than by re-running those suites, so that if either fixture
    // is ever re-captured with a different sourceKind this states what changed. The
    // golden-envelope capture uses `audit-loop-fix`; the write-outcome fixture `ux-lock`.
    for (const sourceKind of ['audit-loop-fix', 'ux-lock']) {
      const ctx = makeCtx({ payload: { sourceKind, description: 'd', specPath: 'tests/x.spec.ts' } });
      const out = await recordRegressionSpecCmd(ctx);
      assert.equal(out.ok, true, `the ${sourceKind} fixture path must stay unprobed`);
    }
  });

  it('still refuses an ABSENT specPath — presence was always the contract here', async () => {
    const ctx = makeCtx({ payload: { sourceKind: 'unit-test', description: 'pins a thing' } });
    await assert.rejects(() => recordRegressionSpecCmd(ctx), /specPath is required/);
  });

  it('cloud off degrades WITHOUT probing, even for unit-test — the placement regression', async () => {
    // The specific break in the reverted attempt: a check placed before this early return
    // turned a supported mode into a refusal. Cloud-off writes nothing, so there is
    // nothing for a probe to protect. This is the negative control for PLACEMENT, and it
    // must use the one kind that IS probed or it proves nothing.
    const ctx = makeCtx({ cloud: false, payload: { sourceKind: 'unit-test', description: 'x', specPath: GONE_SPEC, sourceFindingId: 'f1' } });
    const out = await recordRegressionSpecCmd(ctx);
    assert.equal(out.ok, true);
    assert.equal(out.cloud, false);
  });

  it('lock-with-test KEEPS its own existence check — the verbs now agree on unit-test', async () => {
    // The interactive verb a human aims at one finding. Asserted on the source so the
    // shared contract stays deliberate rather than an accident nobody noticed.
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/lib/cross-skill/commands/ship.mjs'), 'utf-8');
    const lockFn = src.slice(src.indexOf('export async function lockWithTestCmd'));
    assert.match(lockFn.slice(0, 4000), /classifyTestPath/,
      'lock-with-test must keep refusing a citation it cannot resolve');
  });
});


// ── The WRITE half — upstream 429683ac ─────────────────────────────────────
//
// The read half above reports dangling locks. For its whole life nothing could
// act on that report: `lock-with-test` refuses an already-locked finding (correctly
// — its job is discharging an OPEN obligation), and `record-regression-spec`
// cannot re-point a unit-test row either, because its arbiter is
// (repo_id, spec_path, source_finding_id) — a call naming a NEW path does not
// conflict, so it INSERTS a second row and leaves the stale citation standing.
//
// Every case below is a REFUSAL or an outcome that must not be guessed, because
// the failure mode being closed is a lock that reads as coverage while claiming
// something false. A repair that quietly picked a row would reproduce it.

function makeRepointCtx({
  flags = {}, boolFlags = {}, repoId = 'repo-1', cloud = true,
  found = { ok: true, cloud: true, rows: [] },
  repoint = { ok: true, cloud: true, specId: 'spec-1', specPath: 'tests/new.test.mjs' },
  del = { ok: true, cloud: true, specId: 'spec-1', specPath: 'tests/old.test.mjs' },
  calls = {},
} = {}) {
  return {
    verb: 'repoint-regression-spec',
    cloud: { enabled: cloud },
    flag: (n) => flags[n] ?? null,
    hasFlag: (n) => Boolean(boolFlags[n]),
    payload: () => ({}),
    git: { commitSha: () => 'abc1234', branch: () => 'main' },
    degrade: () => ({ ok: true, cloud: false }),
    resolveScope: async () => (repoId
      ? { kind: 'scoped', repoId, slug: 'owner/repo' }
      : { kind: 'unresolved', reason: 'repo-identity-unresolvable' }),
    deps: {
      getRegressionSpecsForFinding: async (...a) => { calls.found = a; return found; },
      repointRegressionSpec: async (...a) => { calls.repoint = a; return repoint; },
      deleteRegressionSpec: async (...a) => { calls.delete = a; return del; },
    },
  };
}

const FINDING = 'a4969127-d5d0-47bb-8b2e-0acb0ed71546';

describe('repoint-regression-spec — the write half the dangling report had no verb for', () => {
  it('re-points a single lock, and names where it came FROM', async () => {
    const calls = {};
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING, test: REAL_SPEC, description: 'the old spec was deleted by a refactor' },
      found: { ok: true, cloud: true, rows: [{ id: 'spec-1', specPath: GONE_SPEC }] },
      repoint: { ok: true, cloud: true, specId: 'spec-1', specPath: REAL_SPEC },
      calls,
    }));
    assert.equal(out.ok, true);
    assert.equal(out.repointed, true);
    assert.equal(out.previousPath, GONE_SPEC, 'the operator must be able to see what was replaced');
    // The repo id comes from the resolved identity, never from the row — the
    // cross-tenant fence lock-with-test grew after adopting a foreign repo_id.
    assert.equal(calls.repoint[0], 'repo-1');
    assert.equal(calls.repoint[1].specId, 'spec-1');
  });

  it('THE DIRECTION THAT MUST FIRE: an AMBIGUOUS (repo, finding) is refused and its candidates named', async () => {
    // Not unique by construction — the unit-test arbiter includes spec_path, so
    // one finding may legitimately carry two citations. Picking the newest would
    // repair one and silently leave the other.
    const calls = {};
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING, test: REAL_SPEC, description: 'why' },
      found: { ok: true, cloud: true, rows: [
        { id: 'spec-1', specPath: GONE_SPEC },
        { id: 'spec-2', specPath: 'tests/other.test.mjs' },
      ] },
      calls,
    }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'ambiguous-lock');
    assert.match(out.error, /spec-1/);
    assert.match(out.error, /spec-2/);
    assert.equal(calls.repoint, undefined, 'nothing may be written while the target is ambiguous');
  });

  it('a READ that failed is not reported as "no lock"', async () => {
    // "could not look" and "nothing there" must not be the same answer: the
    // second reads as "nothing to fix" over a store outage.
    const calls = {};
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING, test: REAL_SPEC, description: 'why' },
      found: { ok: false, cloud: true, reason: 'read-failed', message: 'connection reset' },
      calls,
    }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'read-failed');
    assert.equal(calls.repoint, undefined);
  });

  it('refuses a new path that does not exist — moving a dangling lock is not fixing it', async () => {
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING, test: GONE_SPEC, description: 'why' },
    }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'test-file-not-found');
  });

  it('refuses an unresolvable repo rather than guessing one', async () => {
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING, test: REAL_SPEC, description: 'why' }, repoId: null,
    }));
    assert.equal(out.ok, false);
    assert.match(out.error, /repo identity unresolvable/);
  });

  it('requires a description, exactly as lock-with-test does', async () => {
    for (const description of [null, '   ']) {
      const out = await repointRegressionSpecCmd(makeRepointCtx({
        flags: { finding: FINDING, test: REAL_SPEC, description },
      }));
      assert.equal(out.ok, false, `description ${JSON.stringify(description)} must be refused`);
    }
  });

  it('--delete removes the lock, and says the finding is an open obligation again', async () => {
    const calls = {};
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING }, boolFlags: { delete: true },
      found: { ok: true, cloud: true, rows: [{ id: 'spec-9', specPath: GONE_SPEC }] },
      del: { ok: true, cloud: true, specId: 'spec-9', specPath: GONE_SPEC },
      calls,
    }));
    assert.equal(out.ok, true);
    assert.equal(out.deleted, true);
    assert.equal(out.repointed, false);
    assert.deepEqual(calls.delete, ['repo-1', 'spec-9']);
    assert.match(out.note, /unlocked_fixes/);
  });

  it('--delete alongside --test is refused — two different outcomes for the finding', async () => {
    const calls = {};
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING, test: REAL_SPEC }, boolFlags: { delete: true }, calls,
    }));
    assert.equal(out.ok, false);
    assert.equal(calls.delete, undefined);
    assert.equal(calls.repoint, undefined);
  });

  it('a write that matched no row is a FAILURE, never a success', async () => {
    // Postgres reports success for an UPDATE that affected nothing.
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING, test: REAL_SPEC, description: 'why' },
      found: { ok: true, cloud: true, rows: [{ id: 'spec-1', specPath: GONE_SPEC }] },
      repoint: { ok: false, cloud: true, reason: 'write-failed', message: 'the UPDATE matched nothing' },
    }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'write-failed');
  });

  it('cloud-off degrades without claiming anything happened', async () => {
    const out = await repointRegressionSpecCmd(makeRepointCtx({ cloud: false, flags: { finding: FINDING } }));
    assert.equal(out.repointed, false);
    assert.equal(out.deleted, false);
  });
});
