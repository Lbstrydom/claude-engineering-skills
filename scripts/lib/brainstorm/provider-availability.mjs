import { azureConfig } from '../config.mjs';

/**
 * Single oracle for "can this brainstorm provider actually be called?".
 *
 * **The question is not "is the public API key set?" — it is "does a route to
 * this provider exist from the active profile?"** The two answers diverged the
 * moment the Azure work profile landed. `openai-adapter.mjs` was moved onto the
 * Azure-aware `createOpenAIClient()` seam on 2026-07-14 *precisely* so
 * /brainstorm's OpenAI voice would work on an Azure-only install — but both
 * dispatch sites in `brainstorm-round.mjs` still short-circuited on
 * `process.env.OPENAI_API_KEY` before the adapter was ever reached, so that
 * branch was unreachable: dead code on exactly the installs it was written for.
 * A consumer reported the symptom on 2026-08-13 — "both providers were
 * unavailable because OPENAI_API_KEY and GEMINI_API_KEY are not configured" —
 * on a repo where every other Azure-routed skill ran fine. The tell in the
 * envelope is `latencyMs: 0`: no call was attempted.
 *
 * Round 1 and the debate round each carried their own copy of the
 * `provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'` ternary, which
 * is why fixing one would silently have left the other wrong. One exported
 * function now owns the read.
 *
 * @typedef {object} ProviderAvailability
 * @property {boolean} available    Whether a call may be attempted at all.
 * @property {'azure'|'public'|null} route  Which profile supplies the credential.
 * @property {string|null} reason   Operator-facing explanation when unavailable;
 *   surfaced verbatim as the provider's `errorMessage` (SKILL.md renders it as
 *   "⚠ Not called: <reason>"), so it names the variable AND the alternative.
 */

/**
 * @param {'openai'|'gemini'} provider
 * @param {object} [options]
 * @param {object} [options.azure] Injected azureConfig snapshot (tests).
 * @param {Record<string,string|undefined>} [options.env] Injected env (tests).
 * @returns {ProviderAvailability}
 */
export function resolveProviderAvailability(provider, options = {}) {
  const azure = options.azure || azureConfig;
  const env = options.env || process.env;
  const has = (name) => Boolean((env[name] || '').trim());

  if (provider === 'openai') {
    // Azure first: when the work profile is active the GPT auditor
    // authenticates via AZURE_OPENAI_API_KEY against a deployment, and
    // OPENAI_API_KEY is not read at all. `buildAzureConfig` refuses to report
    // `active` without both a key and a GPT deployment, so `active` alone is a
    // sufficient test — the same reasoning `openai-audit.mjs` uses at its own
    // key gate.
    if (azure.active) return { available: true, route: 'azure', reason: null };
    if (has('OPENAI_API_KEY')) return { available: true, route: 'public', reason: null };
    return {
      available: false,
      route: null,
      reason: 'OPENAI_API_KEY not set (and no Azure work profile active — set '
        + 'AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY + AZURE_OPENAI_GPT_DEPLOYMENT '
        + 'to route this voice through Azure OpenAI instead)',
    };
  }

  if (provider === 'gemini') {
    if (has('GEMINI_API_KEY')) return { available: true, route: 'public', reason: null };
    // Distinguish the two reasons a Gemini leg is dark. On a public install a
    // key is simply missing; under an active Azure profile there is no Gemini
    // in the tenant at all, so telling the operator to "set GEMINI_API_KEY" is
    // advice they cannot act on. Point them at the substitute instead — which
    // `defaultProviders()` below already picks for them unless they named
    // providers explicitly.
    return {
      available: false,
      route: null,
      reason: azure.active
        ? 'GEMINI_API_KEY not set — the Azure work profile has no Gemini equivalent; '
          + 'use --models openai,azure-claude for the Foundry Claude voice instead'
        : 'GEMINI_API_KEY not set',
    };
  }

  if (provider === 'azure-claude') {
    // Three independent things must hold, and they are separately absent in
    // practice: the profile itself, a resolved route (endpoint + credential +
    // auth mode as ONE unit — never a bare baseURL), and a deployment name.
    if (!azure.active) {
      return {
        available: false,
        route: null,
        reason: 'the Azure work profile is not active — this voice exists only on Azure '
          + '(set AZURE_OPENAI_ENDPOINT, or drop it from --models)',
      };
    }
    if (!azure.claudeRoute?.baseUrl || !azure.claudeRoute?.apiKey) {
      return {
        available: false,
        route: null,
        reason: 'the Azure Claude route did not resolve — check AZURE_CLAUDE_ROUTE '
          + `(apim|foundry) and its credential; run \`npm run azure:routes\` to see which `
          + 'variable each route reads',
      };
    }
    if (!azure.claudeDeployment) {
      return {
        available: false,
        route: null,
        reason: 'AZURE_FOUNDRY_CLAUDE_DEPLOYMENT not set — no Claude deployment to call',
      };
    }
    return { available: true, route: 'azure', reason: null };
  }

  // Unknown providers are an argv-validation failure upstream (`--models`
  // rejects them with exit 1); reaching here is a wiring bug, so throw rather
  // than default to "unavailable" and report a config problem that isn't one.
  throw new Error(`[brainstorm] resolveProviderAvailability: unknown provider "${provider}"`);
}

/**
 * The two voices to call when the user did NOT name providers.
 *
 * The default is "two independent views" — WHICH two is a property of the
 * profile, not a constant. On Azure the Gemini slot is structurally empty, so
 * it is filled by the Foundry Claude voice; that is the same substitution the
 * final reviewer makes, and it is why an Azure user does not have to know a
 * flag exists to get a second opinion.
 *
 * **The public profile is byte-identical to before this substitution existed** —
 * no public install can be moved onto an Azure-only voice, and no default can
 * start spending on a provider the user never configured. An explicit `--models`
 * bypasses this entirely: named providers are called exactly as named.
 *
 * @param {object} [options]
 * @param {object} [options.azure] Injected azureConfig snapshot (tests).
 * @returns {string[]}
 */
export function defaultProviders(options = {}) {
  const azure = options.azure || azureConfig;
  return azure.active ? ['openai', 'azure-claude'] : ['openai', 'gemini'];
}
