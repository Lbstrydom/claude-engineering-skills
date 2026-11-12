/**
 * @fileoverview The consumer pre-push hook's v17 steps (docs/plans/prepush-gate-consumer-feedback-theme1.md D1, D2), called through
 * `scripts/prepush-step.mjs`:
 *
 *  - {@link writePlanlessIntent} - the intent document for a plan-less audit: the branch's OWN commit messages in the trusted push range,
 *    secret-redacted, capped, written to a per-invocation file so two pushes never share one.
 *  - {@link snapshotCreateStep} / {@link snapshotRemoveStep} - the detached worktree of the pushed commit the audit runs in, so every
 *    reader sees exactly the pushed bytes (never the working tree), plus the sweep of husks a killed push left.
 *  - {@link snapshotPlanLine} - how a selected plan crosses into the snapshot: by its repo-relative path when the snapshot holds the same
 *    bytes (its store identity is unchanged), otherwise by the checkout copy's absolute path, said out loud.
 *
 * Every function here returns a value and writes only through the injected `write`; none throws for an expected failure.
 *
 * @module scripts/lib/prepush-planless-steps
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIntentDocument } from './audit/planless-intent.mjs';
import { createSnapshot, removeSnapshot, snapshotPath, gitWithLockRetry, CONSUMER_SNAPSHOT_PREFIX } from './prepush-snapshot.mjs';
import { sweepStaleSandboxes, describeSweep } from './prepush-sandbox-cleanup.mjs';
import { canonicalizeEol, atomicWriteFileSync } from './file-io.mjs';

const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** An intent file is protected from retention for one hour: longer than the audit budget's cap (BUDGET.capSec = 2700s). */
const INTENT_MIN_AGE_MS = 60 * 60 * 1000;
/** Exactly the name `snapshotCreateStep` gives a snapshot: prefix, 12-hex tree tag, owner pid. */
const SNAPSHOT_NAME_RE = new RegExp(`^${CONSUMER_SNAPSHOT_PREFIX}[0-9a-f]{12}-[1-9][0-9]*$`);
/** Where the kept pre-push files live, relative to the consumer checkout (the hook's AUDIT_KEEP_DIR). */
export const KEEP_DIR = path.join('.audit', 'prepush');
/** A path handed back to the hook: forward slashes, which git-bash's `cd`, sh and node all accept unconverted. */
const forShell = (p) => path.resolve(p).replace(/\\/g, '/');

/** Atomic write (temp file + rename, directory created): the repo's one writer, lib/file-io.mjs. Throws on failure. */
export const writeAtomic = (file, text) => atomicWriteFileSync(file, text);

/**
 * Keep the newest N files ending in `suffix` (the hook's AUDIT_PREPUSH_KEEP_REPORTS policy: a positive integer of at most 6 digits, else 20),
 * never `protect`, and never a file younger than `minAgeMs` (a CONCURRENT push may still be about to read its own file - an intent file is
 * read by the audit after this returns). Housekeeping only: it never changes an outcome.
 */
export function pruneKept(dir, { suffix, protect, keepArg, minAgeMs = 0, now = Date.now() }) {
  const n = /^[1-9][0-9]{0,5}$/.test(String(keepArg ?? '')) ? Number(keepArg) : 20;
  try {
    fs.readdirSync(dir).filter((e) => e.endsWith(suffix) && e !== protect)
      .map((e) => ({ e, m: fs.statSync(path.join(dir, e)).mtimeMs })).sort((a, b) => b.m - a.m).slice(Math.max(0, n - 1))
      .filter((x) => now - x.m >= minAgeMs)
      .forEach((x) => fs.rmSync(path.join(dir, x.e), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  } catch { /* retention is housekeeping */ }
}

/**
 * Build and write the plan-less intent document for `range` (already resolved and TRUSTED by the caller).
 *
 * The messages are the branch's OWN non-merge commits: `--not <defaultRef>` drops what a merge of the default branch brought in (the set
 * `branchOwnedChangedFiles` uses), and merge commits' own messages ("Merge branch main") are not intent. When the default ref does not
 * resolve, the range's non-merge commits are used. A `git log` failure or a failed write is NOT an empty intent: `{ok:false}`.
 *
 * @param {{range: {base: string, head: string}, cwd: string, gitFn: (cwd: string, args: string[]) => string, env?: object,
 *   defaultRef?: string, pid?: number}} input
 * @returns {{ok: true, path: string, count: number, redacted: number} | {ok: false, why: string}}
 */
export function writePlanlessIntent({ range, cwd, gitFn, env = process.env, defaultRef = 'origin/main', pid = process.pid }) {
  if (!OID_RE.test(String(range?.base ?? '')) || !OID_RE.test(String(range?.head ?? ''))) return { ok: false, why: 'the push range is not a pair of commit ids' };
  let defaultKnown = false;
  try { defaultKnown = OID_RE.test(gitFn(cwd, ['rev-parse', '--verify', '--quiet', `${defaultRef}^{commit}`]).trim()); } catch { defaultKnown = false; }
  let raw;
  let tree;
  try {
    raw = gitFn(cwd, ['log', '--no-merges', '--reverse', '--format=%B%x00', `${range.base}..${range.head}`, ...(defaultKnown ? ['--not', defaultRef] : [])]);
    tree = gitFn(cwd, ['rev-parse', '--verify', '--quiet', `${range.head}^{tree}`]).trim();
  } catch (e) {
    return { ok: false, why: `git could not list the pushed commits' messages (${e?.code || e?.status || 'error'})` };
  }
  if (!OID_RE.test(tree)) return { ok: false, why: 'the pushed tree could not be resolved' };
  const messages = String(raw).split('\0').map((m) => m.trim()).filter(Boolean);
  const doc = buildIntentDocument({ messages });
  const name = `${tree.slice(0, 12)}-${range.base.slice(0, 12)}-${range.head.slice(0, 12)}-${pid}.intent.md`;
  const file = path.join(cwd, KEEP_DIR, name);
  try { writeAtomic(file, doc.text); } catch (e) { return { ok: false, why: `the intent file could not be written (${e?.code || 'error'})` }; }
  // Never prune an intent younger than the audit budget's cap: another push's audit may not have read its own yet (audit B R1 H8).
  pruneKept(path.join(cwd, KEEP_DIR), { suffix: '.intent.md', protect: name, keepArg: env.AUDIT_PREPUSH_KEEP_REPORTS, minAgeMs: INTENT_MIN_AGE_MS });
  return { ok: true, path: forShell(file), count: doc.count, redacted: doc.redacted.length };
}

/**
 * `snapshot create`: sweep husks a killed push left (both pre-push prefixes; a warning, never a block), then create a detached worktree of
 * the pushed commit and print its path. An UNTRACKED `.auditignore` is copied in - it narrows the audit's scope, and omitting it would audit
 * files the operator excluded; a failed copy refuses (the snapshot is removed first). A `.auditignore` TRACKED in the checkout is never
 * copied: the snapshot already holds the pushed commit's own version, or the push deleted it (audit B R1 H7).
 *
 * The snapshot is named for its OWNER: `ownerPid` must be the HOOK's own pid (it lives for the whole audit), never this step's - a
 * short-lived step pid is dead the moment the step returns, and a concurrent push's sweep would remove a snapshot still being audited
 * (audit B R1 H1). The hook passes its Windows pid where git-bash has one (`/proc/$/winpid`), because process.kill probes that.
 *
 * @param {{cwd: string, headArg?: string|null, ownerPid?: number, gitFn: (cwd: string, args: string[]) => string,
 *   write: (l: string) => void, tmpDir?: string, sweep?: typeof sweepStaleSandboxes}} input
 * @returns {{code: number, line: string}}
 */
export function snapshotCreateStep({ cwd, headArg = null, ownerPid = null, gitFn, write, tmpDir = os.tmpdir(), sweep = sweepStaleSandboxes }) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    write(`✗  [prepush-hook] the audit snapshot needs the hook's own pid as its owner (--owner-pid); got ${ownerPid ?? 'none'} - push BLOCKED.`);
    return { code: 1, line: '' };
  }
  let sha; let tree;
  try {
    sha = gitFn(cwd, ['rev-parse', '--verify', '--quiet', `${headArg || 'HEAD'}^{commit}`]).trim();
    tree = gitFn(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`]).trim();
  } catch { sha = ''; tree = ''; }
  if (!OID_RE.test(sha) || !OID_RE.test(tree)) {
    write(`✗  [prepush-hook] the pushed commit ${headArg || 'HEAD'} could not be resolved, so no snapshot of it can be made - push BLOCKED (the audit reads the pushed commit, never the working tree).`);
    return { code: 1, line: '' };
  }
  try {
    const swept = sweep(tmpDir);
    for (const l of describeSweep(swept, tmpDir)) write(`[prepush-hook] ${l.trim()}`);
    if (swept.swept.length) { try { gitWithLockRetry(cwd, ['worktree', 'prune']); } catch { /* noop */ } }
  } catch (e) { write(`⚠ [prepush-hook] stale-snapshot sweep failed (continuing): ${e?.message ?? e}`); }
  const dir = snapshotPath({ prefix: CONSUMER_SNAPSHOT_PREFIX, tag: tree.slice(0, 12), pid: ownerPid, tmpDir });
  const created = createSnapshot({ repoRoot: cwd, sha, dir, onRetry: write });
  if (!created.ok) {
    write(`✗  [prepush-hook] ${created.error} - push BLOCKED: the audit must read the pushed commit, and there is nothing else it may read.`);
    return { code: 1, line: '' };
  }
  const src = path.join(cwd, '.auditignore');
  const dst = path.join(dir, '.auditignore');
  // `ls-files` exits 0 either way: an empty answer is "untracked", a THROW is git failing - never read as "untracked" (audit B R2 H2).
  let tracked;
  try { tracked = gitFn(cwd, ['ls-files', '-z', '--', '.auditignore']).length > 0; } catch (e) {
    removeSnapshot({ repoRoot: cwd, dir });
    write(`✗  [prepush-hook] git could not say whether .auditignore is tracked (${e?.status ?? e?.code ?? 'error'}) - push BLOCKED UNMEASURED: the audit's scope cannot be established.`);
    return { code: 1, line: '' };
  }
  if (!tracked && fs.existsSync(src) && !fs.existsSync(dst)) {
    try {
      fs.copyFileSync(src, dst);
      write('[prepush-hook] ▸ audit snapshot: .auditignore is untracked here - copied in, because it narrows what the audit reads');
    } catch (e) {
      removeSnapshot({ repoRoot: cwd, dir });
      write(`✗  [prepush-hook] the untracked .auditignore could not be copied into the audit snapshot (${e?.code || 'error'}) - push BLOCKED UNMEASURED: without it the audit would read files you excluded.`);
      return { code: 1, line: '' };
    }
  }
  write(`[prepush-hook] ▸ audit snapshot: ${forShell(dir)} - a detached worktree of ${sha.slice(0, 12)}; the audit reads the pushed commit, not the working tree`);
  return { code: 0, line: forShell(dir) };
}

/** Is `dir` exactly a snapshot this hook makes: the snapshot NAME, directly under the temp root (canonical paths)? */
export function isConsumerSnapshotPath(dir, tmpDir = os.tmpdir()) {
  if (!dir) return false;
  const canon = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const abs = path.resolve(String(dir));
  // Case-folded only where the filesystem is (Windows); on a case-sensitive one /tmp/A and /tmp/a are different roots (audit B R2 H4).
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return SNAPSHOT_NAME_RE.test(path.basename(abs)) && fold(canon(path.dirname(abs))) === fold(canon(tmpDir));
}

/**
 * `snapshot remove <dir>`: remove a snapshot this hook made, and verify by stat. Only a path that IS a snapshot name directly under the temp
 * root is ever removed - a cleanup path must not be aimable at anything else (audit B R1 H3). A failure warns and never blocks the push;
 * `code` 3 tells the hook it is still there, so its EXIT trap tries once more.
 * @returns {{code: 0|3, removed: boolean}}
 */
export function snapshotRemoveStep({ cwd, dir, write, tmpDir = os.tmpdir() }) {
  if (!isConsumerSnapshotPath(dir, tmpDir)) {
    write(`⚠ [prepush-hook] refusing to remove ${dir || '(no path)'}: not an audit snapshot this hook makes`);
    return { code: 0, removed: false };
  }
  const r = removeSnapshot({ repoRoot: cwd, dir, onRetry: write });
  if (!r.removed) {
    write(`⚠ [prepush-hook] the audit snapshot could not be removed: ${dir} (${r.error?.code || r.error?.message || 'unknown'}) - a later push sweeps it`);
    return { code: 3, removed: false };
  }
  return { code: 0, removed: true };
}

/**
 * How the selected plan crosses into the snapshot. `relative <path>` when the snapshot holds the same bytes as the checkout (CRLF-folded
 * compare, as planMatchesCheckout does), so the plan's store identity is unchanged; otherwise `checkout <absolute path>` - an override
 * naming an untracked, absolute or locally edited plan is read from the checkout, and the hook says so.
 * @returns {string}
 */
export function snapshotPlanLine({ cwd, snapshotDir, plan }) {
  const p = String(plan ?? '');
  if (!p) return 'checkout ';
  if (path.isAbsolute(p)) return `checkout ${forShell(p)}`;
  const inCheckout = path.join(cwd, p);
  let same = false;
  try {
    same = canonicalizeEol(fs.readFileSync(inCheckout)).equals(canonicalizeEol(fs.readFileSync(path.join(snapshotDir, p))));
  } catch { same = false; }
  return same ? `relative ${p}` : `checkout ${forShell(inCheckout)}`;
}
