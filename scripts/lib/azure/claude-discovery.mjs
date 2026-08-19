/**
 * @fileoverview Azure Claude-deployment verified-candidate selection.
 *
 * Sibling of `gpt-discovery.mjs` for the `AZURE_FOUNDRY_CLAUDE_DEPLOYMENT` slot.
 * See `gpt-discovery.mjs`'s header for the gap this closes and why the catalog
 * is a static, offline hint rather than a live listing.
 *
 * Unlike the GPT/embed surfaces, the Claude deployment is NOT constructor-level
 * route state on `createAnthropicClient` — it resolves `azureRoute`
 * (endpoint + credential + auth header, see `config.mjs` `claudeRoute`)
 * independently of any deployment name, and the deployment is sent purely as
 * the `model` BODY field on `messages.create` (mirrors `route-doctor.mjs`'s
 * claude probe). So ONE client probes every candidate — no `clientFor` needed.
 *
 * @module scripts/lib/azure/claude-discovery
 */

import { STATIC_POOL } from '../model-resolver.mjs';
import { ProbeOutcome, dedupeOrdered, classifyDeploymentNotFound, walkLadder } from './deployment-ladder.mjs';

export { ProbeOutcome };

/** Same ids the public-profile `latest-opus`/`latest-sonnet`/`latest-haiku` sentinels resolve from. */
export const STATIC_CLAUDE_CANDIDATES = Object.freeze([...STATIC_POOL.anthropic]);

/**
 * Probe ONE deployment name with a minimal Messages API call.
 *
 * @param {{messages:{create:Function}}} client - a single client shared across candidates
 * @param {string} name - deployment name to try
 * @param {{throttle?: (fn:()=>Promise<any>)=>Promise<any>}} [opts]
 * @returns {Promise<{name:string, outcome:string, status?:number|null, detail?:string}>}
 */
export async function probeClaudeDeployment(client, name, opts = {}) {
  try {
    const call = () => client.messages.create({
      model: name, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }],
    });
    await (opts.throttle ? opts.throttle(call) : call());
    return { name, outcome: ProbeOutcome.VERIFIED, status: 200 };
  } catch (err) {
    return { name, ...classifyDeploymentNotFound(err) };
  }
}

/**
 * Verified-candidate selection over the ordered source contract: configured →
 * user `--candidate` (in given order) → `STATIC_CLAUDE_CANDIDATES`. Probes in
 * order; the FIRST `verified` wins. A terminal `unverified` stops immediately
 * and offers no replacement.
 *
 * @param {object} args
 * @param {string|null} args.configured - the currently-configured deployment (probed first)
 * @param {string[]} [args.userCandidates] - repeatable `--candidate` values, ordered
 * @param {{messages:{create:Function}}} args.client - shared probe client (see module header)
 * @param {(fn:()=>Promise<any>)=>Promise<any>} [args.throttle]
 * @param {number} [args.maxProbes] - bounded budget (default 6)
 * @returns {Promise<{status:'verified'|'unverified'|'none-found', selected:string|null,
 *   probed:object[], catalogSource:string, truncatedFrom?:number, reason?:object}>}
 */
export async function selectClaudeDeployment({ configured, userCandidates = [], client, throttle, maxProbes = 6 }) {
  const ordered = dedupeOrdered([configured, ...userCandidates, ...STATIC_CLAUDE_CANDIDATES]);
  return walkLadder({
    ordered,
    probeOne: (name) => probeClaudeDeployment(client, name, { throttle }),
    maxProbes,
    catalogSource: 'static',
  });
}
