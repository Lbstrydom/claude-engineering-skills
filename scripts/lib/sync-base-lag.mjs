/**
 * @fileoverview Is the consumer checkout the sync is about to write into behind its origin? Asked BEFORE the first write.
 *
 * `npm run sync` writes into a consumer's main checkout, and coordinators merge the sync PRs on GitHub while nobody pulls that
 * checkout, so it always lags (2026-10-24: storyline 17 commits behind, wine 46). Only `sync:pr` noticed, AFTER the write, with a
 * `stale-base-collision` whose remedy was "discard the synced changes, `git pull --ff-only`, re-run the sync" - every sync paid that
 * by hand (fleet p-...-2753). The lag is asked once, up front, with the SAME predicate `sync:pr` uses (`classifyBaseLag`,
 * below; lib/sync-pr.mjs re-exports it), and answered with one of:
 *
 *  - current / not on the base branch  -> proceed (silent: nothing to say)
 *  - could not be checked (no origin, offline, ...) -> proceed, SAID loudly: an unasked question is not a clean answer
 *  - behind, and the checkout is clean apart from files the sync itself wrote -> fast-forward it. The files the sync wrote are
 *    provenance-proved by `classifyRepo` (ownership AND content hash) and this very run rewrites them, so restoring them to HEAD
 *    first loses nothing; they are what stops `git merge --ff-only` (the receipt changes on every landed sync).
 *  - behind with anything else dirty, or diverged (local commits origin lacks), or the fast-forward itself failing -> REFUSE the
 *    consumer, naming the exact remedy. `--allow-stale-base` accepts the stale base on purpose (and says so): `sync:pr` still
 *    refuses a stale base whose paths collided.
 *
 * Pure planning (`planBaseLag`) plus an executor (`enforceBaseLag`) whose every process call goes through an injected `run`, so the
 * sequence - including the failure branches - is tested without a network.
 *
 * @module scripts/lib/sync-base-lag
 */
import { spawnSync } from 'node:child_process';

/** @typedef {(cmd: string, args: string[], opts?: {cwd?: string, input?: string, timeoutMs?: number, env?: Record<string, string>}) => {status: number|null, stdout: string, stderr: string, error?: Error}} Runner */

/**
 * The remote's default branch from `git ls-remote --symref origin HEAD`
 * (`ref: refs/heads/<name>	HEAD`). PURE.
 * @param {string} text
 * @returns {string|null}
 */
export function parseSymrefHead(text) {
  const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD\s*$/m.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/**
 * Where a consumer checkout stands against its freshly fetched base branch. THE stale-base predicate: `planConsumerPr` asks it
 * after the sync has written (is the PR's base honest?) and the sync asks it BEFORE writing (`lib/sync-base-lag.mjs`), so the two
 * cannot disagree about what "behind" means. PURE.
 *
 *  - `unknown`  a count or the base sha is missing: nothing was compared (never read as current)
 *  - `off-base` not on the base branch: lag against it says nothing about this checkout
 *  - `diverged` behind AND ahead: not fast-forwardable
 *  - `behind`   origin has commits this checkout lacks, and it has none origin lacks
 *  - `current`  not behind (ahead-only is not lag; `planConsumerPr` refuses it separately as `local-commits-ahead`)
 *
 * @param {{baseBranch: string, baseSha: string|null|undefined, currentBranch: string|null, aheadCount: number|null, behindCount: number|null}} f
 * @returns {'unknown'|'off-base'|'diverged'|'behind'|'current'}
 */
export function classifyBaseLag({ baseBranch, baseSha, currentBranch, aheadCount, behindCount }) {
  if (typeof baseSha !== 'string' || !baseSha || !Number.isInteger(aheadCount) || !Number.isInteger(behindCount)) return 'unknown';
  if (currentBranch !== baseBranch) return 'off-base';
  if (behindCount > 0) return aheadCount > 0 ? 'diverged' : 'behind';
  return 'current';
}

/**
 * The real process runner. Shared by `sync-pr.mjs` and `sync-to-repos.mjs` (the pre-write base-lag check) so the two ask git the
 * same way. A consumer's pre-push hook can run its whole test suite, so by default there is no timeout; network fact-gathering passes
 * `timeoutMs` (a stalled `ls-remote` / `fetch` must end in an ordinary failure, not hang the sync) and `env`.
 * @type {Runner}
 */
export function spawnRunner(cmd, args, { cwd, input, timeoutMs, env } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, input, encoding: 'utf-8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    // SIGKILL, not spawnSync's default SIGTERM: a process that ignores SIGTERM would otherwise outlive its own bound.
    ...(timeoutMs > 0 ? { timeout: timeoutMs, killSignal: 'SIGKILL' } : {}), ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/** @param {{status:number|null, error?:Error}} r */
export const ok = (r) => !r.error && r.status === 0;
/** @param {{stdout:string, stderr:string, error?:Error, status:number|null}} r */
export const why = (r) => (r.error?.message || `${r.stderr || ''}${r.stdout || ''}`.trim() || `exit ${r.status}`);

/**
 * The lag half of `gatherConsumerFacts` (lib/sync-pr.mjs), on its own: the freshly fetched base and where this checkout stands against it.
 * Also what the sync asks BEFORE writing (`lib/sync-base-lag.mjs`): it needs no branch or path facts, and must not pay a second
 * `ls-remote` for them.
 *
 * @param {Runner} run
 * @param {string} repoRoot
 * @param {{baseBranch?: string|null}} [opts]
 * @returns {{ok: false, step: string, error: string}
 *   | {ok: true, baseBranch: string, baseSha: string, currentBranch: string|null, aheadCount: number|null, behindCount: number|null}}
 */
export function gatherBaseFacts(run, repoRoot, { baseBranch = null } = {}) {
  const git = (args) => run('git', ['-C', repoRoot, ...args]);
  let base = baseBranch;
  if (!base) {
    const symref = git(['ls-remote', '--symref', 'origin', 'HEAD']);
    base = ok(symref) ? parseSymrefHead(symref.stdout) : null;
    if (!base) {
      return { ok: false, step: 'resolve default branch', error: ok(symref) ? 'origin advertises no HEAD symref — pass --base' : why(symref) };
    }
  }
  const fetched = git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
  if (!ok(fetched)) return { ok: false, step: `fetch origin ${base}`, error: why(fetched) };
  const resolved = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}^{commit}`]);
  const baseSha = ok(resolved) ? resolved.stdout.trim() : '';
  if (!/^[0-9a-f]{40,64}$/.test(baseSha)) return { ok: false, step: `resolve origin/${base}`, error: why(resolved) };

  const head = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const currentBranch = ok(head) ? head.stdout.trim() : null;
  const count = (range) => {
    const r = git(['rev-list', '--count', range]);
    return ok(r) && /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : null;
  };
  const aheadCount = count(`${baseSha}..HEAD`);
  const behindCount = count(`HEAD..${baseSha}`);
  return { ok: true, baseBranch: base, baseSha, currentBranch, aheadCount, behindCount };
}


/** Shown in a refusal's file list; the rest is "and N more". */
const LIST_MAX = 5;

const q = (p) => `"${String(p).replace(/"/g, '\\"')}"`;
const list = (paths) => `${paths.slice(0, LIST_MAX).join(', ')}${paths.length > LIST_MAX ? `, and ${paths.length - LIST_MAX} more` : ''}`;
/** Modified/added/deleted in place: restorable from HEAD by path. Renames and untracked files are left for `merge --ff-only` to judge. */
const restorable = (e) => !e.origPath && e.status !== '??' && !/[RC]/.test(e.status);

/**
 * @typedef {{action: 'proceed'}
 *   | {action: 'unchecked', detail: string}
 *   | {action: 'proceed-stale', detail: string}
 *   | {action: 'fast-forward', discard: string[], behindCount: number}
 *   | {action: 'refuse', reason: 'dirty'|'diverged'|'unreadable-status', detail: string, remedy: string}} BaseLagPlan
 */

/**
 * @param {{
 *   repoRoot: string, baseBranch: string, lag: ReturnType<typeof classifyBaseLag>, behindCount: number|null, aheadCount: number|null,
 *   classified: ReturnType<typeof import('../sync-status.mjs').classifyRepo>|null, allowStale?: boolean, why?: string|null,
 * }} input `classified` is only read for a checkout that is behind
 * @returns {BaseLagPlan}
 */
export function planBaseLag({ repoRoot, baseBranch, lag, behindCount, aheadCount, classified, allowStale = false, why = null }) {
  if (lag === 'current' || lag === 'off-base') return { action: 'proceed' };
  if (lag === 'unknown') return { action: 'unchecked', detail: why ?? 'the base could not be compared' };
  const origin = `origin/${baseBranch}`;
  if (lag === 'diverged') {
    const detail = `${repoRoot} is ${behindCount} commit(s) behind ${origin} AND ${aheadCount} commit(s) ahead of it, so it cannot be fast-forwarded`;
    if (allowStale) return { action: 'proceed-stale', detail };
    return {
      action: 'refuse', reason: 'diverged', detail,
      remedy: `push or rebase its local commits first: git -C ${q(repoRoot)} log ${origin}..HEAD, then git -C ${q(repoRoot)} pull --rebase; re-run the sync afterwards`,
    };
  }
  // behind
  const detail = `${repoRoot} is ${behindCount} commit(s) behind ${origin}`;
  if (allowStale) return { action: 'proceed-stale', detail };
  if (!classified || !classified.ok) {
    return { action: 'refuse', reason: 'unreadable-status', detail: `${detail}, and its working tree could not be read (${classified?.error ?? 'no classification'})`, remedy: `fix git status in ${q(repoRoot)}, then git -C ${q(repoRoot)} pull --ff-only; re-run the sync` };
  }
  const own = [...classified.needsReview, ...classified.other];
  if (classified.degraded || own.length > 0) {
    const what = classified.degraded
      ? 'its ownership could not be established, so none of its changes can be shown to be sync output'
      : `it holds changes that are not sync output: ${list(own.map((e) => e.path))}`;
    return {
      action: 'refuse', reason: 'dirty', detail: `${detail}, and ${what}`,
      remedy: `commit or stash those changes, then git -C ${q(repoRoot)} pull --ff-only, then re-run the sync (or --allow-stale-base to write onto the stale base on purpose)`,
    };
  }
  return { action: 'fast-forward', discard: classified.syncOwned.filter(restorable).map((e) => e.path), behindCount };
}

/**
 * Check one consumer's base lag and, where it is safe, fix it. Never throws: every failure is a refusal or a loud "unchecked".
 *
 * @param {{
 *   repoRoot: string, run: Runner, classify: (repoRoot: string) => ReturnType<typeof import('../sync-status.mjs').classifyRepo>,
 *   dryRun?: boolean, allowStale?: boolean,
 * }} input
 * @returns {{ok: boolean, outcome: 'current'|'unchecked'|'stale-accepted'|'fast-forwarded'|'would-fast-forward'|'refused', lines: string[]}}
 */
export function enforceBaseLag({ repoRoot, run, classify, dryRun = false, allowStale = false }) {
  const git = (args) => run('git', ['-C', repoRoot, ...args]);
  const facts = gatherBaseFacts(run, repoRoot);
  if (!facts.ok) {
    return { ok: true, outcome: 'unchecked', lines: [`base lag NOT CHECKED (${facts.step}: ${facts.error.split('\n')[0]}) - writing without knowing whether this checkout is behind origin`] };
  }
  const lag = classifyBaseLag(facts);
  let classified = null;
  if (lag === 'behind' && !allowStale) {
    try { classified = classify(repoRoot); } catch (e) { classified = { ok: false, error: e?.message || 'classification threw' }; }
  }
  const plan = planBaseLag({ repoRoot, baseBranch: facts.baseBranch, lag, behindCount: facts.behindCount, aheadCount: facts.aheadCount, classified, allowStale });
  switch (plan.action) {
    case 'proceed': return { ok: true, outcome: 'current', lines: [] };
    case 'unchecked': return { ok: true, outcome: 'unchecked', lines: [`base lag NOT CHECKED (${plan.detail})`] };
    case 'proceed-stale': return { ok: true, outcome: 'stale-accepted', lines: [`stale base ACCEPTED (--allow-stale-base): ${plan.detail}; sync:pr will still refuse it if origin changed a path this sync writes`] };
    case 'refuse': return { ok: false, outcome: 'refused', lines: [`REFUSED: ${plan.detail}.`, `remedy: ${plan.remedy}`] };
    default: break;
  }
  const target = `origin/${facts.baseBranch}`;
  const note = plan.discard.length > 0 ? `restore ${plan.discard.length} sync-written file(s) to HEAD (this sync rewrites them), then ` : '';
  if (dryRun) return { ok: true, outcome: 'would-fast-forward', lines: [`would ${note}fast-forward ${plan.behindCount} commit(s) to ${target} (dry run: nothing changed)`] };
  // The restore is the only destructive step, so it is made RECOVERABLE first: `git stash create` writes a commit of the tracked
  // changes (index and worktree) WITHOUT touching refs or the tree, and a failed fast-forward re-applies it. If the snapshot cannot
  // be taken, nothing is restored and the consumer is refused.
  let snapshot = null;
  if (plan.discard.length > 0) {
    const snap = git(['stash', 'create']);
    if (snap.error || snap.status !== 0) return refusedFastForward(repoRoot, target, `could not snapshot the sync-written files before restoring them (${firstLine(snap)}); nothing was changed`);
    snapshot = snap.stdout.trim() || null;
    const restored = git(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...plan.discard]);
    if (restored.error || restored.status !== 0) return failedAfterRestore(git, repoRoot, target, snapshot, `could not restore the sync-written files (${firstLine(restored)})`);
  }
  const merged = git(['merge', '--ff-only', '--quiet', facts.baseSha]);
  if (merged.error || merged.status !== 0) return failedAfterRestore(git, repoRoot, target, snapshot, firstLine(merged));
  return { ok: true, outcome: 'fast-forwarded', lines: [`fast-forwarded ${plan.behindCount} commit(s) to ${target} ${facts.baseSha.slice(0, 8)}${plan.discard.length > 0 ? ` (restored ${plan.discard.length} sync-written file(s) first; this sync rewrites them${snapshot ? `; snapshot ${snapshot.slice(0, 8)} kept until git gc` : ''})` : ''}`] };
}

const firstLine = (r) => (r.error?.message || `${r.stderr || ''}${r.stdout || ''}`.trim() || `exit ${r.status}`).split('\n')[0];

/** A step after the restore failed: put the sync-written changes back, and say whether that worked. */
function failedAfterRestore(git, repoRoot, target, snapshot, because) {
  let recovery = '';
  if (snapshot) {
    const back = git(['stash', 'apply', '--index', '--quiet', snapshot]);
    recovery = back.error || back.status !== 0
      ? ` The sync-written changes could NOT be re-applied automatically (${firstLine(back)}); they are in commit ${snapshot}: git -C ${q(repoRoot)} stash apply --index ${snapshot}.`
      : ' The sync-written changes were put back as they were.';
  }
  return refusedFastForward(repoRoot, target, because, recovery);
}

function refusedFastForward(repoRoot, target, because, recovery = '') {
  return {
    ok: false, outcome: 'refused',
    lines: [`REFUSED: the fast-forward to ${target} failed in ${repoRoot} (${because}).${recovery}`, `remedy: git -C ${q(repoRoot)} status, resolve what it shows, then git -C ${q(repoRoot)} pull --ff-only and re-run the sync`],
  };
}

/** One git call (ls-remote, fetch, merge, ...) outliving this is a failure, which the lag check reads as "not checked"/"refused". */
const REMOTE_CALL_MS = 60_000;
const C = { R: '\x1b[31m', Y: '\x1b[33m', G: '\x1b[32m', D: '\x1b[2m', X: '\x1b[0m' };

/**
 * The sync's one call: check (and where safe fix) one consumer's base lag and PRINT the result. `false` = refuse this consumer.
 * `classifyRepo` is the one provenance pipeline `sync:pr` uses; it lives in a CLI module, so it is loaded only when a checkout is
 * actually behind (the rare case), never on the way to "current".
 *
 * @param {{name: string, path: string}} repo
 * @param {{dryRun?: boolean, allowStale?: boolean, run?: Runner, classify?: Function, write?: (line: string) => void}} [opts]
 * @returns {Promise<boolean>}
 */
export async function enforceBaseLagForTarget(repo, { dryRun = false, allowStale = false, run, classify, write = (l) => console.log(l) } = {}) {
  // Every git call here is local or one short network round trip: bound it, and never let git prompt for credentials in a sync.
  const runner = run ?? ((cmd, args, o) => spawnRunner(cmd, args, { ...o, timeoutMs: REMOTE_CALL_MS, env: { GIT_TERMINAL_PROMPT: '0' } }));
  let classifier = classify;
  if (!classifier) {
    const { classifyRepo } = await import('../sync-status.mjs');
    classifier = classifyRepo;
  }
  const r = enforceBaseLag({ repoRoot: repo.path, run: runner, classify: classifier, dryRun, allowStale });
  const colour = r.ok ? (r.outcome === 'current' ? C.D : r.outcome === 'fast-forwarded' || r.outcome === 'would-fast-forward' ? C.G : C.Y) : C.R;
  for (const line of r.lines) write(`  ${colour}base-lag${C.X} ${line}`);
  return r.ok;
}
