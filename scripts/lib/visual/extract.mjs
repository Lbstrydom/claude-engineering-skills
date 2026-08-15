/**
 * @fileoverview The ONE browser-touching module (plan §2a-C/E, §2b, Gemini-G1/G2).
 * Drives headless Chromium to capture per device×theme evidence the pure tier
 * engines consume. Isolated exactly like scripts/lib/nav/verify.mjs isolates its
 * drive — nothing else imports playwright.
 *
 * Per device×theme it:
 *   1. freezes animation (`* { transition:none!important; animation:none!important }`)
 *      via addInitScript BEFORE any capture so getComputedStyle never reads an
 *      interpolated mid-transition value (Gemini-G2);
 *   2. applies the theme via the contract's discriminated apply protocol
 *      (class/attribute/localStorage/media), then verifies + waits for CONTENT
 *      presence (not just container mount — Gemini-G2-1);
 *   3. batches one page.evaluate to tag audited nodes (`data-va-instance`), collect
 *      computed styles + rects + scroll metrics + the in-browser background-stack
 *      ancestor walk (Gemini-G1) + structural node descriptors;
 *   4. runs the CDP forcePseudoState protocol per interactive node (bounded by
 *      interactiveBudget) to read EFFECTIVE :hover/:focus/:disabled computed styles
 *      without flaky mouse/keyboard actuation.
 *
 * Returns plain evidence; closes the browser + CDP session in `finally`.
 *
 * @module scripts/lib/visual/extract
 */
import { stableNodeKey } from './node-key.mjs';
import { resolveProvenance } from './provenance-resolver.mjs';
import { playwrightInstallHint } from '../package-manager.mjs';

/** Computed properties collected per node (union of what the four tiers read). */
export const COLLECTED_PROPS = [
  'color', 'background-color', 'background-image',
  'border-top-color', 'border-top-left-radius', 'border-top-width', 'border-top-style',
  'position', 'z-index',
  'font-size', 'line-height', 'font-weight', 'box-shadow',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'width', 'height', 'flex-basis', 'grid-template-columns', 'grid-template-rows',
  'outline-style', 'outline-width', 'outline-color',
  'opacity', 'filter', 'cursor', 'object-fit',
  'text-overflow', 'overflow-wrap', 'word-break', 'overflow-x',
  'transform', 'text-decoration-line',
];

const FREEZE_CSS = '*,*::before,*::after{transition:none!important;animation:none!important;animation-duration:0s!important;transition-duration:0s!important;}';
// addInitScript runs at document-start where document.head is null — appending to
// <html> then does NOT survive to capture time. Defer to DOMContentLoaded so the
// freeze lands in <head> and persists. (The runtime re-assert in applyTheme is the
// real guarantee; this just freezes initial-load animation too.)
const ANIM_FREEZE_INIT = `(()=>{const inject=()=>{const s=document.createElement('style');s.setAttribute('data-va-freeze','1');s.textContent=${JSON.stringify(FREEZE_CSS)};(document.head||document.documentElement).appendChild(s);};if(document.head){inject();}else{document.addEventListener('DOMContentLoaded',inject,{once:true});}})()`;

/**
 * @param {object} args
 * @param {string} args.url
 * @param {object} args.contract - parsed visual-contract.json
 * @param {Array<{name:string, viewport:{width:number,height:number}, deviceScaleFactor?:number, isMobile?:boolean, hasTouch?:boolean, userAgent?:string|null}>} args.devices
 * @param {string[]} [args.themeNames] - subset of contract.themes to capture (default all)
 * @param {string} [args.storageState]
 * @param {number} [args.timeoutMs]
 * @param {boolean} [args.fullDom] - theme-safety v2: also capture the full-DOM
 *   text-candidate sweep (`scope:'fullDom'` nodes + per-state captureStats) for
 *   the contrast parity-delta. Default off → capture is byte-identical to v1.
 * @param {number} [args.fullDomNodeBudget] - early-stop bound on EMITTED full-DOM
 *   text candidates (visit ceiling = 25×); clipping sets `captureStats.truncated`.
 * @returns {Promise<{ok:boolean, code?:string, reason?:string, perState?:object[], unverifiableSurfaces?:string[], warnings?:string[], missingStates?:Array<{device:string,theme:string,reason:string}>, expectedStates?:number}>}
 */
export async function runExtract({ url, contract, devices, themeNames = null, storageState = null, timeoutMs = 30000, fullDom = false, fullDomNodeBudget = 4000 }) {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch (err) {
    // Keep the friendly code but preserve the real cause (B-R2: a corrupted
    // install / ESM resolution failure must be distinguishable from "not installed").
    return { ok: false, code: 'NO_CHROMIUM', reason: `playwright unavailable — run \`${playwrightInstallHint()}\` (cause: ${(err && err.message) ? err.message : String(err)})` };
  }

  const themes = (contract.themes || []).filter((t) => !themeNames || themeNames.includes(t.name));
  const effThemes = themes.length ? themes : [{ name: 'default', apply: { mode: 'class', target: 'html', value: '' } }];
  const surfaces = contract.surfaces || [];

  let browser;
  const perState = [];
  const unverifiable = new Set();
  const warnings = [];
  // Structured expected-vs-actual state accounting (audit B-R1-H1): a device×theme
  // cell that failed to capture must be a MACHINE-READABLE loss, not just a
  // warning string — the theme-pair tiers silently shrink to whatever captured,
  // and a partial matrix must never be indistinguishable from a complete one.
  const missingStates = [];
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    return { ok: false, code: 'NO_CHROMIUM', reason: `chromium launch failed: ${err.message}` };
  }

  try {
    for (const device of devices) {
      for (const theme of effThemes) {
        const stateLabel = `${device.name}/${theme.name}`;
        const isMedia = theme.apply?.mode === 'media';
        const ctxOpts = {
          viewport: device.viewport,
          deviceScaleFactor: device.deviceScaleFactor ?? 1,
          isMobile: device.isMobile ?? false,
          hasTouch: device.hasTouch ?? false,
          ...(device.userAgent ? { userAgent: device.userAgent } : {}),
          ...(storageState ? { storageState } : {}),
          ...(isMedia ? { colorScheme: theme.apply.colorScheme } : {}),
        };
        const context = await browser.newContext(ctxOpts);
        // Animation freeze + localStorage theme must be set BEFORE app init.
        await context.addInitScript(ANIM_FREEZE_INIT);
        if (theme.apply?.mode === 'localStorage') {
          await context.addInitScript(({ k, v }) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } }, { k: theme.apply.key, v: theme.apply.value });
        }
        const page = await context.newPage();
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          const themeApplied = await applyTheme(page, theme.apply);
          // Theme-apply integrity (audit B-R1-H3): a bad selector must not become a
          // silent no-op — a not-actually-flipped theme fabricates parity evidence.
          if (themeApplied === false) {
            warnings.push(`${stateLabel}: theme apply target matched nothing — theme "${theme.name}" may not have been applied; parity evidence for this state is suspect`);
          }

          const { nodes, capturedSurfaces, fullDomStats } = await collectState(page, { surfaces, props: COLLECTED_PROPS, timeoutMs, fullDom, fullDomNodeBudget });
          // Capture honesty: a declared surface that never produced content is unverifiable.
          for (const s of surfaces) if (!capturedSurfaces.has(s.id)) unverifiable.add(s.id);

          // CDP forcePseudoState per interactive node (bounded). fullDom nodes carry
          // interactive:false/focusable:false so they never enter this pass.
          await capturePseudoStates(context, page, nodes, surfaces);

          // Finalize: compute stable node keys + provenance in Node context.
          const evidence = nodes.map((n) => ({
            ...n,
            device: device.name,
            theme: theme.name,
            nodeKey: stableNodeKey(n.descriptor),
            matched: resolveMatched(n.declarations),
          }));
          perState.push({
            device: device.name, theme: theme.name, viewportWidth: device.viewport.width, nodes: evidence,
            // Per-state capture stats for the parity-delta's scope-aware coverage
            // (theme-safety v2 decision 4): present only when --full-dom ran.
            ...(fullDomStats ? { captureStats: { ...fullDomStats, device: device.name, theme: theme.name } } : {}),
          });
        } catch (err) {
          const reason = (err && err.message) ? err.message : String(err);
          warnings.push(`${stateLabel}: ${reason}`);
          missingStates.push({ device: device.name, theme: theme.name, reason });
        } finally {
          await context.close().catch(() => {});
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return { ok: true, perState, unverifiableSurfaces: [...unverifiable], warnings, missingStates, expectedStates: devices.length * effThemes.length };
}

/**
 * Apply a theme via the discriminated apply protocol (media handled at context).
 * Uniform verification contract (audit B-R1-H3): returns `true` when the mutation
 * verifiably landed, `false` when the apply target matched NOTHING (a silent
 * no-op would fabricate parity evidence), `null` when the mode is not verifiable
 * at the mutation point (media = context-level; localStorage = app-interpreted).
 * @returns {Promise<boolean|null>}
 */
async function applyTheme(page, apply) {
  let applied = null;
  if (!apply || apply.mode === 'media') { /* media set on context */ }
  else if (apply.mode === 'class' && apply.value) {
    applied = await page.evaluate(({ target, value }) => {
      const el = document.querySelector(target);
      if (!el) return false;
      el.classList.add(value);
      return true;
    }, apply);
  } else if (apply.mode === 'attribute') {
    applied = await page.evaluate(({ target, attribute, value }) => {
      const el = document.querySelector(target);
      if (!el) return false;
      el.setAttribute(attribute, value);
      return true;
    }, apply);
  } else if (apply.mode === 'localStorage') {
    await page.reload({ waitUntil: 'domcontentloaded' }); // ensure app picks up the pre-seeded value
  }
  if (apply?.settleSelector) {
    await page.waitForSelector(apply.settleSelector, { timeout: 5000 }).catch(() => {});
  }
  // Re-assert the transition/animation freeze AT RUNTIME after the theme flip. The
  // addInitScript copy is appended at document-start (head === null → lands on
  // <html>) and does not survive to capture time, so the data-theme flip above
  // would otherwise be read mid-transition → the theme/contrast tiers capture the
  // FROM-theme value (fabricated theme_unmapped_token + contrast_failure). Setting
  // `transition:none` cancels any in-flight transition, snapping computed styles to
  // the settled value. Await fonts BEFORE forcing the reflow — a naive reflow races
  // web-font loading and fabricates theme_geometry_drift on text widths.
  await page.evaluate(async (css) => {
    if (!document.querySelector('style[data-va-freeze]')) {
      const s = document.createElement('style');
      s.setAttribute('data-va-freeze', '1');
      s.textContent = css;
      (document.head || document.documentElement).appendChild(s);
    }
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch { /* ignore */ } }
    void document.body.offsetWidth; // force synchronous style/layout recalc
  }, FREEZE_CSS);
  return applied;
}

/**
 * Batched in-browser collection: tag audited nodes, gather computed styles, rects,
 * scroll metrics, structural descriptors, and the background-stack ancestor walk.
 */
async function collectState(page, { surfaces, props, timeoutMs, fullDom = false, fullDomNodeBudget = 4000 }) {
  // Wait for content presence per surface (not just container mount — G2-1).
  for (const s of surfaces) {
    await page.waitForFunction(
      (sel) => { const el = document.querySelector(sel); return !!el && el.childElementCount > 0; },
      s.selector,
      { timeout: Math.min(timeoutMs, 8000) },
    ).catch(() => { /* unverifiable surface — handled by capturedSurfaces */ });
  }

  const raw = await page.evaluate(({ surfaces, props, fullDom, fullDomNodeBudget }) => {
    const UNRESOLVABLE = 'unresolvable';
    let instanceCounter = 0;
    const out = [];
    const captured = [];
    // Theme-safety v2: every element the contracted loop captures is tracked in
    // an in-closure WeakSet — the full-DOM walk dedups against it WITHOUT
    // reading/writing any page attribute (plan decision 5: no page mutation
    // beyond the pre-existing data-va-instance tagging).
    const capturedEls = new WeakSet();

    const toRgbaNorm = (c) => {
      const m = String(c).match(/rgba?\(([^)]+)\)/);
      if (!m) return c;
      const p = m[1].split(/[,/\s]+/).filter(Boolean);
      const [r, g, b] = p.slice(0, 3).map((x) => Math.round(parseFloat(x)));
      const a = p.length >= 4 ? parseFloat(p[3]) : 1;
      return a >= 1 ? `${r},${g},${b}` : `${r},${g},${b},${a}`;
    };

    const bgStack = (el) => {
      const stack = [];
      let cur = el;
      let hops = 0;
      while (cur && hops++ < 50) {
        const cs = getComputedStyle(cur);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') { stack.push(UNRESOLVABLE); break; }
        const bg = toRgbaNorm(cs.backgroundColor);
        if (bg && bg !== '0,0,0,0') { stack.push(bg); if (!bg.includes(',0,0,0,0')) break; }
        else stack.push('0,0,0,0');
        cur = cur.parentElement;
      }
      return stack;
    };

    const ancestorPath = (el, rootEl) => {
      const chain = [];
      let cur = el;
      let hops = 0;
      while (cur && cur !== rootEl.parentElement && hops++ < 32) {
        const parent = cur.parentElement;
        let nth = 1;
        if (parent) {
          let sib = cur;
          while ((sib = sib.previousElementSibling)) if (sib.tagName === cur.tagName) nth++;
        }
        chain.unshift({ tag: cur.tagName.toLowerCase(), nthOfType: nth, role: cur.getAttribute('role') || null });
        if (cur === rootEl) break;
        cur = parent;
      }
      return chain;
    };

    const FOCUSABLE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
    const isInteractive = (el) => FOCUSABLE.has(el.tagName) || ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch'].includes(el.getAttribute('role')) || el.hasAttribute('onclick');
    const isFocusable = (el) => {
      if (el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')) return false;
      const ti = el.getAttribute('tabindex');
      if (ti != null && parseInt(ti, 10) >= 0) return true;
      return (el.tagName === 'A' ? el.hasAttribute('href') : FOCUSABLE.has(el.tagName));
    };

    for (const surface of surfaces) {
      const root = document.querySelector(surface.selector);
      if (!root || root.childElementCount === 0) continue;
      captured.push(surface.id);
      const excl = (surface.excludeSelectors || []);
      const allowOverlap = (surface.allowOverlapWith || []);
      // The stacking LAYER this surface lives in is often set by an ancestor ABOVE
      // the contracted root (a fixed/absolute overlay like `#auth-screen`), which is
      // outside the captured subtree — the overlap guard can't see it from the nodes
      // alone. Walk the root's ancestors once and tag the whole surface so layout-
      // physics treats overlay-vs-page overlap as intentional (shakedown pass-3 #1).
      let surfaceLayer = null;
      let anc = root.parentElement;
      let aHops = 0;
      while (anc && aHops++ < 50) {
        const ap = getComputedStyle(anc).position;
        if (ap === 'fixed' || ap === 'absolute') { surfaceLayer = anc.id ? `ovl:#${anc.id}` : `ovl:${surface.id}`; break; }
        anc = anc.parentElement;
      }
      const all = [root, ...root.querySelectorAll('*')];
      const budget = surface.nodeBudget || 400;
      let count = 0;
      for (const el of all) {
        if (count >= budget) { out.push({ __budgetExceeded: surface.id }); break; }
        if (excl.some((sel) => el.closest(sel))) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') {
          // still emit a minimal record for theme-conditional detection
        }
        const rect = el.getBoundingClientRect();
        const id = `va-${++instanceCounter}`;
        el.setAttribute('data-va-instance', id);
        capturedEls.add(el);
        const computed = {};
        for (const p of props) computed[p] = cs.getPropertyValue(p);
        const parentEl = el.parentElement;
        out.push({
          surfaceId: surface.id,
          surfaceLayer,
          auditInstanceId: id,
          parentInstanceId: parentEl?.getAttribute('data-va-instance') || null,
          depth: ancestorPath(el, root).length,
          displayed: cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width >= 0,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || null,
          inputType: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : null,
          hasText: !!(el.textContent && el.textContent.trim()) && el.children.length === 0,
          // theme-safety: color-dependent content signal for the finding snippet
          // (form controls paint value/placeholder/option text even when empty).
          textSnippet: String(el.value || el.placeholder || (el.selectedOptions && el.selectedOptions[0] && el.selectedOptions[0].text) || el.textContent || '').trim().slice(0, 60),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          scroll: { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth },
          computed,
          backgroundStack: bgStack(el),
          interactive: isInteractive(el),
          focusable: isFocusable(el),
          disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
          overlapAllowed: allowOverlap.some((sel) => el.matches(sel)),
          isImage: el.tagName === 'IMG',
          naturalWidth: el.naturalWidth || 0,
          naturalHeight: el.naturalHeight || 0,
          descriptor: {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || null,
            dataVisualId: el.getAttribute('data-visual-id') || null,
            ancestorPath: ancestorPath(el, root),
          },
          declarations: [], // populated by CDP pass for nodes that need provenance
        });
        count++;
      }
    }
    // ── Theme-safety v2: opt-in full-DOM sweep (plan decisions 5 + 7) ──
    // Bounded incremental TreeWalker — NOT querySelectorAll('*'), which would
    // materialize the whole NodeList before any budget applies. acceptNode
    // returns FILTER_REJECT for contracted-captured elements so an entire
    // contracted subtree is pruned whole (Gemini-r2-M2). The budget bounds
    // EMITTED text candidates, not raw visits — empty layout wrappers must not
    // eat the budget before real content (arm-eval ffc02eec); a hard visited
    // ceiling (budget × 25) still bounds pathological pages.
    let fullDomStats = null;
    if (fullDom) {
      const stats = { fullDomRequested: true, visitedElements: 0, skippedAlreadyContracted: 0, displayedTextCandidatesAfterSkip: 0, emitted: 0, truncated: false };
      const visitCeiling = fullDomNodeBudget * 25;
      // Full documentElement-rooted chain: `livePath` (un-truncated join identity)
      // and `descriptor.ancestorPath` (feeds stableNodeKey so finding dedup keys
      // stay distinct across different elements — an empty path would collapse
      // every same-tag fullDom finding into one).
      const chainOf = (el) => {
        const chain = [];
        let cur = el;
        while (cur && cur.nodeType === 1) {
          let nth = 1;
          let sib = cur;
          while ((sib = sib.previousElementSibling)) if (sib.tagName === cur.tagName) nth++;
          chain.unshift({ tag: cur.tagName.toLowerCase(), nthOfType: nth, role: (cur.getAttribute && cur.getAttribute('role')) || null });
          cur = cur.parentElement;
        }
        return chain;
      };
      const livePathOf = (chain) => chain.map((s) => `${s.tag}${s.role ? `[${s.role.toLowerCase()}]` : ''}:${s.nthOfType}`).join('>');
      const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT, {
        acceptNode(el) {
          stats.visitedElements++;
          if (capturedEls.has(el)) { stats.skippedAlreadyContracted++; return NodeFilter.FILTER_REJECT; } // prune subtree whole
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let el;
      while ((el = walker.nextNode())) {
        if (stats.emitted >= fullDomNodeBudget || stats.visitedElements >= visitCeiling) { stats.truncated = true; break; }
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const isLeafText = !!(el.textContent && el.textContent.trim()) && el.children.length === 0;
        if (!isLeafText) continue; // the delta assesses text-bearing leaves only — don't spend budget on wrappers
        stats.displayedTextCandidatesAfterSkip++;
        const computed = {};
        for (const p of props) computed[p] = cs.getPropertyValue(p);
        const chain = chainOf(el);
        out.push({
          scope: 'fullDom', // stamped at SOURCE for fullDom nodes (contracted stay untagged — assembly normalizer defaults them)
          surfaceId: null,
          surfaceLayer: null,
          livePath: livePathOf(chain),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || null,
          displayed: true,
          hasText: true,
          textSnippet: String(el.textContent || '').trim().slice(0, 60),
          computed,
          backgroundStack: bgStack(el),
          interactive: false, // never enters the CDP pseudo-state pass
          focusable: false,
          disabled: false,
          isImage: false,
          descriptor: { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || null, dataVisualId: el.getAttribute('data-visual-id') || null, ancestorPath: chain },
          declarations: [],
        });
        stats.emitted++;
      }
      fullDomStats = stats;
    }

    return { out, captured, fullDomStats };
  }, { surfaces, props, fullDom, fullDomNodeBudget });

  const budgetHits = raw.out.filter((n) => n.__budgetExceeded);
  const nodes = raw.out.filter((n) => !n.__budgetExceeded);
  for (const b of budgetHits) nodes.push({ __warning: `surface ${b.__budgetExceeded}: nodeBudget exceeded — some nodes unverified_due_to_budget` });
  return { nodes: nodes.filter((n) => !n.__warning), capturedSurfaces: new Set(raw.captured), fullDomStats: raw.fullDomStats };
}

/** CDP forcePseudoState protocol — read effective :hover/:focus/:disabled styles. */
async function capturePseudoStates(context, page, nodes, surfaces) {
  let cdp;
  try {
    cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
  } catch { return; /* CDP unavailable → signifier tier degrades to unverified */ }

  const budgetById = new Map(surfaces.map((s) => [s.id, s.interactiveBudget || 120]));
  const remaining = new Map();
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    for (const node of nodes) {
      if (!node.interactive && !node.focusable && !node.disabled) continue;
      const left = remaining.get(node.surfaceId) ?? budgetById.get(node.surfaceId) ?? 120;
      if (left <= 0) continue;
      remaining.set(node.surfaceId, left - 1);
      try {
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-va-instance="${node.auditInstanceId}"]` });
        if (!nodeId) continue;
        node.pseudo = {};
        for (const [state, pseudo] of [['hover', ['hover']], ['focus', ['focus']], ['focusVisible', ['focus', 'focus-visible']]]) {
          await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: pseudo });
          node.pseudo[state] = await readComputed(page, node.auditInstanceId);
        }
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
        // Matched declarations for provenance (winning-declaration resolution).
        node.declarations = await collectDeclarations(cdp, nodeId);
      } catch { /* per-node failure → leave pseudo unset (degrades, never crashes) */ }
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function readComputed(page, instanceId) {
  return page.evaluate(({ id, props }) => {
    const el = document.querySelector(`[data-va-instance="${id}"]`);
    if (!el) return {};
    const cs = getComputedStyle(el);
    const o = {};
    for (const p of props) o[p] = cs.getPropertyValue(p);
    return o;
  }, { id: instanceId, props: ['outline-style', 'outline-width', 'outline-color', 'box-shadow', 'border-top-color', 'border-top-width', 'background-color', 'color', 'opacity', 'transform', 'text-decoration-line'] });
}

/** Flatten CDP matched rules into RawDeclaration[] for provenance-resolver. */
async function collectDeclarations(cdp, nodeId) {
  try {
    const { matchedCSSRules = [], inlineStyle } = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
    const decls = [];
    matchedCSSRules.forEach((entry, order) => {
      const rule = entry.rule;
      const origin = normalizeCdpOrigin(rule?.origin);
      if (origin === null) return; // `inspector` origin → ignore (never present headless)
      const spec = entry.matchingSelectors?.length ? selectorSpecificity(rule?.selectorList?.selectors, entry.matchingSelectors) : [0, 0, 0];
      for (const d of rule?.style?.cssProperties || []) {
        if (!d.name || d.value == null) continue;
        decls.push({ property: d.name.toLowerCase(), value: d.value, important: !!d.important, specificity: spec, sourceOrder: order, layerOrder: 0, origin });
      }
    });
    // Inline style is author-origin and wins source-order ties (appended last).
    for (const d of inlineStyle?.cssProperties || []) {
      if (!d.name || d.value == null) continue;
      decls.push({ property: d.name.toLowerCase(), value: d.value, important: !!d.important, specificity: [1, 0, 0], sourceOrder: matchedCSSRules.length + 1, layerOrder: 0, origin: 'author' });
    }
    return decls;
  } catch { return []; }
}

/** CDP `CSS.RuleMatch.origin` → our normalized origin (theme-safety plan decision 9):
 *  user-agent → user-agent; regular/injected(+inline) → author; inspector → ignore. */
function normalizeCdpOrigin(o) {
  if (o === 'user-agent') return 'user-agent';
  if (o === 'inspector') return null;
  return 'author'; // regular | injected | undefined
}

/** Rough specificity from the matched selector text (a/b/c counts). */
function selectorSpecificity(selectors, matchingIdx) {
  const sel = selectors?.[matchingIdx[0]]?.text || '';
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const classes = (sel.match(/[.:[][\w-]+/g) || []).length;
  const types = (sel.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  return [ids, classes, types];
}

function resolveMatched(declarations) {
  if (!Array.isArray(declarations) || !declarations.length) return {};
  const matched = {};
  for (const p of ['color', 'background-color', 'border-top-color']) {
    const prov = resolveProvenance(declarations, p);
    if (prov) matched[p] = prov;
  }
  return matched;
}
