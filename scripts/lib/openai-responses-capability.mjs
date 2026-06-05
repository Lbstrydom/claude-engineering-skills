/**
 * @fileoverview Responses-API capability classifier for the Azure chat-deployment
 * fallback.
 *
 * Plan: docs/plans/azure-work-profile.md §2 (H3). The GPT auditor calls
 * `openai.responses.parse()`. On the Azure v1 surface a *chat* deployment
 * (e.g. `gpt-5.3-chat`) may not expose the Responses route, so the auditor
 * falls back to chat-completions + `zodResponseFormat`.
 *
 * **AGENTS.md forbids retrying 404** (it's a client error — wrong endpoint /
 * deployment / api-version). So a bare 404 must NOT silently trigger the
 * fallback: it's almost always a misconfiguration that should surface, not be
 * masked by a second request shape. The fallback fires ONLY on a *positive,
 * known Responses-unsupported signal*; everything else is fatal.
 *
 * @module scripts/lib/openai-responses-capability
 */

/**
 * Classify an error thrown by `responses.parse()`.
 *
 * Returns `'unsupported'` ONLY when the error positively indicates the
 * Responses *operation/route* is unavailable for an otherwise-valid deployment
 * (chat-only deployment). Any other error — including a generic 404, a
 * deployment-not-found, an auth/quota error — returns `'fatal'` so the caller
 * surfaces `err.status` + the real provider message (per AGENTS.md) rather than
 * masking a misconfiguration.
 *
 * Conservative by design: when in doubt, `'fatal'`.
 *
 * @param {{status?:number, code?:string, message?:string, error?:{code?:string,message?:string,type?:string}}} err
 * @returns {'unsupported'|'fatal'}
 */
export function classifyResponsesSupport(err) {
  if (!err || typeof err !== 'object') return 'fatal';

  const status = Number(err.status ?? err.statusCode ?? err?.error?.status);
  const code = String(err.code ?? err?.error?.code ?? '').toLowerCase();
  const type = String(err?.error?.type ?? '').toLowerCase();
  const msg = String(err.message ?? err?.error?.message ?? '').toLowerCase();

  // A deployment-not-found 404 is a CONFIG error, never "unsupported route".
  // Distinguish it explicitly so we don't fall back on a typo'd deployment.
  const looksLikeDeploymentNotFound =
    msg.includes('deployment') && (msg.includes('not found') || msg.includes('does not exist'));
  if (looksLikeDeploymentNotFound) return 'fatal';

  // Positive "Responses route unsupported" signals. Require the word
  // "responses" to co-occur with an unsupported/not-found marker, OR an
  // explicit unsupported-operation code. This keeps generic 404s fatal.
  const mentionsResponses = msg.includes('responses') || code.includes('responses');
  const unsupportedMarker =
    code.includes('unsupported') ||
    type.includes('unsupported') ||
    msg.includes('not supported') ||
    msg.includes('unsupported') ||
    msg.includes('unknown operation') ||
    msg.includes('no longer supported') ||
    (status === 404 && (msg.includes('responses') || code.includes('responses')));

  if (mentionsResponses && unsupportedMarker) return 'unsupported';

  return 'fatal';
}
