#!/usr/bin/env node
/**
 * @fileoverview `telemetry:export` — write a redacted `telemetry-export/v1` summary of THIS
 * consumer's audit store into a drop directory CES can read.
 *
 * For a consumer whose store sits behind a private network, so CES cannot connect to it
 * (docs/plans/private-store-telemetry-path.md). Default OFF and opt-in per consumer: nothing
 * runs this unless a maintainer or a configured trigger does, and with no drop directory it
 * refuses rather than guess a destination.
 *
 * What it writes is an ALLOWLIST (lib/telemetry-export/schema.mjs): counts and closed enums
 * only — no finding text, titles, paths, repo names, hostnames or DSNs. A group it could not
 * read is `measured:false`, never zero. Before anything is written the serialised bytes are
 * re-checked (lib/telemetry-export/redact.mjs) and an export that trips it is REFUSED.
 *
 * Usage:
 *   node scripts/telemetry-export.mjs --alias <alias> --drop-dir <dir> [--push]
 *   node scripts/telemetry-export.mjs --alias <alias> --print        # build + print, deliver nothing
 *   node scripts/telemetry-export.mjs --alias <alias> --drop-dir <dir> --if-older-than 24   # skip when a recent export exists
 *
 * Env: TELEMETRY_CONSUMER_ALIAS, TELEMETRY_DROP_DIR (flags win); TELEMETRY_EXPORT_PUSH=1 is --push.
 *
 * `--if-older-than <hours>` makes it cheap to call from any trigger (weekly maintenance, a pre-push hook): when
 * this alias already has a valid export newer than that, it exits 0 having read nothing from the store.
 * Exit: 0 written (or printed) · 1 refused / failed · 2 usage.
 *
 * @module scripts/telemetry-export
 */
import './lib/load-env.mjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError, argOption, hasFlag, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { buildExport } from './lib/telemetry-export/build.mjs';
import { makeRowReader } from './lib/telemetry-export/sources.mjs';
import { deliverExport, pushPending } from './lib/telemetry-export/deliver.mjs';
import { ExportRefusedError } from './lib/telemetry-export/redact.mjs';
import { scanDrop } from './lib/telemetry-export/reader.mjs';
import { stdoutNamesUnreachableStore } from './lib/store/backlog-gather.mjs';

const KNOWN_FLAGS = ['--alias', '--drop-dir', '--push', '--print', '--if-older-than', '--selfcheck-relocation'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP_CLI = path.join(HERE, 'setup-postgres.mjs');

/** `setup-postgres --check-drift --live --format json`, read the way `stores:drift` reads it. */
function runDriftChild() {
  try {
    const out = execFileSync(process.execPath, [SETUP_CLI, '--check-drift', '--live', '--format', 'json'], {
      cwd: path.resolve(HERE, '..'), encoding: 'utf-8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseDrift(out);
  } catch (err) {
    // Exit 1 with a parseable payload is the drift-FOUND path, not a failure.
    if (err?.stdout) {
      const parsed = parseDrift(String(err.stdout));
      if (parsed.ok) return parsed;
      if (stdoutNamesUnreachableStore(String(err.stdout))) return { ok: false, reason: 'store-unreachable' };
    }
    return { ok: false, reason: 'read-failed' };
  }
}

function parseDrift(out) {
  const start = out.indexOf('{');
  if (start === -1) return { ok: false, reason: 'read-failed' };
  try {
    const doc = JSON.parse(out.slice(start));
    return typeof doc?.hasDrift === 'boolean' ? { ok: true, drift: doc } : { ok: false, reason: 'read-failed' };
  } catch { return { ok: false, reason: 'read-failed' }; }
}

/**
 * Every failure leaves BOTH a diagnostic on stderr (the human) and `{ok:false,error:{code}}` on stdout (the machine),
 * the CLI contract: a caller parsing stdout must not mistake a failure for silence. Codes only — no message text,
 * which can carry a host.
 */
async function fail(code, exitCode) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code } })}\n`);
  await finishAndExit(exitCode);
}

async function main() {
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'telemetry-export' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); await fail('USAGE', 2); return; }
    throw err;
  }
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); await finishAndExit(0); return; }

  const alias = argOption('alias') || process.env.TELEMETRY_CONSUMER_ALIAS || '';
  const dropDir = argOption('drop-dir') || process.env.TELEMETRY_DROP_DIR || '';
  const printOnly = hasFlag('print');
  const push = hasFlag('push') || process.env.TELEMETRY_EXPORT_PUSH === '1';
  const olderThanRaw = argOption('if-older-than');
  const olderThanHours = olderThanRaw === null || olderThanRaw === undefined ? null : Number(olderThanRaw);
  if (olderThanHours !== null && !(Number.isFinite(olderThanHours) && olderThanHours > 0)) {
    process.stderr.write('telemetry-export: --if-older-than needs a positive number of hours\n');
    await fail('USAGE', 2); return;
  }
  if (!/^[a-z0-9-]{1,32}$/.test(alias)) {
    process.stderr.write('telemetry-export: --alias (or TELEMETRY_CONSUMER_ALIAS) must match [a-z0-9-]{1,32}\n');
    await fail('USAGE', 2); return;
  }
  if (printOnly && push) {
    process.stderr.write('telemetry-export: --print and --push are mutually exclusive (printing delivers nothing)\n');
    await fail('USAGE', 2); return;
  }
  if (!printOnly && !dropDir) {
    process.stderr.write('telemetry-export: no drop directory — pass --drop-dir or set TELEMETRY_DROP_DIR (or use --print)\n');
    await fail('USAGE', 2); return;
  }

  // Throttle: a recent valid export for THIS alias means there is nothing to do (and nothing to read).
  if (olderThanHours !== null && printOnly) {
    process.stderr.write('telemetry-export: --print and --if-older-than are mutually exclusive (printing is never throttled; it also delivers nothing)\n');
    await fail('USAGE', 2); return;
  }
  if (olderThanHours !== null && dropDir) {
    const prior = scanDrop({ dropDir, expected: [{ alias, cadence: 'on-demand' }], now: new Date() }).aliases[0];
    if (prior?.state === 'received') {
      const hours = (Date.now() - Date.parse(prior.generatedAt)) / 3_600_000;
      // A negative age is a FUTURE timestamp (the reader tolerates up to a day of clock skew): it is not evidence
      // of a recent export, so it never throttles.
      if (hours >= 0 && hours < olderThanHours) {
        // A recent FILE is not a delivered export: when a push is requested, deliver anything of this alias's
        // that an earlier failed push left behind BEFORE skipping.
        if (push) {
          try { pushPending({ dropDir, alias }); } catch (err) {
            process.stderr.write(`telemetry-export: an earlier export could not be delivered (${String(err?.message ?? err).split('\n')[0]})\n`);
            await fail('DELIVERY_FAILED', 1); return;
          }
        }
        process.stdout.write(`${JSON.stringify({ ok: true, skipped: 'recent-export', ageHours: Math.floor(hours) })}\n`);
        await finishAndExit(0); return;
      }
    }
  }

  const [{ probeStoreReachability }, client, query, repoStore, identity, upstreamCmds] = await Promise.all([
    import('./lib/doctor/store-reachability.mjs'),
    import('./lib/db/client.mjs'),
    import('./lib/db/query.mjs'),
    import('./lib/store/repo.mjs'),
    import('./lib/repo-identity.mjs'),
    import('./lib/upstream/commands.mjs'),
  ]);

  const dsn = client.resolveDbUrl?.() ?? process.env.AUDIT_DB_URL ?? null;
  const stamp = upstreamCmds.readBundleStamp(path.resolve(HERE, '..'));
  const sha = stamp?.commitSha && /^[0-9a-f]{40}$/.test(stamp.commitSha) ? stamp.commitSha : null;

  let doc;
  try {
    doc = await buildExport({
      now: new Date(),
      consumerAlias: alias,
      storeFingerprint: dsn ? client.storeFingerprint(dsn) : null,
      toolBundleSha: sha,
      exportId: crypto.randomUUID(),
      deps: {
        reachability: () => probeStoreReachability({ subjectRoot: process.cwd(), loadEnv: () => ({}), injectResolvedDbEnv: () => {} }),
        drift: async () => runDriftChild(),
        readRows: makeRowReader({
          withTx: query.withTx,
          many: query.many,
          query: query.query,
          getRepoIdByUuid: (u) => repoStore.getRepoIdByUuid(u, { strict: true }),
          resolveRepoIdentity: () => identity.resolveRepoIdentity(process.cwd()),
        }),
      },
    });
  } catch (err) {
    // Never print err.message of a refusal beyond its categories; a generic failure's message may carry a host.
    process.stderr.write(err instanceof ExportRefusedError
      ? `${err.message}\n`
      : 'telemetry-export: the export could not be built (nothing was written)\n');
    await fail(err instanceof ExportRefusedError ? 'EXPORT_REFUSED' : 'BUILD_FAILED', 1); return;
  } finally {
    try { await client.closePool?.(); } catch { /* best effort */ }
  }

  if (printOnly) {
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    await finishAndExit(0); return;
  }
  try {
    const r = deliverExport({ doc, dropDir, push });
    process.stdout.write(`${JSON.stringify({ ok: true, file: r.file, pushed: r.pushed })}\n`);
    await finishAndExit(0);
  } catch (err) {
    process.stderr.write(`telemetry-export: delivery failed (${String(err?.message ?? err).split('\n')[0]})\n`);
    await fail('DELIVERY_FAILED', 1);
  }
}

/**
 * The outermost boundary: anything that escapes `main` (a failed dynamic import, URL resolution, the bundle-stamp read) is
 * still a failure with a machine-readable code, never an unhandled rejection with a stack and no `{ok:false}`.
 */
async function guarded() {
  try {
    await main();
  } catch {
    process.stderr.write('telemetry-export: initialisation failed (nothing was written)\n');
    await fail('BUILD_FAILED', 1);
  }
}

if (isInvokedAsScript(import.meta.url)) await guarded();
