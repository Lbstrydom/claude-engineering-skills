/**
 * @fileoverview The GATHERING half of `ship-commit.mjs --check-shipped-head`: the coordinator's merge-time re-check of an
 * already-shipped member (docs/plans/coordinator-aggregate-ship.md section 2.3). The decision is the pure
 * `evaluateShippedHead` (lib/ship-preauth.mjs); this module only gathers its facts, in the MEMBER'S OWN worktree, where the
 * two local markers it binds to (the gate evidence and the final-review marker) can honestly be read.
 *
 * **The child contract, v1.** Argv `--check-shipped-head --head <oid> [--json]`, cwd = the member worktree. Stdout is exactly one
 * JSON object `{schema:'shipped-head/v1', ok, head, runId, gate, conditions:[{id, ok, reason}], refusals}`. Exit 0 = ship-ok,
 * 2 = refused (or an argument the caller can correct), 1 = the checker itself errored. A caller treats exit 1, a timeout,
 * unparsable stdout, another schema, or a different `head` as REFUSED, never as a pass.
 *
 * **Read-only.** Nothing here writes the tree, the index, `.audit/` or the store; a coordinator running it can leave nothing
 * behind. It also never RAISES a gate: it reports the one the commit's own trailers carry.
 *
 * @module scripts/lib/ship-shipped-head
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sanitizeGitEnv } from './git-env-sanitize.mjs';
import { resolveEvidence, isContentVerifiable } from './commit-trailers.mjs';
import { readFinalReviewMarker } from './final-review-marker.mjs';
import {
  evaluateShippedHead, renderShippedHeadConditions, gatherChangedPaths, defaultBaseRef,
} from './ship-preauth.mjs';
import { assertKnownFlags, finishAndExit } from './cli-io.mjs';

export const SHIPPED_HEAD_SCHEMA = 'shipped-head/v1';
export const GIT_TIMEOUT_MS = 120_000;
export const LS_REMOTE_TIMEOUT_MS = 30_000;
const KNOWN_FLAGS = Object.freeze(['--check-shipped-head', '--head', '--base', '--remote', '--offline', '--json']);
/** The flags that take a value: an argument following one is its VALUE, never a mode switch. */
const VALUE_FLAGS = new Set(['--head', '--base', '--remote']);
/** git-check-ref-format's rules for a branch name (the value is an argv element, never a shell string, so `+` and the like are fine). */
export function isPlainBranch(n) {
  return typeof n === 'string' && n.length > 0 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(n) && !n.includes('..') && !n.includes('@{') && !n.includes('//')
    && !n.startsWith('-') && !n.startsWith('/') && !n.endsWith('/') && !n.endsWith('.') && !n.endsWith('.lock') && n !== '@';
}
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SHA_RE = /^[0-9a-f]{7,64}$/i;
/** The ONLY path /ship may add between the audit and the head: a new status entry file. Path-based; no content is ever parsed. */
export const SHIP_ENTRY_PATH_RE = /^docs\/status\/entries\/[^/]+\.md$/;
/** The one mode a ship-added entry may have: a regular, non-executable file (never a symlink 120000, a gitlink 160000, or a tree). */
export const SHIP_ENTRY_MODE = '100644';

/**
 * Is this invocation `--check-shipped-head`? The token counts only as a FLAG of the invocation: before any `--` terminator, and not as
 * the value of an option that takes one (`--message-file --check-shipped-head` names a file). `valueFlags` are the CALLER's own
 * value-taking options, so the dispatcher in ship-commit.mjs and this module agree on what a value is.
 * @param {string[]} argv `process.argv.slice(2)`
 * @param {Iterable<string>} [valueFlags]
 */
export function isShippedHeadMode(argv, valueFlags = []) {
  const values = new Set([...valueFlags, ...VALUE_FLAGS]);
  const end = argv.indexOf('--');
  const region = end < 0 ? argv : argv.slice(0, end);
  return region.some((a, k) => a === '--check-shipped-head' && !(k > 0 && values.has(region[k - 1])));
}

/** `git interpret-trailers --parse` output → `[{key, value}]` (split at the first colon). Pure. */
export function parseTrailerLines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '').map((l) => {
    const i = l.indexOf(':');
    return i < 0 ? { key: l.trim(), value: '' } : { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
  });
}

/**
 * `git diff --raw --no-renames -z` output → `[{status, rel, oldMode, newMode}]`. Pure. Each record is a header token
 * `:<oldmode> <newmode> <oldsha> <newsha> <status>` then the path token. A malformed stream (a token that is not a header, a header
 * with no path) is null: nothing is guessed, and a caller treats null as "nothing was checked".
 */
export function parseRawZ(out) {
  const tok = String(out ?? '').split('\0');
  if (tok.length && tok[tok.length - 1] === '') tok.pop();
  const rows = [];
  for (let i = 0; i < tok.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(tok[i] ?? '');
    if (!m || tok[i + 1] === undefined) return null;
    rows.push({ status: m[3], rel: tok[i + 1], oldMode: m[1], newMode: m[2] });
  }
  return rows;
}

/**
 * The git runner for one worktree: `(args, {input}) => {status, stdout, stderr}`. Arguments are an argv array (no shell), so a
 * path with metacharacters or a newline is just an argument. Large outputs are allowed: a name list can be long.
 */
export function makeRunner(cwd, { spawn = spawnSync, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  // The environment is sanitized: a GIT_DIR / GIT_WORK_TREE inherited from a hook or a parent process must never redirect this
  // check to another checkout. Every call is time-bounded; a timeout reads as a failed command (status null) with `timedOut` set.
  const env = sanitizeGitEnv(cwd);
  return (args, { input, timeout } = {}) => {
    const r = spawn('git', args, { cwd, env, encoding: 'utf-8', windowsHide: true, input, maxBuffer: 256 * 1024 * 1024, timeout: timeout ?? (args[0] === 'ls-remote' ? LS_REMOTE_TIMEOUT_MS : timeoutMs) });
    return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, timedOut: r.error?.code === 'ETIMEDOUT' };
  };
}

/**
 * The post-audit delta (C4): what differs between the AUDITED tree and the shipped head, over every path either the head or the
 * audited state changed against its own fork point, must be only what /ship writes. Measured on trees, never on the base, so a
 * plan the branch changed before its audit is judged like any other path, a change reverted to base after the audit is still
 * inspected, and an upstream-only change a rebase brought in (a path in neither set) is correctly ignored. No pathspecs are
 * used at all: the full name list is filtered in code, so a name with glob or magic characters can never be misread.
 *
 * @param {(args: string[], o?: object) => {status: number|null, stdout: string}} run
 * @param {{auditedTree?: string|null, auditedSha?: string|null}|null} evidence
 * @param {string[]|null} headChanged the paths the head changes against its fork point (null = unmeasured)
 * @param {string|null} headTree the head's tree id, resolved ONCE from the checked head (never re-read from HEAD)
 * @param {string|null} [baseBranch] the branch the PR targets (default: `origin/HEAD`'s)
 * @returns {{ok: boolean, reason: string}}
 */
export function computePostAuditDelta(run, evidence, headChanged, headTree, baseBranch = null, remote = 'origin') {
  const no = (reason) => ({ ok: false, reason });
  const out = (args) => { const r = run(args); return r.status === 0 ? String(r.stdout).trim() : null; };
  if (!evidence) return no('no gate-evidence marker, so the audited tree is unknown');
  const A = evidence.auditedTree;
  if (!A) return no('audited-tree-missing: the evidence marker records no audited tree');
  if (out(['cat-file', '-t', `${A}^{tree}`]) !== 'tree') return no(`audited-tree-missing: tree ${String(A).slice(0, 12)} is not in this repository (collected, or never created here)`);
  const sha = evidence.auditedSha;
  if (!sha || out(['cat-file', '-t', `${sha}^{commit}`]) !== 'commit') return no('audited-sha-missing: the audited commit is unknown or not in this repository, so the audit\'s own fork point cannot be found');
  if (!Array.isArray(headChanged)) return no('the head\'s change set could not be resolved, so nothing was checked');
  const base = defaultBaseRef((a) => run(a), baseBranch, remote);
  const fork = out(['merge-base', sha, base]);
  if (!fork) return no(`the audited commit's fork point against ${base} could not be resolved`);
  const pa = run(['diff', '--name-only', '--no-renames', '--ignore-submodules=none', '-z', fork, A]);
  if (pa.status !== 0) return no('the audited tree could not be diffed against its fork point');
  const candidate = new Set([...headChanged, ...String(pa.stdout).split('\0').filter(Boolean)]);
  if (!headTree) return no('the head tree could not be resolved');
  // `--ignore-submodules=none`: a repository's `diff.ignoreSubmodules` / `.gitmodules` setting must never hide a changed gitlink.
  const d = run(['diff', '--raw', '--no-renames', '--ignore-submodules=none', '-z', A, headTree]);
  if (d.status !== 0) return no('the audited tree could not be diffed against the head');
  const rows = parseRawZ(d.stdout);
  if (rows === null) return no('the raw diff output was malformed, so nothing was checked');
  const refused = [];
  let judged = 0;
  for (const { status, rel, newMode } of rows) {
    if (!candidate.has(rel)) continue; // an upstream-only path (a rebase): not this member's change
    judged++;
    const why = shipEntryRefusal({ status, rel, newMode });
    if (why) refused.push(`${rel}: ${why}`);
  }
  if (refused.length) return no(`${refused.length} path(s) changed since the audit that /ship does not write: ${refused.slice(0, 3).join('; ')}${refused.length > 3 ? `; +${refused.length - 3} more` : ''}`);
  return { ok: true, reason: judged === 0 ? 'the head tree equals the audited tree on every path the branch touches' : `${judged} path(s) differ from the audited tree, each a newly added status entry` };
}

/**
 * Why this changed path is not something /ship writes, or null. PATH-ONLY by design: the single permitted change is an ADDED
 * regular file `docs/status/entries/<name>.md`. Content is never read, because a brand-new file cannot rewrite audited content
 * (it is a separate file the audited tree did not contain), so there is nothing in it to verify against the audit.
 * A modification, deletion, rename or type change anywhere, a plan edit and a status.md edit all refuse.
 */
export function shipEntryRefusal({ status, rel, newMode }) {
  if (!SHIP_ENTRY_PATH_RE.test(rel)) return `changed since the audit, and only a NEW docs/status/entries/*.md file may be (status ${status})`;
  if (status !== 'A') return `an existing status entry was changed (status ${status}); only ADDING one is allowed`;
  if (newMode !== SHIP_ENTRY_MODE) return `the added entry has mode ${newMode}, not a regular file (${SHIP_ENTRY_MODE})`;
  return null;
}

/**
 * The default store adapter, loaded lazily so a checkout with the store off still runs the whole check and refuses with a reason.
 * @returns {{runFacts: (runId: string) => Promise<object>, repoId: (cwd: string) => Promise<object>}}
 */
export function createStoreAdapter() {
  return {
    async runFacts(runId) {
      try { const m = await import('./store/ship-run-facts.mjs'); return await m.getShipRunFacts(runId); } catch (e) { return { row: null, why: `the store modules could not be loaded (${e?.code || e?.message || 'error'})` }; }
    },
    async repoId(cwd) {
      try { const m = await import('./store/ship-run-facts.mjs'); return await m.getShipRepoId(cwd); } catch (e) { return { repoId: null, why: `the store modules could not be loaded (${e?.code || e?.message || 'error'})` }; }
    },
  };
}

/**
 * Gather every fact and evaluate. Never throws: any failure to read a fact becomes that fact's refusal.
 *
 * @param {{repoRoot: string, head: string, run?: Function, store?: ReturnType<typeof createStoreAdapter>}} o
 * @returns {Promise<{schema: string, ok: boolean, head: string, runId: string|null, gate: string|null, conditions: object[], refusals: string[]}>}
 */
export async function checkShippedHead({ repoRoot, head, baseBranch = null, remote = 'origin', verifyBase = true, run = makeRunner(repoRoot), store = createStoreAdapter() }) {
  const envelope = (v, headOid) => ({ schema: SHIPPED_HEAD_SCHEMA, ok: v.ok, head: headOid, runId: v.runId ?? null, gate: v.gate ?? null, conditions: v.conditions, refusals: v.refusals });
  const pre = (id, reason) => ({ ok: false, runId: null, gate: null, conditions: [{ id, ok: false, reason }], refusals: [`${id}: ${reason}`] });

  const resolved = run(['rev-parse', '--verify', '--quiet', `${head}^{commit}`]);
  const headOid = resolved.status === 0 ? String(resolved.stdout).trim() : null;
  if (!headOid) return envelope(pre('head', `${head} is not a commit in this repository`), head);
  const checkedOut = run(['rev-parse', '--verify', 'HEAD']);
  if (checkedOut.status !== 0 || String(checkedOut.stdout).trim() !== headOid) {
    return envelope(pre('head', `the member worktree has ${String(checkedOut.stdout).trim().slice(0, 12) || 'no HEAD'} checked out, not ${headOid.slice(0, 12)}: the local evidence markers belong to the checked-out head`), headOid);
  }
  // The change is measured against a LOCAL remote-tracking ref, so by DEFAULT that ref must equal the live branch on the remote, or
  // the "change" it measures is whatever a stale fetch left behind. Unreadable (or timed out) is a refusal, never a pass. The caller
  // can opt out (`--offline`), and then says so: the envelope carries `baseVerified: false`. With no `--base` the branch is the one
  // `<remote>/HEAD` names; if that cannot be determined the check refuses and asks for `--base`.
  let baseRefName = baseBranch;
  if (verifyBase && !baseRefName) {
    const sym = run(['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`]);
    const full = sym.status === 0 ? String(sym.stdout).trim() : '';
    baseRefName = full.startsWith(`refs/remotes/${remote}/`) ? full.slice(`refs/remotes/${remote}/`.length) : null;
    if (!baseRefName) return envelope(pre('base', `the default branch of ${remote} could not be determined (no refs/remotes/${remote}/HEAD): pass --base <branch>, or --offline to measure against whatever is local`), headOid);
  }
  let baseOidAtStart = null;
  if (verifyBase) {
    const live = run(['ls-remote', remote, `refs/heads/${baseRefName}`]);
    const liveOid = live.status === 0 ? String(live.stdout).trim().split(/\s+/)[0] : '';
    const local = run(['rev-parse', '--verify', `refs/remotes/${remote}/${baseRefName}`]);
    const localOid = local.status === 0 ? String(local.stdout).trim() : '';
    if (!/^[0-9a-f]{40,64}$/.test(liveOid)) return envelope(pre('base', `the live ${remote}/${baseRefName} could not be read${live.timedOut ? ' (timed out)' : ''}, so the change cannot be measured against it`), headOid);
    if (localOid !== liveOid) return envelope(pre('base', `refs/remotes/${remote}/${baseRefName} is ${localOid.slice(0, 12) || 'absent'} but the live branch is ${liveOid.slice(0, 12)}: fetch first, then re-check`), headOid);
    baseOidAtStart = localOid;
  }
  // Resolved ONCE, from the verified oid: nothing below reads HEAD again, so a worktree that switches commits mid-check cannot
  // make the facts describe two different heads.
  const treeRes = run(['rev-parse', '--verify', `${headOid}^{tree}`]);
  const headTree = treeRes.status === 0 ? String(treeRes.stdout).trim() : null;

  const msg = run(['log', '-1', '--format=%B', headOid]);
  let trailers = null;
  if (msg.status === 0) {
    const t = run(['interpret-trailers', '--parse'], { input: msg.stdout });
    if (t.status === 0) trailers = parseTrailerLines(t.stdout);
  }

  const ts = run(['log', '-1', '--format=%ct', headOid]);
  const evidence = resolveEvidence({
    auditRunPath: path.join(repoRoot, '.audit', 'last-audit-run.json'),
    headCommitTs: ts.status === 0 ? Number(String(ts.stdout).trim()) || 0 : 0,
    noRunId: false,
  });
  const verifiable = isContentVerifiable(evidence);
  const branchRes = run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const currentBranch = branchRes.status === 0 ? String(branchRes.stdout).trim() : null;

  const runRes = verifiable ? await store.runFacts(evidence.runId) : { row: null, why: `there is no usable gate-evidence marker (state: ${evidence.state})` };
  const repoRes = await store.repoId(repoRoot);
  const changedPaths = headTree ? gatherChangedPaths((a) => run(a), headTree, headOid, baseRefName, remote) : null;
  const usable = verifiable ? evidence : null;

  const verdict = evaluateShippedHead({
    trailers,
    evidence: usable,
    evidenceWhy: verifiable ? undefined : `state: ${evidence.state}`,
    currentBranch,
    runRow: runRes.row,
    runRowWhy: runRes.why ?? undefined,
    repoId: repoRes.repoId,
    finalReview: readFinalReviewMarker(repoRoot),
    delta: computePostAuditDelta(run, usable, changedPaths, headTree, baseRefName, remote),
    changedPaths,
  });
  // The markers and the store were read over time: if HEAD moved while they were, none of it describes the head that was asked about.
  const after = run(['rev-parse', '--verify', 'HEAD']);
  if (after.status !== 0 || String(after.stdout).trim() !== headOid) return envelope(pre('head', 'HEAD moved while the check was running: nothing it read can be trusted'), headOid);
  // ...and so is the base ref the change was measured against: it was verified once, so it must still be what it was.
  if (baseOidAtStart) {
    const again = run(['rev-parse', '--verify', `refs/remotes/${remote}/${baseRefName}`]);
    if (again.status !== 0 || String(again.stdout).trim() !== baseOidAtStart) return envelope(pre('base', `refs/remotes/${remote}/${baseRefName} moved while the check was running: the change was measured against two different bases`), headOid);
    // the LIVE branch too: a force-push to the remote during the store reads leaves the local ref untouched
    const liveAgain = run(['ls-remote', remote, `refs/heads/${baseRefName}`]);
    if (liveAgain.status !== 0 || String(liveAgain.stdout).trim().split(/\s+/)[0] !== baseOidAtStart) return envelope(pre('base', `the live ${remote}/${baseRefName} changed (or could not be re-read) while the check was running`), headOid);
  }
  return { ...envelope(verdict, headOid), baseVerified: verifyBase };
}

/**
 * The CLI half: parse argv, run the check in the cwd's worktree, print, exit. `argv` is `process.argv.slice(2)`.
 * Exits 0 (ship-ok), 2 (refused / a correctable argument) or 1 (the checker errored); stdout is drained before exiting.
 */
export async function runShippedHeadCli(argv, { cwd = process.cwd(), store } = {}) {
  const json = argv.includes('--json');
  const i = argv.indexOf('--head');
  const head = i >= 0 ? argv[i + 1] : undefined;
  const bi = argv.indexOf('--base');
  const baseBranch = bi >= 0 ? argv[bi + 1] : null;
  const ri = argv.indexOf('--remote');
  const remote = ri >= 0 ? argv[ri + 1] : 'origin';
  const verifyBase = !argv.includes('--offline');
  const valueOf = (k) => (i >= 0 && k === i + 1) || (bi >= 0 && k === bi + 1) || (ri >= 0 && k === ri + 1);
  const others = argv.filter((a, k) => a !== '--check-shipped-head' && a !== '--json' && a !== '--head' && a !== '--base' && a !== '--remote' && a !== '--offline' && !valueOf(k));
  const bad = (reason) => {
    if (json) process.stdout.write(`${JSON.stringify({ schema: SHIPPED_HEAD_SCHEMA, ok: false, head: head ?? null, runId: null, gate: null, conditions: [{ id: 'args', ok: false, reason }], refusals: [`args: ${reason}`] })}\n`);
    process.stderr.write(`AGENT FIX: --check-shipped-head: ${reason}. Usage: --check-shipped-head --head <oid> [--json], alone, from the member's worktree.\n`);
    return finishAndExit(2);
  };
  // An unknown flag is refused by NAME before anything runs: a read-only check must never silently ignore what was asked of it.
  try { assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'ship-commit --check-shipped-head', from: 0 }); } catch (e) { return bad(`${e.message.split('. ')[0]}; a standalone read-only check cannot be combined with other flags`); }
  if (head === undefined || head.startsWith('--') || !SHA_RE.test(head)) return bad('--head needs a commit oid');
  if (ri >= 0 && (remote === undefined || remote.startsWith('--') || !REMOTE_RE.test(remote))) return bad('--remote needs a plain remote name');
  if (bi >= 0 && (baseBranch === undefined || baseBranch.startsWith('--') || !isPlainBranch(baseBranch))) return bad('--base needs a valid branch name');
  if (others.length > 0) return bad(`a standalone read-only check cannot be combined with ${others.join(' ')}`);
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, env: sanitizeGitEnv(cwd), encoding: 'utf-8', windowsHide: true, timeout: GIT_TIMEOUT_MS });
  if (top.error || top.status !== 0) { process.stderr.write(`ship-commit: --check-shipped-head: not a git worktree (${(top.stderr || '').trim() || 'git failed'})\n`); return finishAndExit(1); }
  const repoRoot = String(top.stdout).trim();
  let env;
  try { env = await checkShippedHead({ repoRoot, head, baseBranch, remote, verifyBase, store }); } catch (e) {
    process.stderr.write(`ship-commit: --check-shipped-head errored: ${e?.message ?? e}\n`);
    return finishAndExit(1);
  }
  if (json) process.stdout.write(`${JSON.stringify(env)}\n`);
  else process.stdout.write(`${[...renderShippedHeadConditions(env), `ship-commit: shipped head ${env.head.slice(0, 12)} ${env.ok ? 'SHIP-OK' : 'NEEDS-USER'}`].join('\n')}\n`);
  return finishAndExit(env.ok ? 0 : 2);
}
