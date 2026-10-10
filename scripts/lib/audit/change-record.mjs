/**
 * @fileoverview The VCS change record + policy exclusions the file-coverage ledger needs, built where `--scope diff` is
 * computed. Kept out of `openai-audit.mjs` (over the size limit; it may not grow) — this is the seam between "every file git
 * says changed" and "the files the audit will read".
 *
 * A file dropped as audit infrastructure, by `--exclude-paths` / `.auditignore`, or because its type is not one anyone audits
 * is still a CHANGED file. The ledger has to be able to say so, so the record is taken from the UNFILTERED set, and the two
 * refusal lists are returned alongside the filtered candidates.
 *
 * @module scripts/lib/audit/change-record
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { isAuditInfraFile } from '../audit-scope.mjs';
import { parseDiffText } from '../diff-annotation.mjs';
import { normalizePath } from '../file-io.mjs';
import { parseNameStatusZ } from './file-coverage.mjs';

const defaultReadText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

/**
 * @param {object} input
 * @param {string[]} input.diffChanged `git diff --name-only <base>` output, split
 * @param {string[]} input.untrackedFiles `git ls-files --others --exclude-standard`, split
 * @param {string} input.baseSha the resolved, validated base
 * @param {boolean} input.allowInfraScope
 * @param {string[]} input.excludePatterns
 * @param {(files: string[], patterns: string[]) => string[]} input.applyExclusions
 * @param {typeof execFileSync} [input.run] injectable for tests
 * @param {(p: string) => string|null} [input.readText] injectable for tests (untracked files' line counts)
 * @returns {{changed: Array<{path: string, changeKind: string, renamedFrom: string|null, hunks?: object[]}>,
 *   excluded: {infra: string[], user: string[]}, candidates: string[], nameStatusError: string|null}}
 */
export function buildChangeRecord({ diffChanged, untrackedFiles, baseSha, allowInfraScope, excludePatterns, applyExclusions, run = execFileSync, readText = defaultReadText }) {
  const everyChanged = [...new Set([...diffChanged, ...untrackedFiles])];

  // Change KIND comes from git, never from filesystem presence. If the call fails (or its output is malformed) the SET is
  // unchanged but the kinds are UNKNOWN: they fall back to `modified` and the failure is returned + named on stderr, so a
  // deleted file mistaken for a modified one is a reported degradation, not a quiet one.
  let nameStatus = [];
  let nameStatusError = null;
  try {
    nameStatus = parseNameStatusZ(run('git', ['diff', '--name-status', '-z', baseSha], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }));
  } catch (err) {
    nameStatusError = err?.message || String(err);
    process.stderr.write(`  [coverage] change kinds unavailable (${nameStatusError}) — tracked files are recorded as \`modified\`\n`);
  }
  const byPath = new Map(nameStatus.map((r) => [r.path, r]));
  const untracked = new Set(untrackedFiles);
  const hunksByPath = readChangeHunks({ baseSha, untrackedFiles, run, readText });
  const changed = everyChanged.map((p) => {
    const rec = byPath.get(p) ?? { path: p, changeKind: untracked.has(p) ? 'untracked' : 'modified', renamedFrom: null };
    // `hunks` present = measured from the diff. Absent = unknown (diff unreadable, or no section for this path), which the
    // audit's hunk map treats as wholly changed, never as unchanged.
    // Only a path the parsed diff actually CONTAINS carries hunks. A path missing from it may be binary or mode-only —
    // or a section the parser did not recognise — so absence stays UNKNOWN (the hunk map then treats the file as
    // wholly changed), never a measured "no changed line" (code audit R2 H2/H3/H5). A null entry is unknown too.
    const measured = hunksByPath ? hunksByPath.get(normalizePath(p)) : null;
    return Array.isArray(measured) ? { ...rec, hunks: measured } : rec;
  });

  const infra = allowInfraScope ? [] : everyChanged.filter((f) => isAuditInfraFile(f));
  let candidates = everyChanged.filter((f) => allowInfraScope || !isAuditInfraFile(f));
  let user = [];
  if (excludePatterns.length > 0) {
    const kept = new Set(applyExclusions(candidates, excludePatterns));
    user = candidates.filter((f) => !kept.has(f));
    candidates = candidates.filter((f) => kept.has(f));
  }
  return { changed, excluded: { infra, user }, candidates, nameStatusError };
}

/**
 * New-side diff hunks per changed path, so an R1 `--scope diff` round can centre its read windows on the change and
 * count the changed lines it did not read (docs/plans/audit-hunk-window-coverage.md D6). R2+ gets the same from the
 * operator's `--diff`; R1 had none, so every head-cut changed file in R1 was unmeasurable.
 *
 * `--no-textconv`: a configured textconv driver would otherwise number the TRANSFORMED text, not the bytes the readers
 * render. The prefixes are forced (`--src-prefix/--dst-prefix`) because a user's `diff.noprefix` would otherwise turn every
 * `+++ b/x` header into `+++ x`, which `parseDiffText` does not recognise — the map would come back empty and look
 * like "no changes". `maxBuffer` is raised for the same reason: a truncated diff must fail, not parse short.
 * An untracked file is wholly new: one hunk covering every line.
 *
 * @returns {Map<string, Array<{startLine: number, lineCount: number}>|null>|null} keyed by normalised path; a null
 *   entry = that file's change is unknown; a null map = the diff could not be read at all
 */
export function readChangeHunks({ baseSha, untrackedFiles = [], run = execFileSync, readText = defaultReadText }) {
  let diffMap;
  try {
    const out = run('git', ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', baseSha], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 256 * 1024 * 1024,
    });
    diffMap = parseDiffText(String(out ?? ''));
  } catch (err) {
    process.stderr.write(`  [coverage] diff hunks unavailable (${err?.message || err}) — changed files are treated as wholly changed\n`);
    return null;
  }
  const map = new Map([...diffMap].map(([k, v]) => [k, v.hunks]));
  for (const p of untrackedFiles) {
    const text = readText(p);
    // An unreadable untracked file is UNKNOWN (null), never a measured empty change ([]).
    map.set(normalizePath(p), typeof text === 'string' ? [{ startLine: 1, lineCount: text.split('\n').length }] : null);
    if (typeof text !== 'string') process.stderr.write(`  [coverage] ${p}: untracked file could not be read for its line count — its change is unknown\n`);
  }
  return map;
}
