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
/** A git-ignored export could never be staged, would sit on disk unseen by the retry scan and never be delivered. */
function refuseIfIgnored(git, rel) {
  let ignored = false;
  try {
    git(['check-ignore', '-q', '--', rel]);
    ignored = true;
  } catch (err) {
    // Exit 1 is git's answer "not ignored". Anything else (fatal repository or index error) is NOT an answer.
    if (err?.status !== 1) throw new Error('deliver: could not tell whether the export would be git-ignored — refusing to publish');
  }
  if (ignored) throw new Error('deliver: the drop repository ignores exports of this name (.gitignore) — they could never be delivered');
}

function pushGate(git, root) {
  const top = String(git(['rev-parse', '--show-toplevel']) ?? '').trim();
  if (!top || fs.realpathSync(top) !== root) throw new Error('deliver: --push needs the drop directory to be the root of its own Git work tree');
  let upstream;
  try { upstream = String(git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) ?? '').trim(); } catch { upstream = ''; }
  const slash = upstream.indexOf('/');
  if (!upstream || slash < 1) throw new Error('deliver: cannot tell whether earlier exports were pushed (no upstream configured?) — set one, then retry');
  const remote = upstream.slice(0, slash);
  const branch = upstream.slice(slash + 1);
  // The checks below compare HEAD with the local tracking ref, so they only mean something for a PLAIN clone: the
  // default fetch refspec (a custom one can map a differently named remote branch onto this tracking ref) and no
  // separate push URL (a push destination that is not the one the upstream was fetched from can be behind it, and
  // an explicit push would then publish the missing ancestors too).
  const optional = (args) => { try { return String(git(args) ?? '').trim(); } catch { return ''; } };
  const fetchSpecs = optional(['config', '--get-all', `remote.${remote}.fetch`]).split('\n').filter(Boolean);
  if (fetchSpecs.length !== 1 || fetchSpecs[0] !== `+refs/heads/*:refs/remotes/${remote}/*`) {
    throw new Error(`deliver: remote "${remote}" does not use the default fetch refspec — the drop must be a plain clone`);
  }
  // The EFFECTIVE destinations, rewrites applied (`url.<base>.insteadOf` / `pushInsteadOf` / `pushurl`): the push
  // must go exactly where the upstream was fetched from, and to exactly one place.
  const fetchUrls = optional(['remote', 'get-url', '--all', remote]).split('\n').filter(Boolean);
  const pushUrls = optional(['remote', 'get-url', '--push', '--all', remote]).split('\n').filter(Boolean);
  if (fetchUrls.length !== 1 || pushUrls.length !== 1 || fetchUrls[0] !== pushUrls[0]) {
    throw new Error(`deliver: remote "${remote}" pushes somewhere other than where it fetches (a separate push URL or a rewrite) — the drop must be a plain clone`);
  }
  // The local tracking ref is only as fresh as the last fetch: a remote branch reset or deleted since would make
  // "nothing ahead" a statement about a stale picture. Ask the remote itself; a mismatch means fetch first.
  const tracked = String(git(['rev-parse', '@{u}']) ?? '').trim();
  const remoteTip = String(git(['ls-remote', remote, `refs/heads/${branch}`]) ?? '').trim().split(/\s+/)[0] ?? '';
  if (!tracked || remoteTip !== tracked) {
    throw new Error(`deliver: the remote branch is not where this clone last saw it — fetch and review first (the exporter will not push over an unknown state)`);
  }
  const ahead = Number(String(git(['rev-list', '--count', '@{u}..HEAD']) ?? '').trim());
  if (!Number.isInteger(ahead)) throw new Error('deliver: could not count unpushed commits — refusing to push');
  if (ahead > 0) {
    throw new Error(`deliver: ${ahead} commit(s) are committed but not pushed in the drop directory — push or reset them yourself; the exporter will not publish history it did not write`);
  }
  return { remote, branch, tip: tracked };
}

/**
 * Stage exactly `paths`, commit them, and push THAT commit.
 *
 *   - the push names the commit by SHA, so a commit another process makes after this one is not published with it;
 *   - `push.followTags` is switched off for this command: configuration that adds refs adds unvalidated content;
 *   - if the push fails, our own commit is undone (a mixed reset to its parent, only while HEAD is still that commit)
 *     so the exporter never leaves behind the committed-but-unpushed state its own gate refuses — the validated file
 *     stays on disk, uncommitted, for the next attempt.
 */
function commitAndPush(git, dest, paths, message) {
  git(['add', '--', ...paths]);
  const parent = String(git(['rev-parse', 'HEAD']) ?? '').trim();
  git(['commit', '-q', '-m', message, '--', ...paths]);
  const ours = String(git(['rev-parse', 'HEAD']) ?? '').trim();
  try {
    git(['-c', 'push.followTags=false', 'push', '--no-follow-tags', dest.remote, `${ours}:refs/heads/${dest.branch}`]);
  } catch (err) {
    // A push can reach the remote and still report an error (the connection dies before the acknowledgement), so a
    // failed push is NOT proof of non-delivery. Ask the remote, and act only on what can be established:
    //   - it has our commit            -> delivered; undoing anything locally would desynchronise the clone
    //   - it is exactly where it was   -> confirmed not delivered; safe to undo our own commit
    //   - unreadable, or it moved      -> UNKNOWN; leave everything as it is and say so
    let remoteTip = null;
    try { remoteTip = String(git(['ls-remote', dest.remote, `refs/heads/${dest.branch}`]) ?? '').trim().split(/\s+/)[0] || null; } catch { remoteTip = null; }
    if (remoteTip === ours) return;
    if (remoteTip === null || remoteTip !== dest.tip) {
      throw new Error('deliver: the push failed and the remote\'s state could not be established — verify what the remote has before retrying (nothing was undone locally)');
    }
    try {
      // Undo ONLY our commit, atomically: update-ref with the expected old value moves the branch back to the parent
      // only if it is STILL our commit (a commit made in between makes it a no-op), and never touches the index; then
      // just our own paths are unstaged, so anything else staged in the work tree is left exactly as it was found.
      git(['update-ref', '-m', 'telemetry-export: undo an undelivered export commit', 'HEAD', parent, ours]);
      git(['reset', '-q', '--', ...paths]);
    } catch { /* leave it: the gate will report the unpushed commit */ }
    throw err;
  }
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
  if (push) refuseIfIgnored(git, rel);

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
    commitAndPush(git, dest, [rel], `telemetry export ${doc.consumerAlias} ${doc.generatedAt.slice(0, 10)}`);
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
  const status = String(git(['status', '--porcelain=v1', '-z', '-uall', '--ignored', '--', `${alias}/`]) ?? '');
  const entries = status.split('\0').filter(Boolean);
  const ignoredExport = entries.find((e) => e.startsWith('!! ') && pathRe.test(e.slice(3)));
  if (ignoredExport) throw new Error('deliver: an export in the drop is git-ignored and can never be delivered (retry stopped)');
  // A rename or copy record is followed by a second NUL-separated path that would be read as an entry of its own;
  // exports are never renamed, so such a record means something else is going on here: stop.
  if (entries.some((e) => /^[RC]/.test(e))) throw new Error('deliver: a rename or copy is staged in the alias directory — not an export (retry stopped)');
  const dirtyPaths = entries.filter((e) => !e.startsWith('!! ')).map((e) => e.slice(3));
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

  commitAndPush(git, dest, dirtyPaths, `telemetry export ${alias} (retry of an undelivered export)`);
  return { pending: true, pushed: true };
}
