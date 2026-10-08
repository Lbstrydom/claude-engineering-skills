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
import { runChecks, buildCheckPayload } from './checks.mjs';
import { superviseTier } from './tier-supervisor.mjs';
import { approvable, tiersOf, worstResult } from './overlap.mjs';
import { assertManaged, fleetDir, newTrainId, readTrain, writeTrain } from './registry.mjs';

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
  return {
    git: (args, cwd, opts) => runGit(args, cwd, opts),
    gh: ghRun,
    runTier: spawnTier,
    provision: provisionDeps,
    removeWorktree: ({ dir, cwd }) => removeFixture({ dir, cwd }),
    now: () => new Date(),
    log: (m) => process.stderr.write(`  [fleet] ${m}\n`),
    hooks: {},
    ...over,
  };
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
  const r = deps.removeWorktree({ dir: wt, cwd });
  return r.ok ? { removed: true } : { removed: false, reason: `worktree not fully removed: ${(r.steps ?? []).slice(-1)[0] ?? ''}` };
}

function noHooksDir() {
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
export function buildTrain({ cwd, config, sources, checkPayload = { sessions: [], overlaps: [] }, dryRun = false, deps = defaultDeps() }) {
  const refuse = (reason) => ({ ok: false, code: 'refused', reason });
  const dir = fleetDir(cwd);
  const tiers = config.testCommand ?? [];
  const pre = tiers.filter((t) => t.stage === 'pre-land');
  if (!pre.length) return refuse('no testCommand configured — set testCommand in .fleet.json, or add scripts.test to package.json');

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

  const trainId = newTrainId(deps.now());
  const createdAt = iso(deps);
  writeTrain(dir, {
    schemaVersion: 1, trainId, createdAt, updatedAt: createdAt, phase: 'snapshot', baseOid: base.oid,
    sources: plan.entries, mergeMethod: config.mergeMethod, destination, testCommand: tiers, deferredTiers: deferred,
    candidate: null, depsChanged: null, result: null, worktree: null, notes: [],
  });

  const abandon = (why) => {
    const t = patchTrain(dir, trainId, { phase: 'abandoned', result: 'none', notes: [why] }, deps);
    return { ok: false, code: 'error', reason: why, trainId, train: t };
  };

  const wtRoot = config.worktreeRoot;
  const wt = path.join(wtRoot, trainId);
  const hooks = noHooksDir();
  try {
    fs.mkdirSync(wtRoot, { recursive: true });
    const add = deps.git(['-c', `core.hooksPath=${hooks.dir}`, 'worktree', 'add', '--detach', wt, base.oid], cwd);
    if (!add.ok) return abandon(`could not create the integration worktree: ${add.reason}`);
    patchTrain(dir, trainId, { phase: 'applying', worktree: wt }, deps);

    const ident = deps.git(['var', 'GIT_COMMITTER_IDENT'], wt).ok ? [] : ['-c', 'user.name=fleet', '-c', 'user.email=fleet@localhost'];
    const wgit = (args) => deps.git([...ident, '-c', `core.hooksPath=${hooks.dir}`, ...args], wt);
    const conflict = applySources({ wgit, sources, mergeMethod: config.mergeMethod, trainId });
    if (conflict) {
      const t = patchTrain(dir, trainId, { phase: 'conflict', result: 'none', conflict, notes: [`stopped at ${conflict.sourceId}: ${conflict.reason}`] }, deps);
      return { ok: true, train: t, approvability: approvable(t) };
    }
    const head = wgit(['rev-parse', 'HEAD', 'HEAD^{tree}']);
    if (!head.ok) return abandon(`cannot read the candidate: ${head.reason}`);
    const [oid, tree] = head.stdout.split('\n').map((s) => s.trim());
    patchTrain(dir, trainId, { candidate: { oid, tree } }, deps);
    deps.hooks?.afterCandidate?.();
    return finishTrain({ cwd, dir, trainId, getChecks: () => config.checks ?? [], checkPayload, deps });
  } finally { hooks.cleanup(); }
}

/** Apply sources in order; returns a `conflict` record, or null when every source applied. */
function applySources({ wgit, sources, mergeMethod, trainId }) {
  for (const s of sources) {
    const before = wgit(['rev-parse', 'HEAD']).stdout.trim();
    let r;
    if (mergeMethod === 'direct-merge') r = wgit(['merge', '--no-ff', '--no-verify', '-m', `Merge ${s.id} (fleet ${trainId})`, s.oid]);
    else {
      // `pr` uses squash for the test tree, as GitHub will. -C keeps the source tip's author and message.
      r = wgit(['merge', '--squash', s.oid]);
      if (r.ok) r = wgit(['commit', '--no-verify', '--allow-empty', '-C', s.oid]);
    }
    if (!r.ok) {
      const files = wgit(['diff', '--name-only', '--diff-filter=U']);
      return { sourceId: s.id, oid: s.oid, reason: 'merge conflict', files: files.ok ? files.stdout.split('\n').filter(Boolean) : [] };
    }
    const after = wgit(['rev-parse', 'HEAD']).stdout.trim();
    if (after === before) return { sourceId: s.id, oid: s.oid, reason: 'produced no commit (already contained in the candidate)', files: [] };
  }
  return null;
}

/**
 * The steps after the candidate is recorded, each skipped when its result is
 * already in the manifest (so `resumeTrain` can re-enter): the consumer hook,
 * dependency provisioning from the candidate, then the tiers.
 */
export function finishTrain({ cwd, dir, trainId, getChecks, checkPayload, deps }) {
  let t = readTrain(dir, trainId).train;
  if (!Array.isArray(t.checkResults)) {
    const payload = buildCheckPayload({ ...(typeof checkPayload === 'function' ? checkPayload() : checkPayload), phase: 'land', baseOid: t.baseOid, trainSources: t.sources });
    const results = runChecks({ cwd, checks: getChecks(), phase: 'land', payload });
    t = patchTrain(dir, trainId, { checkResults: results }, deps);
  }
  if (t.depsChanged === null || t.depsChanged === undefined) {
    const diff = deps.git(['diff', '--name-only', t.baseOid, t.candidate.oid], t.worktree);
    const changed = diff.ok && diff.stdout.split('\n').some((f) => DEP_FILES.has(path.posix.basename(f.trim())));
    t = patchTrain(dir, trainId, { depsChanged: changed }, deps);
    // Provision AFTER the sources are applied: a combined tree never runs against a stale install.
    const prov = deps.provision(t.worktree, mainRootOf(cwd), { depsChanged: changed });
    if (!prov.ok) {
      t = patchTrain(dir, trainId, { phase: 'tested', result: 'none', notes: [...(t.notes ?? []), prov.reason] }, deps);
      return { ok: true, train: t, approvability: approvable(t) };
    }
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

/** Run one tier with integrity assertions around it; the rerun-once rule. */
function runOneTier({ tier, train, dir, deps }) {
  const wt = train.worktree; const cand = train.candidate;
  const logPath = trainLogPath(dir, train.trainId, tier.name);
  const startedAt = iso(deps);
  // A failed reap after ANY attempt is recorded on the result: a leftover process is not a clean run.
  let cleanupWarning = null;
  const done = (result, extra = {}) => ({ name: tier.name, stage: 'pre-land', ...(tier.note ? { note: tier.note } : {}), result, startedAt, endedAt: iso(deps), logPath, ...(cleanupWarning ? { cleanupWarning } : {}), ...extra });
  const attempt = (n) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `\n--- fleet: tier ${tier.name} attempt ${n} at ${iso(deps)} ---\n`);
    const r = deps.runTier({ tier, cwd: wt, logPath, timeoutMs: tier.timeoutMs });
    if (r?.cleanup && r.cleanup.ok === false) cleanupWarning = cleanupWarning ? `${cleanupWarning}; ${r.cleanup.reason}` : r.cleanup.reason;
    return r;
  };
  const verdict = (r) => (r.refused ? { result: 'red', reason: r.refused } : r.timedOut ? { result: 'red', reason: 'timeout' }
    : r.error ? { result: 'red', reason: `could not start: ${r.error}` }
      : r.exitCode === 0 ? { result: 'green' } : { result: 'red', reason: `exit ${r.exitCode ?? r.signal ?? 'unknown'}` });

  const pre = checkIntegrity(deps, wt, cand);
  if (pre) return done('dirty', { reason: `before ${tier.name}: ${pre}` });

  let v = verdict(attempt(1));
  let rerun = false;
  if (v.result === 'red' && v.reason !== 'timeout' && v.reason !== UNSAFE_WIN_SHELL_ARGV && !v.reason.startsWith('could not start')) {
    // Restore, re-assert the clean precondition, rerun ONCE (a leftover cannot make the rerun pass).
    const bad = restore(deps, wt, cand) ?? checkIntegrity(deps, wt, cand);
    if (bad) return done('dirty', { reason: `after the failed first run, could not restore a clean candidate: ${bad}` });
    rerun = true;
    v = verdict(attempt(2));
  }
  if (v.result !== 'green') return done('red', { reason: v.reason, ...(rerun ? { reran: true } : {}) });
  const post = checkIntegrity(deps, wt, cand);
  if (post) return done('dirty', { reason: `after ${tier.name}: ${post}`, ...(rerun ? { reran: true } : {}) });
  return done(rerun ? 'green-after-rerun' : 'green', rerun ? { reran: true } : {});
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
    if (entry.result !== 'green' && entry.result !== 'green-after-rerun') break;
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
    return { ok: true, code: 'ok', train: next, worktreeRemoved: rm.removed, worktreeNote: rm.reason };
  });
}
