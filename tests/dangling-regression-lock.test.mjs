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
 * **The read side is the primary instrument, and the upstream evidence is why.** Measured
 * here the day of the fix: 3 of 235 rows cite a path that no longer resolves — all three
 * `source_kind: 'unit-test'`, i.e. written by `lock-with-test`, which ALREADY validates
 * existence, and all three deleted by one commit (`e833b2aa`, "retire the consistency
 * candidate promotion path"). They were TRUE when recorded and were invalidated later by
 * a legitimate refactor, so a write-time check would have caught zero of them. The
 * reporter's three were the opposite case (tests on unmerged branches). A citation's
 * truth is not a property of the moment it was written.
 *
 * @module tests/dangling-regression-lock
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { listUnlockedFixesCmd, recordRegressionSpecCmd } from '../scripts/lib/cross-skill/commands/ship.mjs';
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

  it('a spec_path naming a DIRECTORY is dangling — existsSync alone would accept it', async () => {
    // The INC-001 class the shared oracle already handles: `classifyTestPath` requires a
    // regular file, so a lock naming `tests/` cannot read as evidence.
    const out = await listUnlockedFixesCmd(makeCtx({
      recorded: [{ specPath: 'tests', sourceKind: 'unit-test', sourceFindingId: 'f1', createdAt: null }],
    }));
    assert.equal(out.danglingLocks.count, 1, 'a directory is not a test file');
  });
});

describe('record-regression-spec does NOT probe the filesystem — and that is the decision', () => {
  // A REVERSAL of this change's own first attempt, pinned so it is not silently redone.
  // I added a write-time existence check as a "cheap second line". It broke two existing
  // contracts — the golden-envelope capture (a cloud-off call started REFUSING on a
  // filesystem probe where it used to degrade) and the write-outcome fixture (a synthetic
  // `tests/x.spec.ts`, testing exit codes rather than paths). Repairing those two guards
  // to fit the new check would have been fitting the tests to the change.
  //
  // And it earns little: upstream b2c9a63f measured 3 of 3 dangling citations that were
  // TRUE when written and were invalidated later by a refactor, so a write-time probe
  // catches none of the real population — only a typo, which the read-side report above
  // surfaces one ship later anyway.

  it('accepts a path that does not resolve — the programmatic recorder stays permissive', async () => {
    const ctx = makeCtx({ payload: { sourceKind: 'unit-test', description: 'pins a thing', specPath: GONE_SPEC } });
    const out = await recordRegressionSpecCmd(ctx);
    assert.equal(out.ok, true, 'tooling may legitimately record the intent before the file is saved');
  });

  it('still refuses an ABSENT specPath — presence was always the contract here', async () => {
    const ctx = makeCtx({ payload: { sourceKind: 'unit-test', description: 'pins a thing' } });
    await assert.rejects(() => recordRegressionSpecCmd(ctx), /specPath is required/);
  });

  it('cloud-off degrades rather than probing anything — the regression that was caught', async () => {
    // The specific break: a check placed before this early return turned a supported mode
    // into a refusal. Cloud-off writes nothing, so there is nothing for a probe to protect.
    const ctx = makeCtx({ cloud: false, payload: { sourceKind: 'unit-test', description: 'x', specPath: GONE_SPEC } });
    const out = await recordRegressionSpecCmd(ctx);
    assert.equal(out.ok, true);
    assert.equal(out.cloud, false);
  });

  it('lock-with-test KEEPS its own existence check — the two verbs differ on purpose', async () => {
    // The interactive verb a human aims at one finding, where refusing a typo immediately
    // is worth the friction. Asserted on the source so the asymmetry is deliberate rather
    // than an accident nobody noticed.
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/lib/cross-skill/commands/ship.mjs'), 'utf-8');
    const lockFn = src.slice(src.indexOf('export async function lockWithTestCmd'));
    assert.match(lockFn.slice(0, 4000), /classifyTestPath/,
      'lock-with-test must keep refusing a citation it cannot resolve');
  });
});
