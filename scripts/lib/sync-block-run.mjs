/**
 * @fileoverview One sync target's block-hold bookkeeping, so the CLI's write
 * loop carries one call per decision point instead of the logic itself
 * (`sync-to-repos.mjs` is size-ratcheted and may not grow).
 *
 * Owns, per target: the loaded fragments, which declared paths reached the
 * renderer, which blocks LANDED (written or already on disk), every block
 * error, and the anchor-moved comparison against the committed receipt. The
 * decisions themselves stay where they are tested: grammar and splice in
 * `sync-slots.mjs`, declaration checks in `sync-overrides.mjs`, adoption in
 * `sync-divergence.mjs`. Source-side only: never shipped to a consumer.
 *
 * Plan: docs/plans/sync-skill-block-holds.md
 *
 * @module scripts/lib/sync-block-run
 */

import { loadBlockFragments, checkFragmentSources, reconcileBlockDestinations, OVERRIDES_PATH } from './sync-overrides.mjs';
import { adoptionState, assessBlockMigration, describeAdoptionFailure, BASE_STATE } from './sync-divergence.mjs';

/**
 * @param {object} a
 * @param {string} a.repoRoot
 * @param {{blocks: Array<object>}} a.overridesDoc — `loadOverrides` result, already error-free
 * @param {object[]} a.receiptEntries — `readSyncReceipt(...).entries`, newest first
 * @param {(root: string, rel: string) => object} a.read — `readConsumerFile`
 */
export function createBlockRun({ repoRoot, overridesDoc, receiptEntries, read }) {
  const declared = overridesDoc.blocks || [];
  const { byDest, errors } = declared.length ? loadBlockFragments(repoRoot, declared, read) : { byDest: new Map(), errors: [] };
  const declaredPaths = new Set(declared.map((b) => b.path));
  const rendered = new Set();
  const applied = [];
  const blockErrors = [];

  /** The newest receipt record of this (path, slot), or null. */
  function priorAnchor(p, slot) {
    for (const e of receiptEntries || []) {
      const hit = (e?.blocksApplied || []).find((b) => b?.path === p && b?.slot === slot);
      if (hit) return hit;
    }
    return null;
  }

  return {
    /** Declaration errors that abort the target (unreadable, empty or marker-carrying fragments). */
    errors,
    /** Asked once the inventory is known: a fragment may never be a managed file. */
    checkSources: (managedDests) => checkFragmentSources(declared, managedDests),
    /** The fragments to splice into `dstRel`, for EVERY renderOutbound caller. */
    for: (dstRel) => byDest.get(dstRel) ?? [],
    /** Does a block declaration name this path? (GC holds a retired one rather than deleting it.) */
    isDeclared: (dstRel) => declaredPaths.has(dstRel),
    /** The render for a declared path ran (whatever happened next). */
    reached(dstRel) { if (declaredPaths.has(dstRel)) rendered.add(dstRel); },
    /** `[block <slot> +N chars]` for the upd line, or ''. */
    label(dstRel) {
      const f = byDest.get(dstRel);
      return f?.length ? ` [${f.map((x) => `block ${x.slot} +${x.content.length} chars`).join(', ')}]` : '';
    },

    /**
     * A SlotError failed this destination's render: record it and return the
     * operator lines. The file is NOT written; the caller counts the error.
     */
    renderFailed(dstRel, err) {
      rendered.add(dstRel);
      blockErrors.push({ path: dstRel, slot: err.slot ?? null, code: err.code });
      return [
        `    the consumer block was KEPT: ${dstRel} was not written, and its base carries forward.`,
        `    Report it upstream (node scripts/.claude-skills/cross-skill.mjs upstream report --affected-path ${dstRel}),`,
        `    or hold the whole file in ${OVERRIDES_PATH} until upstream restores the slot.`,
      ];
    },

    /**
     * The `blockAdoption` input `decideAction` takes, or null when no adoption
     * question arises (no declaration, not diverged, or held).
     */
    adoption({ dstRel, baseState, override, vcs, diskBytes }) {
      const frags = byDest.get(dstRel);
      if (!frags?.length || override || baseState !== BASE_STATE.DIVERGED) return null;
      if (adoptionState(receiptEntries, dstRel, { hasBlocks: true, hasOverride: false }) !== 'pending') return null;
      const a = assessBlockMigration({
        diskBytes, fragments: frags, matchesHead: vcs?.matchesHead ?? null,
        adoptHeldFile: frags.find((f) => f.adoptHeldFile)?.adoptHeldFile ?? null,
      });
      return { pending: true, ...a };
    },

    /** One extra refusal line for a block-held path, or null. */
    refusalHint(dstRel, reason, adoption) {
      if (reason === 'block-hold-migration-blocked') return describeAdoptionFailure(adoption?.failed, adoption?.token);
      const f = byDest.get(dstRel);
      return f?.length ? `this file carries a block hold: edit ${f.map((x) => x.from).join(', ')}, not the synced copy` : null;
    },

    /**
     * The bytes on disk now carry these blocks (written, or unchanged): record
     * them, and return a warning for each slot upstream moved under another
     * heading since the last recorded run. Heading-level only, by design.
     */
    landed(dstRel, blocksApplied) {
      const frags = byDest.get(dstRel) ?? [];
      const warnings = [];
      for (const b of blocksApplied || []) {
        const prev = priorAnchor(dstRel, b.slot);
        const anchorMoved = !!prev && (prev.anchorHeading ?? null) !== (b.anchorHeading ?? null);
        if (anchorMoved) {
          warnings.push(`upstream moved slot ${b.slot} in ${dstRel} from under "${prev.anchorHeading ?? '(top)'}" to under "${b.anchorHeading ?? '(top)'}"; review that the block still reads right`);
        }
        const f = frags.find((x) => x.slot === b.slot);
        applied.push({ path: dstRel, slot: b.slot, from: f?.from ?? null, fragmentSha: f?.fragmentSha ?? null, anchorHeading: b.anchorHeading ?? null, anchorMoved });
      }
      return warnings;
    },

    /**
     * After the loop: a declaration whose path never reached the renderer is an
     * error, retired or unknown. Records each and returns them.
     */
    reconcile({ retired }) {
      const out = reconcileBlockDestinations(declared, { rendered, retired });
      for (const r of out) blockErrors.push({ path: r.path, slot: r.slot, code: r.code });
      return out;
    },

    /** The receipt's two block lists. */
    receipt: () => ({ blocksApplied: applied, blockErrors }),
  };
}
