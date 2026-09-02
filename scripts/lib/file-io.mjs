/**
 * @fileoverview Core file I/O utilities + barrel re-exports.
 *
 * Core: atomic writes, path normalization, safe parsing, readFileOrDie, writeOutput.
 * Re-exports: audit-scope, diff-annotation, plan-paths (backward compat for all 19+ importers).
 *
 * @module scripts/lib/file-io
 */

import fs from 'node:fs';
import path from 'node:path';
import { retrySync } from './retry-transient-fs.mjs';

// ── Atomic File Writes ──────────────────────────────────────────────────────
// Write to a temp file in the same directory, then rename for crash-safety.

/**
 * Real implementation body, parameterized over the fs functions so tests
 * can inject a failing renameFn/unlinkFn and exercise the whole function
 * (symlink-following, mkdirSync, temp-write, retry-wrapped rename,
 * cleanup-on-failure) rather than mocking at the module boundary.
 */
export function atomicWriteFileSyncImpl(filePath, data, {
  mode,
  exclusive = false,
  renameFn = fs.renameSync,
  unlinkFn = fs.unlinkSync,
  linkFn = fs.linkSync,
} = {}) {
  let absPath = path.resolve(filePath);
  // Gemini-r3-r2 G1: symlink preservation. If the target is a symlink
  // (common for dotfiles managed by stow / chezmoi / etc., e.g. ~/.audit-loop.env
  // → ~/dotfiles/audit-loop.env), follow it to the physical target so the
  // atomic rename replaces the file's CONTENTS, not the symlink itself.
  // Without this, the rename destroys the symlink and breaks the operator's
  // dotfile manager. Best-effort: if lstat/realpath errors, fall through.
  try {
    if (fs.lstatSync(absPath).isSymbolicLink()) {
      absPath = fs.realpathSync(absPath);
    }
  } catch { /* target doesn't exist yet — first write — no symlink to follow */ }
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}`);
  // Forward mode to fs.writeFileSync so the temp file is created with the
  // requested permission bits AT OPEN — secure-mode-at-create for secrets
  // files (plan: docs/plans/shared-cloud-config.md Gemini-G4). Default
  // (mode undefined) preserves Node's prior open-with-umask behaviour.
  const writeOpts = mode !== undefined ? { encoding: 'utf-8', mode } : 'utf-8';
  try {
    fs.writeFileSync(tmpPath, data, writeOpts);
    if (exclusive) {
      // No-clobber enforced by the FILESYSTEM, not by a prior existence check.
      // `link` fails EEXIST atomically if the destination already exists, so
      // there is no window between the test and the write. A caller that does
      // `if (!existsSync(f)) atomicWrite(f)` has exactly that window, and
      // `rename` then clobbers whatever appeared in it — the guarantee reads as
      // enforced while being advisory. `link` keeps both properties: the
      // content is complete before it is ever visible under the final name.
      retrySync(() => linkFn(tmpPath, absPath));
      unlinkFn(tmpPath);      // the link is the file now; drop the temp name
    } else {
      retrySync(() => renameFn(tmpPath, absPath));
    }
  } catch (err) {
    try { unlinkFn(tmpPath); } catch (cleanupErr) {
      process.stderr.write(`  [atomic-write] Temp file cleanup failed: ${cleanupErr.message}\n`);
    }
    throw err;
  }
}

/**
 * @param {string} filePath
 * @param {string} data
 * @param {{mode?: number, exclusive?: boolean}} [opts] - `exclusive: true` makes
 *   the write fail with `EEXIST` rather than replace an existing file, without a
 *   check-then-write race. Default (false) is today's atomic replace.
 */
export function atomicWriteFileSync(filePath, data, { mode, exclusive } = {}) {
  atomicWriteFileSyncImpl(filePath, data, { mode, exclusive });
}

export const _internals = { atomicWriteFileSyncImpl };

// ── Line-ending canonicalization ────────────────────────────────────────────

/**
 * Fold CRLF to LF for hashing and byte comparison. Replaces ONLY the byte
 * sequence `0x0D 0x0A` with `0x0A`.
 *
 * **Use this before hashing or comparing any file whose committed form is
 * LF-pinned.** `.gitattributes` pins `* text=auto eol=lf`, so line endings are
 * git's business, not content — but a working tree can still hold CRLF (a
 * checkout that raced its own `.gitattributes`, an editor, a tool that wrote
 * `os.EOL`). Git reports such a file CLEAN because it normalizes on compare, so
 * a raw-byte hash disagrees with git about whether two files are the same. That
 * has now broken two generators: `skills.manifest.json`'s `bundleVersion`
 * tracked local line endings until it was canonicalized, and
 * `regenerate-skill-copies.mjs` reported all 67 destination files as differing
 * from identical sources.
 *
 * Byte-level by contract. Every other byte passes through untouched — a lone
 * `CR`, a BOM, UTF-8 multibyte sequences, even non-UTF-8 bytes. We do NOT
 * decode to a string first: decoding would silently rewrite malformed UTF-8,
 * widening a comparison helper into a normalizer.
 *
 * NOT for raw-byte integrity checks where the exact bytes on the wire are the
 * contract (transfer-corruption detection) — canonicalizing there would mask
 * the very corruption being looked for.
 *
 * @param {Buffer} buf
 * @returns {Buffer} a new Buffer (never the input) with CRLF folded to LF
 */
export function canonicalizeEol(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let w = 0;
  for (let r = 0; r < buf.length; r++) {
    // Fold CR only when it is immediately followed by LF; a lone CR survives.
    if (buf[r] === 0x0d && r + 1 < buf.length && buf[r + 1] === 0x0a) continue;
    out[w++] = buf[r];
  }
  return out.subarray(0, w);
}

// ── Path Normalization ──────────────────────────────────────────────────────

/**
 * Canonicalize file paths to cwd-relative, forward-slash, lowercase form.
 * @param {string} p - File path (absolute or relative)
 * @returns {string} Normalized path
 */
export function normalizePath(p) {
  const resolved = path.resolve(p);
  const cwdPrefix = path.resolve('.');
  // `path.relative`, NOT a string strip. `resolved.replace(cwdPrefix, '')` is a
  // plain substring removal, so a SIBLING directory sharing the cwd's name as a
  // prefix was silently mangled: with cwd `/repo`, `/repo2/file.mjs` became
  // `2/file.mjs` — a path that is not the input, not inside the repo, and looks
  // like a valid relative path to every downstream consumer that uses this as a
  // dedup key. Paths genuinely inside cwd are unaffected (path.relative returns
  // the same value the strip did); only the mangled case changes, and it now
  // stays recognisably outside via a leading `../`.
  let rel = path.relative(cwdPrefix, resolved);
  // A different Windows drive has no relative form — path.relative returns an
  // absolute path. Keep it absolute rather than pretending it is repo-relative.
  if (path.isAbsolute(rel)) rel = resolved;
  return rel.replaceAll(/\\/g, '/').replace(/^\//, '').toLowerCase();
}

// ── Safe Parsing ────────────────────────────────────────────────────────────

/** Safe parseInt with fallback for NaN. */
export function safeInt(val, fallback) {
  const n = Number.parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

// ── File Helpers ────────────────────────────────────────────────────────────

export function readFileOrDie(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: File not found: ${resolved}`);
    process.exit(1);
  }
  return fs.readFileSync(resolved, 'utf-8');
}

// ── Output Helpers ──────────────────────────────────────────────────────────

/**
 * Write output to file or stdout.
 * @param {object} data
 * @param {string} outPath
 * @param {string} summaryLine
 */
export function writeOutput(data, outPath, summaryLine) {
  const json = JSON.stringify(data, null, 2);
  if (outPath) {
    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, json, 'utf-8');
    process.stderr.write(`  [out] Results written to ${abs}\n`);
    console.log(summaryLine);
  } else {
    console.log(json);
  }
}

// ── Barrel Re-exports (backward compat) ─────────────────────────────────────
// All 19+ importers of file-io.mjs continue working unchanged.

export { isSensitiveFile, isAuditInfraFile, readFilesAsContext, readFilesAsContextDetailed, mergeCodeRenderStats, classifyFiles, safeReadFile, auditSubjectFileGuard, resolveEffectiveScope, AUDIT_INFRA_BASENAMES, MAX_FILE_SIZE } from './audit-scope.mjs';
export { parseDiffFile, readFilesAsAnnotatedContext, getCommentStyle } from './diff-annotation.mjs';
export { extractPlanPaths, mergeScopeFiles } from './plan-paths.mjs';
