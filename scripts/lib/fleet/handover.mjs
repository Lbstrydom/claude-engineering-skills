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
import { gitCommonDir, repoToplevel } from './git-facts.mjs';
import { archiveReport } from './lifecycle.mjs';
import { fleetDir, listTrains, readSessions, realWithTail } from './registry.mjs';
import { renderChipPrompt } from './render-train.mjs';

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
  prepare: { required: [], forbidden: ['--from', '--dry-run'] },
  receive: { required: ['--from'], forbidden: ['--repo'] },
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
  let names = [];
  try { names = fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const memory = []; const anomalies = [];
  for (const dirName of names.sort()) {
    const mem = path.join(projects, dirName, 'memory');
    let st; try { st = fs.lstatSync(mem); } catch { continue; }
    if (st.isSymbolicLink()) { anomalies.push({ kind: 'memory-is-link', detail: dirName }); continue; }
    if (!st.isDirectory()) continue;
    if (!SLUG_RE.test(dirName)) { anomalies.push({ kind: 'unsafe-slug', detail: dirName }); continue; }
    const { files, skipped } = walkMemory(mem);
    memory.push({ dirName, files, skipped });
    if (!files.some((f) => f.rel === 'MEMORY.md')) anomalies.push({ kind: 'no-memory-index', detail: dirName });
    if (/--claude-worktrees-/.test(dirName)) anomalies.push({ kind: 'memory-under-worktree-slug', detail: dirName });
  }
  const byLower = new Map();
  for (const m of memory) byLower.set(m.dirName.toLowerCase(), [...(byLower.get(m.dirName.toLowerCase()) ?? []), m.dirName]);
  for (const group of byLower.values()) if (group.length > 1) anomalies.push({ kind: 'case-duplicate-slugs', detail: group.join(' ~ ') });
  return { memory, anomalies };
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

/** User-level settings: presence + hash only. Contents are never copied or embedded (may hold tokens). */
export function settingsFiles(configDir, env = process.env, homedir = os.homedir()) {
  const account = env.CLAUDE_CONFIG_DIR?.trim() ? path.join(configDir, '.claude.json') : path.join(homedir, '.claude.json');
  return [['settings.json', path.join(configDir, 'settings.json')], ['.claude.json', account]].map(([name, p]) => {
    const pr = probeFile(p);
    return { name, path: p, exists: pr.kind === 'file', sha256: pr.kind === 'file' ? pr.hash : null };
  });
}

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

/** Live coordination state for one repo; a repo without fleet state is reported, never an error. */
function repoState(repo, { env, now }) {
  let dir;
  try { dir = fleetDir(repo); } catch (e) { return { path: repo, fleet: 'error', error: e.message, sessions: [] }; }
  if (!fs.existsSync(dir)) return { path: repo, fleet: 'absent', sessions: [] };
  let config;
  try { config = resolveConfig(repo, { env }); } catch (e) { return { path: repo, fleet: 'error', error: `config: ${e.message}`, sessions: [] }; }
  const f = gatherFacts({ cwd: repo, config, now, env, prs: false, patches: false, worktrees: true, untracked: false, merged: false, checks: false, uncommitted: 'all' });
  const status = buildStatusFrom(f);
  const ctx = { cwd: repo, config, env, now };
  const sessions = status.items.filter((i) => i.tracked && !['done', 'abandoned'].includes(i.state)).map((i) => {
    const s = {
      id: i.id, intent: i.intent ?? '', state: i.state, branch: i.branch ?? null, worktree: i.worktree ?? null,
      paths: i.paths ?? [], ready: i.ready ?? null, readyStale: Boolean(i.readyStale), waitingOn: i.waitingOn ?? [],
      uncommittedFiles: i.uncommittedFiles ?? [], ...(i.uncommittedUnknown ? { uncommittedUnknown: i.uncommittedUnknown } : {}),
    };
    if (i.worktree) {
      const r = archiveReport(ctx, { branch: i.branch ?? null, worktree: i.worktree });
      s.risks = Object.fromEntries(Object.entries(r.risks).map(([k, v]) => [k, v.length]));
      if (r.unverified.length) s.unverified = r.unverified;
    }
    return s;
  });
  const directives = readDirectives(dir);
  const trains = listTrains(dir);
  return {
    path: repo, fleet: 'present', sessions,
    directives: directives.active.length, trains: trains.trains.filter((t) => !['landed', 'abandoned'].includes(t.phase)).length,
  };
}

// ── manifest schema (receive consumes it; zod strict on what it reads) ───────

const FileEntry = z.object({ rel: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative() }).strict();
const MemoryEntry = z.object({
  dirName: z.string().regex(SLUG_RE),
  files: z.array(FileEntry),
  skipped: z.array(z.object({ rel: z.string(), reason: z.string() }).strict()),
}).strict();
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
    repos: z.array(z.object({ path: z.string(), fleet: z.enum(['present', 'absent', 'error']), error: z.string().optional(), directives: z.number().optional(), trains: z.number().optional(), sessions: z.array(z.object({ id: z.string() }).passthrough()) }).strict()),
  }).strict(),
  memory: z.array(MemoryEntry),
  anomalies: z.array(z.object({ kind: z.string(), detail: z.string() }).strict()),
  scheduledTasks: z.array(z.object({ id: z.string(), description: z.string() }).strict()),
  settings: z.array(z.object({ name: z.string(), path: z.string(), exists: z.boolean(), sha256: z.string().nullable() }).strict()),
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

/** prepare: everything account-bound and coordination-live, written as JSON + markdown. Writes nothing to repos. */
export async function prepareHandover(ctx, flags = {}, { homedir = os.homedir() } = {}) {
  const configDir = claudeConfigDir(ctx.env, { homedir });
  const { memory, anomalies } = collectMemory(configDir);
  const scope = await resolveRepoScope(ctx.cwd, flags['--repo'] ?? []);
  const repos = scope.repos.map((r) => repoState(r, { env: ctx.env, now: ctx.now }));
  const handoverDir = path.join(ctx.dir, 'handover');
  const art = reserveArtifacts(handoverDir, ctx.now instanceof Date ? ctx.now : new Date());
  const manifest = {
    schemaVersion: HANDOVER_SCHEMA_VERSION, id: art.id, createdAt: new Date().toISOString(),
    sourceConfigDir: configDir, sourceConfigDirReal: realWithTail(configDir), invokingRepo: scope.repos[0],
    fleetCommand: ctx.cmd ?? 'node scripts/fleet.mjs',
    scope: { sourceRepo: scope.sourceRepo, repos }, memory, anomalies,
    scheduledTasks: collectScheduledTasks(configDir), settings: settingsFiles(configDir, ctx.env, homedir),
  };
  HandoverManifestSchema.parse(manifest); // a manifest prepare cannot itself validate is a bug, never a file
  atomicWriteFileSync(art.json, `${JSON.stringify(manifest, null, 2)}\n`);
  atomicWriteFileSync(art.md, renderHandoverMarkdown(manifest, art));
  return { manifest, artifacts: art };
}

// ── receive ─────────────────────────────────────────────────────────────────

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
  const plan = [];
  for (const m of manifest.memory) {
    const name = destDirName(destConfigDir, m.dirName);
    const srcRoot = path.join(manifest.sourceConfigDir, 'projects', m.dirName, 'memory');
    let srcRootReal = null; let srcRootErr = null;
    try { srcRootReal = fs.realpathSync.native(srcRoot); } catch (e) { srcRootErr = e.code ?? 'unreadable'; }
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
function publishOne(item, stagingDir, seq) {
  const staged = path.join(stagingDir, `${seq}.tmp`);
  fs.copyFileSync(item.source, staged, fs.constants.COPYFILE_EXCL);
  const got = sha256(fs.readFileSync(staged));
  if (got !== item.sourceHash) { fs.unlinkSync(staged); return { ...item, outcome: 'source-changed-during-copy', write: false, human: true }; }
  fs.mkdirSync(path.dirname(item.target), { recursive: true });
  try { fs.linkSync(staged, item.target); } catch (e) {
    fs.unlinkSync(staged);
    if (e.code !== 'EEXIST') throw e;
    return { ...item, ...decideFile(item.prepared, probeFile(item.target), () => ({ kind: 'file', hash: item.sourceHash })), raced: true };
  }
  fs.unlinkSync(staged);
  return item;
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

/** receive: verify (same config root) or additively copy (different one) the memory; flag the human steps. */
export function receiveHandover(ctx, flags, { homedir = os.homedir(), platform = process.platform } = {}) {
  const loaded = loadManifest(path.resolve(ctx.cwd, flags['--from']));
  if (!loaded.ok) return failed(`${loaded.reason}: ${loaded.detail}`, { handover: { reason: loaded.reason } });
  const m = loaded.manifest;
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
        const out = replanned.map((item) => (item.write ? publishOne(item, stagingDir, seq++) : item));
        fs.rmdirSync(stagingDir);
        return { out };
      });
      if (!res.ok) lockContention = true;
      else if (res.value.unsafe) files = files.map((f) => (f.write ? { ...f, outcome: 'unsafe-destination', write: false, human: true, reason: res.value.unsafe } : f));
      else files = res.value.out;
    }
  }

  const taskRoot = scheduledTasksDir(destConfigDir);
  const tasks = m.scheduledTasks.map((t) => ({
    ...t, file: fs.existsSync(path.join(taskRoot, t.id, 'SKILL.md')) ? 'present' : 'missing', registration: 'unverified',
  }));
  const ownSettings = settingsFiles(destConfigDir, ctx.env, homedir);
  const settings = m.settings.map((s) => {
    const mine = ownSettings.find((o) => o.name === s.name);
    const status = !mine?.exists ? 'absent' : mine.sha256 === s.sha256 ? 'same' : 'differs';
    return { name: s.name, status, review: status !== 'same' };
  });
  const liveSessions = m.scope.repos.flatMap((r) => {
    let dir; try { dir = fleetDir(r.path); } catch { return []; }
    let live = [];
    try { live = readSessions(dir).sessions.filter((s) => !['done', 'abandoned'].includes(s.state)).map((s) => s.id); } catch { live = []; }
    return r.sessions.filter((s) => live.includes(s.id)).map((s) => ({ repo: r.path, id: s.id }));
  });

  const count = (o) => files.filter((f) => f.outcome === o).length;
  const errors = files.filter((f) => f.human && f.outcome !== 'conflict');
  const conflicts = files.filter((f) => f.outcome === 'conflict');
  const missingTasks = tasks.filter((t) => t.file === 'missing');
  const handover = {
    id: m.id, mode: sameRoot ? 'same-config-root' : 'copy', dryRun, destConfigDir, sourceConfigDir: m.sourceConfigDir,
    files, sweep, lockContention, tasks, settings, liveSessions, anomalies: m.anomalies,
    summary: {
      verified: count('verified'), copied: count('copied') + count('copied-source-changed'), present: count('present') + count('present-source-changed'),
      changedSincePrepare: count('changed-since-prepare'), missingSincePrepare: count('missing-since-prepare'),
      conflicts: conflicts.length, errors: errors.length, missingTasks: missingTasks.length,
    },
  };
  const text = renderReceiveText(handover);
  if (errors.length) return failed(`${errors.length} memory file(s) could not be decided or written`, { handover, text });
  if (lockContention) return refused('another handover receive holds the lock on this config root', { handover, text });
  if (conflicts.length || missingTasks.length) return refused(`human steps remain: ${conflicts.length} conflict(s), ${missingTasks.length} scheduled task(s) to recreate`, { handover, text });
  return ok({ handover, text });
}

// ── rendering ───────────────────────────────────────────────────────────────

function coordinationPrompt(m, art) {
  return [
    'You are taking over coordination of Claude Code work on this machine from another account.',
    `1. Read the handover: ${art.md}`,
    `2. From any repo with the skills bundle, run: ${m.fleetCommand} handover receive --from "${art.json}"`,
    '   (in a consumer repo the CLI is node scripts/.claude-skills/fleet.mjs). Resolve every error and conflict it lists first.',
    '3. Confirm each repo\'s harness memory path matches the target receive printed (memory must land where this account reads it).',
    '4. Recreate every scheduled task listed under "Scheduled tasks" with your scheduling tool — the CLI cannot see the scheduler.',
    '5. Review user-level settings differences by hand (MCP servers, permissions); they are never copied.',
    '6. For each repo, run fleet status; for each session under "Sessions to resume", spin out a chip with its resume prompt.',
    '7. Only the user approves a merge or push. Run `node scripts/check-setup.mjs` once to confirm this account\'s environment.',
  ].join('\n');
}

/** The human-readable handover (no memory CONTENT — only names, counts and hashes). */
export function renderHandoverMarkdown(m, art) {
  const L = [`# Fleet handover ${m.id}`, '', `- Created: ${m.createdAt}`, `- Source config root: \`${m.sourceConfigDir}\``,
    `- Invoking repo: \`${m.invokingRepo}\``, `- Machine-readable manifest: \`${art.json}\``, ''];
  const sr = m.scope.sourceRepo;
  L.push('## Scope', '', sr.type === 'resolved'
    ? `Source repo resolved (\`${sr.path}\`); registered consumers included.${sr.registryError ? ` Registry read failed: ${sr.registryError}` : ''}`
    : `**Source repo NOT resolved (${sr.type}: ${sr.reason ?? ''}) — the per-repo layer covers only the invoking repo and --repo.**`, '');
  for (const r of m.scope.repos) L.push(`- \`${r.path}\` — fleet ${r.fleet}${r.error ? ` (${r.error})` : ''}${r.fleet === 'present' ? ` · ${r.sessions.length} live session(s), ${r.directives ?? 0} directive(s), ${r.trains ?? 0} open train(s)` : ''}`);
  L.push('', '## Memory (account-wide)', '');
  for (const mem of m.memory) L.push(`- \`${mem.dirName}\`: ${mem.files.length} file(s)${mem.skipped.length ? `, ${mem.skipped.length} skipped (links/specials)` : ''}`);
  if (!m.memory.length) L.push('- (no memory dirs under this config root)');
  L.push('', '### Folder anomalies', '');
  L.push(...(m.anomalies.length ? m.anomalies.map((a) => `- ${a.kind}: \`${a.detail}\` — review; never auto-merged`) : ['- none']));
  L.push('', '## Sessions to resume', '');
  const sessions = m.scope.repos.flatMap((r) => r.sessions.map((s) => ({ ...s, repo: r.path })));
  if (!sessions.length) L.push('- none live');
  for (const s of sessions) {
    const unc = s.uncommittedUnknown ? `UNKNOWN (${s.uncommittedUnknown})` : `${(s.uncommittedFiles ?? []).length}`;
    L.push(`### ${s.id} (${s.repo})`, '', `- state ${s.state}${s.ready ? `, ready at ${String(s.ready.oid ?? '').slice(0, 12)}${s.readyStale ? ' (stale)' : ''}` : ''}; uncommitted files: ${unc}`,
      ...(s.waitingOn?.length ? [`- waiting on: ${s.waitingOn.map((w) => `${w.kind}:${w.ref}`).join(', ')}`] : []),
      ...(s.risks ? [`- worktree risks: ${Object.entries(s.risks).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`] : []),
      '', '```text', renderChipPrompt({ branch: s.branch ?? s.id, worktree: s.worktree ?? '(none)', task: s.intent || s.id, paths: s.paths ?? [], cmd: m.fleetCommand }), '```', '');
  }
  L.push('## Scheduled tasks (recreate in the new account; registration is never visible to the CLI)', '');
  L.push(...(m.scheduledTasks.length ? m.scheduledTasks.map((t) => `- \`${t.id}\` — ${t.description}`) : ['- none']));
  L.push('', '## User settings (presence only; never copied)', '');
  for (const s of m.settings) L.push(`- ${s.name}: ${s.exists ? 'present' : 'absent'} (\`${s.path}\`)`);
  L.push('', '## Coordination prompt for the new account', '', '```text', coordinationPrompt(m, art), '```', '');
  return L.join('\n');
}

function renderReceiveText(h) {
  const s = h.summary;
  const L = [`fleet handover receive ${h.id} — ${h.mode}${h.dryRun ? ' (dry run: nothing written)' : ''}`,
    `  destination config root: ${h.destConfigDir}`,
    h.mode === 'same-config-root'
      ? `  memory: same config root — ${s.verified} verified, ${s.changedSincePrepare} changed since prepare, ${s.missingSincePrepare} missing since prepare`
      : `  memory: ${s.copied} copied${h.dryRun ? ' (would copy)' : ''}, ${s.present} already present, ${s.conflicts} conflict(s), ${s.errors} error(s)`];
  for (const f of h.files.filter((x) => x.human)) L.push(`  ${f.outcome.toUpperCase()}: ${f.dirName}/${f.rel}${f.reason ? ` (${f.reason})` : ''}${f.target ? ` -> ${f.target}` : ''}`);
  if (h.sweep.swept.length) L.push(`  swept ${h.sweep.swept.length} dead staging run(s)`);
  if (h.sweep.kept.length) L.push(`  staging entries left alone (not ours): ${h.sweep.kept.join(', ')}`);
  if (h.lockContention) L.push('  LOCKED: another receive holds this config root — rerun when it finishes');
  L.push(`  scheduled tasks: ${h.tasks.length} — ${s.missingTasks} missing here (recreate), all registrations UNVERIFIED (confirm in this account's scheduler)`);
  for (const t of h.tasks.filter((x) => x.file === 'missing')) L.push(`    recreate: ${t.id} — ${t.description}`);
  for (const st of h.settings.filter((x) => x.review)) L.push(`  settings ${st.name}: ${st.status} — review by hand (MCP servers, permissions)`);
  L.push(`  sessions still live (adopt or resume from the handover prompts): ${h.liveSessions.length ? h.liveSessions.map((x) => x.id).join(', ') : 'none'}`);
  for (const a of h.anomalies) L.push(`  folder anomaly: ${a.kind} ${a.detail}`);
  return L.join('\n');
}

/** CLI entry. */
export async function cmdHandover(ctx, flags, positionals) {
  const sub = positionals[0];
  checkHandoverFlags(sub, flags);
  if (sub === 'prepare') {
    const { manifest, artifacts } = await prepareHandover(ctx, flags);
    const sessions = manifest.scope.repos.reduce((n, r) => n + r.sessions.length, 0);
    const files = manifest.memory.reduce((n, mm) => n + mm.files.length, 0);
    const scopeNote = manifest.scope.sourceRepo.type === 'resolved' ? '' : `\n  WARNING: source repo not resolved (${manifest.scope.sourceRepo.type}) — per-repo scope limited to the invoking repo and --repo`;
    return ok({
      handover: { id: manifest.id, json: artifacts.json, md: artifacts.md, memoryDirs: manifest.memory.length, memoryFiles: files, sessions, scheduledTasks: manifest.scheduledTasks.length, anomalies: manifest.anomalies.length, sourceRepo: manifest.scope.sourceRepo },
      text: `fleet handover prepare ${manifest.id}\n  memory: ${manifest.memory.length} dir(s), ${files} file(s) · sessions: ${sessions} · scheduled tasks: ${manifest.scheduledTasks.length} · anomalies: ${manifest.anomalies.length}${scopeNote}\n  read: ${artifacts.md}\n  new account: ${manifest.fleetCommand} handover receive --from "${artifacts.json}"`,
    });
  }
  return receiveHandover(ctx, flags);
}
