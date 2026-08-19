/**
 * @fileoverview Azure GPT-deployment verified-candidate selection.
 *
 * Sibling of `embed-discovery.mjs`, extended to the `AZURE_OPENAI_GPT_DEPLOYMENT`
 * slot (the gap this closes: the embed slot had probe→select→confirm→persist
 * discovery, GPT and Claude did not — a new tenant deployment had to be found by
 * hand-writing a one-off probe script and confirming it worked before editing
 * `.env`).
 *
 * Probes an EXPLICIT, ordered candidate list — configured → user `--candidate` →
 * the same `STATIC_POOL.openai` names the public-profile sentinel resolver
 * already trusts as "known current models" (`model-resolver.mjs`). That list is
 * a candidate-narrowing hint ONLY, same discipline as the embed module: an Azure
 * deployment NAME is tenant-chosen and need not match a catalog model id, and
 * presence in the pool is never proof of deployment.
 *
 * No live catalog listing here (unlike embed): the GPT client can only be
 * constructed once a deployment name is known (`createOpenAIClient`'s Azure
 * `gpt` purpose requires one at construction, see `openai-client.mjs`
 * `azureDeploymentFor`), so there is no "already-working" client available to
 * list from before a candidate has verified. This matches the plan's own
 * non-goal: probe, don't enumerate.
 *
 * The deployment is baked into the URL path for `embeddings`/`chat/completions`
 * but the Responses API (what the GPT auditor calls) is deliberately NOT
 * deployment-qualified by Azure's own design (`azure-route-report.mjs`) — the
 * `model` BODY field is what actually selects the deployment on the wire. A
 * `clientFor` per candidate is still used here (matching embed's shape) because
 * `createOpenAIClient({purpose:'gpt'})` requires a truthy deployment to
 * construct at all, so a fresh/unconfigured install needs a per-candidate
 * client just to get past that guard — not because the Responses route reads
 * the constructor value.
 *
 * @module scripts/lib/azure/gpt-discovery
 */

import { STATIC_POOL } from '../model-resolver.mjs';
import { ProbeOutcome, dedupeOrdered, classifyDeploymentNotFound, walkLadder } from './deployment-ladder.mjs';

export { ProbeOutcome };

/** Same ids the public-profile `latest-gpt`/`latest-gpt-mini` sentinels resolve from. */
export const STATIC_GPT_CANDIDATES = Object.freeze([...STATIC_POOL.openai]);

/**
 * Probe ONE deployment name with a minimal Responses API call.
 *
 * @param {string} name - deployment name to try
 * @param {(name:string)=>Promise<{responses:{create:Function}}>} clientFor - build a
 *   client pinned to this candidate (REQUIRED — see module header)
 * @param {{throttle?: (fn:()=>Promise<any>)=>Promise<any>}} [opts]
 * @returns {Promise<{name:string, outcome:string, status?:number|null, detail?:string}>}
 */
export async function probeGptDeployment(name, clientFor, opts = {}) {
  try {
    const client = await clientFor(name);
    const call = () => client.responses.create({ model: name, input: 'ping', max_output_tokens: 16 });
    await (opts.throttle ? opts.throttle(call) : call());
    return { name, outcome: ProbeOutcome.VERIFIED, status: 200 };
  } catch (err) {
    return { name, ...classifyDeploymentNotFound(err) };
  }
}

/**
 * Verified-candidate selection over the ordered source contract: configured →
 * user `--candidate` (in given order) → `STATIC_GPT_CANDIDATES`. Probes in
 * order; the FIRST `verified` wins. A terminal `unverified` stops immediately
 * and offers no replacement.
 *
 * @param {object} args
 * @param {string|null} args.configured - the currently-configured deployment (probed first)
 * @param {string[]} [args.userCandidates] - repeatable `--candidate` values, ordered
 * @param {(name:string)=>Promise<{responses:{create:Function}}>} args.clientFor - build a
 *   client pinned to one candidate deployment (required — see module header)
 * @param {(fn:()=>Promise<any>)=>Promise<any>} [args.throttle]
 * @param {number} [args.maxProbes] - bounded budget (default 6)
 * @returns {Promise<{status:'verified'|'unverified'|'none-found', selected:string|null,
 *   probed:object[], catalogSource:string, truncatedFrom?:number, reason?:object}>}
 */
export async function selectGptDeployment({ configured, userCandidates = [], clientFor, throttle, maxProbes = 6 }) {
  const ordered = dedupeOrdered([configured, ...userCandidates, ...STATIC_GPT_CANDIDATES]);
  return walkLadder({
    ordered,
    probeOne: (name) => probeGptDeployment(name, clientFor, { throttle }),
    maxProbes,
    catalogSource: 'static',
  });
}
