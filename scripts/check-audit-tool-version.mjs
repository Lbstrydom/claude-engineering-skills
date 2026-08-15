#!/usr/bin/env node
/**
 * @fileoverview Consumer-side audit-tool version-staleness check.
 *
 * Fetches the upstream sync manifest from claude-engineering-skills' main
 * branch and compares it against local copies of the synced files. Warns when
 * the consumer's audit tool is out of date.
 *
 * Usage:
 *   node scripts/check-audit-tool-version.mjs           # human-readable
 *   node scripts/check-audit-tool-version.mjs --json    # JSON output
 *   node scripts/check-audit-tool-version.mjs --quiet   # suppress warnings
 *
 * Exit codes:
 *   0  current (or source repo, or check disabled)
 *   1  stale — at least one file differs from upstream
 *   2  network/fetch error
 *   3  internal error
 *
 * Env:
 *   AUDIT_TOOL_VERSION_CHECK=skip   disables the check (returns 0 immediately)
 *   AUDIT_TOOL_MANIFEST_URL=<url>   override default upstream URL
 */

import './lib/load-env.mjs';
import {
  fetchUpstreamManifest,
  compareToUpstream,
  isSourceRepo,
  findRepoRoot,
  UPSTREAM_MANIFEST_URL,
  DEFAULT_FETCH_TIMEOUT_MS,
} from './lib/sync-manifest.mjs';

const JSON_MODE = process.argv.includes('--json');
const QUIET = process.argv.includes('--quiet');

function emit(obj) {
  if (JSON_MODE) process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function warn(msg) {
  if (!QUIET && !JSON_MODE) process.stderr.write(msg);
}

// Set exit code and return — process exits cleanly after the event loop
// drains, so buffered stdout/stderr writes flush even when redirected.
// Direct process.exit() can truncate those writes; this avoids it.
function done(code) {
  process.exitCode = code;
}

async function main() {
  const root = findRepoRoot();

  if (process.env.AUDIT_TOOL_VERSION_CHECK === 'skip') {
    emit({ verdict: 'SKIPPED', reason: 'AUDIT_TOOL_VERSION_CHECK=skip' });
    return done(0);
  }

  if (isSourceRepo(root)) {
    emit({ verdict: 'SOURCE_REPO' });
    warn('[sync-check] Source repo — skipping self-check.\n');
    return done(0);
  }

  let upstream;
  try {
    upstream = await fetchUpstreamManifest(UPSTREAM_MANIFEST_URL, { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS });
  } catch (err) {
    // Coerce non-Error throwables defensively — JS allows throwing strings
    // or plain objects, and we don't want the failure-handling path to fail.
    const errMessage = (err && typeof err === 'object' && typeof err.message === 'string')
      ? err.message
      : String(err);
    // Separate verdict for transport-level failures (network, timeout) vs
    // manifest-integrity failures (schema mismatch, oversized payload,
    // unparseable JSON).  Both still exit 2, but the verdict tells the
    // operator whether to retry or to investigate upstream.
    const integrityMarkers = [
      'Invalid upstream manifest',
      'Upstream payload exceeds',
    ];
    const verdict = integrityMarkers.some((m) => errMessage.includes(m))
      ? 'INVALID_MANIFEST'
      : 'NETWORK_ERROR';
    emit({ verdict, error: errMessage });
    warn(`[sync-check] Could not fetch upstream manifest (${verdict}): ${errMessage}\n`);
    return done(2);
  }

  const diff = compareToUpstream(root, upstream);

  if (diff.current) {
    emit({
      verdict: 'CURRENT',
      upstreamCommit: diff.upstreamCommit,
      upstreamGeneratedAt: diff.upstreamGeneratedAt,
    });
    warn(`[sync-check] OK — audit tool matches upstream @ ${diff.upstreamCommit || '(unknown)'}\n`);
    return done(0);
  }

  emit({
    verdict: 'STALE',
    upstreamCommit: diff.upstreamCommit,
    upstreamGeneratedAt: diff.upstreamGeneratedAt,
    stale: diff.stale,
    missing: diff.missing,
    rejected: diff.rejected,
  });

  if (!QUIET && !JSON_MODE) {
    const lines = [
      '',
      '  ──── audit-tool version check ──────────────────────────────',
      `  Upstream: claude-engineering-skills @ ${diff.upstreamCommit || '(unknown)'}`,
      `  Generated: ${diff.upstreamGeneratedAt || '?'}`,
    ];
    if (diff.stale.length) {
      lines.push(`  Stale files (${diff.stale.length}):`);
      for (const f of diff.stale.slice(0, 10)) lines.push(`    - ${f}`);
      if (diff.stale.length > 10) lines.push(`    ... and ${diff.stale.length - 10} more`);
    }
    if (diff.missing.length) {
      lines.push(`  Missing files (${diff.missing.length}):`);
      for (const f of diff.missing.slice(0, 10)) lines.push(`    - ${f}`);
      if (diff.missing.length > 10) lines.push(`    ... and ${diff.missing.length - 10} more`);
    }
    if (diff.rejected && diff.rejected.length) {
      lines.push(`  Rejected paths (${diff.rejected.length}):`);
      for (const f of diff.rejected.slice(0, 5)) lines.push(`    - ${f}`);
    }
    lines.push('  Fix: from claude-engineering-skills, run `npm run sync`');
    lines.push('  Or set AUDIT_TOOL_VERSION_CHECK=skip to suppress this check.');
    lines.push('  ────────────────────────────────────────────────────────────');
    lines.push('');
    process.stderr.write(lines.join('\n') + '\n');
  }

  return done(1);
}

main().catch((err) => {
  emit({ verdict: 'INTERNAL_ERROR', error: err.message });
  warn(`[sync-check] Internal error: ${err.message}\n`);
  done(3);
});
