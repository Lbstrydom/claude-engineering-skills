/**
 * @fileoverview `canonicaliseForHash` — LF canonicalisation for content hashing.
 *
 * Lives in `shared-lib` because it is a CONTRACT consumed by two domains: `install`
 * ([`build-manifest.mjs`](../build-manifest.mjs)) and `audit-orchestration`
 * ([`audit/tiered-shadow-contract-digest.mjs`](./audit/tiered-shadow-contract-digest.mjs)).
 * Keeping it in the install script made that an undeclared `audit-orchestration -> install`
 * edge — audit orchestration depending on build tooling, the reverse of the intended
 * direction.
 *
 * Moved here 2026-07-31; the original export was REMOVED rather than re-exported, so a
 * consumer cannot silently recreate the edge. Plan:
 * docs/plans/layering-and-mutation-contracts.md (L3).
 *
 * @module scripts/lib/canonical-hash
 */

/**
 * Canonicalise text content for hashing: CRLF → LF.
 *
 * WHY (found 2026-07-20 by the pre-push sandbox, which computes this manifest
 * in a clean checkout): `.gitattributes` pins `* text=auto eol=lf`, so the
 * COMMITTED bytes are always LF — but an editor or tool can still leave CRLF
 * in the working tree, and git reports those files as CLEAN because it
 * normalises on comparison. Hashing raw working-tree bytes therefore made
 * `bundleVersion` a function of LOCAL LINE ENDINGS, not of committed source.
 *
 * That silently broke the artifact's own contract twice over: the AGENTS.md
 * generated-artifact policy requires a committed artifact to be a pure,
 * byte-identical function of committed source, and the comment below this
 * claimed exactly that. In practice 16 skill reference files carried CRLF
 * locally, so the committed manifest was generated from contaminated input —
 * a fresh clone computes a different `bundleVersion` and reads as STALE.
 * `size` is normalised for the same reason (CRLF inflates it by one byte
 * per line).
 *
 * @param {Buffer} buf
 * @returns {Buffer} LF-normalised content
 */
export function canonicaliseForHash(buf) {
  return Buffer.from(buf.toString('utf-8').replace(/\r\n/g, '\n'), 'utf-8');
}
