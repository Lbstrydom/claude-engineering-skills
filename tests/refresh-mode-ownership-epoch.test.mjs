/**
 * @fileoverview The ownership-epoch promotion, and the reachability the original
 * design got wrong.
 *
 * Plan: docs/plans/incremental-refresh-ownership-propagation.md (Cluster B).
 *
 * WHY THIS SUITE IS NOT DB-GATED. `tests/refresh-modes.test.mjs` needs a
 * disposable Postgres and SKIPS without one — and node reports a never-run suite
 * as a clean pass. The defect this cluster fixes was a REACHABILITY bug
 * (`else if (epochChanged)` chained after anchor resolution, unreachable on every
 * ordinary `arch:refresh`), and the thing that hid it was precisely that every
 * predicate test passed. So the decision is a pure function and is asserted here,
 * with no database in the way; the persistence half lives in
 * `tests/refresh-ownership-epoch-db.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideRefreshMode, ownershipEpochRequiresFullWalk, provenanceRequiresFullReembed,
} from '../scripts/symbol-index/refresh-mode.mjs';

const EPOCH = 'ignored-untracked-v1';
const NEXT = 'ignored-untracked-v2';

/** A prior snapshot that is compatible on every axis unless overridden. */
const prior = (over = {}) => ({
  refreshId: 'r1',
  activeEmbeddingModel: 'prov-1',
  ownershipRuleEpoch: EPOCH,
  ...over,
});

const decide = (over = {}) => decideRefreshMode({
  prior: prior(),
  anchorMissing: false,
  provenanceId: 'prov-1',
  ownershipRuleEpoch: EPOCH,
  ...over,
});

// ── the predicate ───────────────────────────────────────────────────────────

test('a changed epoch promotes; an equal one does not', () => {
  assert.equal(ownershipEpochRequiresFullWalk(prior(), NEXT), true);
  assert.equal(ownershipEpochRequiresFullWalk(prior(), EPOCH), false,
    'an unchanged epoch must stay incremental — without this a predicate that '
    + 'always returns true would pass every other assertion here');
});

test('a NULL prior epoch DOES promote — unlike the provenance guard', () => {
  // The whole point of §3.6. `provenanceRequiresFullReembed` deliberately does
  // NOT fire on a null prior; copying that here would let a consumer who skips
  // the epoch-introducing release suppress promotion forever, publish the
  // current epoch, and keep every file the old index never had missing — with no
  // mismatch left for any later run to notice.
  assert.equal(ownershipEpochRequiresFullWalk(prior({ ownershipRuleEpoch: null }), EPOCH), true);
  assert.equal(ownershipEpochRequiresFullWalk(prior({ ownershipRuleEpoch: undefined }), EPOCH), true);

  // Contrast, asserted so the asymmetry is deliberate rather than accidental:
  assert.equal(provenanceRequiresFullReembed({ activeEmbeddingModel: null }, 'prov-1'), false);
});

test('no prior snapshot at all is the anchor path, not the epoch path', () => {
  // A first-ever refresh has no prior. Promoting here would be right by
  // accident; the anchor rule already owns it, and this pins that the epoch
  // predicate does not double-report a condition it does not own.
  assert.equal(ownershipEpochRequiresFullWalk(null, EPOCH), false);
  assert.equal(ownershipEpochRequiresFullWalk(undefined, EPOCH), false);
});

// ── reachability: the bug the Gemini plan gate caught ───────────────────────

test('the epoch is a trigger in its own right, not a link in the anchor chain', () => {
  // THE regression test. The original design chained the epoch check as a third
  // `else if` after anchor resolution. `refresh.mjs` sets
  // `sinceCommit = args.sinceCommit`, undefined on a plain `arch:refresh`, so
  // anchor resolution always ran and terminated the chain — the epoch branch was
  // dead code on exactly the path it existed for.
  //
  // `anchorMissing: false` is the state the orchestrator reaches after a
  // SUCCESSFUL anchor resolution — the ordinary case, where the run had no
  // `--since-commit`, looked one up and found it. Under the old chain that
  // state had already consumed the branch, so the epoch could never be reached
  // from it.
  //
  // NAMING NOTE (cluster-B audit R1): this asserts the DECISION, not the
  // orchestration — it does not itself resolve an anchor, and an earlier name
  // implied it did. The orchestration half (that `finalizeRefreshMode` actually
  // reaches this state, and that provenance still short-circuits ahead of the
  // anchor lookup) is covered against a real Postgres by
  // tests/refresh-provenance-promotion.test.mjs and
  // tests/refresh-ownership-epoch-db.test.mjs.
  const d = decide({ anchorMissing: false, ownershipRuleEpoch: NEXT });
  assert.equal(d.mode, 'full');
  assert.equal(d.reason, 'ownership-epoch');
});

test('an unchanged epoch with a resolved anchor stays incremental', () => {
  // The negative control for the test above: without it, an implementation that
  // promoted unconditionally would pass.
  const d = decide();
  assert.equal(d.mode, 'incremental');
  assert.equal(d.reason, null);
});

// ── precedence: previously guaranteed only by a comment ─────────────────────

test('when several triggers hold, provenance is reported first, then anchor, then epoch', () => {
  // The exact ordering a documented prior incident (Gemini-r2-G3) pinned in
  // prose. Restructuring the chain is precisely the change that could silently
  // reorder it, so it is asserted rather than commented.
  assert.equal(decide({
    provenanceId: 'prov-2', anchorMissing: true, ownershipRuleEpoch: NEXT,
  }).reason, 'provenance', 'provenance outranks everything');

  assert.equal(decide({
    anchorMissing: true, ownershipRuleEpoch: NEXT,
  }).reason, 'no-anchor', 'a missing anchor outranks the epoch');

  assert.equal(decide({
    ownershipRuleEpoch: NEXT,
  }).reason, 'ownership-epoch', 'the epoch fires when it is the only trigger');
});

test('every trigger independently produces a full walk', () => {
  // Guards against an implementation that ANDs conditions — which the
  // precedence test alone would not catch.
  for (const [label, over] of [
    ['provenance', { provenanceId: 'prov-2' }],
    ['no-anchor', { anchorMissing: true }],
    ['epoch', { ownershipRuleEpoch: NEXT }],
  ]) {
    assert.equal(decide(over).mode, 'full', `${label} alone must promote`);
  }
});

test('an absent epoch argument disables the epoch trigger without disabling the others', () => {
  // A caller that does not supply an epoch (an older call site, or a test) must
  // not get a spurious promotion — but must still get the other two.
  assert.equal(decide({ ownershipRuleEpoch: null, prior: prior({ ownershipRuleEpoch: 'anything' }) }).mode,
    'incremental', 'no epoch supplied ⇒ no epoch-driven promotion');
  assert.equal(decide({ ownershipRuleEpoch: null, anchorMissing: true }).mode, 'full');
});
