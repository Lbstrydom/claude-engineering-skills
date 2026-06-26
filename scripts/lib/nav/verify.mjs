/**
 * @fileoverview `--verify <url>` runtime mode (plan §2.2 trade-off, debt-2).
 *
 * The static graph is a set of HYPOTHESES. Verify drives the live app with
 * Playwright (already a repo dependency) to (1) CONFIRM static destinations that
 * appear in the live nav, (2) flag STATIC-ONLY destinations the live nav doesn't
 * surface (dead/deep-link/gated/extraction-FP), and (3) surface RUNTIME-ONLY nav
 * the static model can't see (role/flag/empty-state-gated) — the thing static
 * analysis fundamentally misses. It also checks declared persona intents are
 * reachable from the landing nav.
 *
 * The reconciliation + live-target normalization are pure (unit-tested); the
 * browser drive is isolated in `runVerify`.
 *
 * @module scripts/lib/nav/verify
 */
import { normalizeDestination } from './normalize.mjs';
import { getPreset } from '../device-presets.mjs';
import { resolveContainer, attributeLive, computeCaptureStatus } from './live-attribution.mjs';

const VIEW_PARAMS = ['view', 'tab', 'page', 'screen'];

/**
 * Normalize a live href/target to the canonical id space the static model uses.
 * Handles query-param view routing (`?view=today` → `today`, matching a VIEWS
 * slug) and path routing (`/wines/123` → `/wines/:param`).
 * @param {string} raw
 * @param {string} [baseUrl] - to resolve relative/origin
 * @returns {string|null}
 */
export function normalizeLiveTarget(raw, baseUrl) {
  if (typeof raw !== 'string' || !raw) return null;
  if (/^(mailto:|tel:|javascript:)/i.test(raw)) return null;
  // Hash-router routes (`#/wines`, `#!/wines`) are real destinations — strip the
  // leading `#`/`#!` and treat the rest as the path (Gemini2-M).
  const hashRoute = raw.match(/^#!?(\/.*)$/);
  if (hashRoute) raw = hashRoute[1];
  // A bare view slug (e.g. `data-nav-view="today"`) — no path/query/hash separator —
  // IS a view id; return it verbatim rather than URL-resolving it (which against a
  // file:// base would mangle it). Matches the static VIEWS-slug destinations.
  if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(raw)) return raw;
  let u;
  try { u = new URL(raw, baseUrl || 'http://localhost'); }
  catch { return null; }
  // External-origin links are NOT internal nav (R1-H): when a real baseUrl is
  // known and an ABSOLUTE href resolves to a different origin, drop it — else
  // `https://docs.other.com/wines` would falsely match the internal `wines`.
  if (baseUrl) {
    let base; try { base = new URL(baseUrl); } catch { base = null; }
    if (base && u.origin !== base.origin) return null;
  }
  // query-param view routing (vanilla SPAs)
  for (const p of VIEW_PARAMS) {
    const v = u.searchParams.get(p);
    if (v) return v;
  }
  let path = u.pathname || '/';
  if (path === '/' && raw.startsWith('#')) return null;
  // Collapse CONCRETE dynamic-looking segments (numeric ids, uuids, long hex) to
  // :param so a live `/wines/123` matches the static pattern `/wines/:param`.
  path = path.split('/').map((seg) =>
    /^\d+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) ? ':param' : seg
  ).join('/');
  return normalizeDestination(path).ids[0] ?? null;
}

/**
 * Reconcile the static destination set against the live nav targets.
 * @param {Iterable<string>} staticDestinations
 * @param {Iterable<string>} liveTargets
 * @returns {{confirmed: string[], staticOnly: string[], runtimeOnly: string[]}}
 */
export function reconcile(staticDestinations, liveTargets) {
  const staticArr = [...staticDestinations].filter((d) => d && d !== '<dynamic>' && !d.startsWith('modal:'));
  const liveArr = [...liveTargets].filter(Boolean);
  // Slug↔path tolerance: many apps surface a view both as a slug (`wines`, from a
  // static VIEWS registry) and as a path (`/wines`, in the live nav). Match on a
  // canonical key (leading slash stripped) so these reconcile, while still
  // reporting the original forms.
  const canon = (d) => d.replace(/^\//, '');
  const liveCanon = new Set(liveArr.map(canon));
  const staticCanon = new Set(staticArr.map(canon));
  const uniq = (a) => [...new Set(a)].sort();
  return {
    confirmed: uniq(staticArr.filter((d) => liveCanon.has(canon(d)))),
    staticOnly: uniq(staticArr.filter((d) => !liveCanon.has(canon(d)))),
    runtimeOnly: uniq(liveArr.filter((d) => !staticCanon.has(canon(d)))),
  };
}

/** Flatten contract.navLayers into [{selector, layer}] for in-page matching. */
export function selectorLayers(contract) {
  const out = [];
  for (const [layer, sels] of Object.entries(contract?.navLayers ?? {})) {
    for (const sel of (Array.isArray(sels) ? sels : [])) out.push({ selector: sel, layer });
  }
  return out;
}

/**
 * Drive the live app across multiple states (viewports × optional auth) and
 * produce a verify report WITH per-occurrence container attribution (plan v1.1).
 * Library function — NEVER calls process.exit; returns {ok:false,...} on failure.
 *
 * @param {object} args
 * @param {string} args.url
 * @param {object} args.model - static model (buildModel output)
 * @param {object|null} args.contract
 * @param {string[]} [args.breakpoints=['mobile','desktop']] - device-presets names
 * @param {string|null} [args.storageState=null] - Playwright storageState path
 * @param {number} [args.timeoutMs=30000]
 * @param {number} [args.hydrateMs=6000] - max settle budget; the populate-wait
 *   resolves early when declared nav containers fill, so fast apps don't pay it.
 *   Auth-gated SPAs mount their nav at ~2–5s, so 1500 was too short.
 * @returns {Promise<object>}
 */
const ACTIVATION_CAP = 8;        // max collapsible-nav activations per viewport (#3)
const ACTIVATE_MS = 1500;        // settle budget after an activation click
const ACTIVATION_FAIL_STOP = 3;  // consecutive unactionable triggers → abort the pass (v1.4)

export async function runVerify({ url, model, contract, breakpoints = ['mobile', 'desktop'], storageState = null, timeoutMs = 30000, hydrateMs = 6000, activate = true }) {
  const selLayers = selectorLayers(contract);
  const declaredSelectors = selLayers.map((s) => s.selector);
  const statesRequested = breakpoints.slice();
  const statesCollected = [];
  const liveEvidence = [];     // one row per occurrence
  const stateWarnings = [];
  const presenceByState = {};  // v1.4: per-state visibility-aware declared-selector presence

  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch (err) { return { ok: false, reason: `playwright not available: ${err.message}`, code: 'NO_PLAYWRIGHT' }; }

  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (err) { return { ok: false, reason: `chromium launch failed: ${err.message}`, code: 'NO_CHROMIUM' }; }

  try {
    for (const stateName of statesRequested) {
      let context;
      try {
        // getPreset inside the try so an invalid breakpoint is a recorded warning,
        // not an unhandled rejection (library never crashes — consolidated-4).
        const preset = getPreset(stateName);
        const viewport = preset?.viewport ?? { width: 1280, height: 720 };
        context = await browser.newContext({ viewport, ...(storageState ? { storageState } : {}) });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        // Settle: wait until EVERY declared container that is PRESENT in the DOM
        // is POPULATED (≥1 child), and at least one is. The earlier `.some` short-
        // circuited the instant ANY container had children — fatal when a STATIC
        // secondary nav is populated at t≈0 but the JS-built primary bottom-bar
        // mounts seconds later (auth-gated SPA): the snapshot captured the pre-
        // hydration shell and the primary nav was never seen (live wine-cellar-app
        // finding, 2026-06-26). `.every`-over-PRESENT fixes it: an empty-but-
        // present late nav (`<nav id="primary-nav">` static-empty) is waited for,
        // while a never-rendered declared selector is simply absent and can't hang
        // the wait. The waitForFunction polls and resolves AS SOON AS the nav
        // populates (≈2–5s here), so the raised hydrateMs cap only bounds the
        // genuinely-never-populating case — fast apps still exit in <1s. Per-
        // selector try/catch (R1-M); on timeout the never-resolving `.catch` lets
        // the waitForTimeout win (consolidated-3).
        const settle = () => Promise.race([
          page.waitForTimeout(hydrateMs),
          ...(declaredSelectors.length ? [page.waitForFunction(
            (sels) => {
              const present = [];
              for (const s of sels) { try { const el = document.querySelector(s); if (el) present.push(el); } catch { /* invalid selector */ } }
              if (!present.length) return false;                       // none present yet — keep waiting (capped)
              return present.every((el) => el.childElementCount > 0);  // all present containers populated
            },
            declaredSelectors,
            { timeout: hydrateMs },
          ).catch(() => new Promise(() => {}))] : []),
        ]);
        // Collect the current DOM into liveEvidence under `evState`. Reused by the
        // base per-viewport snapshot AND each activation-derived state (v1.3 #3).
        const collectState = async (evState) => {
          // v1.4: visibility-aware presence probe — distinguishes a stalled
          // (visible-but-empty) declared container from a responsive hidden one.
          try {
            presenceByState[evState] = await page.evaluate((sels) => {
              const out = {};
              for (const s of sels) {
                try {
                  const el = document.querySelector(s);
                  if (!el) { out[s] = 'absent'; continue; }
                  const cs = getComputedStyle(el); const box = el.getBoundingClientRect();
                  out[s] = (cs.display !== 'none' && cs.visibility !== 'hidden' && (box.width > 0 || box.height > 0)) ? 'visible' : 'hidden';
                } catch { out[s] = 'absent'; }
              }
              return out;
            }, declaredSelectors);
          } catch { /* probe is best-effort */ }
          const shapes = await collectLiveNav(page, selLayers);
          const seen = new Set();
          for (const sh of shapes) {
            const raw = extractTarget(sh);          // pure gate (plan §4a)
            if (!raw) continue;
            const target = normalizeLiveTarget(raw, url);
            if (!target) continue;
            const container = resolveContainer(sh.matches, contract);
            const key = `${target}|${container?.selector ?? ''}|${evState}`;
            if (seen.has(key)) continue;
            seen.add(key);
            liveEvidence.push({
              target, label: sh.label,
              container: container?.selector ?? null, layer: container?.layer ?? null,
              state: evState, role: sh.role ?? null,
              containerCandidates: sh.containerCandidates ?? [],
            });
          }
        };
        await settle();
        await collectState(stateName);
        statesCollected.push(stateName);

        // Bounded activation pass (v1.3 #3): open collapsible nav (hamburger /
        // collapsed sub-tab parents) so destinations behind a closed menu are
        // captured instead of read as "missing". Single-level, navigation-guarded,
        // best-effort additive — a failed activation contributes no evidence and
        // never marks anything `unverified`.
        if (activate) {
          let triggers = [];
          try { triggers = await discoverExpandTriggers(page, declaredSelectors); } catch { triggers = []; }
          // v1.4: adaptive early-stop — if ACTIVATION_FAIL_STOP triggers in a row are
          // unactionable (click THROWS — the cold-init/stall signature), abort the rest
          // so a degraded app's per-trigger goto isolation doesn't keep amplifying the
          // storm. A successful click resets the counter REGARDLESS of new evidence.
          let consecutiveFails = 0;
          for (let i = 0; i < Math.min(triggers.length, ACTIVATION_CAP); i++) {
            const evState = `${stateName}+a${i}`;
            try {
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }); // isolate each
              await settle();
              const handle = await page.$(triggers[i].selector).catch(() => null);
              if (!handle) { stateWarnings.push(`activation ${evState}: trigger no longer present`); continue; }
              const urlBefore = page.url();
              await handle.click({ timeout: 1000 });   // throws if unactionable → counted as a fail below
              consecutiveFails = 0;                     // click succeeded → reset (success regardless of new evidence)
              await page.waitForTimeout(ACTIVATE_MS);
              if (page.url() !== urlBefore) { stateWarnings.push(`activation ${evState}: navigated away — discarded`); continue; }
              await collectState(evState);
              statesCollected.push(evState);
            } catch (err) {
              stateWarnings.push(`activation ${evState} failed: ${err.message}`);
              if (++consecutiveFails >= ACTIVATION_FAIL_STOP) {
                stateWarnings.push(`activation aborted — ${ACTIVATION_FAIL_STOP} consecutive triggers unresponsive; app likely degraded`);
                break;
              }
            }
          }
        }
      } catch (err) {
        stateWarnings.push(`state ${stateName} failed: ${err.message}`);
      } finally {
        if (context) await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (statesCollected.length === 0) {
    return { ok: false, reason: `all states failed: ${stateWarnings.join('; ')}`, code: 'ALL_STATES_FAILED', statesRequested };
  }

  // Filter null/invalid targets; build union for the static reconcile buckets.
  const evidence = liveEvidence.filter((e) => e.target);
  const liveTargets = evidence.map((e) => e.target);
  const recon = reconcile([...model.destinations.keys()], liveTargets);
  const liveAttribution = attributeLive(evidence);

  // v1.4 capture honesty: which declared layers couldn't be verified (stalled or
  // never observable) — so the scorecard/findings degrade to `unverified`.
  const placedContainers = new Set(evidence.map((e) => e.container).filter(Boolean));
  const { captureStatus, unverifiableLayers, absentDeclared } = computeCaptureStatus(presenceByState, placedContainers, selLayers);
  for (const [sel, status] of Object.entries(captureStatus)) {
    if (status === 'empty') stateWarnings.push(`primary capture incomplete — unreliable (${sel})`);
  }
  for (const sel of absentDeclared) stateWarnings.push(`declared container matched no element — check the selector (${sel})`);

  return {
    ok: true,
    url,
    statesRequested,
    statesCollected,
    stateWarnings,
    liveNavCount: evidence.length,
    confirmed: recon.confirmed,
    staticOnly: recon.staticOnly,
    runtimeOnly: recon.runtimeOnly,
    liveEvidence: evidence,
    liveAttribution,
    unverifiableLayers,
    captureStatus,
  };
}

/**
 * Collect nav occurrences from the live DOM. For each anchor/view-handle, record
 * its label, ARIA role/`<nav>` ancestry (corroboration), and — for each DECLARED
 * navLayers selector — whether an ancestor matches and at what DOM depth (so the
 * pure resolveContainer picks the nearest). One row PER OCCURRENCE (not deduped).
 * @param {import('playwright').Page} page
 * @param {Array<{selector,layer}>} selLayers
 */
async function collectLiveNav(page, selLayers) {
  // Pre-filter: clickable tags ∪ enumerated data-* (superset of any target-bearing
  // element — plan §4a). The pure `extractTarget` node-side is the real gate.
  const CANDIDATES = 'a[href],area[href],button,[role=button],[onclick],[tabindex],[data-view],[data-nav-view],[data-target],[data-nav],[data-tab],[data-route],[data-page]';
  return page.evaluate(({ sl, CANDIDATES }) => {
    const out = [];
    const depthTo = (el, sel) => {
      let cur = el; let d = 0;
      while (cur) {
        try { if (cur.matches && cur.matches(sel)) return d; } catch { return -1; }
        cur = cur.parentElement; d++;
      }
      return -1;
    };
    const navRole = (el) => {
      let cur = el;
      while (cur) { if (cur.tagName === 'NAV' || cur.getAttribute?.('role') === 'navigation') return true; cur = cur.parentElement; }
      return false;
    };
    // Nav-ish ancestor CONTAINERS (for bootstrap), excluding page-level wrappers.
    // Each carries a sticky flag (computed position fixed/sticky). NOT counted here
    // (≥2-children is decided node-side post-extractTarget — plan §4a R2-M2).
    const EXCLUDE = new Set(['BODY', 'MAIN', 'HTML', 'HEADER']);
    const re = /nav|tabs?|menu|sidebar|toolbar|primary|bottom-?nav|navbar|tabbar|sub-?tabs?|drawer|hamburger|breadcrumb|secondary/i;
    const containerCandidates = (el) => {
      const cands = [];
      let cur = el.parentElement;
      while (cur) {
        if (!EXCLUDE.has(cur.tagName)) {
          const isNav = cur.tagName === 'NAV' || cur.getAttribute?.('role') === 'navigation';
          const id = cur.id || '';
          const cls = (cur.getAttribute?.('class') || '');
          if (isNav || re.test(id) || re.test(cls)) {
            // CSS.escape so a numeric/special id or class (e.g. `123-nav`) yields a
            // VALID selector in the drafted contract — never `#123-nav` (Gemini-H kernel).
            const esc = (v) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v);
            const clsTok = cls.split(/\s+/).find((c) => re.test(c));
            // Prefer whichever of id/class actually MATCHED the nav-ish regex, so a
            // semantic `.primary-nav` isn't shadowed by a non-semantic `#header-123`
            // (which would also break PRIMARY_RE classification) — Gemini2-M.
            const selector = (id && re.test(id)) ? `#${esc(id)}`
              : (clsTok ? `.${esc(clsTok)}`
              : (id ? `#${esc(id)}` : (isNav ? 'nav' : null)));
            if (selector) {
              let sticky = false;
              try { const p = getComputedStyle(cur).position; sticky = p === 'fixed' || p === 'sticky'; } catch { /* jsdom/headless */ }
              cands.push({ selector, sticky });
            }
          }
        }
        cur = cur.parentElement;
      }
      return cands;
    };
    // Skip elements hidden by display:none / visibility:hidden (on the element or
    // an ancestor) or [hidden] — e.g. an authed app's collapsed signin/signup tabs
    // still live in the DOM but are not real affordances (live wine-cellar finding).
    // visibility:hidden but NOT offsetParent (a fixed bottom-nav has null
    // offsetParent yet is visible), so walk computed display/visibility, not layout.
    const isHidden = (el) => {
      if (el.hidden) return true;
      let cur = el;
      while (cur && cur.nodeType === 1) {
        let st; try { st = getComputedStyle(cur); } catch { return false; }
        if (st && (st.display === 'none' || st.visibility === 'hidden')) return true;
        cur = cur.parentElement;
      }
      return false;
    };
    document.querySelectorAll(CANDIDATES).forEach((el) => {
      if (isHidden(el)) return;
      const dataAttrs = {};
      for (const a of el.attributes) if (a.name.startsWith('data-')) dataAttrs[a.name.slice(5)] = a.value;
      const matches = [];
      for (const { selector, layer } of sl) { const d = depthTo(el, selector); if (d >= 0) matches.push({ selector, layer, depth: d }); }
      out.push({
        tag: el.tagName,
        href: el.getAttribute('href'),
        dataAttrs,
        label: (el.textContent || '').trim().slice(0, 40),
        role: navRole(el) ? 'navigation' : null,
        matches,
        containerCandidates: containerCandidates(el),
      });
    });
    return out;
  }, { sl: selLayers, CANDIDATES });
}

/**
 * Discover collapsible-nav activation triggers (v1.3 #3), in document order, each
 * with a STABLE selector (survives re-goto). Closed, nav-ish-gated set: an
 * `[aria-expanded="false"]` or `[aria-controls]` toggle in a nav-ish context, OR
 * a hamburger affordance. Single-level (base-state triggers only).
 * @param {import('playwright').Page} page
 * @param {string[]} declaredSelectors
 */
async function discoverExpandTriggers(page, declaredSelectors) {
  return page.evaluate((decl) => {
    const re = /nav|tabs?|menu|sidebar|drawer|hamburger|primary|bottom-?nav|navbar|tabbar|sub-?tabs?/i;
    const matchesDecl = (el) => decl.some((s) => { try { return el.matches(s); } catch { return false; } });
    // Is an element nav-ish? <nav>/[role=navigation], or id/class/aria-label match
    // (Gemini-union-H/M: also count the semantic tag/role + aria-label, not only id/class).
    const elNavish = (el) => el.tagName === 'NAV'
      || el.getAttribute?.('role') === 'navigation'
      || re.test(el.id || '')
      || re.test(el.getAttribute?.('class') || '')
      || re.test(el.getAttribute?.('aria-label') || '');
    const navish = (el) => {
      const ctrlId = el.getAttribute('aria-controls');
      if (ctrlId) { const t = document.getElementById(ctrlId); if (t && (elNavish(t) || matchesDecl(t))) return true; }
      let cur = el;
      while (cur && cur.nodeType === 1) { if (elNavish(cur)) return true; cur = cur.parentElement; }
      return false;
    };
    const esc = (v) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v);
    const pathOf = (el) => {
      // Stable structural selector (no live handle) — used only when there's no id.
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && cur.tagName !== 'BODY' && parts.length < 6) {
        let seg = cur.tagName.toLowerCase();
        const sibs = [...(cur.parentElement?.children || [])].filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
        parts.unshift(seg);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    };
    const out = [];
    const seen = new Set();
    const cands = document.querySelectorAll('[aria-expanded="false"], button[aria-controls], [role="button"][aria-controls], [aria-label*="menu" i], .hamburger, [class*="hamburger" i]');
    for (const el of cands) {
      // aria-expanded / aria-controls candidates must be nav-ish (exclude FAQ accordions);
      // the hamburger-affordance ones are nav by definition.
      const needsNavCheck = el.matches('[aria-expanded="false"], [aria-controls]');
      if (needsNavCheck && !navish(el)) continue;
      const selector = el.id ? `#${esc(el.id)}`
        : (el.getAttribute('aria-controls') ? `[aria-controls="${el.getAttribute('aria-controls')}"]` : pathOf(el));
      if (!selector || seen.has(selector)) continue;
      seen.add(selector);
      out.push({ selector });
    }
    return out;
  }, declaredSelectors);
}

// ── Pure target extraction (plan §4a) — exported for deterministic test ──────
const TARGET_LAST_SEG = ['view', 'target', 'route', 'page', 'tab']; // priority order
const TARGET_WHITELIST = new Set(['data-nav', 'data-target', 'data-tab', 'data-route', 'data-page', 'data-view']);

/** Is an href lexically navigational (not js:/mailto:/tel:/bare-anchor)? Hash-router
 *  hrefs (`#/`, `#!`) ARE kept. */
function usableHref(h) {
  if (typeof h !== 'string' || !h) return false;
  if (/^(javascript:|mailto:|tel:)/i.test(h)) return false;
  if (h === '#' || /^#[^/!]/.test(h)) return false; // bare same-page anchor
  return true;
}

/**
 * Resolve a candidate element's nav destination (pure; plan §4a precedence).
 * @param {{href?: string|null, dataAttrs?: Object<string,string>}} shape
 * @returns {string|null} the raw target (pre-normalisation), or null
 */
export function extractTarget(shape) {
  if (!shape) return null;
  if (usableHref(shape.href)) return shape.href;
  const data = shape.dataAttrs || {};
  const matched = [];
  for (const [name, val] of Object.entries(data)) {
    if (!val) continue;
    const lastSeg = name.split('-').pop().toLowerCase();
    if (TARGET_LAST_SEG.includes(lastSeg) || TARGET_WHITELIST.has(`data-${name}`)) {
      matched.push({ name, val, lastSeg });
    }
  }
  if (!matched.length) return null;
  matched.sort((a, b) => {
    const ra = TARGET_LAST_SEG.indexOf(a.lastSeg); const rb = TARGET_LAST_SEG.indexOf(b.lastSeg);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || a.name.localeCompare(b.name);
  });
  return matched[0].val;
}
