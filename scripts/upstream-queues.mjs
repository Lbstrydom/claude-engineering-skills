#!/usr/bin/env node
/**
 * @fileoverview `upstream:queues` — the open upstream-report queue across
 * EVERY store this maintainer's consumers file into, not just the ambient one.
 *
 * ## The defect this closes
 *
 * `/ship` Step 0.5h ran `cross-skill.mjs upstream list`, which reads whatever
 * store `AUDIT_DB_URL` names HERE. Consumers are not on one store: measured
 * 2026-08-29, `storyline` files into a corporate Azure Postgres while this repo
 * defaults to the NAS one. The step printed **`0 open`** in the same session in
 * which that consumer had eight genuinely open reports. A triage nudge that
 * cannot see a consumer reports its blindness as a clean queue — the failure
 * shape this repo keeps closing, here on the one surface whose entire job is
 * noticing what consumers said.
 *
 * ## Why a child process per store
 *
 * `db/client.mjs`'s pool is a module-global singleton latched to
 * `process.env.AUDIT_DB_URL` at first init, so querying N stores in-process
 * would mean either a second pool API or resetting a global between reads.
 * Spawning `cross-skill.mjs upstream list` per store instead reuses the exact
 * command that already answers this question, keeps each read isolated, and
 * keeps every consumer DSN out of this process's own environment. Two stores
 * today; the fan-out is over DISTINCT stores, not repos, so consumers sharing
 * one are queried once.
 *
 * ## Never blocks, and never fakes a clean answer
 *
 * Advisory by construction (exit 0 even when queues are non-empty) — the queue
 * is CLOUD state that the commit being shipped cannot change, and a gate firing
 * on something the author cannot fix is what earns `--no-verify`.
 *
 * But it distinguishes **queried** from **unqueried**, loudly. "We asked and
 * the queue is empty" and "we never asked" must never render the same, because
 * rendering them the same IS the bug. A run that reached no store at all says
 * so instead of printing zero.
 *
 * Source-repo-only: reads `consumer-repos.mjs`, whose private half is gitignored
 * and absent everywhere else. Never declared in `sync-to-repos.mjs`, never in
 * `CLI_SMOKE_SET` — same disposition as `check-upstream-probe-coverage.mjs`.
 *
 * Usage:
 *   node scripts/upstream-queues.mjs            # human report
 *   node scripts/upstream-queues.mjs --json     # machine-readable
 *
 * Exit codes: 0 — always (advisory) · 2 — usage error.
 *
 * @module scripts/upstream-queues
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve this repo's own env the way every other CLI does — `.env` (from the
// MAIN checkout when we are in a linked worktree) then the shared config. The
// first cut read a bare `process.env.AUDIT_DB_URL`, which is unset in a
// worktree, so the fan-out silently EXCLUDED this repo's own store: a
// regression against the single-store read it replaces. Caught by running it.
import './lib/load-env.mjs';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { CONSUMER_REPOS } from './lib/consumer-repos.mjs';
import {
  discoverStores, describeStore, readRepoEnvText, readSharedEnvText,
} from './lib/upstream/store-discovery.mjs';
import { storeFingerprint } from './lib/db/client.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'cross-skill.mjs');
const KNOWN_FLAGS = ['--json', '--limit', '--selfcheck-relocation'];

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

/** Per-store query timeout. A wedged store must not stall a ship. */
const QUERY_TIMEOUT_MS = 20_000;

/**
 * Ask ONE store for its open upstream reports, in a child process carrying that
 * store's DSN and nothing else of ours.
 *
 * Never throws: an unreachable store returns `{ok:false}` with a reason, which
 * the caller renders as UNQUERIED rather than as an empty queue.
 *
 * @param {{url: string, sslMode: string|null}} store
 * @param {number} limit
 * @returns {{ok: boolean, rows: Array<object>, reason: string|null}}
 */
export function queryStore(store, limit = 50) {
  try {
    const out = execFileSync(
      process.execPath,
      [CLI, 'upstream', 'list', '--state', 'open', '--limit', String(limit)],
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        timeout: QUERY_TIMEOUT_MS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          AUDIT_DB_URL: store.url,
          // Absent means "the consumer did not set one"; let the client apply
          // its own default rather than inventing a mode that could either
          // fail to connect or silently downgrade TLS.
          ...(store.sslMode ? { AUDIT_DB_SSL_MODE: store.sslMode } : {}),
        },
      },
    );
    // The CLI prints a JSON envelope as its LAST line; earlier lines are the
    // env/config banners it writes to stdout.
    const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
    if (!line) return { ok: false, rows: [], reason: 'no-envelope-in-output' };
    const env = JSON.parse(line);
    if (!env.ok) return { ok: false, rows: [], reason: env.error?.code || 'query-failed' };
    // `cloud:false` is NOT an empty queue — it is an unasked question.
    if (env.cloud === false) return { ok: false, rows: [], reason: 'cloud-off' };
    return { ok: true, rows: Array.isArray(env.rows) ? env.rows : [], reason: null };
  } catch (err) {
    const reason = err?.signal === 'SIGTERM' ? 'timeout' : (err?.code || 'spawn-failed');
    return { ok: false, rows: [], reason: String(reason) };
  }
}

const SEVERITY_ORDER = { BLOCKER: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/**
 * Collate every store's answer. PURE over the injected query function.
 *
 * @param {object} input
 * @param {Array<object>} input.stores
 * @param {Array<{repo: string, reason: string}>} input.unresolved
 * @param {(store: object) => {ok: boolean, rows: Array<object>, reason: string|null}} input.query
 * @returns {object}
 */
export function collectQueues({ stores, unresolved, query }) {
  const queried = [];
  const unqueried = [];
  const items = [];

  for (const store of stores) {
    const res = query(store);
    if (!res.ok) {
      unqueried.push({ store: describeStore(store), reason: res.reason });
      continue;
    }
    queried.push({ store: describeStore(store), open: res.rows.length });
    for (const row of res.rows) {
      items.push({
        id: typeof row.id === 'string' ? row.id.slice(0, 8) : '?',
        severity: row.severity || 'MEDIUM',
        title: row.title || '(untitled)',
        repoName: row.repo_name || null,
        store: describeStore(store),
      });
    }
  }

  items.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

  return {
    // `storesQueried === 0` is the state that must never render as a clean
    // queue — it is the whole reason this file exists.
    storesQueried: queried.length,
    storesUnqueried: unqueried.length,
    totalOpen: items.length,
    queried,
    unqueried,
    unresolved,
    items,
  };
}

/**
 * Render the operator card. PURE.
 *
 * @param {object} result
 * @param {number} [max]
 * @returns {string}
 */
export function renderQueues(result, max = 5) {
  const lines = [];
  if (result.storesQueried === 0) {
    lines.push(`${Y}ⓘ UPSTREAM QUEUES — NOTHING WAS CHECKED${X}`);
    lines.push(`  ${D}0 of ${result.storesQueried + result.storesUnqueried} store(s) answered. This is NOT an empty queue.${X}`);
  } else if (result.totalOpen === 0) {
    lines.push(`${G}✓ upstream queues: 0 open${X} ${D}across ${result.storesQueried} store(s)${X}`);
  } else {
    lines.push(`${B}ⓘ UPSTREAM REPORTS OPEN (non-blocking)${X}`);
    lines.push(`  ${result.totalOpen} report(s) awaiting triage across ${result.storesQueried} store(s) (showing <=${max}, most severe first):`);
    for (const it of result.items.slice(0, max)) {
      const from = it.repoName ? ` — from ${it.repoName}` : '';
      lines.push(`    • [${it.severity}] ${it.id} ${it.title.slice(0, 90)}${from}`);
    }
    if (result.totalOpen > max) lines.push(`    ${D}... ${result.totalOpen - max} more${X}`);
    lines.push(`  ${D}Triage against the store that owns the row — the ambient AUDIT_DB_URL is only one of them.${X}`);
  }

  // Printed on EVERY path, including the clean one. A store nobody could reach
  // is exactly the condition that made the old single-store read misleading,
  // so it must never be quieter than the good news beside it.
  for (const u of result.unqueried) {
    lines.push(`  ${R}unqueried${X} ${u.store} ${D}(${u.reason}) — its reports were NOT counted above${X}`);
  }
  for (const u of result.unresolved) {
    lines.push(`  ${Y}no store${X} ${u.repo} ${D}(${u.reason}) — this consumer's queue is invisible${X}`);
  }
  return lines.join('\n');
}

function main() {
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'upstream-queues' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const limitIdx = process.argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Math.max(1, Number.parseInt(process.argv[limitIdx + 1], 10) || 50) : 50;

  const { stores, unresolved } = discoverStores({
    repos: CONSUMER_REPOS,
    self: {
      name: 'this repo',
      url: process.env.AUDIT_DB_URL || null,
      sslMode: process.env.AUDIT_DB_SSL_MODE || null,
    },
    readEnvText: readRepoEnvText,
    fingerprintOf: storeFingerprint,
    sharedEnvText: readSharedEnvText(),
  });

  const result = collectQueues({
    stores, unresolved, query: (s) => queryStore(s, limit),
  });

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderQueues(result)}\n`);
  }
  // Always 0 — advisory. See the header.
  process.exit(0);
}

const invokedAsScript = (() => {
  try {
    return path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
})();
if (invokedAsScript) main();
