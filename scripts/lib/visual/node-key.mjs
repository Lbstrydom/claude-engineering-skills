/**
 * @fileoverview Stable node identity — the cross-theme / cross-run join key
 * (plan §2 decision 4, §2b-E). To diff "the same element" between light/dark and
 * against a base run, each audited node needs a key that is stable across runs
 * yet distinguishes siblings. Two strategies, in precedence order:
 *
 *   1. `data-visual-id` opt-in override → `vid:<id>` (apps with unstable DOM can
 *      pin critical nodes; survives DOM reshuffles).
 *   2. structural signature → a depth-capped `tag[role]:nthOfType` ancestor chain
 *      rooted at the contracted surface (NOT document root — so the key is stable
 *      against changes outside the surface).
 *
 * Pure (no DOM/browser) — consumes a plain descriptor emitted by extract.mjs's
 * `page.evaluate`. Hard test-first (tests/visual-node-key.test.mjs).
 *
 * @module scripts/lib/visual/node-key
 */

/** Cap the structural chain so an unrelated deep-nesting change far up the tree
 *  doesn't churn the key. The surface root anchors the bottom of the chain. */
export const MAX_PATH_DEPTH = 8;

/**
 * @typedef {object} NodeDescriptor
 * @property {string} tag                 lowercased tag name
 * @property {string|null} [role]         ARIA role (explicit or implicit), or null
 * @property {string|null} [dataVisualId] value of `data-visual-id`, or null
 * @property {Array<{tag:string, nthOfType:number, role?:string|null}>} [ancestorPath]
 *           the chain from the surface root (index 0) down to and INCLUDING the
 *           node itself (last element). `nthOfType` is 1-based among same-tag siblings.
 */

/**
 * Compute a stable key for an audited node.
 * @param {NodeDescriptor} desc
 * @returns {string}
 */
export function stableNodeKey(desc) {
  if (!desc || typeof desc !== 'object') return 'node:invalid';

  const vid = typeof desc.dataVisualId === 'string' ? desc.dataVisualId.trim() : '';
  if (vid) return `vid:${vid}`;

  const path = Array.isArray(desc.ancestorPath) ? desc.ancestorPath : [];
  if (path.length === 0) {
    // No path — fall back to a tag/role signature (weakest; same-tag siblings collide,
    // which is acceptable since there's nothing to disambiguate them by).
    return `node:${seg({ tag: desc.tag, nthOfType: 1, role: desc.role })}`;
  }

  // Keep the LAST MAX_PATH_DEPTH segments (closest to the node) — the tail is the
  // most stable/identifying part; the head (near the surface root) churns least but
  // matters least for sibling disambiguation.
  const tail = path.slice(-MAX_PATH_DEPTH);
  const truncated = path.length > MAX_PATH_DEPTH;
  return `${truncated ? '…>' : ''}${tail.map(seg).join('>')}`;
}

/**
 * Are two descriptors the same logical node? (Convenience for theme-parity /
 * drift joins — equality of the computed key.)
 * @param {NodeDescriptor} a
 * @param {NodeDescriptor} b
 * @returns {boolean}
 */
export function sameNode(a, b) {
  return stableNodeKey(a) === stableNodeKey(b);
}

function seg(s) {
  const tag = String(s?.tag ?? 'unknown').toLowerCase();
  const nth = Number.isInteger(s?.nthOfType) && s.nthOfType > 0 ? s.nthOfType : 1;
  const role = s?.role ? `[${String(s.role).toLowerCase()}]` : '';
  return `${tag}${role}:${nth}`;
}
