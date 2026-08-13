import { AsyncLocalStorage } from 'node:async_hooks';
/**
 * @fileoverview Scoped provider-env isolation for tests.
 *
 * A test suite's verdict must be a function of the repo, never of the
 * operator's shell — and the operator's shell is not always their own. Claude
 * Code desktop injects `ANTHROPIC_BASE_URL` into every child shell, which made
 * 15 anthropic-client tests fail inside the harness and pass outside it
 * (2026-07-18). `tests/openai-client.test.mjs` had the same exposure via
 * `AZURE_OPENAI_ENDPOINT`: its `beforeEach` reset the client cache but never
 * scrubbed the env, so an ambient Azure endpoint silently activated the Azure
 * path inside tests that believed they were exercising the public one.
 *
 * ONE list per LAYER, and there are deliberately two layers — do not "unify"
 * them:
 *
 *   `SCRUBBED_ROUTING_ENV` (scripts/run-tests.mjs) is the RUNNER layer. It
 *   scrubs the ambient shell once before spawning the test children, and it
 *   scrubs ROUTING SELECTORS ONLY, never credentials: CI injects API keys by
 *   env, and a key with no routing selector is inert for verdicts. Scrubbing
 *   keys there would break real CI.
 *
 *   `PROVIDER_ENV_VARS` (here) is the PER-TEST layer. It may also scrub
 *   credentials, because a test asserting "no key → misconfigured" needs them
 *   absent for its own duration only.
 *
 * So the lists differ on purpose. What must NOT differ is the routing half:
 * every selector the runner knows about must also be scrubbed here, or a test
 * that sets up its own env could still be steered by one this layer missed.
 * `tests/provider-env-helper.test.mjs` asserts that containment — it caught
 * four selectors missing from this list when the two layers were compared
 * (AZURE_FOUNDRY_SUMMARY_DEPLOYMENT, AZURE_OPENAI_API_VERSION,
 * AZURE_CLAUDE_API_SHAPE, AZURE_FOUNDRY_API_PATH).
 *
 * SNAPSHOT-AND-RESTORE, not delete: a test that throws must not leak state into
 * the next one, so restoration runs in `finally`. "Was unset" is preserved as
 * distinct from "was empty" — `resolveBackend` and the Azure-activation checks
 * read presence, not truthiness.
 *
 * Plan: docs/plans/debt-burndown-workstreams.md §4 WS-B4.
 */

/**
 * Every env var that steers provider construction, across all families.
 *
 * Adding a provider knob to `anthropic-client.mjs` / `openai-client.mjs` /
 * `embed-text.mjs` means adding it HERE — not to one suite.
 */
export const PROVIDER_ENV_VARS = Object.freeze([
  // Anthropic
  'CLAUDE_BACKEND', 'CLAUDE_BIN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  // OpenAI
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  // Azure (endpoint presence alone activates the Azure path — the openai-client gap)
  'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_GPT_DEPLOYMENT',
  'AZURE_OPENAI_EMBED_DEPLOYMENT', 'AZURE_AI_ENDPOINT', 'AZURE_AI_API_KEY',
  'AZURE_FOUNDRY_CLAUDE_DEPLOYMENT',
  // Routing selectors the runner layer already scrubs — kept in sync by the
  // containment assertion in tests/provider-env-helper.test.mjs.
  'AZURE_FOUNDRY_SUMMARY_DEPLOYMENT', 'AZURE_OPENAI_API_VERSION',
  'AZURE_CLAUDE_API_SHAPE', 'AZURE_FOUNDRY_API_PATH', 'AZURE_CLAUDE_ROUTE',
  // Gemini
  'GEMINI_API_KEY',
  // Final-review routing
  'FINAL_REVIEW_PROVIDER', 'FINAL_REVIEW_BASE_URL', 'FINAL_REVIEW_API_KEY',
  'FINAL_REVIEW_MODEL', 'FINAL_REVIEW_SHADOW', 'FINAL_REVIEW_SHADOW_MODEL',
]);

/**
 * `process.env` is process-global, so two interleaved scopes would restore the
 * wrong values. Node's test runner isolates by FILE, which satisfies this
 * today — but `{concurrency: true}`, a parallel subtest, or a runner-config
 * change could interleave two scopes silently, and the failure would surface
 * as an unrelated flaky provider test. A documented "don't do that" is not a
 * safeguard, so the helper serialises its own lifecycle.
 *
 * Re-entrant: a nested scope inside an owning scope proceeds immediately
 * rather than deadlocking on its own parent.
 */
// Re-entrancy is tracked with AsyncLocalStorage, NOT a global counter. A global
// integer cannot distinguish "nested inside the owning scope" from "a different
// concurrent test while the owner is awaiting": once Test A awaits, the counter
// is still > 0, so Test B would take the nested branch, bypass the queue, and
// mutate `process.env` underneath A — the exact interleaving this helper exists
// to prevent. Same pattern as `withTx`'s `_txStore` in scripts/lib/db/query.mjs.
let queue = Promise.resolve();
const scopeStore = new AsyncLocalStorage();

/** Snapshot every managed var, preserving unset-vs-empty. */
function snapshot(vars) {
  const saved = new Map();
  for (const k of vars) saved.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined);
  return saved;
}

/** Restore exactly — `undefined` means the var was absent, not empty. */
function restore(saved) {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/**
 * Run `fn` with every provider env var removed, then restore the exact prior
 * environment — including on throw.
 *
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {{vars?: readonly string[], set?: Record<string, string>}} [opts]
 *   `set` applies AFTER scrubbing, for a test that needs one var present.
 * @returns {Promise<T>}
 */
export async function withScrubbedProviderEnv(fn, { vars = PROVIDER_ENV_VARS, set = {} } = {}) {
  const run = async () => {
    // Snapshot the UNION of the managed list and any `set` keys. Snapshotting
    // only `vars` while injecting `set` meant a custom key outside the list was
    // written into process.env and never restored — leaking permanently into
    // every subsequent test, which is precisely the cross-test contamination
    // this helper exists to prevent.
    const managed = [...new Set([...vars, ...Object.keys(set)])];
    const saved = snapshot(managed);
    try {
      for (const k of vars) delete process.env[k];
      for (const [k, v] of Object.entries(set)) process.env[k] = v;
      return await scopeStore.run(true, fn);
    } finally {
      restore(saved);
    }
  };

  // Genuinely nested (this async context already owns a scope) → run inline;
  // queueing behind our own owner would deadlock. Anything else queues.
  if (scopeStore.getStore()) return run();
  const result = queue.then(run, run);  // run regardless of a prior scope's outcome
  queue = result.then(() => {}, () => {});
  return result;
}

/**
 * beforeEach/afterEach form, for suites whose structure predates the scoped
 * helper. Returns `{beforeEach, afterEach}` sharing one snapshot.
 */
export function providerEnvHooks(vars = PROVIDER_ENV_VARS) {
  let saved = null;
  return {
    beforeEach() {
      saved = snapshot(vars);
      for (const k of vars) delete process.env[k];
    },
    afterEach() {
      if (saved) restore(saved);
      saved = null;
    },
  };
}
