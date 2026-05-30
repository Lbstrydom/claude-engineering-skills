#!/usr/bin/env node
/**
 * @fileoverview Remove files that were synced under the legacy layout.
 *
 * Run from the CONSUMER side AFTER the new layout has been hydrated.
 * Iterates the legacy manifest (passed via --legacy-manifest), removes
 * each entry under `scripts/<NOT-.claude-skills>/...` from both the git
 * index (if tracked) and the working tree.
 *
 * Security contract:
 *   - Manifest entries are UNTRUSTED input. Every path is validated
 *     against a safe relative-path regex (no `..`, no leading `/` or
 *     drive letter, no control chars) and re-checked for containment
 *     under consumer-root after resolution. Any failure is reported
 *     and the file is skipped — no shell interpolation, no destructive
 *     filesystem ops outside the consumer tree.
 *   - All subprocess calls use `execFileSync` with argument arrays —
 *     no shell-string interpolation that could be hijacked by a
 *     malicious manifest entry.
 *
 * Safety contract (R1 H10 fix):
 *   - By default, modified tracked files cause an ABORT before any
 *     destructive operation. The user re-runs with `--force-dirty`
 *     to acknowledge and proceed; the choice is recorded in the
 *     summary so PR reviewers can see it.
 *
 * Tolerates ENOENT, surfaces modified-tracked files separately. Never
 * touches files NOT in the legacy manifest — native consumer files
 * stay untouched.
 *
 * Plan §7, §10 Phase 3 step 7.
 *
 * @module scripts/lib/remove-legacy-synced
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LAYOUT_CONSTANTS } from './sync-path-map.mjs';
import { SyncManifestSchema } from './sync-manifest.mjs';

// Strict safe relative path: no traversal, no absolute, no control chars.
const SAFE_REL_PATH = /^(?!\.\.\/)(?!\/)(?![A-Za-z]:[/\\])[A-Za-z0-9_./\-+@]+$/;

function parseArgs(argv) {
  const out = {
    consumerRoot: process.cwd(),
    legacyManifest: null,
    dryRun: false,
    forceDirty: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--consumer-root') out.consumerRoot = argv[++i];
    else if (a === '--legacy-manifest') out.legacyManifest = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force-dirty') out.forceDirty = true;
    else if (a === '--selfcheck-relocation') out.selfcheckRelocation = true;
  }
  return out;
}

function validateRelPath(relPath, consumerRoot) {
  if (typeof relPath !== 'string') return { ok: false, error: 'not a string' };
  if (!relPath) return { ok: false, error: 'empty' };
  // Normalise backslashes first so the regex sees forward slashes only.
  const norm = relPath.replace(/\\/g, '/');
  if (!SAFE_REL_PATH.test(norm)) return { ok: false, error: 'unsafe characters or traversal' };
  if (norm.split('/').some((seg) => seg === '..')) return { ok: false, error: 'traversal' };
  // Containment check after resolution.
  const abs = path.resolve(consumerRoot, norm);
  const rootResolved = path.resolve(consumerRoot) + path.sep;
  if (abs !== path.resolve(consumerRoot) && !abs.startsWith(rootResolved)) {
    return { ok: false, error: 'escapes consumer-root' };
  }
  return { ok: true, normalised: norm, abs };
}

function isTracked(consumerRoot, relPath) {
  // R2 H10 fix: distinguish "not tracked" (exit 1) from "git command failed"
  // (any other error). Silent-false on git failure would treat unknown state
  // as untracked and proceed with destructive ops — exactly the bug.
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relPath], {
      cwd: consumerRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, tracked: true };
  } catch (err) {
    // Git's --error-unmatch returns exit 1 for "file is not tracked" with
    // a specific stderr message. Any other status (binary missing,
    // permission error, etc.) is a hard failure.
    if (err.status === 1) {
      return { ok: true, tracked: false };
    }
    return { ok: false, error: `git ls-files failed (status=${err.status}): ${err.message?.slice(0, 200)}` };
  }
}

function isModified(consumerRoot, relPath) {
  // R2 H10 fix: same as isTracked — a git failure means we don't KNOW the
  // state, which is different from "not modified". Propagate error.
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', relPath], {
      cwd: consumerRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Porcelain v1 format: XY <space> path. Empty output → clean.
    const modified = /^[ MARC?][MD]/.test(out) || /^[MARC]/.test(out);
    return { ok: true, modified };
  } catch (err) {
    return { ok: false, error: `git status failed: ${err.message?.slice(0, 200)}` };
  }
}

function gitRm(consumerRoot, relPath, dryRun) {
  if (dryRun) return { ok: true, dryRun: true };
  try {
    execFileSync('git', ['rm', '-f', '--cached', '--', relPath], {
      cwd: consumerRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function fsUnlink(absPath, dryRun) {
  if (dryRun) return { ok: true, dryRun: true };
  try {
    fs.unlinkSync(absPath);
    return { ok: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, alreadyGone: true };
    return { ok: false, error: err.message };
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.selfcheckRelocation) {
    console.log('OK');
    process.exit(0);
  }

  if (!opts.legacyManifest) {
    process.stderr.write('[remove-legacy-synced] --legacy-manifest <path> required\n');
    process.exit(2);
  }
  if (!fs.existsSync(opts.legacyManifest)) {
    process.stderr.write(`[remove-legacy-synced] legacy manifest not found: ${opts.legacyManifest}\n`);
    process.exit(2);
  }
  let rawLegacy;
  try {
    rawLegacy = JSON.parse(fs.readFileSync(opts.legacyManifest, 'utf-8'));
  } catch (err) {
    process.stderr.write(`[remove-legacy-synced] failed to parse legacy manifest: ${err.message}\n`);
    process.exit(2);
  }
  // R2 H11 fix: validate manifest shape via the canonical Zod schema before
  // any decision derives from manifest contents. Malformed manifests get
  // rejected here, not silently treated as empty.
  const parsedLegacy = SyncManifestSchema.safeParse(rawLegacy);
  if (!parsedLegacy.success) {
    const issues = parsedLegacy.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
    process.stderr.write(`[remove-legacy-synced] legacy manifest schema invalid:\n  ${issues.join('\n  ')}\n`);
    process.exit(2);
  }
  const legacy = parsedLegacy.data;

  const summary = {
    consumerRoot: opts.consumerRoot,
    dryRun: opts.dryRun,
    forceDirty: opts.forceDirty,
    totalLegacyEntries: 0,
    skippedAlreadyIsolated: 0,
    skippedNonScripts: 0,
    skippedInvalidPath: [],
    skippedHashMismatch: [],
    skippedMissingExpectedHash: [],
    modifiedTrackedFiles: [],
    untrackedDeletions: [],
    trackedDeletions: [],
    alreadyGone: [],
    errors: [],
  };

  // ── Pass 1: validate all paths + collect modified-tracked files ──
  // We do NOT mutate the filesystem until validation passes and the
  // dirty-files preflight either clears or is explicitly --force-dirty.
  const candidates = [];
  for (const [destRel, expectedHash] of Object.entries(legacy.files || {})) {
    summary.totalLegacyEntries++;
    if (!destRel.startsWith('scripts/')) {
      summary.skippedNonScripts++;
      continue;
    }
    const isolatedPrefix = `${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/`;
    if (destRel === LAYOUT_CONSTANTS.MANIFEST_PATH || destRel.startsWith(isolatedPrefix)) {
      summary.skippedAlreadyIsolated++;
      continue;
    }
    const v = validateRelPath(destRel, opts.consumerRoot);
    if (!v.ok) {
      summary.skippedInvalidPath.push({ path: destRel, reason: v.error });
      continue;
    }
    // R2 H5 fix: ownership hash verification. If the file exists on disk
    // BUT its current sha differs from the manifest's recorded hash, the
    // user (or another tool) modified our generated content. Skip the
    // deletion so we don't destroy that work. The summary surfaces the
    // skipped paths for operator review.
    if (!expectedHash) {
      summary.skippedMissingExpectedHash.push(destRel);
      continue;
    }
    if (fs.existsSync(v.abs)) {
      let actualHash;
      try {
        actualHash = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(v.abs)).digest('hex');
      } catch (err) {
        summary.errors.push({ path: destRel, op: 'hash', error: err.message?.slice(0, 200) });
        continue;
      }
      if (actualHash !== expectedHash) {
        summary.skippedHashMismatch.push({ path: destRel, expected: expectedHash, actual: actualHash });
        continue;
      }
    }
    const trackedRes = isTracked(opts.consumerRoot, v.normalised);
    if (!trackedRes.ok) {
      summary.errors.push({ path: destRel, op: 'git-ls-files', error: trackedRes.error });
      continue;
    }
    let modifiedRes = { ok: true, modified: false };
    if (trackedRes.tracked) {
      modifiedRes = isModified(opts.consumerRoot, v.normalised);
      if (!modifiedRes.ok) {
        summary.errors.push({ path: destRel, op: 'git-status', error: modifiedRes.error });
        continue;
      }
    }
    if (modifiedRes.modified) summary.modifiedTrackedFiles.push(v.normalised);
    candidates.push({
      relPath: v.normalised, abs: v.abs,
      tracked: trackedRes.tracked, modified: modifiedRes.modified,
    });
  }

  // R2 H10 fix: errors in the validation pass abort BEFORE destructive ops.
  if (summary.errors.length > 0) {
    process.stderr.write(`\n[remove-legacy-synced] ABORT: ${summary.errors.length} validation error(s):\n`);
    for (const e of summary.errors.slice(0, 10)) {
      process.stderr.write(`  ${e.path}  (${e.op}: ${e.error})\n`);
    }
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    process.exit(2);
  }

  // ── Preflight: abort on modified tracked files unless --force-dirty ──
  if (summary.modifiedTrackedFiles.length > 0 && !opts.forceDirty) {
    process.stderr.write(
      `\n[remove-legacy-synced] ABORT: ${summary.modifiedTrackedFiles.length} tracked legacy file(s) have local modifications.\n` +
      `These would be destroyed by the removal. Re-run with --force-dirty to acknowledge and proceed.\n\n`
    );
    for (const p of summary.modifiedTrackedFiles) process.stderr.write(`  ${p}\n`);
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    process.exit(3);
  }

  // ── Pass 2: apply destructive operations ──
  for (const { relPath, abs, tracked } of candidates) {
    if (tracked) {
      const rmResult = gitRm(opts.consumerRoot, relPath, opts.dryRun);
      if (!rmResult.ok) {
        summary.errors.push({ path: relPath, op: 'git-rm', error: rmResult.error });
        continue;
      }
      summary.trackedDeletions.push(relPath);
    } else {
      summary.untrackedDeletions.push(relPath);
    }
    const unlinkResult = fsUnlink(abs, opts.dryRun);
    if (!unlinkResult.ok) {
      summary.errors.push({ path: relPath, op: 'unlink', error: unlinkResult.error });
    } else if (unlinkResult.alreadyGone) {
      summary.alreadyGone.push(relPath);
    }
  }

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

  if (summary.modifiedTrackedFiles.length && opts.forceDirty) {
    process.stderr.write(`\n[remove-legacy-synced] WARNING: ${summary.modifiedTrackedFiles.length} tracked legacy file(s) had local modifications when --force-dirty was set:\n`);
    for (const p of summary.modifiedTrackedFiles) process.stderr.write(`  ${p}\n`);
  }
  if (summary.skippedInvalidPath.length) {
    process.stderr.write(`\n[remove-legacy-synced] WARNING: ${summary.skippedInvalidPath.length} manifest entries had unsafe paths (skipped):\n`);
    for (const e of summary.skippedInvalidPath) process.stderr.write(`  ${e.path}  (${e.reason})\n`);
  }
  if (summary.skippedHashMismatch.length) {
    process.stderr.write(`\n[remove-legacy-synced] WARNING: ${summary.skippedHashMismatch.length} file(s) had locally-modified content (hash mismatch); preserved on disk:\n`);
    for (const e of summary.skippedHashMismatch) process.stderr.write(`  ${e.path}\n`);
  }
  if (summary.skippedMissingExpectedHash.length) {
    process.stderr.write(`\n[remove-legacy-synced] WARNING: ${summary.skippedMissingExpectedHash.length} manifest entries had no recorded hash (cannot verify ownership; skipped):\n`);
    for (const p of summary.skippedMissingExpectedHash) process.stderr.write(`  ${p}\n`);
  }

  process.exit(summary.errors.length ? 2 : 0);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) main();

export const _internals = {
  SAFE_REL_PATH, parseArgs, validateRelPath, isTracked, isModified, gitRm, fsUnlink,
};
