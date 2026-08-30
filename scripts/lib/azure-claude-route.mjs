/**
 * @fileoverview The Azure Claude transport, resolved as ONE unit.
 *
 * Extracted from `config.mjs` (2026-08-30) so that `anthropic-client.mjs` can
 * consult the SAME oracle without importing `config.mjs`, whose module-level
 * `loadSharedEnv()` side effect injects a developer's personal
 * `~/.audit-loop.env` into any process that merely builds a client — the very
 * credential this module exists to keep off a corporate endpoint. Pure: no
 * imports, no env mutation, no I/O.
 *
 * Scope of that claim, precisely: it holds for the PUBLIC path and for the sync
 * `isClaudeAvailable()`, which are the two places a config import would have
 * been a new side effect. The Azure branch of the client still reaches
 * `config.mjs` transitively through `azure-throttle.mjs` — on that path the
 * profile is active and already validated, so the load is not new. Do not read
 * this file as "anthropic-client never touches config".
 *
 * `config.mjs` re-exports nothing from here; it imports `buildClaudeRoute` and
 * remains the place `azureConfig` is assembled. There is exactly one
 * implementation of the route, in this file.
 *
 * @module scripts/lib/azure-claude-route
 */

/** The two services that can serve Claude in a tenant. */
export const VALID_CLAUDE_ROUTES = new Set(['apim', 'foundry']);

/**
 * Resolve the Claude transport as ONE unit: origin, path, credential, and the
 * header that carries it.
 *
 * Why this exists (incident 2026-08-13). The route used to be assembled from
 * two independent places that no code ever reconciled: `claudeBaseUrl` was
 * hard-wired to `AZURE_AI_ENDPOINT`, while `anthropic-client.mjs` picked the
 * credential by sniffing `AZURE_OPENAI_API_KEY` off the ambient env whenever a
 * baseURL was set, and always sent it as Bearer. On any tenant where those two
 * variables name different services — which is every tenant fronted by APIM —
 * that ships the APIM subscription key to the direct Foundry host and gets a
 * bare 401 naming neither the route nor the credential. It was also
 * *unrepresentable* to point Claude at the APIM route at all: no combination of
 * environment variables could express it.
 *
 * Selection: `AZURE_CLAUDE_ROUTE` when set (explicit always wins); otherwise
 * `foundry` if `AZURE_AI_ENDPOINT` is present — which is exactly today's
 * behaviour, so an existing working Foundry install is unaffected — else `apim`.
 *
 * The `foundry` route prefers a dedicated `AZURE_AI_API_KEY`. It still falls
 * back to `AZURE_OPENAI_API_KEY` (tenants where one key really does serve both,
 * which is the configuration the original Foundry path was verified against),
 * but the fallback is recorded in `credentialShared` so the doctor and the
 * failure message can name it rather than leaving a 401 unexplained.
 *
 * @param {Record<string,string|undefined>} env
 * @param {{openaiEndpoint: string, aiEndpoint: string|null, apiKey: string|null}} endpoints
 * @returns {Readonly<{mode:string, origin:string, baseUrl:string, authMode:string,
 *   apiKey:string|null, credentialVar:string, credentialShared:boolean}>}
 */
export function buildClaudeRoute(env, { openaiEndpoint, aiEndpoint, apiKey }) {
  const requested = (env.AZURE_CLAUDE_ROUTE || '').trim();
  if (requested && !VALID_CLAUDE_ROUTES.has(requested)) {
    throw new Error(
      `[config] Invalid AZURE_CLAUDE_ROUTE="${requested}". ` +
      `Valid values: ${[...VALID_CLAUDE_ROUTES].join(', ')}.`,
    );
  }
  const mode = requested || (aiEndpoint ? 'foundry' : 'apim');

  if (mode === 'foundry') {
    if (!aiEndpoint) {
      throw new Error(
        '[config] AZURE_CLAUDE_ROUTE=foundry requires AZURE_AI_ENDPOINT (the direct ' +
        'AI Foundry inference endpoint). Set it, or use AZURE_CLAUDE_ROUTE=apim to serve ' +
        'Claude through the API Management front-end on AZURE_OPENAI_ENDPOINT.',
      );
    }
    const dedicated = (env.AZURE_AI_API_KEY || '').trim() || null;
    const origin = aiEndpoint.replace(/\/+$/, '');
    return Object.freeze({
      mode: 'foundry',
      origin,
      baseUrl: `${origin}/anthropic`,
      authMode: 'bearer',
      apiKey: dedicated || apiKey,
      credentialVar: dedicated ? 'AZURE_AI_API_KEY' : 'AZURE_OPENAI_API_KEY',
      credentialShared: !dedicated,
    });
  }

  const origin = openaiEndpoint.replace(/\/+$/, '');
  return Object.freeze({
    mode: 'apim',
    origin,
    baseUrl: `${origin}/anthropic`,
    authMode: 'api-key',
    apiKey,
    credentialVar: 'AZURE_OPENAI_API_KEY',
    credentialShared: false,
  });
}

/**
 * The route this environment describes, or `null` when the Azure work profile
 * is not active.
 *
 * `AZURE_OPENAI_ENDPOINT` is the profile's activation switch (AGENTS.md,
 * "Opt-in invariant"), so an unset value returns `null` and every caller keeps
 * its public-path behaviour byte-identical.
 *
 * **Throws when the profile is active but has no credential.** Returning `null`
 * there would be a silent demotion to the public endpoint — and a caller that
 * then supplies `ANTHROPIC_API_KEY` would be reaching a corporate tenant's
 * Claude with a personal key, which is the failure this whole module exists to
 * make unrepresentable. `buildAzureConfig` already refuses the same env, so any
 * process in this state is misconfigured, not merely unlucky.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {ReturnType<typeof buildClaudeRoute>|null}
 */
export function resolveClaudeRouteFromEnv(env = process.env) {
  const openaiEndpoint = (env.AZURE_OPENAI_ENDPOINT || '').trim() || null;
  if (!openaiEndpoint) return null;
  const apiKey = (env.AZURE_OPENAI_API_KEY || '').trim() || null;
  if (!apiKey) {
    throw new Error(
      '[config] AZURE_OPENAI_ENDPOINT is set (Azure work profile active) but ' +
      'AZURE_OPENAI_API_KEY is missing. Set it, or unset AZURE_OPENAI_ENDPOINT ' +
      'to use the public profile.',
    );
  }
  const aiEndpoint = (env.AZURE_AI_ENDPOINT || '').trim() || null;
  return buildClaudeRoute(env, { openaiEndpoint, aiEndpoint, apiKey });
}
