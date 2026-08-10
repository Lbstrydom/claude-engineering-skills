import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CampaignConfigSchema, parseCampaignConfig, configDigest, canonicalJson,
  selectCampaignConfig, MIN_TARGET_N, ANALYSIS_TIME_FIELDS,
} from '../scripts/lib/campaign/config.mjs';

/** The committed dogfood campaign, used as the known-good base for mutations. */
const REAL = JSON.parse(fs.readFileSync('.campaigns/final-review-2026q3.json', 'utf-8'));
const base = () => JSON.parse(JSON.stringify(REAL));
const parses = (cfg) => CampaignConfigSchema.safeParse(cfg).success;
const errorOf = (cfg) => {
  const r = CampaignConfigSchema.safeParse(cfg);
  return r.success ? '' : r.error.issues.map((i) => i.message).join(' | ');
};

describe('campaign config — the committed campaign is valid', () => {
  it('the repo\'s own dogfood campaign parses', () => {
    // If this fails, `.campaigns/final-review-2026q3.json` and the schema have
    // drifted apart — which under .strict() means the runner cannot load it.
    const { config, configDigest: digest } = parseCampaignConfig(REAL);
    assert.equal(config.id, 'final-review-2026q3');
    assert.match(digest, /^[0-9a-f]{16}$/);
  });
});

describe('campaign config — strict, closed validation', () => {
  it('an unknown key is REJECTED, not ignored (a typo must not run at a default dial)', () => {
    const cfg = base();
    cfg.controls.reasoningEfort = 'high';           // the typo the lesson is named for
    assert.equal(parses(cfg), false);
    const stray = base();
    stray.unexpectedTopLevel = true;
    assert.equal(parses(stray), false);
  });

  it('rejects a campaign id that could escape its own path', () => {
    for (const bad of ['../evil', 'Has-Capitals', '-leading-dash', 'has/slash', '', 'a'.repeat(65)]) {
      const cfg = base(); cfg.id = bad;
      assert.equal(parses(cfg), false, `id "${bad}" must be rejected`);
    }
    const ok = base(); ok.id = 'a'.repeat(64);
    assert.equal(parses(ok), true, '64 chars is the documented maximum, not one less');
  });

  it('rejects an arm id that could escape its receipt filename', () => {
    for (const bad of ['../x', 'Up', 'has space', '']) {
      const cfg = base(); cfg.arms[0].id = bad;
      assert.equal(parses(cfg), false, `arm id "${bad}" must be rejected`);
    }
  });
});

describe('campaign config — semantic rules (§2.5a)', () => {
  it('targetN below the floor is rejected, and the floor is 12', () => {
    const cfg = base(); cfg.targetN = MIN_TARGET_N - 1;
    assert.equal(parses(cfg), false);
    assert.match(errorOf(cfg), /targetN/);
    const ok = base(); ok.targetN = MIN_TARGET_N;
    assert.equal(parses(ok), true);
  });

  it('calibration.sampleRate is bounded to [0.1, 1.0]', () => {
    for (const bad of [0, 0.09, 1.01, 2]) {
      const cfg = base(); cfg.calibration.sampleRate = bad;
      assert.equal(parses(cfg), false, `sampleRate ${bad} must be rejected`);
    }
    for (const good of [0.1, 0.5, 1.0]) {
      const cfg = base(); cfg.calibration.sampleRate = good;
      assert.equal(parses(cfg), true, `sampleRate ${good} must be accepted`);
    }
  });

  it('one arm is not a comparison — >= 2 non-replicate arms required', () => {
    const cfg = base();
    cfg.arms = [{ id: 'only', model: 'claude-opus', mode: 'shadow' }];
    cfg.decision.incumbent = 'claude-opus';
    assert.equal(parses(cfg), false);
    assert.match(errorOf(cfg), /non-replicate arms/);
  });

  it('replicates do NOT count toward the two-arm minimum', () => {
    // The trap: three arms, but two of them are the same scenario.
    const cfg = base();
    cfg.arms = [
      { id: 'a', model: 'claude-opus', mode: 'shadow' },
      { id: 'a2', model: 'claude-opus', mode: 'primary', type: 'replicate' },
    ];
    cfg.decision.incumbent = 'claude-opus';
    assert.equal(parses(cfg), false, 'one real arm plus its replicate is still one arm');
  });

  it('at most one primary arm', () => {
    const cfg = base();
    cfg.arms.push({ id: 'second-primary', model: 'claude-opus', mode: 'primary' });
    assert.equal(parses(cfg), false);
    assert.match(errorOf(cfg), /primary/);
  });

  it('duplicate arm ids are rejected — an arm id names a receipt and a store row', () => {
    const cfg = base();
    cfg.arms.push({ id: cfg.arms[0].id, model: 'claude-opus', mode: 'shadow' });
    assert.equal(parses(cfg), false);
    assert.match(errorOf(cfg), /duplicate arm id/);
  });

  it('a replicate of a model no real arm uses is a mislabelled scenario', () => {
    const cfg = base();
    cfg.arms.push({ id: 'ghost', model: 'some/model-nobody-runs', mode: 'shadow', type: 'replicate' });
    assert.equal(parses(cfg), false);
    assert.match(errorOf(cfg), /replicate of nothing|no non-replicate arm/);
  });

  it('the incumbent must name exactly one non-replicate arm\'s model', () => {
    const absent = base(); absent.decision.incumbent = 'not-an-arm-model';
    assert.equal(parses(absent), false);
    assert.match(errorOf(absent), /incumbent/);

    // Ambiguous: two distinct non-replicate arms on the same model.
    const ambiguous = base();
    ambiguous.arms.push({ id: 'opus-again', model: 'claude-opus', mode: 'shadow' });
    assert.equal(parses(ambiguous), false, 'an incumbent matching two arms is not identifiable');
    assert.match(errorOf(ambiguous), /unambiguous/);
  });

  it('a negative floorMargin is rejected — it would let a worse arm clear the floor', () => {
    const cfg = base(); cfg.decisionRule.floorMargin = -0.1;
    assert.equal(parses(cfg), false);
    const zero = base(); zero.decisionRule.floorMargin = 0;
    assert.equal(parses(zero), true, 'zero margin is permitted; negative is not');
  });
});

describe('campaign config — configDigest scope (§2.5b)', () => {
  it('is stable across key order and whitespace', () => {
    const a = parseCampaignConfig(base()).configDigest;
    const reordered = base();
    const flipped = { decisionRule: reordered.decisionRule, id: reordered.id, ...reordered };
    const b = parseCampaignConfig(flipped).configDigest;
    assert.equal(a, b, 'insertion order must not change identity');
  });

  it('CHANGES when a collection-relevant field changes', () => {
    const before = parseCampaignConfig(base()).configDigest;
    for (const mutate of [
      (c) => { c.controls.reasoningEffort = 'low'; },
      (c) => { c.controls.promptTemplateId = 'final-review-shadow@5'; },
      // the kimi arm, deliberately: it carries no replicate, so changing its
      // model is a pure collection-relevant edit rather than one that also
      // orphans a replicate and trips the semantic rule first.
      (c) => { c.arms[2].model = 'moonshotai/kimi-k2-0905'; },
      (c) => { c.arms.push({ id: 'extra', model: 'claude-sonnet', mode: 'shadow' }); },
      // `role` WAS mutated here. It still belongs to the digest subset, but D7's
      // one-value enum makes a legal role change unrepresentable in v1, so the
      // case can no longer be constructed — a mutation to an invalid value tests
      // the schema, not the digest. RESTORE this line the moment the enum gains
      // a second value; that is exactly when the digest's coverage of `role`
      // stops being untested-because-impossible.
      (c) => { c.decision.incumbent = 'moonshotai/kimi-k2-thinking'; },
    ]) {
      const cfg = base(); mutate(cfg);
      assert.notEqual(parseCampaignConfig(cfg).configDigest, before, 'a change to what is ASKED must orphan prior evidence');
    }
  });

  it('does NOT change when an analysis-time field changes — the load-bearing exemption', () => {
    // This is the defect the plan calls out one level up from the matcher one:
    // a whole-file digest would orphan every snapshot ever collected the moment
    // someone edited a cost ceiling, and §2.5c.6 schedules exactly those edits.
    const before = parseCampaignConfig(base()).configDigest;
    for (const mutate of [
      (c) => { c.targetN = 40; },
      (c) => { c.calibration.sampleRate = 1.0; },
      (c) => { c.decisionRule.costCeilingUsdPerAccepted = 99; },
      (c) => { c.decisionRule.floorMargin = 3; },
      (c) => { c.decisionRule.tiebreak = 'something-else'; },
    ]) {
      const cfg = base(); mutate(cfg);
      assert.equal(parseCampaignConfig(cfg).configDigest, before, 'editing how evidence is READ must not destroy it');
    }
    assert.deepEqual([...ANALYSIS_TIME_FIELDS], ['targetN', 'calibration', 'decisionRule']);
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every depth but preserves array order', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
    assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  });
  it('refuses a non-finite number rather than silently serialising it as null', () => {
    // JSON.stringify(NaN) is "null", so digesting it would give two different
    // configs the same identity without anyone seeing why.
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(() => canonicalJson({ v: bad }), /non-finite/);
    }
  });
});

describe('campaign config — selection (§807)', () => {
  const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-select-'));

  it('an absent directory is NOT an error — a repo may never run campaigns', () => {
    const r = selectCampaignConfig({ dir: path.join(mkdir(), 'nope') });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'none');
  });

  it('a single config is selected without --campaign', () => {
    const dir = mkdir();
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(base()));
    const r = selectCampaignConfig({ dir });
    assert.equal(r.ok, true);
    assert.equal(r.config.id, 'final-review-2026q3');
  });

  it('REFUSES on ambiguity and lists ids — never "pick the first"', () => {
    const dir = mkdir();
    const a = base(); a.id = 'alpha';
    const b = base(); b.id = 'beta';
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(a));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(b));
    const r = selectCampaignConfig({ dir });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ambiguous');
    assert.deepEqual(r.available, ['alpha', 'beta']);
    // and naming one resolves it
    assert.equal(selectCampaignConfig({ dir, campaignId: 'beta' }).config.id, 'beta');
  });

  it('an unknown --campaign id is a hard error naming what IS available', () => {
    const dir = mkdir();
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(base()));
    const r = selectCampaignConfig({ dir, campaignId: 'ghost' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unknown-id');
    assert.deepEqual(r.available, ['final-review-2026q3']);
  });
});

// ── D7: role is a ONE-VALUE enum ──────────────────────────────────────────

test('role is a closed enum, not an open string (D7)', () => {
  // v1 generalises role 3 only. An open string let a typo'd or invented role
  // parse into a campaign that collects happily under a role nothing
  // dispatches on — the seam exists to be widened deliberately, not by
  // accident.
  const base = JSON.parse(fs.readFileSync('.campaigns/final-review-2026q3.json', 'utf-8'));
  assert.doesNotThrow(() => parseCampaignConfig(base));
  for (const bogus of ['final_review', 'auditor', 'FINAL_REVIEW_SHADOW', '']) {
    assert.throws(() => parseCampaignConfig({ ...base, role: bogus }), `role "${bogus}" must be rejected`);
  }
});
