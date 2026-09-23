/**
 * @fileoverview `sync-pr` — turn a consumer's sync-owned dirty group into a
 * branch, a scoped commit, a push, and a squash-auto-merged pull request.
 *
 * ## Why a SEPARATE command, and not the sync itself
 *
 * `lib/sync-receipt.mjs`'s header records why the sync never commits in a
 * consumer: that tree is the human's, a commit would fire their hooks and
 * bundle unrelated staged work. Every one of those stays true here — this
 * command is only ever run ON PURPOSE (`npm run sync:pr`), it commits ONLY the
 * group `sync-status.mjs` already proves was written by the sync (ownership
 * AND content-hash provenance, via the one `classifyRepo` pipeline), scoped by
 * pathspec so staged unrelated work is never swept in, and it does so on its
 * own branch so the consumer's protected default branch keeps its PR gate.
 * "Skip the PR for sync commits" was rejected: a ruleset bypass cannot be
 * scoped by path, so it would mean "this actor may push anything to main".
 *
 * ## The two decisions that matter
 *
 * 1. **Receipt-only changes do not earn a PR.** `.sync-receipt.json` changes on
 *    EVERY sync run, so without this rule every upstream push would spawn a
 *    consumer PR that changes nothing anyone reads. A PR is opened only when
 *    the tracked surface changed (`.claude/skills/**`, the ownership sidecar,
 *    the schema fixture, …); the receipt then rides along.
 * 2. **The consumer must be on its base branch with no unpushed commits.**
 *    The new branch forks from HEAD. Forking from a feature branch would put
 *    that branch's commits in the PR; forking from a `main` that is ahead of
 *    `origin/main` would publish commits the human has not pushed. Both are
 *    refused with a named reason, never silently "handled".
 *
 * PURE planning (`planConsumerPr`, `branchNameFor`, `buildPrText`,
 * `parseGhAccounts`, `isRepoNotResolvable`) plus an executor
 * (`runConsumerPr`) whose every process call goes through an injected `run`,
 * so the full sequence — including the switch-back on failure — is tested
 * without git or gh.
 *
 * @module scripts/lib/sync-pr
 */
import { RECEIPT_PATH } from './sync-receipt.mjs';
import { comparisonKey } from './sync-owned-sidecar.mjs';
import { pathspecsForCommit } from './sync-status.mjs';

/** Every reason `planConsumerPr` can decline. Strings are the CLI's contract. */
export const SKIP_REASON = Object.freeze({
  CLEAN: 'clean',
  RECEIPT_ONLY: 'receipt-only',
  UNCLASSIFIABLE: 'unclassifiable',
  NO_MANIFEST: 'no-manifest',
  NOT_ON_BASE: 'not-on-base',
  AHEAD: 'local-commits-ahead',
  BRANCH_EXISTS: 'branch-exists',
});

const RECEIPT_KEY = comparisonKey(RECEIPT_PATH);

/**
 * @param {string|null|undefined} commitSha — the consumer manifest's `commitSha`
 * @returns {string}
 */
export function branchNameFor(commitSha) {
  return `chore/sync-${String(commitSha).slice(0, 8)}`;
}

/**
 * Commit title/message + PR body for one consumer. Pure text.
 *
 * @param {{repo: string, commitSha: string, surface: string[], leftBehind: string[], consumerName: string}} input
 * @returns {{title: string, message: string, body: string}}
 */
export function buildPrText({ repo, commitSha, surface, leftBehind, consumerName }) {
  const short = String(commitSha).slice(0, 8);
  const title = `chore(sync): bundle sync from ${repo} ${short}`;
  const fileList = surface.map((p) => `- \`${p}\``).join('\n');
  const message = [
    title,
    '',
    `Commits the tracked artifacts of the claude-engineering-skills sync at ${short}`,
    `(${surface.length} sync-owned path(s), content verified against scripts/.sync-manifest.json).`,
    'Opened by `npm run sync:pr` in the upstream repo; the sync itself never commits here.',
  ].join('\n');
  const body = [
    '## Summary',
    '',
    `Tracked artifacts of the bundle sync from \`${repo}\` at https://github.com/${repo}/commit/${commitSha}, for consumer \`${consumerName}\`.`,
    '',
    `Every path below was classified **sync-owned** by \`sync-status.mjs\` — owned by the sync AND byte-identical to the hash the sync recorded — so nothing here is a hand edit:`,
    '',
    fileList,
    '',
    ...(leftBehind.length > 0
      ? [
        '### Left uncommitted (needs review)',
        '',
        'Sync-managed paths whose content changed since the last sync, or could not be verified. Deliberately NOT included:',
        '',
        leftBehind.map((p) => `- \`${p}\``).join('\n'),
        '',
      ]
      : []),
    '_Opened by `npm run sync:pr` from the upstream repo. Squash auto-merge is armed; it lands when the required checks pass._',
  ].join('\n');
  return { title, message, body };
}

/**
 * Decide, from facts the CLI gathered, whether this consumer earns a PR.
 * PURE — no git, no gh, no filesystem.
 *
 * @param {{
 *   consumerName: string,
 *   classified: ReturnType<typeof import('../sync-status.mjs').classifyRepo>,
 *   manifest: {repo?: string, commitSha?: string|null}|null,
 *   baseBranch: string,
 *   currentBranch: string|null,
 *   aheadCount: number|null,
 *   branchExists: boolean,
 * }} input
 * @returns {{action:'skip', reason:string, detail?:string}
 *   | {action:'pr', branch:string, addPaths:string[], commitPathspecs:string[], surface:string[],
 *      leftBehind:string[], title:string, message:string, body:string}}
 */
export function planConsumerPr({ consumerName, classified, manifest, baseBranch, currentBranch, aheadCount, branchExists }) {
  if (!classified || !classified.ok) {
    return { action: 'skip', reason: SKIP_REASON.UNCLASSIFIABLE, detail: classified?.error ?? 'no classification' };
  }
  if (classified.clean || classified.syncOwned.length === 0) {
    return { action: 'skip', reason: SKIP_REASON.CLEAN };
  }
  if (classified.degraded) {
    return { action: 'skip', reason: SKIP_REASON.UNCLASSIFIABLE, detail: 'no ownership sidecar and no readable git-ignore state' };
  }
  const commitSha = manifest?.commitSha;
  if (typeof commitSha !== 'string' || commitSha.length < 8) {
    return { action: 'skip', reason: SKIP_REASON.NO_MANIFEST, detail: 'scripts/.sync-manifest.json has no commitSha' };
  }
  const addPaths = [...new Set(classified.syncOwned.map((e) => e.path))].sort();
  const surface = addPaths.filter((p) => comparisonKey(p) !== RECEIPT_KEY);
  if (surface.length === 0) {
    return { action: 'skip', reason: SKIP_REASON.RECEIPT_ONLY };
  }
  if (currentBranch !== baseBranch) {
    return { action: 'skip', reason: SKIP_REASON.NOT_ON_BASE, detail: `on ${currentBranch ?? '(detached)'}, expected ${baseBranch}` };
  }
  if (aheadCount === null || aheadCount > 0) {
    return {
      action: 'skip',
      reason: SKIP_REASON.AHEAD,
      detail: aheadCount === null ? `could not compare against origin/${baseBranch}` : `${aheadCount} local commit(s) not on origin/${baseBranch}`,
    };
  }
  const branch = branchNameFor(commitSha);
  if (branchExists) {
    return { action: 'skip', reason: SKIP_REASON.BRANCH_EXISTS, detail: branch };
  }
  const leftBehind = classified.needsReview.map((e) => e.path).sort();
  const text = buildPrText({ repo: manifest.repo ?? 'Lbstrydom/claude-engineering-skills', commitSha, surface, leftBehind, consumerName });
  return {
    action: 'pr',
    branch,
    addPaths,
    commitPathspecs: [...new Set(pathspecsForCommit(classified.syncOwned))].sort(),
    surface,
    leftBehind,
    ...text,
  };
}

/**
 * `gh` names the one case worth retrying with another signed-in account: the
 * active account cannot see the repo at all. Anything else (auth expired, API
 * down, validation) is reported as-is.
 * @param {string} text — stdout + stderr of the failed gh call
 * @returns {boolean}
 */
export function isRepoNotResolvable(text) {
  return /Could not resolve to a Repository|HTTP 404|Not Found \(HTTP 404\)/i.test(String(text ?? ''));
}

/**
 * Parse `gh auth status` into `[{host, login, active}]`. Tolerates both the
 * stderr and stdout placement gh has used across versions.
 * @param {string} text
 * @returns {Array<{host: string, login: string, active: boolean}>}
 */
export function parseGhAccounts(text) {
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /Logged in to (\S+) account (\S+)/.exec(lines[i]);
    if (!m) continue;
    let active = false;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const a = /Active account:\s*(true|false)/i.exec(lines[j]);
      if (a) { active = a[1].toLowerCase() === 'true'; break; }
    }
    out.push({ host: m[1], login: m[2], active });
  }
  return out;
}

/**
 * @typedef {(cmd: string, args: string[], opts?: {cwd?: string, input?: string}) => {status: number|null, stdout: string, stderr: string, error?: Error}} Runner
 */

/** @param {{status:number|null, error?:Error}} r */
const ok = (r) => !r.error && r.status === 0;
/** @param {{stdout:string, stderr:string, error?:Error, status:number|null}} r */
const why = (r) => (r.error?.message || `${r.stderr || ''}${r.stdout || ''}`.trim() || `exit ${r.status}`);

/**
 * Execute one planned PR. Every process call goes through `run`; nothing here
 * touches git or gh directly. On ANY failure after the branch was created the
 * consumer is switched back to `currentBranch` and the branch is left in
 * place for inspection — a half-done sync PR must never leave the human's
 * checkout on a branch they did not ask for.
 *
 * `gh` account fallback: if the active account cannot resolve the repo (this
 * machine signs in to two GitHub accounts; each consumer belongs to one), the
 * other signed-in accounts are tried in turn, and the original active account
 * is restored before returning.
 *
 * @param {{
 *   plan: Extract<ReturnType<typeof planConsumerPr>, {action:'pr'}>,
 *   repoRoot: string, baseBranch: string, currentBranch: string, merge: boolean,
 *   run: Runner, log?: (line: string) => void,
 * }} input
 * @returns {{ok: true, branch: string, url: string|null, merged: 'armed'|'not-armed'|'skipped', warnings: string[]}
 *   | {ok: false, branch: string, step: string, error: string, warnings: string[]}}
 */
export function runConsumerPr({ plan, repoRoot, baseBranch, currentBranch, merge, run, log = () => {} }) {
  const warnings = [];
  // `--literal-pathspecs` ONLY on the two commands that take our pathspecs.
  // As a global flag git exports it as GIT_LITERAL_PATHSPECS to every child —
  // including the consumer's pre-push hook, whose own `git ls-files -- '*.md'`
  // then matches nothing. First live run (2026-09-23): ai-organiser's npm-args
  // gate refused the push with `scan/empty-scan-set`, correctly — the
  // instrument had been poisoned from outside.
  const git = (args, opts = {}) => run('git', ['-C', repoRoot, ...args], opts);
  const gitLiteral = (args, opts = {}) => run('git', ['--literal-pathspecs', '-C', repoRoot, ...args], opts);
  const ghState = { original: null, current: null };
  const gh = (args, opts = {}) => {
    let r = run('gh', args, { cwd: repoRoot, ...opts });
    if (ok(r) || !isRepoNotResolvable(`${r.stderr}\n${r.stdout}`)) return r;
    const status = run('gh', ['auth', 'status'], { cwd: repoRoot });
    const accounts = parseGhAccounts(`${status.stdout}\n${status.stderr}`);
    const active = accounts.find((a) => a.active);
    if (ghState.original === null) ghState.original = active?.login ?? null;
    for (const acct of accounts.filter((a) => !a.active)) {
      log(`  gh: ${active?.login ?? '(unknown)'} cannot see this repo — retrying as ${acct.login}`);
      const sw = run('gh', ['auth', 'switch', '-u', acct.login], { cwd: repoRoot });
      if (!ok(sw)) continue;
      ghState.current = acct.login;
      r = run('gh', args, { cwd: repoRoot, ...opts });
      if (ok(r)) return r;
    }
    return r;
  };
  const restoreGhAccount = () => {
    if (ghState.original && ghState.current && ghState.current !== ghState.original) {
      const back = run('gh', ['auth', 'switch', '-u', ghState.original], { cwd: repoRoot });
      if (!ok(back)) warnings.push(`gh active account left as ${ghState.current}; \`gh auth switch -u ${ghState.original}\` to restore`);
    }
  };
  const fail = (step, r) => ({ ok: false, branch: plan.branch, step, error: why(r), warnings });

  const created = git(['switch', '-c', plan.branch]);
  if (!ok(created)) return fail('switch -c', created);

  const switchBack = () => {
    const back = git(['switch', currentBranch]);
    if (!ok(back)) warnings.push(`could not switch back to ${currentBranch}: ${why(back)} — the checkout is still on ${plan.branch}`);
  };

  try {
    const added = gitLiteral(['add', '--', ...plan.addPaths]);
    if (!ok(added)) { switchBack(); return fail('add', added); }
    const committed = gitLiteral(['commit', '-q', '-m', plan.message, '--', ...plan.commitPathspecs]);
    if (!ok(committed)) { switchBack(); return fail('commit', committed); }
    log(`  pushing ${plan.branch} (the consumer's own pre-push hook runs now — this can take a while)`);
    const pushed = git(['push', '-u', 'origin', plan.branch]);
    if (!ok(pushed)) { switchBack(); return fail('push', pushed); }

    const create = gh(['pr', 'create', '--base', baseBranch, '--head', plan.branch, '--title', plan.title, '--body-file', '-'], { input: plan.body });
    if (!ok(create)) { switchBack(); return fail('gh pr create', create); }
    const url = (String(create.stdout).match(/https?:\/\/\S+/g) || []).pop() ?? null;

    let merged = 'skipped';
    if (merge) {
      const mergeArgs = ['pr', 'merge', ...(url ? [url] : []), '--auto', '--squash', '--delete-branch'];
      const m = gh(mergeArgs);
      if (ok(m)) merged = 'armed';
      else {
        merged = 'not-armed';
        warnings.push(`auto-merge not armed: ${why(m)} — enable "Allow auto-merge" in the repo settings, or merge the PR by hand`);
      }
    }
    switchBack();
    return { ok: true, branch: plan.branch, url, merged, warnings };
  } finally {
    restoreGhAccount();
  }
}
