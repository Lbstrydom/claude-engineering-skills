/**
 * @fileoverview The session log as one file per entry — name grammar, validation, listing, reading.
 *
 * **Why.** Every `/ship` used to insert its entry at the TOP of one file, so two PRs shipping at
 * once always collided in `status.md` (four times in one day, 2026-10-15). A new entry is now a
 * NEW FILE under `docs/status/entries/`; a new path never conflicts, nothing is rendered, and
 * the old log stays where it is as frozen history.
 *
 * **One marker, one resolver.** Per-entry mode is ON at a revision iff the tracked control file
 * `docs/status/entries/README.md` exists there. {@link perEntryMode} is the ONLY place that
 * says so; the readers, the writer instructions and the gate all call it. A directory holding
 * entries but no marker is NOT per-entry mode and the gate names it (`entries-without-marker`).
 *
 * **Entry records vs the marker.** {@link isEntryRecordPath} is the single predicate that
 * separates an entry record from the marker; every enumerator goes through it, so the marker is
 * never validated as an entry and never conserved as one (it has its own law).
 *
 * Plan: docs/plans/fleet-chips-and-merge-friction.md §12.
 *
 * @module scripts/lib/status-entry-files
 */

import fs from 'node:fs';
import path from 'node:path';

export const ENTRIES_DIR = 'docs/status/entries';
export const MARKER_REL = `${ENTRIES_DIR}/README.md`;
export const ROOT_LOG = 'status.md';

/** `<YYYY-MM-DD>-<HHMMSS>-<kebab-slug>.md`; the capture groups are date, time, slug. */
export const ENTRY_NAME_RE = /^(\d{4}-\d{2}-\d{2})-(\d{6})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const HEADING_RE = /^## (\d{4}-\d{2}-\d{2})\b(.*)$/;

/** Default head window, matching the dashboard's existing 256 KB cap on `status.md`. */
export const LOG_HEAD_BYTES = 256 * 1024;

/**
 * THE per-entry-mode resolver. Pure: give it the repo-relative paths that exist at a revision
 * (a `git ls-tree` listing, or a directory read mapped to repo-relative paths).
 * @param {Iterable<string>} paths
 * @returns {boolean}
 */
export function perEntryMode(paths) {
  for (const p of paths) if (p === MARKER_REL) return true;
  return false;
}

/**
 * Whether a repo-relative path is an ENTRY RECORD: a direct child of the entries directory that
 * is a markdown file and is not the marker. Anything else under the directory (a nested folder,
 * a stray `.txt`) is not an entry record — and is reported by the gate, not silently ignored.
 * @param {string} rel
 */
export function isEntryRecordPath(rel) {
  if (typeof rel !== 'string' || !rel.startsWith(`${ENTRIES_DIR}/`)) return false;
  const name = rel.slice(ENTRIES_DIR.length + 1);
  return !name.includes('/') && name.endsWith('.md') && rel !== MARKER_REL;
}

/**
 * Whether a repo-relative path is a month ARCHIVE: a direct child of `docs/status/` that is not the
 * README. `ls-tree -r` also lists `entries/` (not archives), and the README is the index: it carries
 * `## ` section headings, so reading it as an archive froze its prose and failed any edit to it.
 * @param {string} rel
 */
export function isArchivePath(rel) {
  if (typeof rel !== 'string' || !rel.startsWith('docs/status/')) return false;
  const name = rel.slice('docs/status/'.length);
  return !name.includes('/') && name.endsWith('.md') && name !== 'README.md';
}

/**
 * @param {string} name - a file name (no directory)
 * @returns {{date: string, time: string, slug: string}|null}
 */
export function parseEntryName(name) {
  const m = ENTRY_NAME_RE.exec(String(name ?? ''));
  return m ? { date: m[1], time: m[2], slug: m[3] } : null;
}

/**
 * Whether a NEW entry file is well-formed (Law 8). Returns the list of problems; empty = fine.
 * @param {string} name - file name
 * @param {string} text - file content
 * @returns {string[]}
 */
export function validateEntryText(name, text) {
  const problems = [];
  const parsed = parseEntryName(name);
  if (!parsed) problems.push(`name "${name}" does not match <YYYY-MM-DD>-<HHMMSS>-<kebab-slug>.md`);
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const m = HEADING_RE.exec(lines[0] ?? '');
  if (!m) problems.push('first line must be a "## YYYY-MM-DD — summary" heading');
  else {
    if (!m[2].trim()) problems.push('the heading has a date but no summary');
    if (parsed && parsed.date !== m[1]) problems.push(`heading date ${m[1]} differs from the file name's ${parsed.date}`);
  }
  const headings = lines.filter((l) => /^## /.test(l)).length;
  if (headings !== 1) problems.push(`must hold exactly one "## " heading, found ${headings}`);
  if (!lines.slice(1).some((l) => l.trim())) problems.push('entry has no body under its heading');
  return problems;
}

/**
 * Entry record file names on disk, NEWEST FIRST (filename order is chronological by construction).
 * Names that fail the grammar are still returned — a reader must show what is there, and the gate
 * is what rejects a bad name.
 * @param {string} root - repo root
 * @returns {string[]} repo-relative paths
 */
export function listEntryFiles(root) {
  let names;
  try { names = fs.readdirSync(path.join(root, ENTRIES_DIR)); } catch { return []; }
  return names
    .map((n) => `${ENTRIES_DIR}/${n}`)
    .filter(isEntryRecordPath)
    .sort()
    .reverse();
}

/** Whether per-entry mode is on in the working tree at `root`. */
export function perEntryModeOnDisk(root) {
  return perEntryMode(fs.existsSync(path.join(root, MARKER_REL)) ? [MARKER_REL] : []);
}

/**
 * The log's head for the readers: entry files newest-first, then the head of `status.md`, within
 * `maxBytes` in total. With no entries directory this is exactly the old `status.md` head.
 *
 * `capped` is true when anything in either source was left unread, decided from file sizes and not
 * from the length of the string returned.
 *
 * @param {string} root
 * @param {number} [maxBytes]
 * @returns {{text: string|null, absent: boolean, error: string|null, capped: boolean}}
 */
export function readLogHead(root, maxBytes = LOG_HEAD_BYTES) {
  const parts = [];
  let used = 0;
  let capped = false;
  const take = (file) => {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const room = Math.max(0, maxBytes - used);
      const buf = Buffer.alloc(Math.min(size, room));
      const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, 0) : 0;
      if (size > n) capped = true;
      parts.push(buf.subarray(0, n).toString('utf8'));
      used += n;
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err.code };
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  };
  for (const rel of listEntryFiles(root)) {
    if (used >= maxBytes) { capped = true; break; }
    const r = take(path.join(root, rel));
    if (!r.ok) return { text: null, absent: false, error: `cannot read ${rel} (${r.code})`, capped: false };
    if (!parts[parts.length - 1].endsWith('\n')) parts[parts.length - 1] += '\n';
  }
  let rootAbsent = false;
  if (used >= maxBytes && fs.existsSync(path.join(root, ROOT_LOG))) {
    capped = true;
  } else {
    const r = take(path.join(root, ROOT_LOG));
    if (!r.ok) {
      if (r.code === 'ENOENT') rootAbsent = true;
      else return { text: null, absent: false, error: `cannot read ${ROOT_LOG} (${r.code})`, capped: false };
    }
  }
  if (rootAbsent && parts.length === 0) return { text: null, absent: true, error: null, capped: false };
  return { text: parts.join(''), absent: false, error: null, capped };
}
