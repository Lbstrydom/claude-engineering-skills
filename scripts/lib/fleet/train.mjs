/**
 * @fileoverview /fleet's integration train — build, test, resume and abandon.
 * (Approval, confirmation and reconciliation live in `train-approve.mjs`: they
 * are the OUTWARD half and share nothing with the tiering loop but the manifest.)
 *
 * Everything before approval is disposable and local: write the manifest FIRST
 * (write-ahead), create a detached integration worktree OUTSIDE `.git`, apply the
 * selected sources in landing order, record `candidate:{oid,tree}` BEFORE any
 * test runs, run the consumer hook, provision dependencies from the CANDIDATE
 * (not the base), then run the tiers with integrity rules around every one:
 * a clean tree and a HEAD whose commit and tree equal the candidate, before AND
 * after; red → `git reset --hard <oid> && git clean -fdx -e node_modules`, re-assert,
 * rerun once. Tier results are written as each tier finishes, so a 50-minute
 * chain survives an interrupted terminal (`resumeTrain`).
 *
 * Every process call goes through an injectable `deps` object (git, gh, the tier
 * runner, provisioning, the clock, and crash hooks) so a test can fake `gh`,
 * assert the exact emitted `git push` argv, and simulate a kill between steps.
 * Read-only facts come from `git-facts.mjs`.
 *
 * Plan: docs/plans/fleet-multi-session-coordination.md §2 Train mechanics, §2b, §7 (Phase 5).
 *
 * @module scripts/lib/fleet/train
 */
import fs from 'node:fs';
import { isMatch } from '../glob.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withFileLockSync } from '../file-lock.mjs';
import { dependencySetChanged } from '../dependency-identity.mjs';
import { provisionNodeModules, removeFixture } from '../pinned-worktree/manage.mjs';
import {
  runGit, headOf, remoteRefOid, resolveRemoteUrls, gitCommonDir, repoToplevel, parseWorktreePorcelain,
} from './git-facts.mjs';
import { materializePrRef } from './gh-facts.mjs';
import { sleepSync } from './remote-read.mjs';
import { runChecks, buildCheckPayload } from './checks.mjs';
import { resolveAppendOnly } from './union-merge.mjs';
import { superviseTier } from './tier-supervisor.mjs';
import { approvable, tiersOf, worstResult } from './overlap.mjs';
import { guardOnlyRed } from './tier-acceptance.mjs';
import { assertManaged, fleetDir, mintTrainId, probesDir, readTrain, writeTrain } from './registry.mjs';
import { rollupMessage } from './rollup.mjs';
import { readTail } from './tier-failure.mjs';
import { DEFAULT_GIT_TIMEOUT_MS, RERUN_FILES_TOKEN } from './contracts.mjs';
import { classifyAttemptLog } from '../test-outcome-marker.mjs';
import { FAILED_FILES_MARKER, parseFailedFilesPayload } from '../failed-files-marker.mjs';

const DEP_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']);
const WIN_SHIMS = /^(?:npm|npx|pnpm|yarn)$/i;
/** Tokens a Windows shell may receive UNQUOTED and unexpanded. Nothing is ever hand-quoted. */
const SAFE_SHELL_TOKEN = /^[A-Za-z0-9_@+=:,./\\-]+$/;
export const UNSAFE_WIN_SHELL_ARGV = 'unsafe-windows-shell-argv';

/**
 * Would handing this argv to cmd.exe be unsafe? Any element outside the plain
 * token set (which excludes every one of & | < > ^ % ! " and newlines, plus
 * whitespace) is unsafe: cmd.exe expands %VAR% even inside quotes, so no
 * hand-quoting makes it safe - such a tier is REFUSED instead.
 * @param {string[]} argv
 */
export const unsafeWinShellArgv = (argv) => argv.some((a) => typeof a !== 'string' || !SAFE_SHELL_TOKEN.test(a));

/**
 * Decide HOW a tier is spawned. Pure (platform and filesystem are injectable).
 *  - tier.shell (a string testCommand): shell syntax by definition, run through the platform shell; marked in the manifest.
 *  - Windows npm/npx: `node <npm-cli.js>` located beside the running node, shell:false.
 *  - Windows pnpm/yarn (no safe route): a shell is used ONLY when every argv element is a plain token; otherwise REFUSED.
 *  - everything else: shell:false.
 * @returns {{file: string, args: string[], shell: boolean} | {refuse: string}}
 */
export function resolveTierSpawn({ tier, platform = process.platform, execPath = process.execPath, exists = fs.existsSync }) {
  const [exe, ...args] = tier.command;
  if (tier.shell) return { file: exe, args: [], shell: true };
  if (platform === 'win32' && WIN_SHIMS.test(exe)) {
    const base = exe.toLowerCase();
    if (base === 'npm' || base === 'npx') {
      const cli = path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', `${base}-cli.js`);
      if (exists(cli)) return { file: execPath, args: [cli, ...args], shell: false };
    }
    if (unsafeWinShellArgv([exe, ...args])) return { refuse: UNSAFE_WIN_SHELL_ARGV };
    return { file: `${exe}.cmd`, args, shell: true };
  }
  return { file: exe, args, shell: false };
}

// ── Default dependencies ────────────────────────────────────────────────────

/** Run `gh`. Never throws. @returns {{ok: boolean, status: number|null, stdout: string, stderr: string, reason: string|null}} */
export function ghRun(args, cwd) {
  const res = spawnSync('gh', args, {
    cwd, encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
  });
  if (res.error) {
    return { ok: false, status: null, stdout: '', stderr: '',
      reason: res.error.code === 'ENOENT' ? 'gh not installed' : res.error.code === 'ETIMEDOUT' ? 'gh timed out' : `gh failed to run: ${res.error.message}` };
  }
  const stderr = String(res.stderr ?? '');
  return { ok: res.status === 0, status: res.status, stdout: String(res.stdout ?? ''), stderr,
    reason: res.status === 0 ? null : `gh exited ${res.status}: ${stderr.trim().split('\n')[0] || 'no output'}` };
}

/**
 * Run one tier command in the integration worktree, output appended to `logPath`.
 * `tier.shell` (a string testCommand with shell metacharacters) is honoured; any
 * other tier is an argv with `shell:false` (see `resolveTierSpawn` for Windows shims).
 * @returns {{exitCode: number|null, timedOut: boolean, error: string|null, signal: string|null, refused?: string}}
 */
export function spawnTier({ tier, cwd, logPath, timeoutMs, platform = process.platform }) {
  const plan = resolveTierSpawn({ tier, platform });
  if (plan.refuse) return { exitCode: null, timedOut: false, error: null, signal: null, refused: plan.refuse };
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  // A timeout must end the tier's whole process tree, not just the process spawned (see tier-supervisor.mjs).
  return superviseTier({ file: plan.file, args: plan.args, shell: plan.shell, cwd, logPath, timeoutMs });
}

/** The main checkout (node_modules owner): the parent of `.git` when the common dir is one, else the toplevel. */
export function mainRootOf(cwd) {
  const c = gitCommonDir(cwd);
  const t = repoToplevel(cwd);
  if (c.ok && path.basename(c.dir) === '.git') return path.dirname(c.dir);
  return t.ok ? t.dir : cwd;
}

/** Provision `node_modules` for the candidate worktree. @returns {{ok: boolean, mode?: string, reason: string}} */
export function provisionDeps(worktree, mainRoot) {
  if (!fs.existsSync(path.join(worktree, 'package.json'))) return { ok: true, mode: 'skipped', reason: 'no package.json in the candidate' };
  try {
    const r = provisionNodeModules(worktree, mainRoot);
    return { ok: true, mode: r.mode, reason: r.reason };
  } catch (e) {
    return { ok: false, reason: `provisioning failed: ${String(e.stderr || e.message).trim().split('\n').pop()}` };
  }
}

/**
 * The default `deps`. Tests override pieces; `hooks` are crash-simulation points
 * (`afterCandidate`, `afterTier(name)`, `afterPushPending`) that a test makes throw.
 */
export function defaultDeps(over = {}) {
  const d = {
    // The train's own git calls (worktree add, merge, commit, reset, clean) take `gitTimeoutMs` (land sets it from
    // FLEET_GIT_TIMEOUT_MS / .fleet.json gitTimeoutMs); an explicit per-call timeout still wins.
    gitTimeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    git: (args, cwd, opts) => runGit(args, cwd, { timeoutMs: d.gitTimeoutMs, ...opts }),
    gh: ghRun,
    runTier: spawnTier,
    provision: provisionDeps,
    removeWorktree: ({ dir, cwd }) => removeFixture({ dir, cwd }),
    now: () => new Date(),
    log: (m) => process.stderr.write(`  [fleet] ${m}\n`),
    hooks: {},
    ...over,
  };
  return d;
}

// ── Shared plumbing ─────────────────────────────────────────────────────────

/**
 * Run `fn` under the exclusive `trains/.lock`: concurrent `land` operations on one
 * repo are refused, never queued. A live holder is never recovered.
 * @returns {object} `fn`'s result, or a refusal-shaped `{ok:false, code:'error'}`
 */
export function withTrainLock(dir, fn) {
  fs.mkdirSync(path.join(dir, 'trains'), { recursive: true });
  const r = withFileLockSync(path.join(dir, 'trains', '.lock'), { attempts: 1 }, fn);
  return r.ok ? r.value : { ok: false, code: 'error', reason: 'another land operation holds trains/.lock — wait for it to finish' };
}

const iso = (deps) => deps.now().toISOString();

/** Read-modify-write a train; `writeTrain` enforces which fields may change. */
export function patchTrain(dir, trainId, patch, deps) {
  const cur = readTrain(dir, trainId);
  if (!cur.ok) throw new Error(`train ${trainId} unreadable: ${cur.reason}`);
  return writeTrain(dir, { ...cur.train, ...patch, updatedAt: iso(deps) });
}

export const trainLogPath = (dir, trainId, tier) => assertManaged(dir, path.join(dir, 'logs', `${trainId}.${tier}.log`));

/** Why a worktree cannot be trusted as the candidate, or null. Clean tree AND HEAD commit+tree == candidate. */
export function checkIntegrity(deps, wt, cand) {
  const st = deps.git(['status', '--porcelain', '--untracked-files=all'], wt);
  if (!st.ok) return `cannot read worktree status: ${st.reason}`;
  // The provisioned node_modules link is ours; nothing else may differ.
  const dirty = st.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l && !/^\?\? node_modules\/?$/.test(l));
  if (dirty.length) return `worktree is not clean (${dirty.length} change${dirty.length === 1 ? '' : 's'}: ${dirty.slice(0, 3).join(', ')})`;
  const h = deps.git(['rev-parse', 'HEAD', 'HEAD^{tree}'], wt);
  if (!h.ok) return `cannot read worktree HEAD: ${h.reason}`;
  const [oid, tree] = h.stdout.split('\n').map((s) => s.trim());
  if (oid !== cand.oid) return `HEAD moved (${String(oid).slice(0, 12)} != candidate ${cand.oid.slice(0, 12)})`;
  if (tree !== cand.tree) return `HEAD tree differs from the candidate tree`;
  return null;
}

/**
 * Path equality as the filesystem sees it: case-insensitive ONLY on win32/darwin,
 * exact elsewhere (lower-casing conflates distinct paths on a case-sensitive fs).
 * @param {string} a @param {string} b @param {string} [platform]
 */
export function pathsEqual(a, b, platform = process.platform) {
  const x = path.resolve(a); const y = path.resolve(b);
  return platform === 'win32' || platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Remove an integration worktree - only one that is registered with git and
 * named after its train. Idempotent, and honest: every git call's exit status is
 * checked, and a "gone" worktree is verified unregistered before it is reported
 * removed.
 * @returns {{removed: boolean, reason?: string}}
 */
export function removeTrainWorktree(cwd, train, deps, { platform = process.platform } = {}) {
  const wt = train.worktree;
  if (!wt) return { removed: false, reason: 'no worktree recorded' };
  if (path.basename(wt) !== train.trainId) return { removed: false, reason: `refusing to remove ${wt}: not named after ${train.trainId}` };
  const registered = () => {
    const l = deps.git(['worktree', 'list', '--porcelain', '-z'], cwd);
    if (!l.ok) return { ok: false, reason: l.reason };
    return { ok: true, listed: parseWorktreePorcelain(l.stdout).some((w) => pathsEqual(w.path, wt, platform)) };
  };
  if (!fs.existsSync(wt)) {
    const pr = deps.git(['worktree', 'prune'], cwd);
    if (!pr.ok) return { removed: false, reason: `git worktree prune failed: ${pr.reason}` };
    const after = registered();
    if (!after.ok) return { removed: false, reason: `cannot verify the worktree registration is gone: ${after.reason}` };
    return after.listed ? { removed: false, reason: `${wt} is gone from disk but still registered with git` } : { removed: true, reason: 'already gone' };
  }
  const before = registered();
  if (!before.ok || !before.listed) return { removed: false, reason: `refusing to remove ${wt}: not a registered worktree${before.ok ? '' : ` (${before.reason})`}` };
  // A transient lock (an editor, an indexer, antivirus on Windows) often clears in a moment: three bounded attempts before giving up.
  let r = deps.removeWorktree({ dir: wt, cwd });
  for (let i = 0; i < 2 && !r.ok; i += 1) { (deps.sleep ?? sleepSync)(500 * (i + 1)); r = deps.removeWorktree({ dir: wt, cwd }); }
  return r.ok ? { removed: true } : { removed: false, reason: `worktree not fully removed: ${(r.steps ?? []).slice(-1)[0] ?? ''}` };
}

/** A throwaway empty hooks dir (`core.hooksPath`), so no consumer hook runs in a fleet-made worktree. */
export function noHooksDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-nohooks-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } } };
}

/** The branch part of `refs/heads/<x>`. */
export const branchOfRef = (ref) => String(ref).replace(/^refs\/heads\//, '');

// ── Build ───────────────────────────────────────────────────────────────────

/**
 * Validate sources against the merge method's contract and shape their manifest
 * entries. @returns {{ok: true, entries: object[]} | {ok: false, reason: string}}
 */
export function planSources(sources, { mergeMethod, expectedOid }) {
  const no = (reason) => ({ ok: false, reason });
  if (!sources.length) return no('no sources selected');
  const entries = sources.map((s) => ({
    id: s.id, gen: s.gen, rev: s.rev, oid: s.oid, kind: s.kind,
    repo: s.pr?.repo ?? s.repo ?? null, prNumber: s.pr?.number ?? s.prNumber ?? null,
    headRepo: s.pr?.headRepo ?? s.headRepo ?? null, baseRef: s.pr?.baseRef ?? s.baseRef ?? null,
    baseRefOid: s.pr?.baseOid ?? null,
  }));
  if (mergeMethod === 'pr') {
    const branchOnly = sources.filter((s) => !s.pr);
    if (branchOnly.length) return no(`mergeMethod is pr but ${branchOnly.map((s) => s.id).join(', ')} ha${branchOnly.length === 1 ? 's' : 've'} no open PR — open a PR, or set mergeMethod to a direct mode`);
    for (const [i, s] of sources.entries()) {
      if (s.pr.state && s.pr.state !== 'open') return no(`${s.id}: PR #${s.pr.number} is ${s.pr.state}, not open`);
      if (s.pr.headOid !== s.oid) return no(`${s.id}: PR #${s.pr.number} head ${String(s.pr.headOid).slice(0, 12)} differs from the ready oid ${s.oid.slice(0, 12)} — run \`fleet ready\` again`);
      if (!entries[i].repo || !entries[i].baseRef || !entries[i].baseRefOid) return no(`${s.id}: PR #${s.pr.number} lacks repo/baseRef/baseRefOid — cannot be verified`);
    }
    if (new Set(entries.map((e) => `${e.repo}\u0000${e.baseRef}`)).size > 1) return no(`mixed targets: sources target different repos or base refs (${[...new Set(entries.map((e) => `${e.repo}:${e.baseRef}`))].join(', ')})`);
    const wrongBase = entries.filter((e) => e.baseRefOid !== expectedOid);
    if (wrongBase.length) return no(`${wrongBase.map((e) => e.id).join(', ')}: PR baseRefOid ${String(wrongBase[0].baseRefOid).slice(0, 12)} does not equal the remote base ${String(expectedOid).slice(0, 12)}`);
  }
  return { ok: true, entries };
}

/**
 * Build a train. Refusals before the manifest is written return
 * `{ok:false, code:'refused', reason}`; once a manifest exists the result is
 * `{ok:true, train, approvability}` whatever the outcome (red, dirty, conflict…) —
 * the caller decides what that means for exit codes.
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {object} args.config - `resolveConfig` result
 * @param {Array<object>} args.sources - ORDERED: `{id, gen, rev, oid, kind, repo?, prNumber?, headRepo?, baseRef?, pr?}`
 * @param {object} [args.checkPayload] - `{sessions, overlaps}` for the hook's stdin
 * @param {boolean} [args.dryRun]
 * @param {ReturnType<typeof defaultDeps>} [args.deps]
 */
export function buildTrain({ cwd, config, sources, checkPayload = { sessions: [], overlaps: [] }, dryRun = false, probeTier = null, deps = defaultDeps(), rollup = false }) {
  const refuse = (reason) => ({ ok: false, code: 'refused', reason });
  // A probe (`land --dry-run --tier <name>`) builds the same combined candidate but runs ONE tier, under `fleet/probes/`,
  // where no approve/confirm/resume reader looks: it can never be approved.
  const dir = probeTier ? probesDir(fleetDir(cwd)) : fleetDir(cwd);
  const allTiers = config.testCommand ?? [];
  const pre = allTiers.filter((t) => t.stage === 'pre-land');
  if (!pre.length) return refuse('no testCommand configured — set testCommand in .fleet.json, or add scripts.test to package.json');
  const probe = probeTier ? pre.find((t) => t.name === probeTier) : null;
  if (probeTier && !probe) return refuse(`no pre-land tier named ${JSON.stringify(probeTier)} (pre-land tiers: ${pre.map((t) => t.name).join(', ')})`);
  const tiers = probe ? [probe] : allTiers;
  if (probe) dryRun = false; // a probe BUILDS and runs its tier; plain --dry-run only plans

  const remote = 'origin';
  const urls = resolveRemoteUrls(cwd, remote);
  if (!urls.ok) return refuse(`cannot resolve remote ${remote}: ${urls.reason}`);
  if (urls.pushUrls.length !== 1) return refuse(`remote ${remote} has ${urls.pushUrls.length} push URLs — a push would no longer be one destination`);
  const ref = `refs/heads/${config.baseBranch}`;
  const rem = remoteRefOid(cwd, urls.fetchUrl, ref);
  if (!rem.ok) return refuse(`cannot reach ${remote} to read ${ref}: ${rem.reason}`);
  if (!rem.oid) return refuse(`${ref} does not exist on ${remote}`);
  const base = headOf(cwd, ref);
  if (!base.ok) return refuse(`local base branch ${ref} not found: ${base.reason}`);
  if (base.oid !== rem.oid) return refuse(`local base differs from ${remote}/${config.baseBranch} — sync first (local ${base.oid.slice(0, 12)}, remote ${rem.oid.slice(0, 12)})`);

  const plan = planSources(sources, { mergeMethod: config.mergeMethod, expectedOid: rem.oid });
  if (!plan.ok) return refuse(plan.reason);
  for (const s of sources) {
    if (!headOf(cwd, s.oid).ok) return refuse(`${s.id}: commit ${s.oid.slice(0, 12)} is not in this repository`);
  }
  const destination = { remote, fetchUrl: urls.fetchUrl, pushUrl: urls.pushUrls[0], ref, expectedOid: rem.oid };
  const deferred = tiers.filter((t) => t.stage === 'post-merge');
  if (dryRun) {
    return { ok: true, dryRun: true, plan: { baseOid: base.oid, destination, sources: plan.entries, mergeMethod: config.mergeMethod, testCommand: tiers, deferredTiers: deferred } };
  }

  // A PR head is materialised into an isolated ref and its OID verified; a mismatch refuses.
  for (const [i, s] of sources.entries()) {
    if (s.kind !== 'pr') continue;
    const m = materializePrRef(cwd, plan.entries[i].prNumber, s.oid, { remote });
    if (!m.ok) return refuse(`${s.id}: ${m.reason}`);
  }

  const trainId = mintTrainId(dir, deps.now());
  const createdAt = iso(deps);
  writeTrain(dir, {
    schemaVersion: 1, trainId, createdAt, updatedAt: createdAt, phase: 'snapshot', baseOid: base.oid,
    sources: plan.entries, mergeMethod: config.mergeMethod, destination, testCommand: tiers, deferredTiers: deferred,
    candidate: null, depsChanged: null, result: null, worktree: null, notes: [],
    ...(rollup ? { landing: 'rollup' } : {}),
  });

  const abandon = (why, reasonCode, notes = []) => {
    const t = patchTrain(dir, trainId, { phase: 'abandoned', result: 'none', reasonCode, notes: [...notes, why] }, deps);
    return { ok: false, code: 'error', reason: why, reasonCode, trainId, train: t };
  };

  const wtRoot = config.worktreeRoot;
  const wt = path.join(wtRoot, trainId);
  const hooks = noHooksDir();
  try {
    fs.mkdirSync(wtRoot, { recursive: true });
    const add = addIntegrationWorktree({ deps, cwd, wt, baseOid: base.oid, hooksDir: hooks.dir });
    if (!add.ok) return abandon(`could not create the integration worktree: ${add.reason}`, add.timedOut ? 'git-timeout' : 'worktree-add-failed', add.notes);
    patchTrain(dir, trainId, { phase: 'applying', worktree: wt, ...(add.notes.length ? { notes: add.notes } : {}) }, deps);

    const ident = deps.git(['var', 'GIT_COMMITTER_IDENT'], wt).ok ? [] : ['-c', 'user.name=fleet', '-c', 'user.email=fleet@localhost'];
    const wgit = (args) => deps.git([...ident, '-c', `core.hooksPath=${hooks.dir}`, ...args], wt);
    const applied = applySources({ wgit, dir: wt, sources, mergeMethod: config.mergeMethod, trainId, appendOnlyGlobs: config.appendOnlyGlobs ?? [], rollup, sleep: deps.sleep ?? sleepSync });
    const conflict = applied.conflict;
    const applyNotes = [...applied.unioned.map((u) => `${u.sourceId}: ${u.files.join(', ')} merged keeping both sides (appendOnlyGlobs)`),
      ...applied.skipped.map((k) => `${k.sourceId}: skipped — ${k.reason}`)];
    const cur = readTrain(dir, trainId).train;
    if (applyNotes.length || applied.skipped.length) patchTrain(dir, trainId, { notes: [...(cur.notes ?? []), ...applyNotes], ...(applied.skipped.length ? { skipped: applied.skipped } : {}) }, deps);
    if (conflict) {
      const prior = readTrain(dir, trainId).train.notes ?? [];
      const t = patchTrain(dir, trainId, { phase: 'conflict', result: 'none', conflict, notes: [...prior, `stopped at ${conflict.sourceId}: ${conflict.reason}`] }, deps);
      const out = { ok: true, train: t, approvability: approvable(t) };
      return probe ? closeProbe({ cwd, dir, done: out, deps }) : out;
    }
    const head = wgit(['rev-parse', 'HEAD', 'HEAD^{tree}']);
    if (!head.ok) return abandon(`cannot read the candidate: ${head.reason}`, 'candidate-unreadable');
    const [oid, tree] = head.stdout.split('\n').map((s) => s.trim());
    patchTrain(dir, trainId, { candidate: { oid, tree } }, deps);
    deps.hooks?.afterCandidate?.();
    const done = finishTrain({ cwd, dir, trainId, getChecks: () => config.checks ?? [], checkPayload, deps });
    return probe ? closeProbe({ cwd, dir, done, deps }) : done;
  } finally { hooks.cleanup(); }
}

/**
 * A finished probe: its result stays recorded (the status hint reads it), its worktree is removed and its phase is
 * `abandoned` — it was never a candidate for approval. A removal that fails is a note, not a lost result.
 */
function closeProbe({ cwd, dir, done, deps }) {
  const t = done.train;
  const rm = removeTrainWorktree(cwd, t, deps);
  const train = patchTrain(dir, t.trainId, { phase: 'abandoned', notes: [...(t.notes ?? []), `probe of tier ${t.testCommand[0]?.name} only — never approvable${rm.removed ? '' : ` (worktree: ${rm.reason})`}`] }, deps);
  // The reason says what happened (audit R1 L1): a conflict stops before any tier runs.
  const what = t.conflict ? `stopped at a conflict before tier ${t.testCommand[0]?.name} ran` : `only tier ${t.testCommand[0]?.name} ran`;
  return { ...done, probe: true, train, approvability: { ok: false, reason: `probe: ${what} — build a full train (\`land\` without --tier) to approve` } };
}

const STDERR_SLICE = 500;
const RETRY_DELAY_MS = 750;
export const WORKTREE_ADD_ATTEMPTS = 3;

/** A git failure that may clear on its own: git never started, it timed out, or it met a lock. The `retryTransient` rule. */
const transientGitFailure = (r) => r.status === null || /index\.lock|EBUSY|EPERM/.test(`${r.stderr ?? ''} ${r.reason ?? ''}`);

/**
 * `git worktree add --detach` for the integration worktree, with a bounded retry inside the slot hold (consumer report
 * 2026-11-27: under load `worktree add` took 12-31 s and a 15 s timeout lost the slot). Only a transient failure retries,
 * and only after the partial add is undone: a listed worktree is force-removed; an unlisted directory is removed only
 * because it is the fresh train-named path that did not exist before the first attempt (refused up front otherwise).
 * @returns {{ok: boolean, attempts: number, notes: string[], reason?: string, timedOut?: boolean}}
 */
export function addIntegrationWorktree({ deps, cwd, wt, baseOid, hooksDir, attempts = WORKTREE_ADD_ATTEMPTS, sleep = deps.sleep ?? sleepSync, exists = fs.existsSync }) {
  const notes = [];
  if (exists(wt)) return { ok: false, attempts: 0, notes, reason: `${wt} already exists — refusing to reuse a directory this train did not create` };
  for (let i = 1; ; i += 1) {
    const r = deps.git(['-c', `core.hooksPath=${hooksDir}`, 'worktree', 'add', '--detach', wt, baseOid], cwd);
    if (r.ok) return { ok: true, attempts: i, notes };
    if (!transientGitFailure(r) || i >= attempts) return { ok: false, attempts: i, notes, reason: `${r.reason}${i > 1 ? ` (after ${i} attempts)` : ''}`, timedOut: r.timedOut === true };
    const undo = undoPartialWorktree({ deps, cwd, wt, exists });
    if (undo) return { ok: false, attempts: i, notes, reason: `${r.reason}; the partial worktree could not be undone before a retry: ${undo}`, timedOut: r.timedOut === true };
    notes.push(`worktree add attempt ${i} of ${attempts} failed (${r.reason}); undone and retried`);
    sleep(RETRY_DELAY_MS * i);
  }
}

/** Undo a partial `worktree add`. @returns {string|null} why it could not be undone, or null */
function undoPartialWorktree({ deps, cwd, wt, exists }) {
  const l = deps.git(['worktree', 'list', '--porcelain', '-z'], cwd);
  if (!l.ok) return `git worktree list failed: ${l.reason}`;
  if (parseWorktreePorcelain(l.stdout).some((w) => pathsEqual(w.path, wt))) {
    const rm = deps.git(['worktree', 'remove', '--force', '--force', wt], cwd);
    if (!rm.ok) return `git worktree remove failed: ${rm.reason}`;
  } else if (exists(wt)) {
    try { fs.rmSync(wt, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (e) { return `could not remove ${wt}: ${e.message}`; }
  }
  const pr = deps.git(['worktree', 'prune'], cwd);
  return pr.ok ? null : `git worktree prune failed: ${pr.reason}`;
}

/**
 * One bounded retry of a git step that may not have run to completion (field report 4: a transient Windows
 * `spawnSync git ENOENT`). A spawn failure (`status:null`, "failed to run") means git NEVER started, so repeating it
 * cannot double-apply. A timeout or an index lock may have done part of the work: retry only when HEAD still equals
 * `before` (and, for a merge, the tree is clean). Anything else is returned as it came; the second failure wins.
 */
function retryTransient({ run, wgit, before, sleep, requireClean = false }) {
  const r = run();
  if (r.ok) return r;
  // Only an error CODE that means the process never started proves it: ENOBUFS/EPIPE arrive under the same
  // "failed to run" wording after git DID run, so the wording alone is not evidence.
  const spawnFailed = r.status === null && /failed to run: .*\b(?:ENOENT|EACCES|EAGAIN|EMFILE|ENFILE|ENOMEM)\b/.test(r.reason ?? '');
  const transient = spawnFailed || transientGitFailure(r);
  if (!transient) return r;
  if (!spawnFailed) {
    const head = wgit(['rev-parse', 'HEAD']);
    if (!head.ok || head.stdout.trim() !== before) return r;
    if (requireClean) {
      const st = wgit(['status', '--porcelain']);
      if (!st.ok || st.stdout.trim()) return r;
    }
  }
  sleep(RETRY_DELAY_MS);
  return run();
}

/**
 * Apply sources in order. A conflict confined to `appendOnlyGlobs` is resolved
 * keeping both sides in the DIRECT modes (fleet pushes this very tree); in `pr`
 * mode it stays a conflict, because GitHub would report it too — the remedy is to
 * restack the later branch once the earlier one lands.
 *
 * A source that adds no commit because it is ALREADY CONTAINED in the candidate (a branch and its ancestor in one train: the
 * descendant brought it in) is skipped with a recorded reason, never a stop: landing the candidate lands it too.
 * @returns {{conflict: object|null, unioned: Array<{sourceId: string, files: string[]}>, skipped: Array<{sourceId: string, oid: string, reasonCode: string, reason: string}>}}
 */
export function applySources({ wgit, dir, sources, mergeMethod, trainId, appendOnlyGlobs = [], rollup = false, sleep = sleepSync }) {
  const unioned = [];
  const skipped = [];
  // A rollup member is squashed with a message that names it and carries NO AI-* trailer: `-C` would copy the member's AI-Gate onto a
  // commit whose combined tree no audit read (docs/plans/ship-batch-member-outcomes.md section 2.9.3).
  const squashCommit = (s) => {
    if (!rollup) return wgit(['commit', '--no-verify', '--allow-empty', '-C', s.oid]);
    const subj = wgit(['log', '-1', '--format=%s', s.oid]);
    if (!subj.ok) return { ...subj, reason: `the subject of ${s.id} (${s.oid.slice(0, 12)}) could not be read: ${subj.reason ?? 'git log failed'}` }; // never a substituted subject
    return wgit(['commit', '--no-verify', '--allow-empty', '-m', rollupMessage({ subject: subj.stdout.trim(), id: s.id, oid: s.oid })]);
  };
  for (const s of sources) {
    const before = wgit(['rev-parse', 'HEAD']).stdout.trim();
    const retry = (run, opts) => retryTransient({ run, wgit, before, sleep, ...opts });
    let r;
    if (mergeMethod === 'direct-merge') r = retry(() => wgit(['merge', '--no-ff', '--no-verify', '-m', `Merge ${s.id} (fleet ${trainId})`, s.oid]), { requireClean: true });
    else {
      // `pr` uses squash for the test tree, as GitHub will. -C keeps the source tip's author and message.
      r = retry(() => wgit(['merge', '--squash', s.oid]), { requireClean: true });
      if (r.ok) r = retry(() => squashCommit(s));
    }
    if (!r.ok) {
      const list = wgit(['diff', '--name-only', '--diff-filter=U']);
      const files = list.ok ? list.stdout.split('\n').filter(Boolean) : [];
      // "merge conflict" is a claim about the TREE: only a listed unmerged file makes it. An empty list (git never ran,
      // timed out, a lock) is a different failure and an unreadable list is an unanswered question, never `files: []`.
      const why = files.length ? 'merge conflict'
        : !list.ok ? `conflict list unavailable: ${list.reason} (merge: ${r.reason})`
          : `merge failed (not a conflict): ${r.reason}`;
      const reasonCode = files.length ? 'merge-conflict' : !list.ok ? 'conflict-list-unavailable' : r.timedOut ? 'git-timeout' : 'merge-failed';
      const conflict = { sourceId: s.id, oid: s.oid, reason: why, reasonCode, files, ...(files.length ? {} : { status: r.status ?? null, stderr: String(r.stderr ?? '').trim().slice(0, STDERR_SLICE) }) };
      if (!appendOnlyGlobs.length || !files.length) return { conflict, unioned, skipped };
      if (mergeMethod === 'pr') {
        const allAppendOnly = files.every((f) => isMatch(f, appendOnlyGlobs, { dot: true }));
        return { conflict: allAppendOnly ? { ...conflict, reasonCode: 'append-only-conflict', reason: `append-only conflict — GitHub would refuse it too; land the earlier branch, then fleet restack ${s.id}` } : conflict, unioned, skipped };
      }
      const u = resolveAppendOnly({ dir, git: wgit, globs: appendOnlyGlobs });
      if (!u.ok) return { conflict: { ...conflict, ...(u.ineligible ? { reason: `merge conflict (${u.reason})` } : {}) }, unioned, skipped };
      const done = mergeMethod === 'direct-merge'
        ? wgit(['commit', '--no-verify', '--no-edit'])
        : squashCommit(s);
      if (!done.ok) return { conflict: { ...conflict, reasonCode: 'merge-failed', reason: `resolved append-only files but could not commit: ${done.reason}` }, unioned, skipped };
      unioned.push({ sourceId: s.id, files: u.resolved });
    }
    const after = wgit(['rev-parse', 'HEAD']).stdout.trim();
    if (after === before) {
      // Contained: git says so (exit 0 of --is-ancestor). Anything else that made no commit is still a stop, with its own code.
      if (wgit(['merge-base', '--is-ancestor', s.oid, 'HEAD']).ok) {
        skipped.push({ sourceId: s.id, oid: s.oid, reasonCode: 'already-contained', reason: `${s.oid.slice(0, 12)} is already contained in the candidate (an earlier source brought it in)` });
        continue;
      }
      return { conflict: { sourceId: s.id, oid: s.oid, reason: 'produced no commit (and is not contained in the candidate)', reasonCode: 'no-commit', files: [] }, unioned, skipped };
    }
  }
  return { conflict: null, unioned, skipped };
}

/**
 * The steps after the candidate is recorded, each skipped when its result is
 * already in the manifest (so `resumeTrain` can re-enter): dependency
 * provisioning from the candidate, the consumer hook, then the tiers.
 *
 * The `land` checks run INSIDE the candidate worktree, after provisioning: a
 * guard committed by one train branch therefore applies to every other branch's
 * change in the combined tree, before CI does.
 */
export function finishTrain({ cwd, dir, trainId, getChecks, checkPayload, deps }) {
  let t = readTrain(dir, trainId).train;
  if (t.depsChanged === null || t.depsChanged === undefined) {
    const diff = deps.git(['diff', '--name-only', t.baseOid, t.candidate.oid], t.worktree);
    const changed = diff.ok && diff.stdout.split('\n').some((f) => DEP_FILES.has(path.posix.basename(f.trim())));
    t = patchTrain(dir, trainId, { depsChanged: changed }, deps);
    // Provision AFTER the sources are applied: a combined tree never runs against a stale install.
    const prov = deps.provision(t.worktree, mainRootOf(cwd), { depsChanged: changed });
    if (!prov.ok) {
      t = patchTrain(dir, trainId, { phase: 'tested', result: 'none', reasonCode: 'provision-failed', notes: [...(t.notes ?? []), prov.reason] }, deps);
      return { ok: true, train: t, approvability: approvable(t) };
    }
  }
  if (!Array.isArray(t.checkResults)) {
    const payload = buildCheckPayload({ ...(typeof checkPayload === 'function' ? checkPayload() : checkPayload), phase: 'land', baseOid: t.baseOid, trainSources: t.sources });
    const results = runChecks({ cwd: t.worktree, checks: getChecks(), phase: 'land', payload });
    t = patchTrain(dir, trainId, { checkResults: results }, deps);
  }
  t = runTiers({ dir, trainId, deps });
  return { ok: true, train: t, approvability: approvable(t) };
}

/**
 * Did the candidate change what would be installed? Lockfiles: any diff. A
 * package.json: only its dependency-relevant fields (`dependencySetChanged`, so a
 * scripts-only edit is not a change); an added/removed one, or an unreadable
 * diff, fails CLOSED to changed.
 */
function depFilesChanged(deps, t) {
  const diff = deps.git(['diff', '--name-status', '--no-renames', t.baseOid, t.candidate.oid], t.worktree);
  if (!diff.ok) return true;
  for (const line of diff.stdout.split('\n').filter(Boolean)) {
    const [status, file] = line.split('\t');
    const name = path.posix.basename(file ?? '');
    if (!DEP_FILES.has(name)) continue;
    if (name !== 'package.json' || status !== 'M') return true;
    const show = (rev) => { const r = deps.git(['show', `${rev}:${file}`], t.worktree); return r.ok ? r.stdout : null; };
    if (dependencySetChanged(show(t.baseOid), show(t.candidate.oid)).changed) return true;
  }
  return false;
}

// ── Tiers ───────────────────────────────────────────────────────────────────

function restore(deps, wt, cand) {
  const r = deps.git(['reset', '--hard', cand.oid], wt);
  if (!r.ok) return `reset failed: ${r.reason}`;
  const c = deps.git(['clean', '-fdx', '-e', 'node_modules'], wt);
  return c.ok ? null : `clean failed: ${c.reason}`;
}

/**
 * Every code a tier result may carry in `reasonCode` (`land --json`): a script tells "why red" apart without the prose
 * `reason`. A cleanup failure is never a reason — it is a `warnings[]` entry (`cleanup-warning`) beside the result.
 */
export const TIER_REASON_CODES = Object.freeze([
  'green', 'green-after-rerun', 'test-failure', 'guard-failure', 'test-timeout', 'tier-timeout', 'instrument-failure',
  'unclassified-failure', 'spawn-refused', 'spawn-failed', 'dirty-before', 'dirty-after', 'restore-failed',
]);
/** The tier reason code for each failure kind the runner's `test-outcome/v1` line can name. */
const KIND_CODE = Object.freeze({
  'test-failure': 'test-failure', guard: 'guard-failure', timeout: 'test-timeout', instrument: 'instrument-failure', unclassified: 'unclassified-failure',
});
/**
 * Kinds a rerun can change. A policy guard over a finished run (`guard`) is deterministic; a run stopped for time
 * (`timeout`) is rerun under the same load at the full cost — the rule the tier timeout always had.
 */
const RERUN_KINDS = new Set(['test-failure', 'instrument', 'unclassified']);
export const MAX_RERUN_FILES = 50;
const SAFE_FILE = /^[A-Za-z0-9_@+=:,./-]+$/;

/** The log text of ONE attempt: everything after its own header (the log is appended across attempts). */
export function attemptSegment(text, tierName, n) {
  const t = String(text ?? '');
  const at = t.lastIndexOf(`--- fleet: tier ${tierName} attempt ${n} `);
  return at === -1 ? '' : t.slice(at);
}

/**
 * The argv of a targeted rerun: the tier's `rerunFailedCommand` with `{files}` replaced by the failing files the attempt's
 * `run-tests/v1 failed-files:` line named. Every file is a repo-relative plain token (it came from a log), at most
 * MAX_RERUN_FILES. @returns {{ok: true, argv: string[], files: string[]} | {ok: false, why: string}}
 */
export function targetedRerunArgv(tier, segment) {
  if (!Array.isArray(tier.rerunFailedCommand)) return { ok: false, why: 'the tier declares no rerunFailedCommand' };
  const payloads = String(segment ?? '').split(/\r?\n/).map((l) => { const at = l.indexOf(FAILED_FILES_MARKER); return at === -1 ? null : l.slice(at + FAILED_FILES_MARKER.length); }).filter((x) => x !== null);
  if (payloads.length !== 1) return { ok: false, why: `the attempt printed ${payloads.length} failed-files lines (exactly one is trusted)` };
  const p = parseFailedFilesPayload(payloads[0]);
  if (p.kind !== 'files' || !p.files.length) return { ok: false, why: `the failing files are ${p.kind === 'files' ? 'an empty list' : p.kind}` };
  if (p.files.length > MAX_RERUN_FILES) return { ok: false, why: `${p.files.length} failing files (over ${MAX_RERUN_FILES})` };
  const bad = p.files.find((f) => !SAFE_FILE.test(f) || f.startsWith('-') || f.startsWith('/') || f.split('/').includes('..'));
  if (bad !== undefined) return { ok: false, why: `failing file ${JSON.stringify(bad)} is not a plain repo-relative path` };
  return { ok: true, files: p.files, argv: tier.rerunFailedCommand.flatMap((a) => (a === RERUN_FILES_TOKEN ? p.files : [a])) };
}

/**
 * Run one tier with integrity assertions around it, and the rerun policy (docs/plans/fleet-train-landing-friction.md
 * section 2.2): a red attempt is classified from the runner's own `test-outcome/v1` line; only a kind a rerun can change
 * is rerun; a test failure whose files are named reruns those files first and the whole tier only if they pass.
 */
function runOneTier({ tier, train, dir, deps }) {
  const wt = train.worktree; const cand = train.candidate;
  const logPath = trainLogPath(dir, train.trainId, tier.name);
  const startedAt = iso(deps);
  // A failed reap after ANY attempt is recorded on the result: a leftover process is not a clean run.
  let cleanupWarning = null;
  const done = (result, extra = {}) => ({
    name: tier.name, stage: 'pre-land', ...(tier.note ? { note: tier.note } : {}), result, startedAt, endedAt: iso(deps), logPath,
    ...(cleanupWarning ? { cleanupWarning, warnings: [{ code: 'cleanup-warning', reason: cleanupWarning }] } : {}), ...extra,
  });
  const attempt = (n, run = tier, label = '') => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `\n--- fleet: tier ${tier.name} attempt ${n} ${label}at ${iso(deps)} ---\n`);
    const r = deps.runTier({ tier: run, cwd: wt, logPath, timeoutMs: tier.timeoutMs });
    if (r?.cleanup && r.cleanup.ok === false) cleanupWarning = cleanupWarning ? `${cleanupWarning}; ${r.cleanup.reason}` : r.cleanup.reason;
    return r;
  };
  // A red verdict carries its classification. Only a red that ran to an exit code is read for the runner's line.
  const verdict = (r, n) => {
    if (r.refused) return { result: 'red', reason: r.refused, reasonCode: 'spawn-refused' };
    if (r.timedOut) return { result: 'red', reason: 'timeout', reasonCode: 'tier-timeout' };
    if (r.error) return { result: 'red', reason: `could not start: ${r.error}`, reasonCode: 'spawn-failed' };
    if (r.exitCode === 0) return { result: 'green' };
    const segment = attemptSegment(readTail(logPath), tier.name, n);
    const c = classifyAttemptLog(segment);
    return {
      result: 'red', reason: `exit ${r.exitCode ?? r.signal ?? 'unknown'}${c.kind === 'unclassified' ? '' : ` (${c.kind})`}`, reasonCode: KIND_CODE[c.kind],
      failureKind: c.kind, ...(c.outcome ? { testsFailed: c.outcome.testsFailed, guards: c.outcome.guards } : { classifyWhy: c.why }), segment,
    };
  };
  const fields = ({ segment: _s, result: _r, ...v }) => v;

  const pre = checkIntegrity(deps, wt, cand);
  if (pre) return done('dirty', { reason: `before ${tier.name}: ${pre}`, reasonCode: 'dirty-before' });

  let n = 1;
  let v = verdict(attempt(n), n);
  let rerun = null; let rerunFallback = null;
  if (v.result === 'red' && RERUN_KINDS.has(v.failureKind)) {
    // Restore, re-assert the clean precondition, rerun (a leftover cannot make the rerun pass).
    const restoreOrDirty = () => restore(deps, wt, cand) ?? checkIntegrity(deps, wt, cand);
    let bad = restoreOrDirty();
    if (bad) return done('dirty', { reason: `after the failed first run, could not restore a clean candidate: ${bad}`, reasonCode: 'restore-failed' });
    if (v.failureKind === 'test-failure') {
      const t = targetedRerunArgv(tier, v.segment);
      if (t.ok) {
        n += 1;
        const tv = verdict(attempt(n, { ...tier, command: t.argv, shell: undefined }, `(targeted: ${t.files.length} failing file${t.files.length === 1 ? '' : 's'}) `), n);
        if (tv.result !== 'green') {
          return done('red', { ...fields(tv), reason: `targeted rerun of ${t.files.length} failing file(s) still red: ${tv.reason}`, reran: true, rerun: 'targeted' });
        }
        bad = restoreOrDirty();
        if (bad) return done('dirty', { reason: `after the targeted rerun, could not restore a clean candidate: ${bad}`, reasonCode: 'restore-failed', reran: true, rerun: 'targeted' });
        rerun = 'targeted-then-full';
      } else rerunFallback = t.why;
    }
    rerun ??= 'full';
    n += 1;
    v = verdict(attempt(n), n);
  }
  const reran = rerun ? { reran: true, rerun, ...(rerunFallback ? { rerunFallback } : {}) } : {};
  if (v.result !== 'green') return done('red', { ...fields(v), ...reran });
  const post = checkIntegrity(deps, wt, cand);
  if (post) return done('dirty', { reason: `after ${tier.name}: ${post}`, reasonCode: 'dirty-after', ...reran });
  return rerun ? done('green-after-rerun', { reasonCode: 'green-after-rerun', ...reran }) : done('green', { reasonCode: 'green' });
}


/**
 * Run the `pre-land` tiers that have no recorded result, in order, stopping at
 * the first non-green. Each result is written as it finishes. `post-merge` tiers
 * are NEVER run here (they are recorded as `deferredTiers`). Leaves
 * `phase:'tested'` with the overall (worst) result.
 * @returns {object} the updated train
 */
export function runTiers({ dir, trainId, deps }) {
  let train = readTrain(dir, trainId).train;
  const pre = tiersOf(train.testCommand).filter((t) => (t.stage ?? 'pre-land') === 'pre-land');
  for (const tier of pre) {
    if ((train.tierResults ?? []).some((r) => r.name === tier.name)) continue;
    deps.log?.(`tier ${tier.name}: running`);
    const entry = runOneTier({ tier, train, dir, deps });
    const tierResults = [...(train.tierResults ?? []), entry];
    train = patchTrain(dir, trainId, { tierResults, result: worstResult(tierResults.map((r) => r.result)) }, deps);
    deps.log?.(`tier ${tier.name}: ${entry.result}${entry.reason ? ` (${entry.reason})` : ''}`);
    deps.hooks?.afterTier?.(tier.name);
    if (entry.result !== 'green' && entry.result !== 'green-after-rerun' && !guardOnlyRed(entry)) break;
  }
  return patchTrain(dir, trainId, { phase: 'tested', result: worstResult((train.tierResults ?? []).map((r) => r.result)) }, deps);
}

/**
 * `land --resume`: continue a tiered run from the first tier with no recorded
 * result, in the same still-clean worktree. The integrity preconditions are
 * re-asserted FIRST; a dirty or moved worktree is refused (rebuild).
 */
export function resumeTrain({ cwd, trainId, getChecks, checkPayload, deps = defaultDeps() }) {
  const dir = fleetDir(cwd);
  return withTrainLock(dir, () => {
    const r = readTrain(dir, trainId);
    if (!r.ok) return { ok: false, code: 'refused', reason: `train ${trainId}: ${r.reason}` };
    const t = r.train;
    if (t.phase !== 'applying' || !t.candidate) return { ok: false, code: 'refused', reason: `train is ${t.phase} — only an interrupted run (phase applying, candidate recorded) can be resumed` };
    if (!t.worktree || !fs.existsSync(t.worktree)) return { ok: false, code: 'refused', reason: 'the integration worktree is gone — rebuild a new train' };
    const bad = checkIntegrity(deps, t.worktree, t.candidate);
    if (bad) return { ok: false, code: 'refused', reason: `cannot resume: ${bad} — abandon and rebuild a new train` };
    return finishTrain({ cwd, dir, trainId, getChecks, checkPayload: checkPayload ?? { sessions: [], overlaps: [] }, deps });
  });
}

/**
 * What a failed worktree removal STILL leaves, with the two facts that decide the recovery kept separate (the directory on disk,
 * and git's registration of it): a locked worktree needs `--force` twice, a directory git no longer lists is only a directory,
 * and a registration with no directory is cleared by `worktree prune`. Empty when neither remains (nothing to tell the user).
 */
function leftoverOf(cwd, t, rm, deps) {
  if (!t.worktree) return [];
  const dirExists = fs.existsSync(t.worktree);
  const l = deps.git(['worktree', 'list', '--porcelain', '-z'], cwd);
  const registered = l.ok ? parseWorktreePorcelain(l.stdout).some((w) => pathsEqual(w.path, t.worktree, process.platform)) : null;
  // An UNANSWERED registration query is not proof of absence: with the directory gone, `registered: null` is still reported.
  if (!dirExists && registered === false) return [];
  return [{ kind: 'worktree', path: t.worktree, dirExists, registered, reason: l.ok ? rm.reason : `${rm.reason}; git worktree list failed (${l.reason})` }];
}

/**
 * `land --abandon`, per the transition table: legal before approval and from
 * `diverged`; REFUSED in `push-pending` and `awaiting-merge` (an outward action
 * may have happened) and in `landed`/`abandoned`. Sessions are never touched.
 */
export function abandonTrain({ cwd, trainId, deps = defaultDeps() }) {
  const dir = fleetDir(cwd);
  return withTrainLock(dir, () => {
    const r = readTrain(dir, trainId);
    if (!r.ok) return { ok: false, code: 'refused', reason: `train ${trainId}: ${r.reason}` };
    const t = r.train;
    const why = {
      'push-pending': 'an outward push may have happened — run `land --reconcile` first',
      'awaiting-merge': 'some PRs may already be merged — use `land --confirm`',
      landed: 'the train already landed', abandoned: 'the train is already abandoned',
    }[t.phase];
    if (why) return { ok: false, code: 'refused', reason: `cannot abandon a ${t.phase} train: ${why}` };
    const rm = removeTrainWorktree(cwd, t, deps);
    const next = patchTrain(dir, trainId, { phase: 'abandoned', notes: [...(t.notes ?? []), `abandoned from ${t.phase}${rm.removed ? '' : ` (worktree: ${rm.reason})`}`] }, deps);
    // What is STILL on disk, said plainly: a worktree that could not be removed is the user's to clean, with the exact command.
    const leftBehind = rm.removed ? [] : leftoverOf(cwd, t, rm, deps);
    return { ok: true, code: 'ok', train: next, worktreeRemoved: rm.removed, worktreeNote: rm.reason, leftBehind };
  });
}
