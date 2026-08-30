#!/usr/bin/env node
/**
 * @fileoverview `stores:drift` — migration drift across EVERY store this
 * maintainer's consumers file into, not just the ambient one.
 *
 * ## The defect this closes (2026-08-30)
 *
 * `/ship` Step 0.5g runs `ship-commit --check-migrations`, which asks whether
 * **this** process's `AUDIT_DB_URL` is current. Consumers are not on one store,
 * and a consumer's own tooling is what notices its own drift — so a consumer
 * whose store falls behind is invisible from here until one of its writes hits
 * the realization guard.
 *
 * Measured: a consumer's Azure store sat **2 migrations behind** for a day. The
 * `.sql` files had synced to disk and were never applied, so its code and its
 * schema disagreed silently; the shipped `annotation` event could not have
 * worked there. Nothing in this repo could have said so, because nothing here
 * ever asked that store. It surfaced only when a routine upstream-report
 * closure was refused by the guard.
 *
 * This is the same shape `upstream-queues.mjs` closed for reports one day
 * earlier — a single-store read reporting its blindness as good news — and it
 * deliberately reuses that file's store discovery rather than growing a second
 * copy. Two readers, one oracle for "which stores exist".
 *
 * ## Never blocks, and never fakes a clean answer
 *
 * Advisory by construction (exit 0 even when a store is behind): applying a
 * migration to a consumer's production database is an operator decision, and a
 * gate that fires on something the pushed commit cannot change is what earns
 * `--no-verify`. But **queried and unqueried never render the same** — a run
 * that reached no store says NOTHING WAS CHECKED rather than printing zero.
 *
 * Source-repo-only: reads `consumer-repos.mjs`, whose private half is gitignored
 * and absent everywhere else. Never declared in `sync-to-repos.mjs`.
 *
 * Usage:
 *   node scripts/store-drift.mjs            # human report
 *   node scripts/store-drift.mjs --json     # machine-readable
 *
 * Exit codes: 0 — always (advisory) · 2 — usage error.
 *
 * @module scripts/store-drift
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './lib/load-env.mjs';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { CONSUMER_REPOS } from './lib/consumer-repos.mjs';
import {
  discoverStores, describeStore, readRepoEnvText, readSharedEnvText,
} from './lib/upstream/store-discovery.mjs';
import { storeFingerprint } from './lib/db/client.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP_CLI = path.join(REPO_ROOT, 'scripts', 'setup-postgres.mjs');
const KNOWN_FLAGS = ['--json', '--selfcheck-relocation'];

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

/** Per-store timeout. A wedged store must not stall a ship. */
const QUERY_TIMEOUT_MS = 30_000;

/**
 * Ask ONE store whether its schema matches this revision's migration set, in a
 * child process carrying that store's DSN and nothing else of ours.
 *
 * Never throws: an unreachable store returns `{ok:false}` with a reason, which
 * the caller renders as UNQUERIED rather than as a clean store.
 *
 * @param {{url: string, sslMode: string|null}} store
 * @returns {{ok: boolean, drift: object|null, reason: string|null}}
 */
export function queryStoreDrift(store) {
  try {
    const out = execFileSync(
      process.execPath,
      [SETUP_CLI, '--check-drift', '--format', 'json'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        timeout: QUERY_TIMEOUT_MS,
        windowsHide: true,
        // --check-drift exits 1 when it FINDS drift, which is data, not failure.
        // execFileSync throws on non-zero, so the status is read off the error.
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          AUDIT_DB_URL: store.url,
          ...(store.sslMode ? { AUDIT_DB_SSL_MODE: store.sslMode } : {}),
        },
      },
    );
    return parseDriftOutput(out);
  } catch (err) {
    // Exit 1 with a parseable payload is the drift-found path, not an error.
    if (err?.stdout) {
      const parsed = parseDriftOutput(String(err.stdout));
      if (parsed.ok) return parsed;
    }
    const reason = err?.signal === 'SIGTERM' ? 'timeout' : (err?.code || 'spawn-failed');
    return { ok: false, drift: null, reason: String(reason) };
  }
}

/** @param {string} out @returns {{ok: boolean, drift: object|null, reason: string|null}} */
function parseDriftOutput(out) {
  const start = out.indexOf('{');
  if (start === -1) return { ok: false, drift: null, reason: 'no-envelope-in-output' };
  try {
    const doc = JSON.parse(out.slice(start));
    if (typeof doc?.hasDrift !== 'boolean') return { ok: false, drift: null, reason: 'unexpected-envelope' };
    return { ok: true, drift: doc, reason: null };
  } catch {
    return { ok: false, drift: null, reason: 'unparseable-envelope' };
  }
}

/**
 * Collate every store's answer. PURE over the injected query function.
 *
 * @param {object} input
 * @param {Array<object>} input.stores
 * @param {Array<{repo: string, reason: string}>} input.unresolved
 * @param {(store: object) => {ok: boolean, drift: object|null, reason: string|null}} input.query
 * @returns {object}
 */
export function collectDrift({ stores, unresolved, query }) {
  const queried = [];
  const unqueried = [];
  const behind = [];

  for (const store of stores) {
    const res = query(store);
    if (!res.ok) {
      unqueried.push({ store: describeStore(store), reason: res.reason });
      continue;
    }
    const d = res.drift.drift ?? {};
    const unapplied = Array.isArray(d.unapplied) ? d.unapplied : [];
    const shaMismatch = Array.isArray(d.shaMismatch) ? d.shaMismatch : [];
    queried.push({ store: describeStore(store), unapplied: unapplied.length, shaMismatch: shaMismatch.length });
    // `orphanLedger` is DELIBERATELY not counted as behind: it means the store
    // knows a migration this checkout does not have, which is what a stale
    // working tree looks like from the store's side — not a store that is
    // missing anything. Counting it would make every out-of-date branch report
    // its consumers as broken.
    if (unapplied.length > 0 || shaMismatch.length > 0) {
      behind.push({
        store: describeStore(store),
        unapplied: unapplied.slice(0, 5),
        unappliedTotal: unapplied.length,
        shaMismatch: shaMismatch.slice(0, 5),
        shaMismatchTotal: shaMismatch.length,
      });
    }
  }

  return {
    storesQueried: queried.length,
    storesUnqueried: unqueried.length,
    storesBehind: behind.length,
    queried,
    unqueried,
    unresolved,
    behind,
  };
}

/**
 * Render the operator card. PURE.
 * @param {object} result
 * @returns {string}
 */
export function renderDrift(result) {
  const lines = [];
  if (result.storesQueried === 0) {
    lines.push(`${Y}ⓘ STORE MIGRATION DRIFT — NOTHING WAS CHECKED${X}`);
    lines.push(`  ${D}0 of ${result.storesQueried + result.storesUnqueried} store(s) answered. `
      + `This is NOT "every store is current".${X}`);
  } else if (result.storesBehind === 0) {
    lines.push(`${G}✓ store migrations: all current${X} ${D}across ${result.storesQueried} store(s)${X}`);
  } else {
    lines.push(`${B}ⓘ STORE BEHIND THIS REVISION (non-blocking)${X}`);
    lines.push(`  ${result.storesBehind} of ${result.storesQueried} store(s) do not match this revision's migrations:`);
    for (const s of result.behind) {
      if (s.unappliedTotal > 0) {
        lines.push(`    • ${s.store} — ${s.unappliedTotal} unapplied:`);
        for (const f of s.unapplied) lines.push(`        ${f}`);
        if (s.unappliedTotal > s.unapplied.length) {
          lines.push(`        ${D}... ${s.unappliedTotal - s.unapplied.length} more${X}`);
        }
      }
      if (s.shaMismatchTotal > 0) {
        lines.push(`    • ${s.store} — ${s.shaMismatchTotal} applied with a DIFFERENT sha (edited migration?)`);
      }
    }
    lines.push(`  ${D}That store's code and schema disagree: a feature can be fully synced and still inert there.${X}`);
    lines.push(`  ${D}Apply with that store's OWNER DSN (the runtime role usually cannot):${X}`);
    lines.push(`  ${D}  AUDIT_DB_URL=<owner dsn> node scripts/setup-postgres.mjs --migrate${X}`);
  }

  // Printed on EVERY path, including the clean one — a store nobody could reach
  // is precisely the condition that made the single-store read misleading.
  for (const u of result.unqueried) {
    lines.push(`  ${R}unqueried${X} ${u.store} ${D}(${u.reason}) — its drift was NOT assessed above${X}`);
  }
  for (const u of result.unresolved) {
    lines.push(`  ${Y}no store${X} ${u.repo} ${D}(${u.reason}) — this consumer's schema state is invisible${X}`);
  }
  return lines.join('\n');
}

function main() {
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'store-drift' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

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
  const result = collectDrift({ stores, unresolved, query: queryStoreDrift });

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderDrift(result)}\n`);
  }
  // Advisory, always. See the fileoverview.
  process.exit(0);
}

// Guarded: this module EXPORTS its pure collators for tests, and a bare main()
// would run the live fan-out — and its process.exit(0) — on import. Measured
// here: the first version of tests/store-drift.test.mjs reported "1 pass" having
// executed none of its assertions, because the import exited the test process.
// A suite that cannot fail is the unearned green this repo's own test guard
// exists to catch, arriving through the module system instead of the runner.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
