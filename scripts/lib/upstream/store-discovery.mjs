/**
 * @fileoverview Which stores do this maintainer's consumers file upstream
 * reports into?
 *
 * ## Why this exists
 *
 * `/ship-checked` Step 0.5h read `cross-skill.mjs upstream list`, which queries
 * whatever store `AUDIT_DB_URL` names in THIS repo. That is one store, and
 * consumers are not on one store: measured 2026-08-29, `storyline` files into a
 * corporate Azure Postgres while this repo defaults to the NAS one. The step
 * reported **`0 open`** in the same session in which that consumer had eight
 * genuinely open reports — a triage nudge structurally blind to an entire
 * consumer, reporting its blindness as a clean queue.
 *
 * Same store-scoping class as the disposition-ledger defect fixed alongside it,
 * one layer earlier: that one was about RECONCILING a closure, this one is
 * about ever SEEING the report.
 *
 * ## Why the DSN is read from each consumer's own environment
 *
 * There is no registry of "which store does consumer X use", and inventing one
 * would go stale the first time a consumer was repointed. The authoritative
 * answer is the environment that consumer's own tooling reads, so this resolves
 * it the same way `load-shared-env.mjs` does — the repo's `.env`, then the
 * per-user shared `~/.audit-loop.env`.
 *
 * **The DSN never leaves this process except into a child's environment.** It
 * is never logged, never written, never returned in a rendered line. Everything
 * operator-facing is `storeFingerprint` plus the consumer NAMES that map to it —
 * the actionable half anyway ("the store storyline uses"), and it cannot publish
 * a corporate hostname into this public repo. Render with `describeStore`, never
 * the raw record.
 *
 * ## Fail-open, but never fail-silent
 *
 * A consumer whose store cannot be resolved is reported in `unresolved` with a
 * reason, never dropped. "We did not look" and "we looked and found nothing" are
 * the two states this whole defect class is made of; a fan-out that silently
 * skipped a store would recreate the bug it exists to fix, one level up.
 *
 * PURE except the two `read*Text` helpers, injected so the discovery logic is
 * testable without a filesystem of consumer repos.
 *
 * @module scripts/lib/upstream/store-discovery
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveEnvValue } from '../env-setting.mjs';
import { DSN_GROUP_KEYS, sharedEnvPath } from '../shared-cloud-config.mjs';

// `storeFingerprint` is INJECTED rather than imported. This module is
// `shared-lib`; `lib/db/client.mjs` is `stores`, and that edge is a layering
// violation `arm-vocabulary-layering` fails on. The preference order there is
// refactor > retag > declare, and injection is the refactor: the module was
// already injection-shaped for its IO (`readEnvText`, `repoExists`), so the one
// pure helper it wanted from the store layer joins them instead of dragging a
// domain edge behind it. Callers pass `storeFingerprint` from lib/db/client.mjs.

/**
 * Why a consumer was DELIBERATELY not queried (`policyUnreachable`). Distinct from
 * `UNRESOLVED` ("we could not look"): these are "we must not look".
 */
/** The label this repo carries in a store's `aliases` (it has no registry alias; the registry reserves the word). */
const SELF_ALIAS = 'self';

export const POLICY_REASON = Object.freeze({
  DECLARED: 'unreachable-by-policy',
  UNDETERMINABLE: 'policy-undeterminable',
  SHARED: 'shared-with-policy-consumer',
});

/** Why a consumer contributed no store. */
export const UNRESOLVED = Object.freeze({
  NO_REPO: 'repo-directory-absent',
  NO_ENV: 'no-env-file-and-no-shared-config',
  NO_DSN: 'no-DSN-in-.env-or-shared-config',
  BAD_DSN: 'DSN-unparseable',
});

const clean = (v) => {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/^["']|["']$/g, '').trim();
  return t || null;
};

/**
 * Read the DSN bundle out of one env-file's text. PURE.
 *
 * Three rules inherited from `load-shared-env.mjs` rather than re-invented,
 * because a second spelling of a precedence rule is how two resolvers drift:
 *
 *  - **Last-wins** within a file, via `resolveEnvValue` (dotenv's own
 *    semantic), so a consumer with a duplicated key resolves the way its
 *    tooling would.
 *  - **Both DSN spellings** (`DSN_GROUP_KEYS`) — `AUDIT_POSTGRES_URL` is the
 *    other one `resolveDbUrl` accepts, and a consumer using it would otherwise
 *    read as having no store at all.
 *  - **The SSL mode comes from the SAME layer as the DSN, or not at all.** That
 *    is the whole-bundle rule: pairing one layer's DSN with another's SSL mode
 *    is the cross-key precedence hole `load-shared-env` documents, and here it
 *    would mean reaching one consumer's database with another's TLS setting.
 *
 * Reads only FILE values, never `process.env` — this repo's ambient DSN is a
 * different store, and letting it leak in would make every consumer look like
 * it shares ours: exactly the false negative this fan-out exists to remove.
 *
 * @param {string} envText
 * @returns {{url: string|null, sslMode: string|null}}
 */
export function parseStoreEnv(envText) {
  let url = null;
  let urlKey = null;
  for (const key of DSN_GROUP_KEYS) {
    const v = clean(resolveEnvValue(key, { envFileText: envText }).fileValue);
    if (v) { url = v; urlKey = key; break; }
  }
  if (!url) return { url: null, sslMode: null };
  const sslKey = urlKey === 'AUDIT_POSTGRES_URL' ? 'AUDIT_POSTGRES_SSL_MODE' : 'AUDIT_DB_SSL_MODE';
  return { url, sslMode: clean(resolveEnvValue(sslKey, { envFileText: envText }).fileValue) };
}

/**
 * Resolve one repo's effective store, layering as `load-shared-env` does: the
 * repo's own `.env` first, then the per-user shared `~/.audit-loop.env`.
 *
 * The shared layer is not optional polish. On the first live run of this
 * fan-out, three of the four repos reported "no store" — they carry no
 * per-repo DSN and take the shared one, which is how `setup:cloud` provisions a
 * consumer. A discovery that read only `.env` would declare them invisible
 * while their tooling connects fine: a false alarm as misleading as the false
 * clean it replaced.
 *
 * @param {object} input
 * @param {string|null} input.repoEnvText — the repo's `.env`, or null if absent
 * @param {string|null} input.sharedEnvText — `~/.audit-loop.env`, or null
 * @returns {{url: string|null, sslMode: string|null, layer: 'repo'|'shared'|null}}
 */
export function resolveRepoStore({ repoEnvText, sharedEnvText }) {
  const own = repoEnvText ? parseStoreEnv(repoEnvText) : { url: null, sslMode: null };
  if (own.url) return { ...own, layer: 'repo' };
  const shared = sharedEnvText ? parseStoreEnv(sharedEnvText) : { url: null, sslMode: null };
  if (shared.url) return { ...shared, layer: 'shared' };
  return { url: null, sslMode: null, layer: null };
}

/**
 * Group the source repo and every consumer by the store each one talks to.
 *
 * Deduplicated by `storeFingerprint`, so three consumers sharing the NAS store
 * are queried ONCE — the fan-out is over distinct databases, not over repos.
 *
 * @param {object} input
 * @param {Array<{name: string, path: string}>} input.repos — consumer registry entries
 * @param {{name: string, url: string|null, sslMode: string|null, path?: string}} [input.self]
 *   this repo's own store, included so the fan-out is a superset of today's read
 * @param {(repoPath: string) => string|null} input.readEnvText
 * @param {(dsn: string) => string|null} input.fingerprintOf — `storeFingerprint`
 * @param {(repoPath: string) => object} input.readSetupPointer — `readStoreSetupPointer`; REQUIRED
 * @param {string|null} [input.sharedEnvText]
 * @param {(repoPath: string) => boolean} [input.repoExists]
 * @returns {{stores: Array<{fingerprint: string, url: string, sslMode: string|null, repos: string[], aliases: string[]}>,
 *            unresolved: Array<{repo: string, reason: string}>,
 *            policyUnreachable: Array<{repo: string, alias: string|null, reason: string}>}}
 */
export function discoverStores({
  repos, self = null, readEnvText, fingerprintOf, readSetupPointer, sharedEnvText = null, repoExists = () => true,
}) {
  if (typeof fingerprintOf !== 'function') {
    // Refused rather than defaulted: a missing fingerprint function would make
    // every store unresolvable, i.e. every consumer's queue silently invisible —
    // the exact failure this module exists to end, arriving as a clean result.
    throw new TypeError('discoverStores: fingerprintOf is required (pass storeFingerprint from lib/db/client.mjs)');
  }
  if (typeof readSetupPointer !== 'function') {
    // Same refusal, for the privacy rule: an omitted injection must not silently
    // turn "never query a declared-private consumer" off.
    throw new TypeError('discoverStores: readSetupPointer is required (pass readStoreSetupPointer from lib/doctor/store-reachability.mjs)');
  }
  /** @type {Map<string, {fingerprint: string, url: string, sslMode: string|null, repos: string[], aliases: string[]}>} */
  const byFingerprint = new Map();
  const unresolved = [];
  /** @type {Array<{repo: string, alias: string|null, reason: string}>} */
  const policyUnreachable = [];
  /** Fingerprints of stores a policy-private consumer resolves to — computed locally, never queried. */
  const privateFingerprints = new Set();
  const aliasByName = new Map();

  const add = (name, url, sslMode, alias = null) => {
    const fingerprint = fingerprintOf(url);
    if (!fingerprint) { unresolved.push({ repo: name, reason: UNRESOLVED.BAD_DSN }); return; }
    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      if (!existing.repos.includes(name)) existing.repos.push(name);
      if (alias && !existing.aliases.includes(alias)) existing.aliases.push(alias);
      return;
    }
    byFingerprint.set(fingerprint, { fingerprint, url, sslMode: sslMode ?? null, repos: [name], aliases: alias ? [alias] : [] });
  };

  // The source repo first, so its fingerprint owns the group when a consumer
  // shares it — the operator reads "this repo, wine" rather than "wine, this repo".
  // The source repo has a pointer too (committed in its own tree): a private or undeterminable self is
  // never queried either. Callers pass `self.path` (the repo root) so it can be read.
  const selfName = self?.name || 'this repo';
  const selfPolicy = self?.path ? policyOf(readSetupPointer(self.path)) : null;
  if (selfPolicy) {
    const fp = self.url ? fingerprintOf(self.url) : null;
    if (fp) privateFingerprints.add(fp);
    policyUnreachable.push({ repo: selfName, alias: null, reason: selfPolicy, ...(fp ? {} : { identityUnknown: true }) });
  } else if (self?.url) {
    // Recorded so a refused shared store still labels this repo `self` (final gate G1).
    aliasByName.set(selfName, SELF_ALIAS);
    add(selfName, self.url, self.sslMode, SELF_ALIAS);
  }
  else if (self) unresolved.push({ repo: selfName, reason: UNRESOLVED.NO_DSN });

  for (const repo of repos || []) {
    if (!repoExists(repo.path)) {
      unresolved.push({ repo: repo.name, reason: UNRESOLVED.NO_REPO });
      continue;
    }
    const repoEnvText = readEnvText(repo.path);
    const { url, sslMode } = resolveRepoStore({ repoEnvText, sharedEnvText });
    const alias = typeof repo.alias === 'string' ? repo.alias : null;
    aliasByName.set(repo.name, alias);
    const policy = policyOf(readSetupPointer(repo.path));
    if (policy) {
      // Never queried, never returned, never logged — but fingerprinted locally,
      // so a reachable consumer on the SAME store can be refused below.
      const fp = url ? fingerprintOf(url) : null;
      if (fp) privateFingerprints.add(fp);
      // A private consumer whose DSN resolves in neither layer cannot be fingerprinted, so a shared store
      // cannot be ruled out; say so. Other stores are NOT refused on that account.
      policyUnreachable.push({ repo: repo.name, alias, reason: policy, ...(fp ? {} : { identityUnknown: true }) });
      continue;
    }
    if (!url) {
      // "No file to read at all" and "read it, and neither layer named a DSN"
      // are different operator problems and get different reasons.
      unresolved.push({
        repo: repo.name,
        reason: (repoEnvText == null && sharedEnvText == null) ? UNRESOLVED.NO_ENV : UNRESOLVED.NO_DSN,
      });
      continue;
    }
    add(repo.name, url, sslMode, alias);
  }

  // A private STORE is refused whole: its rows would otherwise be read through a
  // reachable consumer's query. Listed per repo so the contradiction is visible.
  const stores = [];
  for (const store of byFingerprint.values()) {
    if (!privateFingerprints.has(store.fingerprint)) { stores.push(store); continue; }
    for (const name of store.repos) {
      policyUnreachable.push({ repo: name, alias: aliasByName.get(name) ?? null, reason: POLICY_REASON.SHARED });
    }
  }

  return { stores, unresolved, policyUnreachable };
}

/**
 * Is this consumer declared (or, failing closed, presumed) private? PURE.
 *
 * A declaration we cannot read is treated as private: a typo in a privacy
 * declaration must not turn into a query of the store it protects.
 *
 * @param {object} pointer — `readStoreSetupPointer`'s result
 * @returns {string|null} a POLICY_REASON, or null (not private)
 */
function policyOf(pointer) {
  // `policy` is the reader's own structured answer (absent | reachable | private | undeterminable);
  // an unknown value fails CLOSED rather than reading as reachable.
  switch (pointer?.policy) {
    case 'private': return POLICY_REASON.DECLARED;
    case 'undeterminable': return POLICY_REASON.UNDETERMINABLE;
    case 'absent': case 'reachable': return null;
    default: return pointer?.present === false ? null : POLICY_REASON.UNDETERMINABLE;
  }
}

/**
 * The operator line for one deliberately-unqueried consumer. PURE. Labelled by
 * registry alias (falling back to the repo name for an alias-less entry), never a
 * hostname. Printed on every path by both readers; never counted.
 *
 * @param {{repo: string, alias: string|null, reason: string, identityUnknown?: boolean}} entry
 * @returns {string}
 */
export function renderPolicyUnreachable(entry) {
  const base = renderPolicyBase(entry);
  return entry.identityUnknown ? `${base} — its store identity is unknown, so a shared store cannot be ruled out` : base;
}

function renderPolicyBase(entry) {
  const who = entry.alias || entry.repo;
  if (entry.reason === POLICY_REASON.SHARED) {
    return `refused ${who} — shares a store with a policy-private consumer; never queried, NOT counted`;
  }
  if (entry.reason === POLICY_REASON.UNDETERMINABLE) {
    return `not queried ${who} — .audit-loop/store-setup.json unreadable or malformed; treated as private`;
  }
  return `unreachable-by-policy ${who} — declared private; never queried, NOT counted`;
}

/**
 * The operator-facing name of a store: its fingerprint plus who uses it.
 *
 * **Never the DSN, and never the hostname.** This output is printed at ship
 * time and pasted into status logs in a public repo, and one consumer's store
 * is a corporate internal host. The consumer names ARE the actionable identity.
 *
 * @param {{fingerprint: string, repos: string[]}} store
 * @returns {string}
 */
export function describeStore(store) {
  return `${store.fingerprint} (${store.repos.join(', ')})`;
}

/**
 * Read a repo's `.env`. IMPURE.
 *
 * Returns null when absent or unreadable — both are "we could not look", which
 * the caller reports rather than swallows.
 *
 * @param {string} repoPath
 * @returns {string|null}
 */
export function readRepoEnvText(repoPath) {
  try {
    return fs.readFileSync(path.join(repoPath, '.env'), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Read the per-user shared cloud config. IMPURE.
 *
 * Absent is the ordinary case on a machine that never ran `setup:cloud`;
 * unreadable degrades the same way, because this is an advisory read and a
 * throw here would take down a ship-time nudge.
 *
 * @returns {string|null}
 */
export function readSharedEnvText() {
  try {
    return fs.readFileSync(sharedEnvPath(), 'utf-8');
  } catch {
    return null;
  }
}
