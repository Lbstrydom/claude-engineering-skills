/**
 * @fileoverview Azure embedding-deployment verified-candidate selection.
 *
 * NOT "discovery" in the enumerate-everything sense (plan §2 / H1): Azure
 * deployment names are tenant-chosen and need not equal a catalog model id, and
 * there is no data-plane API to list them. So this probes an EXPLICIT, ordered
 * candidate list — configured → user `--candidate` → catalog model ids — and
 * confirms each with a real 1-token embeddings call. The catalog is a
 * candidate-narrowing hint ONLY; presence there is never proof of deployment
 * (INC-002: "set" ≠ "safe to use").
 *
 * The probe returns a TYPED outcome (H5): only a genuine deployment-not-found
 * advances the ladder; auth / throttle / transport / 5xx are terminal `unverified`
 * so a transient failure can never silently repoint the vector space.
 *
 * Client is injected (an OpenAI-shaped client from `createOpenAIClient({purpose:
 * 'embed'})`), so this module is unit-testable without a network.
 *
 * @module scripts/lib/azure/embed-discovery
 */

// Single source of truth for the vector width the runtime requests. The probe
// must ask the same question embedText asks, or "verified" is not "usable".
import { symbolIndexConfig } from '../config.mjs';

/** @enum {string} */
export const ProbeOutcome = Object.freeze({
  VERIFIED: 'verified',     // 200 — selectable
  UNSUPPORTED: 'unsupported', // deployment-not-found — the ONLY outcome that advances the ladder
  UNVERIFIED: 'unverified', // auth/throttle/transport/5xx/malformed — terminal, never advances
});

/**
 * Versioned static fallback used when the catalog can't be listed (plan M3/R6).
 * Ordered by preference so probing is deterministic even without a catalog.
 */
export const STATIC_EMBED_CANDIDATES = Object.freeze([
  'text-embedding-3-large',
  'text-embedding-3-small',
  'text-embedding-ada-002',
]);

const PREFERENCE_INDEX = new Map(STATIC_EMBED_CANDIDATES.map((n, i) => [n, i]));

/** Trim + drop empties, preserving first-seen order (case-sensitive: Azure names are). */
function dedupeOrdered(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const n = typeof raw === 'string' ? raw.trim() : '';
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Classify one probe error into a typed outcome. Only a genuine
 * deployment/model-not-found is `unsupported` (advances); everything else is
 * terminal `unverified`.
 */
function classifyProbeError(err) {
  const status = err?.status ?? err?.response?.status ?? err?.statusCode ?? null;
  const code = String(err?.code ?? err?.error?.code ?? '');
  const msg = String(err?.message ?? err?.error?.message ?? err ?? '');
  const hay = `${code} ${msg}`;
  // A genuine deployment/model-not-found SIGNAL is required to advance the ladder
  // (audit H4/H5). A BARE 404 does NOT qualify: Azure returns 404 for a wrong
  // endpoint host, bad API route/version, or proxy/gateway failure too — treating
  // those as "the deployment doesn't exist" would walk the ladder and present a
  // DIFFERENT deployment as verified, masking an endpoint/config defect. So a
  // 404 (or 400) advances ONLY when the code/message explicitly says not-found;
  // any other error — including a signal-less 404 — is terminal `unverified`.
  const deploymentNotFound = /unknown[_ ]?model|deploymentnotfound|deployment (?:not found|does not exist)|does not exist|no such (?:model|deployment)|model_not_found|resourcenotfound/i.test(hay);
  // A deployment that EXISTS but cannot serve our contract is also "advance",
  // not "stop". `text-embedding-ada-002` has a fixed 1536-vector and rejects the
  // `dimensions` parameter that every real embedText call sends — so without
  // this branch the probe (which now sends `dimensions`) would classify a
  // present-but-unusable deployment as a terminal transient failure and halt
  // the ladder in front of a perfectly good candidate behind it.
  //
  // Same discipline as the not-found rule above: an EXPLICIT signal is required.
  // A bare 400 stays terminal, because that is also what a malformed request or
  // a gateway fault looks like, and advancing on those would repoint the vector
  // space to hide a config defect.
  const contractUnsupported = /dimensions|unsupported[_ ]?parameter|unknown[_ ]?parameter|invalid[_ ]?parameter|extra fields/i.test(hay);
  const isUnsupported = (status === 400 || status === 404) && (deploymentNotFound || contractUnsupported);
  return {
    outcome: isUnsupported ? ProbeOutcome.UNSUPPORTED : ProbeOutcome.UNVERIFIED,
    status,
    detail: msg.slice(0, 200),
  };
}

/**
 * Probe ONE deployment name with a 1-token embeddings call. Typed outcome (H5).
 * @param {{embeddings:{create:Function}}} client
 * @param {string} name - deployment name to try
 * @param {{throttle?: (fn:()=>Promise<any>)=>Promise<any>}} [opts]
 * @returns {Promise<{name:string, outcome:string, status?:number|null, detail?:string}>}
 */
export async function probeDeployment(client, name, opts = {}) {
  // Probe with the SAME `dimensions` the runtime sends. Without it the probe
  // asked a weaker question than embedText does, so a deployment could be
  // stamped `verified` and locked into .env, and then fail on every real call —
  // a green check that never checked the thing that matters. `dimensions` is
  // exactly where that gap lives: ada-002 rejects it outright.
  const dim = opts.dim ?? symbolIndexConfig.embedDim;
  const call = () => client.embeddings.create({ model: name, input: 'ping', dimensions: dim });
  try {
    await (opts.throttle ? opts.throttle(call) : call());
    return { name, outcome: ProbeOutcome.VERIFIED, status: 200 };
  } catch (err) {
    return { name, ...classifyProbeError(err) };
  }
}

/**
 * Narrow the candidate list from the model catalog (plan §2 / M3). Catalog is a
 * HINT — it lists what *could* be deployed, not what is. Degrades to the static
 * list on any non-200 / shape surprise (R6). Never throws.
 * @param {{models?:{list:Function}}} client
 * @returns {Promise<{source:'catalog'|'static', names:string[]}>}
 */
export async function listEmbeddingCandidates(client) {
  try {
    const res = await client.models.list();
    const data = res?.data || res?.body?.data || (Array.isArray(res) ? res : []);
    if (!Array.isArray(data) || data.length === 0) {
      return { source: 'static', names: [...STATIC_EMBED_CANDIDATES] };
    }
    const names = data
      .filter((m) => {
        if (!m || typeof m.id !== 'string') return false;
        // Prefer the capability flags Azure adds; fall back to a name heuristic
        // for SDKs / endpoints that strip them. GA-only when lifecycle is present.
        const embeddable = m.capabilities?.embeddings === true || /embedding/i.test(m.id);
        const ga = m.lifecycle_status ? m.lifecycle_status === 'generally-available' : true;
        return embeddable && ga;
      })
      .map((m) => m.id);
    const deduped = dedupeOrdered(names);
    return deduped.length ? { source: 'catalog', names: deduped } : { source: 'static', names: [...STATIC_EMBED_CANDIDATES] };
  } catch {
    return { source: 'static', names: [...STATIC_EMBED_CANDIDATES] };
  }
}

/** Deterministic catalog ordering (M3): configured-exact, then preference, then lexicographic. */
function sortCatalog(names, configured) {
  return [...names].sort((a, b) => {
    if (a === configured) return -1;
    if (b === configured) return 1;
    const pa = PREFERENCE_INDEX.has(a) ? PREFERENCE_INDEX.get(a) : Infinity;
    const pb = PREFERENCE_INDEX.has(b) ? PREFERENCE_INDEX.get(b) : Infinity;
    if (pa !== pb) return pa - pb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Verified-candidate selection over the ordered source contract (plan §2):
 * configured → user `--candidate` (in given order) → sorted catalog. Probes in
 * order; the FIRST `verified` wins (H11 — no multiple-verified state). A terminal
 * `unverified` stops immediately and offers no replacement (H5).
 *
 * @param {object} args
 * @param {string|null} args.configured - the currently-configured deployment (probed first)
 * @param {string[]} [args.userCandidates] - repeatable `--candidate` values, ordered
 * @param {{embeddings:{create:Function}, models?:{list:Function}}} args.client
 * @param {(fn:()=>Promise<any>)=>Promise<any>} [args.throttle]
 * @param {number} [args.maxProbes] - bounded budget (default 6)
 * @returns {Promise<{status:'verified'|'unverified'|'none-found', selected:string|null,
 *   probed:object[], catalogSource:string, truncatedFrom?:number, reason?:object}>}
 */
export async function selectEmbedDeployment({ configured, userCandidates = [], client, throttle, maxProbes = 6 }) {
  const catalog = await listEmbeddingCandidates(client);
  const ordered = dedupeOrdered([
    configured,
    ...userCandidates,
    ...sortCatalog(catalog.names, configured),
  ]);
  const budget = ordered.slice(0, maxProbes);
  const probed = [];
  for (const name of budget) {
    const r = await probeDeployment(client, name, { throttle });
    probed.push(r);
    if (r.outcome === ProbeOutcome.VERIFIED) {
      return { status: 'verified', selected: name, probed, catalogSource: catalog.source };
    }
    if (r.outcome === ProbeOutcome.UNVERIFIED) {
      // Terminal (H5): a transient/auth/5xx failure must not be "repaired" into a
      // different deployment. Preserve the configured value; offer no replacement.
      return { status: 'unverified', selected: null, probed, catalogSource: catalog.source, reason: r };
    }
    // unsupported → advance to the next candidate
  }
  return {
    status: 'none-found',
    selected: null,
    probed,
    catalogSource: catalog.source,
    ...(ordered.length > budget.length ? { truncatedFrom: ordered.length } : {}),
  };
}

export const _internals = { dedupeOrdered, classifyProbeError, sortCatalog, PREFERENCE_INDEX };
