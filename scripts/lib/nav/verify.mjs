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
  let u;
  try { u = new URL(raw, baseUrl || 'http://localhost'); }
  catch { return null; }
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
        // settle delay raced against ANY declared selector. On selector
        // error/absence the selector promise must NOT resolve (a resolving
        // `.catch(()=>{})` would short-circuit the race and skip the settle —
        // consolidated-3); use a never-resolving fallback so the timeout wins.
        await Promise.race([
          page.waitForTimeout(hydrateMs),
          ...(declaredSelectors.length ? [page.waitForSelector(declaredSelectors.join(','), { timeout: hydrateMs }).catch(() => new Promise(() => {}))] : []),
        ]);
        const occ = await collectLiveNav(page, selLayers);
        for (const o of occ) {
          const container = resolveContainer(o.matches, contract);
          liveEvidence.push({
            target: normalizeLiveTarget(o.target, url),
            label: o.label,
            container: container?.selector ?? null,
            layer: container?.layer ?? null,
            state: stateName,
            role: o.role ?? null,
            navIsh: o.navIsh ?? null,   // for bootstrap drafting (no contract)
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
  return page.evaluate((sl) => {
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
      while (cur) {
        if (cur.tagName === 'NAV' || cur.getAttribute?.('role') === 'navigation') return true;
        cur = cur.parentElement;
      }
      return false;
    };
    // Nearest nav-ish container (for bootstrap drafting, no declared selectors):
    // a <nav>/[role=navigation] or an id/class matching nav-ish words.
    const navIsh = (el) => {
      const re = /nav|tabs?|menu|sidebar|toolbar|primary|bottom-?nav|sub-?tabs?/i;
      let cur = el;
      while (cur) {
        const isNav = cur.tagName === 'NAV' || cur.getAttribute?.('role') === 'navigation';
        const id = cur.id || '';
        const cls = (cur.getAttribute?.('class') || '');
        if (isNav || re.test(id) || re.test(cls)) {
          const selector = id ? `#${id}` : (cls.split(/\s+/).find((c) => re.test(c)) ? `.${cls.split(/\s+/).find((c) => re.test(c))}` : (isNav ? 'nav' : null));
          if (selector) return { selector, tag: cur.tagName, role: cur.getAttribute?.('role') || (cur.tagName === 'NAV' ? 'navigation' : null) };
        }
        cur = cur.parentElement;
      }
      return null;
    };
    const record = (el, target, label) => {
      if (!target) return;
      const matches = [];
      for (const { selector, layer } of sl) {
        const d = depthTo(el, selector);
        if (d >= 0) matches.push({ selector, layer, depth: d });
      }
      out.push({ target, label: (label || '').trim().slice(0, 40), role: navRole(el) ? 'navigation' : null, matches, navIsh: navIsh(el) });
    };
    document.querySelectorAll('a[href]').forEach((a) => record(a, a.getAttribute('href'), a.textContent));
    document.querySelectorAll('[data-view],[data-target],[data-nav],[data-tab]').forEach((el) => {
      const t = el.getAttribute('data-view') || el.getAttribute('data-target') || el.getAttribute('data-nav') || el.getAttribute('data-tab');
      record(el, t, el.textContent);
    });
    return out;
  }, selLayers);
}
