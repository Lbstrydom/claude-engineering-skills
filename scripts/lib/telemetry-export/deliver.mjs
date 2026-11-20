/**
 * @fileoverview Delivery: write the finished export into the drop directory.
 *
 * THE ONE PRIMITIVE (plan §6 decision 2). Every channel reduces to "a directory of files the
 * reader can scan": a private Git repository cloned on both machines (recommended — per-writer
 * access control, an audit trail, atomic publication by commit), a synced shared folder, or a
 * person carrying the file. The exporter only ever writes into `TELEMETRY_DROP_DIR`.
 *
 *   - IMMUTABLE, UNIQUELY NAMED: `<alias>/<yyyy-mm-dd>-<exportId>.json` (the full UUID). A same-day
 *     repeat is a second file, never an overwrite, so a delayed or rejected older file can never
 *     replace a valid newer one.
 *   - ATOMIC, NO-REPLACE: written to a temporary name in the SAME directory, then published with a
 *     hard link — `link()` fails with EEXIST rather than replacing, which `rename()` would do on
 *     some platforms — and the temporary name removed. A reader never sees a half-written file.
 *   - CONTAINED: the alias directory is created, never followed — an existing symlink there is
 *     refused, and the resolved real path must stay inside the resolved real drop directory.
 *   - `--push` (opt-in): the drop directory must ITSELF be the root of a Git work tree (one merely
 *     nested inside another repository — say, the consumer's own — would commit into the wrong
 *     history). Then exactly `git add <file>`, `git commit`, `git push` there — nothing else, never
 *     `--force`, never a branch or remote change. Without it the exporter only writes the file.
 *
 * @module scripts/lib/telemetry-export/deliver
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateExport } from './schema.mjs';
import { assertExportClean } from './redact.mjs';

const ALIAS_RE = /^[a-z0-9-]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @param {object} doc a validated export
 * @returns {string} the POSIX-style relative file name inside the drop directory
 */
export function exportFileName(doc) {
  if (!ALIAS_RE.test(doc.consumerAlias)) throw new Error('deliver: consumerAlias is not a valid alias');
  if (!UUID_RE.test(doc.exportId)) throw new Error('deliver: exportId is not a uuid');
  return `${doc.consumerAlias}/${doc.generatedAt.slice(0, 10)}-${doc.exportId}.json`;
}

/** Is `child` (a real path) strictly inside `parent` (a real path)? */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param {object} p
 * @param {object} p.doc
 * @param {string} p.dropDir
 * @param {boolean} [p.push=false]
 * @param {(cmd: string, args: string[], opts: object) => any} [p.exec]  test seams: exec, link, mkdir
 * @returns {{file: string, pushed: boolean}}
 */
export function deliverExport({ doc, dropDir, push = false, exec = execFileSync, link = fs.linkSync, mkdir = fs.mkdirSync }) {
  if (!dropDir || typeof dropDir !== 'string') throw new Error('deliver: no drop directory (set TELEMETRY_DROP_DIR or pass --drop-dir)');
  if (!fs.existsSync(dropDir) || !fs.statSync(dropDir).isDirectory()) throw new Error('deliver: the drop directory does not exist');
  const root = fs.realpathSync(dropDir);

  const rel = exportFileName(doc);
  const [aliasDir, fileName] = rel.split('/');
  const aliasPath = path.join(root, aliasDir);
  const git = (args) => exec('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsHide: true });

  // Validate the Git destination BEFORE publishing anything: a refusal here must not leave a published file
  // behind it, and "delivery failed" must never describe a file that was in fact written.
  if (push) {
    const top = String(git(['rev-parse', '--show-toplevel']) ?? '').trim();
    // The drop directory must BE the work tree's root, not a folder inside some other repository.
    if (!top || fs.realpathSync(top) !== root) throw new Error('deliver: --push needs the drop directory to be the root of its own Git work tree');
  }

  // The alias directory is created by us or is a plain directory: never a symlink (which could point out of the drop).
  let st = null;
  try { st = fs.lstatSync(aliasPath); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  if (st) {
    if (st.isSymbolicLink()) throw new Error('deliver: the alias directory is a symlink (refused)');
    if (!st.isDirectory()) throw new Error('deliver: the alias path exists and is not a directory');
  } else {
    try {
      mkdir(aliasPath);
    } catch (err) {
      // A concurrent export created it first: recheck the entry with the same rules instead of failing.
      if (err?.code !== 'EEXIST') throw err;
      const again = fs.lstatSync(aliasPath);
      if (again.isSymbolicLink()) throw new Error('deliver: the alias directory is a symlink (refused)');
      if (!again.isDirectory()) throw new Error('deliver: the alias path exists and is not a directory');
    }
  }
  const realAlias = fs.realpathSync(aliasPath);
  if (!isInside(root, realAlias)) throw new Error('deliver: the alias directory resolves outside the drop directory');

  const target = path.join(realAlias, fileName);
  // Unique per call (random suffix), so two deliveries — even in one process, even in one millisecond — never
  // share a temp name, and the cleanup below can only ever remove a file this call created.
  const tmp = path.join(realAlias, `.${fileName}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}
`, { flag: 'wx' });
    try {
      link(tmp, target);   // atomic, and fails EEXIST rather than replacing: exports are immutable
    } catch (err) {
      // A filesystem without hard links (FAT/exFAT, some network shares). A RENAME is still atomic to a
      // reader, which matters more than the no-replace guarantee here: the name embeds a random UUID, so a
      // genuine collision is not a realistic event, and the existence check below covers a re-run. A copy
      // straight to the final name would not do: a crash mid-copy would leave a truncated file at an
      // immutable name that every retry then refuses.
      if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(err?.code)) {
        if (fs.existsSync(target)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        fs.renameSync(tmp, target);
      } else {
        throw err;
      }
    }
  } catch (err) {
    if (err?.code === 'EEXIST') throw new Error('deliver: an export with this name already exists (exports are immutable)');
    throw err;
  } finally {
    // Covers a failed or partial temp write and the post-link cleanup. A failure to remove a temp file must
    // NOT turn a successfully published export into a thrown "delivery failed" (and skip the requested push).
    try { fs.unlinkSync(tmp); } catch { /* already gone (renamed) or leftover temp: harmless, dot-prefixed, never .json */ }
  }

  let pushed = false;
  if (push) {
    git(['add', '--', rel]);
    git(['commit', '-q', '-m', `telemetry export ${doc.consumerAlias} ${doc.generatedAt.slice(0, 10)}`, '--', rel]);
    git(['push']);
    pushed = true;
  }
  return { file: target, pushed };
}

/**
 * Push what is already written but not yet delivered, for ONE alias.
 *
 * Why this exists: the throttle (`--if-older-than`) treats a recent valid file as "an export exists", but a file
 * written by an earlier run whose push failed (offline, rejected) is NOT delivered. Without this, such a file
 * suppresses every later attempt for the whole throttle window. So a requested push first delivers anything of
 * this alias's that is uncommitted OR committed-but-unpushed, and only then may the caller skip.
 *
 * Same rules as `deliverExport`'s push: the drop directory must itself be a Git work-tree root; exactly
 * `status`/`add`/`commit`/`push`; never force; nothing outside `<alias>/`.
 *
 * @param {object} p
 * @param {string} p.dropDir
 * @param {string} p.alias
 * @param {(cmd: string, args: string[], opts: object) => any} [p.exec]
 * @returns {{pending: boolean, pushed: boolean}}
 */
export function pushPending({ dropDir, alias, exec = execFileSync }) {
  if (!ALIAS_RE.test(alias)) throw new Error('deliver: not a valid alias');
  if (!fs.existsSync(dropDir) || !fs.statSync(dropDir).isDirectory()) throw new Error('deliver: the drop directory does not exist');
  const root = fs.realpathSync(dropDir);
  const git = (args) => exec('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsHide: true });
  const top = String(git(['rev-parse', '--show-toplevel']) ?? '').trim();
  if (!top || fs.realpathSync(top) !== root) throw new Error('deliver: --push needs the drop directory to be the root of its own Git work tree');

  const pathRe = new RegExp(String.raw`^${alias}/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$`);

  // 1. Uncommitted files in this alias's directory. ONLY validated exports may ride along: a stray file here would
  //    otherwise be committed and pushed without ever meeting the schema or the redaction check, so anything else
  //    (an unrelated file, a hand-edited export) stops the retry rather than being swept in.
  const status = String(git(['status', '--porcelain=v1', '-z', '-uall', '--', `${alias}/`]) ?? '');
  const dirtyPaths = status.split('\0').filter(Boolean).map((e) => e.slice(3));
  for (const p of dirtyPaths) {
    if (!pathRe.test(p)) throw new Error(`deliver: refusing to stage "${p.split('/').pop()}" — not a telemetry export (retry stopped; nothing was staged)`);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(root, ...p.split('/')), 'utf8')); } catch { throw new Error(`deliver: "${p.split('/').pop()}" is not valid JSON (retry stopped)`); }
    const v = validateExport(doc);
    if (!v.ok || v.doc.consumerAlias !== alias) throw new Error(`deliver: "${p.split('/').pop()}" does not validate as an export of this alias (retry stopped)`);
    assertExportClean(v.doc);   // throws ExportRefusedError (category only)
  }

  // 2. Commits already made but not pushed. An unavailable upstream is an UNKNOWN delivery state, not "nothing ahead"
  //    (assuming zero would silently strand an export whose push failed for want of an upstream), and only commits
  //    that touch nothing but this alias's exports may be pushed on its behalf.
  let ahead = 0;
  try {
    ahead = Number(String(git(['rev-list', '--count', '@{u}..HEAD']) ?? '0').trim());
  } catch {
    throw new Error('deliver: cannot tell whether earlier exports were pushed (no upstream configured?) — set one, then retry');
  }
  if (ahead > 0) {
    const touched = String(git(['diff', '--name-only', '-z', '@{u}..HEAD']) ?? '').split('\0').filter(Boolean);
    const stray = touched.find((p) => !pathRe.test(p));
    if (stray) throw new Error(`deliver: an unpushed commit touches "${stray}", which is not one of this alias's exports — refusing to push it on the exporter's behalf`);
  }
  if (dirtyPaths.length === 0 && ahead === 0) return { pending: false, pushed: false };
  if (dirtyPaths.length > 0) {
    git(['add', '--', ...dirtyPaths]);
    git(['commit', '-q', '-m', `telemetry export ${alias} (retry of an undelivered export)`, '--', ...dirtyPaths]);
  }
  git(['push']);
  return { pending: true, pushed: true };
}
