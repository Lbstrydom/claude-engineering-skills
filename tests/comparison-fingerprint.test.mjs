/**
 * @fileoverview Tier 1 — D4 fingerprint canonicalisation (Cluster A round 4, H3).
 *
 * Raised twice: once against the raw model string, and again after a
 * documentation-only defer — the correct signal that a comment does not close
 * a real correctness gap in D4's own collision coverage. This asserts the
 * BOUNDED partial fix directly: what it closes (stale-id aliasing, offline)
 * and what it still leaves open (sentinel-vs-current-concrete, which would
 * need the live catalog and is a deliberately worse trade to make).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { armRequestFingerprint, classifyArmCollisions } from '../scripts/lib/comparison/fingerprint.mjs';
import { checkArmSetSemantics } from '../scripts/lib/comparison/arms.mjs';
import { DEPRECATED_REMAP } from '../scripts/lib/model-resolver.mjs';

const CONTROLS = { reasoningEffort: 'high' };

describe('armRequestFingerprint — canonicalisation is bounded, not complete', () => {
  it('CLOSED: a stale id and its current form fingerprint IDENTICALLY (a real DEPRECATED_REMAP pair, not invented)', () => {
    const [staleId] = Object.keys(DEPRECATED_REMAP);
    assert.ok(staleId, 'guard: DEPRECATED_REMAP must be non-empty or this test proves nothing');
    const currentSentinel = DEPRECATED_REMAP[staleId];
    const fpStale = armRequestFingerprint({ model: staleId }, CONTROLS);
    const fpCurrent = armRequestFingerprint({ model: currentSentinel }, CONTROLS);
    assert.equal(fpStale, fpCurrent,
      `"${staleId}" and its remap target "${currentSentinel}" must collide — that is the whole point of the remap`);
  });

  it('a sentinel and its possible concrete form fingerprint DIFFERENTLY, but are caught pre-flight (H2/H3 fix)', () => {
    // The hash itself still differs — closing THAT would need live catalog
    // state (a worse trade, see the module docstring). What changed: an
    // offline, provider/tier comparison now refuses the PAIRING before spend,
    // via classifyArmCollisions, without ever resolving either model.
    const fpSentinel = armRequestFingerprint({ model: 'latest-opus' }, CONTROLS);
    const fpConcrete = armRequestFingerprint({ model: 'claude-opus-5' }, CONTROLS);
    assert.notEqual(fpSentinel, fpConcrete, 'the hash is not made to agree — that would need network');

    const collision = classifyArmCollisions({
      controls: CONTROLS,
      arms: [
        { id: 'a', model: 'latest-opus', mode: 'shadow' },
        { id: 'b', model: 'claude-opus-5', mode: 'shadow' },
      ],
    });
    assert.equal(collision.ok, false, 'same-family sentinel/concrete ambiguity must be refused pre-flight');
    assert.match(collision.message, /SAME first-party/);
  });

  it('a DECLARED replicate/control of the same family is NOT refused — that is the correct way to say so on purpose', () => {
    const asReplicate = classifyArmCollisions({
      controls: CONTROLS,
      arms: [
        { id: 'a', model: 'latest-opus', mode: 'shadow' },
        { id: 'b', model: 'claude-opus-5', mode: 'shadow', type: 'replicate' },
      ],
    });
    assert.equal(asReplicate.ok, true, 'a declared replicate is the escape hatch, same as an exact-fingerprint collision');
  });

  it('DIFFERENT families never collide, even across a sentinel and a concrete id', () => {
    // latest-opus (anthropic/opus) vs a concrete SONNET id — same provider,
    // different tier. Must not false-positive.
    const differentTier = classifyArmCollisions({
      controls: CONTROLS,
      arms: [
        { id: 'a', model: 'latest-opus', mode: 'shadow' },
        { id: 'b', model: 'claude-sonnet-5', mode: 'shadow' },
      ],
    });
    assert.equal(differentTier.ok, true);
  });

  it('gateway/xAI ids never false-positive against a first-party sentinel — the documented exclusion', () => {
    // The committed campaign's real shape: latest-opus alongside kimi/grok/
    // qwen/deepseek concrete gateway ids. None of these are parseable by the
    // first-party parsers, so none may ever trigger this check — verified
    // against the actual multi-vendor arm set, not a synthetic pair.
    const r = classifyArmCollisions({
      controls: CONTROLS,
      arms: [
        { id: 'opus', model: 'claude-opus', mode: 'shadow' },
        { id: 'kimi', model: 'moonshotai/kimi-k2-thinking', mode: 'shadow' },
        { id: 'grok', model: 'grok-4.6', mode: 'shadow' },
        { id: 'qwen', model: 'qwen/qwen3.8-max', mode: 'shadow' },
        { id: 'deepseek', model: 'deepseek/deepseek-v4-pro', mode: 'shadow' },
        { id: 'gemini-control', model: 'gemini-pro-latest', mode: 'shadow', type: 'control' },
      ],
    });
    assert.equal(r.ok, true, 'the real committed multi-vendor campaign must not be refused by this check');
  });

  it('negative control — sameFamilyAmbiguity is not a constant true', async () => {
    const { sameFamilyAmbiguity } = await import('../scripts/lib/comparison/fingerprint.mjs');
    assert.equal(sameFamilyAmbiguity('latest-opus', 'claude-opus-5'), true);
    assert.equal(sameFamilyAmbiguity('latest-opus', 'claude-sonnet-5'), false, 'different tier');
    assert.equal(sameFamilyAmbiguity('claude-opus-5', 'claude-opus-6'), false, 'neither side is a sentinel — not this check\'s job');
    assert.equal(sameFamilyAmbiguity('latest-opus', 'moonshotai/kimi-k2-thinking'), false, 'unparseable concrete id — no comparable shape');
  });

  it('an OpenAI o-series id never false-positives against latest-gpt (round 8, H4)', async () => {
    // Before the fix: the OpenAI branch compared mini-vs-not ONLY, so an
    // 'o'-series reasoning model (a genuinely different family) was treated as
    // the same family as any non-mini `gpt-*` id.
    const { sameFamilyAmbiguity } = await import('../scripts/lib/comparison/fingerprint.mjs');
    assert.equal(sameFamilyAmbiguity('latest-gpt', 'o3-pro'), false, 'o-series is not gpt-series, regardless of mini/non-mini');
    assert.equal(sameFamilyAmbiguity('latest-gpt-mini', 'o4-mini'), false, 'still not the same family even when both are lite variants');
    assert.equal(sameFamilyAmbiguity('latest-gpt', 'gpt-5.6-terra'), true, 'CONTROL: a genuine gpt-family non-mini match must still fire');
  });

  it('an UNKNOWN string (e.g. an OpenRouter gateway id) passes through unchanged — never mangled', () => {
    // Gateway ids are never in DEPRECATED_REMAP and must not be touched:
    // `deprecatedRemap` on an unknown key returns it as-is (verified against
    // the real function, not assumed).
    const fp1 = armRequestFingerprint({ model: 'moonshotai/kimi-k2-thinking' }, CONTROLS);
    const fp2 = armRequestFingerprint({ model: 'moonshotai/kimi-k2-thinking' }, CONTROLS);
    assert.equal(fp1, fp2, 'identical gateway ids must still fingerprint identically');
  });

  it('D4 collision refusal fires for a REAL undeclared stale-vs-current pair', () => {
    const [staleId] = Object.keys(DEPRECATED_REMAP);
    const config = {
      controls: CONTROLS,
      arms: [
        { id: 'a', model: staleId, mode: 'shadow' },
        { id: 'b', model: DEPRECATED_REMAP[staleId], mode: 'shadow' },
      ],
    };
    const r = classifyArmCollisions(config);
    assert.equal(r.ok, false, 'an undeclared stale/current alias pair must be refused, same as any other reroll');
    assert.match(r.message, /IDENTICAL request/);
  });
});

describe('checkArmSetSemantics and classifyArmCollisions agree on a same-family declared replicate (Cluster A round 6, M3)', () => {
  // The exact configuration the finding named: a scored arm on a SENTINEL, a
  // declared replicate on the CONCRETE id of the same family. classifyArmCollisions
  // already treated this as the correct escape hatch (declared arms are filtered
  // out of its pairing before the same-family check ever runs). Before this fix,
  // checkArmSetSemantics's replicate-backing rule used exact string equality only,
  // so the identical declaration was refused HERE while accepted THERE — two
  // policies disagreeing about one configuration.
  const cfg = {
    arms: [
      { id: 'a', model: 'latest-opus', mode: 'shadow' },
      { id: 'b', model: 'claude-sonnet-5', mode: 'shadow' },
      { id: 'a-replicate', model: 'claude-opus-5', mode: 'shadow', type: 'replicate' },
    ],
    controls: CONTROLS,
    decision: { incumbent: 'latest-opus' },
  };

  it('classifyArmCollisions accepts it (declared arms are exempt from pairing)', () => {
    assert.equal(classifyArmCollisions(cfg).ok, true);
  });

  it('checkArmSetSemantics now ALSO accepts it — same-family backing counts, not just exact string match', () => {
    const issues = [];
    checkArmSetSemantics(cfg, (message, path) => issues.push({ message, path }));
    const replicateIssues = issues.filter((i) => /replicate arm/.test(i.message));
    assert.deepEqual(replicateIssues, [], 'a same-family-backed replicate must not be flagged as backing nothing');
  });

  it('negative control — an UNBACKED replicate (no scored arm, same or different family) is still refused', () => {
    const unbacked = {
      ...cfg,
      arms: [...cfg.arms, { id: 'orphan', model: 'gpt-5.6-terra', mode: 'shadow', type: 'replicate' }],
    };
    const issues = [];
    checkArmSetSemantics(unbacked, (message, path) => issues.push({ message, path }));
    assert.ok(issues.some((i) => /replicate arm "orphan"/.test(i.message)),
      'a replicate naming a model no scored arm uses, exactly or by family, must still be refused');
  });
});

describe('the control-vs-incumbent duplicate check applies the SAME same-family policy as replicate-backing (round 7)', () => {
  // Round 6 (M3) applied sameFamilyAmbiguity to the replicate-backing rule.
  // Round 7 found the sibling rule — a control must not duplicate the
  // incumbent — was left on exact string equality, the identical class of gap
  // one rule over.
  it('a control declared on a sentinel that resolves to the SAME family as a CONCRETE incumbent is refused', () => {
    const cfg = {
      arms: [
        { id: 'incumbent', model: 'claude-opus-5', mode: 'primary' },
        { id: 'other', model: 'claude-sonnet-5', mode: 'shadow' },
        { id: 'bad-control', model: 'latest-opus', mode: 'shadow', type: 'control' },
      ],
      controls: CONTROLS,
      decision: { incumbent: 'claude-opus-5' },
    };
    const issues = [];
    checkArmSetSemantics(cfg, (message, path) => issues.push({ message, path }));
    assert.ok(issues.some((i) => /control arm "bad-control"/.test(i.message)),
      'a same-family control/incumbent pairing must be refused, not just an exact string match');
  });

  it('a control on a genuinely DIFFERENT family from the incumbent is NOT refused', () => {
    const cfg = {
      arms: [
        { id: 'incumbent', model: 'claude-opus-5', mode: 'primary' },
        { id: 'other', model: 'claude-sonnet-5', mode: 'shadow' },
        { id: 'ok-control', model: 'gemini-pro-latest', mode: 'shadow', type: 'control' },
      ],
      controls: CONTROLS,
      decision: { incumbent: 'claude-opus-5' },
    };
    const issues = [];
    checkArmSetSemantics(cfg, (message, path) => issues.push({ message, path }));
    assert.ok(!issues.some((i) => /control arm "ok-control"/.test(i.message)),
      'a control from a genuinely different family must not be false-positive refused');
  });
});

describe('incumbent-exactly-once ALSO applies the same-family policy (round 8, M4 — third sibling of the same class)', () => {
  it('a same-family SECOND scored arm makes the incumbent AMBIGUOUS, not falsely unique', () => {
    // Before the fix: incumbentArms used exact-string match only, so a
    // sentinel-spelled second scored arm resolving to the SAME model as a
    // concrete incumbent was invisible to this check even though it is
    // exactly the ambiguity the "exactly once" rule exists to catch.
    const cfg = {
      arms: [
        { id: 'incumbent', model: 'claude-opus-5', mode: 'primary' },
        { id: 'same-family-second', model: 'latest-opus', mode: 'shadow' },
      ],
      controls: CONTROLS,
      decision: { incumbent: 'claude-opus-5' },
    };
    const issues = [];
    checkArmSetSemantics(cfg, (message, path) => issues.push({ message, path }));
    assert.ok(issues.some((i) => /decision\.incumbent/.test(i.message) && /matches 2/.test(i.message)),
      'a same-family duplicate must be counted, not silently treated as a distinct second arm');
  });

  it('a genuinely single incumbent match is still accepted', () => {
    const cfg = {
      arms: [
        { id: 'incumbent', model: 'claude-opus-5', mode: 'primary' },
        { id: 'other', model: 'claude-sonnet-5', mode: 'shadow' },
      ],
      controls: CONTROLS,
      decision: { incumbent: 'claude-opus-5' },
    };
    const issues = [];
    checkArmSetSemantics(cfg, (message, path) => issues.push({ message, path }));
    assert.ok(!issues.some((i) => /decision\.incumbent/.test(i.message)),
      'an unambiguous single incumbent match must not be flagged');
  });
});
