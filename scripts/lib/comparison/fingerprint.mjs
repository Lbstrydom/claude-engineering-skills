/**
 * @fileoverview D4 — request fingerprinting and pre-flight reroll refusal.
 * Role-agnostic.
 *
 * Moved from `bakeoff-collect.mjs` (2026-08-14) so the synchronous swap-eval
 * harness gets the same protection. Nothing here is collection-mode specific:
 * two arms that send the same request are one distribution sampled twice
 * whether the sampling is passive or synchronous.
 *
 * LESSON (c), which this exists to make unrepeatable: two arms in the original
 * hand-built table issued a BYTE-IDENTICAL request and differed only in
 * downstream bucketing. It took token-count archaeology across five result
 * files to discover — per snapshot, `opus` and `solo-opus` reported identical
 * input token counts to the byte (81,182 / 81,182; 192,998 / 192,998). A
 * reroll masquerading as a second scenario silently halves the apparent
 * evidence for one model while looking like two independent arms. Discovering
 * it after the spend means the aggregate was already wrong, so the check is
 * PRE-flight and the refusal is hard.
 *
 * Plan: docs/plans/role-agnostic-comparison-core.md D2.
 *
 * @module scripts/lib/comparison/fingerprint
 */

import crypto from 'node:crypto';
import { canonicalJson } from './lock.mjs';
import { isScoredArm } from './arms.mjs';
import { deprecatedRemap } from '../model-resolver.mjs';
import { sameFamilyAmbiguity } from './model-family.mjs';

/**
 * Re-exported for callers that historically imported it from here.
 * `sameFamilyAmbiguity` itself now lives in `model-family.mjs` — a LEAF module
 * with no dependency on `arms.mjs` — because `arms.mjs`'s own
 * `checkArmSetSemantics` needs the identical same-family test (Cluster A
 * round 6, M3) and importing this file from `arms.mjs` would be circular
 * (this file already imports `isScoredArm` FROM `arms.mjs`).
 */
export { sameFamilyAmbiguity };

/**
 * The request fingerprint, computed PRE-FLIGHT.
 *
 * Over `{model, controls}` and deliberately NOT `mode`: two arms differing only
 * in shadow-vs-primary send the *same request*.
 *
 * Canonicalises through `deprecatedRemap()` first — OFFLINE and deterministic,
 * a static lookup table, no network — closing the case where one arm uses a
 * STALE concrete id and another its current form. `{ silent: true }` because
 * this runs on every collection pre-flight, not an interactive resolution.
 *
 * A sentinel (`latest-opus`) vs the concrete id it might currently resolve to
 * (`claude-opus-5`) is DELIBERATELY left un-collapsed at the hash level — that
 * would need the live catalog, and a fingerprint depending on mutable remote
 * state is a WORSE failure than the reroll D4 exists to catch (a catalog
 * refresh would silently split one cohort into two). That pairing is instead
 * refused pre-flight, offline, by `sameFamilyAmbiguity()` (`model-family.mjs`) +
 * `classifyArmCollisions()` below — closed at the point it matters (before
 * spend) without making the hash itself network-dependent. Cluster A raised
 * this gap as HIGH three times before it closed this way: round 4 against the
 * raw string, again after a documentation-only defer (a comment does not
 * close a correctness gap), and round 5 after the `deprecatedRemap`-only
 * narrowing still left the sentinel/concrete pair undetected.
 *
 * @param {{model: string}} arm
 * @param {object} controls - the campaign-level shared dials
 * @returns {string} 16 hex chars
 */
export function armRequestFingerprint(arm, controls) {
  const canonicalModel = deprecatedRemap(arm.model, { silent: true });
  return crypto.createHash('sha256').update(canonicalJson({ model: canonicalModel, controls })).digest('hex').slice(0, 16);
}

/**
 * Colliding arms are classified BEFORE spend, never discovered after.
 *
 * Two arms with the same fingerprint are a hard refusal unless the collision is
 * *declared*: at most one arm per fingerprint may be undeclared, the rest must
 * carry `type: "replicate"` or `type: "control"`. Both declarations say "this
 * duplicate request is deliberate" — the refusal exists to catch an UNdeclared
 * collision, not to privilege one keyword. The escape is not a loophole: a
 * deliberate replicate is a valuable within-model variance reading.
 *
 * @param {{arms: object[], controls: object}} config
 * @returns {{ok: true, fingerprints: Record<string,string>} | {ok: false, message: string}}
 */
export function classifyArmCollisions(config) {
  const arms = config.arms;
  const fingerprints = {};
  const byFingerprint = new Map();
  for (const arm of arms) {
    const fp = armRequestFingerprint(arm, config.controls);
    fingerprints[arm.id] = fp;
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
    byFingerprint.get(fp).push(arm);
  }
  for (const [fp, group] of byFingerprint) {
    if (group.length < 2) continue;
    const undeclared = group.filter(isScoredArm);
    if (undeclared.length > 1) {
      return {
        ok: false,
        message: `[bakeoff] D4: arms ${undeclared.map((a) => `"${a.id}"`).join(', ')} send an IDENTICAL request (fingerprint ${fp}) but none is declared type:"replicate". `
          + 'Two arms sampling one distribution are a reroll, not a comparison — declare the duplicate as a replicate, or make the requests differ. '
          + 'Refusing before spend: discovering this afterwards means the aggregate was already wrong.',
      };
    }
  }

  // SAME-FAMILY AMBIGUITY (Cluster A round 5, H2/H3): a sentinel and a
  // concrete id can be the SAME model under different spellings and still
  // fingerprint differently — that is fingerprinting's documented residual
  // gap. Where it IS provable offline (anthropic/google/openai), refuse
  // rather than silently allow, same escape hatch as an exact-fingerprint
  // collision: two UNDECLARED scored arms in the same family is a refusal,
  // but a declared `replicate`/`control` is exactly the right way to say
  // "yes, this is deliberately the same model."
  const scored = arms.filter(isScoredArm);
  for (let i = 0; i < scored.length; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const [a, b] = [scored[i], scored[j]];
      if (sameFamilyAmbiguity(a.model, b.model)) {
        return {
          ok: false,
          message: `[bakeoff] D4: arms "${a.id}" (${a.model}) and "${b.id}" (${b.model}) name the SAME first-party `
            + 'model family via a sentinel and a concrete id — they may resolve to the identical model under '
            + 'different spellings, which is the reroll D4 exists to catch. Declare the duplicate as a replicate/'
            + 'control, or make them provably different models. Refusing before spend.',
        };
      }
    }
  }

  return { ok: true, fingerprints };
}
