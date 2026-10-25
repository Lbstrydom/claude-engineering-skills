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
 * 4. **A newer sync PR SUPERSEDES an older open one** (upstream 2f933809).
 *    Two sync PRs open at once for one consumer both prepend to the receipt,
 *    so whichever merges second is DIRTY, and resolving it by hand either
 *    drops an event or hand-computes the rotation. Once the new PR is open,
 *    each older open `chore/sync-*` PR is closed with a comment naming its
 *    successor — never merged, its branch kept so it can be reopened — but
 *    ONLY when git evidence proves the new one replaces it: one commit over
 *    the merge-base, every changed file sync-owned by that PR's own sidecar
 *    (or the merge-base's, for a file it retired), and its own receipt
 *    attesting a bundle strictly OLDER than this one. Anything else is kept
 *    open with a named reason (`SUPERSEDE_KEEP_REASON`). Rejected: a merge
 *    driver (GitHub's server-side merge never runs one, so the PR still reads
 *    DIRTY), and regenerating the receipt when the base moves (no trigger
 *    exists, and it would be the second implementation rule 3 refuses).
 *    A re-run that opens no PR while this bundle's sync branch exists
 *    (`supersessionRetryTarget`) retries a failed supersession for the
 *    already-open PR via `retrySupersession` — creating nothing and arming
 *    nothing.
 *    Plan: docs/plans/sync-pr-supersede-open-sync-pr.md.
 *
 * PURE planning (`planConsumerPr`, `branchNameFor`, `buildPrText`,
 * `parseGhAccounts`, `isRepoNotResolvable`, `parseOpenSyncPrs`,
 * `decideSupersession`) plus an executor (`runConsumerPr`, and the
 * `supersedeOlderSyncPrs` step it runs) whose every process call goes through
 * an injected `run` (bundle order through an injected `ancestry` oracle), as
 * does `retrySupersession`'s, so the full sequence — including the
 * switch-back on failure — is tested without git or gh.
 *
 * @module scripts/lib/sync-pr
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { RECEIPT_PATH, readSyncReceipt, latestReceiptEntry } from './sync-receipt.mjs';
import { OVERRIDES_PATH } from './sync-overrides.mjs';
import { comparisonKey, isUpstreamOwned, isUsableSidecar, OWNED_SIDECAR_RELATIVE_PATH } from './sync-owned-sidecar.mjs';
import { pathspecsForCommit } from './sync-status.mjs';
import { SYNC_BRANCH_PREFIX } from './sync-divergence.mjs';
import { classifyGitignoreTransition } from './sync-gitignore.mjs';
import { createGitAncestry } from './sync-rollback-guard.mjs';
// The base-lag oracle (and the runner / git helpers it shares with this module) lives in sync-base-lag.mjs, which the sync asks BEFORE
// writing; re-exported here so `sync:pr` and every existing importer keep one door.
import { spawnRunner, ok, why, parseSymrefHead, classifyBaseLag, gatherBaseFacts } from './sync-base-lag.mjs';
export { spawnRunner, parseSymrefHead, classifyBaseLag, gatherBaseFacts };

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
  /** Nothing synced is on disk, but the bundle stamp differs from the source HEAD: 'clean' would read as 'up to date' (proposal da9a). */
  CLEAN_BUNDLE_DIFFERS: 'clean-bundle-differs',
  /** Nothing synced is on disk and the stamp cannot be compared to the source (malformed, short, source unreadable or dirty). */
  CLEAN_UNVERIFIED: 'clean-unverified',
});

const FULL_SHA = /^[0-9a-f]{40}$/;
const GITIGNORE_PATH = '.gitignore';
/** `block-only` is the one state that rides in the PR; the rest are named under leftBehind. */
const GITIGNORE_PATH_STATE = Object.freeze({ BLOCK_ONLY: 'block-only' });
const GITIGNORE_LEFT_BEHIND_REASON = Object.freeze({
  mixed: 'edited beyond the sync-managed block',
  invalid: 'managed-block markers are malformed',
  unverified: 'could not be compared with the base',
});

/**
 * Is the consumer's bundle stamp the source's current commit? PURE.
 *
 * A 'clean' consumer only means the tracked surface on disk is committed - it compares nothing against the source, so a STALE
 * bundle read 'skip clean' (storyline, 2026-10-16: the bundle lacked #265 until a separate sync). Decision table:
 *
 *   stamp not 40-hex (missing/short/malformed) -> unverified
 *   sourceSha not 40-hex                       -> unverified
 *   different                                  -> different (NEVER 'behind': no ancestry is verified - it may be ahead or divergent)
 *   equal, source tree dirty or unknown        -> unverified (a matching HEAD stamp does not prove equal content)
 *   equal, source tree clean                   -> current
 *
 * @param {{stamp: unknown, sourceSha: unknown, sourceDirty: unknown}} input
 * @returns {'current'|'different'|'unverified'}
 */
export function classifyBundleFreshness({ stamp, sourceSha, sourceDirty }) {
  if (typeof stamp !== 'string' || !FULL_SHA.test(stamp)) return 'unverified';
  if (typeof sourceSha !== 'string' || !FULL_SHA.test(sourceSha)) return 'unverified';
  if (stamp !== sourceSha) return 'different';
  return sourceDirty === false ? 'current' : 'unverified';
}

const RECEIPT_KEY = comparisonKey(RECEIPT_PATH);
const DEFAULT_REPO = 'Lbstrydom/claude-engineering-skills';

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
 *   sourceSha?: string,            — the SOURCE repo HEAD (40-hex); absent => a clean skip is "unverified"
 *   sourceDirty?: boolean,         — the SOURCE working tree has uncommitted changes
 *   gitignoreTransition?: 'unchanged'|'block-only'|'mixed'|'invalid'|'unverified' — what the sync did to the consumer's .gitignore
 * }} input
 * @returns {{action:'skip', reason:string, detail?:string}
 *   | {action:'pr', branch:string, bundleSha:string, repo:string, startPoint:string, behindCount:number, addPaths:string[],
 *      commitPathspecs:string[], surface:string[], leftBehind:string[], title:string, message:string, body:string}}
 */
export function planConsumerPr({
  consumerName, classified, manifest, baseBranch, baseSha, currentBranch, aheadCount, behindCount, upstreamChanged = [], branchExists,
  sourceSha, sourceDirty, gitignoreTransition,
}) {
  if (!classified || !classified.ok) {
    return { action: 'skip', reason: SKIP_REASON.UNCLASSIFIABLE, detail: classified?.error ?? 'no classification' };
  }
  // a5ce: the managed .gitignore block is sync output in a file the consumer owns. It rides in the PR only when the edit is the block
  // and nothing else (classifyGitignoreTransition); any other dirty state of that file is named under leftBehind, never swept in.
  const gitignoreRides = gitignoreTransition === GITIGNORE_PATH_STATE.BLOCK_ONLY;
  if ((classified.clean || classified.syncOwned.length === 0) && !gitignoreRides) {
    // 'clean' compared nothing against the source: say whether the bundle is actually current (da9a).
    const freshness = classifyBundleFreshness({ stamp: manifest?.commitSha, sourceSha, sourceDirty });
    if (freshness === 'different') {
      return {
        action: 'skip', reason: SKIP_REASON.CLEAN_BUNDLE_DIFFERS,
        detail: `no synced changes on disk, but the bundle stamp ${manifest.commitSha.slice(0, 8)} differs from the source ${sourceSha.slice(0, 8)}`
          + ` - run npm run sync -- --target ${consumerName} first`,
      };
    }
    if (freshness === 'unverified') {
      return {
        action: 'skip', reason: SKIP_REASON.CLEAN_UNVERIFIED,
        detail: 'no synced changes on disk, and the bundle stamp could not be verified against the source (missing or short stamp, unreadable or uncommitted source) - not proven up to date',
      };
    }
    return { action: 'skip', reason: SKIP_REASON.CLEAN };
  }
  if (classified.degraded) {
    return { action: 'skip', reason: SKIP_REASON.UNCLASSIFIABLE, detail: 'no ownership sidecar and no readable git-ignore state' };
  }
  const commitSha = manifest?.commitSha;
  if (typeof commitSha !== 'string' || commitSha.length < 8) {
    return { action: 'skip', reason: SKIP_REASON.NO_MANIFEST, detail: 'scripts/.sync-manifest.json has no commitSha' };
  }
  const addPaths = [...new Set([...classified.syncOwned.map((e) => e.path), ...(gitignoreRides ? [GITIGNORE_PATH] : [])])].sort();
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
  const commitPathspecs = [...new Set([...pathspecsForCommit(classified.syncOwned), ...(gitignoreRides ? [GITIGNORE_PATH] : [])])].sort();
  if (classifyBaseLag({ baseBranch, baseSha, currentBranch, aheadCount, behindCount }) === 'behind') {
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
  const leftBehind = [
    ...classified.needsReview.map((e) => e.path),
    ...(gitignoreTransition && !gitignoreRides && gitignoreTransition !== 'unchanged' ? [`${GITIGNORE_PATH} (${GITIGNORE_LEFT_BEHIND_REASON[gitignoreTransition] ?? 'could not be verified as managed-block-only'})`] : []),
  ].sort();
  const repo = manifest.repo ?? DEFAULT_REPO;
  const text = buildPrText({ repo, commitSha, surface, leftBehind, consumerName });
  return {
    action: 'pr',
    branch,
    bundleSha: commitSha,
    repo,
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
  const lag = gatherBaseFacts(run, repoRoot, { baseBranch });
  if (!lag.ok) return lag;
  const { baseBranch: base, baseSha, behindCount } = lag;
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
  return { ...lag, upstreamChanged, branchExists };
}

/** CSI / OSC escape sequences, so a coloured reporter's lines still match. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Failing test names out of a consumer hook's output, so a refused push
 * names WHAT failed rather than only "Tests 2 failed | 19805 passed". Each
 * runner contributes its first matching shape (so one failure is never listed
 * twice in two spellings), and the runners are unioned. PURE; [] when nothing
 * parses.
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
  // Test-level shapes grouped by runner, most specific first within each.
  // One runner spells one failure several ways (vitest: a `×` mark AND a FAIL
  // summary line; jest: `✕` AND `●`), so a runner contributes only its first
  // matching shape. A hook may run several runners, so the runners' lists are
  // unioned — the first runner's failures never hide the second's.
  const MARK_TAIL = '(?:\\s+\\(?\\d+(?:\\.\\d+)?\\s*m?s\\)?)?\\s*$';
  const families = [
    [/^\s*FAIL\s+(\S.*? > .+?)\s*$/, new RegExp(`^\\s*×\\s+(.+?)${MARK_TAIL}`)], // vitest
    [/^\s*● (?!Console\b)(.+?)\s*$/, new RegExp(`^\\s*✕\\s+(.+?)${MARK_TAIL}`)], // jest
    [/^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/], // node:test tap
    [new RegExp(`^\\s*[✖✗]\\s+(.+?)${MARK_TAIL}`)], // node:test spec
  ];
  const found = [];
  for (const shapes of families) {
    for (const re of shapes) {
      const names = collect(re);
      if (names.length === 0) continue;
      for (const n of names) if (!found.includes(n)) found.push(n);
      break;
    }
  }
  if (found.length > 0) return found.slice(0, cap);
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

/** Why an older open sync PR was left open. Strings are the CLI's contract. */
export const SUPERSEDE_KEEP_REASON = Object.freeze({
  INVALID_RECORD: 'invalid-record',
  NOT_OURS: 'not-ours',
  EVIDENCE_UNAVAILABLE: 'evidence-unavailable',
  HAND_EDITED: 'hand-edited',
  OWNERSHIP_UNKNOWN: 'ownership-unknown',
  PROVENANCE_MISMATCH: 'provenance-mismatch',
  NOT_OLDER: 'not-older',
  BUNDLE_ORDER_UNKNOWN: 'bundle-order-unknown',
  SUCCESSOR_UNAVAILABLE: 'successor-unavailable',
  CHANGED_BEFORE_CLOSE: 'changed-before-close',
  CLOSE_FAILED: 'close-failed',
});

/** Open PRs read per consumer. A page this full may have missed some. */
export const SUPERSEDE_LIST_LIMIT = 1000;
const SUPERSEDE_LIST_FIELDS = 'number,url,headRefName,baseRefName,isCrossRepository,headRefOid';
const SHORT_SHA = /^[0-9a-f]{8}$/;
const FULL_OID = /^[0-9a-f]{40}$/;
/** The receipt and the sidecar are written by every sync but listed in neither. */
const ALWAYS_SYNC_OWNED = new Set([RECEIPT_KEY, comparisonKey(OWNED_SIDECAR_RELATIVE_PATH)]);
/** `upstreamDir` default: git discovers the upstream repo from this module's own directory. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** @param {string} branch @returns {boolean} the `branchNameFor` shape */
const isSyncBranch = (branch) => typeof branch === 'string'
  && branch.startsWith(SYNC_BRANCH_PREFIX) && SHORT_SHA.test(branch.slice(SYNC_BRANCH_PREFIX.length));

/**
 * Validate `gh pr list --json <SUPERSEDE_LIST_FIELDS>` output. PURE.
 * Non-sync heads are ignored; a sync-shaped head with any malformed field is
 * `invalid` (reported and kept open — never closed on a record it cannot read).
 *
 * @param {string} text
 * @param {{excludeBranch?: string, limit?: number}} [opts] — `excludeBranch`: the new PR's own branch
 * @returns {null | {records: Array<{number:number, url:string, branch:string, baseRefName:string,
 *   isCrossRepository:boolean, headRefOid:string}>, invalid: Array<{number:unknown, url:unknown, branch:string}>, full: boolean}}
 *   — null when the output is not a JSON array: an unread list is not an empty one
 */
export function parseOpenSyncPrs(text, { excludeBranch, limit = SUPERSEDE_LIST_LIMIT } = {}) {
  let raw;
  try { raw = JSON.parse(String(text ?? '')); } catch { return null; }
  if (!Array.isArray(raw)) return null;
  const records = [];
  const invalid = [];
  for (const r of raw) {
    const branch = r?.headRefName;
    if (!isSyncBranch(branch) || branch === excludeBranch) continue;
    const valid = Number.isSafeInteger(r.number) && r.number > 0
      && typeof r.url === 'string' && typeof r.baseRefName === 'string'
      && typeof r.isCrossRepository === 'boolean'
      && typeof r.headRefOid === 'string' && FULL_OID.test(r.headRefOid);
    if (valid) {
      records.push({ number: r.number, url: r.url, branch, baseRefName: r.baseRefName, isCrossRepository: r.isCrossRepository, headRefOid: r.headRefOid });
    } else {
      invalid.push({ number: r.number ?? null, url: r.url ?? null, branch });
    }
  }
  return { records, invalid, full: raw.length >= limit };
}

/**
 * `git diff --name-status --no-renames -z` → `[{status, path}]`. PURE. With
 * renames off every record is exactly one status field then one path.
 * @param {string} text
 * @returns {Array<{status: string, path: string}>|null} null on a malformed (odd) record stream
 */
export function parseNameStatus(text) {
  const parts = String(text ?? '').split('\0');
  if (parts.at(-1) === '') parts.pop();
  if (parts.length % 2 !== 0) return null;
  const out = [];
  for (let i = 0; i < parts.length; i += 2) out.push({ status: parts[i].charAt(0), path: parts[i + 1] });
  return out;
}

/**
 * Gather the git evidence `decideSupersession` judges, in the consumer
 * checkout and (for bundle order) the upstream repo. Every git call goes
 * through `run`; ancestry through the injected three-valued oracle. Never
 * throws — a missing piece is `null`, which the decision reads as "not proven".
 *
 * @param {Runner} run
 * @param {{repoRoot: string, record: {branch: string, headRefOid: string}, baseSha: string,
 *   ancestry: (a: string, b: string) => 'yes'|'no'|'unknown', newBundleSha: string}} input
 * @returns {{fetchedOid: string|null, commitCount: number|null, changes: Array<{status: string, path: string}>|null,
 *   headSidecar: object|null, baseSidecar: object|null, receiptEntry: object|null,
 *   ancestry: 'yes'|'no'|'unknown'|'equal'|null, detail: string|null}}
 */
function collectSupersedeEvidence(run, { repoRoot, record, baseSha, ancestry, newBundleSha }) {
  const git = (args) => run('git', ['-C', repoRoot, ...args]);
  const ev = {
    fetchedOid: null, commitCount: null, changes: null, headSidecar: null, baseSidecar: null, receiptEntry: null, ancestry: null, detail: null,
  };
  const ref = `refs/remotes/origin/${record.branch}`;
  const fetched = git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${record.branch}:${ref}`]);
  if (!ok(fetched)) return { ...ev, detail: `fetch ${record.branch}: ${why(fetched)}` };
  const head = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  ev.fetchedOid = ok(head) ? head.stdout.trim() : null;
  if (ev.fetchedOid !== record.headRefOid) return { ...ev, detail: `fetched ${ev.fetchedOid ?? 'nothing'}, listed ${record.headRefOid}` };
  const oid = ev.fetchedOid;

  const count = git(['rev-list', '--count', `${baseSha}..${oid}`]);
  ev.commitCount = ok(count) && /^\d+$/.test(count.stdout.trim()) ? Number(count.stdout.trim()) : null;
  const mb = git(['merge-base', baseSha, oid]);
  const mergeBase = ok(mb) ? mb.stdout.trim() : '';
  if (FULL_OID.test(mergeBase)) {
    const diff = git(['diff', '--name-status', '--no-renames', '-z', mergeBase, oid, '--']);
    ev.changes = ok(diff) ? parseNameStatus(diff.stdout) : null;
  }
  const showJson = (rev, rel) => {
    const r = git(['show', `${rev}:${rel}`]);
    if (!ok(r)) return null;
    try { return JSON.parse(r.stdout); } catch { return null; }
  };
  ev.headSidecar = showJson(oid, OWNED_SIDECAR_RELATIVE_PATH);
  if (FULL_OID.test(mergeBase)) ev.baseSidecar = showJson(mergeBase, OWNED_SIDECAR_RELATIVE_PATH);
  const receipt = showJson(oid, RECEIPT_PATH);
  ev.receiptEntry = receipt === null ? null : latestReceiptEntry(readSyncReceipt(receipt));

  // Bundle order is asked only of a full OID the candidate's own receipt
  // attests — never of the branch's abbreviation, which a ref could shadow.
  const attested = ev.receiptEntry?.source?.commitSha;
  if (typeof attested === 'string' && FULL_OID.test(attested)) {
    ev.ancestry = attested === newBundleSha ? 'equal' : ancestry(attested, newBundleSha);
  }
  return ev;
}

/**
 * Does the new sync PR replace this older open one? PURE — every keep is a
 * named reason, and only a fully evidenced pure older sync PR is superseded.
 *
 * @param {{branch: string, baseRefName: string, isCrossRepository: boolean, headRefOid: string}} record
 * @param {ReturnType<typeof collectSupersedeEvidence>|null} evidence — null when none was gathered
 * @param {{baseBranch: string, repo: string}} ctx
 * @returns {{supersede: true} | {supersede: false, reason: string, detail?: string}}
 */
export function decideSupersession(record, evidence, { baseBranch, repo }) {
  const keep = (reason, detail) => ({ supersede: false, reason, ...(detail ? { detail } : {}) });
  if (record.isCrossRepository || record.baseRefName !== baseBranch) {
    return keep(SUPERSEDE_KEEP_REASON.NOT_OURS, record.isCrossRepository ? 'from a fork' : `targets ${record.baseRefName}`);
  }
  if (!evidence || evidence.fetchedOid !== record.headRefOid || evidence.commitCount === null || !Array.isArray(evidence.changes)) {
    return keep(SUPERSEDE_KEEP_REASON.EVIDENCE_UNAVAILABLE, evidence?.detail ?? 'no git evidence gathered');
  }
  if (evidence.commitCount !== 1) {
    return keep(SUPERSEDE_KEEP_REASON.HAND_EDITED, `${evidence.commitCount} commits over its base — sync:pr makes one`);
  }
  if (!isUsableSidecar(evidence.headSidecar)) {
    return keep(SUPERSEDE_KEEP_REASON.OWNERSHIP_UNKNOWN, `no usable ${OWNED_SIDECAR_RELATIVE_PATH} at its head`);
  }
  // Its OWN sidecar (the new sync's would call a file a newer bundle dropped
  // hand-made). The merge-base's sidecar may authorise only a DELETION — the
  // sync retiring a file it used to own — never a change to a path the PR's
  // own sync no longer claims.
  const owned = ({ status, path: p }) => ALWAYS_SYNC_OWNED.has(comparisonKey(p))
    || isUpstreamOwned(evidence.headSidecar, p) || (status === 'D' && isUpstreamOwned(evidence.baseSidecar, p));
  const foreign = evidence.changes.filter((c) => !owned(c)).map((c) => c.path);
  if (foreign.length > 0) {
    const shown = foreign.slice(0, 5).join(', ') + (foreign.length > 5 ? ` (+${foreign.length - 5} more)` : '');
    return keep(SUPERSEDE_KEEP_REASON.HAND_EDITED, `changes files the sync does not own: ${shown}`);
  }
  const source = evidence.receiptEntry?.source;
  const short = record.branch.slice(SYNC_BRANCH_PREFIX.length);
  if (!source || typeof source.commitSha !== 'string' || !FULL_OID.test(source.commitSha)
    || !source.commitSha.startsWith(short) || source.repo !== repo) {
    return keep(SUPERSEDE_KEEP_REASON.PROVENANCE_MISMATCH,
      `its receipt attests ${source?.repo ?? '(no repo)'} ${source?.commitSha ?? '(no sha)'}, the branch names ${repo} ${short}`);
  }
  if (evidence.ancestry === 'equal' || evidence.ancestry === 'no') {
    return keep(SUPERSEDE_KEEP_REASON.NOT_OLDER,
      `its bundle ${source.commitSha.slice(0, 8)} is not older than this sync's — if it is newer, THIS PR may be the stale one`);
  }
  if (evidence.ancestry !== 'yes') {
    return keep(SUPERSEDE_KEEP_REASON.BUNDLE_ORDER_UNKNOWN, `could not order bundle ${source.commitSha.slice(0, 8)} against this sync's in the upstream repo`);
  }
  return { supersede: true };
}

/**
 * Close every older open sync PR the new one provably replaces (header rule
 * 4). Runs after the new PR exists, so a consumer is never left with no open
 * sync PR. Never fails the caller: every problem is a warning, and the status
 * says how far it got. Exported so a retry path can run it without re-creating
 * the new PR.
 *
 * @param {{
 *   gh: (args: string[]) => ReturnType<Runner>, run: Runner,
 *   ancestry: (a: string, b: string) => 'yes'|'no'|'unknown',
 *   repoRoot: string, repo: string, baseBranch: string, baseSha: string,
 *   newBranch: string, newBundleSha: string, newUrl: string|null, log?: (line: string) => void,
 * }} input
 * @returns {{status: 'none'|'complete'|'partial'|'incomplete-discovery'|'failed',
 *   superseded: Array<{number:number, url:string, branch:string}>,
 *   kept: Array<{number:unknown, url:unknown, branch:string, reason:string, detail?:string}>, warnings: string[]}}
 */
export function supersedeOlderSyncPrs({
  gh, run, ancestry, repoRoot, repo, baseBranch, baseSha, newBranch, newBundleSha, newUrl, log = () => {},
}) {
  const out = { status: 'none', superseded: [], kept: [], warnings: [] };
  const listed = gh(['pr', 'list', '--state', 'open', '--base', baseBranch, '--limit', String(SUPERSEDE_LIST_LIMIT), '--json', SUPERSEDE_LIST_FIELDS]);
  const parsed = ok(listed) ? parseOpenSyncPrs(listed.stdout, { excludeBranch: newBranch }) : null;
  if (!parsed) {
    out.status = 'failed';
    out.warnings.push(`could not list open PRs to supersede (${ok(listed) ? 'unparseable gh output' : why(listed)}) — an older sync PR may still be open and will conflict on ${RECEIPT_PATH}`);
    return out;
  }
  const successor = newUrl ?? `the ${newBranch} PR`;
  const comment = `Superseded by ${successor}, the sync of a newer upstream bundle built from the current ${baseBranch}. `
    + 'Closed automatically by `npm run sync:pr`: synced files are upstream-owned, and two open sync PRs conflict on '
    + `${RECEIPT_PATH}. The branch is kept, so this PR can be reopened.`;
  const keep = (pr, reason, detail) => {
    out.kept.push({ number: pr.number, url: pr.url, branch: pr.branch, reason, ...(detail ? { detail } : {}) });
    out.warnings.push(`kept older sync PR #${pr.number} (${pr.branch}) open: ${reason}${detail ? ` — ${detail}` : ''}`);
  };

  /** `gh pr view <ref>` → `{state, headRefOid, baseRefName, isCrossRepository}`, or null when unreadable. */
  const readOpenPr = (ref) => {
    const view = gh(['pr', 'view', ref, '--json', 'state,headRefOid,baseRefName,isCrossRepository']);
    try { return ok(view) ? JSON.parse(view.stdout) : null; } catch { return null; }
  };
  let successorOpen = null;

  for (const pr of parsed.invalid) keep(pr, SUPERSEDE_KEEP_REASON.INVALID_RECORD, 'gh returned a record that failed validation');
  for (const pr of parsed.records) {
    const foreign = pr.isCrossRepository || pr.baseRefName !== baseBranch;
    const evidence = foreign ? null : collectSupersedeEvidence(run, { repoRoot, record: pr, baseSha, ancestry, newBundleSha });
    const verdict = decideSupersession(pr, evidence, { baseBranch, repo });
    if (!verdict.supersede) { keep(pr, verdict.reason, verdict.detail); continue; }

    // The successor must still be open: closing in favour of a PR someone
    // already closed would leave the consumer with no open sync PR at all.
    if (successorOpen === null) successorOpen = readOpenPr(newUrl ?? newBranch)?.state === 'OPEN';
    if (!successorOpen) {
      keep(pr, SUPERSEDE_KEEP_REASON.SUCCESSOR_UNAVAILABLE, `${successor} is not open`);
      continue;
    }
    // GitHub has no head-conditional close: re-read just before closing and
    // re-apply the SAME decision to the fresh base/head, which narrows the
    // evidence→close window to one round trip but cannot remove it.
    const now = readOpenPr(String(pr.number));
    const fresh = now && { ...pr, baseRefName: now.baseRefName, isCrossRepository: now.isCrossRepository, headRefOid: now.headRefOid };
    if (now?.state !== 'OPEN' || !decideSupersession(fresh, evidence, { baseBranch, repo }).supersede) {
      keep(pr, SUPERSEDE_KEEP_REASON.CHANGED_BEFORE_CLOSE,
        now ? `now ${now.state} at ${now.headRefOid} on ${now.baseRefName}` : 'could not re-read it');
      continue;
    }
    const closed = gh(['pr', 'close', String(pr.number), '--comment', comment]);
    if (!ok(closed)) {
      keep(pr, SUPERSEDE_KEEP_REASON.CLOSE_FAILED,
        `${why(closed)} — finish by hand: gh pr close ${pr.number} --comment "Superseded by ${successor}"`);
      continue;
    }
    out.superseded.push({ number: pr.number, url: pr.url, branch: pr.branch });
    log(`  superseded older sync PR #${pr.number} (${pr.branch}) — closed, branch kept`);
  }

  if (parsed.full) {
    out.status = 'incomplete-discovery';
    out.warnings.push(`discovery incomplete: gh returned ${SUPERSEDE_LIST_LIMIT} open PRs (its limit) — an older sync PR beyond it was not examined`);
  } else if (out.kept.length > 0) {
    out.status = 'partial';
  } else if (out.superseded.length > 0) {
    out.status = 'complete';
  }
  return out;
}

/**
 * `gh` with the account fallback: if the active account cannot resolve the
 * repo (this machine signs in to two GitHub accounts; each consumer belongs to
 * one), the other signed-in accounts are tried in turn. `restore()` switches
 * back to the original active account and returns a warning when it cannot.
 * The ONE implementation, shared by `runConsumerPr` and `retrySupersession`.
 *
 * @param {{run: Runner, repoRoot: string, log?: (line: string) => void}} input
 * @returns {{gh: (args: string[], opts?: {input?: string}) => ReturnType<Runner>, restore: () => string|null}}
 */
function createGhWithAccountFallback({ run, repoRoot, log = () => {} }) {
  const state = { original: null, current: null };
  const gh = (args, opts = {}) => {
    let r = run('gh', args, { cwd: repoRoot, ...opts });
    if (ok(r) || !isRepoNotResolvable(`${r.stderr}\n${r.stdout}`)) return r;
    const status = run('gh', ['auth', 'status'], { cwd: repoRoot });
    const accounts = parseGhAccounts(`${status.stdout}\n${status.stderr}`);
    const active = accounts.find((a) => a.active);
    if (state.original === null) state.original = active?.login ?? null;
    for (const acct of accounts.filter((a) => !a.active)) {
      log(`  gh: ${active?.login ?? '(unknown)'} cannot see this repo — retrying as ${acct.login}`);
      const sw = run('gh', ['auth', 'switch', '-u', acct.login], { cwd: repoRoot });
      if (!ok(sw)) continue;
      state.current = acct.login;
      r = run('gh', args, { cwd: repoRoot, ...opts });
      if (ok(r)) return r;
    }
    return r;
  };
  const restore = () => {
    if (!state.original || !state.current || state.current === state.original) return null;
    const back = run('gh', ['auth', 'switch', '-u', state.original], { cwd: repoRoot });
    return ok(back) ? null : `gh active account left as ${state.current}; \`gh auth switch -u ${state.original}\` to restore`;
  };
  return { gh, restore };
}

/**
 * Which existing sync PR a run that opens none should retry supersession for,
 * or null. PURE. The retry is remote-only (it never touches the working tree),
 * so ANY skip qualifies once the current bundle's sync branch exists: the
 * same-bundle re-run that reaches `BRANCH_EXISTS` after a fresh `sync`, AND
 * the bare `sync:pr` re-run that reaches `CLEAN` because the first run
 * committed the synced files onto that branch (code audit R1 M2).
 *
 * @param {{plan: ReturnType<typeof planConsumerPr>, manifest: {repo?: string, commitSha?: string|null}|null, branchExists: boolean}} input
 * @returns {{branch: string, bundleSha: string, repo: string}|null}
 */
export function supersessionRetryTarget({ plan, manifest, branchExists }) {
  const commitSha = manifest?.commitSha;
  if (plan?.action !== 'skip' || !branchExists || typeof commitSha !== 'string' || !FULL_OID.test(commitSha)) return null;
  return { branch: branchNameFor(commitSha), bundleSha: commitSha, repo: manifest.repo ?? DEFAULT_REPO };
}

/** Why `retrySupersession` ran nothing. Strings are the CLI's contract. */
export const SUPERSEDE_RETRY_SKIP = Object.freeze({
  NO_PR: 'no-pr',
  PR_UNREADABLE: 'pr-unreadable',
  NOT_OPEN: 'not-open',
  OTHER_BASE: 'other-base',
  SUCCESSOR_UNVERIFIED: 'successor-unverified',
});

/**
 * Header rule 4, retried (audit M2 of the supersede change). A re-run of the
 * same bundle never reaches `runConsumerPr` — it skips at `BRANCH_EXISTS`
 * (after a fresh sync) or `CLEAN` (the first run committed the synced files) —
 * so a supersession that failed on the first run (a list or close failure,
 * incomplete discovery) would otherwise never be retried, and that PR's
 * auto-merge stays withheld. This resolves the EXISTING PR for the branch
 * and runs `supersedeOlderSyncPrs` for it against the freshly fetched base.
 *
 * It never creates a commit, a branch or a PR, never switches the checkout,
 * and never arms auto-merge: whether to merge the existing PR once its
 * supersession settles stays a person's call (its own run withheld it).
 *
 * @param {{
 *   branch: string, bundleSha: string, repo: string, — from `supersessionRetryTarget`
 *   repoRoot: string, baseBranch: string, baseSha: string, — `baseSha`: origin/<base> as freshly fetched
 *   run: Runner, log?: (line: string) => void,
 *   ancestry?: (a: string, b: string) => 'yes'|'no'|'unknown',
 * }} input
 * @returns {{retried: true, url: string, supersede: ReturnType<typeof supersedeOlderSyncPrs>, warnings: string[]}
 *   | {retried: false, reason: string, detail: string, warnings: string[]}}
 */
export function retrySupersession({
  branch, bundleSha, repo, repoRoot, baseBranch, baseSha, run, log = () => {}, ancestry = createGitAncestry(MODULE_DIR),
}) {
  const warnings = [];
  const { gh, restore } = createGhWithAccountFallback({ run, repoRoot, log });
  try {
    const skip = (reason, detail) => ({ retried: false, reason, detail, warnings });
    const view = gh(['pr', 'view', branch, '--json', 'url,state,headRefOid,baseRefName']);
    if (!ok(view)) {
      // An absent PR and an unreadable one must not leave as the same value.
      const text = why(view);
      return /no (open )?pull requests? found/i.test(text) ? skip(SUPERSEDE_RETRY_SKIP.NO_PR, `${branch} has no PR`) : skip(SUPERSEDE_RETRY_SKIP.PR_UNREADABLE, text);
    }
    let pr = null;
    try { pr = JSON.parse(view.stdout); } catch { /* validated below */ }
    if (!pr || typeof pr.url !== 'string' || typeof pr.state !== 'string' || typeof pr.baseRefName !== 'string'
      || typeof pr.headRefOid !== 'string' || !FULL_OID.test(pr.headRefOid)) {
      return skip(SUPERSEDE_RETRY_SKIP.PR_UNREADABLE, 'gh returned a record that failed validation');
    }
    if (pr.state !== 'OPEN') return skip(SUPERSEDE_RETRY_SKIP.NOT_OPEN, `${pr.url} is ${pr.state}`);
    if (pr.baseRefName !== baseBranch) return skip(SUPERSEDE_RETRY_SKIP.OTHER_BASE, `${pr.url} targets ${pr.baseRefName}, not ${baseBranch}`);
    // The creating run KNOWS its successor carries this bundle; a retry is
    // handed a remote PR, so it proves it the way a candidate is proven: the
    // head gh names is the head git fetched, and that head's own receipt
    // attests exactly this bundle from this repo (code audit R3 H1).
    const ev = collectSupersedeEvidence(run, { repoRoot, record: { branch, headRefOid: pr.headRefOid }, baseSha, ancestry, newBundleSha: bundleSha });
    const source = ev.receiptEntry?.source;
    if (ev.fetchedOid !== pr.headRefOid || source?.commitSha !== bundleSha || source?.repo !== repo) {
      return skip(SUPERSEDE_RETRY_SKIP.SUCCESSOR_UNVERIFIED, ev.detail
        ?? `${pr.url}'s receipt attests ${source?.repo ?? '(no repo)'} ${source?.commitSha ?? '(no sha)'}, not ${repo} ${bundleSha}`);
    }

    const supersede = supersedeOlderSyncPrs({
      gh, run, ancestry, repoRoot, repo, baseBranch, baseSha, newBranch: branch, newBundleSha: bundleSha, newUrl: pr.url, log,
    });
    warnings.push(...supersede.warnings);
    return { retried: true, url: pr.url, supersede, warnings };
  } finally {
    const warning = restore();
    if (warning) warnings.push(warning);
  }
}

/**
 * Execute one planned PR. Every process call goes through `run`; nothing here
 * touches git or gh directly. On ANY failure after the branch was created the
 * consumer is switched back to `currentBranch` and the branch is left in
 * place for inspection — a half-done sync PR must never leave the human's
 * checkout on a branch they did not ask for.
 *
 * Every gh call goes through `createGhWithAccountFallback`, and the original
 * active account is restored before returning.
 *
 * @param {{
 *   plan: Extract<ReturnType<typeof planConsumerPr>, {action:'pr'}>,
 *   repoRoot: string, baseBranch: string, currentBranch: string, merge: boolean,
 *   run: Runner, log?: (line: string) => void,
 *   consumerName?: string, pushLogDir?: string|null, — where a refused push's full output is kept
 *   ancestry?: (a: string, b: string) => 'yes'|'no'|'unknown', — bundle order in the upstream repo (header rule 4)
 * }} input
 * @returns {{ok: true, branch: string, url: string|null, merged: 'armed'|'not-armed'|'skipped',
 *     supersede: ReturnType<typeof supersedeOlderSyncPrs>, warnings: string[]}
 *   | {ok: false, branch: string, step: string, error: string, warnings: string[],
 *      pushLog?: ReturnType<typeof writePushFailureLog>}}
 */
export async function runConsumerPr({
  plan, repoRoot, baseBranch, currentBranch, merge, run, log = () => {}, consumerName = path.basename(repoRoot), pushLogDir = null,
  ancestry = createGitAncestry(MODULE_DIR), signal = null,
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
  const { gh, restore } = createGhWithAccountFallback({ run, repoRoot, log });
  const restoreGhAccount = () => {
    const warning = restore();
    if (warning) warnings.push(warning);
  };
  const fail =(step, r) => ({ ok: false, branch: plan.branch, step, error: why(r), warnings });
  // Cancellation is STEP-WISE (plan D7): git and gh run through a synchronous runner, so a step in flight cannot be interrupted
  // and a signal handler can only run when the event loop does. Yield before each step, and stop before the next one if aborted.
  let pushedOk = false;
  const cancelled = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return signal?.aborted === true;
  };
  const stopped = () => ({ ok: false, branch: plan.branch, step: 'aborted', error: 'cancelled by a signal before the next step', pushed: pushedOk, warnings });
  if (await cancelled()) return stopped();

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
    if (await cancelled()) { switchBack(); return stopped(); }
    const added = gitLiteral(['add', '--', ...plan.addPaths]);
    if (!ok(added)) { switchBack(); return fail('add', added); }
    if (await cancelled()) { switchBack(); return stopped(); }
    const committed = gitLiteral(['commit', '-q', '-m', plan.message, '--', ...plan.commitPathspecs]);
    if (!ok(committed)) { switchBack(); return fail('commit', committed); }
    if (await cancelled()) { switchBack(); return stopped(); }
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

    pushedOk = true;
    if (await cancelled()) { switchBack(); return stopped(); }
    const create = gh(['pr', 'create', '--base', baseBranch, '--head', plan.branch, '--title', plan.title, '--body-file', '-'], { input: plan.body });
    if (!ok(create)) { switchBack(); return fail('gh pr create', create); }
    const url = (String(create.stdout).match(/https?:\/\/\S+/g) || []).pop() ?? null;

    // Header rule 4: only now that the successor exists, and before its
    // auto-merge is armed (the shortest window for an older one to land).
    const supersede = supersedeOlderSyncPrs({
      gh, run, ancestry, repoRoot, repo: plan.repo, baseBranch, baseSha: plan.startPoint,
      newBranch: plan.branch, newBundleSha: plan.bundleSha, newUrl: url, log,
    });
    warnings.push(...supersede.warnings);

    let merged = 'skipped';
    // Arming auto-merge while another sync PR may still be open recreates the
    // receipt conflict this step exists to remove — and when that PR is NEWER,
    // it lands a stale sync over it. A person resolves the named PR(s) first.
    const supersedeSettled = supersede.status === 'none' || supersede.status === 'complete';
    if (merge && !supersedeSettled) {
      merged = 'not-armed';
      warnings.push(`auto-merge withheld: supersession is ${supersede.status}, so another sync PR may still be open and would conflict on ${RECEIPT_PATH} — resolve the PR(s) named above, then merge this one by hand`);
    } else if (merge) {
      const mergeArgs = ['pr', 'merge', ...(url ? [url] : []), '--auto', '--squash', '--delete-branch'];
      const m = gh(mergeArgs);
      if (ok(m)) merged = 'armed';
      else {
        merged = 'not-armed';
        warnings.push(`auto-merge not armed: ${why(m)} — enable "Allow auto-merge" in the repo settings, or merge the PR by hand`);
      }
    }
    switchBack();
    return { ok: true, branch: plan.branch, url, merged, supersede, warnings };
  } finally {
    restoreGhAccount();
  }
}

/**
 * The SOURCE repo's HEAD and whether its tree is dirty - the two facts `planConsumerPr` needs to say whether a 'clean' consumer is
 * actually current (da9a). Any git failure yields `undefined` for that fact, which the planner reads as UNVERIFIED, never as current.
 *
 * @param {Runner} run
 * @param {string} sourceRoot
 * @returns {{sourceSha: string|undefined, sourceDirty: boolean|undefined}}
 */
export function gatherSourceFacts(run, sourceRoot) {
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot });
  const status = run('git', ['status', '--porcelain'], { cwd: sourceRoot });
  return {
    sourceSha: ok(head) ? head.stdout.trim() : undefined,
    sourceDirty: ok(status) ? status.stdout.trim().length > 0 : undefined,
  };
}

/**
 * What the sync did to the consumer's `.gitignore`, compared with the commit the PR branch will fork from (`baseSha`, never the local
 * HEAD - that is the stale-base lesson of header rule 3). IMPURE; never throws. "The path is absent at the base" and "git could not
 * answer" are different outcomes: the first is a legitimate new file, the second is `unverified` and the file is left behind.
 *
 * @param {Runner} run
 * @param {string} repoRoot
 * @param {string|null} baseSha
 * @returns {'unchanged'|'block-only'|'mixed'|'invalid'|'unverified'}
 */
export function gatherGitignoreTransition(run, repoRoot, baseSha) {
  if (typeof baseSha !== 'string' || !baseSha) return 'unverified';
  let work;
  try {
    work = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf-8');
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'unchanged' : 'unverified';
  }
  const tree = run('git', ['ls-tree', baseSha, '--', '.gitignore'], { cwd: repoRoot });
  if (!ok(tree)) return 'unverified';
  let head = null;
  if (tree.stdout.trim()) {
    const shown = run('git', ['show', `${baseSha}:.gitignore`], { cwd: repoRoot });
    if (!ok(shown)) return 'unverified';
    head = shown.stdout;
  }
  return classifyGitignoreTransition(head, work);
}
