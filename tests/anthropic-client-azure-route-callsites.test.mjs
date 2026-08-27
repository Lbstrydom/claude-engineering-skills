/**
 * @fileoverview Guard against the `baseURL: azureConfig.claudeBaseUrl` anti-pattern.
 *
 * `createAnthropicClient()` picks its Azure auth header from an explicit
 * `azureRoute` option (apim -> `api-key`, foundry -> `Authorization: Bearer`).
 * Without it, `azureAuthMode` silently defaults to `'bearer'` — on an
 * APIM-fronted tenant that is a bare 401 with no route name or credential
 * name in the error (see tests/azure-claude-route.test.mjs, incident
 * 2026-08-13). `gemini-review.mjs` was fixed at the time; two other call
 * sites (`scripts/symbol-index/summarise.mjs`,
 * `scripts/symbol-index/summarise-domains.mjs`) were never touched and kept
 * passing `{ baseURL: azureConfig.claudeBaseUrl }` — silently 401ing on any
 * APIM tenant, degrading to empty summaries/embeddings rather than erroring
 * loud (reported from a consumer, fixed 2026-08-27).
 *
 * This scans every script under `scripts/` for that exact anti-pattern
 * (a `createAnthropicClient(...)` call whose options object sets `baseURL`
 * from `azureConfig` instead of passing `azureRoute`) so a future new call
 * site can't reintroduce it silently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPTS_ROOT = path.join(REPO_ROOT, 'scripts');

// The defect shape itself: an options object passed to createAnthropicClient
// that derives `baseURL` from `azureConfig` rather than passing `azureRoute`.
const BAD_BASEURL_RE = /createAnthropicClient\(\s*\{[^}]*baseURL:\s*azureConfig\b[^}]*\}\s*\)/;

function* allScriptFiles() {
  for (const rel of fs.readdirSync(SCRIPTS_ROOT, { recursive: true })) {
    if (!rel.endsWith('.mjs') && !rel.endsWith('.js')) continue;
    // The generated consumer bundle is a byte copy of scripts/**; scanning it
    // too would just double-report the same source defect.
    if (rel.split(path.sep).includes('.claude-skills')) continue;
    const abs = path.join(SCRIPTS_ROOT, rel);
    if (!fs.statSync(abs).isFile()) continue;
    yield { rel: path.join('scripts', rel), abs };
  }
}

test('no createAnthropicClient() call site derives baseURL from azureConfig instead of passing azureRoute', () => {
  const offenders = [];
  for (const { rel, abs } of allScriptFiles()) {
    const content = fs.readFileSync(abs, 'utf-8');
    if (BAD_BASEURL_RE.test(content)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    'createAnthropicClient({ baseURL: azureConfig... }) found — this silently defaults the Azure ' +
    'auth header to Bearer and 401s on an APIM-fronted tenant. Pass `{ azureRoute: azureConfig.claudeRoute }` ' +
    '(or a resolved per-candidate route) instead, as gemini-review.mjs does.',
  );
});
