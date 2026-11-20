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
 * @param {(cmd: string, args: string[], opts: object) => any} [p.exec]
 * @returns {{file: string, pushed: boolean}}
 */
export function deliverExport({ doc, dropDir, push = false, exec = execFileSync }) {
  if (!dropDir || typeof dropDir !== 'string') throw new Error('deliver: no drop directory (set TELEMETRY_DROP_DIR or pass --drop-dir)');
  if (!fs.existsSync(dropDir) || !fs.statSync(dropDir).isDirectory()) throw new Error('deliver: the drop directory does not exist');
  const root = fs.realpathSync(dropDir);

  const rel = exportFileName(doc);
  const [aliasDir, fileName] = rel.split('/');
  const aliasPath = path.join(root, aliasDir);

  // The alias directory is created by us or is a plain directory: never a symlink (which could point out of the drop).
  let st = null;
  try { st = fs.lstatSync(aliasPath); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  if (st) {
    if (st.isSymbolicLink()) throw new Error('deliver: the alias directory is a symlink (refused)');
    if (!st.isDirectory()) throw new Error('deliver: the alias path exists and is not a directory');
  } else {
    fs.mkdirSync(aliasPath);
  }
  const realAlias = fs.realpathSync(aliasPath);
  if (!isInside(root, realAlias)) throw new Error('deliver: the alias directory resolves outside the drop directory');

  const target = path.join(realAlias, fileName);
  const tmp = path.join(realAlias, `.${fileName}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { flag: 'wx' });
  try {
    fs.linkSync(tmp, target);   // fails EEXIST rather than replacing: exports are immutable
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (err?.code === 'EEXIST') throw new Error('deliver: an export with this name already exists (exports are immutable)');
    throw err;
  }
  fs.rmSync(tmp, { force: true });

  let pushed = false;
  if (push) {
    const git = (args) => exec('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsHide: true });
    const top = String(git(['rev-parse', '--show-toplevel']) ?? '').trim();
    // The drop directory must BE the work tree's root, not a folder inside some other repository.
    if (!top || fs.realpathSync(top) !== root) throw new Error('deliver: --push needs the drop directory to be the root of its own Git work tree');
    git(['add', '--', rel]);
    git(['commit', '-q', '-m', `telemetry export ${doc.consumerAlias} ${doc.generatedAt.slice(0, 10)}`, '--', rel]);
    git(['push']);
    pushed = true;
  }
  return { file: target, pushed };
}
