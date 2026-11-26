#!/usr/bin/env node
/**
 * @fileoverview `sync-status` — separates a consumer's dirty working tree into
 * "written by the claude-engineering-skills sync" vs "this repo's own edits".
 *
 * A sync writes straight into the consumer's working tree and never commits
 * (see `lib/sync-receipt.mjs`'s header for why self-committing was rejected).
 * That output — `.claude/skills/**`, `.sync-receipt.json`,
 * `scripts/.sync-owned.json` — then sits as ordinary uncommitted changes,
 * indistinguishable in plain `git status` from a person's own unfinished
 * edits. This CLI runs the same cross-reference a human had to do by hand
 * (open `scripts/.sync-manifest.json`, diff each file) using the ALREADY
 * shipped `scripts/.sync-owned.json` sidecar + git-ignore state, via the one
 * ownership oracle `debt-review.mjs` already trusts
 * (`lib/upstream-ownership.mjs`'s `createUpstreamOwnershipOracle`) — PLUS a
 * per-file content-hash check against `scripts/.sync-manifest.json`, because
 * ownership alone is not provenance (`/audit-code` round 1, H1/H6/H7 —
 * `docs/plans/sync-output-drift-classification.md`): a hand-edit to an owned
 * `SKILL.md`, or a human rename onto an owned path, must not inherit "safe to
 * commit" just because the PATH is one the sync manages. A path with no
 * verifiable hash match is reported under "needs review", never folded into
 * "safe to commit".
 *
 * REPORT-ONLY. Never stages or commits anything itself — see the "self-commit
 * rejected" rationale above; this tool exists so a human (or a pre-commit
 * hook) doesn't have to reverse-engineer the same answer by hand.
 *
 * Usage:
 *   node scripts/sync-status.mjs                  # human-readable report
 *   node scripts/sync-status.mjs --format json
 *   node scripts/sync-status.mjs --repo-root <dir>
 *
 * Exit codes:
 *   0  ran (report-only; a dirty tree, even an entirely unowned one, is not a failure)
 *   1  `git status` could not be read
 *   2  bad CLI input
 *
 * @module scripts/sync-status
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { createUpstreamOwnershipOracle } from './lib/upstream-ownership.mjs';
import { MANIFEST_RELATIVE_PATH, hashFile } from './lib/sync-manifest.mjs';
import {
  parsePorcelainZ, classifyDirtyEntries, createProvenanceVerifier, createRetirementVerifier, buildCommitSuggestion,
} from './lib/sync-status.mjs';
import { RECEIPT_PATH, readSyncReceipt } from './lib/sync-receipt.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';

const KNOWN_FLAGS = ['--format', '--repo-root', '--selfcheck-relocation'];
const KNOWN_FORMATS = new Set(['json', 'text']);
const G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

// Relocation smoke: proves this file's imports survive being synced into a
// consumer's `scripts/.claude-skills/`. Answered before anything else, and
// before `assertKnownFlags` — a probe that itself required valid flags could
// never prove the file loads at all.
if (process.argv.includes('--selfcheck-relocation') && isInvokedAsScript(import.meta.url)) { console.log('OK'); process.exit(0); }

/**
 * `scripts/.sync-manifest.json`'s `files` map (destination-relative path →
 * `sha256:…`), or `null` when absent/unreadable/malformed. `null` must never
 * be confused with `{}` — an empty map would assert "no path has a recorded
 * hash", which is a claim about content, not about the file being missing.
 *
 * @param {string} repoRoot
 * @returns {Record<string,string>|null}
 */
function loadManifestFiles(repoRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, MANIFEST_RELATIVE_PATH), 'utf-8'));
    return raw && typeof raw.files === 'object' && raw.files !== null ? raw.files : null;
  } catch {
    return null;
  }
}

/**
 * Receipt text -> its entries, newest first: `[]` for an absent file, `null` for one present but unreadable, malformed or
 * of a shape this code cannot read (audit R3 H2: a broken receipt must not read as "no retirements"). `null` makes every
 * deletion `unverified` — reviewed, never committed and never silently "not ours".
 *
 * @param {string|null} text — `null` when the file does not exist
 * @returns {object[]|null}
 */
function receiptEntriesOf(text) {
  if (text === null) return [];
  try {
    const read = readSyncReceipt(JSON.parse(text));
    return read.status === 'ok' ? read.entries : read.status === 'absent' ? [] : null;
  } catch {
    return null;
  }
}

/**
 * The working tree's receipt, read ONCE: the entries and the verdict on them come from the same bytes, so a receipt
 * replaced between a hash read and a parse read can never lend its verdict to the other snapshot (audit R5 H2).
 *
 * @param {string} repoRoot
 * @param {Record<string,string>|null} manifestFiles
 * @returns {{entries: object[]|null, verified: boolean}}
 */
function loadReceipt(repoRoot, manifestFiles) {
  let bytes;
  try { bytes = fs.readFileSync(path.join(repoRoot, RECEIPT_PATH)); } catch (err) { return { entries: err.code === 'ENOENT' ? [] : null, verified: false }; }
  const expected = manifestFiles?.[RECEIPT_PATH];
  const verified = typeof expected === 'string' && expected === `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  return { entries: receiptEntriesOf(bytes.toString('utf-8')), verified };
}

/**
 * Per PATH, the receipt entries whose retirement of it is already CONSUMED (`createRetirementVerifier`'s `committedAsOf`).
 *
 * A retirement is consumed once the path changed AFTER the entry was committed: the receipt as of the LAST commit that
 * touched the path already holds the entry. That is a re-creation (or a deletion) the consumer committed on top of the
 * retirement, so the record can no longer vouch for today's deletion (audit R1 H1). Where the entry is in HEAD's receipt but
 * the path is untouched since — an earlier sync PR committed the receipt without its deletions, the pre-fix behaviour —
 * the retirement is still pending, so it still rides (audit R3 H1/M1). HEAD only ever subtracts evidence; it never grants
 * ownership. Any git failure answers `null` (cannot tell), which makes a named deletion `unverified`.
 *
 * The receipt as of that commit misses one case: the consumer re-created the file and committed it ALONE while the
 * retirement was still uncommitted (audit R5 H1). So a working-tree entry is consumed too when that commit is dated at or
 * after the entry's `syncedAt` — the path changed after the retirement, whatever that commit's receipt says. An entry whose
 * `syncedAt` or that commit's date cannot be parsed counts as consumed (the conservative direction).
 *
 * @param {string} repoRoot
 * @param {object[]} workingEntries — the working tree's receipt entries
 * @returns {(rel: string) => object[]|null}
 */
function createCommittedReceiptReader(repoRoot, workingEntries) {
  const git = (args) => spawnSync('git', ['--literal-pathspecs', '-C', repoRoot, ...args], { encoding: 'utf-8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const byCommit = new Map();
  let shallow;
  return (rel) => {
    // A shallow clone's boundary reads as a root, so "the last commit that touched it" may be a commit history never had
    // (audit R4 H2): cannot tell.
    shallow ??= git(['rev-parse', '--is-shallow-repository']);
    if (shallow.status !== 0 || shallow.stdout.trim() !== 'false') return null;
    // `--first-parent`: default simplification (and `--full-history`, which drops a merge TREESAME to ANY parent) follows the
    // side of a merge that brought the path's content, so a merge carrying a side branch's edit onto the mainline after the
    // retirement would be dated to the side commit, before the retirement (audit R4 H1/H3). On the mainline that merge IS
    // the change: it consumes the retirement, the conservative direction.
    const last = git(['log', '-1', '--first-parent', '--format=%H %cI', 'HEAD', '--', rel]);
    if (last.status !== 0) return null;
    const [sha, committedAt] = last.stdout.trim().split(' ');
    if (!sha) return []; // never committed: nothing to consume
    const at = Date.parse(committedAt);
    const after = (workingEntries ?? []).filter((e) => !(Date.parse(e?.syncedAt) > at));
    if (!byCommit.has(sha)) {
      const listed = git(['ls-tree', '--name-only', sha, '--', RECEIPT_PATH]);
      const shown = listed.status === 0 && listed.stdout.trim() !== '' ? git(['show', `${sha}:${RECEIPT_PATH}`]) : null;
      byCommit.set(sha, listed.status !== 0 ? null
        : shown === null ? []
          : shown.status === 0 ? receiptEntriesOf(shown.stdout) : null);
    }
    const atCommit = byCommit.get(sha);
    return atCommit === null ? null : [...atCommit, ...after];
  };
}

/**
 * Run the classification pipeline for one consumer checkout: `git status`
 * → parse → ownership oracle + manifest provenance → `classifyDirtyEntries`.
 * Shared by `main()` below and by `scripts/sync-pr.mjs`, which turns the
 * `syncOwned` group into a branch + PR — ONE pipeline, so the two can never
 * disagree about what "written by the sync" means.
 *
 * @param {string} repoRoot
 * @returns {{ok:false, error:string}
 *   | {ok:true, clean:boolean,
 *      syncOwned: Array<{status:string, path:string, origPath:string|null}>,
 *      needsReview: Array<{status:string, path:string, origPath:string|null}>,
 *      other: Array<{status:string, path:string, origPath:string|null}>,
 *      manifestFound: boolean, degraded: boolean, partial: boolean, blindTo: string[]}}
 */
export function classifyRepo(repoRoot) {
  // `--untracked-files=all`, not the default `normal`: an entirely-untracked
  // directory collapses to one `dirname/` record under `normal`, which cannot
  // be classified against the sidecar's per-FILE path list — every file inside
  // reads as "not attributed" on a first sync, which is exactly the run where
  // the most sync-owned content exists. `all` lists each file individually.
  const status = spawnSync(
    'git',
    ['-C', repoRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { encoding: 'utf-8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  );
  if (status.error || typeof status.status !== 'number' || status.status !== 0) {
    return {
      ok: false,
      error: `\`git status\` failed in ${repoRoot}: ${status.error?.message || status.stderr || `exit ${status.status}`}`,
    };
  }

  const entries = parsePorcelainZ(status.stdout);
  if (entries.length === 0) {
    return { ok: true, clean: true, syncOwned: [], needsReview: [], other: [], manifestFound: true, degraded: false, partial: false, blindTo: [] };
  }

  const candidates = entries.flatMap((e) => (e.origPath ? [e.path, e.origPath] : [e.path]));
  const oracle = createUpstreamOwnershipOracle(repoRoot, candidates);
  const manifestFiles = loadManifestFiles(repoRoot);
  const isVerifiedSyncOutput = createProvenanceVerifier({
    manifestFiles,
    hashOf: (relPath) => {
      try { return hashFile(path.join(repoRoot, relPath)); } catch { return null; }
    },
  });
  // The receipt's `gcDeleted` is the sync's record of what it retired; its bytes must match the manifest to count.
  const receipt = loadReceipt(repoRoot, manifestFiles);
  const retirementOf = createRetirementVerifier({
    receiptEntries: receipt.entries,
    committedAsOf: createCommittedReceiptReader(repoRoot, receipt.entries),
    receiptVerified: receipt.verified,
    manifestFiles,
  });
  const { syncOwned, needsReview, other } = classifyDirtyEntries({
    entries, isUpstreamOwned: oracle.isUpstreamOwned, isVerifiedSyncOutput, retirementOf,
  });
  return {
    ok: true, clean: false, syncOwned, needsReview, other,
    manifestFound: manifestFiles !== null,
    degraded: oracle.degraded, partial: oracle.partial, blindTo: oracle.blindTo,
  };
}

/**
 * @param {string[]} argv
 * @param {NodeJS.WriteStream} out
 * @param {NodeJS.WriteStream} err
 * @returns {number} exit code
 */
export function main(argv = process.argv, out = process.stdout, err = process.stderr) {
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'sync-status' });

  const rest = argv.slice(2);
  // Requires a value, unlike a bare `indexOf` lookup — a trailing `--repo-root`
  // (nothing after it, or another flag) used to silently fall back to
  // `process.cwd()` and an unsupported `--format` value silently fell through
  // to the text path (`/audit-code` M3/M7). Malformed input now refuses
  // rather than inspecting an unintended repository.
  const flagValue = (name) => {
    const i = rest.indexOf(name);
    if (i === -1) return undefined;
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new ArgvError(`sync-status: ${name} requires a value`);
    }
    return v;
  };

  const formatRaw = flagValue('--format');
  if (formatRaw !== undefined && !KNOWN_FORMATS.has(formatRaw)) {
    throw new ArgvError(`sync-status: --format must be one of ${[...KNOWN_FORMATS].join('/')}, got "${formatRaw}"`);
  }
  const asJson = formatRaw === 'json';
  const repoRoot = path.resolve(flagValue('--repo-root') ?? process.cwd());

  const classified = classifyRepo(repoRoot);
  if (!classified.ok) {
    err.write(`sync-status: ${classified.error}\n`);
    return 1;
  }
  if (classified.clean) {
    if (asJson) {
      out.write(`${JSON.stringify({ repoRoot, syncOwned: [], needsReview: [], other: [], clean: true }, null, 2)}\n`);
    } else {
      out.write(`${G}Working tree is clean${X} — nothing to classify.\n`);
    }
    return 0;
  }
  const { syncOwned, needsReview, other } = classified;
  // The report below only asks "was a manifest found" and the oracle's
  // degradation flags; neither needs the underlying objects.
  const manifestFiles = classified.manifestFound ? {} : null;
  const oracle = { degraded: classified.degraded, partial: classified.partial, blindTo: classified.blindTo };
  // Display lists are the CURRENT path per entry; the commit needs BOTH sides
  // of a rename (`/audit-code` round 2 H2) so the old path's deletion lands
  // in the same commit as the new path's addition.
  const syncOwnedPaths = syncOwned.map((e) => e.path);
  const needsReviewPaths = needsReview.map((e) => e.path);
  const otherPaths = other.map((e) => e.path);

  if (asJson) {
    out.write(`${JSON.stringify({
      repoRoot, syncOwned: syncOwnedPaths, needsReview: needsReviewPaths, other: otherPaths,
      manifestFound: manifestFiles !== null,
      degraded: oracle.degraded, partial: oracle.partial, blindTo: oracle.blindTo,
    }, null, 2)}\n`);
    return 0;
  }

  out.write(`${B}Sync status${X}  ${D}${repoRoot}${X}\n\n`);

  if (oracle.degraded) {
    out.write(
      `  ${Y}⚠ no scripts/.sync-owned.json and no readable git-ignore state${X} — cannot tell `
      + `sync output from this repo's own edits. Run a sync from the upstream repo first.\n\n`,
    );
  } else if (oracle.partial) {
    out.write(`  ${Y}⚠ partial classification${X} ${D}(not examined: ${oracle.blindTo.join(', ')})${X}\n\n`);
  }
  if (manifestFiles === null) {
    out.write(
      `  ${Y}⚠ no scripts/.sync-manifest.json${X} ${D}— cannot verify owned paths were unmodified since `
      + `the last sync, so they are listed under "needs review" rather than "safe to commit".${X}\n\n`,
    );
  }

  if (syncOwnedPaths.length > 0) {
    out.write(`  ${G}Sync-owned${X} (${syncOwnedPaths.length}) — content verified unchanged since the last sync, safe to commit as-is:\n`);
    for (const p of syncOwnedPaths) out.write(`    ${D}${p}${X}\n`);
    out.write(`\n  ${buildCommitSuggestion(syncOwned, { repoRoot })}\n\n`);
  }

  if (needsReviewPaths.length > 0) {
    out.write(`  ${Y}Needs review${X} (${needsReviewPaths.length}) — sync-managed path, but content changed since the last sync (or unverifiable):\n`);
    for (const p of needsReviewPaths) out.write(`    ${p}\n`);
    out.write('\n');
  }

  if (otherPaths.length > 0) {
    out.write(`  ${B}Not attributed to the sync${X} (${otherPaths.length}):\n`);
    for (const p of otherPaths) out.write(`    ${p}\n`);
    out.write('\n');
  }

  if (syncOwnedPaths.length === 0 && needsReviewPaths.length === 0 && otherPaths.length === 0) {
    out.write(`  ${D}nothing to report${X}\n`);
  }

  return 0;
}

// Compare the RESOLVED file, not a path suffix — a suffix match is true in
// this repo and false at the consumer path `scripts/.claude-skills/sync-status.mjs`
// (the exact class workflow-cadence-doctor.mjs's own guard comment records).
const isDirectRun = isInvokedAsScript(import.meta.url);
if (isDirectRun) {
  try {
    await finishAndExit(main());
  } catch (e) {
    if (e instanceof ArgvError || e?.code === 'ARGV_ERROR') {
      process.stderr.write(`${e.message}\n`);
      await finishAndExit(2);
    } else {
      throw e;
    }
  }
}
