/**
 * @fileoverview `fleet handover prepare|receive`: move coordination to another Claude Code account on
 * this machine, with the account-bound state MEASURED rather than assumed (docs/plans/fleet-handover.md).
 *
 * The disk carries repos, worktrees, uncommitted files and fleet's registry on its own. What stays
 * behind with the old ACCOUNT is everything under its config root: harness memory (every
 * `projects/*\/memory`), scheduled tasks, user settings. `prepare` (old account) records it plus the live
 * coordination state, read-only towards every repo. `receive` (new account) verifies or ADDITIVELY
 * copies the memory, flags what a human must do, and never overwrites a differing file.
 *
 * @module scripts/lib/fleet/handover
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ArgvError } from '../cli-io.mjs';
import { atomicWriteFileSync } from '../file-io.mjs';
import { withFileLockSync } from '../file-lock.mjs';
import { SLUG_RE, claudeConfigDir, samePath, scheduledTasksDir } from '../harness-paths.mjs';
import { resolveSourceRepo } from '../shared-cloud-config.mjs';
import { ok, failed, refused } from './commands.mjs';
import { resolveConfig } from './config.mjs';
import { readDirectives } from './directives.mjs';
import { buildStatusFrom, gatherFacts } from './facts.mjs';
import { gitCommonDir, listBranches, listWorktrees, repoToplevel, runGit } from './git-facts.mjs';
import { parseOriginRepo } from '../branch-protection.mjs';
import { archiveReport } from './lifecycle.mjs';
import { RISK_KINDS, UNREGISTERED_BUDGET, VERDICTS, coveredBy, liveSessionsOf, unregisteredWork } from './unregistered.mjs';

export { liveSessionsOf };
import { isTerminalState } from './overlap.mjs';
import { fleetDir, listTrains, readSessions, realWithTail } from './registry.mjs';
import { blocksHandover, ghUnknownLine, receiveCommand, renderBeforeRelaunch, renderHandoverMarkdown, renderReceiveText } from './handover-render.mjs';
import { renderCommand } from './shell-quote.mjs';
import { RECONCILE_ID, joinTaskRecords, parseSchedulerSnapshot, readScheduleReconcile, stageTaskExports, verifyTaskExports } from './handover-tasks.mjs';
import { defaultProbe, machineDir, readLease, summarise } from './lease.mjs';

export { blocksHandover, ghUnknownLine, renderHandoverMarkdown };
export { claimCommand } from './handover-render.mjs';

export const HANDOVER_SCHEMA_VERSION = 1;
export const OP_ID_RE = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/;
const STAGING_DIR = '.fleet-handover-staging';
const LOCK_FILE = '.fleet-handover.lock';

// ── ids + flag contract ─────────────────────────────────────────────────────

/** Colon-free UTC stamp + 6 hex: valid on win32, unique across same-millisecond runs (R1-H3). */
export function handoverId(now = new Date(), rand = crypto.randomBytes(3).toString('hex')) {
  return `${now.toISOString().replace(/[-:.]/g, '')}-${rand}`;
}

const FLAG_CONTRACT = {
  prepare: { required: [], forbidden: ['--from', '--dry-run', '--allow-older'] },
  receive: { required: ['--from'], forbidden: ['--repo', '--scheduler-checked', '--scheduler-snapshot'] },
};

/** Validated before ANY discovery or I/O (R1-M3); a violation is an argv error (exit 2). */
export function checkHandoverFlags(sub, flags) {
  if (!Object.hasOwn(FLAG_CONTRACT, sub)) throw new ArgvError(`fleet handover: unknown subcommand ${JSON.stringify(sub)} (expected prepare or receive)`);
  const c = FLAG_CONTRACT[sub];
  for (const f of c.forbidden) if (flags[f] !== undefined) throw new ArgvError(`fleet handover ${sub}: ${f} is not valid here`);
  for (const f of c.required) if (flags[f] === undefined) throw new ArgvError(`fleet handover ${sub}: ${f} is required`);
}

// ── path safety (R1-H1) ─────────────────────────────────────────────────────

/** A manifest rel path → its segments, or null when it could escape (absolute, `..`, `\`, `:`, NUL). */
export function safeRelSegments(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.startsWith('/')) return null;
  const segs = rel.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..' || /[\\:\0]/.test(s)) return null;
  }
  return segs;
}

/** First symlink/junction among EXISTING components strictly below `rootReal` on the way to `target`. */
function linkBelow(rootReal, target) {
  const rel = path.relative(rootReal, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return target; // outside the root: refuse
  let cur = rootReal;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') return null; return cur; }
    if (st.isSymbolicLink()) return cur;
  }
  return null;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** One probe: absent | file(hash) | error(reason) (R2-M2). Never follows a link. */
export function probeFile(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return e.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'error', reason: e.code ?? 'lstat-failed' }; }
  if (st.isSymbolicLink()) return { kind: 'error', reason: 'link' };
  if (!st.isFile()) return { kind: 'error', reason: 'not-a-file' };
  try { return { kind: 'file', hash: sha256(fs.readFileSync(p)) }; } catch (e) { return { kind: 'error', reason: e.code ?? 'read-failed' }; }
}

/**
 * The receive decision table (R1-M1 + R2-M2), evaluated in order; first match wins.
 * @param {string} P prepared hash
 * @param {{kind: string, hash?: string, reason?: string}} D destination probe
 * @param {() => {kind: string, hash?: string, reason?: string}} readS current-source probe (lazy: rule 2 never reads it)
 * @returns {{outcome: string, write: boolean, human: boolean, sourceHash?: string, reason?: string}}
 */
export function decideFile(P, D, readS) {
  if (D.kind === 'error') return { outcome: 'destination-unreadable', write: false, human: true, reason: D.reason };
  if (D.kind === 'file' && D.hash === P) return { outcome: 'present', write: false, human: false };
  const S = readS();
  if (S.kind === 'error') return { outcome: D.kind === 'absent' ? 'source-unreadable' : 'undetermined', write: false, human: true, reason: S.reason };
  if (D.kind === 'absent') {
    if (S.kind === 'absent') return { outcome: 'source-missing', write: false, human: true };
    return S.hash === P
      ? { outcome: 'copied', write: true, human: false, sourceHash: S.hash }
      : { outcome: 'copied-source-changed', write: true, human: false, sourceHash: S.hash };
  }
  if (S.kind === 'file' && D.hash === S.hash) return { outcome: 'present-source-changed', write: false, human: false };
  return { outcome: 'conflict', write: false, human: true };
}

// ── prepare ─────────────────────────────────────────────────────────────────

/** Regular files under `dir` (posix rel paths); links and specials are skipped with a reason. */
function walkMemory(dir) {
  const files = []; const skipped = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(abs, e.name);
      if (e.isSymbolicLink()) { skipped.push({ rel: r, reason: 'link' }); continue; }
      if (e.isDirectory()) { walk(p, r); continue; }
      if (!e.isFile()) { skipped.push({ rel: r, reason: 'not-a-file' }); continue; }
      const buf = fs.readFileSync(p);
      files.push({ rel: r, sha256: sha256(buf), bytes: buf.length });
    }
  };
  walk(dir, '');
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, skipped };
}

/** Every `projects/*\/memory` under the config root (account-wide, independent of the invoking repo). */
export function collectMemory(configDir) {
  const projects = path.join(configDir, 'projects');
  let entries = [];
  try { entries = fs.readdirSync(projects, { withFileTypes: true }); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const memory = []; const anomalies = []; const errors = [];
  // Classify BEFORE filtering: a linked project dir is reported, never dropped as if it held no memory.
  for (const e of entries) if (e.isSymbolicLink()) anomalies.push({ kind: 'project-is-link', detail: e.name });
  const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  for (const dirName of names.sort()) {
    const mem = path.join(projects, dirName, 'memory');
    // ENOENT = this project simply has no memory (most are transcript-only). ANY other failure means the
    // inventory was NOT measured, and must be said — never read as "no memory here" (audit R1-H5/H10).
    let st; try { st = fs.lstatSync(mem); } catch (e) { if (e.code !== 'ENOENT') errors.push({ dirName, reason: e.code ?? 'lstat-failed' }); continue; }
    if (st.isSymbolicLink()) { anomalies.push({ kind: 'memory-is-link', detail: dirName }); continue; }
    if (!st.isDirectory()) continue;
    if (!SLUG_RE.test(dirName)) { anomalies.push({ kind: 'unsafe-slug', detail: dirName }); continue; }
    let walked;
    try { walked = walkMemory(mem); } catch (e) { errors.push({ dirName, reason: e.code ?? 'read-failed' }); continue; }
    const { files, skipped } = walked;
    memory.push({ dirName, files, skipped });
    if (!files.some((f) => f.rel === 'MEMORY.md')) anomalies.push({ kind: 'no-memory-index', detail: dirName });
    if (/--claude-worktrees-/.test(dirName)) anomalies.push({ kind: 'memory-under-worktree-slug', detail: dirName });
  }
  const byLower = new Map();
  for (const m of memory) byLower.set(m.dirName.toLowerCase(), [...(byLower.get(m.dirName.toLowerCase()) ?? []), m.dirName]);
  for (const group of byLower.values()) if (group.length > 1) anomalies.push({ kind: 'case-duplicate-slugs', detail: group.join(' ~ ') });
  return { memory, anomalies, errors };
}

/** Scheduled tasks under the config root: id + its frontmatter description. */
export function collectScheduledTasks(configDir) {
  let ids = [];
  try { ids = fs.readdirSync(scheduledTasksDir(configDir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return ids.sort().map((id) => {
    let description = '';
    try {
      const text = fs.readFileSync(path.join(scheduledTasksDir(configDir), id, 'SKILL.md'), 'utf8');
      description = (/^description:\s*(.+)$/m.exec(text)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
    } catch { description = '(no SKILL.md)'; }
    return { id, description };
  });
}

/** The account file: under the config root when CLAUDE_CONFIG_DIR is set, else beside the home directory. */
export const claudeJsonPath = (configDir, env = process.env, homedir = os.homedir()) =>
  (env.CLAUDE_CONFIG_DIR?.trim() ? path.join(configDir, '.claude.json') : path.join(homedir, '.claude.json'));

/**
 * User-level settings: presence + hash only. Contents are never copied or embedded (may hold tokens).
 * `.claude.json` carries NO hash: the app rewrites it every minute or two (plan M13), so a hash could never read
 * "same"; its identity is compared by `accountIdentity` instead.
 */
export function settingsFiles(configDir, env = process.env, homedir = os.homedir()) {
  return [['settings.json', path.join(configDir, 'settings.json')], ['.claude.json', claudeJsonPath(configDir, env, homedir)]].map(([name, p]) => {
    const pr = probeFile(p);
    if (name === '.claude.json') return { name, path: p, exists: pr.kind === 'file', sha256: null, volatile: true };
    return { name, path: p, exists: pr.kind === 'file', sha256: pr.kind === 'file' ? pr.hash : null };
  });
}

/**
 * Account identity from `.claude.json`, by WHITELIST (plan o): `oauthAccount.accountUuid`, `.emailAddress`,
 * `.organizationUuid`, and the NAMES of MCP servers (top-level and per project; projects with none omitted). The
 * file also holds tokens, so nothing outside those keys is read into the result. Never throws: an absent or
 * unparseable file is `account: null` with a reason.
 */
export function accountIdentity(file) {
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { account: null, reason: e.code === 'ENOENT' ? '.claude.json absent' : `.claude.json unreadable (${e.code ?? 'not valid JSON'})`, mcp: null };
  }
  const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const o = isObj(json?.oauthAccount) ? json.oauthAccount : null;
  const account = o ? { accountUuid: str(o.accountUuid), emailAddress: str(o.emailAddress), organizationUuid: str(o.organizationUuid) } : null;
  const names = (v) => (isObj(v) ? Object.keys(v).sort() : []);
  const projects = isObj(json?.projects)
    ? Object.keys(json.projects).sort().map((p) => ({ path: p, names: names(json.projects[p]?.mcpServers) })).filter((p) => p.names.length)
    : [];
  return { account, ...(account ? {} : { reason: 'no oauthAccount in .claude.json' }), mcp: { global: names(json?.mcpServers), projects } };
}

/**
 * Source identity against this account's (plan o). The key is `accountUuid`, else the address; either side missing
 * a key is `unknown`, never "same". MCP servers are compared by name only, as `name` or `name (project)`.
 */
export function compareIdentity(src, mine) {
  const key = (a) => a?.accountUuid ?? a?.emailAddress ?? null;
  const account = !src ? { status: 'unknown', reason: 'not recorded at prepare (manifest predates identity)' }
    : !key(src.account) ? { status: 'unknown', reason: `source: ${src.reason ?? 'no account id'}` }
      : !key(mine.account) ? { status: 'unknown', reason: `this account: ${mine.reason ?? 'no account id'}` }
        : { status: key(src.account) === key(mine.account) ? 'same' : 'different', source: src.account.emailAddress, mine: mine.account.emailAddress };
  const flat = (mcp) => (mcp ? [...mcp.global, ...mcp.projects.flatMap((p) => p.names.map((n) => `${n} (${p.path})`))] : null);
  const a = flat(src?.mcp); const b = flat(mine.mcp);
  const mcp = a && b ? { added: b.filter((n) => !a.includes(n)), removed: a.filter((n) => !b.includes(n)) } : null;
  return { account, mcp };
}

/** The documented wait token for "blocked on the account switch itself" (plan s): case, spaces, `_` and `-` folded. */
export const SWITCH_TOKEN = 'account-switch';
export const normaliseWaitRef = (ref) => String(ref ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '-');

/**
 * A repo's identity is its MAIN checkout (the parent of the git common dir), whichever worktree runs
 * the command: fleet's registry is per repo, so a worktree path and the main path are the same repo.
 */
export function mainCheckout(cwd) {
  const common = gitCommonDir(cwd);
  if (common.ok && path.basename(common.dir).toLowerCase() === '.git') return path.resolve(path.dirname(common.dir));
  const top = repoToplevel(cwd);
  return path.resolve(top.ok ? top.dir : cwd);
}

/** The repos whose fleet state is in scope: invoking repo + registered consumers (when the source resolves) + --repo. */
async function resolveRepoScope(cwd, extra = []) {
  const invoking = mainCheckout(cwd);
  const src = resolveSourceRepo({ cwd: invoking });
  const sourceRepo = src.type === 'resolved' ? { type: 'resolved', path: src.path } : { type: src.type, reason: src.reason ?? src.value ?? src.type };
  const paths = [invoking];
  if (src.type === 'resolved') {
    paths.push(src.path);
    try {
      const mod = await import(pathToFileURL(path.join(src.path, 'scripts', 'lib', 'consumer-repos.mjs')).href);
      for (const r of mod.CONSUMER_REPOS ?? []) if (r.path) paths.push(path.resolve(src.path, r.path));
    } catch (e) { sourceRepo.registryError = e.message; }
  }
  for (const r of extra) paths.push(path.resolve(r));
  const seen = []; const repos = [];
  for (const p of paths) if (!seen.some((s) => samePath(s, p))) { seen.push(p); repos.push(p); }
  return { sourceRepo, repos };
}

/** The fleet CLI as THAT repo invokes it: the source repo runs it in place, a consumer from its synced tree. */
export function fleetCliFor(repo) {
  return fs.existsSync(path.join(repo, 'scripts', 'sync-to-repos.mjs')) ? 'node scripts/fleet.mjs' : 'node scripts/.claude-skills/fleet.mjs';
}

/**
 * The branches a handover asks merged evidence for: every non-terminal claim's branch and every branch
 * checked out in a listed worktree, never the base. A branch left out would always read "not merged" — an
 * unasked question is not an empty answer — so a landed claim would stay live (defect h).
 */
export function mergedEvidenceNames({ registry, worktreeList, base, extra = [] }) {
  const names = new Set(extra);
  for (const s of registry?.sessions ?? []) if (s.source?.branch && !isTerminalState(s.state)) names.add(s.source.branch);
  for (const w of worktreeList?.worktrees ?? []) if (w.branch && !w.bare) names.add(w.branch);
  names.delete(base);
  return [...names];
}

/**
 * ONE derivation of a repo's coordination state, shared by prepare and receive (defect h): the same
 * `gatherFacts` + `buildStatusFrom` that `status` renders, with merged evidence for the branches that can
 * retire a claim. The registry is read once here to name those branches; a claim registered between that
 * read and gatherFacts' own simply has no evidence asked for, so it reads live (the safe direction).
 */
function gatherLive(repo, { config, env, now, deadlineAt = null }) {
  const worktreeList = listWorktrees(repo);
  // Branch-only unregistered candidates (ahead of base, or ahead unknown) need evidence too, or every one of
  // them would read `unverified`: they come from ONE listBranches call made before gatherFacts.
  const local = listBranches(repo, config.baseBranch);
  const branchOnly = (local.branches ?? []).filter((b) => b.ahead !== 0).map((b) => b.name);
  const names = mergedEvidenceNames({ registry: readSessions(fleetDir(repo)), worktreeList, base: config.baseBranch, extra: branchOnly });
  const facts = gatherFacts({ cwd: repo, config, now, env, prs: false, patches: false, worktrees: true, untracked: false, merged: names, checks: false, uncommitted: 'all', deadlineAt });
  const status = buildStatusFrom(facts);
  return { facts, status, ...liveSessionsOf(facts, status) };
}

/**
 * Unregistered work for a handover, as manifest fields. A scan that did not reach every candidate is NOT
 * MEASURED (fail closed): its items are kept, and `unregisteredUnknown` says what was left out.
 */
function unregisteredFields(repo, ctx, claimed, deps) {
  const u = unregisteredWork(repo, ctx, claimed, deps);
  if (!u.queried) return { unregistered: [], unregisteredUnknown: u.reason };
  const gaps = [u.notProbed ? `scan deadline reached: ${u.notProbed} worktree(s)/branch(es) not probed` : null, u.branchesUnknown ?? null].filter(Boolean);
  return { unregistered: u.items, ...(gaps.length ? { unregisteredUnknown: gaps.join('; ') } : {}) };
}

/**
 * A pasteable fleet command: `cli` is a rendered invocation prefix (`fleetCliFor`, or a manifest's copy of it), used
 * as is and never re-split; only the arguments added here go through the shell quoter.
 */
export const cliCommand = (cli, args) => `${cli} ${renderCommand(args)}`;

/** A merged-unreleased claim as a handover lists it: what landed, and the exact command that retires it. */
function mergedUnreleasedEntry(i, fleetCli) {
  return { id: i.id, branch: i.branch ?? null, note: i.notes.find((n) => n.startsWith('derived done')) ?? 'derived done', release: cliCommand(fleetCli, ['release', '--id', i.id]) };
}

/**
 * Could this repo's PR state be read (plan e)? `facts.merged.prs` verbatim — the merged-PR query a handover already
 * makes, so no extra gh call — plus `owner/repo` from `origin`, to name the account that is needed.
 */
export function ghReachability(repo, facts, { git = runGit } = {}) {
  const prs = facts?.merged?.prs ?? { queried: false, reason: 'not measured' };
  const url = git(['remote', 'get-url', 'origin'], repo);
  const parsed = url.ok ? parseOriginRepo(url.stdout) : null;
  return { gh: { queried: Boolean(prs.queried), ...(prs.queried ? {} : { reason: String(prs.reason ?? 'not queried') }) }, ghRepo: parsed?.slug ?? null };
}

/** Live coordination state for one repo; a repo without fleet state is reported, never an error. */
function repoState(repo, { env, now, deadlineAt }) {
  const fleetCli = fleetCliFor(repo);
  let dir;
  try { dir = fleetDir(repo); } catch (e) { return { path: repo, fleetCli, fleet: 'error', error: e.message, sessions: [], unregistered: [], unregisteredUnknown: `not a git repo: ${e.message}` }; }
  const wtList = listWorktrees(repo);
  let config;
  try { config = resolveConfig(repo, { env }); } catch (e) {
    // Sessions cannot be read without config, but worktrees still can: probe them (nothing counts as claimed,
    // and with no base nothing can be counted off it, so every candidate fails closed as `unverified`).
    return { path: repo, fleetCli, fleet: 'error', error: `config: ${e.message}`, sessions: [], ...unregisteredFields(repo, { cwd: repo, env, now }, {}, { list: () => wtList, deadlineAt }) };
  }
  // A repo with no fleet registry can still hold unregistered work in its worktrees: always look.
  const { facts, live, mergedUnreleased } = gatherLive(repo, { config, env, now, deadlineAt });
  const gh = ghReachability(repo, facts);
  const unregisteredFor = (claimed) => unregisteredFields(repo, { cwd: repo, config, env, now }, claimed, { facts, list: () => wtList, deadlineAt });
  if (!fs.existsSync(dir)) return { path: repo, fleetCli, fleet: 'absent', sessions: [], ...gh, ...unregisteredFor({}) };
  const ctx = { cwd: repo, config, env, now };
  const sessions = live.map((i) => {
    // An adopted session (`fleet add`) records no worktree: resolve it from where its branch is checked out.
    const worktree = i.worktree ?? (i.branch ? (wtList.worktrees ?? []).find((w) => !w.bare && w.branch === i.branch)?.path ?? null : null);
    const s = {
      id: i.id, intent: i.intent ?? '', state: i.state, branch: i.branch ?? null, worktree,
      paths: i.paths ?? [], ready: i.ready ?? null, readyStale: Boolean(i.readyStale), waitingOn: i.waitingOn ?? [],
      uncommittedFiles: i.uncommittedFiles ?? [], ...(i.uncommittedUnknown ? { uncommittedUnknown: i.uncommittedUnknown } : {}),
    };
    if (worktree) {
      const r = archiveReport(ctx, { branch: i.branch ?? null, worktree });
      s.risks = Object.fromEntries(Object.entries(r.risks).map(([k, v]) => [k, v.length]));
      if (r.unverified.length) s.unverified = r.unverified;
    }
    return s;
  });
  const directives = readDirectives(dir);
  const trains = listTrains(dir);
  // A registry that could not be read completely is NOT MEASURED here exactly as it is at receive: the sessions
  // that were readable are kept, and the repo is marked so prepare refuses rather than reading "these are all".
  const incomplete = facts.registry?.complete === false ? { fleet: 'error', error: 'registry incomplete (unreadable session records)' } : { fleet: 'present' };
  return {
    path: repo, fleetCli, ...incomplete, sessions, mergedUnreleased: mergedUnreleased.map((i) => mergedUnreleasedEntry(i, fleetCli)), ...gh,
    directives: directives.active.length, trains: trains.trains.filter((t) => !['landed', 'abandoned'].includes(t.phase)).length,
    // A merged-unreleased record is still non-terminal, so it still covers its worktree until it is released.
    ...unregisteredFor(coveredBy([...live, ...mergedUnreleased])),
  };
}

// ── manifest schema (receive consumes it; zod strict on what it reads) ───────

const FileEntry = z.object({ rel: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative() }).strict();
const MemoryEntry = z.object({
  dirName: z.string().regex(SLUG_RE),
  files: z.array(FileEntry),
  skipped: z.array(z.object({ rel: z.string(), reason: z.string() }).strict()),
}).strict();
// The verdict fields are optional: a manifest written before verdicts existed still parses (and every one of
// its items blocks, `blocksHandover`). A branch-only candidate has no worktree.
const UnregisteredEntry = z.object({
  worktree: z.string().nullable(), branch: z.string().nullable(), detached: z.boolean(), locked: z.boolean(),
  risks: z.object(Object.fromEntries(RISK_KINDS.map((k) => [k, z.number().int().nonnegative()]))).strict(),
  unverified: z.array(z.string()).optional(),
  kind: z.enum(['worktree', 'branch']).optional(), head: z.string().nullable().optional(), ahead: z.number().int().nonnegative().nullable().optional(),
  committed: z.enum(['none', 'pushed', 'unpushed', 'unknown']).optional(), evidence: z.enum(['landed', 'duplicate', 'none', 'incomplete']).optional(),
  duplicateOf: z.string().optional(), verdict: z.enum(VERDICTS).optional(), row: z.string().optional(), blocks: z.boolean().optional(),
  preserved: z.string().optional(), reason: z.string().optional(), via: z.enum(['landed', 'duplicate']).optional(), syncOwnedDirty: z.literal(true).optional(),
  idleDays: z.number().int().nonnegative().nullable().optional(), stale: z.boolean().optional(), lastActivity: z.string().nullable().optional(),
  mtimeNotStatted: z.number().int().positive().optional(),
}).strict();
const MergedUnreleasedEntry = z.object({ id: z.string(), branch: z.string().nullable(), note: z.string(), release: z.string() }).strict();
export const HandoverManifestSchema = z.object({
  schemaVersion: z.literal(HANDOVER_SCHEMA_VERSION),
  id: z.string().regex(OP_ID_RE),
  createdAt: z.string(),
  sourceConfigDir: z.string().min(1),
  sourceConfigDirReal: z.string().min(1),
  invokingRepo: z.string(),
  fleetCommand: z.string(),
  scope: z.object({
    sourceRepo: z.object({ type: z.string(), path: z.string().optional(), reason: z.string().optional(), registryError: z.string().optional() }).strict(),
    repos: z.array(z.object({
      path: z.string(), fleetCli: z.string().optional(), fleet: z.enum(['present', 'absent', 'error']), error: z.string().optional(),
      directives: z.number().optional(), trains: z.number().optional(), sessions: z.array(z.object({ id: z.string() }).passthrough()),
      // optional: whether this repo's PR state could be read (plan e); absent in a manifest written before it
      gh: z.object({ queried: z.boolean(), reason: z.string().optional() }).strict().optional(), ghRepo: z.string().nullable().optional(),
      // optional: a manifest written before unregistered-work detection still parses (it just reports none)
      unregistered: z.array(UnregisteredEntry).optional(), unregisteredUnknown: z.string().optional(),
      // optional: a manifest written before defect h's fix lists merged-unreleased claims as sessions instead
      mergedUnreleased: z.array(MergedUnreleasedEntry).optional(),
    }).strict()),
  }).strict(),
  memory: z.array(MemoryEntry),
  memoryErrors: z.array(z.object({ dirName: z.string(), reason: z.string() }).strict()),
  anomalies: z.array(z.object({ kind: z.string(), detail: z.string() }).strict()),
  // export/schedule/scheduleUnknown are optional (PR 4): a manifest written before them still parses.
  scheduledTasks: z.array(z.object({
    id: z.string(), description: z.string(),
    export: z.object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative() }).strict().optional(),
    schedule: z.object({ cronExpression: z.string().nullable().optional(), fireAt: z.string().nullable().optional(), enabled: z.boolean().optional(), lastRunAt: z.string().nullable().optional() }).strict().optional(),
    scheduleUnknown: z.string().optional(),
  }).strict()),
  // optional (PR 4): the machine lease at prepare, or why it could not be read
  lease: z.union([
    z.object({ unmeasured: z.string() }).strict(),
    z.object({
      holder: z.object({ holder: z.string().nullable(), repo: z.string().nullable(), kind: z.string().nullable(), expiresAt: z.string().nullable() }).strict().nullable(),
      waiters: z.array(z.object({ repo: z.string().nullable(), since: z.string().nullable() }).strict()),
      windows: z.array(z.object({ id: z.string().nullable(), kind: z.string().nullable(), repo: z.string().nullable(), from: z.string().nullable(), until: z.string().nullable() }).strict()),
      turn: z.object({ repo: z.string().nullable(), endsAt: z.string().nullable() }).strict().nullable(),
    }).strict(),
  ]).optional(),
  memoryBackupCmd: z.string().optional(),
  // `volatile`: compared by identity, never by hash (plan o). A manifest written before it carries a `.claude.json`
  // hash, which receive ignores.
  settings: z.array(z.object({ name: z.string(), path: z.string(), exists: z.boolean(), sha256: z.string().nullable(), volatile: z.literal(true).optional() }).strict()),
  // optional (plan o, r): absent in a manifest written before them
  identity: z.object({
    account: z.object({ accountUuid: z.string().nullable(), emailAddress: z.string().nullable(), organizationUuid: z.string().nullable() }).strict().nullable(),
    reason: z.string().optional(),
    mcp: z.object({ global: z.array(z.string()), projects: z.array(z.object({ path: z.string(), names: z.array(z.string()) }).strict()) }).strict().nullable(),
  }).strict().optional(),
  schedulerChecked: z.boolean().optional(),
}).strict();

/** Reserve `<dir>/handover-<id>.<ext>` exclusively; retry with a fresh suffix on EEXIST (R1-H3). */
function reserveArtifacts(dir, now) {
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = handoverId(now);
    const json = path.join(dir, `handover-${id}.json`);
    const md = path.join(dir, `handover-${id}.md`);
    try {
      fs.closeSync(fs.openSync(json, 'wx'));
      try { fs.closeSync(fs.openSync(md, 'wx')); } catch (e) { fs.unlinkSync(json); throw e; }
      return { id, json, md };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error(`could not reserve a unique handover id under ${dir}`);
}

/** The machine lease as prepare saw it; an unreadable one is `{unmeasured}`, never an empty lease. */
export function leaseState(env, now) {
  const str = (v) => (v === undefined || v === null ? null : String(v));
  try {
    const s = summarise(readLease(machineDir(env)), now instanceof Date ? now : new Date(), defaultProbe());
    if (!s.measured) return { unmeasured: s.reason ?? s.state };
    const h = s.holder;
    return {
      holder: h ? { holder: str(h.holder), repo: str(h.repo), kind: str(h.kind), expiresAt: str(h.expiresAt) } : null,
      waiters: (s.waiters ?? []).map((w) => ({ repo: str(w.repo), since: str(w.since) })),
      windows: (s.windows ?? []).map((w) => ({ id: str(w.id), kind: str(w.kind), repo: str(w.repo), from: str(w.from), until: str(w.until) })),
      turn: s.turn ? { repo: str(s.turn.repo), endsAt: str(s.turn.endsAt) } : null,
    };
  } catch (e) { return { unmeasured: e.message }; }
}

/**
 * prepare: everything account-bound and coordination-live, written as JSON + markdown. Writes nothing to repos.
 * Returns `{error}` (nothing published) when the scheduler snapshot is invalid or a task cannot be exported.
 * `taskIo` and `beforeManifest` are fault-injection seams for the publication contract.
 */
export async function prepareHandover(ctx, flags = {}, { homedir = os.homedir(), taskIo, beforeManifest, removeTasks } = {}) {
  const configDir = claudeConfigDir(ctx.env, { homedir });
  const tasks = collectScheduledTasks(configDir);
  let byId = null;
  if (flags['--scheduler-snapshot'] !== undefined) {
    let text;
    try { text = fs.readFileSync(path.resolve(ctx.cwd, String(flags['--scheduler-snapshot'])), 'utf8'); } catch (e) { return { error: `cannot read the scheduler snapshot (${e.code ?? e.message})` }; }
    const snap = parseSchedulerSnapshot(text, tasks.map((t) => t.id));
    if (!snap.ok) return { error: snap.reason };
    byId = snap.byId;
  }
  const { memory, anomalies, errors: memoryErrors } = collectMemory(configDir);
  const scope = await resolveRepoScope(ctx.cwd, flags['--repo'] ?? []);
  const deadlineAt = Date.now() + UNREGISTERED_BUDGET.handoverMs;
  const repos = scope.repos.map((r) => repoState(r, { env: ctx.env, now: ctx.now, deadlineAt }));
  const handoverDir = path.join(ctx.dir, 'handover');
  const art = reserveArtifacts(handoverDir, ctx.now instanceof Date ? ctx.now : new Date());
  const tasksDir = path.join(handoverDir, `handover-${art.id}-tasks`);
  // Returns what it could NOT remove, so a failure report never claims a rollback that did not happen.
  const unpublish = (withTasks) => {
    const left = [];
    for (const f of [art.json, art.md]) { try { fs.rmSync(f, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (e) { left.push(`${f} (${e.code ?? e.message})`); } }
    if (withTasks) { try { (removeTasks ?? ((p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })))(tasksDir); } catch (e) { left.push(`${tasksDir} (${e.code ?? e.message})`); } }
    return left.length ? ` NOT removed, delete by hand: ${left.join(', ')}` : '';
  };
  let exports = null;
  if (tasks.length) {
    const st = stageTaskExports({ configDir, ids: tasks.map((t) => t.id), destDir: tasksDir, io: taskIo });
    if (!st.ok) return { error: `scheduled-task export failed: ${st.reason}; nothing was published.${unpublish(false)}` };
    exports = st.exports;
  }
  const manifest = {
    schemaVersion: HANDOVER_SCHEMA_VERSION, id: art.id, createdAt: new Date().toISOString(),
    sourceConfigDir: configDir, sourceConfigDirReal: realWithTail(configDir), invokingRepo: scope.repos[0],
    fleetCommand: ctx.cmd ?? 'node scripts/fleet.mjs',
    scope: { sourceRepo: scope.sourceRepo, repos }, memory, memoryErrors, anomalies,
    scheduledTasks: joinTaskRecords(tasks, exports, byId), settings: settingsFiles(configDir, ctx.env, homedir),
    lease: leaseState(ctx.env, ctx.now),
    ...(ctx.env.FLEET_MEMORY_BACKUP_CMD?.trim() ? { memoryBackupCmd: ctx.env.FLEET_MEMORY_BACKUP_CMD.trim() } : {}),
    identity: accountIdentity(claudeJsonPath(configDir, ctx.env, homedir)),
    schedulerChecked: Boolean(flags['--scheduler-checked']),
  };
  try {
    beforeManifest?.();
    HandoverManifestSchema.parse(manifest); // a manifest prepare cannot itself validate is a bug, never a file
    // The markdown first, the manifest LAST: the manifest is what makes a handover receivable.
    atomicWriteFileSync(art.md, renderHandoverMarkdown(manifest, art));
    atomicWriteFileSync(art.json, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (e) {
    const left = unpublish(true);
    return { error: `the handover could not be published (${e.message}); ${left ? `rollback incomplete.${left}` : 'the task copies were removed'}` };
  }
  return { manifest, artifacts: art };
}

// ── receive ─────────────────────────────────────────────────────────────────

/**
 * Ids of sibling `handover-<id>.json` manifests newer than `id` (ids sort chronologically); unparseable names ignored.
 * A directory that cannot be listed is `{ok:false}`, never an empty list: "no newer manifest" must be a measurement.
 * @returns {{ok: true, newer: string[]} | {ok: false, reason: string}}
 */
export function newerManifests(dir, id, { readdir = fs.readdirSync } = {}) {
  let names;
  try { names = readdir(dir); } catch (e) { return { ok: false, reason: `${dir} could not be listed (${e.code ?? e.message})` }; }
  return { ok: true, newer: names.map((n) => /^handover-(.+)\.json$/.exec(n)?.[1]).filter((x) => x && OP_ID_RE.test(x) && x > id).sort() };
}

/** Parse + validate a manifest; every failure is a named reason, never a clean report. */
export function loadManifest(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, reason: e.code === 'ENOENT' ? 'manifest-missing' : 'manifest-unreadable', detail: `${file}: ${e.message}` };
  }
  let json;
  try { json = JSON.parse(text); } catch (e) { return { ok: false, reason: 'manifest-malformed', detail: e.message }; }
  if (json?.schemaVersion !== HANDOVER_SCHEMA_VERSION) return { ok: false, reason: 'manifest-schema-version', detail: `got ${JSON.stringify(json?.schemaVersion)}, expected ${HANDOVER_SCHEMA_VERSION}` };
  const parsed = HandoverManifestSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'manifest-schema', detail: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { ok: true, manifest: parsed.data };
}

/** The destination dir name for a source slug: reuse an existing case-variant on win32, else the source's exact name. */
function destDirName(destConfigDir, dirName, platform = process.platform) {
  if (platform !== 'win32') return dirName;
  try {
    const hit = fs.readdirSync(path.join(destConfigDir, 'projects')).find((n) => n.toLowerCase() === dirName.toLowerCase());
    return hit ?? dirName;
  } catch { return dirName; }
}

/** Plan every memory file against the destination (no writes). */
function planMemory(manifest, destConfigDir, destReal) {
  let srcCfgReal = null;
  try { srcCfgReal = fs.realpathSync.native(manifest.sourceConfigDir); } catch { srcCfgReal = null; }
  const plan = [];
  for (const m of manifest.memory) {
    const name = destDirName(destConfigDir, m.dirName);
    const srcRoot = path.join(manifest.sourceConfigDir, 'projects', m.dirName, 'memory');
    let srcRootReal = null; let srcRootErr = null;
    try { srcRootReal = fs.realpathSync.native(srcRoot); } catch (e) { srcRootErr = e.code ?? 'unreadable'; }
    // The memory dir must still BE <canonical source config root>/projects/<dirName>/memory: a dir swapped
    // for a link since prepare cannot anchor its own containment check (audit R1-H3/H7).
    if (srcRootReal && !samePath(srcRootReal, path.join(srcCfgReal ?? '', 'projects', m.dirName, 'memory'))) {
      srcRootErr = 'source-root-moved'; srcRootReal = null;
    }
    const dstRoot = path.join(destReal, 'projects', name, 'memory');
    for (const f of m.files) {
      const segs = safeRelSegments(f.rel);
      if (!segs) { plan.push({ dirName: m.dirName, rel: f.rel, outcome: 'unsafe-path', write: false, human: true }); continue; }
      const target = path.join(dstRoot, ...segs);
      const unsafe = linkBelow(destReal, target);
      if (unsafe) { plan.push({ dirName: m.dirName, rel: f.rel, target, outcome: 'unsafe-destination', write: false, human: true, reason: unsafe }); continue; }
      const source = path.join(srcRoot, ...segs);
      const readS = () => {
        if (srcRootErr) return srcRootErr === 'ENOENT' ? { kind: 'absent' } : { kind: 'error', reason: srcRootErr };
        let real;
        try { real = fs.realpathSync.native(source); } catch (e) { return e.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'error', reason: e.code ?? 'realpath-failed' }; }
        const rel = path.relative(srcRootReal, real);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { kind: 'error', reason: 'outside-root' };
        return probeFile(source);
      };
      plan.push({ dirName: m.dirName, rel: f.rel, source, target, prepared: f.sha256, ...decideFile(f.sha256, probeFile(target), readS) });
    }
  }
  return plan;
}

/** Copy one planned file via staging + exclusive hard-link publish (R1-H2); EEXIST is re-classified, never overwritten. */
/**
 * Copy one planned file via staging + exclusive hard-link publish (R1-H2); EEXIST is re-classified, never
 * overwritten. Every failure is a per-file outcome, never a throw that strands later files (audit R1-M5).
 * The destination is re-checked for links right before publishing (audit R1-H2/H8): Node has no dirfd
 * APIs, so a NON-cooperating writer racing in that instant remains a documented residual; cooperating
 * receivers are excluded by the lock.
 */
function publishOne(item, stagingDir, seq, rootReal) {
  const staged = path.join(stagingDir, `${seq}.tmp`);
  const fail = (outcome, reason) => {
    try { fs.unlinkSync(staged); } catch { /* not created yet / already gone */ }
    return { ...item, outcome, write: false, human: true, ...(reason ? { reason } : {}) };
  };
  try {
    fs.copyFileSync(item.source, staged, fs.constants.COPYFILE_EXCL);
    if (sha256(fs.readFileSync(staged)) !== item.sourceHash) return fail('source-changed-during-copy');
    fs.mkdirSync(path.dirname(item.target), { recursive: true });
    const unsafe = linkBelow(rootReal, item.target);
    if (unsafe) return fail('unsafe-destination', unsafe);
    try { fs.linkSync(staged, item.target); } catch (e) {
      if (e.code !== 'EEXIST') return fail('publish-failed', e.code ?? e.message);
      fs.unlinkSync(staged);
      const D = probeFile(item.target);
      // The target existed at link time but not now: something else is writing here. Never report a copy.
      if (D.kind === 'absent') return { ...item, outcome: 'publish-raced', write: false, human: true };
      return { ...item, ...decideFile(item.prepared, D, () => ({ kind: 'file', hash: item.sourceHash })), raced: true };
    }
    fs.unlinkSync(staged);
    return item;
  } catch (e) {
    return fail('publish-failed', e.code ?? e.message);
  }
}

/** Sweep staging dirs of DEAD runs. Only called while holding the lock (no other receive can be live) (R2-H1/R3-H1). */
function sweepStaging(stagingRoot) {
  const swept = []; const kept = [];
  let entries = [];
  try { entries = fs.readdirSync(stagingRoot, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return { swept, kept }; throw e; }
  for (const e of entries) {
    const p = path.join(stagingRoot, e.name);
    const st = fs.lstatSync(p);
    if (!OP_ID_RE.test(e.name) || st.isSymbolicLink() || !st.isDirectory()) { kept.push(e.name); continue; }
    const kids = fs.readdirSync(p, { withFileTypes: true });
    if (!kids.every((k) => k.isFile() && /^\d+\.tmp$/.test(k.name))) { kept.push(e.name); continue; }
    for (const k of kids) fs.unlinkSync(path.join(p, k.name));
    fs.rmdirSync(p);
    swept.push(e.name);
  }
  return { swept, kept };
}

/** The registry-flow step receive prints first when `schedule-reconcile` is installed under the config root. */
export function reconcileStep(r, tasks = []) {
  if (r.registryError) return `${RECONCILE_ID} is installed but its registry ${r.registry} cannot be read (${r.registryError}): fix the registry, then run ${RECONCILE_ID}; do not recreate tasks by hand meanwhile`;
  const covered = tasks.filter((t) => r.covered.includes(t.id)).length;
  return `first: if list_scheduled_tasks has no ${RECONCILE_ID}, create it from ${r.skill} (taskId ${RECONCILE_ID}, cron ${r.cron ? `"${r.cron}"` : `as in ${r.registry}`}); then run it (run_scheduled_task ${RECONCILE_ID}) and read its one-line report. Never hand-recreate a task the registry covers (${covered} of ${tasks.length} in this handover).`;
}

/**
 * What a receive leaves for a human that is NOT a failure (plan p): scheduled tasks to confirm or recreate, settings
 * or MCP differences, a repo whose PR state cannot be read, an account change (or an unknown one), and claims waiting
 * on the switch itself. Each is `{kind, detail}`.
 */
export function receiveFollowUps({ tasks, settingsReview, identity, ghUnknown, waits, reconcile = null }) {
  const out = [];
  // The registry flow comes FIRST, ahead of every per-task line: with it installed, a hand-recreated task is a duplicate.
  if (reconcile) out.push({ kind: 'schedule-reconcile', detail: reconcileStep(reconcile, tasks) });
  if (tasks.length) {
    const missing = tasks.filter((t) => t.file === 'missing').length;
    const uncovered = reconcile?.covered ? tasks.filter((t) => !reconcile.covered.includes(t.id)).map((t) => t.id) : null;
    const todo = !reconcile ? "confirm each in this account's scheduler, recreate what is still wanted"
      : uncovered ? (uncovered.length ? `not in the registry, so confirm by hand: ${uncovered.join(', ')}` : 'all in the registry: schedule-reconcile restores them, never recreate by hand')
        : 'the registry could not be read: fix it before recreating anything';
    out.push({ kind: 'scheduled-tasks', detail: `${tasks.length} scheduled task(s): ${tasks.length - missing} file(s) present, ${missing} missing here — ${todo}` });
    for (const t of tasks.filter((x) => x.exportCheck === 'missing' || x.exportCheck === 'mismatch')) {
      out.push({ kind: 'task-export', detail: `the exported copy of ${t.id} is ${t.exportCheck === 'missing' ? 'missing' : 'not the copy prepare hashed'} (${t.export?.path ?? '?'}): do not recreate from it, read the source account's task instead` });
    }
  }
  for (const s of settingsReview) out.push({ kind: 'settings', detail: `${s.name} ${s.status} — review by hand` });
  const a = identity.account;
  if (a.status === 'different') out.push({ kind: 'account', detail: `account changed: ${a.source ?? '?'} → ${a.mine ?? '?'}` });
  else if (a.status === 'unknown') out.push({ kind: 'account', detail: `account not compared (${a.reason})` });
  if (identity.mcp && (identity.mcp.added.length || identity.mcp.removed.length)) {
    out.push({ kind: 'mcp', detail: `MCP servers${identity.mcp.added.length ? ` added here: ${identity.mcp.added.join(', ')}` : ''}${identity.mcp.removed.length ? `${identity.mcp.added.length ? ';' : ''} missing here: ${identity.mcp.removed.join(', ')}` : ''}` });
  }
  for (const g of ghUnknown) out.push({ kind: 'gh', detail: ghUnknownLine(g) });
  for (const w of waits.filter((x) => x.onSwitch)) {
    out.push({ kind: 'waiting-on-switch', detail: `${w.id} (${w.repo}) waits on the switch itself — unblock now: ${w.clear} (drops only that wait; every other wait is left as it is, with its age)` });
  }
  return out;
}

/** receive: verify (same config root) or additively copy (different one) the memory; flag the human steps. */
export function receiveHandover(ctx, flags, { homedir = os.homedir(), platform = process.platform, readdir = fs.readdirSync } = {}) {
  const fromFile = path.resolve(ctx.cwd, flags['--from']);
  const loaded = loadManifest(fromFile);
  if (!loaded.ok) return failed(`${loaded.reason}: ${loaded.detail}`, { handover: { reason: loaded.reason } });
  const m = loaded.manifest;
  // A newer manifest beside this one means this one is stale (plan l): refuse unless told this is deliberate.
  // A check that could not run refuses the same way — it never reads as "this is the newest".
  const fresh = newerManifests(path.dirname(fromFile), m.id, { readdir });
  if (!flags['--allow-older']) {
    if (!fresh.ok) return refused(`could not check for a newer handover manifest: ${fresh.reason} — pass --allow-older to receive this one without that check`, { handover: { reason: 'newer-manifest-unknown', detail: fresh.reason } });
    if (fresh.newer.length) return refused(`a newer handover manifest sits beside this one (handover-${fresh.newer.at(-1)}.json) — receive that one, or pass --allow-older to receive this older one deliberately`, { handover: { reason: 'newer-manifest', newer: fresh.newer } });
  }
  const destConfigDir = claudeConfigDir(ctx.env, { homedir });
  const destReal = realWithTail(destConfigDir);
  const sameRoot = samePath(destReal, m.sourceConfigDirReal, platform);
  const dryRun = Boolean(flags['--dry-run']);
  const opId = handoverId(ctx.now instanceof Date ? ctx.now : new Date());

  let files; let sweep = { swept: [], kept: [] }; let lockContention = false;
  if (sameRoot) {
    // Same account root: nothing to copy. Verify every recorded file is still there and unchanged.
    files = m.memory.flatMap((mem) => mem.files.map((f) => {
      const segs = safeRelSegments(f.rel);
      if (!segs) return { dirName: mem.dirName, rel: f.rel, outcome: 'unsafe-path', human: true };
      const D = probeFile(path.join(destReal, 'projects', destDirName(destConfigDir, mem.dirName, platform), 'memory', ...segs));
      const outcome = D.kind === 'file' ? (D.hash === f.sha256 ? 'verified' : 'changed-since-prepare') : D.kind === 'absent' ? 'missing-since-prepare' : 'destination-unreadable';
      return { dirName: mem.dirName, rel: f.rel, outcome, human: outcome === 'destination-unreadable' };
    }));
  } else {
    files = planMemory(m, destConfigDir, destReal);
    if (!dryRun && files.some((f) => f.write)) {
      fs.mkdirSync(destConfigDir, { recursive: true });
      const rootReal = fs.realpathSync.native(destConfigDir); // the root itself may be a link (G2)
      const stagingRoot = path.join(rootReal, STAGING_DIR);
      const res = withFileLockSync(path.join(rootReal, LOCK_FILE), {}, () => {
        const unsafeStaging = linkBelow(rootReal, path.join(stagingRoot, 'x'));
        if (unsafeStaging) return { unsafe: unsafeStaging };
        sweep = sweepStaging(stagingRoot);
        const replanned = planMemory(m, destConfigDir, rootReal); // re-validate UNDER the lock (R3-M1)
        fs.mkdirSync(stagingRoot, { recursive: true });
        const stagingDir = path.join(stagingRoot, opId);
        fs.mkdirSync(stagingDir); // exclusive: fails if it exists
        let seq = 0;
        const out = replanned.map((item) => (item.write ? publishOne(item, stagingDir, seq++, rootReal) : item));
        fs.rmdirSync(stagingDir);
        return { out };
      });
      if (!res.ok) {
        // Nothing was published by THIS receiver: planned copies must not read as done (audit R2-M1).
        lockContention = true;
        files = files.map((f) => (f.write ? { ...f, outcome: 'not-written-lock-held', write: false } : f));
      }
      else if (res.value.unsafe) files = files.map((f) => (f.write ? { ...f, outcome: 'unsafe-destination', write: false, human: true, reason: res.value.unsafe } : f));
      else files = res.value.out;
    }
  }

  const taskRoot = scheduledTasksDir(destConfigDir);
  const exportCheck = new Map(verifyTaskExports(m.scheduledTasks).map((x) => [x.id, x]));
  const tasks = m.scheduledTasks.map((t) => ({
    ...t, file: fs.existsSync(path.join(taskRoot, t.id, 'SKILL.md')) ? 'present' : 'missing', registration: 'unverified',
    exportCheck: exportCheck.get(t.id)?.export ?? 'none',
  }));
  const reconcile = readScheduleReconcile(destConfigDir);
  const ownSettings = settingsFiles(destConfigDir, ctx.env, homedir);
  const settings = m.settings.map((s) => {
    // `.claude.json` is compared by identity, never by hash: an older manifest's hash is ignored (plan o).
    if (s.volatile || s.name === '.claude.json') return { name: s.name, status: 'by-identity', review: false };
    const mine = ownSettings.find((o) => o.name === s.name);
    const status = !mine?.exists ? (s.exists ? 'absent' : 'same') : mine.sha256 === s.sha256 ? 'same' : 'differs';
    return { name: s.name, status, review: status !== 'same' };
  });
  const identity = compareIdentity(m.identity, accountIdentity(claudeJsonPath(destConfigDir, ctx.env, homedir)));
  // Where each memory dir lands, in the spelling on disk (plan t), so "confirm the path" has something to compare.
  const memoryDest = m.memory.map((mem) => ({ dirName: mem.dirName, dest: path.join(destConfigDir, 'projects', destDirName(destConfigDir, mem.dirName, platform), 'memory') }));
  // ONE live read per scoped repo drives both the live-session list and claimed-worktree coverage: a claim made
  // after prepare is a live session here AND covers its worktree. A registry that cannot be read completely is
  // UNKNOWN live state, never "no live sessions" (audit R1-H4/M4).
  const liveUnknown = [];
  const liveSessions = [];
  const mergedUnreleased = [];
  const ghUnknown = [];
  const unregistered = [];
  const waits = [];
  const deadlineAt = Date.now() + UNREGISTERED_BUDGET.handoverMs;
  for (const r of m.scope.repos) {
    if (!fs.existsSync(r.path)) { unregistered.push({ repo: r.path, unknown: 'repo path no longer exists' }); continue; }
    let claimed = { worktrees: [], branches: [] };
    let dir = null; let g = null; let config = null;
    try { dir = fleetDir(r.path); } catch (e) { liveUnknown.push({ repo: r.path, reason: e.message }); }
    if (dir) {
      try {
        // The same derivation prepare used (`gatherLive`): a claim whose work landed is not live here either.
        config = resolveConfig(r.path, { env: ctx.env });
        g = gatherLive(r.path, { config, env: ctx.env, now: ctx.now, deadlineAt });
      } catch (e) { liveUnknown.push({ repo: r.path, reason: e.message }); }
    }
    // gh reachability is re-measured here too: the new account may read what the old one could not (or not).
    if (g) { const reach = ghReachability(r.path, g.facts); if (!reach.gh.queried) ghUnknown.push({ repo: r.path, ...reach }); }
    if (g && fs.existsSync(dir)) {
      if (!g.facts.registry.complete) liveUnknown.push({ repo: r.path, reason: 'registry incomplete (unreadable session records)' });
      claimed = coveredBy([...g.live, ...g.mergedUnreleased]);
      const atPrepare = new Set(r.sessions.map((x) => x.id));
      const cli = r.fleetCli ?? fleetCliFor(r.path);
      for (const x of g.live) {
        liveSessions.push({ repo: r.path, id: x.id, ...(atPrepare.has(x.id) ? {} : { sincePrepare: true }) });
        // A claim parked on a human wait: the switch token unblocks now; any other human wait gets a note (plan s).
        const human = (x.waitingOn ?? []).filter((w) => w.kind === 'human');
        if (!human.length) continue;
        const isSwitch = (w) => w.kind === 'human' && normaliseWaitRef(w.ref) === SWITCH_TOKEN;
        const onSwitch = human.some(isSwitch);
        // `touch --unwait kind:ref` drops exactly the switch wait(s), inside the registry transaction (plan D10). The recipe used to
        // clear every wait and re-add a SNAPSHOT of the others, which lost any wait added between receive and the command. The
        // ref is printed as STORED (the switch test folds case/spaces/`_`; the removal matches exactly, so these must agree).
        const drop = (x.waitingOn ?? []).filter(isSwitch);
        const clear = onSwitch ? cliCommand(cli, ['touch', '--id', x.id, ...drop.flatMap((w) => ['--unwait', `${w.kind}:${w.ref}`])]) : null;
        waits.push({ repo: r.path, id: x.id, onSwitch, refs: human.map((w) => w.ref), ...(onSwitch ? { clear } : {}) });
      }
      for (const x of g.mergedUnreleased) mergedUnreleased.push({ repo: r.path, ...mergedUnreleasedEntry(x, cli) });
    } else if (dir && !fs.existsSync(dir) && r.sessions.length) liveUnknown.push({ repo: r.path, reason: 'fleet registry missing, but prepare recorded live sessions' });
    // Unregistered work is MEASURED NOW — the prepare snapshot never decides what counts.
    const u = unregisteredFields(r.path, { cwd: r.path, config, env: ctx.env, now: ctx.now }, claimed, { facts: g?.facts ?? null, deadlineAt });
    if (u.unregisteredUnknown) unregistered.push({ repo: r.path, unknown: u.unregisteredUnknown });
    for (const item of u.unregistered) unregistered.push({ repo: r.path, ...item });
  }

  const count = (o) => files.filter((f) => f.outcome === o).length;
  const errors = files.filter((f) => f.human && f.outcome !== 'conflict');
  const conflicts = files.filter((f) => f.outcome === 'conflict');
  const missingTasks = tasks.filter((t) => t.file === 'missing');
  const settingsReview = settings.filter((x) => x.review);
  const followUps = receiveFollowUps({ tasks, settingsReview, identity, ghUnknown, waits, reconcile });
  const handover = {
    id: m.id, mode: sameRoot ? 'same-config-root' : 'copy', dryRun, destConfigDir, sourceConfigDir: m.sourceConfigDir, createdAt: m.createdAt,
    files, sweep, lockContention, tasks, reconcile, settings, identity, memoryDest, liveSessions, waits, mergedUnreleased, ghUnknown, liveUnknown, unregistered,
    anomalies: m.anomalies, memoryErrors: m.memoryErrors, followUps,
    summary: {
      verified: count('verified'), copied: count('copied') + count('copied-source-changed'), present: count('present') + count('present-source-changed'),
      changedSincePrepare: count('changed-since-prepare'), missingSincePrepare: count('missing-since-prepare'),
      conflicts: conflicts.length, errors: errors.length, missingTasks: missingTasks.length, settingsReview: settingsReview.length,
    },
  };
  const text = renderReceiveText(handover);
  // Three classes, worst first (plan p): FAILED (a file could not be decided, copied or verified) outranks REFUSED
  // (a blocking human step), which outranks OK-with-follow-ups. Follow-ups are never failures: exit 0, listed.
  if (errors.length) return failed(`${errors.length} memory file(s) could not be decided or written`, { handover, text });
  if (lockContention) return refused('another handover receive holds the lock on this config root', { handover, text });
  const unmeasured = m.memoryErrors ?? [];
  const blocking = unregistered.filter(blocksHandover);
  if (conflicts.length || liveUnknown.length || unmeasured.length || blocking.length) {
    // An incomplete prepare (unreadable memory dirs) can never receive clean (audit R2-H1).
    const parts = [conflicts.length ? `${conflicts.length} memory conflict(s)` : null, liveUnknown.length ? `live state unknown in ${liveUnknown.length} repo(s)` : null,
      unmeasured.length ? `${unmeasured.length} memory dir(s) NOT measured at prepare — fix and re-prepare` : null, blocking.length ? `${blocking.length} item(s) of blocking unregistered work` : null].filter(Boolean);
    return refused(`blocking steps remain: ${parts.join(', ')}${followUps.length ? ` (plus ${followUps.length} follow-up(s))` : ''}`, { handover, text });
  }
  return ok({ handover, text });
}

/** CLI entry. */
export async function cmdHandover(ctx, flags, positionals) {
  const sub = positionals[0];
  checkHandoverFlags(sub, flags);
  if (sub === 'prepare') {
    const prep = await prepareHandover(ctx, flags);
    if (prep.error) return failed(prep.error, { handover: { reason: 'prepare-failed', detail: prep.error } });
    const { manifest, artifacts } = prep;
    const sessions = manifest.scope.repos.reduce((n, r) => n + r.sessions.length, 0);
    const files = manifest.memory.reduce((n, mm) => n + mm.files.length, 0);
    const ghNote = manifest.scope.repos.filter((r) => r.gh && !r.gh.queried).map((r) => `\n  ${ghUnknownLine(r)}`).join('');
    const scopeNote = ghNote + (manifest.scope.sourceRepo.type === 'resolved' ? '' : `\n  WARNING: source repo not resolved (${manifest.scope.sourceRepo.type}) — per-repo scope limited to the invoking repo and --repo`);
    // A memory dir prepare could not read was NOT measured: the run says so and is not a clean exit.
    const memNote = manifest.memoryErrors.length ? `\n  NOT MEASURED: ${manifest.memoryErrors.map((e) => `${e.dirName} (${e.reason})`).join(', ')} — fix access and re-run prepare` : '';
    const unreg = manifest.scope.repos.reduce((n, r) => n + (r.unregistered ?? []).filter(blocksHandover).length, 0);
    const unregUnknown = manifest.scope.repos.filter((r) => r.unregisteredUnknown || r.fleet === 'error');
    const unregNote = unreg || unregUnknown.length ? `\n  UNREGISTERED WORK: ${unreg} blocking item(s) hold work no claim covers${unregUnknown.length ? `; NOT MEASURED in ${unregUnknown.map((r) => r.path).join(', ')}` : ''} — see "Unregistered work", claim or settle, re-run prepare` : '';
    // The pre-switch gate (plan r): while tasks are listed, the switch is not ready until the operator says the
    // scheduler step was done. A forcing function, not a verification — the CLI cannot read the scheduler.
    const schedulerUnconfirmed = manifest.scheduledTasks.length > 0 && !manifest.schedulerChecked;
    // Each refusal names its own reason; when several apply, all are named (the artefacts are written either way).
    const reasons = [
      manifest.memoryErrors.length ? 'memory dir(s) could not be read at prepare' : null,
      unreg ? 'worktrees hold unregistered work' : unregUnknown.length ? 'repo state could not be measured' : null,
      schedulerUnconfirmed ? 'not ready: scheduler step unconfirmed' : null,
    ].filter(Boolean);
    const relaunch = renderBeforeRelaunch(manifest);
    const head = relaunch.length ? `${relaunch.join('\n')}\n` : '';
    const payload = {
      handover: { id: manifest.id, json: artifacts.json, md: artifacts.md, memoryDirs: manifest.memory.length, memoryFiles: files, memoryErrors: manifest.memoryErrors, sessions, unregistered: unreg, scheduledTasks: manifest.scheduledTasks.length, schedulerChecked: manifest.schedulerChecked, anomalies: manifest.anomalies.length, sourceRepo: manifest.scope.sourceRepo },
      text: `${head}fleet handover prepare ${manifest.id}${memNote}${unregNote}\n  memory: ${manifest.memory.length} dir(s), ${files} file(s) · sessions: ${sessions} · scheduled tasks: ${manifest.scheduledTasks.length} · anomalies: ${manifest.anomalies.length}${scopeNote}\n  read: ${artifacts.md}\n  new account: ${receiveCommand(manifest.fleetCommand, artifacts.json)}`,
    };
    return reasons.length ? refused(reasons.join('; '), payload) : ok(payload);
  }
  return receiveHandover(ctx, flags);
}
