/**
 * @fileoverview The `--files-from` manifest wire format — one formatter, one
 * parser, so the two producers and the single reader cannot drift.
 *
 * The manifest is how a caller hands `extract.mjs` an explicit file list
 * without overflowing the OS argv limit (Windows `ENAMETOOLONG` at ~1600+
 * files). It is also the handoff that decides WHICH files an incremental
 * refresh extracts, so a path that mangles here is a file silently not
 * indexed.
 *
 * **Framing contract** (NUL, git `-z` style — same shape as `vcs.mjs`'s
 * `parseUntrackedPathsZ`, and `tests/nul-framing-parity.test.mjs` holds the two
 * to identical accept/reject decisions so the resemblance cannot silently rot):
 *   - Empty content is VALID and means a real zero-file scope (`[]`), never
 *     "unrestricted" (`null`) — see `isFullRunFromFiles`/`b021576b`.
 *   - Non-empty content MUST end in a NUL. A missing terminator means a
 *     truncated write; reading a short list as a complete one is silent data
 *     loss, so it throws.
 *   - Exactly one trailing empty token (after the final NUL) is discarded — it
 *     is framing, not a record.
 *   - An interior empty token is malformed and throws. Dropping it with
 *     `.filter(Boolean)` is the silent-data-loss class AGENTS.md names.
 *   - `formatFilesManifest` validates symmetrically, so a bad list fails at the
 *     producer rather than being coerced into a path that matches no file.
 *
 * **Why NUL, and why no legacy fallback.** Newline framing + `.trim()` was the
 * one lossy hop in a chain that is NUL-clean from `git diff -z` onward, and it
 * silently dropped files from the extraction scope. Sniffing both formats would
 * reopen it exactly: a path containing a newline is indistinguishable from a
 * separator. Losslessness is bounded to UTF-8-representable paths — `vcs.mjs`
 * spawns git with `encoding: 'utf-8'`, so non-UTF-8 bytes are already U+FFFD
 * before any path reaches a producer; widening here would fix nothing without
 * changing that layer first.
 *
 * This module owns the whole parent→child transport, not just the framing:
 * `writeFilesManifest`/`removeFilesManifest` live here so the private-temp-dir
 * half cannot be hand-rolled per producer either. (`lib/temp-paths.mjs`
 * deliberately wraps no bare `mkdtempSync`, and that stands — what is shared
 * here is the manifest-specific pairing of private directory + single framed
 * file + teardown.)
 *
 * Full incident history, the rejected alternatives (stdin transport, atomic
 * tmp+rename, format sniffing) and their adjudications:
 * `docs/plans/refactor-arch-memory-symbol-index-2026-07.md`.
 *
 * @module scripts/lib/symbol-index/files-manifest
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Serialize a file list to manifest content.
 *
 * Each path is written as its own NUL-TERMINATED record (not NUL-JOINED), so
 * an empty list yields empty content rather than a single bare NUL — which
 * would otherwise parse as one empty record and be rejected as malformed.
 *
 * **Validates symmetrically with `parseFilesManifest`** (shadow final-review
 * finding `3339be19`). The parser was strict while this was not, and template
 * interpolation made the asymmetry silent in the worst direction: a non-string
 * entry was coerced rather than refused. Measured before the fix —
 *   `[{from,to}]`  → `"[object Object]\0"` → parsed back as the literal path
 *                    `[object Object]`, which no file matches, so the entry was
 *                    silently dropped from the extraction scope;
 *   `[undefined]`  → the literal path `undefined`, same silent drop;
 *   `['']`         → a manifest THIS module's own parser rejects, with an error
 *                    blaming a truncated write or the retired newline format —
 *                    pointing the reader at the wrong layer entirely.
 * That is the silent-data-loss class the module exists to prevent, reintroduced
 * one function away from the guard against it. `refresh-file-scope.mjs` builds
 * its list partly from `diff.renamed.map(r => r.to)`, so a rename object is one
 * mapping slip from arriving here — this is not a hypothetical shape.
 *
 * Failing HERE names the producing call site while its stack is still live;
 * failing in the child names only the manifest.
 *
 * @param {string[]} paths
 * @returns {string}
 * @throws {TypeError} if `paths` is not an array of non-empty strings
 */
export function formatFilesManifest(paths) {
  if (!Array.isArray(paths)) {
    throw new TypeError(`formatFilesManifest: expected an array of paths, got ${typeof paths}`);
  }
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    if (typeof p !== 'string') {
      throw new TypeError(
        `formatFilesManifest: entry ${i} is ${p === null ? 'null' : typeof p}, expected a string. `
        + 'A non-string would be coerced into a literal path like "[object Object]" and then '
        + 'silently match no file — pass the path itself (e.g. `renamed.to`, not the rename object).',
      );
    }
    if (p === '') {
      throw new TypeError(
        `formatFilesManifest: entry ${i} is an empty string, which the parser rejects as a `
        + 'malformed record. Filter empty entries at the source rather than emitting them.',
      );
    }
    if (p.includes('\0')) {
      // A NUL inside a path cannot occur on POSIX or Windows, so this means the
      // caller passed already-framed content — double-framing it would split
      // one path into two records.
      throw new TypeError(
        `formatFilesManifest: entry ${i} contains a NUL byte. Pass raw paths; this function `
        + 'applies the framing.',
      );
    }
  }
  return paths.map(p => `${p}\0`).join('');
}

/**
 * Parse manifest content back into the exact file list that was written.
 *
 * @param {string} content
 * @param {string} [manifestPath] - included in error messages for locatability
 * @returns {string[]}
 * @throws {Error} on a missing NUL terminator or an interior empty token
 */
export function parseFilesManifest(content, manifestPath = '<manifest>') {
  // Zero-byte content is a legitimate zero-file scope, and it is ALSO what a
  // write truncated all the way to nothing looks like. Those two are
  // indistinguishable from the content alone (shadow `83c4d439`) — the
  // "truncation throws" guarantee above holds for a PARTIAL write, which
  // leaves a record without its terminator, not for total truncation. The
  // producer is where this is actually closed: `writeFilesManifest` creates
  // the file with `wx` inside a private directory and the only writer is a
  // single `writeFileSync`, so a zero-byte file means zero records were asked
  // for. Do not "fix" this by making empty content throw — that would break
  // the real zero-file incremental scope (b021576b) in exchange for a case
  // the transport already prevents.
  if (content === '') return [];
  if (!content.endsWith('\0')) {
    // The message names the retired format AND how to migrate, because format
    // sniffing is not an option here (a path containing a newline is
    // indistinguishable from a separator, which is the whole defect) — so a
    // loud, self-describing failure IS the migration path for the ad-hoc
    // caller. `extract.mjs` is an internal pipeline script, not an exposed npm
    // script or a documented CLI, so the in-repo producers are the only
    // callers that had to be migrated together.
    throw new Error(
      `--files-from manifest ${manifestPath} did not end with a NUL terminator — `
      + 'the write was truncated, or the file is in the retired newline-delimited format. '
      + 'This format is NUL-framed (git -z style) because a path may legally contain a '
      + "newline. To convert an existing newline manifest: tr '\\n' '\\0' < old > new",
    );
  }
  const tokens = content.split('\0');
  tokens.pop(); // discard exactly one trailing token: the empty string after the final NUL
  for (const t of tokens) {
    if (t === '') {
      throw new Error(`malformed --files-from manifest ${manifestPath}: empty path token`);
    }
  }
  return tokens;
}

/**
 * Write `paths` as a manifest inside a fresh, owner-only private directory and
 * return the manifest's absolute path.
 *
 * **Trust boundary, stated precisely** (R3 H1 → adjudicated `compromise`,
 * severity LOW). What the private directory closes:
 *   - cross-UID access: `mkdtempSync` creates the directory `0700`, so no
 *     OTHER user can read, substitute, or symlink the manifest;
 *   - name predictability: an unguessable name per call, so nothing can be
 *     pre-staged at a derivable path (a `<prefix>-<pid>-<ts>.txt` in the
 *     world-writable temp root could be, given the right clock and PID).
 *
 * What it does NOT close, deliberately: a process running as the SAME UID can
 * still substitute the manifest between this write and the child opening it.
 * No pathname scheme prevents that, and defending it here would be incoherent
 * — such a process can equally rewrite `extract.mjs` (the reader), rewrite
 * this module (the parser both producers share), modify the working tree about
 * to be indexed, or read `.env` for the API keys and DSN. A same-UID attacker
 * owns the toolchain; a lock on this one door buys nothing. A
 * `--files-from-stdin` transport was considered and rejected on those grounds:
 * it removes the race but adds a second IPC mode and bidirectional stream
 * lifecycle (partial writes, EPIPE, drain-order deadlock) to a shared
 * subprocess helper that owns stdio purely for JSONL results. Revisit only if
 * this boundary later crosses trust domains, or the toolchain becomes
 * immutable relative to the invoking user.
 *
 * Serialization happens BEFORE the directory is created, and the write is
 * wrapped, so neither a rejected file list nor a failed write can strand a
 * directory in the temp root (Gemini final-gate, LOW).
 *
 * @param {string[]} paths
 * @param {string} [prefix] - mkdtemp prefix, for locating a leak by producer
 * @returns {string} absolute path to the manifest
 */
export function writeFilesManifest(paths, prefix = 'files-manifest-') {
  const content = formatFilesManifest(paths);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const manifestPath = path.join(dir, 'files.manifest');
  try {
    fs.writeFileSync(manifestPath, content, { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    // The caller never receives the path, so its `finally` cannot clean up —
    // this is the only place that still can.
    removeFilesManifest(manifestPath);
    throw err;
  }
  return manifestPath;
}

/**
 * Remove a manifest written by `writeFilesManifest`, including the private
 * directory holding it — the directory IS the protection, so unlinking only
 * the file would leak one empty directory per call.
 *
 * Best-effort by design: cleanup failure must never fail the work it supported.
 * Tolerates `null`/`undefined` so callers need no branch.
 *
 * @param {string|null|undefined} manifestPath
 */
export function removeFilesManifest(manifestPath) {
  if (!manifestPath) return;
  try {
    // maxRetries/retryDelay: repo-wide Windows EPERM/EBUSY hardening
    // (tests/rmsync-retry-guard.test.mjs) — the child may still be releasing
    // its handle on the manifest as this runs.
    fs.rmSync(path.dirname(manifestPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch { /* best-effort — a stray temp dir is not worth failing the run */ }
}
