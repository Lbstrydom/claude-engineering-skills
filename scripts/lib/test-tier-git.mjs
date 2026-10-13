/**
 * @fileoverview The git side of the test-tier oracle (`test-tier.mjs` stays pure): read a head's tree from git
 * OBJECTS (never the working tree), resolve the selection base, list what changed, identify the selector.
 *
 * **The selection base is the fork point, not the push range** (plan D4). The hook's `PUSH_BASE` is the remote sha for
 * a branch already pushed, so a re-push after a fix would select against the fix alone; that is a different question
 * from `push-range.mjs`'s ("which commits does this push send"), so it has its own name and resolver. A stale
 * `origin/<default>` only makes the base older and the diff larger: the safe direction.
 *
 * Results are structured (`{ok:true,…}` / `{ok:false, error}`), never bare throws, in the shape of `vcs.mjs`.
 *
 * @module scripts/lib/test-tier-git
 */
import { spawnSync } from 'node:child_process';
import { sanitizeGitEnv } from './git-env-sanitize.mjs';
import { isSafeGitRevision } from './vcs.mjs';
import { SELECTOR_IDENTITY_FILES } from './test-tier.mjs';

const MAX_BUFFER = 1 << 30;
const SHA = /^[0-9a-f]{40,64}$/;

function run(cwd, args, { input } = {}) {
  const r = spawnSync('git', args, { cwd, env: sanitizeGitEnv(cwd), encoding: input === undefined ? 'utf8' : undefined, input, maxBuffer: MAX_BUFFER });
  return r;
}

/** Run git and return trimmed stdout, or null with the reason. */
function out(cwd, args) {
  const r = run(cwd, args);
  if (r.error) return { ok: false, reason: `git ${args[0]} failed to run: ${r.error.message}`, status: null };
  if (r.status !== 0) return { ok: false, reason: `git ${args[0]} exited ${r.status}: ${String(r.stderr).trim().split('\n')[0] || 'no output'}`, status: r.status };
  return { ok: true, value: String(r.stdout).trim() };
}

/**
 * Strict reader for `-z` output: every record is NUL-TERMINATED and non-empty. An unterminated stream (a truncated read)
 * or an empty record is malformed output, never silently dropped (audit M2).
 * @returns {{ok: true, records: string[]}|{ok: false, reason: string}}
 */
function splitNul(text) {
  if (text === '') return { ok: true, records: [] };
  if (!text.endsWith('\0')) return { ok: false, reason: 'the stream is not NUL-terminated (truncated?)' };
  const records = text.slice(0, -1).split('\0');
  if (records.some((r) => r === '')) return { ok: false, reason: 'the stream contains an empty record' };
  return { ok: true, records };
}

/** Resolve a revision to a full commit id. */
export function resolveCommit(cwd, rev) {
  if (!isSafeGitRevision(rev)) return { ok: false, error: `refusing an unsafe revision: ${JSON.stringify(String(rev).slice(0, 80))}` };
  const r = out(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  if (!r.ok || !SHA.test(r.value)) return { ok: false, error: r.ok ? `${rev} did not resolve to a commit id` : `${rev} does not resolve to a commit (${r.reason})` };
  return { ok: true, oid: r.value };
}

/** The remote's default branch name: `origin/HEAD`'s target, else `main`. */
export function defaultBranchName(cwd) {
  const r = out(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const m = r.ok ? /^origin\/(.+)$/.exec(r.value) : null;
  return m ? m[1] : 'main';
}

/**
 * The ONE resolver for the selection base (D4). `head` and an explicit `base` resolve to full commit ids; an explicit
 * base must be an ancestor of `head`, and one that is malformed, unresolvable or not an ancestor is an ERROR (never a
 * degrade). With no explicit base the fork point from `origin/<default>` is used; when that cannot be computed the
 * result is `{ok:true, base:null}` and the oracle's `full` escape applies. An ancestry check git cannot answer (an
 * exit other than 0 or 1) is an error, never "assume ancestor".
 *
 * @returns {{ok: true, head: string, base: string|null, source: string, reason?: string}|{ok: false, error: string}}
 */
export function resolveSelectionBase({ cwd, head, base = null }) {
  const h = resolveCommit(cwd, head);
  if (!h.ok) return { ok: false, error: h.error };
  // An omitted base is null/undefined; a SUPPLIED empty string is an invalid base, never "infer one" (audit M6/M14).
  if (base !== null && base !== undefined) {
    const b = resolveCommit(cwd, base);
    if (!b.ok) return { ok: false, error: `--base: ${b.error}` };
    const anc = run(cwd, ['merge-base', '--is-ancestor', b.oid, h.oid]);
    if (anc.error) return { ok: false, error: `could not check that --base is an ancestor of the head (${anc.error.message})` };
    if (anc.status === 1) return { ok: false, error: `--base ${b.oid.slice(0, 12)} is not an ancestor of ${h.oid.slice(0, 12)}` };
    if (anc.status !== 0) return { ok: false, error: `git could not answer whether --base is an ancestor of the head (exit ${anc.status})` };
    return { ok: true, head: h.oid, base: b.oid, source: 'explicit' };
  }
  const ref = `origin/${defaultBranchName(cwd)}`;
  const mb = out(cwd, ['merge-base', ref, h.oid]);
  if (!mb.ok || !SHA.test(mb.value)) return { ok: true, head: h.oid, base: null, source: 'none', reason: `no merge-base with ${ref}${mb.ok ? '' : ` (${mb.reason})`}` };
  return { ok: true, head: h.oid, base: mb.value, source: `merge-base:${ref}` };
}

/** Paths that differ between `base` and `head` (renames split into delete + add). */
export function changedFiles(cwd, base, head) {
  const r = run(cwd, ['diff', '--name-only', '--no-renames', '-z', '--no-ext-diff', '--no-textconv', base, head]);
  if (r.error || r.status !== 0) return { ok: false, error: `git diff failed: ${r.error?.message ?? String(r.stderr).trim().split('\n')[0]}` };
  const recs = splitNul(String(r.stdout));
  if (!recs.ok) return { ok: false, error: `git diff output is malformed: ${recs.reason}` };
  return { ok: true, files: recs.records };
}

/** The head's committer time as an ISO instant: the clock the list's age is judged at, so a query gives the same answer tomorrow. */
export function committerTime(cwd, head) {
  const r = out(cwd, ['show', '-s', '--format=%cI', head]);
  const t = r.ok ? Date.parse(r.value) : NaN;
  return Number.isFinite(t) ? { ok: true, iso: new Date(t).toISOString() } : { ok: false, error: `could not read the committer time of ${head}` };
}

/** `git rev-parse <rev>:<path>`: a blob id, or null when the path is absent. */
export function blobSha(cwd, rev, filePath) {
  const r = out(cwd, ['rev-parse', '--verify', '--quiet', `${rev}:${filePath}`]);
  return r.ok && SHA.test(r.value) ? r.value : null;
}

/** One file's text at `rev`, or null. */
export function readFileAt(cwd, rev, filePath) {
  const r = run(cwd, ['show', `${rev}:${filePath}`]);
  return r.error || r.status !== 0 ? null : String(r.stdout);
}

const CODE = /\.(?:mjs|js|cjs)$/;

/**
 * The head's tree as the oracle's injected reader: the file set from `git ls-tree`, and every code file's text from one
 * `git cat-file --batch`. Never the working tree.
 *
 * @returns {{ok: true, tree: {files: Set<string>, read: (p: string) => string|null}}|{ok: false, error: string}}
 */
export function readTreeAt(cwd, head) {
  // `<mode> SP <type> SP <oid> TAB <path> NUL`: object ids, not path-spelled requests, go to cat-file, so a tracked path
  // containing a newline (or anything else) cannot turn one request into several (audit M1/H6).
  const ls = run(cwd, ['ls-tree', '-r', '-z', head]);
  if (ls.error || ls.status !== 0) return { ok: false, error: `git ls-tree failed: ${ls.error?.message ?? String(ls.stderr).trim().split('\n')[0]}` };
  const recs = splitNul(String(ls.stdout));
  if (!recs.ok) return { ok: false, error: `git ls-tree output is malformed: ${recs.reason}` };
  const entries = [];
  for (const rec of recs.records) {
    const m = /^(\d+) (\w+) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(rec);
    if (!m) return { ok: false, error: `git ls-tree gave an unreadable record: ${JSON.stringify(rec.slice(0, 80))}` };
    entries.push({ mode: m[1], type: m[2], oid: m[3], path: m[4] });
  }
  const files = entries.map((e) => e.path);
  // A symbolic link (mode 120000) is a blob whose CONTENT is a target path, not source: it is listed (the path exists) but
  // never read or parsed as code (audit r2 H1).
  const wanted = entries.filter((e) => e.type === 'blob' && e.mode !== '120000' && CODE.test(e.path) && !e.path.startsWith('node_modules/'));
  const cat = run(cwd, ['cat-file', '--batch'], { input: `${wanted.map((e) => e.oid).join('\n')}\n` });
  if (cat.error || cat.status !== 0) return { ok: false, error: `git cat-file failed: ${cat.error?.message ?? String(cat.stderr).trim().split('\n')[0]}` };
  const buf = cat.stdout;
  const content = new Map();
  let off = 0;
  for (const e of wanted) {
    const nl = buf.indexOf(10, off);
    if (nl < 0) return { ok: false, error: 'git cat-file output ended early' };
    const header = buf.subarray(off, nl).toString();
    off = nl + 1;
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!m) continue; // missing or not a blob: left unread, which the oracle treats as an edge it cannot follow
    const n = Number(m[1]);
    content.set(e.path, buf.subarray(off, off + n).toString('utf8'));
    off += n + 1;
  }
  return { ok: true, tree: { files: new Set(files), symlinks: new Set(entries.filter((e) => e.mode === '120000').map((e) => e.path)), read: (p) => content.get(p) ?? null } };
}

/** The blob shas that identify the selector at `rev` (§2.6): the code that decides, not the list. */
export function selectorIdentity(cwd, rev) {
  const sel = {};
  for (const f of SELECTOR_IDENTITY_FILES) sel[f] = blobSha(cwd, rev, f);
  return { selector: sel, manifest: blobSha(cwd, rev, '.test-tiers.json') };
}
