/**
 * @fileoverview Storage primitives for the tech-debt ledger: where it lives, how
 * one entry becomes one file, how the directory is read safely, the one lock
 * every mutation takes, and the git facts that decide which storage form a
 * write may use. No merge semantics live here — those are `debt-ledger.mjs`'s.
 *
 * **Why one file per entry** (docs/plans/debt-ledger-per-entry-files.md;
 * upstream report d338aa8a). A consumer that commits its ledger ran ~10 parallel
 * sessions, and every PR that recorded debt went DIRTY once another merged: the
 * single file carried a top-level `lastUpdated` every writer bumped, and its one
 * sorted array made two branches inserting neighbouring topicIds conflict on the
 * same gap. Separate files are separate PATHS — no merge engine conflicts on two
 * new paths, and none needs per-clone configuration to know that. A topicId is
 * the filename, so a duplicate topicId is unrepresentable.
 *
 * Layout (v2):
 *   <dir>/entries/<fileKey(topicId)>.json   one entry, keys sorted, pretty-printed
 *   <dir>/budgets.json                      optional ledger-wide policy
 * The legacy single file is `<dir>.json`; `<dir>` is that path without `.json`,
 * so every existing `--ledger x.json` argument keeps naming the same ledger.
 *
 * @module scripts/lib/debt-ledger-files
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import lockfile from 'proper-lockfile';

const LOCK_RETRIES = 5;
const LOCK_STALE_MS = 30_000;

/**
 * Both forms a ledger can take, derived from one path in either spelling.
 *
 * @param {string} ledgerPath - `.audit/tech-debt.json` or `.audit/tech-debt`
 * @returns {{dir: string, legacyFile: string, entriesDir: string, budgetsFile: string, stagingDir: string}}
 */
export function resolveLedgerLocation(ledgerPath) {
  const abs = path.resolve(ledgerPath);
  const dir = abs.toLowerCase().endsWith('.json') ? abs.slice(0, -'.json'.length) : abs;
  return {
    dir,
    legacyFile: `${dir}.json`,
    entriesDir: path.join(dir, 'entries'),
    budgetsFile: path.join(dir, 'budgets.json'),
    // Sibling, not child: a half-built migration must never be listed as the
    // ledger, and a sibling under `.audit/` stays ignored by `.audit/*` even in
    // a consumer that re-includes `.audit/tech-debt/`.
    stagingDir: `${dir}.migrating`,
  };
}

// ── topicId ⇄ filename ─────────────────────────────────────────────────────

const TOPIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/;

/**
 * Longest encoded basename (with `.json`) a topicId may produce. Bounded on the
 * ENCODED name, not the raw id: the case escape below can double an uppercase
 * id. 140 keeps `<repo>/.audit/tech-debt/entries/<name>` under Windows' 260-char
 * MAX_PATH for repo roots up to ~90 characters — git for Windows without
 * `core.longpaths` fails beyond it. Today's longest real id is 49 characters.
 */
export const MAX_ENTRY_BASENAME_BYTES = 140;

/**
 * Case-fold-safe, injective filename for a topicId: each uppercase letter `X`
 * becomes `~x`. A per-writer "does this name exist?" check cannot see another
 * branch — branch X adds `ABC`, branch Y adds `abc`, git merges two distinct
 * paths, and a case-insensitive filesystem cannot hold both. With every
 * filename lowercase, no two distinct ids can fold together anywhere. `~` is
 * outside the topicId alphabet, so the mapping is exactly reversible; an
 * all-lowercase id (every id seen so far) maps to itself.
 *
 * @param {string} topicId
 * @returns {string}
 */
export function fileKey(topicId) {
  return topicId.replace(/[A-Z]/g, (c) => `~${c.toLowerCase()}`);
}

/**
 * Inverse of `fileKey`. Returns null for a name `fileKey` cannot have produced
 * (an uppercase letter, or a `~` not followed by a lowercase letter) — such a
 * file was not written by this module and is treated as corruption.
 *
 * @param {string} key - basename without `.json`
 * @returns {string|null}
 */
export function decodeFileKey(key) {
  if (/[A-Z]/.test(key) || /~(?![a-z])/.test(key)) return null;
  return key.replace(/~([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Why `topicId` cannot be a filename, or null when it can. Refused, never
 * sanitised: two ids must never map to one file.
 *
 * @param {unknown} topicId
 * @returns {string|null}
 */
export function topicIdFilenameProblem(topicId) {
  if (typeof topicId !== 'string') return 'topicId is not a string';
  if (!TOPIC_ID_RE.test(topicId)) return 'topicId must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}';
  if (topicId.endsWith('.')) return 'topicId may not end in "."';
  const key = fileKey(topicId);
  if (WINDOWS_RESERVED_RE.test(key)) return 'topicId is a Windows reserved device name';
  if (Buffer.byteLength(`${key}.json`) > MAX_ENTRY_BASENAME_BYTES) {
    return `encoded filename exceeds ${MAX_ENTRY_BASENAME_BYTES} bytes`;
  }
  return null;
}

/**
 * @param {ReturnType<typeof resolveLedgerLocation>} location
 * @param {string} topicId - must already pass `topicIdFilenameProblem`
 * @returns {string}
 */
export function entryFilePath(location, topicId) {
  return path.join(location.entriesDir, `${fileKey(topicId)}.json`);
}

// ── Canonical bytes ─────────────────────────────────────────────────────────

/** Deep copy with object keys sorted; arrays keep their order. */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

/**
 * One entry's on-disk bytes. Keys sorted so two branches recording the same
 * logical entry write byte-identical files (git merges identical changes
 * cleanly); pretty-printed so a same-entry merge is a field-level text merge
 * and a hand resolution stays readable.
 *
 * @param {object} entry
 * @returns {string}
 */
export function serializeEntryForDisk(entry) {
  return `${JSON.stringify(sortKeysDeep(entry), null, 2)}\n`;
}

/** Order-insensitive equality of two JSON values (undefined = absent). */
export function canonicalEqual(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

// ── Path boundary ───────────────────────────────────────────────────────────

/**
 * Refuse a ledger path that runs through a symbolic link (on Windows `lstat`
 * also reports junctions as links) or an unexpected node type, checking every
 * existing component from the ledger directory down to `absPath`.
 *
 * Threat model (plan §5): a symlink that was COMMITTED — the directory is now
 * tracked in some consumers, so a pull request can add `entries` as a link to
 * anywhere — or created by accident. Not a concurrent local process swapping a
 * component between check and use: that process can already rewrite the ledger.
 *
 * @param {ReturnType<typeof resolveLedgerLocation>} location
 * @param {string} absPath - the file or directory about to be read or written
 * @param {{expect?: 'file'|'dir'}} [opts] - what `absPath` itself must be, if it exists
 */
export function assertLedgerPathSafe(location, absPath, { expect } = {}) {
  const fromDir = path.relative(location.dir, absPath);
  const insideDir = fromDir && !fromDir.startsWith('..') && !path.isAbsolute(fromDir);
  const chain = [];
  if (absPath === location.dir || insideDir) {
    chain.push(location.dir);
    let cur = location.dir;
    for (const part of insideDir ? fromDir.split(path.sep) : []) {
      cur = path.join(cur, part);
      chain.push(cur);
    }
  } else {
    chain.push(absPath); // the legacy file or staging dir — siblings of `dir`
  }
  for (let i = 0; i < chain.length; i++) {
    let st;
    try {
      st = fs.lstatSync(chain[i]);
    } catch (err) {
      if (err && err.code === 'ENOENT') return; // nothing further exists to traverse
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`Debt ledger path is a symbolic link (refused): ${chain[i]}`);
    }
    const isLast = i === chain.length - 1;
    const wantFile = isLast && expect === 'file';
    if (wantFile ? !st.isFile() : !st.isDirectory()) {
      // Coded like the fs error the old single-file read raised here, so a
      // reader maps it to 'ledger-unreadable' (unavailable), never to corruption.
      throw Object.assign(
        new Error(`Debt ledger path is not a ${wantFile ? 'regular file' : 'directory'}: ${chain[i]}`),
        { code: st.isDirectory() ? 'EISDIR' : 'ENOTDIR' },
      );
    }
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * A read raced a concurrent mutation (a listed file vanished). Retryable —
 * never corruption, never an empty ledger.
 */
export class TransientLedgerReadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransientLedgerReadError';
  }
}

/** File bytes, or null when absent. */
export function readBytesOrNull(absPath, fsImpl = fs) {
  try {
    return fsImpl.readFileSync(absPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/** True when `absPath` exists as a directory (no symlink following). */
export function isDirectory(absPath, fsImpl = fs) {
  try {
    return fsImpl.lstatSync(absPath).isDirectory();
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Read every entry file. Fail-closed: only regular, non-dot `*.json` files are
 * entries; anything else under `entries/` (a link, a directory, a FIFO) throws,
 * as does unparseable JSON (e.g. a hand resolution that left conflict markers)
 * or a filename that does not decode to the entry's own topicId. A file listed
 * and then gone is a race with a concurrent mutation → `TransientLedgerReadError`.
 *
 * @param {ReturnType<typeof resolveLedgerLocation>} location
 * @param {{fs?: typeof fs}} [opts] - injectable for deterministic race tests
 * @returns {object[]} entries, sorted by topicId
 */
export function readEntryDir(location, { fs: fsImpl = fs } = {}) {
  assertLedgerPathSafe(location, location.entriesDir);
  let dirents;
  try {
    dirents = fsImpl.readdirSync(location.entriesDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return []; // a ledger with no entries yet
    throw err;
  }
  const entries = [];
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue; // atomic-write temp files (`.tmp-<pid>-<ts>`)
    const abs = path.join(location.entriesDir, d.name);
    if (!d.isFile() || !d.name.endsWith('.json')) {
      throw new Error(`Debt ledger corrupted: unexpected ${d.isSymbolicLink() ? 'symbolic link' : 'entry'} in ${location.entriesDir}: ${d.name}`);
    }
    const id = decodeFileKey(d.name.slice(0, -'.json'.length));
    let text;
    try {
      text = fsImpl.readFileSync(abs, 'utf-8');
    } catch (err) {
      if (err && err.code === 'ENOENT') throw new TransientLedgerReadError(`${abs} vanished during the read`);
      throw err;
    }
    let entry;
    try {
      entry = JSON.parse(text);
    } catch (err) {
      throw new Error(`Debt ledger corrupted at ${abs}: ${err.message}`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || id === null || entry.topicId !== id) {
      throw new Error(`Debt ledger corrupted at ${abs}: the file does not hold the entry its name declares`);
    }
    entries.push(entry);
  }
  return entries.sort((a, b) => a.topicId.localeCompare(b.topicId));
}

/**
 * The v2 budgets policy. Absent and empty are different: absent declares no
 * policy, `{}` declares an empty one.
 *
 * @returns {{present: boolean, budgets: Record<string, number>|undefined}}
 */
export function readBudgetsFile(location, { fs: fsImpl = fs } = {}) {
  assertLedgerPathSafe(location, location.budgetsFile, { expect: 'file' });
  const bytes = readBytesOrNull(location.budgetsFile, fsImpl);
  if (bytes === null) return { present: false, budgets: undefined };
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf-8'));
  } catch (err) {
    throw new Error(`Debt ledger corrupted at ${location.budgetsFile}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Debt ledger corrupted at ${location.budgetsFile}: expected an object`);
  }
  return { present: true, budgets: parsed };
}

/**
 * Parse legacy bytes. Corruption throws, as it always has.
 *
 * @param {Buffer} bytes
 * @param {string} absPath - for the message
 * @returns {{entries: object[], budgets: Record<string, number>|undefined, raw: object}}
 */
export function parseLegacyBytes(bytes, absPath) {
  let raw;
  try {
    raw = JSON.parse(bytes.toString('utf-8'));
  } catch (err) {
    throw new Error(`Debt ledger corrupted at ${absPath}: ${err.message}`);
  }
  if (!raw || !Array.isArray(raw.entries)) {
    throw new Error(`Debt ledger corrupted: missing entries array at ${absPath}`);
  }
  const budgets = (typeof raw.budgets === 'object' && raw.budgets !== null && !Array.isArray(raw.budgets))
    ? raw.budgets : undefined;
  return { entries: raw.entries, budgets, raw };
}

// ── The one lock ────────────────────────────────────────────────────────────

/**
 * Run `fn` holding the ledger's single mutation lock: `proper-lockfile` on the
 * LEGACY FILE PATH with `realpath:false`, i.e. the lock directory
 * `<legacyFile>.lock`.
 *
 * Two properties, both load-bearing (plan §2.4):
 *  - Locking creates nothing that selects a storage form. `realpath:false`
 *    locks a path that need not exist; locking the ledger DIRECTORY would have
 *    required creating it — and an existing directory is exactly the signal
 *    that selects v2, so a tracked legacy ledger would have been flipped by
 *    its own lock acquisition.
 *  - Pre-upgrade synced tooling locks `<legacyFile>` with default options, whose
 *    lock directory is this same `<legacyFile>.lock` — one name, one mutex, so
 *    old and new writers exclude each other with no lock ordering to get wrong.
 *
 * @template T
 * @param {ReturnType<typeof resolveLedgerLocation>} location
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export async function withLedgerLock(location, fn) {
  fs.mkdirSync(path.dirname(location.legacyFile), { recursive: true });
  let release;
  try {
    release = await lockfile.lock(location.legacyFile, {
      realpath: false,
      retries: { retries: LOCK_RETRIES, minTimeout: 100, maxTimeout: 1000 },
      stale: LOCK_STALE_MS,
    });
  } catch (err) {
    throw new Error(
      `Failed to acquire debt-ledger lock at ${location.legacyFile}.lock: ${err.message}. `
      + 'Another audit-loop run may be mutating the ledger. '
      + `If stuck, inspect ${location.legacyFile}.lock and remove it if clearly stale.`,
    );
  }
  try {
    return await fn();
  } finally {
    try { await release(); } catch { /* lock already released / stale */ }
  }
}

// ── Git facts ───────────────────────────────────────────────────────────────

/** git in `cwd`, C locale (so a failure message is stable), never inheriting a hook's GIT_DIR. */
export function runGit(args, cwd, { input } = {}) {
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[k];
  return spawnSync('git', args, {
    cwd, encoding: 'utf-8', input, env, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The git work tree that contains `absPath`'s directory.
 *
 * @returns {{state: 'repo', root: string} | {state: 'no-repo'} | {state: 'unknown', reason: string}}
 */
export function workTreeOf(absPath) {
  let cwd = path.dirname(absPath);
  while (!fs.existsSync(cwd)) {
    const up = path.dirname(cwd);
    if (up === cwd) break;
    cwd = up;
  }
  const r = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (r.error) return { state: 'unknown', reason: `git unavailable: ${r.error.code || r.error.message}` };
  if (r.status === 0) return { state: 'repo', root: path.resolve(r.stdout.trim()) };
  if (/not a git repository/i.test(r.stderr || '')) return { state: 'no-repo' };
  return { state: 'unknown', reason: (r.stderr || '').trim().slice(0, 200) || `git exit ${r.status}` };
}

/** Repo-relative POSIX path. */
export function repoRelative(root, absPath) {
  return path.relative(root, absPath).split(path.sep).join('/');
}

/**
 * Whether the legacy file has git consequences — the ONLY fact that makes an
 * automatic migration safe (plan §2.4). `untracked` covers both "untracked in a
 * repo" and "in no repo at all"; `unknown` (git failed) is treated as tracked by
 * every caller, because the conservative branch is the one that cannot delete a
 * committed file.
 *
 * @param {string} legacyFile
 * @returns {'tracked'|'untracked'|'unknown'}
 */
export function legacyTrackingState(legacyFile) {
  const wt = workTreeOf(legacyFile);
  if (wt.state === 'no-repo') return 'untracked';
  if (wt.state !== 'repo') return 'unknown';
  const rel = repoRelative(wt.root, legacyFile);
  if (!rel || rel.startsWith('..')) return 'unknown';
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], {
      cwd: wt.root, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
    });
    return 'tracked';
  } catch (err) {
    return err && err.status === 1 ? 'untracked' : 'unknown';
  }
}

/**
 * Which of `relPaths` git would ignore — one batched, NUL-delimited call.
 * Throws when git cannot answer, so a caller can never read "could not check"
 * as "nothing ignored".
 *
 * @param {string} root - work tree root
 * @param {string[]} relPaths - repo-relative POSIX paths
 * @returns {string[]} the ignored subset
 */
export function ignoredPaths(root, relPaths) {
  if (relPaths.length === 0) return [];
  const r = runGit(['check-ignore', '-z', '--stdin'], root, { input: `${relPaths.join('\0')}\0` });
  if (r.error) throw new Error(`trackability could not be established: ${r.error.message}`);
  if (r.status === 1) return [];
  if (r.status === 0) return r.stdout.split('\0').filter(Boolean);
  throw new Error(`trackability could not be established: git check-ignore exit ${r.status}: ${(r.stderr || '').trim()}`);
}

// ── Legacy single-file serialization ────────────────────────────────────────

/**
 * Render a LEGACY single-file ledger: every top-level field pretty-printed
 * normally EXCEPT `entries`, which renders one compact JSON object per line.
 * Still the write path for a tracked ledger that has not been migrated yet
 * (plan §2.4 rule 3), and for a migration remainder.
 *
 * **Format-only — never deduplicates.** Renders EXACTLY the `entries` array it
 * is given, in order: a Map keyed by topicId would silently discard one of a
 * resolved/unresolved duplicate pair (docs/plans/debt-ledger-merge-safety.md).
 * Assembled by hand rather than by regex-collapsing `JSON.stringify(x, null, 2)`,
 * which could corrupt a string VALUE containing `},\n{`-shaped text.
 *
 * Moved here from `debt-ledger.mjs` (re-exported there) so the migration module
 * can use it without an import cycle.
 *
 * @param {{entries?: object[], [key: string]: any}} ledger
 * @returns {string} JSON text, trailing newline included
 */
export function serializeLedgerForDisk(ledger) {
  const parts = [];
  for (const [key, value] of Object.entries(ledger)) {
    if (key === 'entries') {
      const arr = Array.isArray(value) ? value : [];
      const body = arr.map((e) => `    ${JSON.stringify(e)}`).join(',\n');
      parts.push(`  "entries": [\n${body ? `${body}\n` : ''}  ]`);
    } else {
      parts.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
    }
  }
  return `{\n${parts.join(',\n')}\n}\n`;
}

/** Budgets file bytes (keys sorted, pretty). */
export function serializeBudgetsForDisk(budgets) {
  return `${JSON.stringify(sortKeysDeep(budgets), null, 2)}\n`;
}
