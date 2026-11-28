/**
 * @fileoverview "What would the sync write to this destination?" — defined ONCE
 * (debts 07a3dbdd565b, 77c917615461, ae70a5d51c16; plan
 * docs/plans/sync-to-repos-debt-cluster.md §2 E–F).
 *
 * The write loop built an outbound file through one pipeline (EOL fold, JSON
 * stage, rewriter, banner) and the ownership scan rebuilt "the bytes we would
 * write" through a SECOND, shorter one that skipped the JSON stage. A
 * byte-identical JSON orphan therefore read as a collision, and every `.json`
 * destination — including upstream-exclusive ones — was `deepMerge`d with
 * whatever the consumer had, so a key upstream deleted could never be removed
 * downstream. Both are fixed by having exactly one renderer.
 *
 * Two rules live here because they decide what a destination's bytes ARE:
 *
 *  - **Merge is for shared surfaces only.** `isCoOwnedJsonDest` (the layout's own
 *    answer, `sync-path-map.mjs`) names the JSON files whose destination is the
 *    consumer's own config namespace; only those are merged with the consumer's
 *    content. A relocated JSON file is upstream-exclusive and is REPLACED.
 *  - **Permission to merge is not proof of ownership.** An unmanifested
 *    destination is `owned` only on evidence (our banner, byte-identity with what
 *    we would write, or identity with an EARLIER upstream version). A shared
 *    config surface gets its own disposition, `shared-merge`: the consumer's
 *    keys are preserved, nothing is claimed.
 *
 * @module scripts/lib/sync-outbound
 */

import { deepMerge } from './json-merge.mjs';
import { guardPinDowngrades, assertNoPinDowngrade } from './sync-pin-guard.mjs';
import { rewriteCommandSurface } from './sync-rewriter.mjs';
import { injectUpstreamBanner } from './sync-banner.mjs';
import { canonicaliseOutboundEol } from './sync-eol-pins.mjs';
import { classifyOwnership } from './sync-ownership.mjs';
import { isCoOwnedJsonDest } from './sync-path-map.mjs';
import { spliceBlocks } from './sync-slots.mjs';

/**
 * Render the bytes the sync writes to `dstRel`. PURE. THROWS on a JSON that does not
 * parse or a pin downgrade (the caller reports it as that file's error).
 *
 * @param {object} a
 * @param {string} a.srcRel          source-relative path
 * @param {string} a.dstRel          consumer-relative destination
 * @param {string} a.srcContent      the source file's text
 * @param {string|null} [a.existingContent]  the consumer's current text; consulted ONLY for a shared (co-owned) JSON surface
 * @param {object} a.rewriteConfig
 * @param {Array<{slot: string, content: string, from: string}>} [a.blocks]  this consumer's declared blocks for `dstRel`
 *   (`.sync-overrides.json` `blocks`, fragments already normalised). EVERY caller must pass them — the write loop, the
 *   prior-upstream renderer and the ownership scan — or they compare different bytes. A slot that cannot be filled
 *   THROWS a `SlotError` (lib/sync-slots.mjs): the consumer's block is never silently dropped.
 * @returns {{content: string, rewrite: {changed: boolean, hits: number}, pinsHeld: Array<{key: string, server: string}>,
 *   blocksApplied: Array<{slot: string, anchorHeading: string|null}>}}
 */
export function renderOutbound({ srcRel, dstRel, srcContent, existingContent = null, rewriteConfig, blocks = [] }) {
  // Fold to LF before anything hashes, compares or writes (the bytes a consumer receives are a function of committed
  // source, not of which checkout ran the sync — see canonicaliseOutboundEol).
  let out = canonicaliseOutboundEol(dstRel, srcContent);
  let pinsHeld = [];
  if (dstRel.endsWith('.json')) {
    // The `!existing` branch is not a no-op: both paths go through ONE stringify so the output is a function of the source
    // alone (a first sync used to write the raw bytes and every later one the expanded form).
    const src = JSON.parse(srcContent);
    const existingJson = isCoOwnedJsonDest(srcRel) && existingContent !== null ? JSON.parse(existingContent) : null;
    const merged = existingJson ? deepMerge(existingJson, src) : src;
    // Supply-chain invariant: a merge may never move a server launcher from a pinned local path to an unpinned network
    // fetch (report 5b1a121e). Guard, then an INDEPENDENT post-condition on the final value.
    const guarded = guardPinDowngrades(existingJson, merged);
    assertNoPinDowngrade({ relPath: dstRel, existing: existingJson, outbound: guarded.value });
    pinsHeld = guarded.held;
    out = JSON.stringify(guarded.value, null, 2) + '\n';
  }
  const rewritten = rewriteCommandSurface({ relPath: dstRel, content: out, config: rewriteConfig });
  // Consumer blocks go in AFTER the rewriter, so a consumer's own command lines reach it verbatim (the rewriter owns
  // upstream's command surface, never the consumer's), and before the banner and any hash.
  const spliced = spliceBlocks(rewritten.rewritten, blocks);
  // The banner goes on last, BEFORE any hash, so the manifest matches what is written (idempotent: the source is banner-free).
  return {
    content: injectUpstreamBanner(spliced.content, dstRel),
    rewrite: { changed: rewritten.changed, hits: rewritten.hits },
    pinsHeld,
    blocksApplied: spliced.applied,
  };
}

/**
 * Decide what an existing destination that is NOT in the prior manifest (and not journalled) is. PURE except for the
 * injected `priorUpstreamMatches`, which the caller backs with the git-history resolver.
 *
 * `owned`        evidence it is ours: our banner, bytes identical to what we would write, or identical to an EARLIER upstream
 *                version (a stale snapshot, not an edit)
 * `shared-merge` a shared config surface whose consumer keys the merge preserves — NOT an ownership claim
 * `collision`    anything else; `--adopt-orphans` is the operator's override
 *
 * @param {object} a
 * @param {string} a.srcRel
 * @param {string} a.dstRel
 * @param {string|null} a.destContent   the destination's text, null if unreadable
 * @param {string|null} a.sourceText    the source file's text, null if unreadable (then only the banner can prove anything)
 * @param {object} a.rewriteConfig
 * @param {Array<object>} [a.blocks]  this destination's declared blocks — the SAME ones the write loop renders with
 * @param {string} a.bannerMarker
 * @param {(o: {acceptRaw: boolean}) => boolean|null} [a.priorUpstreamMatches]  true / false / null (unknown); asked last. `acceptRaw` is
 *   false when a rewrite touched the file: only an earlier version RENDERED through the same pipeline may then count.
 * @returns {{disposition: 'owned'|'shared-merge'|'collision', evidence?: string, reason?: string}}
 */
export function decideUnmanifested({ srcRel, dstRel, destContent, sourceText, rewriteConfig, blocks = [], bannerMarker, priorUpstreamMatches }) {
  if (isCoOwnedJsonDest(srcRel)) {
    try {
      const json = JSON.parse(destContent ?? '');
      if (json && typeof json === 'object' && !Array.isArray(json)) return { disposition: 'shared-merge' };
    } catch { /* falls through to the collision below */ }
    return { disposition: 'collision', reason: 'a shared config surface that does not parse as a JSON object' };
  }
  let expected = null;
  let hits = 0;
  if (typeof sourceText === 'string') {
    try {
      // A throwing render (incl. a declared slot upstream lacks) leaves `expected` null: ownership then rests on the banner, never a guess.
      const r = renderOutbound({ srcRel, dstRel, srcContent: sourceText, existingContent: null, rewriteConfig, blocks });
      expected = r.content;
      hits = r.rewrite.hits;
    } catch { expected = null; }
  }
  const { provable, evidence } = classifyOwnership({ destContent, sourceContent: expected, bannerMarker });
  if (provable) return { disposition: 'owned', evidence };
  // The oracle is told whether RAW historical blobs may count: only when nothing was rewritten (a rewritten destination matches a
  // RENDERED earlier version, never a raw blob). Never asked for an empty or unreadable destination: those are rejected above on
  // purpose and no history can rehabilitate them.
  if (expected !== null && typeof destContent === 'string' && destContent.length > 0 && priorUpstreamMatches?.({ acceptRaw: hits === 0 }) === true) {
    return { disposition: 'owned', evidence: 'prior-upstream' };
  }
  return { disposition: 'collision' };
}
