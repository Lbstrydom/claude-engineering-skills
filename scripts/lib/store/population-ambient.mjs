/**
 * @fileoverview The population for a verdict writer's CURRENT store, resolved from
 * the ambient environment. The impure half of `lib/population.mjs` (which stays pure
 * and shared-lib): it asks the store layer which store this process is on, and
 * dynamically imports the consumer registry.
 *
 * The registry's private half exists only in the source repo. Anywhere it cannot be
 * imported (a consumer) the population is `unknownBeyond: true` with nothing claimed
 * about other consumers — never an empty "all measured".
 *
 * Discovery here fingerprints locally and queries NOTHING.
 *
 * @module scripts/lib/store/population-ambient
 */
import fs from 'node:fs';
import { activeStoreDescriptor, storeFingerprint } from '../db/client.mjs';
import { resolvePopulation, warnRegistryFailure, repoScopeLabels } from '../population.mjs';

/**
 * @param {object} [opts]
 * @param {'store'|{repo: string|null}} [opts.scope] (`{repo: 'self'}` = this repo's own rows) what the writer's query actually filtered on
 * @param {boolean} [opts.answered] false when the store was configured but gave NO measurement: nothing was measured from it
 * @param {string|null} [opts.fingerprint] override (tests); default: the store this process is on
 * @param {() => Promise<{registry: ReadonlyArray<object>, discover: Function}|null>} [opts.loadRegistry] override (tests)
 * @returns {Promise<ReturnType<typeof resolvePopulation>>}
 */
export async function ambientPopulation({ scope = 'store', answered = true, warn, fingerprint, loadRegistry = loadSourceRegistry } = {}) {
  let fp = fingerprint;
  if (fp === undefined) {
    try { fp = activeStoreDescriptor()?.fingerprint ?? null; } catch { fp = null; }
  }
  let reg = null;
  try { reg = await loadRegistry(); } catch (err) { warnRegistryFailure(err, warn, REGISTRY_URLS); reg = null; }
  return resolvePopulation({ fingerprint: fp, scope, registry: reg?.registry ?? null, discover: reg?.discover ?? null, answered, ...(warn ? { warn } : {}) });
}

/**
 * The scope labels for a repo-scoped read over this checkout plus sibling repos (see `repoScopeLabels`). The registry
 * is reached through the same loader as the population; where it is unavailable no sibling matches and each is
 * `sibling-<n>`.
 *
 * @param {Array<{uuid: string, name?: string|null, path?: string|null}>} identities this checkout FIRST
 * @param {{loadRegistry?: Function, warn?: (line: string) => void}} [opts]
 * @returns {Promise<string[]>}
 */
export async function siblingScopeLabels(identities, { loadRegistry = loadSourceRegistry, warn } = {}) {
  let registry = [];
  try { registry = (await loadRegistry())?.registry ?? []; } catch (err) { warnRegistryFailure(err, warn, REGISTRY_URLS); }
  return repoScopeLabels(identities, registry);
}

/**
 * Opaque to the sync-closure analyser ON PURPOSE. The consumer registry (and the discovery that reads
 * sibling repos' env files) exist only in the source repo; a literal specifier would pull them into every
 * consumer's synced tree, where `CONSUMER_REPOS` would be the maintainer's list — a claim about
 * consumers the reader cannot see. Where the file is absent the import throws and the caller falls back
 * to the unknown population.
 */
const REGISTRY_SPECIFIERS = ['../consumer-repos.mjs', '../upstream/store-discovery.mjs', '../doctor/store-reachability.mjs'];
const REGISTRY_URLS = REGISTRY_SPECIFIERS.map((rel) => new URL(rel, import.meta.url).href);
const sourceOnly = (rel) => import(new URL(rel, import.meta.url).href);

async function loadSourceRegistry() {
  const { CONSUMER_REPOS, sourceRepoRoot } = await sourceOnly('../consumer-repos.mjs');
  const sourceRoot = sourceRepoRoot();
  const disc = await sourceOnly('../upstream/store-discovery.mjs');
  const { readStoreSetupPointer } = await sourceOnly('../doctor/store-reachability.mjs');
  const sharedEnvText = disc.readSharedEnvText();
  return {
    registry: CONSUMER_REPOS,
    discover: (repos) => disc.discoverStores({
      repos,
      self: { name: 'this repo', path: sourceRoot, url: process.env.AUDIT_DB_URL || null, sslMode: process.env.AUDIT_DB_SSL_MODE || null },
      readEnvText: disc.readRepoEnvText,
      fingerprintOf: storeFingerprint,
      readSetupPointer: readStoreSetupPointer,
      repoExists: (p) => fs.existsSync(p),
      sharedEnvText,
    }),
  };
}
