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
    try { fs.rmSync(tmp, { force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* leftover temp file: harmless, dot-prefixed, never .json */ }
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
