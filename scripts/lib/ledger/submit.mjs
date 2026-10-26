/**
 * @fileoverview The one producer-facing entry point: gather the impure context,
 * run `prepareLedgerEvent`, then deliver (store, else spool)
 * (docs/plans/own-model-decision-ledger.md decisions 4, 6, 9).
 *
 * Delivery states returned (the shared receipt contract):
 *   persisted | duplicate | spooled | refused | disabled | failed-retryable | failed-permanent
 *
 * Every dependency is injectable, so the whole decision tree is testable without
 * a store, a git repo or a clock.
 *
 * @module scripts/lib/ledger/submit
 */
import { resolveRepoIdentity } from '../repo-identity.mjs';
import { prepareLedgerEvent } from './prepare.mjs';
import {
  ledgerEnabled, ledgerDir, readState, writeState, cachedFlag, writeSpool,
} from './spool.mjs';

/** @returns {Promise<object>} the production dependency set (imported lazily: no store import for callers that only spool). */
async function defaultDeps() {
  const store = await import('../store/own-model-ledger.mjs');
  const { isCloudEnabled } = await import('../store/repo.mjs');
  return {
    resolveRepoName: (cwd) => resolveRepoIdentity(cwd).name,
    isCloudEnabled,
    lookupRepoFlag: store.lookupRepoFlag,
    readPurgeGeneration: store.readPurgeGeneration,
    recordLedgerEvents: store.recordLedgerEvents,
    ledgerDir,
  };
}

/**
 * @param {unknown} raw ingress event
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, nowMs?: number, deps?: object, toolSha?: string|null}} [opts]
 * @returns {Promise<{state: string, event_id?: string, content_state?: string, contentDropped?: boolean, reason?: string, error?: string}>}
 */
export async function submitLedgerEvent(raw, { cwd = process.cwd(), env = process.env, nowMs = Date.now(), deps = null, toolSha = null, purgeGeneration = null } = {}) {
  if (!ledgerEnabled(env)) return { state: 'disabled' };
  const d = deps ?? await defaultDeps();
  let dir;
  try { dir = d.ledgerDir(cwd); } catch (err) { return { state: 'failed-permanent', error: `no ledger dir: ${err.message}` }; }

  // The ledger repo is the AMBIENT repo. A producer-supplied `repo` may only restate it: it selects the eligibility flag,
  // so letting it differ would let an event be attributed to (and shaped by) a repo it did not come from.
  let name = null;
  try { name = d.resolveRepoName(cwd); } catch { name = null; }
  if (raw && typeof raw === 'object' && raw.repo && name && raw.repo !== name) return { state: 'refused', reason: 'repo-mismatch' };
  if (raw && typeof raw === 'object' && raw.repo && !name) name = raw.repo;

  const state = readState(dir);
  let cloud = false;
  try { cloud = await d.isCloudEnabled(); } catch { cloud = false; }

  // Eligibility + generation: the store when reachable, else the (TTL-bound) cache.
  let repo = { id: null, name, flag: 'unknown' };
  let generation = state.generation ?? 0;
  if (cloud) {
    try {
      const looked = await d.lookupRepoFlag(name);
      if (looked.flag !== 'unknown') { repo = looked; writeState(dir, { repo: looked }, nowMs); }
      generation = await d.readPurgeGeneration();
      writeState(dir, { generation }, nowMs);
    } catch { /* store trouble: fall through to the cache, which expires into 'unknown' */ }
  }
  if (repo.flag === 'unknown' && name) {
    const c = cachedFlag(state, name, nowMs);
    repo = { id: c.id, name, flag: c.flag };
  }

  const prepared = prepareLedgerEvent(raw, { repo: { id: repo.id, name: repo.name }, flag: repo.flag, purgeGeneration: purgeGeneration ?? generation, nowMs, toolSha });
  if (!prepared.ok) return { state: 'refused', reason: prepared.reason };
  const event = prepared.event;
  const meta = { event_id: event.event_id, content_state: event.content_state, contentDropped: repo.flag === 'unknown' };

  if (cloud) {
    try {
      const res = await d.recordLedgerEvents([event]);
      if (res.ok && res.receipts[0]) {
        if (Number.isFinite(res.generation)) writeState(dir, { generation: res.generation }, nowMs);
        const r = res.receipts[0];
        return { ...meta, state: r.state, ...(r.reason ? { reason: r.reason } : {}) };
      }
    } catch { /* fall through to the spool */ }
  }
  const sp = writeSpool(dir, event);
  return sp.state === 'spooled' ? { ...meta, state: 'spooled' } : { ...meta, state: sp.state, error: sp.error };
}
