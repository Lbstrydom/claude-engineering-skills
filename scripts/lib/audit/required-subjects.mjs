/**
 * @fileoverview Required-subject coverage: an operator-declared `--require` list, and the question it answers —
 * "did this audit actually read the files I named?" (docs/plans/copilot-feedback-item4.md Cluster A).
 *
 * ## The defect this closes (Copilot consumer report, 2026-10-19)
 *
 * A twelve-subject final gate was declared by the operator; eleven were read and one (`package-lock.json`, a
 * `non-code` file the audit never admits) was not. Nothing in any output said so, and the round read as complete,
 * because the ledger's notion of "required" is "a changed file of a reviewable class", not "something the operator
 * required".
 *
 * ## Shape
 *
 *   - `parseRequireArgs`         argv → raw paths (comma list, repeated flag, `@file`)
 *   - `validateRequiredSubjects` raw paths → subjects, or a refusal. THE EGRESS SEAM: `--require` forces user-named paths
 *                                into prompts sent to third-party models, so every path is repo-contained and
 *                                symlink-resolved through `resolveAndClassify` (INC-001) and fails CLOSED.
 *   - `requiredSubjectStatus`    one ledger record → FULL | PARTIAL | UNREAD | SENSITIVE | N/A (a pure projection)
 *   - `summariseRequiredSubjects` the ledger → the `_coverage.requiredSubjects` block
 *
 * A required path that is SENSITIVE is reported and never admitted: it is not read, not sent, and — because it is not
 * FULL — it blocks convergence. A required non-code file (a lockfile) is the opposite case: the operator's explicit
 * declaration is the opt-in that admits it (the mirror of `.auditignore` as the opt-out), and it is sent to the
 * reviewers through the ordinary readers, so it is redacted like any other file.
 *
 * @module scripts/lib/audit/required-subjects
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizePath } from '../file-io.mjs';
import { classifyPath, resolveAndClassify } from '../sensitive-paths.mjs';

export const REQUIRED_STATUSES = Object.freeze(['FULL', 'PARTIAL', 'UNREAD', 'SENSITIVE', 'N/A']);

const OUTSIDE = 'resolves outside the repository';

const tidy = (p) => String(p).trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');

/**
 * `--require <path>[,<path>…]` (repeatable; `--require=<list>` too). A value starting `@` names a file of one path per
 * line (blank lines and `#` comments ignored) — the form for a long list.
 *
 * Errors, never silence: a flag with no value, or an unreadable `@file`, is reported — an empty list would read as
 * "nothing required", which is the very defect this flag exists to close.
 *
 * @param {string[]} args
 * @param {{readFile?: (f: string) => string}} [deps]
 * @returns {{paths: string[], errors: string[]}}
 */
export function parseRequireArgs(args, { readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const paths = [];
  const errors = [];
  const take = (value) => {
    const before = paths.length;
    for (const item of String(value).split(',')) {
      const v = item.trim();
      if (!v) continue;
      if (!v.startsWith('@')) { paths.push(tidy(v)); continue; }
      let text;
      try { text = readFile(v.slice(1)); } catch (err) { errors.push(`--require ${v}: cannot read the list file (${err?.code ?? err?.message})`); continue; }
      for (const line of String(text).split(/\r?\n/)) {
        const t = line.trim();
        if (t && !t.startsWith('#')) paths.push(tidy(t));
      }
    }
    // A flag that names nothing (`--require=`, `--require ,,`, an empty @file) is a mistake, not "nothing required".
    if (paths.length === before && errors.length === 0) errors.push(`--require ${JSON.stringify(String(value))} declares no path`);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--require') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) { errors.push('--require needs a value: a path, a comma list, or @<file>'); continue; }
      take(v);
      i++;
    } else if (typeof a === 'string' && a.startsWith('--require=')) {
      take(a.slice('--require='.length));
    }
  }
  return { paths, errors };
}

const inside = (root, abs) => {
  const rel = path.relative(root, abs);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/** lstat that distinguishes "absent" from "cannot tell". */
function lstatOrCode(p, fsMod) {
  try { return { stat: fsMod.lstatSync(p) }; } catch (err) { return { code: err?.code ?? 'UNKNOWN' }; }
}

/**
 * Validate the declared paths BEFORE any read. Pure of the audit; touches the filesystem only to resolve links.
 *
 * - an existing path is repo-contained AND symlink-resolved (`resolveAndClassify`): resolving outside the repo, or
 *   not at all (a broken link), refuses the run; resolving to a SENSITIVE target makes the subject `sensitive`;
 * - a path not on disk cannot be realpathed, so it gets a lexical check plus a realpath of its nearest existing
 *   parent (a symlinked parent cannot smuggle it out). It is admitted to nothing — there is nothing to read — and
 *   its status is the diff's call (deleted ⇒ N/A, otherwise UNREAD);
 * - required AND excluded (`.auditignore` / `--exclude-paths`) is two contradictory declarations: refuse;
 * - duplicates by normalised identity are reported, not merged away.
 *
 * @param {string[]} rawPaths
 * @param {{repoRoot: string, isExcluded?: (p: string) => boolean, fsMod?: typeof fs}} opts
 * @returns {{ok: boolean, subjects: Array<{path: string, sensitive: boolean, onDisk: boolean, reason: string|null}>,
 *   errors: Array<{path: string, reason: string}>, duplicates: string[]}}
 */
export function validateRequiredSubjects(rawPaths, { repoRoot, isExcluded = () => false, fsMod = fs } = {}) {
  const errors = [];
  const subjects = [];
  const duplicates = [];
  const seen = new Set();
  const root = path.resolve(repoRoot);
  let realRoot = root;
  try { realRoot = fsMod.realpathSync(root); } catch { /* keep the lexical root */ }
  const fail = (p, reason) => errors.push({ path: p, reason });

  for (const raw of rawPaths) {
    const abs = path.resolve(root, raw);
    if (!inside(root, abs)) { fail(raw, `${OUTSIDE} (${raw})`); continue; }
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const key = normalizePath(rel);
    if (seen.has(key)) { duplicates.push(raw); continue; }
    seen.add(key);
    if (isExcluded(rel)) { fail(raw, 'is also excluded by --exclude-paths/.auditignore: required and excluded contradict each other'); continue; }

    const lex = classifyPath(rel) === 'sensitive';
    const st = lstatOrCode(abs, fsMod);
    if (st.code === 'ENOENT' || st.code === 'ENOTDIR') {
      // Not on disk: judge the nearest existing ancestor, so a symlinked parent cannot carry it out of the repo.
      let parent = path.dirname(abs);
      while (parent !== path.dirname(parent) && (lstatOrCode(parent, fsMod).code === 'ENOENT' || lstatOrCode(parent, fsMod).code === 'ENOTDIR')) parent = path.dirname(parent);
      let realParent;
      try { realParent = fsMod.realpathSync(parent); } catch { fail(raw, `${OUTSIDE} (its parent directory cannot be resolved)`); continue; }
      if (realParent !== realRoot && !inside(realRoot, realParent)) { fail(raw, `${OUTSIDE} (its parent directory resolves outside)`); continue; }
      subjects.push({ path: rel, sensitive: lex, onDisk: false, reason: lex ? 'sensitive path' : null });
      continue;
    }
    if (st.code) { fail(raw, `cannot be examined (${st.code})`); continue; }

    if (lex) { subjects.push({ path: rel, sensitive: true, onDisk: true, reason: 'sensitive path' }); continue; }
    const c = resolveAndClassify(rel, { repoRoot: realRoot, fs: fsMod });
    if (c.escapedRepo) { fail(raw, `${OUTSIDE} (a symlink leaves it)`); continue; }
    if (c.resolutionFailed) { fail(raw, 'cannot be resolved (broken or cyclic link)'); continue; }
    if (c.category === 'sensitive') { subjects.push({ path: rel, sensitive: true, onDisk: true, reason: 'resolves to a sensitive path' }); continue; }
    let isFile = false;
    try { isFile = fsMod.statSync(c.canonical ?? abs).isFile(); } catch { /* fall through to the refusal */ }
    if (!isFile) { fail(raw, 'is not a file'); continue; }
    subjects.push({ path: rel, sensitive: false, onDisk: true, reason: null });
  }
  return { ok: errors.length === 0, subjects, errors, duplicates };
}

/** The subjects that may be sent to a model: sensitive ones never are. */
export function admittedRequiredPaths(subjects) {
  return (Array.isArray(subjects) ? subjects : []).filter((s) => s && !s.sensitive).map((s) => s.path);
}

/** `scopeFiles` plus the admitted required paths, order-stable and de-duplicated by identity. */
export function widenScopeWithRequired(scopeFiles, requiredPaths) {
  if (requiredPaths.length === 0) return scopeFiles;
  const out = [];
  const seen = new Set();
  for (const p of [...(scopeFiles ?? []), ...requiredPaths]) {
    const k = normalizePath(p);
    if (!seen.has(k)) { seen.add(k); out.push(p); }
  }
  return out;
}

/**
 * Parse + validate in one call, for the CLI. `error` is a ready-to-print refusal (exit 2), else `subjects`.
 * @returns {{subjects: Array<object>, error: string|null}}
 */
export function resolveRequireFlag({ args, mode = 'code', repoRoot, isExcluded, readFile }) {
  const parsed = parseRequireArgs(args, readFile ? { readFile } : undefined);
  if (parsed.errors.length > 0) return { subjects: [], error: parsed.errors.join('\n') };
  if (parsed.paths.length === 0) return { subjects: [], error: null };
  // A declaration that is silently ignored is the defect this flag closes: only a code audit reads files.
  if (mode !== 'code') return { subjects: [], error: `--require applies to a code audit; it was given with mode "${mode}"` };
  const v = validateRequiredSubjects(parsed.paths, { repoRoot, isExcluded });
  if (!v.ok) {
    return { subjects: [], error: `--require refused, nothing was read or sent:\n${v.errors.map((e) => `  ${e.path}: ${e.reason}`).join('\n')}` };
  }
  return { subjects: v.subjects, error: null };
}

/**
 * One ledger record → the status the operator sees. Pure. Applies to a record carrying `required: true`.
 *
 * `changedLinesUnread === 0` proves a partial read covered the change only for a file that HAS a change: for an unchanged
 * context subject (`requiredContext`) zero is vacuous, so anything short of a whole read is PARTIAL.
 *
 * @param {object} f a ledger file record
 * @returns {{status: 'FULL'|'PARTIAL'|'UNREAD'|'SENSITIVE'|'N/A', reason: string|null}}
 */
export function requiredSubjectStatus(f) {
  switch (f.outcome) {
    case 'deleted': return { status: 'N/A', reason: 'deleted in the diff' };
    case 'sensitive': return { status: 'SENSITIVE', reason: 'sensitive path, never sent to any model' };
    case 'audited': {
      const state = f.read?.state;
      if (state === 'full') return { status: 'FULL', reason: null };
      if ((state === 'head-cut' || state === 'windowed') && !f.requiredContext && f.changedLinesUnread === 0) return { status: 'FULL', reason: null };
      const detail = f.changedLinesUnread > 0 ? `, ${f.changedLinesUnread} changed line(s) unread`
        : f.requiredContext ? ', unchanged file not read in full' : ', changed lines could not be measured';
      return { status: 'PARTIAL', reason: `read ${state}${detail}` };
    }
    default: return { status: 'UNREAD', reason: f.reason ?? f.outcome };
  }
}

/**
 * The `_coverage.requiredSubjects` block, derived from the ledger — never accumulated separately. `N/A` (deleted) counts
 * as satisfied and is named; `FULL` is the only other satisfied status.
 *
 * @param {object[]} files ledger records
 */
export function summariseRequiredSubjects(files) {
  const subjects = files.filter((f) => f.required).map((f) => ({ path: f.path, ...requiredSubjectStatus(f) }));
  return {
    declared: subjects.length,
    full: subjects.filter((s) => s.status === 'FULL').length,
    notApplicable: subjects.filter((s) => s.status === 'N/A').length,
    notFull: subjects.filter((s) => s.status !== 'FULL' && s.status !== 'N/A'),
    subjects,
  };
}
