/**
 * @fileoverview Content-derived ownership for sync destinations.
 *
 * Answers "is the file at this destination ours?" from the FILE'S OWN BYTES,
 * not from the consumer's manifest.
 *
 * Why this exists. Ownership used to be recorded exclusively in
 * `scripts/.sync-manifest.json`, which consumers TRACK while the files it
 * describes are gitignored. A merge, reset or branch checkout therefore rolls
 * the ownership record backwards while the files survive — and worse, different
 * branches carry different committed manifests, so merging them makes ownership
 * a merge artifact. Everything synced since the reverted record then reads as an
 * unowned collision and aborts the WHOLE target, so the consumer silently stops
 * receiving updates. Observed twice on two different consumers; the second time
 * a re-run reported a different orphan count purely because a different branch's
 * manifest had won the merge.
 *
 * A file's own content cannot be reverted by a merge it does not participate in.
 * That is the whole idea.
 *
 * Two independent proofs, in order:
 *
 *   1. **Banner** — relocated tooling is banner-injected on the way out, and a
 *      consumer-authored file cannot carry our banner. This is the same signal
 *      `--adopt-orphans` already reported to operators, promoted from advisory
 *      text to the decision itself.
 *   2. **Byte-identity to source** — for payload we do NOT banner-inject
 *      (`.audit-loop/migrations/*.sql` — SQL gets no banner), identical bytes
 *      make the question moot: if what is on disk is exactly what we would
 *      write, adopting it discards nothing. Safe regardless of who wrote it.
 *
 * Anything else stays a collision and still aborts. The guard keeps its real
 * job — protecting a genuine consumer file — and `--adopt-orphans` remains the
 * operator escape hatch for that residue.
 *
 * Plan: docs/plans/sync-ownership-from-content.md
 *
 * @module scripts/lib/sync-ownership
 */

/**
 * @typedef {'banner'|'identical-to-source'|'unreadable'|'none'} OwnershipEvidence
 */

/**
 * Classify a single destination file's provenance from its content.
 *
 * Pure: the caller reads both sides. That keeps the decision testable without a
 * consumer checkout, which matters because this function is what stands between
 * a sync and a consumer's own file.
 *
 * Fails CLOSED. Unreadable, empty, or absent content is never "ours" — the
 * abort is recoverable (`--adopt-orphans`), silently overwriting a consumer's
 * file is not.
 *
 * @param {object} args
 * @param {string|null} args.destContent   Bytes on disk at the destination, utf-8.
 * @param {string|null} args.sourceContent Bytes we would write, utf-8; null when
 *   the outbound form is not a verbatim copy of a source file (any
 *   banner-injected or rewritten payload), in which case only the banner proof
 *   applies.
 * @param {string} args.bannerMarker       Single discriminating banner line.
 * @returns {{provable: boolean, evidence: OwnershipEvidence}}
 */
export function classifyOwnership({ destContent, sourceContent, bannerMarker }) {
  if (typeof destContent !== 'string' || destContent.length === 0) {
    return { provable: false, evidence: 'unreadable' };
  }
  // Guard against a falsy/empty marker matching everything — `''.includes` is
  // vacuously true, which would make every file "provably ours".
  if (typeof bannerMarker === 'string' && bannerMarker.length > 0
      && destContent.includes(bannerMarker)) {
    return { provable: true, evidence: 'banner' };
  }
  if (typeof sourceContent === 'string' && sourceContent.length > 0
      && destContent === sourceContent) {
    return { provable: true, evidence: 'identical-to-source' };
  }
  return { provable: false, evidence: 'none' };
}

/** Human-readable evidence, for the one-line-per-file operator report. */
export function describeEvidence(evidence) {
  switch (evidence) {
    case 'banner': return 'carries our upstream-owned banner — provably ours';
    case 'identical-to-source': return 'byte-identical to source — adopting discards nothing';
    case 'unreadable': return 'unreadable';
    default: return 'no banner, and differs from source';
  }
}
