/**
 * @fileoverview Human- and machine-readable descriptions of the Azure wire
 * routes — **never** the credential values themselves.
 *
 * Why this exists (incident 2026-08-13). A consumer's Azure install failed with
 * a bare `401` from the Claude route and a bare `404` from the GPT route. Both
 * messages named the HTTP status and nothing else: not which endpoint was
 * addressed, not which environment variable supplied the credential, not which
 * auth header carried it. Diagnosing it took a hand-written probe script,
 * because nothing in the tooling could answer "what did you actually send, and
 * where?" — and the wrong first hypothesis (an invalid key) survived for a whole
 * investigation as a result.
 *
 * Every function here reports the credential's SOURCE VARIABLE NAME and its
 * length, never its value. That is the whole point: an operator needs to know
 * *which* secret was used, not what it is.
 *
 * @module scripts/lib/azure-route-report
 */

import { azureConfig as defaultAzureConfig } from './config.mjs';

/**
 * Machine-readable failure classes for an Azure transport error. These name the
 * DEFECT, not the status code — a 404 from a route that does not exist and a
 * 404 from a deployment that does not exist need different fixes.
 */
export const AZURE_FAILURE_CODE = Object.freeze({
  /** The endpoint has no such route/deployment — wrong path or wrong name. */
  DEPLOYMENT_ROUTE_NOT_FOUND: 'DEPLOYMENT_ROUTE_NOT_FOUND',
  /** Authenticated against the wrong service, or with the wrong auth header. */
  AUTH_ENDPOINT_MISMATCH: 'AUTH_ENDPOINT_MISMATCH',
  /** No credential resolved for the selected route. */
  CREDENTIAL_MISSING: 'CREDENTIAL_MISSING',
  /** Network/DNS/TLS/timeout — the endpoint was never reached. */
  TRANSPORT_UNAVAILABLE: 'TRANSPORT_UNAVAILABLE',
});

/** Redact a credential to its provenance: which variable, how long. Never the value. */
function credentialSummary(varName, value) {
  return value
    ? `${varName} (${String(value).length} chars)`
    : `${varName} (UNSET)`;
}

/**
 * Structured, secret-free description of the Claude route.
 * @param {object} [cfg] - an azureConfig snapshot
 * @returns {object|null} null when the Azure profile is inactive
 */
export function claudeRouteReport(cfg = defaultAzureConfig) {
  if (!cfg?.active || !cfg.claudeRoute) return null;
  const r = cfg.claudeRoute;
  // `endpointOrigin` is scheme+host ONLY and `finalPath` carries the whole path,
  // so a caller can concatenate them without doubling an endpoint base path such
  // as APIM's `/foundry`.
  return {
    surface: 'claude',
    provider: 'azure',
    route: r.mode,
    apiShape: cfg.claudeApiShape,
    endpointOrigin: new URL(r.baseUrl).origin,
    // The SDK appends `/v1/messages` to the base for the native Anthropic shape.
    finalPath: cfg.claudeApiShape === 'anthropic'
      ? `${new URL(r.baseUrl).pathname.replace(/\/+$/, '')}/v1/messages`
      : `${new URL(r.baseUrl + cfg.foundryApiPath).pathname.replace(/\/+$/, '')}/chat/completions`,
    requestedModel: cfg.claudeDeployment,
    wireDeployment: cfg.claudeDeployment,
    apiVersion: cfg.claudeApiShape === 'anthropic' ? null : cfg.apiVersion,
    credentialSource: r.credentialVar,
    credentialPresent: !!r.apiKey,
    credentialShared: r.credentialShared,
    authMode: r.authMode,
  };
}

/**
 * Structured, secret-free description of a deployment-qualified GPT/embed route.
 * @param {'gpt'|'embed'} purpose
 * @param {object} [cfg]
 * @returns {object|null}
 */
export function openAiRouteReport(purpose, cfg = defaultAzureConfig) {
  if (!cfg?.active) return null;
  const deployment = purpose === 'embed' ? cfg.embedDeployment : cfg.gptDeployment;
  const endpoint = new URL(String(cfg.openaiEndpoint).replace(/\/+$/, ''));
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  return {
    surface: purpose,
    provider: 'azure',
    route: 'deployment-qualified',
    apiShape: 'openai',
    // scheme+host only — `finalPath` carries the endpoint's own base path (e.g.
    // APIM's `/foundry`), so the two concatenate without doubling it.
    endpointOrigin: endpoint.origin,
    // The Responses API is deliberately NOT deployment-qualified (Azure's own
    // design); chat/completions and embeddings are.
    finalPath: purpose === 'embed'
      ? `${basePath}/openai/deployments/${deployment}/embeddings`
      : `${basePath}/openai/responses`,
    requestedModel: purpose === 'embed' ? cfg.embedDeployment : cfg.gptDeployment,
    wireDeployment: deployment,
    apiVersion: cfg.deploymentApiVersion,
    credentialSource: 'AZURE_OPENAI_API_KEY',
    credentialPresent: !!cfg.apiKey,
    credentialShared: false,
    authMode: 'api-key',
  };
}

/**
 * One-line route suffix for a log line. Empty string for non-Azure providers, so
 * callers can interpolate it unconditionally.
 * @param {string} provider - a final-review provider id
 * @param {object} [cfg]
 * @returns {string}
 */
export function describeAzureRoute(provider, cfg = defaultAzureConfig) {
  if (provider !== 'azure-claude') return '';
  const r = cfg?.claudeRoute;
  if (!r) return '';
  return ` · route=${r.mode} · endpoint=${r.origin} · auth=${r.authMode} from `
    + `${credentialSummary(r.credentialVar, r.apiKey)}${r.credentialShared ? ' [SHARED across services]' : ''}`;
}

/**
 * Classify an Azure transport error.
 * @param {any} err
 * @returns {string} one of AZURE_FAILURE_CODE
 */
export function classifyAzureTransportFailure(err) {
  const status = err?.status ?? err?.response?.status ?? null;
  if (status === 404) return AZURE_FAILURE_CODE.DEPLOYMENT_ROUTE_NOT_FOUND;
  if (status === 401 || status === 403) return AZURE_FAILURE_CODE.AUTH_ENDPOINT_MISMATCH;
  if (status == null) return AZURE_FAILURE_CODE.TRANSPORT_UNAVAILABLE;
  return AZURE_FAILURE_CODE.TRANSPORT_UNAVAILABLE;
}

/**
 * Render a transport failure with enough route provenance to act on it.
 *
 * For a non-Azure provider this is the plain `err.message`, byte-identical to
 * what callers printed before. For the Azure Claude route it appends the
 * failure class and the route/credential provenance, because a bare
 * "401 Access denied" is indistinguishable between "the key is wrong" and "the
 * key is right but addressed at the wrong service" — which is precisely the
 * distinction the 2026-08-13 investigation had to make by hand.
 *
 * @param {any} err
 * @param {string} provider
 * @param {object} [cfg]
 * @returns {string}
 */
export function describeTransportFailure(err, provider, cfg = defaultAzureConfig) {
  const base = err?.message || String(err);
  if (provider !== 'azure-claude') return base;
  const r = cfg?.claudeRoute;
  if (!r) return base;
  const code = classifyAzureTransportFailure(err);
  const lines = [
    `${base}`,
    `  ${code} on the "${r.mode}" Claude route`,
    `  endpoint : ${r.baseUrl}`,
    `  auth     : ${r.authMode} header, from ${credentialSummary(r.credentialVar, r.apiKey)}`,
  ];
  if (!r.apiKey) {
    lines.push(`  → ${AZURE_FAILURE_CODE.CREDENTIAL_MISSING}: set ${r.credentialVar}.`);
  } else if (code === AZURE_FAILURE_CODE.AUTH_ENDPOINT_MISMATCH) {
    lines.push(r.credentialShared
      ? `  → ${r.credentialVar} is being sent to a DIFFERENT service than the one it belongs to. `
        + `If Claude is served through your API Management front-end, set AZURE_CLAUDE_ROUTE=apim; `
        + `if it is served by AI Foundry directly, set AZURE_AI_API_KEY to the Foundry key.`
      : `  → the credential in ${r.credentialVar} was rejected by ${r.origin}. `
        + `Confirm it belongs to that service, and that AZURE_CLAUDE_ROUTE=${r.mode} is the right route.`);
  } else if (code === AZURE_FAILURE_CODE.DEPLOYMENT_ROUTE_NOT_FOUND) {
    lines.push(`  → no such route or deployment. Check AZURE_FOUNDRY_CLAUDE_DEPLOYMENT="${cfg.claudeDeployment}" `
      + `and whether ${r.origin} serves Claude at /anthropic.`);
  }
  lines.push('  Run `npm run azure:doctor -- --routes` for the full route table.');
  return lines.join('\n');
}
