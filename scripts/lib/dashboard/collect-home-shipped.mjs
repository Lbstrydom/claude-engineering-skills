/**
 * @fileoverview Home collector: Recently shipped — TWO separately bounded lists,
 * each its own MEASUREMENT: `shipped-log` (dated `status.md` entries, ≤ 10) and
 * `shipped-merges` (`git log --first-parent` subjects, i.e. squash-merges, ≤ 10).
 *
 * `status.md` is read from its head only (256 KB; entries are newest-first). A
 * heading that does not parse is COUNTED and surfaced, not dropped. The git half is
 * synchronous (`runGit` → `spawnSync`), so it runs inside the Home worker thread.
 *
 * Plan: docs/plans/dashboard-home-summary.md §2 (Recently shipped).
 *
 * @module scripts/lib/dashboard/collect-home-shipped
 */
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from '../fleet/git-facts.mjs';
import { parseStatusEntries, STATUS_HEAD_BYTES } from './status-entries.mjs';
import { makeMeasurement, clip } from './home-model.mjs';

export const SHIPPED_LIMIT = 10;
const GIT_TIMEOUT_MS = 10_000;

/**
 * Read at most {@link STATUS_HEAD_BYTES} bytes from the head of `status.md`.
 * @param {string} root
 * @returns {{text: string|null, absent: boolean, error: string|null, capped: boolean}} `capped`: the file is larger than the window (decided from fstat, not from the string length)
 */
export function readStatusHead(root) {
  const file = path.join(root, 'status.md');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(STATUS_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, STATUS_HEAD_BYTES, 0);
    const capped = fs.fstatSync(fd).size > STATUS_HEAD_BYTES;
    return { text: buf.subarray(0, n).toString('utf8'), absent: false, error: null, capped };
  } catch (err) {
    return err.code === 'ENOENT' ? { text: null, absent: true, error: null, capped: false } : { text: null, absent: false, error: `cannot read status.md (${err.code})`, capped: false };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

/**
 * The status-log measurement (pure over the head already read).
 * @param {{text: string|null, absent: boolean, error: string|null}} read
 * @param {Date} now
 */
export function shippedLog(read, now = new Date()) {
  const base = { id: 'shipped-log', label: 'Shipped (status log)', card: 'shipped', asOf: now.toISOString(), source: 'status.md (head, 256 KB)' };
  if (read.absent) return makeMeasurement({ ...base, status: 'missing-optional', detail: 'No status.md — nothing to list' });
  if (read.error) return makeMeasurement({ ...base, status: 'unexpected-error', detail: read.error });
  const { entries, skippedHeadings, capped } = parseStatusEntries(read.text, SHIPPED_LIMIT, { capped: read.capped });
  const notes = [skippedHeadings > 0 ? `${skippedHeadings} heading(s) unparsed` : '', capped ? 'partial: only the first 256 KB of status.md was read' : ''].filter(Boolean);
  return makeMeasurement({
    ...base, status: 'ok',
    value: { entries: entries.map((e) => ({ date: e.date, title: clip(e.title), planPath: e.planPath })), skippedHeadings, partial: capped },
    detail: notes.join('; '),
  });
}

/**
 * The ref squash-merges land on: origin's default branch, else a main/master. For each candidate
 * name the LOCAL branch wins, then its `refs/remotes/origin/<name>` (a clone whose HEAD is on a feature
 * branch has no local main); HEAD only when no named branch exists anywhere AND HEAD is a branch-less
 * fallback. `null` means nothing could be resolved, and the measurement says so.
 */
function mergeRef(root) {
  const origin = runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root, { timeoutMs: GIT_TIMEOUT_MS });
  const m = origin.ok ? /^origin\/(.+)$/.exec(origin.stdout.trim()) : null;
  const has = (ref) => runGit(['rev-parse', '--verify', '--quiet', ref], root, { timeoutMs: GIT_TIMEOUT_MS }).ok;
  for (const name of [m?.[1], 'main', 'master'].filter(Boolean)) {
    if (has(`refs/heads/${name}`)) return { ref: `refs/heads/${name}`, label: name };
    if (has(`refs/remotes/origin/${name}`)) return { ref: `refs/remotes/origin/${name}`, label: `origin/${name}` };
  }
  // The default branch could not be resolved. Falling back to HEAD is only honest if it SAYS so: an
  // attached feature branch is not the default branch, and its log is not "what shipped".
  return has('HEAD') ? { ref: 'HEAD', label: 'HEAD — default branch not resolved; this is the current branch, not what shipped' } : null;
}

/**
 * The merge-log measurement. SYNCHRONOUS (spawnSync): run it in the worker thread.
 * @param {string} root
 * @param {{now?: Date}} [opts]
 */
export function collectShippedMerges(root, { now = new Date() } = {}) {
  const base = { id: 'shipped-merges', label: 'Shipped (merges)', card: 'shipped', asOf: now.toISOString(), source: 'git log --first-parent' };
  const target = mergeRef(root);
  if (!target) return makeMeasurement({ ...base, status: 'missing-optional', detail: 'no default branch (local or origin) and no HEAD commit could be resolved' });
  const r = runGit(['log', '--first-parent', '-n', String(SHIPPED_LIMIT), '--format=%h%x00%s', target.ref], root, { timeoutMs: GIT_TIMEOUT_MS });
  if (!r.ok) return makeMeasurement({ ...base, status: 'missing-optional', detail: r.reason ?? 'git log failed' });
  const subjects = r.stdout.split('\n').filter(Boolean).map((l) => {
    const [sha7, ...rest] = l.split('\0');
    return { sha7, subject: clip(rest.join('\0')) };
  });
  return makeMeasurement({ ...base, source: `git log --first-parent ${target.label}`, status: 'ok', value: { branch: target.label, subjects } });
}
