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

/**
 * Drive the live app and produce a verify report.
 * @param {object} args
 * @param {string} args.url
 * @param {object} args.model - the static model (buildModel output)
 * @param {object|null} args.contract
 * @param {number} [args.timeoutMs=30000]
 * @param {number} [args.hydrateMs=1500]
 * @returns {Promise<object>} verify report
 */
export async function runVerify({ url, model, contract, timeoutMs = 30000, hydrateMs = 1500 }) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(hydrateMs);

    const liveRaw = await collectLiveNav(page);
    const liveTargets = liveRaw.map((l) => normalizeLiveTarget(l.target, url)).filter(Boolean);
    const staticDests = [...model.destinations.keys()];
    const recon = reconcile(staticDests, liveTargets);

    // Declared persona intents: is each destination present in the landing nav?
    const liveSet = new Set(liveTargets);
    const intentReachability = [];
    for (const p of contract?.personas ?? []) {
      for (const intent of p.intents ?? []) {
        intentReachability.push({
          persona: p.id,
          intent: intent.id,
          destination: intent.destination,
          reachableInLandingNav: liveSet.has(intent.destination),
        });
      }
    }

    return {
      ok: true,
      url,
      liveNavCount: liveRaw.length,
      confirmed: recon.confirmed,
      staticOnly: recon.staticOnly,
      runtimeOnly: recon.runtimeOnly,
      intentReachability,
      sample: liveRaw.slice(0, 25),
    };
  } finally {
    await browser.close();
  }
}

/** Collect candidate nav targets from the live DOM: anchors + view-attr elements. */
async function collectLiveNav(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const push = (target, label, kind) => {
      if (!target) return;
      const k = kind + ':' + target;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ target, label: (label || '').trim().slice(0, 40), kind });
    };
    document.querySelectorAll('a[href]').forEach((a) => push(a.getAttribute('href'), a.textContent, 'link'));
    // vanilla view-switch handles (data-view / data-target / data-nav)
    document.querySelectorAll('[data-view],[data-target],[data-nav],[data-tab]').forEach((el) => {
      const t = el.getAttribute('data-view') || el.getAttribute('data-target') || el.getAttribute('data-nav') || el.getAttribute('data-tab');
      push(t, el.textContent, 'view');
    });
    return out;
  });
}
