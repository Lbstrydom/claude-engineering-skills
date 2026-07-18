/**
 * @fileoverview Test runner shim — spawns `node --test` with the AMBIENT
 * provider-ROUTING env scrubbed, so the suite's verdict is a function of the
 * repo, never of the operator's shell.
 *
 * **Why a runner and not a per-suite scrub or a preload** (all three were
 * tried or probed before this shape was chosen, 2026-07-18):
 *
 * - Per-suite `beforeEach` scrubbing CANNOT work for Azure routing:
 *   `azureConfig` is a module-load-time snapshot (`buildAzureConfig(process.env)`
 *   in config.mjs), frozen before any test hook runs. The anthropic-client
 *   suite's beforeEach scrub works only because that client resolves env at
 *   CALL time — mirroring the pattern here would have been a fake fix that
 *   scrubs after the routing decision is already taken.
 * - `node --test --import <scrub>` does NOT propagate the preload to the test
 *   runner's per-file child processes (probed empirically on Node 22.19) —
 *   only the coordinator process would be scrubbed.
 * - Per-test-file "import the scrub first" is per-file discipline, and
 *   scrub-list-vs-resolution-list drift is this week's demonstrated failure
 *   mode (the anthropic hygiene block saved 3 of the 4 vars the factory
 *   resolves). One choke point beats N conventions.
 *
 * **The trust boundary this enforces**: the repo's own `.env` (loaded by
 * dotenv transitively via model-resolver → config) and `~/.audit-loop.env`
 * are TRUSTED config — dotenv loads them inside each child AFTER this scrub,
 * so their values survive. The ambient shell is NOT trusted: agent harnesses
 * inject provider vars into every shell they spawn (Claude Code desktop
 * injects `ANTHROPIC_BASE_URL`; found 2026-07-18 when 15 tests failed inside
 * the harness and passed outside it), and corporate machines carry work-profile
 * Azure vars. Empirically, before this runner: a hostile ambient
 * `AZURE_OPENAI_ENDPOINT` flipped 3 real test verdicts (the audit-plan/rebuttal
 * smoke tests inherit `{...process.env}` into their own children, and
 * model-ab-egress's public-path assertion consumes the load-time snapshot).
 *
 * **Scrub ROUTING SELECTORS only, never credentials.** CI and developers
 * legitimately inject API keys via env (that is how CI secrets work); a key
 * with no routing selector is inert for verdicts. Scrubbing keys would break
 * real workflows; scrubbing selectors converges every machine to the
 * CI-verified baseline.
 *
 * Usage: `npm test` (default globs) · `npm test -- tests/foo.test.mjs [args]`
 * (forwarded verbatim to `node --test`).
 *
 * @module scripts/run-tests
 */

import { spawnSync } from 'node:child_process';

/**
 * Ambient provider-ROUTING vars scrubbed from the child env. Enumerated from
 * the resolution sources, not guessed:
 * - config.mjs `buildAzureConfig(env)` — every `env.AZURE_*` it reads except
 *   the credential (`AZURE_OPENAI_API_KEY`, deliberately kept: credential,
 *   inert without a selector).
 * - anthropic-client.mjs — `ANTHROPIC_BASE_URL` (the harness-injected one),
 *   `CLAUDE_BACKEND` (transport selector; the repo's `.env` value resurrects
 *   via dotenv inside the child, so only shell-injected values die).
 * - the OpenAI SDK itself reads `OPENAI_BASE_URL` ambiently, which would
 *   flip every public-path baseURL assertion.
 */
export const SCRUBBED_ROUTING_ENV = Object.freeze([
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_AI_ENDPOINT',
  'AZURE_OPENAI_GPT_DEPLOYMENT',
  'AZURE_FOUNDRY_CLAUDE_DEPLOYMENT',
  'AZURE_FOUNDRY_SUMMARY_DEPLOYMENT',
  'AZURE_OPENAI_EMBED_DEPLOYMENT',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_CLAUDE_API_SHAPE',
  'AZURE_FOUNDRY_API_PATH',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'CLAUDE_BACKEND',
]);

/** Pure: a copy of `env` with the routing selectors removed. Exported so the
 *  hermeticity regression test asserts against THIS list, not a duplicate. */
export function scrubRoutingEnv(env) {
  const out = { ...env };
  for (const k of SCRUBBED_ROUTING_ENV) delete out[k];
  return out;
}

/** The default file set — kept byte-identical to the pre-runner npm script. */
const DEFAULT_ARGS = ['tests/*.test.mjs', 'tests/claudemd/*.test.mjs', 'tests/install/*.test.mjs'];

function main() {
  const forwarded = process.argv.slice(2);
  const args = forwarded.length > 0 ? forwarded : DEFAULT_ARGS;
  const res = spawnSync(process.execPath, ['--test', ...args], {
    stdio: 'inherit',
    env: scrubRoutingEnv(process.env),
  });
  // Propagate signal-kills as failure; otherwise mirror the child exactly.
  process.exit(res.status === null ? 1 : res.status);
}

// Import-safe: tests import { scrubRoutingEnv } without spawning anything.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main();
}
