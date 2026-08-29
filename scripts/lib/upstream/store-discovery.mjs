/**
 * @fileoverview Which stores do this maintainer's consumers file upstream
 * reports into?
 *
 * ## Why this exists
 *
 * `/ship` Step 0.5h read `cross-skill.mjs upstream list`, which queries
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
import { storeFingerprint } from '../db/client.mjs';
import { DSN_GROUP_KEYS, sharedEnvPath } from '../shared-cloud-config.mjs';

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
 * @param {{name: string, url: string|null, sslMode: string|null}} [input.self]
 *   this repo's own store, included so the fan-out is a superset of today's read
 * @param {(repoPath: string) => string|null} input.readEnvText
 * @param {string|null} [input.sharedEnvText]
 * @param {(repoPath: string) => boolean} [input.repoExists]
 * @returns {{stores: Array<{fingerprint: string, url: string, sslMode: string|null, repos: string[]}>,
 *            unresolved: Array<{repo: string, reason: string}>}}
 */
export function discoverStores({
  repos, self = null, readEnvText, sharedEnvText = null, repoExists = () => true,
}) {
  /** @type {Map<string, {fingerprint: string, url: string, sslMode: string|null, repos: string[]}>} */
  const byFingerprint = new Map();
  const unresolved = [];

  const add = (name, url, sslMode) => {
    const fingerprint = storeFingerprint(url);
    if (!fingerprint) { unresolved.push({ repo: name, reason: UNRESOLVED.BAD_DSN }); return; }
    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      if (!existing.repos.includes(name)) existing.repos.push(name);
      return;
    }
    byFingerprint.set(fingerprint, { fingerprint, url, sslMode: sslMode ?? null, repos: [name] });
  };

  // The source repo first, so its fingerprint owns the group when a consumer
  // shares it — the operator reads "this repo, wine" rather than "wine, this repo".
  if (self?.url) add(self.name || 'this repo', self.url, self.sslMode);
  else if (self) unresolved.push({ repo: self.name || 'this repo', reason: UNRESOLVED.NO_DSN });

  for (const repo of repos || []) {
    if (!repoExists(repo.path)) {
      unresolved.push({ repo: repo.name, reason: UNRESOLVED.NO_REPO });
      continue;
    }
    const repoEnvText = readEnvText(repo.path);
    const { url, sslMode } = resolveRepoStore({ repoEnvText, sharedEnvText });
    if (!url) {
      // "No file to read at all" and "read it, and neither layer named a DSN"
      // are different operator problems and get different reasons.
      unresolved.push({
        repo: repo.name,
        reason: (repoEnvText == null && sharedEnvText == null) ? UNRESOLVED.NO_ENV : UNRESOLVED.NO_DSN,
      });
      continue;
    }
    add(repo.name, url, sslMode);
  }

  return { stores: [...byFingerprint.values()], unresolved };
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
