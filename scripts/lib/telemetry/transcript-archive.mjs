/**
 * @fileoverview Transcript archive core
 * (docs/plans/own-model-telemetry-pr3.md decision 8; memo section 6.8 "history that dies").
 *
 * Coordinator and chip transcripts are the only record of historical decisions and
 * Louis's corrections, and they die at an account switch. This keeps a redacted,
 * content-addressed copy in a local store OUTSIDE the repo, with a JSONL manifest.
 *
 * Eligibility is default-deny and decided by the repo flag the caller resolved:
 *   `true`            redact (secret patterns), refuse if a secret survives, store content
 *   `false`/`unknown` NO content: a manifest row with `content_state:'structure-only'` and the
 *                     sha256 of the (unredacted) input only - storyline is never archived
 *
 * Layout (`<dir>` = AUDIT_TRANSCRIPT_ARCHIVE_DIR, default ~/.audit-loop/transcript-archive):
 *   <dir>/blobs/<repo-slug>/<sha256>      per-repo, never shared across repos
 *   <dir>/manifest.jsonl                   one JSON object per archived transcript
 *   <dir>/.lock                            exclusive lock (O_EXCL), stale after 10 minutes
 *
 * Crash protocol: blob (temp+rename) THEN manifest row, under the lock. `verifyArchive`
 * reports an orphan blob (blob, no row) and a dangling row (row, no blob); `repair` removes
 * orphan blobs and marks dangling rows, so no state is silent. Off-machine durability is the
 * operator's backup decision, not this module's.
 *
 * @module scripts/lib/telemetry/transcript-archive
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets, scanForSecrets } from '../secret-patterns.mjs';

export const ARCHIVE_REDACTION_VERSION = 1;
export const LOCK_STALE_MS = 10 * 60 * 1000;
export const COORDINATORS = ['CES', 'WCA', 'STO', 'AIO', 'other'];

export function archiveDir(env = process.env) {
  return env.AUDIT_TRANSCRIPT_ARCHIVE_DIR || path.join(os.homedir(), '.audit-loop', 'transcript-archive');
}

/** PURE. A filesystem-safe slug of a repo name (`owner/repo` -> `owner__repo`). */
export function repoSlug(name) {
  const raw = String(name ?? '');
  const readable = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '__').replace(/^[_.]+|_+$/g, '').slice(0, 80);
  if (!raw.trim() || !readable) throw new Error('archive: unusable repo name');
  // A readable prefix is lossy (case, punctuation, truncation), so identity comes from a hash of the EXACT
  // name: two different repo names can never share a directory, and purging one cannot touch the other.
  return `${readable}-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 10)}`;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * PURE. Decide what to store for an input under a repo flag.
 * @param {string} text raw transcript text
 * @param {true|false|null|'unknown'} flag
 * @returns {{ok: true, contentState: 'full'|'structure-only', body: string|null, redactions: number, sha256: string, bytes: number}
 *   | {ok: false, reason: string}}
 */
export function prepareArchive(text, flag) {
  const raw = Buffer.from(String(text ?? ''), 'utf8');
  const base = { sha256: sha256(raw), bytes: raw.length };
  if (flag !== true) return { ok: true, contentState: 'structure-only', body: null, redactions: 0, ...base };
  const r = redactSecrets(String(text));
  if (scanForSecrets(r.text).matched) return { ok: false, reason: 'secret-survived-redaction' };
  return { ok: true, contentState: 'full', body: r.text, redactions: r.redacted.length, ...base, sha256: sha256(Buffer.from(r.text, 'utf8')), bytes: Buffer.byteLength(r.text) };
}

function acquireLock(dir, nowMs = Date.now()) {
  const lock = path.join(dir, '.lock');
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, String(nowMs));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(lock); } catch { /* already gone */ } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = 0;
      try { age = nowMs - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) { try { fs.unlinkSync(lock); } catch { /* raced */ } continue; }
      throw new Error('archive: another archive/purge holds the lock');
    }
  }
  throw new Error('archive: could not take the lock');
}

function readManifest(dir) {
  const p = path.join(dir, 'manifest.jsonl');
  if (!fs.existsSync(p)) return [];
  const rows = [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  lines.forEach((l, i) => {
    try { rows.push(JSON.parse(l)); } catch {
      // A crash mid-append can leave a truncated LAST line; skip it (the blob it described is an orphan that
      // `verify --repair` removes). Corruption anywhere else is not a crash artefact and must not be hidden.
      if (i !== lines.length - 1) throw new Error(`archive: manifest line ${i + 1} is corrupt`);
    }
  });
  return rows;
}

function writeManifest(dir, rows) {
  const p = path.join(dir, 'manifest.jsonl');
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/**
 * Archive one transcript. Idempotent: the same (repo, sha256) is recorded once.
 * @param {{dir: string, repo: string, coordinator: string, date: string, text: string, flag: true|false|null|'unknown'}} a
 * @returns {{ok: boolean, state?: 'archived'|'duplicate', contentState?: string, sha256?: string, reason?: string}}
 */
export function archiveTranscript({ dir, repo, coordinator, date, text, flag }) {
  if (!COORDINATORS.includes(coordinator)) return { ok: false, reason: 'bad-coordinator' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return { ok: false, reason: 'bad-date' };
  const slug = repoSlug(repo);
  const prep = prepareArchive(text, flag);
  if (!prep.ok) return prep;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const unlock = acquireLock(dir);
  try {
    const rows = readManifest(dir);
    // A crash can leave a partial last line with no newline; appending after it would fuse the two. Rewrite the
    // manifest from its parsed rows first so the new row always starts on a clean line.
    const mp = path.join(dir, 'manifest.jsonl');
    if (fs.existsSync(mp) && !fs.readFileSync(mp, 'utf8').endsWith('\n')) writeManifest(dir, rows);
    // Idempotent only when the stored state already satisfies this request: a structure-only row must not
    // swallow a later eligible request for the same bytes, and a row whose blob is gone must be restored.
    // Judge ALL rows for this content, not the first: an upgraded transcript has a structure-only row AND a full one.
    const matches = rows.filter((r) => r.repo_slug === slug && r.sha256 === prep.sha256);
    const full = matches.find((r) => r.content_state === 'full');
    const same = full ?? matches[0];
    const blobPath = path.join(dir, 'blobs', slug, prep.sha256);
    const satisfied = same && (prep.contentState === 'structure-only' || (full && fs.existsSync(blobPath)));
    if (satisfied) return { ok: true, state: 'duplicate', contentState: same.content_state, sha256: prep.sha256 };
    if (prep.contentState === 'full') {
      const bdir = path.join(dir, 'blobs', slug);
      fs.mkdirSync(bdir, { recursive: true, mode: 0o700 });
      const final = path.join(bdir, prep.sha256);
      const tmp = `${final}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, prep.body, { mode: 0o600 });
      fs.renameSync(tmp, final);
    }
    const row = {
      repo, repo_slug: slug, coordinator, date, sha256: prep.sha256, bytes: prep.bytes,
      content_state: prep.contentState, training_eligible: flag === true, redactions: prep.redactions,
      redaction_version: ARCHIVE_REDACTION_VERSION, archived_at: new Date().toISOString(),
    };
    fs.appendFileSync(path.join(dir, 'manifest.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    return { ok: true, state: 'archived', contentState: prep.contentState, sha256: prep.sha256 };
  } finally { unlock(); }
}

/**
 * Delete one repo's archived content and manifest rows.
 * @returns {{ok: true, blobsRemoved: number, rowsRemoved: number}}
 */
export function purgeRepo({ dir, repo }) {
  const slug = repoSlug(repo);
  if (!fs.existsSync(dir)) return { ok: true, blobsRemoved: 0, rowsRemoved: 0 };
  const unlock = acquireLock(dir);
  try {
    const bdir = path.join(dir, 'blobs', slug);
    let blobs = 0;
    if (fs.existsSync(bdir)) { blobs = fs.readdirSync(bdir).length; fs.rmSync(bdir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    const rows = readManifest(dir);
    const kept = rows.filter((r) => r.repo_slug !== slug);
    writeManifest(dir, kept);
    return { ok: true, blobsRemoved: blobs, rowsRemoved: rows.length - kept.length };
  } finally { unlock(); }
}

/**
 * Report (and with `repair`, fix) orphan blobs and dangling rows.
 * @returns {{ok: boolean, orphanBlobs: string[], danglingRows: string[], repaired: boolean}}
 */
export function verifyArchive({ dir, repair = false }) {
  if (!fs.existsSync(dir)) return { ok: true, orphanBlobs: [], danglingRows: [], repaired: false };
  const unlock = acquireLock(dir);
  try {
    const rows = readManifest(dir);
    const known = new Set(rows.filter((r) => r.content_state === 'full').map((r) => `${r.repo_slug}/${r.sha256}`));
    const orphanBlobs = [];
    const bRoot = path.join(dir, 'blobs');
    if (fs.existsSync(bRoot)) {
      for (const slug of fs.readdirSync(bRoot)) {
        for (const f of fs.readdirSync(path.join(bRoot, slug))) if (!known.has(`${slug}/${f}`)) orphanBlobs.push(`${slug}/${f}`);
      }
    }
    const danglingRows = rows.filter((r) => r.content_state === 'full' && !fs.existsSync(path.join(bRoot, r.repo_slug, r.sha256))).map((r) => `${r.repo_slug}/${r.sha256}`);
    if (repair) {
      for (const o of orphanBlobs) fs.rmSync(path.join(bRoot, o), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      if (danglingRows.length) writeManifest(dir, rows.map((r) => (danglingRows.includes(`${r.repo_slug}/${r.sha256}`) ? { ...r, content_state: 'missing' } : r)));
    }
    return { ok: orphanBlobs.length === 0 && danglingRows.length === 0, orphanBlobs, danglingRows, repaired: repair };
  } finally { unlock(); }
}
