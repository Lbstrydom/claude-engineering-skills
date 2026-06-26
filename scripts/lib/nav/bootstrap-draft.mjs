/**
 * @fileoverview Pure bootstrap drafter (plan v1.2 §4a). Given the live nav
 * evidence (each occurrence carries `containerCandidates` from the collector),
 * draft a `navLayers` map + `observedTargets` so a new user edits a smart
 * baseline instead of a blank page. v1.2: propose CONTAINERS holding ≥2 distinct
 * nav targets — never single-button ids — classified sticky-aware. Deterministic;
 * NO LLM (cut for egress safety — §2.4). Zero browser.
 *
 * @module scripts/lib/nav/bootstrap-draft
 */

// drawer/hamburger are NOT force-classified secondary (R2-M3) — a hamburger
// drawer can be the primary nav on mobile; let the prominence rule decide.
const SECONDARY_RE = /sub-?tabs?|secondary|breadcrumb/i;
const PRIMARY_RE = /primary|bottom-?nav|main-?nav|navbar|tabbar/i;

/**
 * Draft a navLayers contract from live evidence (plan §4a prominence). Groups
 * occurrences by their `containerCandidates`, keeps only containers holding ≥2
 * distinct nav targets, then classifies: sticky/fixed OR primary-word →
 * `primary`; secondary-word → `secondary`; otherwise the earliest-document-order
 * remaining container → `primary`, the rest → `secondary`.
 *
 * @param {Array<{target, containerCandidates?: Array<{selector,sticky}>}>} liveEvidence
 * @returns {{navLayers: {primary: string[], secondary: string[]}, observedTargets: string[]}}
 */
export function draftContractFromLive(liveEvidence) {
  // selector → {selector, sticky, targets:Set<string>, order}
  const containers = new Map();
  const observed = new Set();
  let order = 0;
  for (const e of liveEvidence || []) {
    if (e?.target) observed.add(e.target);
    for (const cand of e?.containerCandidates || []) {
      const sel = cand?.selector;
      if (!sel) continue;
      let c = containers.get(sel);
      if (!c) { c = { selector: sel, sticky: false, targets: new Set(), order: order++ }; containers.set(sel, c); }
      if (cand.sticky) c.sticky = true;
      // `<dynamic>` is an unresolved placeholder, not a distinct nav child — it
      // must NOT count toward the ≥2-targets gate (R1-M).
      if (e.target && e.target !== '<dynamic>') c.targets.add(e.target);
    }
  }
  // Keep only containers holding ≥2 distinct nav targets (drop single-button selectors).
  const multi = [...containers.values()].filter((c) => c.targets.size >= 2).sort((a, b) => a.order - b.order);

  const primary = [];
  const secondary = [];
  const undecided = [];
  for (const c of multi) {
    if (c.sticky || PRIMARY_RE.test(c.selector)) primary.push(c.selector);
    else if (SECONDARY_RE.test(c.selector)) secondary.push(c.selector);
    else undecided.push(c);
  }
  // Most-prominent remaining (earliest document order) → primary; rest → secondary.
  if (primary.length === 0 && undecided.length) primary.push(undecided.shift().selector);
  for (const c of undecided) secondary.push(c.selector);

  return {
    navLayers: {
      primary: dedupe(primary),
      secondary: dedupe(secondary),
    },
    observedTargets: [...observed].filter((t) => t && t !== '<dynamic>').sort(),
  };
}

function dedupe(a) { return [...new Set(a)]; }
