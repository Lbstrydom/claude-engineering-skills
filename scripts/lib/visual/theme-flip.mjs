/**
 * @fileoverview Theme-flip durability + verification for extract.mjs.
 *
 * Bug class (WCA report 892b8e82): an `attribute`/`class` theme flip applied after
 * DOMContentLoaded is REVERTED when the app boots (a theme manager re-stamps
 * `data-theme`), so the "dark" capture is light — ~1200 fabricated
 * `theme_unmapped_token` findings. Fix, in three layers:
 *   1. PIN: an init script applies the flip at document-start and a
 *      MutationObserver re-asserts it if the app reverts it (bounded — an app
 *      that fights back forever must not turn this into a livelock).
 *   2. RE-ASSERT + VERIFY: after load the flip is re-applied and the attribute /
 *      class is read back from the live DOM.
 *   3. PROBE: a sampled computed-colour signature must DIFFER between themes of
 *      one device. Identical signatures mean the flip changed nothing the page
 *      paints — the captures are not a theme pair, so the cells are reported
 *      `missingStates` (unverified), never scored.
 *
 * Pure helpers are exported for Tier-1 tests; the browser-side script strings are
 * built here so extract.mjs stays the only module that touches playwright.
 *
 * @module scripts/lib/visual/theme-flip
 */

/** Max times the pin will re-assert a reverted flip (livelock bound). */
export const PIN_MAX_REASSERTS = 25;

/** Is this apply-protocol a DOM flip the app can revert? (media/localStorage are not.) */
export function isDomFlip(apply) {
  return !!apply && (apply.mode === 'attribute' || (apply.mode === 'class' && !!apply.value));
}

/**
 * Init script (runs before any app script) that applies and pins the flip.
 * @returns {string|null} script source, or null when the mode is not a DOM flip
 */
export function buildPinInitScript(apply) {
  if (!isDomFlip(apply)) return null;
  const cfg = JSON.stringify({
    mode: apply.mode, target: apply.target, attribute: apply.attribute || null, value: apply.value, max: PIN_MAX_REASSERTS,
  });
  return `(()=>{const c=${cfg};let n=0;let mo=null;const ok=(el)=>c.mode==='attribute'?el.getAttribute(c.attribute)===c.value:el.classList.contains(c.value);
const put=(el)=>{if(c.mode==='attribute')el.setAttribute(c.attribute,c.value);else el.classList.add(c.value);};
const off=()=>{if(mo){mo.disconnect();mo=null;}};
const ensure=()=>{let el=null;try{el=document.querySelector(c.target);}catch(e){}if(el&&!ok(el)){if(n>=c.max){off();return;}n++;put(el);}};
window.__vaThemePin={reasserts:()=>n,exhausted:()=>n>=c.max,stop:off};
ensure();
mo=new MutationObserver(ensure);
mo.observe(document,{attributes:true,attributeFilter:[c.mode==='attribute'?c.attribute:'class'],subtree:true,childList:true});
})()`;
}

/**
 * Read back whether the flip is live right now, plus the colour probe.
 * Runs in the page; returned shape is plain JSON.
 */
export async function readFlipState(page, apply, surfaceSelectors = []) {
  return page.evaluate(({ apply, sels }) => {
    let el = null;
    const mode = apply && apply.mode;
    if (mode === 'attribute' || mode === 'class') { try { el = document.querySelector(apply.target); } catch { /* bad selector */ } }
    let live = null; // null = not a DOM flip (media / localStorage): nothing to read back
    if (mode === 'attribute') live = !!el && el.getAttribute(apply.attribute) === apply.value;
    else if (mode === 'class') live = !!el && el.classList.contains(apply.value);
    const pin = window.__vaThemePin;
    const exhausted = !!(pin && pin.exhausted());
    // Probe keyed by structural path so cross-theme comparison matches the SAME element
    // in both captures (a different DOM population cannot masquerade as a colour change).
    const pathOf = (e) => {
      const parts = [];
      for (let c = e; c && c.nodeType === 1 && parts.length < 40; c = c.parentElement) {
        let i = 1; for (let sb = c.previousElementSibling; sb; sb = sb.previousElementSibling) if (sb.tagName === c.tagName) i++;
        parts.unshift(c.tagName.toLowerCase() + ':' + i);
      }
      return parts.join('>');
    };
    const probeEls = [document.documentElement, document.body];
    for (const s of sels) {
      try {
        const root = document.querySelector(s);
        if (root) probeEls.push(root, ...Array.from(root.querySelectorAll('*')).slice(0, 400));
      } catch { /* bad selector */ }
    }
    const probe = {};
    for (const e of probeEls) {
      const cs = getComputedStyle(e);
      probe[pathOf(e)] = cs.backgroundColor + '|' + cs.color + '|' + cs.borderTopColor;
    }
    return { live, exhausted, probe };
  }, { apply: apply || {}, sels: surfaceSelectors });
}

/**
 * Cross-theme verification: do the sampled computed-colour probes of one device's
 * theme captures differ somewhere? Pure.
 * @param {Array<{theme:string, probe:string}>} probes - one per flip-mode theme
 * @returns {{ok:boolean, reason?:string}}
 */
export function probesDiffer(probes) {
  const list = (probes || []).filter((p) => p && p.probe && typeof p.probe === 'object');
  if (list.length < 2) return { ok: true, badThemes: [] }; // nothing to compare - not a verdict
  const bad = new Set();
  const why = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]; const b = list[j];
      let common = 0; let differs = false;
      for (const k of Object.keys(a.probe)) {
        if (!(k in b.probe)) continue;
        common++;
        if (a.probe[k] !== b.probe[k]) { differs = true; break; }
      }
      if (common === 0) { bad.add(a.theme); bad.add(b.theme); why.push(`"${a.theme}" and "${b.theme}" share no comparable sampled element`); }
      else if (!differs) { bad.add(a.theme); bad.add(b.theme); why.push(`"${a.theme}" and "${b.theme}" have identical sampled computed colours`); }
    }
  }
  if (!bad.size) return { ok: true, badThemes: [] };
  return {
    ok: false,
    badThemes: [...bad],
    reason: `theme flip not observable: ${why.join('; ')} (background/colour/border of html, body and surface elements matched by path) - the captures are not a distinguishable theme pair, so no theme findings are emitted from them`,
  };
}
