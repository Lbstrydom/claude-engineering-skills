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

/**
 * The request fingerprint, computed PRE-FLIGHT.
 *
 * Over `{model, controls}` and deliberately NOT `mode`: two arms differing only
 * in shadow-vs-primary send the *same request*.
 *
 * @param {{model: string}} arm
 * @param {object} controls - the campaign-level shared dials
 * @returns {string} 16 hex chars
 */
export function armRequestFingerprint(arm, controls) {
  return crypto.createHash('sha256').update(canonicalJson({ model: arm.model, controls })).digest('hex').slice(0, 16);
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
  return { ok: true, fingerprints };
}
