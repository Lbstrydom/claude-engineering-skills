/**
 * @fileoverview Delivery: write the finished export into the drop directory.
 *
 * THE ONE PRIMITIVE (plan §6 decision 2). Every channel reduces to "a directory of files the
 * reader can scan": a private Git repository cloned on both machines (recommended — per-writer
 * access control, an audit trail, atomic publication by commit), a synced shared folder, or a
 * person carrying the file. The exporter only ever writes into `TELEMETRY_DROP_DIR`.
 *
 *   - IMMUTABLE, UNIQUELY NAMED: `<alias>/<yyyy-mm-dd>-<first 8 of exportId>.json`. A same-day
 *     repeat is a second file, never an overwrite, so a delayed or rejected older file can never
 *     replace a valid newer one.
 *   - ATOMIC: written to a temporary name in the SAME directory and renamed into place, so a
 *     reader never sees a half-written file. The temporary name never ends in `.json`.
 *   - `--push` (opt-in): when the drop directory is a Git work tree, run exactly
 *     `git add <file>`, `git commit`, `git push` there — nothing else, never `--force`, never a
 *     branch or remote change. Without it the exporter only writes the file.
 *
 * @module scripts/lib/telemetry-export/deliver
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ALIAS_RE = /^[a-z0-9-]{1,32}$/;

/**
 * @param {object} doc a validated export
 * @returns {string} the repo-relative file name inside the drop directory
 */
export function exportFileName(doc) {
  if (!ALIAS_RE.test(doc.consumerAlias)) throw new Error('deliver: consumerAlias is not a valid alias');
  return `${doc.consumerAlias}/${doc.generatedAt.slice(0, 10)}-${doc.exportId.slice(0, 8)}.json`;
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
  const root = path.resolve(dropDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('deliver: the drop directory does not exist');

  const rel = exportFileName(doc);
  const target = path.join(root, ...rel.split('/'));
  // Containment: the alias is regex-bounded and the date/exportId are hex, but the join is still checked.
  if (!path.resolve(target).startsWith(root + path.sep)) throw new Error('deliver: the target escapes the drop directory');
  if (fs.existsSync(target)) throw new Error('deliver: an export with this name already exists (exports are immutable)');

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(tmp, target);

  let pushed = false;
  if (push) {
    const git = (args) => exec('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsHide: true });
    git(['rev-parse', '--is-inside-work-tree']);
    git(['add', '--', rel]);
    git(['commit', '-q', '-m', `telemetry export ${doc.consumerAlias} ${doc.generatedAt.slice(0, 10)}`, '--', rel]);
    git(['push']);
    pushed = true;
  }
  return { file: target, pushed };
}
