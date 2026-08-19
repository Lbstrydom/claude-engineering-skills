/**
 * @fileoverview Shared candidate-ladder walk for Azure deployment discovery.
 *
 * `embed-discovery.mjs` (the original, deployment-qualified surface) owns its
 * own walk because it also carries surface-specific concerns (the `dimensions`
 * echo-defense, per-candidate client construction as the DEFAULT). The GPT and
 * Claude probes added alongside it (`gpt-discovery.mjs`, `claude-discovery.mjs`)
 * differ from it in what a probe call looks like and how their errors classify,
 * but share one mechanical shape with each other and with it: walk an ordered,
 * deduped candidate list, probe each, stop at the first `verified` or the first
 * terminal `unverified` (H5 — a transient/auth/5xx failure must never be
 * "repaired" into a different deployment), and never probe more than
 * `maxProbes`. This module owns exactly that shape for the two new surfaces;
 * `embed-discovery.mjs` is left as-is to avoid regression risk on tested code.
 *
 * @module scripts/lib/azure/deployment-ladder
 */

/** @enum {string} */
export const ProbeOutcome = Object.freeze({
  VERIFIED: 'verified',       // 200 — selectable
  UNSUPPORTED: 'unsupported', // deployment/model-not-found — the ONLY outcome that advances the ladder
  UNVERIFIED: 'unverified',   // auth/throttle/transport/5xx/malformed — terminal, never advances
});

/** Trim + drop empties, preserving first-seen order (case-sensitive: Azure names are). */
export function dedupeOrdered(names) {
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
 * A genuine deployment/model-not-found SIGNAL is required to advance the
 * ladder — a BARE 404/400 does not qualify: Azure returns those for a wrong
 * endpoint host, bad route/version, or proxy/gateway failure too, and treating
 * those as "the deployment doesn't exist" would walk the ladder and present a
 * DIFFERENT deployment as verified, masking an endpoint/config defect instead
 * of surfacing it. Same regex embed-discovery.mjs uses (battle-tested there).
 */
const DEPLOYMENT_NOT_FOUND_RE = /unknown[_ ]?model|deploymentnotfound|deployment (?:not found|does not exist)|does not exist|no such (?:model|deployment)|model_not_found|resourcenotfound/i;

/**
 * Classify one probe error against the shared not-found contract. Only a
 * genuine deployment/model-not-found is `unsupported` (advances); everything
 * else — including a signal-less 404 — is terminal `unverified`.
 * @param {any} err
 * @returns {{outcome:string, status:number|null, detail:string}}
 */
export function classifyDeploymentNotFound(err) {
  const status = err?.status ?? err?.response?.status ?? err?.statusCode ?? null;
  const code = String(err?.code ?? err?.error?.code ?? err?.type ?? err?.error?.type ?? '');
  const msg = String(err?.message ?? err?.error?.message ?? err ?? '');
  const hay = `${code} ${msg}`;
  const isUnsupported = (status === 400 || status === 404) && DEPLOYMENT_NOT_FOUND_RE.test(hay);
  return {
    outcome: isUnsupported ? ProbeOutcome.UNSUPPORTED : ProbeOutcome.UNVERIFIED,
    status,
    detail: msg.slice(0, 200),
  };
}

/**
 * Walk an ordered candidate list, probing each with `probeOne(name)` until the
 * first `verified` (returns it) or the first terminal `unverified` (stops, no
 * replacement — H5). Bounded by `maxProbes`.
 *
 * @param {object} args
 * @param {string[]} args.ordered - deduped candidate names, in probe order
 * @param {(name:string)=>Promise<{name:string, outcome:string, status?:number|null, detail?:string}>} args.probeOne
 * @param {number} [args.maxProbes]
 * @param {string} args.catalogSource
 * @returns {Promise<{status:'verified'|'unverified'|'none-found', selected:string|null,
 *   probed:object[], catalogSource:string, truncatedFrom?:number, reason?:object}>}
 */
export async function walkLadder({ ordered, probeOne, maxProbes = 6, catalogSource }) {
  const budget = ordered.slice(0, maxProbes);
  const probed = [];
  for (const name of budget) {
    const r = await probeOne(name);
    probed.push(r);
    if (r.outcome === ProbeOutcome.VERIFIED) {
      return { status: 'verified', selected: name, probed, catalogSource };
    }
    if (r.outcome === ProbeOutcome.UNVERIFIED) {
      return { status: 'unverified', selected: null, probed, catalogSource, reason: r };
    }
    // unsupported → advance to the next candidate
  }
  return {
    status: 'none-found',
    selected: null,
    probed,
    catalogSource,
    ...(ordered.length > budget.length ? { truncatedFrom: ordered.length } : {}),
  };
}

export const _internals = { DEPLOYMENT_NOT_FOUND_RE };
