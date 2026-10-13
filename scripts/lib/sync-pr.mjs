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
 *    The sync computed its output against that checkout. A feature branch, or
 *    a `main` ahead of `origin/main`, is a base the PR cannot honestly sit on
 *    (its commits would leak into the PR, or the output would rest on commits
 *    origin has never seen). Both are refused with a named reason, never
 *    silently "handled".
 * 3. **The branch forks from a FRESHLY FETCHED `origin/<default>`, never from
 *    the checkout's local default branch.** The default branch is asked of the
 *    remote (`ls-remote --symref origin HEAD`), fetched, and a failure of
 *    either is an ERROR, never a fall-back to the local ref. Incident
 *    2026-10-12: wine-cellar-app's local `main` sat 30+ commits behind origin,
 *    missing the previous sync PR, so the new branch conflicted on
 *    `.sync-receipt.json` and the consumer's hook refused the push.
 *    The synced files reach the fresh base by carrying the working tree
 *    across `git switch -c <branch> <origin sha>` — and that carry is only
 *    honest when origin changed NONE of the paths the sync wrote (nor
 *    `.sync-overrides.json`, the declared divergence the sync honoured) since
 *    the stale base: then each written file sits on exactly the content the
 *    sync's three-way decision saw. When origin did touch one — every landed
 *    sync touches the append-only receipt — the output is refused with the
 *    colliding paths named, and the remedy is to re-run the sync on a current
 *    checkout. Rebuilding the receipt or re-deciding divergence here would be
 *    a second implementation of the sync; the sync is the one that may do it.
 *
 * PURE planning (`planConsumerPr`, `branchNameFor`, `buildPrText`,
 * `parseGhAccounts`, `isRepoNotResolvable`) plus an executor
 * (`runConsumerPr`) whose every process call goes through an injected `run`,
 * so the full sequence — including the switch-back on failure — is tested
 * without git or gh.
 *
 * @module scripts/lib/sync-pr
 */
import fs from 'node:fs';
import path from 'node:path';
import { RECEIPT_PATH } from './sync-receipt.mjs';
import { OVERRIDES_PATH } from './sync-overrides.mjs';
import { comparisonKey } from './sync-owned-sidecar.mjs';
import { pathspecsForCommit } from './sync-status.mjs';
import { SYNC_BRANCH_PREFIX } from './sync-divergence.mjs';

/** Every reason `planConsumerPr` can decline. Strings are the CLI's contract. */
export const SKIP_REASON = Object.freeze({
  CLEAN: 'clean',
  RECEIPT_ONLY: 'receipt-only',
  UNCLASSIFIABLE: 'unclassifiable',
  NO_MANIFEST: 'no-manifest',
  NOT_ON_BASE: 'not-on-base',
  AHEAD: 'local-commits-ahead',
  STALE_BASE_COLLISION: 'stale-base-collision',
  BRANCH_EXISTS: 'branch-exists',
});

const RECEIPT_KEY = comparisonKey(RECEIPT_PATH);

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
 * @param {string|null|undefined} commitSha — the consumer manifest's `commitSha`
 * @returns {string}
 */
export function branchNameFor(commitSha) {
  return `${SYNC_BRANCH_PREFIX}${String(commitSha).slice(0, 8)}`;
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
    '',
    // A mechanical sync has no model author. Consumers that gate PRs on an
    // AI-Models declaration (wine-cellar-app's `AI-Models trailer` check, which
    // failed on every sync PR until 2026-09-29) accept `none` from the body.
    // Body only: `AI-*` COMMIT trailers are reserved for ship-commit.mjs.
    'AI-Models: none',
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
 *   baseSha: string|null,          — `origin/<baseBranch>` as freshly fetched
 *   currentBranch: string|null,
 *   aheadCount: number|null,       — commits on HEAD not on baseSha
 *   behindCount: number|null,      — commits on baseSha not on HEAD
 *   upstreamChanged?: string[],    — paths that differ between HEAD and baseSha
 *   branchExists: boolean,
 * }} input
 * @returns {{action:'skip', reason:string, detail?:string}
 *   | {action:'pr', branch:string, startPoint:string, behindCount:number, addPaths:string[],
 *      commitPathspecs:string[], surface:string[], leftBehind:string[], title:string, message:string, body:string}}
 */
export function planConsumerPr({
  consumerName, classified, manifest, baseBranch, baseSha, currentBranch, aheadCount, behindCount, upstreamChanged = [], branchExists,
}) {
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
  if (typeof baseSha !== 'string' || !baseSha || aheadCount === null || behindCount === null || aheadCount > 0) {
    return {
      action: 'skip',
      reason: SKIP_REASON.AHEAD,
      detail: aheadCount > 0 ? `${aheadCount} local commit(s) not on origin/${baseBranch}` : `could not compare against origin/${baseBranch}`,
    };
  }
  const commitPathspecs = [...new Set(pathspecsForCommit(classified.syncOwned))].sort();
  if (behindCount > 0) {
    // Header rule 3: the working tree may ride onto origin's head only if
    // origin left every path the sync wrote (and the overrides it honoured)
    // exactly as the sync saw them.
    const changed = new Set(upstreamChanged.map(comparisonKey));
    const collisions = [...commitPathspecs, OVERRIDES_PATH].filter((p) => changed.has(comparisonKey(p)));
    if (collisions.length > 0) {
      return {
        action: 'skip',
        reason: SKIP_REASON.STALE_BASE_COLLISION,
        detail: `this checkout is ${behindCount} commit(s) behind origin/${baseBranch}, which has since changed ${collisions.join(', ')}`
          + ' — the sync ran against a stale base. Discard the synced changes, `git pull --ff-only`, re-run the sync, then sync:pr',
      };
    }
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
    startPoint: baseSha,
    behindCount,
    addPaths,
    commitPathspecs,
    surface,
    leftBehind,
    ...text,
  };
}

/**
 * Facts about the consumer checkout that `planConsumerPr` needs and cannot
 * derive itself. Header rule 3: the base is asked of the REMOTE and fetched
 * fresh; either failing is an error — never a quiet fall-back to the local
 * default branch, which is exactly the stale base of the 2026-10-12 incident.
 *
 * @param {Runner} run
 * @param {string} repoRoot
 * @param {{baseBranch?: string|null, commitSha?: string|null}} [opts] — `baseBranch` overrides the remote default
 * @returns {{ok: false, step: string, error: string}
 *   | {ok: true, baseBranch: string, baseSha: string, currentBranch: string|null, aheadCount: number|null,
 *      behindCount: number|null, upstreamChanged: string[], branchExists: boolean}}
 */
export function gatherConsumerFacts(run, repoRoot, { baseBranch = null, commitSha = null } = {}) {
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
  let upstreamChanged = [];
  if (behindCount > 0) {
    const diff = git(['diff', '--name-only', '--no-renames', '-z', 'HEAD', baseSha, '--']);
    if (!ok(diff)) return { ok: false, step: `diff HEAD..origin/${base}`, error: why(diff) };
    upstreamChanged = diff.stdout.split('\0').filter(Boolean);
  }
  const branch = branchNameFor(commitSha ?? 'unknown');
  const local = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  const remote = git(['ls-remote', '--heads', 'origin', branch]);
  const branchExists = ok(local) || (ok(remote) && remote.stdout.trim() !== '');
  return { ok: true, baseBranch: base, baseSha, currentBranch, aheadCount, behindCount, upstreamChanged, branchExists };
}

/** CSI / OSC escape sequences, so a coloured reporter's lines still match. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Failing test names out of a consumer hook's output, so a refused push
 * names WHAT failed rather than only "Tests 2 failed | 19805 passed". Tries
 * one reporter shape at a time and returns the first that matches, so one
 * failure is never listed twice in two spellings. PURE; [] when nothing parses.
 *   - vitest summary:   ` FAIL  tests/a.test.js > suite > name`
 *   - node:test / tap:  `not ok 3 - name`
 *   - jest:             `  ● Suite › name`
 *   - per-test marks:   `  × name 12ms` / `✕ name` / `✖ name (3ms)` (vitest, jest, node spec)
 *   - fallback:         ` FAIL  tests/a.test.js` (file only, when no test-level line exists)
 *
 * @param {string} text
 * @param {number} [cap]
 * @returns {string[]}
 */
export function parseFailingTests(text, cap = 25) {
  const lines = String(text ?? '').replace(ANSI, '').split(/\r?\n/);
  const collect = (re) => {
    const found = [];
    for (const line of lines) {
      const m = re.exec(line);
      if (m && !found.includes(m[1])) found.push(m[1]);
    }
    return found;
  };
  // Test-level shapes, most specific first. Reporters overlap (vitest prints
  // both `×` marks and FAIL summary lines for one failure; jest prints a
  // file-level `FAIL path` header above its `●` test names), so only the first
  // shape that matches is used.
  const testLevel = [
    /^\s*FAIL\s+(\S.*? > .+?)\s*$/,
    /^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/,
    /^\s*● (?!Console\b)(.+?)\s*$/,
    /^\s*[×✕✖✗]\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s*m?s\)?)?\s*$/,
  ];
  for (const re of testLevel) {
    const found = collect(re);
    if (found.length > 0) return found.slice(0, cap);
  }
  // File-level only (a jest `FAIL path` with no `●` detail, or a suite that
  // failed to load): the file is still better than the summary line.
  return collect(/^\s*FAIL\s+(\S.*?)\s*$/).slice(0, cap);
}

/**
 * Persist a refused push's FULL output (the consumer hook's report rides in
 * it) where a person or agent can read it later, and name the failing tests.
 * The terminal only ever shows a tail; the 2026-10-12 incident printed the
 * vitest summary line alone, so the two failures could never be identified.
 * A write failure is reported in the return, never thrown — the caller still
 * has the tail to print.
 *
 * @param {{dir: string, consumerName: string, branch: string, startPoint?: string, text: string, now?: Date}} input
 * @returns {{logPath: string|null, writeError: string|null, failingTests: string[]}}
 */
export function writePushFailureLog({ dir, consumerName, branch, startPoint, text, now = new Date() }) {
  const failingTests = parseFailingTests(text);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');
  const logPath = path.join(dir, `${safe(consumerName)}-${safe(branch)}-${stamp}.log`);
  const header = [
    `# sync-pr: push refused for ${consumerName}`,
    `# branch: ${branch}${startPoint ? ` (from ${startPoint})` : ''}`,
    `# at: ${now.toISOString()}`,
    `# failing tests parsed: ${failingTests.length > 0 ? failingTests.join(' | ') : '(none — read the output below)'}`,
    '',
  ].join('\n');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(logPath, `${header}${text}\n`, 'utf-8');
    return { logPath, writeError: null, failingTests };
  } catch (err) {
    return { logPath: null, writeError: err.message, failingTests };
  }
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
 *   consumerName?: string, pushLogDir?: string|null, — where a refused push's full output is kept
 * }} input
 * @returns {{ok: true, branch: string, url: string|null, merged: 'armed'|'not-armed'|'skipped', warnings: string[]}
 *   | {ok: false, branch: string, step: string, error: string, warnings: string[],
 *      pushLog?: ReturnType<typeof writePushFailureLog>}}
 */
export function runConsumerPr({
  plan, repoRoot, baseBranch, currentBranch, merge, run, log = () => {}, consumerName = path.basename(repoRoot), pushLogDir = null,
}) {
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

  // Header rule 3: fork from the freshly fetched origin sha, carrying the
  // synced working tree across. git refuses the carry when a dirty path
  // differs between HEAD and the start point — the planner already refused
  // that case by name; this is the backstop.
  const created = git(['switch', '--no-track', '-c', plan.branch, plan.startPoint]);
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
    if (!ok(pushed)) {
      switchBack();
      const failure = fail('push', pushed);
      if (pushLogDir) {
        failure.pushLog = writePushFailureLog({
          // Not `why()`: it returns the spawn error ALONE when one is set
          // (e.g. ENOBUFS past the runner's buffer), dropping the partial
          // output that still came back.
          dir: pushLogDir, consumerName, branch: plan.branch, startPoint: plan.startPoint,
          text: [pushed.error && `[spawn error] ${pushed.error.message}`, pushed.stderr, pushed.stdout].filter(Boolean).join('\n')
            || `push exited ${pushed.status} with no output`,
        });
      }
      return failure;
    }

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
