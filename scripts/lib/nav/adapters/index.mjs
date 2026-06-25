/**
 * @fileoverview Adapter registry (plan §4a.B/§4a.F). A new framework is ONE file
 * here — the universal affordance detector (extract.mjs) and everything
 * downstream is untouched (strategy-over-switch, #3). Multiple matching adapters
 * is the normal case: their destinations are UNIONED, never first-wins (§4a.F).
 *
 * @module scripts/lib/nav/adapters/index
 */
import * as vanillaSwitchview from './vanilla-switchview.mjs';
import * as reactRouter from './react-router.mjs';
import * as nextFile from './next-file.mjs';

export const ADAPTERS = [vanillaSwitchview, reactRouter, nextFile];

/**
 * @param {string} root
 * @param {Array<{path: string, content: string}>} sources
 * @returns {object[]} the active adapters (those whose stack is present)
 */
export function activeAdapters(root, sources) {
  return ADAPTERS.filter((a) => {
    try { return a.detect(root, sources); } catch { return false; }
  });
}

/**
 * Resolve a raw navigate target to a canonical id using the first active adapter
 * that recognises it. First-active-wins is correct for resolving a SINGLE target
 * (a given navigate-call resolves to one id); the union semantics in §4a.F apply
 * to destination DISCOVERY (which is unioned in extract.mjs), not single-target
 * resolution (audit M6).
 * @param {object[]} adapters
 * @param {string} raw
 * @param {object} [ctx] - shared context (e.g. {viewsMap})
 * @returns {string|null}
 */
export function resolveWithAdapters(adapters, raw, ctx = {}) {
  for (const a of adapters) {
    try {
      const id = a.resolveDestination(raw, ctx);
      if (id) return id;
    } catch { /* try next adapter */ }
  }
  return null;
}
