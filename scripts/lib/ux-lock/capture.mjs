/**
 * @fileoverview Phase 2 capture library — DOM + network observation against
 * a Playwright `page` for the consistency-mode rig.
 *
 * Plan: docs/plans/persona-test-consistency-mode.md.
 *
 * Design commitments (locked through the audit cycle):
 *   - `page.on('response')` for passive observation (NOT `page.route()`,
 *     which is request interception — wrong API per R4-H1 + Gemini-R1-G3).
 *   - **Cumulative session-wide NetworkGroundTruth store** keyed by surface
 *     tuple — handles SPA cache patterns where navigation doesn't refetch
 *     (Gemini-R2-G1). LRU evicts at the buffer cap.
 *   - DOM stabilisation tick loop after the runner's settle but before
 *     extraction (Gemini-R6-G1): poll the `[data-engine-claim]` content-hash
 *     every 50ms; capture when two consecutive polls match, or a 500ms cap
 *     fires (emit `dom-stabilisation-cap-reached` warning).
 *   - Visibility check uses `getBoundingClientRect` + computed style — no
 *     reliance on Playwright's `isVisible()` (which is async-per-element and
 *     expensive at scale).
 *   - This module knows nothing about `playwright` the npm package; it
 *     operates on whatever `page` object the runner injects. That keeps the
 *     module testable without installing Playwright (Phase 6.5 installs it).
 *
 * @module scripts/lib/ux-lock/capture
 */

const DEFAULT_STABILISE_POLL_MS = 50;
const DEFAULT_STABILISE_CAP_MS  = 500;
const DEFAULT_BUFFER_CAP = (() => {
  const env = parseInt(process.env.PERSONA_CONSISTENCY_BUFFER_CAP, 10);
  return Number.isFinite(env) && env > 0 ? env : 1024;
})();

// ────────────────────────────────────────────────────────────────────────────
// NetworkGroundTruth store — keyed by surface tuple; LRU eviction at cap.
// ────────────────────────────────────────────────────────────────────────────

/**
 * @returns {{
 *   upsert(key: string, entry: object): void,
 *   findFor(surfaceId: string, engineField: string, scope: string|null, key: string|null): object|null,
 *   keys(): string[],
 *   size(): number,
 *   isFull(): boolean,
 *   evictedCount(): number,
 * }}
 */
export function createNetworkGroundTruthStore(opts = {}) {
  const cap = Number.isFinite(opts.cap) && opts.cap > 0 ? opts.cap : DEFAULT_BUFFER_CAP;
  /** @type {Map<string, object>} */
  const entries = new Map();   // insertion order preserves age — Map iteration is FIFO
  let evicted = 0;

  return {
    upsert(key, entry) {
      if (entries.has(key)) {
        entries.delete(key);     // re-insert to refresh LRU position
      } else if (entries.size >= cap) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
        evicted += 1;
      }
      entries.set(key, entry);
    },
    findFor(surfaceId, engineField, scope, key) {
      // Find the most-recent entry matching the surface tuple.
      // Walk in reverse-insertion order so the latest match wins (matches
      // the `winnerRule: 'latest'` default in the manifest schema).
      const tuple = `${surfaceId}::${engineField}::${scope ?? ''}::${key ?? ''}`;
      let found = null;
      for (const [k, v] of entries) {
        if (k === tuple) found = v;        // overwrite — last write wins
      }
      return found;
    },
    keys() { return [...entries.keys()]; },
    size() { return entries.size; },
    isFull() { return entries.size >= cap; },
    evictedCount() { return evicted; },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Response matcher — given a Playwright Response, walk the manifest and
// return zero-or-more `{ key, entry }` records to upsert into the store.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Test if `pattern` matches `subject` as a JavaScript RegExp. Pattern strings
 * compiled lazily; failures return false (don't throw).
 */
function regexMatch(pattern, subject) {
  if (!pattern || typeof subject !== 'string') return false;
  try { return new RegExp(pattern).test(subject); } catch { return false; }
}

function resolveJsonPath(obj, path) {
  if (obj == null || typeof path !== 'string' || path.length === 0) return undefined;
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Match a Playwright response against the manifest's networkSources +
 * collection bindings and produce store entries.
 *
 * @param {{ url(): string, status(): number, request(): {method(): string, postData(): string|null}, json(): Promise<unknown> }} response - duck-typed Playwright Response
 * @param {import('../persona-test/schemas.mjs').SurfaceManifest} manifest
 * @returns {Promise<Array<{ key: string, entry: object }>>}
 */
export async function matchResponseAgainstManifest(response, manifest) {
  const status = typeof response.status === 'function' ? response.status() : response.status;
  if (typeof status !== 'number' || status < 200 || status >= 300) return [];

  const url    = typeof response.url    === 'function' ? response.url()    : response.url;
  const method = response.request?.()?.method?.() ?? 'GET';

  // Body fetch — fail-soft (response body can be unavailable after navigation).
  let body;
  try {
    body = await response.json();
  } catch {
    return [];
  }

  let postBody = null;
  try {
    const raw = response.request?.()?.postData?.();
    if (raw) {
      try { postBody = JSON.parse(raw); } catch { postBody = null; }
    }
  } catch { /* ignore */ }

  const collectionsById = new Map();
  for (const c of manifest.collections || []) collectionsById.set(c.id, c);

  const out = [];

  // For each (surface, engineField with networkSource), see if this response matches.
  for (const surface of manifest.surfaces) {
    for (const field of surface.engineFields) {
      const ns = field.networkSource;
      if (!ns) continue;

      if (!regexMatch(ns.urlPattern, url)) continue;
      if (ns.excludeUrlPattern && regexMatch(ns.excludeUrlPattern, url)) continue;
      if (ns.method && ns.method !== method) continue;
      if (ns.operationName && postBody?.operationName !== ns.operationName) continue;
      if (Array.isArray(ns.requestMatchers) && ns.requestMatchers.length > 0) {
        let allMatched = true;
        for (const rm of ns.requestMatchers) {
          if (rm.location === 'body-json') {
            const v = resolveJsonPath(postBody, rm.jsonPath);
            if (String(v) !== rm.value) { allMatched = false; break; }
          } else if (rm.location === 'query-string') {
            let qs = '';
            try { qs = new URL(url).searchParams.get(rm.jsonPath) ?? ''; } catch { qs = ''; }
            if (qs !== rm.value) { allMatched = false; break; }
          }
        }
        if (!allMatched) continue;
      }

      // Extract the projected value(s).
      if (surface.scope) {
        // Collection-scoped: walk the array, emit per-row entries keyed by keyField.
        const binding = collectionsById.get(surface.scope);
        if (!binding) continue;
        const array = resolveJsonPath(body, binding.jsonPath);
        if (!Array.isArray(array)) continue;

        // The field path begins with `<arrayName>[].` per the contract.
        // Strip the array prefix to get the per-entry path.
        const entryFieldPath = stripCollectionPrefix(field.field, binding.jsonPath);
        for (const row of array) {
          const rowKey = row?.[binding.keyField];
          if (rowKey == null) continue;
          const value = resolveJsonPath(row, entryFieldPath);
          const tuple = `${surface.id}::${field.field}::${surface.scope}::${String(rowKey)}`;
          out.push({
            key: tuple,
            entry: {
              surfaceId: surface.id,
              engineField: field.field,
              scope: surface.scope,
              key: String(rowKey),
              value: value === undefined ? null : value,
              sourceUrl: url,
              receivedAt: new Date().toISOString(),
            },
          });
        }
      } else {
        // Singleton surface — read the jsonPath directly.
        const value = resolveJsonPath(body, ns.jsonPath);
        const tuple = `${surface.id}::${field.field}::::`;
        out.push({
          key: tuple,
          entry: {
            surfaceId: surface.id,
            engineField: field.field,
            scope: null,
            key: null,
            value: value === undefined ? null : value,
            sourceUrl: url,
            receivedAt: new Date().toISOString(),
          },
        });
      }
    }
  }

  return out;
}

// Strip the array prefix from a field path like `wines[].vintage` → `vintage`.
function stripCollectionPrefix(fieldPath, collectionPath) {
  // The convention: field starts with `<collection>[].<rest>`. Strip prefix.
  const marker = '[].';
  const idx = fieldPath.indexOf(marker);
  if (idx === -1) return fieldPath;
  return fieldPath.slice(idx + marker.length);
}

// ────────────────────────────────────────────────────────────────────────────
// Network listener — attaches the response handler and returns the store +
// remove function.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Attach a passive response observer to a Playwright page. The handler runs
 * on every response and upserts matching entries into the cumulative store.
 *
 * @param {{ on(event: string, fn: Function): void, off(event: string, fn: Function): void }} page
 * @param {import('../persona-test/schemas.mjs').SurfaceManifest} manifest
 * @param {object} [opts]
 * @param {number} [opts.cap]            - Store cap; default $PERSONA_CONSISTENCY_BUFFER_CAP or 1024
 * @param {(err: Error) => void} [opts.onError] - Optional sink for handler errors
 * @returns {{ store: ReturnType<typeof createNetworkGroundTruthStore>, removeListener: () => void }}
 */
export function attachNetworkListener(page, manifest, opts = {}) {
  const store = createNetworkGroundTruthStore(opts);

  const handler = async (response) => {
    try {
      const matches = await matchResponseAgainstManifest(response, manifest);
      for (const m of matches) store.upsert(m.key, m.entry);
    } catch (err) {
      if (typeof opts.onError === 'function') {
        try { opts.onError(err); } catch { /* swallow */ }
      }
    }
  };

  page.on('response', handler);
  return {
    store,
    removeListener: () => {
      try { page.off('response', handler); } catch { /* swallow */ }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// DOM stabilisation — wait until the [data-engine-claim] content-hash is
// stable across two consecutive polls, OR the cap fires.
// ────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ evaluate(fn: Function): Promise<unknown> }} page
 * @param {object} [opts]
 * @param {number} [opts.pollMs]
 * @param {number} [opts.capMs]
 * @param {(warning: {kind: string, detail: string}) => void} [opts.warn]
 * @returns {Promise<{ stabilised: boolean, ticks: number }>}
 */
export async function stabiliseDom(page, opts = {}) {
  const pollMs = Number.isFinite(opts.pollMs) && opts.pollMs > 0 ? opts.pollMs : DEFAULT_STABILISE_POLL_MS;
  const capMs  = Number.isFinite(opts.capMs)  && opts.capMs  > 0 ? opts.capMs  : DEFAULT_STABILISE_CAP_MS;
  const start = Date.now();
  let lastSig = null;
  let ticks = 0;

  while (Date.now() - start < capMs) {
    const sig = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[data-engine-claim]'));
      // Stable signature: claim=value@freshness | claim=value@freshness | ...
      const parts = els.map((el) => {
        const c = el.getAttribute('data-engine-claim') || '';
        const v = el.getAttribute('data-engine-value') || '';
        const f = el.getAttribute('data-freshness')   || '';
        const s = el.getAttribute('data-engine-scope') || '';
        const k = el.getAttribute('data-engine-key')   || '';
        return `${c}=${v}@${f}#${s}/${k}`;
      });
      parts.sort();
      return parts.join('|');
    });
    ticks += 1;
    if (lastSig !== null && sig === lastSig) {
      return { stabilised: true, ticks };
    }
    lastSig = sig;
    await new Promise((r) => setTimeout(r, pollMs));
  }

  if (typeof opts.warn === 'function') {
    opts.warn({
      kind: 'dom-stabilisation-cap-reached',
      detail: `DOM did not stabilise within ${capMs}ms (${ticks} ticks)`,
    });
  }
  return { stabilised: false, ticks };
}

// ────────────────────────────────────────────────────────────────────────────
// DOM extraction — pull all `[data-engine-claim]` elements + ancestor scope.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Extract DOM claims from the current page. Reconciles claims against the
 * manifest to determine which are declared (→ domClaims[]) vs undeclared
 * (→ undeclaredDomClaims[]).
 *
 * @param {{ evaluate(fn: Function): Promise<unknown> }} page
 * @param {import('../persona-test/schemas.mjs').SurfaceManifest} manifest
 * @returns {Promise<{
 *   domClaims: object[],
 *   undeclaredDomClaims: { engineField: string, selector: string }[],
 * }>}
 */
export async function extractDomClaims(page, manifest) {
  // Raw extract from browser context.
  const raw = await page.evaluate(() => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return true;
    }
    function pathOf(el) {
      const parts = [];
      let cur = el;
      while (cur && cur !== document.body && cur.nodeType === 1 && parts.length < 8) {
        const tag = cur.tagName.toLowerCase();
        const id = cur.id ? `#${cur.id}` : '';
        const cls = (cur.className && typeof cur.className === 'string')
          ? cur.className.split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('')
          : '';
        parts.unshift(`${tag}${id}${cls}`);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    }
    const els = Array.from(document.querySelectorAll('[data-engine-claim]'));
    return els.map((el) => {
      // Walk ancestors to find data-engine-scope; innermost wins.
      let scope = null;
      let key = null;
      let cur = el;
      while (cur && !scope && cur.nodeType === 1) {
        const s = cur.getAttribute && cur.getAttribute('data-engine-scope');
        if (s) {
          scope = s;
          key = cur.getAttribute('data-engine-key');
        }
        cur = cur.parentElement;
      }
      return {
        engineField: el.getAttribute('data-engine-claim') || '',
        domValueRaw: el.getAttribute('data-engine-value') || '',
        freshness:   el.getAttribute('data-freshness')    || 'absent',
        scope:       scope || null,
        key:         key   || null,
        visible:     visible(el),
        selector:    pathOf(el),
      };
    });
  });

  // Build (scope, field) → surface index — first declaration wins.
  const surfaceByTuple = new Map();
  for (const s of manifest.surfaces) {
    for (const f of s.engineFields) {
      const key = `${s.scope || ''}::${f.field}`;
      if (!surfaceByTuple.has(key)) surfaceByTuple.set(key, s);
    }
  }

  const domClaims = [];
  const undeclaredDomClaims = [];

  for (const c of raw) {
    const key = `${c.scope || ''}::${c.engineField}`;
    const surface = surfaceByTuple.get(key) || surfaceByTuple.get(`::${c.engineField}`);
    if (!surface) {
      undeclaredDomClaims.push({
        engineField: c.engineField,
        selector: c.selector,
      });
      continue;
    }
    domClaims.push({
      surfaceId: surface.id,
      engineField: c.engineField,
      domValueRaw: c.domValueRaw,
      freshness: c.freshness,
      scope: c.scope,
      key: c.key,
      locator: surface.locator,
      visible: c.visible,
    });
  }

  return { domClaims, undeclaredDomClaims };
}

// ────────────────────────────────────────────────────────────────────────────
// captureWitness — the public entry point used by the runner per step.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Capture a WitnessRecord against the current page state. Runs DOM
 * stabilisation, extracts DOM claims, looks up matching network claims in
 * the cumulative store, and returns the assembled record.
 *
 * Synchronous wrt the page object (R1-H1 + Gemini-G1 — the
 * Post-Hoc Execution Fallacy makes this load-bearing).
 *
 * @param {object} page
 * @param {import('../persona-test/schemas.mjs').SurfaceManifest} manifest
 * @param {{ store: ReturnType<typeof createNetworkGroundTruthStore> }} listener
 * @param {object} [opts]
 * @param {number} [opts.stepIndex]
 * @param {(warning: {kind: string, detail: string}) => void} [opts.warn]
 * @returns {Promise<import('../persona-test/schemas.mjs').WitnessRecord>}
 */
export async function captureWitness(page, manifest, listener, opts = {}) {
  // 1. Stabilise the DOM (resolves Gemini-R6-G1).
  await stabiliseDom(page, opts);

  // 2. Extract DOM claims.
  const { domClaims, undeclaredDomClaims } = await extractDomClaims(page, manifest);

  // 3. Resolve network claims from the cumulative store.
  const networkClaims = [];
  let cacheOnly = false;
  for (const dom of domClaims) {
    const net = listener.store.findFor(dom.surfaceId, dom.engineField, dom.scope, dom.key);
    if (net) {
      networkClaims.push(net);
    } else {
      cacheOnly = true;
      if (typeof opts.warn === 'function') {
        opts.warn({
          kind: 'cache-only-network-claim',
          detail: `No network ground-truth for ${dom.surfaceId}.${dom.engineField}${dom.key ? `[${dom.key}]` : ''}`,
        });
      }
    }
  }

  // partialCapture fires when:
  //   - any DOM claim had no matching network entry (cache-only), OR
  //   - the store evicted entries this session (buffer cap hit)
  const partialCapture = cacheOnly || listener.store.isFull();

  return {
    stepIndex: opts.stepIndex ?? 0,
    domClaims,
    networkClaims,
    undeclaredDomClaims,
    partialCapture,
    customClaims: {},
  };
}

// Test-internal exports.
export const _internals = Object.freeze({
  DEFAULT_STABILISE_POLL_MS,
  DEFAULT_STABILISE_CAP_MS,
  DEFAULT_BUFFER_CAP,
  resolveJsonPath,
  regexMatch,
  stripCollectionPrefix,
});
