/**
 * @fileoverview Pure bootstrap drafter (plan v1.1 Priority 2 / §4a). Given the
 * live nav evidence (`navIsh` containers from the collector), draft a `navLayers`
 * map + `observedTargets` so a new user edits a smart baseline instead of a blank
 * page. Deterministic; NO LLM (cut for egress safety — §2.4). Zero browser.
 *
 * @module scripts/lib/nav/bootstrap-draft
 */

const SECONDARY_RE = /sub-?tabs?|secondary|drawer|hamburger|breadcrumb/i;
const PRIMARY_RE = /(^|[#.\b])(primary|bottom-?nav|main-?nav|navbar)\b|primary|bottom-?nav|navbar/i;

/**
 * Classify a discovered nav-ish container into a layer (non-overlapping
 * precedence, R2-M3): secondary words first, then primary words, then the single
 * most-prominent remaining container → primary, the rest → secondary.
 *
 * @param {Array<{target,navIsh}>} liveEvidence
 * @returns {{navLayers: {primary: string[], secondary: string[]}, observedTargets: string[]}}
 */
export function draftContractFromLive(liveEvidence) {
  // Collect distinct nav-ish containers in first-seen (document-ish) order.
  const containers = [];
  const seen = new Set();
  const observed = new Set();
  for (const e of liveEvidence || []) {
    if (e?.target) observed.add(e.target);
    const sel = e?.navIsh?.selector;
    if (!sel || seen.has(sel)) continue;
    seen.add(sel);
    containers.push({ selector: sel, role: e.navIsh.role, tag: e.navIsh.tag });
  }

  const primary = [];
  const secondary = [];
  const undecided = [];
  for (const c of containers) {
    if (SECONDARY_RE.test(c.selector)) secondary.push(c.selector);
    else if (PRIMARY_RE.test(c.selector)) primary.push(c.selector);
    else undecided.push(c);
  }
  // Most-prominent remaining (first <nav>/role=navigation, else first) → primary.
  if (primary.length === 0 && undecided.length) {
    const idx = undecided.findIndex((c) => c.tag === 'NAV' || c.role === 'navigation');
    const pick = undecided.splice(idx === -1 ? 0 : idx, 1)[0];
    primary.push(pick.selector);
  }
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
