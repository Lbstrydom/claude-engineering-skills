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
import { resolveContainer, attributeLive } from './live-attribution.mjs';

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
 * @param {number} [args.hydrateMs=1500]
 * @returns {Promise<object>}
 */
export async function runVerify({ url, model, contract, breakpoints = ['mobile', 'desktop'], storageState = null, timeoutMs = 30000, hydrateMs = 1500 }) {
  const selLayers = selectorLayers(contract);
  const declaredSelectors = selLayers.map((s) => s.selector);
  const statesRequested = breakpoints.slice();
  const statesCollected = [];
  const liveEvidence = [];     // one row per occurrence
  const stateWarnings = [];

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
        // Settle delay raced against a declared container becoming POPULATED
        // (≥1 child) — NOT merely present. Late-rendered nav (JS-built bottom
        // bars) leaves the container in the DOM but empty for a beat; waiting on
        // mere existence resolves the race instantly and misses the children
        // (R1-H). Per-selector try/catch so one invalid declared selector can't
        // crash the wait (R1-M). On absence/error the predicate never matches →
        // never-resolving `.catch` → the timeout wins (consolidated-3).
        await Promise.race([
          page.waitForTimeout(hydrateMs),
          ...(declaredSelectors.length ? [page.waitForFunction(
            (sels) => sels.some((s) => { try { const el = document.querySelector(s); return !!el && el.childElementCount > 0; } catch { return false; } }),
            declaredSelectors,
            { timeout: hydrateMs },
          ).catch(() => new Promise(() => {}))] : []),
        ]);
        const shapes = await collectLiveNav(page, selLayers);
        const seen = new Set();
        for (const sh of shapes) {
          const raw = extractTarget(sh);          // pure gate (plan §4a)
          if (!raw) continue;                     // no resolvable nav target → skip
          const target = normalizeLiveTarget(raw, url);
          if (!target) continue;
          const container = resolveContainer(sh.matches, contract);
          // Dedupe by (target, container, state) — a real <a> also caught by the
          // container scan isn't double-counted (plan §4a).
          const key = `${target}|${container?.selector ?? ''}|${stateName}`;
          if (seen.has(key)) continue;
          seen.add(key);
          liveEvidence.push({
            target,
            label: sh.label,
            container: container?.selector ?? null,
            layer: container?.layer ?? null,
            state: stateName,
            role: sh.role ?? null,
            containerCandidates: sh.containerCandidates ?? [], // for bootstrap drafting
          });
        }
        statesCollected.push(stateName);
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
    document.querySelectorAll(CANDIDATES).forEach((el) => {
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
