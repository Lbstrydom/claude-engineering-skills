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
 *    provenance-proved by `classifyRepo` (ownership AND content hash), so restoring one to HEAD first loses nothing; those the
 *    fast-forward CHANGES are what stops `git merge --ff-only` (the receipt changes on every landed sync). ONLY those are restored:
 *    git accepts a dirty path the fast-forward does not touch, and restoring it anyway put its bytes out of step with the manifest
 *    base, so the divergence gate refused it `diverged-committed` on every later sync (storyline, 2026-11-18;
 *    docs/plans/sync-refused-manifest-base.md). Which paths the fast-forward changes could not be read -> REFUSE, never "restore all".
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
import { isManagedBlockFile } from './sync-path-map.mjs';

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
 * The paths a fast-forward from `headSha` to `baseSha` CHANGES, from `git diff --name-only -z --no-renames`'s stdout. PURE.
 *
 * Complete or nothing: the list is NUL-TERMINATED, so a non-empty answer that does not end in NUL was cut short, and a name that
 * decoded lossily (U+FFFD: two byte-distinct names can decode to one string) could stand for a path it is not. Either returns
 * `null`, which `planBaseLag` reads as "do not know" and refuses, never as "no paths" (an empty list is `new Set()`).
 *
 * @param {string} stdout
 * @returns {Set<string>|null}
 */
export function parseNameOnlyZ(stdout) {
  const text = String(stdout ?? '');
  if (text === '') return new Set();
  if (!text.endsWith('\0')) return null;
  const names = text.slice(0, -1).split('\0');
  if (names.some((n) => n === '' || n.includes('\uFFFD'))) return null;
  return new Set(names);
}

/**
 * What the fast-forward from `headSha` (pinned by `gatherBaseFacts`, BEFORE the lag was measured) to `baseSha` would change: both
 * ends are object ids, so the plan and the merge (`merge --ff-only <baseSha>`) speak about the same two commits. `paths: null` =
 * could not be established.
 * @param {Runner} run
 * @param {string} repoRoot
 * @param {string|null} headSha
 * @param {string} baseSha
 * @returns {{headSha: string|null, paths: Set<string>|null, error: string|null}}
 */
export function gatherFastForwardChanges(run, repoRoot, headSha, baseSha) {
  const git = (args) => run('git', ['-C', repoRoot, ...args]);
  if (!/^[0-9a-f]{40,64}$/.test(String(headSha ?? ''))) return { headSha: null, paths: null, error: 'HEAD could not be pinned to a commit' };
  const diff = git(['diff', '--name-only', '-z', '--no-renames', headSha, baseSha]);
  if (!ok(diff)) return { headSha, paths: null, error: `git diff ${headSha.slice(0, 8)}..${baseSha.slice(0, 8)}: ${why(diff)}` };
  const paths = parseNameOnlyZ(diff.stdout);
  return { headSha, paths, error: paths ? null : 'the changed-path list was incomplete or held a path that did not decode cleanly' };
}

/**
 * The lag half of `gatherConsumerFacts` (lib/sync-pr.mjs), on its own: the freshly fetched base and where this checkout stands against it.
 * Also what the sync asks BEFORE writing (`lib/sync-base-lag.mjs`): it needs no branch or path facts, and must not pay a second
 * `ls-remote` for them.
 *
 * @param {Runner} run
 * @param {string} repoRoot
 * @param {{baseBranch?: string|null}} [opts]
 * @returns {{ok: false, step: string, error: string}
 *   | {ok: true, baseBranch: string, baseSha: string, headSha: string|null, currentBranch: string|null, aheadCount: number|null, behindCount: number|null}}
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

  // HEAD is pinned to an oid FIRST and every count below is taken against it, so the lag verdict, the changed-path list and the
  // executor's identity recheck all speak about ONE commit (a HEAD that moves mid-gather is refused, never half-measured).
  const headResolved = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const headSha = ok(headResolved) && /^[0-9a-f]{40,64}$/.test(headResolved.stdout.trim()) ? headResolved.stdout.trim() : null;
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const currentBranch = ok(head) ? head.stdout.trim() : null;
  const count = (range) => {
    const r = git(['rev-list', '--count', range]);
    return ok(r) && /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : null;
  };
  const aheadCount = headSha ? count(`${baseSha}..${headSha}`) : null;
  const behindCount = headSha ? count(`${headSha}..${baseSha}`) : null;
  return { ok: true, baseBranch: base, baseSha, headSha, currentBranch, aheadCount, behindCount };
}


/** Shown in a refusal's file list; the rest is "and N more". */
const LIST_MAX = 5;

/** A repository filename as a LITERAL pathspec: `a[1].md` must not also match `a1.md` (code audit R3 H1). */
const lit = (p) => `:(literal)${p}`;
/** POSIX single-quoting, so a recovery command pasted into a shell sees each path as exactly one argument (code audit R4). */
const sq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
const q = (p) => `"${String(p).replace(/"/g, '\\"')}"`;
const list = (paths) => `${paths.slice(0, LIST_MAX).join(', ')}${paths.length > LIST_MAX ? `, and ${paths.length - LIST_MAX} more` : ''}`;
/** Tracked in-place changes are restorable from HEAD by path. Untracked files are left for `merge --ff-only` to judge (renames never get here: see planBaseLag). */
const restorable = (e) => e.status !== '??';

/**
 * @typedef {{action: 'proceed'}
 *   | {action: 'unchecked', detail: string}
 *   | {action: 'proceed-stale', detail: string}
 *   | {action: 'fast-forward', discard: string[], behindCount: number}
 *   | {action: 'refuse', reason: 'dirty'|'diverged'|'unreadable-status', detail: string, remedy: string}} BaseLagPlan
 */

/**
 * Transitions of a managed-block file that this sync can rewrite losslessly, so the file is sync OUTPUT rather than the human's
 * work. `mixed` (edited beyond the block), `invalid` (malformed markers) and `unverified` (not compared) all stay the human's:
 * an unasked question is not a clean answer.
 */
const RESTORABLE_BLOCK_TRANSITIONS = new Set(['block-only', 'unchanged']);

/**
 * `ffChanges` (`gatherFastForwardChanges`'s answer) is what narrows the restore: a sync-written file is restored ONLY when the
 * fast-forward changes it, because git refuses a fast-forward only for a dirty path it would change, and any other restore puts
 * the file's bytes out of step with the manifest base (the divergence gate then refuses it for good; docs/plans/sync-refused-
 * manifest-base.md). It is only consulted when there is something to restore; absent or incomplete it REFUSES.
 *
 * @param {{
 *   repoRoot: string, baseBranch: string, lag: ReturnType<typeof classifyBaseLag>, behindCount: number|null, aheadCount: number|null,
 *   classified: ReturnType<typeof import('../sync-status.mjs').classifyRepo>|null, allowStale?: boolean, why?: string|null,
 *   managedBlockTransition?: (relPath: string) => string,
 *   ffChanges?: {headSha: string|null, paths: Set<string>|null, error?: string|null}|null,
 * }} input `classified` is only read for a checkout that is behind
 * @returns {BaseLagPlan}
 */
export function planBaseLag({
  repoRoot, baseBranch, lag, behindCount, aheadCount, classified, allowStale = false, why = null,
  managedBlockTransition = () => 'unverified', ffChanges = null,
}) {
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
  // A staged rename/copy cannot be restored by path (and the recovery snapshot would then cover more than the restore does), and the
  // sync does not produce one: treat it as the human's, not as regenerable output.
  const renamed = classified.syncOwned.filter((e) => e.origPath || /[RC]/.test(e.status));
  // `.gitignore` / `.gitattributes` are consumer-TRACKED files the sync mutates by managed block, so neither the ownership sidecar
  // nor git-ignore state can see them and `classifyRepo` calls both "not sync output" (measured 2026-11-14: two independent holds
  // deadlocked every sync of two consumers). Ownership of the path is not ownership of the bytes, so each is reclaimed only when
  // the diff from the base is CONFINED to the block — asked of the one marker oracle, and failing closed to the human otherwise.
  const blockRewritten = [];
  const unattributed = [...classified.needsReview, ...classified.other].filter((e) => {
    if (e.origPath || /[RC]/.test(e.status)) return true;
    if (!isManagedBlockFile(e.path)) return true;
    if (!RESTORABLE_BLOCK_TRANSITIONS.has(managedBlockTransition(e.path))) return true;
    blockRewritten.push(e);
    return false;
  });
  const own = [...unattributed, ...renamed];
  if (classified.degraded || own.length > 0) {
    const what = classified.degraded
      ? 'its ownership could not be established, so none of its changes can be shown to be sync output'
      : `it holds changes that are not sync output: ${list(own.map((e) => e.path))}`;
    return {
      action: 'refuse', reason: 'dirty', detail: `${detail}, and ${what}`,
      remedy: `commit or stash those changes, then git -C ${q(repoRoot)} pull --ff-only, then re-run the sync (or --allow-stale-base to write onto the stale base on purpose)`,
    };
  }
  if (!ffChanges?.headSha) {
    return {
      action: 'refuse', reason: 'unreadable-status',
      detail: `${detail}, and its HEAD could not be pinned to a commit, so the fast-forward cannot be checked against what it was planned for`,
      remedy: `git -C ${q(repoRoot)} pull --ff-only; re-run the sync`,
    };
  }
  const candidates = [...classified.syncOwned, ...blockRewritten].filter(restorable).map((e) => e.path);
  if (candidates.length === 0) return { action: 'fast-forward', discard: [], kept: [], behindCount, headSha: ffChanges.headSha };
  const lossy = candidates.some((p) => p.includes('\uFFFD'));
  if (!ffChanges.paths || lossy) {
    const because = ffChanges?.error ?? (lossy ? 'a sync-written path did not decode cleanly' : 'it was not asked');
    return {
      action: 'refuse', reason: 'unreadable-status',
      detail: `${detail}, and which files the fast-forward changes could not be read (${because}), so none of its sync-written changes can be safely restored or kept`,
      remedy: `git -C ${q(repoRoot)} pull --ff-only; re-run the sync`,
    };
  }
  const discard = candidates.filter((p) => ffChanges.paths.has(p));
  return { action: 'fast-forward', discard, kept: candidates.filter((p) => !ffChanges.paths.has(p)), behindCount, headSha: ffChanges.headSha };
}

/**
 * Whether a REAL sync would apply to this consumer, read off the same `planBaseLag` result the real run's `enforceBaseLag`
 * switches on — never a second classifier. A dry run's UNMEASURED verdict says its COUNTS were read against a stale base; it did not
 * say whether the write itself would go through, and an operator read "a base this run could not establish" as "unsafe" while the
 * real run then fast-forwarded and applied cleanly (wine, 2026-11-15). This is that missing answer.
 *
 * Scoped to what the plan decides, and says so: the BASE-LAG gate. `safe`: true = that gate lets a real sync proceed (after its own
 * fast-forward, which can still fail at run time and then refuses with the changes restored); false = the gate refuses this
 * consumer; null = it would proceed without having established the base (unchecked, or `--allow-stale-base` on purpose). Per-file
 * refusals (divergence, overrides) are not this gate's: the dry run evaluates them itself and reports them in its own counts.
 * A plan is a prediction, so only a DRY RUN carries this (`enforceBaseLag`); a real run reports what happened instead.
 *
 * @param {BaseLagPlan} plan
 * @returns {{safe: boolean|null, line: string}}
 */
export function realRunVerdictOf(plan) {
  switch (plan.action) {
    case 'proceed':
      return { safe: true, line: 'safe to apply (base lag): yes — the base is current' };
    case 'fast-forward':
      return {
        safe: true,
        line: `safe to apply (base lag): yes — a real sync fast-forwards ${plan.behindCount} commit(s) first${plan.discard.length ? ` (restoring ${plan.discard.length} sync-written file(s) it rewrites)` : ''} and then syncs; a fast-forward that fails at run time refuses with nothing lost, and only these dry-run counts are read against the stale base`,
      };
    case 'proceed-stale':
      return { safe: null, line: 'safe to apply (base lag): only on purpose — --allow-stale-base writes onto the stale base (sync:pr still refuses a colliding path)' };
    case 'unchecked':
      return { safe: null, line: `safe to apply (base lag): UNKNOWN — a real sync would write without knowing whether this checkout is behind origin (${plan.detail})` };
    case 'refuse':
      return { safe: false, line: `safe to apply (base lag): NO — a real sync REFUSES this consumer (${plan.reason}); remedy: ${plan.remedy}` };
    default:
      return { safe: null, line: `safe to apply (base lag): UNKNOWN — unrecognised base-lag plan "${plan.action}"` };
  }
}

/**
 * Check one consumer's base lag and, where it is safe, fix it. Never throws: every failure is a refusal or a loud "unchecked".
 *
 * A DRY RUN never refuses. A refusal protects the base from being WRITTEN onto, and a dry run writes nothing — so the same verdict
 * that is a safeguard for a real sync is, for a report, a decline to look that reads as a result (measured 2026-11-14: `sync:dry
 * --target wine` printed the refusal and then `Would create: 0  update: 0  unchanged: 0`, having examined nothing; it was the only
 * read-only way to ask whether a consumer carried the staleness #357 had just made visible, and it refused exactly when asking
 * mattered). Instead the report proceeds and is LABELLED `stale-base-unmeasured`: the base it compared against is not the base a
 * real sync would write onto, so its counts are a reading of a tree that is behind — a consumer that could not be fully assessed
 * must never read as clean.
 *
 * @param {{
 *   repoRoot: string, run: Runner, classify: (repoRoot: string) => ReturnType<typeof import('../sync-status.mjs').classifyRepo>,
 *   dryRun?: boolean, allowStale?: boolean,
 *   managedBlockReader?: (input: {run: Runner, repoRoot: string, baseSha: string|null}) => ((relPath: string) => string),
 * }} input
 * @returns {{ok: boolean, measured: boolean, outcome: 'current'|'unchecked'|'stale-accepted'|'fast-forwarded'|'would-fast-forward'|'refused'|'stale-base-unmeasured', lines: string[],
 *   applyVerdict: ReturnType<typeof realRunVerdictOf>|null}} `applyVerdict` — DRY RUN only: what a real sync's base-lag gate does with the
 *   same plan (`realRunVerdictOf`). null on a real run, whose `ok`/`outcome` already say what happened, so a failed fast-forward never
 *   sits beside a predicted "yes".
 */
export function enforceBaseLag(args) {
  const { plan, ...r } = enforceBaseLagCore(args);
  if (!args.dryRun) return { ...r, applyVerdict: null };
  return { ...r, applyVerdict: realRunVerdictOf(plan ?? { action: 'unchecked', detail: r.lines[0] ?? 'base lag not checked' }) };
}

function enforceBaseLagCore({ repoRoot, run, classify, dryRun = false, allowStale = false, managedBlockReader }) {
  const git = (args) => run('git', ['-C', repoRoot, ...args]);
  const facts = gatherBaseFacts(run, repoRoot);
  if (!facts.ok) {
    return { ok: true, measured: false, outcome: 'unchecked', lines: [`base lag NOT CHECKED (${facts.step}: ${facts.error.split('\n')[0]}) - ${dryRun ? 'reporting' : 'writing'} without knowing whether this checkout is behind origin`] };
  }
  const lag = classifyBaseLag(facts);
  let classified = null;
  if (lag === 'behind' && !allowStale) {
    try { classified = classify(repoRoot); } catch (e) { classified = { ok: false, error: e?.message || 'classification threw' }; }
  }
  const managedBlockTransition = managedBlockReader
    ? managedBlockReader({ run, repoRoot, baseSha: facts.baseSha })
    : undefined;
  // HEAD is pinned for every fast-forward plan; the diff only matters when something is dirty, but it is the same two cheap calls.
  const ffChanges = lag === 'behind' && !allowStale && classified?.ok
    ? gatherFastForwardChanges(run, repoRoot, facts.headSha, facts.baseSha)
    : null;
  const plan = planBaseLag({ repoRoot, baseBranch: facts.baseBranch, lag, behindCount: facts.behindCount, aheadCount: facts.aheadCount, classified, allowStale, managedBlockTransition, ffChanges });
  return { ...executeBaseLagPlan({ plan, facts, git, repoRoot, dryRun }), plan };
}

/** The real run's (and dry run's) action on a `planBaseLag` result. Split out so `enforceBaseLag` can hand the plan to `realRunVerdictOf`. */
function executeBaseLagPlan({ plan, facts, git, repoRoot, dryRun }) {
  switch (plan.action) {
    case 'proceed': return { ok: true, measured: true, outcome: 'current', lines: [] };
    case 'unchecked': return { ok: true, measured: false, outcome: 'unchecked', lines: [`base lag NOT CHECKED (${plan.detail})`] };
    case 'proceed-stale': return { ok: true, measured: false, outcome: 'stale-accepted', lines: [`stale base ACCEPTED (--allow-stale-base): ${plan.detail}; sync:pr will still refuse it if origin changed a path this sync writes`] };
    case 'refuse':
      if (dryRun) {
        return {
          ok: true, measured: false, outcome: 'stale-base-unmeasured',
          lines: [
            `base is STALE and this report could not be fully measured: ${plan.detail}.`,
            `the counts below are read against that stale base, NOT against the base a real sync would write onto — treat this consumer as UNMEASURED, not clean.`,
            `to measure it: ${plan.remedy.replace(/re-run the sync/g, 're-run the dry run')}`,
          ],
        };
      }
      return { ok: false, measured: false, outcome: 'refused', lines: [`REFUSED: ${plan.detail}.`, `remedy: ${plan.remedy}`] };
    default: break;
  }
  const target = `origin/${facts.baseBranch}`;
  const kept = plan.kept?.length ?? 0;
  const note = plan.discard.length > 0 ? `restore ${plan.discard.length} sync-written file(s) to HEAD (this sync rewrites them), then ` : '';
  const keptNote = kept > 0 ? `kept ${kept} sync-written file(s) the fast-forward does not touch` : '';
  // A dry run reports the fast-forward it WOULD do and does not perform it, so the counts that follow are read against the stale
  // base just as in the refusal branch above: reported, and not measured.
  if (dryRun) {
    return {
      ok: true, measured: false, outcome: 'would-fast-forward',
      lines: [
        `would ${note}fast-forward ${plan.behindCount} commit(s) to ${target} (dry run: nothing changed)`,
        `the counts below are read against the stale base, so treat this consumer as UNMEASURED, not clean`,
      ],
    };
  }
  // Residual, stated (code audit R1 H3): the snapshot is a dangling commit, recoverable by name only until `git gc`, and an edit
  // landing between the snapshot and the restore (two consecutive git calls) is not in it. This change only shrinks how many
  // paths that window can touch; closing it needs a coordination protocol with the consumer's own editors.
  // The restore is the only destructive step, so it is made RECOVERABLE first: `git stash create` writes a commit of the tracked
  // changes (index and worktree) WITHOUT touching refs or the tree, and a failed fast-forward re-applies it. If the snapshot cannot
  // be taken, nothing is restored and the consumer is refused.
  // The plan was made for ONE commit on ONE branch, so BOTH are re-read before anything is mutated, a clean or all-kept plan's
  // merge included: restoring against another commit would discard changes it never classified, and the fast-forward would
  // advance a branch lag was never measured on (the same commit can sit under two branch names).
  const nowHead = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!plan.headSha || !ok(nowHead) || nowHead.stdout.trim() !== plan.headSha) return refusedFastForward(repoRoot, target, 'HEAD moved since the plan was made; nothing was changed');
  const nowBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!ok(nowBranch) || nowBranch.stdout.trim() !== facts.currentBranch) return refusedFastForward(repoRoot, target, 'the checked-out branch changed since the plan was made; nothing was changed');
  let snapshot = null;
  if (plan.discard.length > 0) {
    const snap = git(['stash', 'create']);
    if (snap.error || snap.status !== 0) return refusedFastForward(repoRoot, target, `could not snapshot the sync-written files before restoring them (${firstLine(snap)}); nothing was changed`);
    snapshot = snap.stdout.trim() || null;
    const restored = git(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...plan.discard.map(lit)]);
    if (restored.error || restored.status !== 0) return failedAfterRestore(git, repoRoot, target, snapshot, plan.discard, `could not restore the sync-written files (${firstLine(restored)})`);
  }
  const merged = git(['merge', '--ff-only', '--no-overwrite-ignore', '--quiet', facts.baseSha]);
  if (merged.error || merged.status !== 0) return failedAfterRestore(git, repoRoot, target, snapshot, plan.discard, firstLine(merged));
  return { ok: true, measured: true, outcome: 'fast-forwarded', lines: [`fast-forwarded ${plan.behindCount} commit(s) to ${target} ${facts.baseSha.slice(0, 8)}${plan.discard.length > 0 ? ` (restored ${plan.discard.length} sync-written file(s) first; this sync rewrites them${snapshot ? `; snapshot ${snapshot.slice(0, 8)} kept until git gc` : ''}${keptNote ? `; ${keptNote}` : ''})` : keptNote ? ` (${keptNote})` : ''}`] };
}

const firstLine = (r) => (r.error?.message || `${r.stderr || ''}${r.stdout || ''}`.trim() || `exit ${r.status}`).split('\n')[0];

/**
 * A step after the restore failed: put the RESTORED paths back, and say whether that worked. Only the restored paths: the files
 * the fast-forward does not touch were never restored, are still dirty, and a whole-snapshot `stash apply` would collide with
 * them (code audit R2 H1). The snapshot's index commit (`<snap>^2`) carries each path's staged state, the snapshot itself its
 * worktree bytes.
 */
function failedAfterRestore(git, repoRoot, target, snapshot, restoredPaths, because) {
  let recovery = '';
  if (snapshot && restoredPaths.length > 0) {
    const staged = git(['restore', `--source=${snapshot}^2`, '--staged', '--', ...restoredPaths.map(lit)]);
    const back = staged.error || staged.status !== 0 ? staged : git(['restore', `--source=${snapshot}`, '--worktree', '--', ...restoredPaths.map(lit)]);
    recovery = back.error || back.status !== 0
      ? ` The sync-written changes could NOT be re-applied automatically (${firstLine(back)}); they are in commit ${snapshot}: git -C ${q(repoRoot)} restore --source=${snapshot}^2 --staged -- ${restoredPaths.map((x) => sq(lit(x))).join(' ')} && git -C ${q(repoRoot)} restore --source=${snapshot} --worktree -- ${restoredPaths.map((x) => sq(lit(x))).join(' ')}.`
      : ' The sync-written changes were put back as they were.';
  }
  return refusedFastForward(repoRoot, target, because, recovery);
}

function refusedFastForward(repoRoot, target, because, recovery = '') {
  return {
    ok: false, measured: false, outcome: 'refused',
    lines: [`REFUSED: the fast-forward to ${target} failed in ${repoRoot} (${because}).${recovery}`, `remedy: git -C ${q(repoRoot)} status, resolve what it shows, then git -C ${q(repoRoot)} pull --ff-only and re-run the sync`],
  };
}

/**
 * The summary's unmeasured verdict and its per-target lines. Lives here rather than inline in `sync-to-repos.mjs` — that file is
 * already over the file-size ratchet's governed limit, the same reason `describeSafeToCommit` sits in `lib/sync-status.mjs`.
 *
 * NOT the plain verdict when something could not be measured. A dry run no longer refuses a stale base (it writes nothing, so
 * there is nothing to protect), but its counts for such a consumer are a reading of a tree that is behind — and zeros from a base
 * nobody could compare are indistinguishable from zeros meaning "clean" unless the verdict says so. The same holds for a real
 * sync: `--allow-stale-base` and an unreachable origin both leave a consumer written onto a base nobody compared.
 *
 * Each target's line is followed by its `applyVerdict` (`realRunVerdictOf`) when it carries one: UNMEASURED is about the dry run's
 * COUNTS, and on its own it was read as "unsafe to apply" for a consumer the real run then fast-forwarded and synced cleanly.
 *
 * @param {Array<{name: string, outcome: string, applyVerdict?: {safe: boolean|null, line: string}}>} unmeasured
 * @param {{dryRun: boolean, targetCount: number}} run
 * @param {{Y?: string, D?: string, X?: string}} [colors] — ANSI codes, caller's own
 * @returns {{verdict: string|null, lines: string[]}} `verdict` is null when everything was measured
 */
export function describeUnmeasuredTargets(unmeasured, { dryRun, targetCount }, { Y = '', D = '', X = '' } = {}) {
  if (!unmeasured?.length) return { verdict: null, lines: [] };
  const why = dryRun
    ? 'its counts above are read against a base this run could not establish'
    : 'written without establishing its base lag';
  return {
    verdict: dryRun ? `${Y}DRY RUN complete — UNMEASURED for ${unmeasured.length} of ${targetCount} target(s)${X} — no files written` : null,
    lines: unmeasured.flatMap((t) => [
      `  ${Y}unmeasured${X} ${t.name} ${D}(${t.outcome})${X} — ${why}`,
      ...(dryRun && t.applyVerdict ? [`    ${t.applyVerdict.line}`] : []),
    ]),
  };
}

/** One network git call (ls-remote, fetch) outliving this is a failure, which the lag check reads as "not checked"/"refused". */
const REMOTE_CALL_MS = 60_000;
const C = { R: '\x1b[31m', Y: '\x1b[33m', G: '\x1b[32m', D: '\x1b[2m', X: '\x1b[0m' };

/**
 * The sync's one call: check (and where safe fix) one consumer's base lag and PRINT the result. `proceed: false` = refuse this
 * consumer (never in a dry run — see `enforceBaseLag`). `measured: false` says the consumer's state could not be established
 * against the base it will actually be compared with: the CALLER must carry that into its own verdict rather than letting the
 * counts stand alone, which is the whole defect this returns a shape instead of a boolean for.
 *
 * `classifyRepo` is the one provenance pipeline `sync:pr` uses; it lives in a CLI module, so it is loaded only when a checkout is
 * actually behind (the rare case), never on the way to "current". The managed-block transition reader is loaded on the same
 * branch and for the same reason.
 *
 * @param {{name: string, path: string}} repo
 * @param {{dryRun?: boolean, allowStale?: boolean, run?: Runner, classify?: Function, managedBlockReader?: Function, write?: (line: string) => void}} [opts]
 * @returns {Promise<{proceed: boolean, measured: boolean, outcome: string, applyVerdict: {safe: boolean|null, line: string}|null}>}
 */
export async function enforceBaseLagForTarget(repo, { dryRun = false, allowStale = false, run, classify, managedBlockReader, write = (l) => console.log(l) } = {}) {
  // Every git call here is local or one short network round trip: bound it, and never let git prompt for credentials in a sync.
  // Only the NETWORK calls are bounded (killing a local merge / restore / stash halfway would leave locks and half-applied state).
  const runner = run ?? ((cmd, args, o) => spawnRunner(cmd, args, { ...o, env: { GIT_TERMINAL_PROMPT: '0' }, ...(args.some((a) => a === 'ls-remote' || a === 'fetch') ? { timeoutMs: REMOTE_CALL_MS } : {}) }));
  let classifier = classify;
  if (!classifier) {
    const { classifyRepo } = await import('../sync-status.mjs');
    classifier = classifyRepo;
  }
  let blockReader = managedBlockReader;
  if (!blockReader) {
    const { createManagedBlockTransitionReader } = await import('./sync-pr-facts.mjs');
    blockReader = createManagedBlockTransitionReader;
  }
  const r = enforceBaseLag({ repoRoot: repo.path, run: runner, classify: classifier, dryRun, allowStale, managedBlockReader: blockReader });
  const colour = r.ok ? (r.outcome === 'current' ? C.D : r.outcome === 'fast-forwarded' ? C.G : C.Y) : C.R;
  for (const line of r.lines) write(`  ${colour}base-lag${C.X} ${line}`);
  return { proceed: r.ok, measured: r.measured, outcome: r.outcome, applyVerdict: r.applyVerdict };
}
