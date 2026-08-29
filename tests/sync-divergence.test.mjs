/**
 * @fileoverview Guards the consumer-divergence gate — the half of the sync's
 * ownership model added after upstream report `5b1a121e`.
 *
 * Tier 1 (test-first, deterministic module) per the testing doctrine, and Tier
 * 3-adjacent in spirit: this contract ships to repos we cannot observe, and its
 * failure mode is SILENT destruction of committed work.
 *
 * The direction that matters most here is the one a green suite cannot show you:
 * a gate that never fires reads exactly like a gate with nothing to catch. So
 * every REFUSE case has a paired WRITE case proving the guard is not simply
 * always-on, and vice versa — the `feedback_test_the_direction_the_gate_must_
 * NOT_fire` rule.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_STATE, ACTION, classifyAgainstBase, decideAction, describeReason,
} from '../scripts/lib/sync-divergence.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('classifyAgainstBase', () => {
  test('same bytes as the recorded base ⇒ pristine', () => {
    assert.equal(
      classifyAgainstBase({ baseHash: `sha256:${HASH_A}`, diskHash: HASH_A }),
      BASE_STATE.PRISTINE,
    );
  });

  test('different bytes ⇒ diverged', () => {
    assert.equal(
      classifyAgainstBase({ baseHash: `sha256:${HASH_A}`, diskHash: HASH_B }),
      BASE_STATE.DIVERGED,
    );
  });

  test('the sha256: prefix is tolerated on either side, or neither', () => {
    const all = [
      classifyAgainstBase({ baseHash: HASH_A, diskHash: HASH_A }),
      classifyAgainstBase({ baseHash: `sha256:${HASH_A}`, diskHash: `sha256:${HASH_A}` }),
      classifyAgainstBase({ baseHash: HASH_A, diskHash: `sha256:${HASH_A}` }),
    ];
    assert.deepEqual(all, [BASE_STATE.PRISTINE, BASE_STATE.PRISTINE, BASE_STATE.PRISTINE]);
  });

  test('a missing base is NO_BASE, never PRISTINE', () => {
    // Absence of a record must never read as "unchanged" — that would license
    // an unconditional overwrite on exactly the runs where we know least.
    for (const baseHash of [undefined, null, '']) {
      assert.equal(classifyAgainstBase({ baseHash, diskHash: HASH_A }), BASE_STATE.NO_BASE);
    }
  });

  test('a missing disk hash is NO_BASE (the file is not there to destroy)', () => {
    assert.equal(classifyAgainstBase({ baseHash: HASH_A, diskHash: null }), BASE_STATE.NO_BASE);
  });
});

describe('decideAction — the direction the gate must NOT fire', () => {
  test('pristine writes, however far upstream has moved', () => {
    // The whole reason the base is the manifest and not HEAD: an ordinary
    // upstream update must not trip the guard, or it gets flagged away.
    const d = decideAction({
      baseState: BASE_STATE.PRISTINE,
      vcs: { tracked: true, matchesHead: true },
      overrideActive: false,
      allowOverwriteDiverged: false,
    });
    assert.equal(d.action, ACTION.WRITE);
  });

  test('a first sync (no base) writes', () => {
    const d = decideAction({
      baseState: BASE_STATE.NO_BASE, vcs: null,
      overrideActive: false, allowOverwriteDiverged: false,
    });
    assert.equal(d.action, ACTION.WRITE);
  });
});

describe('decideAction — the direction the gate MUST fire', () => {
  test('diverged + committed in the consumer ⇒ REFUSE', () => {
    // The 2026-08-29 incident, exactly: content in the consumer's own main,
    // reverted silently.
    const d = decideAction({
      baseState: BASE_STATE.DIVERGED,
      vcs: { tracked: true, matchesHead: true },
      overrideActive: false,
      allowOverwriteDiverged: false,
    });
    assert.equal(d.action, ACTION.REFUSE);
    assert.equal(d.reason, 'diverged-committed');
  });

  test('diverged + tracked with uncommitted edits ⇒ REFUSE', () => {
    const d = decideAction({
      baseState: BASE_STATE.DIVERGED,
      vcs: { tracked: true, matchesHead: false },
      overrideActive: false,
      allowOverwriteDiverged: false,
    });
    assert.equal(d.action, ACTION.REFUSE);
    assert.equal(d.reason, 'diverged-uncommitted');
  });

  test('diverged + git could not answer ⇒ REFUSE (fails CLOSED)', () => {
    const d = decideAction({
      baseState: BASE_STATE.DIVERGED,
      vcs: { tracked: null, matchesHead: null },
      overrideActive: false,
      allowOverwriteDiverged: false,
    });
    assert.equal(d.action, ACTION.REFUSE);
    assert.equal(d.reason, 'diverged-vcs-unknown');
  });

  test('a null vcs reading also refuses — no vcs answer is not a "no"', () => {
    const d = decideAction({
      baseState: BASE_STATE.DIVERGED, vcs: null,
      overrideActive: false, allowOverwriteDiverged: false,
    });
    assert.equal(d.action, ACTION.REFUSE);
  });
});

describe('decideAction — untracked divergence is loud, not fatal', () => {
  test('diverged + untracked ⇒ WRITE_LOUD', () => {
    // scripts/.claude-skills/** is gitignored in every consumer. A hand-edit
    // there is the governance violation the banner forbids, and the sanctioned
    // remedy IS the re-sync — so refusing would block the fix.
    const d = decideAction({
      baseState: BASE_STATE.DIVERGED,
      vcs: { tracked: false, matchesHead: null },
      overrideActive: false,
      allowOverwriteDiverged: false,
    });
    assert.equal(d.action, ACTION.WRITE_LOUD);
    assert.equal(d.reason, 'diverged-untracked');
  });
});

describe('decideAction — precedence', () => {
  test('an override outranks everything, including the overwrite flag', () => {
    const d = decideAction({
      baseState: BASE_STATE.DIVERGED,
      vcs: { tracked: true, matchesHead: true },
      overrideActive: true,
      allowOverwriteDiverged: true,
    });
    assert.equal(d.action, ACTION.HOLD);
  });

  test('--overwrite-diverged outranks the tracked test, and stays loud', () => {
    // An escape hatch that still refuses is not one. It must still announce
    // itself, which is why the action is WRITE_LOUD and never plain WRITE.
    const d = decideAction({
      baseState: BASE_STATE.DIVERGED,
      vcs: { tracked: true, matchesHead: true },
      overrideActive: false,
      allowOverwriteDiverged: true,
    });
    assert.equal(d.action, ACTION.WRITE_LOUD);
    assert.equal(d.reason, 'diverged-overwrite-flag');
  });

  test('the flag does not make a PRISTINE write loud', () => {
    const d = decideAction({
      baseState: BASE_STATE.PRISTINE, vcs: null,
      overrideActive: false, allowOverwriteDiverged: true,
    });
    assert.equal(d.action, ACTION.WRITE);
  });
});

describe('describeReason', () => {
  test('every reason the decision table can emit has prose', () => {
    // Derived from the table rather than listed, so a new reason cannot ship
    // without a message — the reader of a REFUSE line has nothing else.
    const reasons = new Set();
    for (const baseState of Object.values(BASE_STATE)) {
      for (const vcs of [null, { tracked: true, matchesHead: true },
        { tracked: true, matchesHead: false }, { tracked: false, matchesHead: null },
        { tracked: null, matchesHead: null }]) {
        for (const overrideActive of [true, false]) {
          for (const allowOverwriteDiverged of [true, false]) {
            reasons.add(decideAction({
              baseState, vcs, overrideActive, allowOverwriteDiverged,
            }).reason);
          }
        }
      }
    }
    for (const r of reasons) {
      // A reason with no case falls through to `default: return reason` and so
      // renders as its own machine slug — which is the failure, not the pass.
      assert.notEqual(describeReason(r), r, `no operator prose for reason "${r}"`);
    }
  });
});
