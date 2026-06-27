/**
 * @fileoverview Pure mapping: persona reachability evidence → nav personaIntents
 * (plan: docs/completed/persona-clickpath-nav-seeding.md). Extracted from
 * nav-audit.mjs so the mapping is testable without running the CLI (its `main()`
 * is unguarded). The evidence FETCH (cross-skill subprocess) stays in nav-audit;
 * this is the pure transform. No browser, no I/O.
 *
 * @module scripts/lib/nav/persona-seed
 */
import { normalizeLiveTarget } from './verify.mjs';

/** Slugify a destination id into a stable intentId — so two controls with the same
 *  label but different destinations never collide (R3-M2). */
export function slugifyDestination(dest) {
  return String(dest).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
}

/**
 * Map per-persona reached URLs → personaIntents seeds. Each URL is normalized to a
 * destination via `normalizeLiveTarget`; a URL that doesn't normalize (unrecognized
 * route, external origin, mailto:) is DROPPED — it never seeds a false destination
 * (R1-M4). Intents are deduped per (persona, destination); `requiredInLayer` is left
 * null for the human reviewer; `source` is `persona-test-evidence`.
 * @param {Array<{persona:string, reached?:Array<{url:string, clickedText?:string|null}>}>} personas
 * @param {string|null} bootUrl - the live origin used to normalize/scope URLs
 * @returns {Array<{personaId:string, intentId:string, destination:string, label:string|null, source:string}>}
 */
export function mapPersonasToIntents(personas, bootUrl) {
  const seeds = [];
  for (const p of personas || []) {
    if (!p?.persona) continue;
    const seen = new Set(); // dedupe per (persona, destination)
    for (const r of p.reached || []) {
      const dest = normalizeLiveTarget(r?.url, bootUrl); // string | null
      if (!dest || seen.has(dest)) continue;             // unnormalizable → dropped
      seen.add(dest);
      seeds.push({
        personaId: p.persona,
        intentId: slugifyDestination(dest),
        destination: dest,
        label: r.clickedText ?? null,
        source: 'persona-test-evidence',
      });
    }
  }
  return seeds;
}
