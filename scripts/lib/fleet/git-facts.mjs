/**
 * @fileoverview Git facts for /fleet — everything that needs a `git` process,
 * returned as plain data that carries its own provenance.
 *
 * Every fact block is `{queried, observedAt, reason?, ...payload}`. A query that
 * could not be answered says `queried:false` with a reason; it is NEVER rendered
 * as an empty result (an unasked question must not read as "nothing there").
 *
 * Process hygiene: `GIT_TERMINAL_PROMPT=0` (a missing credential fails instead
 * of blocking on a prompt), `GIT_NO_LAZY_FETCH=1` (a partial clone cannot reach
 * the network behind a local read), `LC_ALL=C`, a timeout on every call, and
 * `sanitizeGitEnv` so a hook-exported `GIT_DIR` cannot redirect a query. All
 * list output is NUL-delimited — worktree paths with spaces, CRLF in porcelain
 * output, and branch names are parsed from `-z` records, never from lines.
 *
 * Base freshness is NOT reimplemented: `baseFreshness` delegates to
 * `resolveBaseFreshness` (never fetches; `unknown` is a real state).
 *
 * Plan: docs/plans/fleet-multi-session-coordination.md §2, §7 (Phase 1).
 *
 * @module scripts/lib/fleet/git-facts
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sanitizeGitEnv } from '../git-env-sanitize.mjs';
import { resolveBaseFreshness } from '../git-freshness.mjs';
import { OID_PATTERN, OID_RE, isOid } from './contracts.mjs';
import { VALID, memoPure } from './oid-cache.mjs';

const LOCAL_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 30_000;

/** @returns {string} */
function nowIso() { return new Date().toISOString(); }

/** A fact block: provenance first, payload after. */
function block(queried, payload = {}, reason) {
  return { queried, observedAt: nowIso(), ...(reason ? { reason } : {}), ...payload };
}

/**
 * Run git once. Never throws.
 * @param {string[]} args
 * @param {string} cwd
 * @param {{timeoutMs?: number, input?: string}} [opts]
 * @returns {{ok: boolean, status: number|null, stdout: string, stderr: string, reason: string|null}}
 */
export function runGit(args, cwd, { timeoutMs = LOCAL_TIMEOUT_MS, input } = {}) {
  const sub = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c') ?? args[0];
  const env = {
    ...sanitizeGitEnv(cwd),
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    LC_ALL: 'C',
  };
  const res = spawnSync('git', args, {
    cwd, env, encoding: 'utf-8', timeout: timeoutMs,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    const timedOut = res.error.code === 'ETIMEDOUT';
    return { ok: false, status: null, stdout: '', stderr: '',
      reason: timedOut ? `git ${sub} timed out after ${timeoutMs}ms` : `git ${sub} failed to run: ${res.error.message}` };
  }
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  return { ok: res.status === 0, status: res.status, stdout, stderr,
    reason: res.status === 0 ? null : `git ${sub} exited ${res.status}: ${stderr.trim().split('\n')[0] || 'no output'}` };
}

// ── Pure parsers ────────────────────────────────────────────────────────────

/**
 * Parse `git worktree list --porcelain -z`. Records are NUL-terminated fields,
 * a record ends with an empty field.
 * @param {string} text
 * @returns {Array<{path: string, head: string|null, branch: string|null, detached: boolean, bare: boolean, locked: boolean, prunable: boolean, prunableReason: string|null}>}
 */
export function parseWorktreePorcelain(text) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur && cur.path) out.push(cur); cur = null; };
  for (const field of String(text).split('\0')) {
    if (field === '') { flush(); continue; }
    const sp = field.indexOf(' ');
    const key = sp === -1 ? field : field.slice(0, sp);
    const val = sp === -1 ? '' : field.slice(sp + 1);
    if (key === 'worktree') {
      flush();
      cur = { path: val, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false, prunableReason: null };
    } else if (!cur) {
      continue;
    } else if (key === 'HEAD') cur.head = val;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') { cur.prunable = true; cur.prunableReason = val || null; }
  }
  flush();
  return out;
}

/**
 * Split NUL-delimited names (`diff --name-only -z`).
 * @param {string} text
 * @returns {string[]}
 */
export function parseNulList(text) {
  return String(text).split('\0').filter((s) => s !== '');
}

/**
 * Parse the for-each-ref record format used by `listBranches`
 * (`name NUL oid NUL unix-time`, one record per line).
 * @param {string} text
 * @returns {Array<{name: string, oid: string, tipTime: number|null}>}
 */
export function parseBranchRefs(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    const [ref, oid, ct, counts] = line.split('\0');
    if (!ref || !oid) continue;
    const t = Number.parseInt(ct, 10);
    out.push({ name: ref.replace(/^refs\/heads\//, ''), oid, tipTime: Number.isFinite(t) ? t * 1000 : null, counts: counts ?? null });
  }
  return out;
}

/**
 * Parse `git ls-remote <url> <ref>` for an EXACT ref match.
 * @param {string} text
 * @param {string} ref - full ref, e.g. `refs/heads/main`
 * @returns {string|null}
 */
export function parseLsRemote(text, ref) {
  for (const line of String(text).split('\n')) {
    const [oid, name] = line.split('\t');
    if (name === ref && OID_RE.test(oid)) return oid;
  }
  return null;
}

/** First column of `git patch-id` output, or null for an empty diff. */
export function parsePatchId(text) {
  const m = new RegExp(`^(${OID_PATTERN})\\s`, 'm').exec(String(text));
  return m ? m[1] : null;
}

// ── Fact gatherers ──────────────────────────────────────────────────────────

/** @returns {{ok: boolean, dir?: string, reason?: string}} */
export function gitCommonDir(cwd) {
  const r = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return r.ok ? { ok: true, dir: r.stdout.trim() } : { ok: false, reason: r.reason };
}

const commonDirs = new Map();
/** The common dir for the commit-id cache (memoised per cwd); null when it cannot be resolved. */
export function cacheDirFor(cwd) {
  if (!commonDirs.has(cwd)) {
    const r = gitCommonDir(cwd);
    commonDirs.set(cwd, r.ok ? r.dir : null);
  }
  return commonDirs.get(cwd);
}

/**
 * Every merge-base of two COMMITS (`merge-base --all`), memoised by their ids.
 * @returns {{ok: boolean, value?: string[], reason?: string}}
 */
export function mergeBasesAll(cwd, a, b) {
  return memoPure({ commonDir: cacheDirFor(cwd), op: 'mb-all', oids: [a, b], valid: VALID.oids, compute: () => {
    const r = runGit(['merge-base', '--all', a, b], cwd);
    return r.ok ? { ok: true, value: r.stdout.split('\n').map((x) => x.trim()).filter(Boolean) } : { ok: false, reason: r.reason };
  } });
}

/**
 * The cache key for a `base...branch` (three-dot) answer. With a SINGLE
 * merge-base the answer is a function of (merge-base, branch) alone, so it stays
 * cached when base moves on but the fork point does not; with several (a
 * criss-cross history) the key falls back to (base, branch). Not ids → [] (live).
 */
function forkKey(cwd, base, branch) {
  if (!isOid(base) || !isOid(branch)) return [];
  const mbs = mergeBasesAll(cwd, base, branch);
  return mbs.ok && mbs.value.length === 1 ? [mbs.value[0], branch] : [base, branch];
}

/** Top-level of the work tree containing `cwd`. */
export function repoToplevel(cwd) {
  const r = runGit(['rev-parse', '--show-toplevel'], cwd);
  return r.ok ? { ok: true, dir: r.stdout.trim() } : { ok: false, reason: r.reason };
}

/** @returns {{ok: boolean, oid?: string, reason?: string}} */
export function headOf(cwd, ref = 'HEAD') {
  const r = runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
  return r.ok ? { ok: true, oid: r.stdout.trim() } : { ok: false, reason: r.reason ?? `cannot resolve ${ref}` };
}

/** @returns {{ok: boolean, oid?: string, reason?: string}} */
export function mergeBase(cwd, a, b) {
  // Two commit ids: answer from the (memoised) `--all` list — its first entry is
  // the one `git merge-base a b` prints — so a status run pays one merge-base per
  // branch, not two. A ref name still asks git directly.
  if (isOid(a) && isOid(b)) {
    const all = mergeBasesAll(cwd, a, b);
    return all.ok && all.value.length ? { ok: true, oid: all.value[0] } : { ok: false, reason: all.reason ?? `no merge-base of ${a} and ${b}` };
  }
  const r = runGit(['merge-base', a, b], cwd);
  return r.ok ? { ok: true, oid: r.stdout.trim() } : { ok: false, reason: r.reason };
}

/**
 * The commit every "what did this branch change" question is measured against:
 * the FRESHER of the local base branch and its remote-tracking upstream.
 *
 * Why not just the local branch: three-dot (`base...branch`) only discounts commits
 * that landed on base AFTER the fork. When the local base TRAILS the upstream a
 * branch was cut from, the merge-base IS the stale local tip, so every commit the
 * upstream gained since reads as the branch's own change - phantom overlaps that
 * block a legitimate claim. Measuring from the upstream removes them.
 *
 *  `relation` says how the two stand, and which one was picked:
 *  - `same` / `local-ahead` (upstream is an ancestor: unpushed base commits) / `local-only` -> local;
 *  - `local-trails` (local is an ancestor of upstream; `behindBy` = by how much) / `upstream-only` -> upstream;
 *  - `diverged` or `unknown` (git could not answer) -> local, and overlaps measured from it
 *    may be phantom: callers must say so rather than present them as fact.
 *  Neither resolves -> `{ok:false}`. Never fetches: "fresher" means as of your last fetch.
 *
 * @param {string} cwd
 * @param {{base: string, upstream: string|null}} refs - base is a branch NAME, upstream e.g. `origin/main`
 * @param {{git?: typeof runGit}} [opts]
 * @returns {{ok: true, oid: string, ref: string, source: 'local'|'upstream', behindBy: number|null,
 *   relation: 'same'|'local-ahead'|'local-only'|'local-trails'|'upstream-only'|'diverged'|'unknown'}
 *   | {ok: false, kind: 'base-unresolvable'|'git-error', reason: string}}
 */
export function resolveMeasurementBase(cwd, { base, upstream }, { git = runGit } = {}) {
  // `rev-parse --verify --quiet`: exit 1 = the ref does not exist; anything else = git failed, which is
  // NOT an absence and must not quietly select the other ref.
  let failure = null;
  const oidOf = (ref) => {
    const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    if (r.ok) return r.stdout.trim();
    if (r.status !== 1 && !failure) failure = `cannot resolve ${ref}: ${r.reason ?? `git exited ${r.status}`}`;
    return null;
  };
  const localRef = `refs/heads/${base}`;
  const upRef = upstream ? (upstream.startsWith('refs/') ? upstream : `refs/remotes/${upstream}`) : null;
  const local = oidOf(localRef);
  const up = upRef ? oidOf(upRef) : null;
  if (failure) return { ok: false, kind: 'git-error', reason: failure };
  const pick = (source, relation, extra = {}) => ({
    ok: true, oid: source === 'local' ? local : up, ref: source === 'local' ? base : upstream, source, relation, behindBy: 0, ...extra,
  });
  if (!local && !up) return { ok: false, kind: 'base-unresolvable', reason: `base branch ${base} is not resolvable (neither ${localRef}${upRef ? ` nor ${upRef}` : ''} exists)` };
  if (!up) return pick('local', 'local-only');
  if (!local) return pick('upstream', 'upstream-only');
  if (local === up) return pick('local', 'same');
  // `merge-base --is-ancestor`: exit 0 = yes, 1 = no, anything else = git could not tell.
  const anc = (a, b) => git(['merge-base', '--is-ancestor', a, b], cwd).status;
  const trails = anc(local, up);
  if (trails === 0) {
    const n = git(['rev-list', '--count', `${local}..${up}`], cwd);
    const behindBy = n.ok ? Number.parseInt(n.stdout.trim(), 10) : Number.NaN;
    return pick('upstream', 'local-trails', { behindBy: Number.isFinite(behindBy) ? behindBy : null });
  }
  const ahead = trails === 1 ? anc(up, local) : null;
  if (ahead === 0) return pick('local', 'local-ahead');
  return pick('local', trails === 1 && ahead === 1 ? 'diverged' : 'unknown');
}

/**
 * Every worktree git knows, with directories that vanished flagged `missing`
 * (git still lists them as `prunable`) — never dropped.
 */
export function listWorktrees(cwd) {
  const r = runGit(['worktree', 'list', '--porcelain', '-z'], cwd);
  if (!r.ok) return block(false, { worktrees: [] }, r.reason);
  const worktrees = parseWorktreePorcelain(r.stdout).map((w) => ({
    ...w, missing: !fs.existsSync(w.path),
  }));
  return block(true, { worktrees });
}

/** Parse `rev-list --left-right --count` / `%(ahead-behind)` text into {ahead, behind}, or null. */
function parseCounts(text, order) {
  const m = /^(\d+)\s+(\d+)$/.exec(String(text).trim());
  if (!m) return null;
  return order === 'left-right' ? { behind: Number(m[1]), ahead: Number(m[2]) } : { ahead: Number(m[1]), behind: Number(m[2]) };
}

/**
 * Local branches with ahead/behind against `base`, and tip commit time (ms).
 *
 * Fast path: ONE `for-each-ref` with the `%(ahead-behind:<base>)` atom (git >=
 * 2.41), so a repo with many branches does not spawn a process per branch. If
 * git cannot do that (old git, unresolvable base) it falls back to one
 * `rev-list` per branch. In BOTH paths a branch whose counts could not be
 * obtained keeps the REASON (`countsReason`, counts null) and the block is
 * `partial:true` — a null is never a bare unknown.
 *
 * @param {string} cwd
 * @param {string} base - a ref, e.g. `main` or `origin/main`
 * @param {{exec?: typeof runGit, aheadBehind?: boolean}} [opts] - `exec` is injectable for tests
 */
export function listBranches(cwd, base, { exec = runGit, aheadBehind = true } = {}) {
  const fmt = '%(refname)%00%(objectname)%00%(committerdate:unix)';
  let r = aheadBehind ? exec(['for-each-ref', `--format=${fmt}%00%(ahead-behind:${base})`, 'refs/heads'], cwd) : null;
  let fast = Boolean(r?.ok);
  let refs = fast ? parseBranchRefs(r.stdout) : null;
  // Probe: every record must carry a parseable count, else this git ignored the atom.
  if (fast && !refs.every((b) => parseCounts(b.counts, 'ahead-behind'))) fast = false;
  if (!fast) {
    r = exec(['for-each-ref', `--format=${fmt}`, 'refs/heads'], cwd);
    if (!r.ok) return block(false, { branches: [], base }, r.reason);
    refs = parseBranchRefs(r.stdout);
  }
  const branches = refs.map((b) => {
    const { counts, ...rest } = b;
    if (fast) return { ...rest, ...parseCounts(counts, 'ahead-behind') };
    const lr = exec(['rev-list', '--left-right', '--count', `${base}...${b.oid}`], cwd);
    const c = lr.ok ? parseCounts(lr.stdout, 'left-right') : null;
    if (c) return { ...rest, ...c };
    return { ...rest, ahead: null, behind: null, countsReason: lr.reason ?? 'unparseable ahead/behind output' };
  });
  const partial = branches.some((b) => b.countsReason);
  return block(true, { branches, base, ...(partial ? { partial: true } : {}) });
}

/**
 * Files changed on `branch` since it forked from `base` (`merge-base...branch`).
 * `--no-renames` so BOTH endpoints of a rename appear (a rename out of a claimed
 * directory is still a change to it). Three-dot on purpose: a stale local base
 * must not inflate the change set with commits that landed on base after the fork.
 * @returns {{queried: boolean, files: string[], observedAt: string, reason?: string}}
 */
export function changedFiles(cwd, base, branch) {
  const key = forkKey(cwd, base, branch);
  const r = memoPure({ commonDir: key.length ? cacheDirFor(cwd) : null, op: 'changed', oids: key, valid: VALID.files, compute: () => {
    const g = runGit(['diff', '--name-only', '-z', '--no-renames', `${base}...${branch}`], cwd);
    return g.ok ? { ok: true, value: parseNulList(g.stdout) } : { ok: false, reason: g.reason };
  } });
  return r.ok ? block(true, { files: r.value }) : block(false, { files: [] }, r.reason);
}

/**
 * `-c` config and flags that make a diff canonical for `git patch-id`. Every
 * patch-id producer uses BOTH, so fingerprints from different producers compare.
 */
export const CANON_DIFF_CONFIG = Object.freeze([
  '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'core.quotepath=off', '-c', 'color.ui=false', '-c', 'diff.renames=false',
]);
export const CANON_DIFF_FLAGS = Object.freeze(['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames']);

/**
 * Stable patch-id of the whole branch diff (`merge-base...branch`); two branches
 * with equal ids carry the same change. `patchId: null` = empty diff. The diff is
 * canonical: nothing in a user's git config (external diff, textconv, colour,
 * prefixes, path quoting, rename detection) may change the fingerprint.
 */
export function patchId(cwd, base, branch) {
  const key = forkKey(cwd, base, branch);
  const r = memoPure({ commonDir: key.length ? cacheDirFor(cwd) : null, op: 'patch', oids: key, valid: VALID.patchId, compute: () => {
    const d = runGit([...CANON_DIFF_CONFIG, 'diff', ...CANON_DIFF_FLAGS, `${base}...${branch}`], cwd);
    if (!d.ok) return { ok: false, reason: d.reason };
    if (d.stdout === '') return { ok: true, value: null };
    const p = runGit(['patch-id', '--stable'], cwd, { input: d.stdout });
    return p.ok ? { ok: true, value: parsePatchId(p.stdout) } : { ok: false, reason: p.reason };
  } });
  return r.ok ? block(true, { patchId: r.value }) : block(false, { patchId: null }, r.reason);
}

/**
 * Is `a` an ancestor of `b`? exit 1 is a legitimate false; anything else is
 * "could not tell".
 * @returns {{ok: boolean, value?: boolean, reason?: string}}
 */
export function isAncestor(cwd, a, b) {
  const r = runGit(['merge-base', '--is-ancestor', a, b], cwd);
  if (r.status === 0) return { ok: true, value: true };
  if (r.status === 1) return { ok: true, value: false };
  return { ok: false, reason: r.reason };
}

/**
 * Tip commit time of `ref`, epoch ms.
 * @returns {{ok: boolean, at?: number, reason?: string}}
 */
export function tipCommitTime(cwd, ref) {
  const r = runGit(['log', '-1', '--format=%ct', ref], cwd);
  if (!r.ok) return { ok: false, reason: r.reason };
  const t = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(t) ? { ok: true, at: t * 1000 } : { ok: false, reason: `unparseable commit time for ${ref}` };
}

/** Subject line of the tip commit (adopted sessions take their intent from it). */
export function tipSubject(cwd, ref) {
  const r = runGit(['log', '-1', '--format=%s', ref], cwd);
  return r.ok ? { ok: true, subject: r.stdout.trim() } : { ok: false, reason: r.reason };
}

/**
 * The remote's current OID for a full ref, asked of the REMOTE with `ls-remote`
 * against an explicit URL. Never falls back to a local remote-tracking ref —
 * that only moves on fetch, so it would answer a different question.
 *
 * `{ok:true, oid:null}` = reachable, ref absent. `{ok:false, reason}` = could
 * not ask.
 * @param {string} cwd
 * @param {string} urlOrRemote
 * @param {string} ref - full ref name
 */
export function remoteRefOid(cwd, urlOrRemote, ref) {
  const r = runGit(['ls-remote', urlOrRemote, ref], cwd, { timeoutMs: REMOTE_TIMEOUT_MS });
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, oid: parseLsRemote(r.stdout, ref) };
}

/**
 * Fetch and push URLs for a remote, as the manifest records them. More than one
 * push URL means a push is no longer one destination — surfaced, not hidden.
 * @returns {{ok: boolean, fetchUrl?: string, pushUrls?: string[], reason?: string}}
 */
export function resolveRemoteUrls(cwd, remote) {
  const f = runGit(['remote', 'get-url', remote], cwd);
  if (!f.ok) return { ok: false, reason: f.reason };
  const p = runGit(['remote', 'get-url', '--push', '--all', remote], cwd);
  if (!p.ok) return { ok: false, reason: p.reason };
  const pushUrls = p.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return { ok: true, fetchUrl: f.stdout.trim(), pushUrls };
}

/**
 * Base freshness via the repo's one oracle. `subject` is the local base,
 * `upstream` its remote-tracking counterpart; never fetches, so "behind" means
 * "since your last fetch".
 */
export function baseFreshness(cwd, { base, upstream }) {
  const f = resolveBaseFreshness({ subject: base, upstream, repoRoot: cwd });
  return block(f.state !== 'unknown', { freshness: f }, f.state === 'unknown' ? f.reason : undefined);
}
