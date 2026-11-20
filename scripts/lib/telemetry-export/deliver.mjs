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
 * The ONE gate in front of any push the exporter makes (the fresh-export path and the retry path alike).
 *
 * The exporter pushes only what IT created, and only when that is the whole difference to the remote:
 *   - the drop directory is itself the ROOT of its own work tree (not a folder inside another repository);
 *   - an upstream is configured — its absence is an UNKNOWN delivery state, never "nothing pending"; and
 *   - NOTHING is already committed-but-unpushed. A push publishes every ancestor, so pushing on top of history the
 *     exporter did not write would publish that history too, past the schema and the redaction check. Rather than
 *     try to inspect arbitrary commits, it refuses and says so; whoever made them pushes them.
 *
 * @returns {{remote: string, branch: string}} the destination, resolved explicitly (a bare `git push` obeys
 *   push.default / remote.pushDefault and could publish other refs)
 */
function pushGate(git, root) {
  const top = String(git(['rev-parse', '--show-toplevel']) ?? '').trim();
  if (!top || fs.realpathSync(top) !== root) throw new Error('deliver: --push needs the drop directory to be the root of its own Git work tree');
  let upstream;
  try { upstream = String(git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) ?? '').trim(); } catch { upstream = ''; }
  const slash = upstream.indexOf('/');
  if (!upstream || slash < 1) throw new Error('deliver: cannot tell whether earlier exports were pushed (no upstream configured?) — set one, then retry');
  const remote = upstream.slice(0, slash);
  const branch = upstream.slice(slash + 1);
  const ahead = Number(String(git(['rev-list', '--count', '@{u}..HEAD']) ?? '').trim());
  if (!Number.isInteger(ahead)) throw new Error('deliver: could not count unpushed commits — refusing to push');
  if (ahead > 0) {
    throw new Error(`deliver: ${ahead} commit(s) are committed but not pushed in the drop directory — push or reset them yourself; the exporter will not publish history it did not write`);
  }
  return { remote, branch };
}

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
  const dest = push ? pushGate(git, root) : null;

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
    git(['push', dest.remote, `HEAD:refs/heads/${dest.branch}`]);
    pushed = true;
  }
  return { file: target, pushed };
}

/**
 * Deliver what is already written but not yet COMMITTED, for ONE alias.
 *
 * Why this exists: the throttle (`--if-older-than`) treats a recent valid file as "an export exists", but a file written
 * by an earlier run whose push failed (offline, rejected) is NOT delivered, and would otherwise suppress every later
 * attempt for the whole throttle window. This stages, commits and pushes ONLY validated exports of this alias, through
 * the same `pushGate` as a fresh export. Commits that already exist but were never pushed are NOT pushed on the
 * exporter's behalf (the gate refuses and says so): they were not written by it, and inspecting arbitrary history is
 * not something an exporter should pretend to do safely.
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
  const dest = pushGate(git, root);

  // Uncommitted files in this alias's directory. ONLY validated exports may ride along: a stray file here would
  // otherwise be committed and pushed without ever meeting the schema or the redaction check, so anything else (an
  // unrelated file, a hand-edited export, a symlink) stops the retry rather than being swept in.
  const pathRe = new RegExp(String.raw`^${alias}/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$`);
  const status = String(git(['status', '--porcelain=v1', '-z', '-uall', '--', `${alias}/`]) ?? '');
  const dirtyPaths = status.split('\0').filter(Boolean).map((e) => e.slice(3));
  for (const p of dirtyPaths) {
    const name = p.split('/').pop();
    if (!pathRe.test(p)) throw new Error(`deliver: refusing to stage "${name}" — not a telemetry export (retry stopped; nothing was staged)`);
    const full = path.join(root, ...p.split('/'));
    // lstat, never a followed read: a symlink would validate as its TARGET's JSON while git commits the link itself.
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`deliver: "${name}" is not a regular file (retry stopped)`);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { throw new Error(`deliver: "${name}" is not valid JSON (retry stopped)`); }
    const v = validateExport(doc);
    if (!v.ok || v.doc.consumerAlias !== alias) throw new Error(`deliver: "${name}" does not validate as an export of this alias (retry stopped)`);
    assertExportClean(v.doc);   // throws ExportRefusedError (category only)
  }
  if (dirtyPaths.length === 0) return { pending: false, pushed: false };

  git(['add', '--', ...dirtyPaths]);
  git(['commit', '-q', '-m', `telemetry export ${alias} (retry of an undelivered export)`, '--', ...dirtyPaths]);
  git(['push', dest.remote, `HEAD:refs/heads/${dest.branch}`]);
  return { pending: true, pushed: true };
}
