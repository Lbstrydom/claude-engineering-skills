/**
 * @fileoverview Path containment + read/test-path classification for CLI handlers.
 *
 * **I/O contract, stated because it is not uniform across this module:**
 * - `isPathContained` is **pure** — string and `node:path` arithmetic only, no syscalls.
 * - `classifyReadPath` and `classifyTestPath` **touch the filesystem**: they resolve
 *   symlinks (`realpath`) and stat the target via `resolveAndClassify`. They never
 *   write, and every failure mode — including a throwing `realpath` — is returned as
 *   `{ok:false, reason}` rather than propagated.
 *
 * Why both classifiers resolve rather than string-compare: the call sites they serve
 * (`groundingNoteFor`, `lock-with-test`) accept **model-authored or operator-supplied**
 * paths and then READ them. A lexical containment check passes an in-repo symlink whose
 * target is `~/.ssh/id_rsa`; `groundingNoteFor` would read it and feed the contents into
 * an audit prompt bound for a third-party LLM. That is the INC-001 symlink-bypass class
 * on this repo's Tier-3 sensitive-egress seam, which is why resolution is not optional
 * here and why both classifiers delegate to the one canonical oracle.
 *
 * Plan: docs/plans/layering-and-mutation-contracts.md (C2, C3).
 *
 * @module scripts/lib/path-validation
 */

import path from 'node:path';
import fsDefault from 'node:fs';

import { resolveAndClassify } from './sensitive-paths.mjs';

/**
 * Is `candidate` inside `root`?
 *
 * PURE. The trailing separator is the whole point: `'/repo-evil/x'.startsWith('/repo')`
 * is `true`, so a bare prefix comparison lets a sibling directory pass containment.
 * Demonstrated on this repo 2026-07-31 against the real `groundingNoteFor` check.
 *
 * Equality with the root itself counts as contained (a caller asking about the root
 * directory is not escaping it).
 *
 * @param {string} root
 * @param {string} candidate — already absolute
 * @returns {boolean}
 */
export function isPathContained(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false;
  // Case-fold on Windows only. `path.resolve` PRESERVES the drive-letter case it was
  // given, so `c:\repo` vs `C:\repo` compares unequal and the check FALSELY REJECTS a
  // contained path on a case-insensitive filesystem — verified on win32 2026-07-31.
  // Same rationale as `normalizePath()`'s lowercasing (AGENTS.md accepted-debt table):
  // correct for Windows, and deliberately NOT applied on case-sensitive filesystems
  // where two paths differing only in case are genuinely different files.
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const r = fold(path.resolve(root));
  const c = fold(path.resolve(candidate));
  return c === r || c.startsWith(r + path.sep);
}

/**
 * Shared resolution used by both classifiers below.
 *
 * @returns {{ok: true, canonical: string} | {ok: false, reason: string}}
 */
function resolveContained(relOrAbs, { repoRoot, fs = fsDefault, missingReason }) {
  // ORDER MATTERS, and getting it wrong collapses three distinct outcomes into one.
  // `resolveAndClassify` fails CLOSED: any resolution error (missing file, broken
  // symlink, EPERM) comes back as `resolutionFailed` AND `category: 'sensitive'`. So
  // checking `category` first reports a simple typo'd filename as "sensitive path",
  // which is both wrong and unactionable. Cheap lexical checks run first, then
  // existence, and only then the resolving classifier.
  const lexicalAbs = path.resolve(repoRoot, relOrAbs);
  if (!isPathContained(repoRoot, lexicalAbs)) {
    return { ok: false, reason: 'path-escapes-repo' };
  }

  // `lstat`, not `stat`: a dangling symlink exists as a link and must be reported as
  // unresolvable rather than missing.
  try { fs.lstatSync(lexicalAbs); }
  catch { return { ok: false, reason: missingReason }; }

  const verdict = resolveAndClassify(relOrAbs, { repoRoot, fs });
  if (verdict.lexical === 'sensitive') return { ok: false, reason: 'sensitive-path' };
  if (verdict.escapedRepo) return { ok: false, reason: 'path-escapes-repo' };
  if (verdict.resolutionFailed) return { ok: false, reason: 'path-unresolvable' };
  if (verdict.category === 'sensitive') return { ok: false, reason: 'sensitive-path' };

  // `canonical` is null when the lexical fast-path returned without resolving; fall
  // back to the lexical join, then re-check containment on the resolved target — this
  // is the check a symlink escaping the repo fails.
  const canonical = verdict.canonical || lexicalAbs;
  if (!isPathContained(repoRoot, canonical)) return { ok: false, reason: 'path-escapes-repo' };
  return { ok: true, canonical };
}

/**
 * Classify a path the caller intends to READ (C2 — `groundingNoteFor`).
 *
 * @param {{repoRoot: string, candidate: string, fs?: object}} args
 * @returns {{ok: true, canonical: string} | {ok: false, reason: string}}
 */
export function classifyReadPath({ repoRoot, candidate, fs = fsDefault }) {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return { ok: false, reason: 'empty-path' };
  }
  const contained = resolveContained(candidate, { repoRoot, fs, missingReason: 'not-found' });
  if (!contained.ok) return contained;

  let st;
  try { st = fs.statSync(contained.canonical); }
  catch { return { ok: false, reason: 'not-found' }; }
  if (!st.isFile()) return { ok: false, reason: 'not-a-file' };
  return contained;
}

/**
 * Classify a test path supplied to `lock-with-test` (C3).
 *
 * Policy — one row per outcome, so the command's answer is not re-derived at the call
 * site (plan §2 dec. 3):
 *
 * | target after realpath                  | result                       |
 * |----------------------------------------|------------------------------|
 * | regular file, canonical path in repo   | `{ok:true, canonical}`       |
 * | outside repoRoot (incl. via symlink)   | `path-escapes-repo`          |
 * | directory                              | `not-a-file`                 |
 * | missing                                | `test-file-not-found`        |
 * | realpath throws                        | `path-unresolvable`          |
 * | classified sensitive                   | `sensitive-path`             |
 *
 * @param {{repoRoot: string, testPath: string, fs?: object}} args
 * @returns {{ok: true, canonical: string} | {ok: false, reason: string}}
 */
export function classifyTestPath({ repoRoot, testPath, fs = fsDefault }) {
  if (typeof testPath !== 'string' || !testPath.trim()) {
    return { ok: false, reason: 'empty-path' };
  }
  const contained = resolveContained(testPath, { repoRoot, fs, missingReason: 'test-file-not-found' });
  if (!contained.ok) return contained;

  let st;
  try { st = fs.statSync(contained.canonical); }
  catch { return { ok: false, reason: 'test-file-not-found' }; }
  if (!st.isFile()) return { ok: false, reason: 'not-a-file' };
  return contained;
}
