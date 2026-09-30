/**
 * @fileoverview Tool pre-pass orchestration — runs linters and type-checkers,
 * normalizes output to canonical FindingSchema format.
 *
 * Design:
 * - Uses execFileSync with argv arrays (no shell, no path concat)
 * - Status envelope distinguishes no_tool / failed / timeout from ok
 * - Tools whose config marks `scopeToFiles: true` (eslint, ruff, flake8) are
 *   invoked against exactly the audited file set, via a `--` end-of-options
 *   separator (so a filename like `-rf.js` is never read as a flag) and
 *   filtered to files that still exist on disk (a diff's deleted files have
 *   nothing to lint, and passing them explicitly would crash the tool rather
 *   than silently skip, the way project-wide invocation does). A tool
 *   without `scopeToFiles` (tsc) runs project-wide at repo root, because its
 *   analysis is not meaningfully scopable to a file subset — config
 *   resolution and cross-file type checking need the whole project. Either
 *   way, output is ALSO post-filtered to the audited file set as
 *   defense-in-depth (a no-op for already-scoped tools, the sole mechanism
 *   for project-wide ones).
 * - Graceful: missing tools never block the audit
 * - HONEST: a tool that ran and produced nothing it could locate is `failed`, never `ok` with zero findings. A
 *   non-zero exit with no parseable finding, or any diagnostic the parser flags as a `toolFault` (a crashed config, an
 *   unrestored project), is a failure — otherwise an ESLint config crash or a `dotnet build` that never compiled
 *   reads as a clean lint. The states are the closed vocabulary in audit/file-coverage.mjs (TOOL_STATES).
 * - PROJECT-scoped tools (dotnet): MSBuild builds a project, not a file list. `projectMarkers` on a tool config makes
 *   the runner resolve each audited file to its owning project (nearest directory, one exact project file — two in one
 *   directory is `ambiguous_project`, never a guess) and build each project ONCE, serially, under a per-tool project
 *   cap and ONE monotonic audit-wide deadline. Each process is killed as a TREE on timeout (a direct-child kill leaves
 *   MSBuild/compiler workers running long after the audit moved on).
 *
 * SECURITY: running repo-configured linters means executing code/config the
 * repo owner controls (ESLint configs can `require()` custom rules). This is
 * equivalent to running `npm test` in the repo. Gated behind the `--no-tools`
 * CLI flag. Every invocation is logged to stderr for auditability.
 * @module scripts/lib/linter
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { normalizePath } from './file-io.mjs';
import { getProfileForFile } from './language-profiles.mjs';
import { getRuleMetadata } from './rule-metadata.mjs';
import { toolRunConfig } from './tool-run-config.mjs';
import { worstToolState } from './tool-states.mjs';
import { oneLine } from './coverage-format.mjs';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * ToolRunResult — contract for all tool executions.
 * @typedef {object} ToolRunResult
 * @property {'ok'|'no_tool'|'failed'|'timeout'|'spawn_error'|'deadline_exceeded'|'ambiguous_project'|'no_project'|'skipped_budget'|'not_applicable'} status
 * @property {RawLintFinding[]} findings
 * @property {{ files: number }} usage
 * @property {number} latencyMs
 * @property {string} stderr
 * @property {string} toolId
 * @property {string} toolKind
 */

/**
 * RawLintFinding — parser output, before normalization to FindingSchema.
 * @typedef {object} RawLintFinding
 * @property {string} file
 * @property {number} line
 * @property {number} [endLine]
 * @property {number} [column]
 * @property {string} rule
 * @property {string} message
 * @property {boolean} fixable
 * @property {'error'|'warning'|'style'} [level] compiler-style tools: an `error` is a real defect, `style` a formatting note
 * @property {boolean} [toolFault] the DIAGNOSTIC is about the tool's own run (restore/SDK/config failure), not the code
 */

const TOOL_TIMEOUT_MS = 60_000;
const TOOL_MAX_BUFFER_BASE = 10 * 1024 * 1024;    // 10MB
const TOOL_MAX_BUFFER_PER_FILE = 100 * 1024;      // +100KB per file

// A scoped invocation's argv grows with the audited file count. `runTool`
// has no caller today that exceeds a diff's file count (orders of magnitude
// under OS ARG_MAX) — this is a clear-error guard against a future misuse,
// not a working ceiling meant to ever be hit; see docs/plans/refactor-misc-small-items-2026-07.md.
const MAX_SCOPED_FILES = 2000;

/** Scale buffer with audited file count. Prevents overflow on large repos. */
function computeMaxBuffer(fileCount) {
  return TOOL_MAX_BUFFER_BASE + fileCount * TOOL_MAX_BUFFER_PER_FILE;
}

// ── execFileSync indirection (testable) ──────────────────────────────────────
// Tests inject a fake via `setExecFileSync()` to avoid spawning real processes.
let _execFileSync = execFileSync;

/** @internal test-only */
export function setExecFileSync(fn) { _execFileSync = fn; }
/** @internal test-only */
export function resetExecFileSync() { _execFileSync = execFileSync; }

// ── existsSync indirection (testable) ────────────────────────────────────────
// Same pattern as _execFileSync — tests fake file presence without touching
// real disk (`setExistsSync()`).
let _existsSync = existsSync;

/** @internal test-only */
export function setExistsSync(fn) { _existsSync = fn; }
/** @internal test-only */
export function resetExistsSync() { _existsSync = existsSync; }

// ── Tool Availability ────────────────────────────────────────────────────────

/**
 * Check whether a tool responds to its availability probe.
 * Uses argv array (no shell, no command injection).
 * @param {[string, string[]]} probe - [command, args]
 * @returns {boolean}
 */
function isToolAvailable([command, args = []]) {
  try {
    _execFileSync(command, args, { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// ── Tool Execution ───────────────────────────────────────────────────────────

/**
 * Run a single tool. Returns ToolRunResult envelope.
 * Post-filters findings to the audited file set (project-scoped tools run at repo root).
 * @param {object} toolConfig - From profile.tools[]
 * @param {string[]} auditedFiles - Files the audit is analyzing
 * @param {string} profileId - e.g. 'js', 'py'
 * @param {Set<string>} [attempted] tool ids already tried on this fallback chain (cycle guard)
 * @returns {ToolRunResult}
 */
export function runTool(toolConfig, auditedFiles, profileId, attempted = new Set()) {
  const startMs = Date.now();
  const fileSet = new Set(auditedFiles.map(f => normalizePath(f)));
  const toolId = toolConfig.id;
  const toolKind = toolConfig.kind;
  attempted.add(toolId);

  if (!isToolAvailable(toolConfig.availabilityProbe)) {
    if (toolConfig.fallback && attempted.has(toolConfig.fallback.id)) {
      // A self-referencing or cyclic fallback graph is a configuration bug: fail the tool, never recurse forever.
      return toolFailure(toolConfig, profileId, startMs, `fallback cycle: ${[...attempted, toolConfig.fallback.id].join(' -> ')}`);
    }
    if (toolConfig.fallback) {
      process.stderr.write(`  [tool] ${profileId}/${toolId} not available — trying fallback ${toolConfig.fallback.id}\n`);
      return runTool(toolConfig.fallback, auditedFiles, profileId, attempted);
    }
    process.stderr.write(`  [tool] ${profileId}/${toolId} not available — skipping\n`);
    return { status: 'no_tool', findings: [], usage: { files: 0 }, latencyMs: 0, stderr: '', toolId, toolKind };
  }

  const parser = PARSERS[toolConfig.parser];
  if (!parser) {
    process.stderr.write(`  [tool] ${profileId}/${toolId}: unknown parser "${toolConfig.parser}"\n`);
    return { status: 'failed', findings: [], usage: { files: 0 }, latencyMs: Date.now() - startMs, stderr: `unknown parser: ${toolConfig.parser}`, toolId, toolKind };
  }

  let args = toolConfig.args;
  if (toolConfig.scopeToFiles) {
    // Deleted files exist in a diff but not on disk. Project-wide invocation
    // tolerates that silently (nothing to traverse); passing a deleted path
    // explicitly makes the tool fail loudly instead. Drop them — there is
    // nothing to lint in a file that no longer exists.
    const existing = auditedFiles.filter(f => _existsSync(f));
    if (existing.length === 0) {
      process.stderr.write(`  [tool] ${profileId}/${toolId}: no existing files to scope to (all ${auditedFiles.length} deleted) — skipping\n`);
      return { status: 'not_applicable', findings: [], usage: { files: 0 }, latencyMs: 0, stderr: '', toolId, toolKind };
    }
    if (existing.length > MAX_SCOPED_FILES) {
      throw new Error(`[tool] ${profileId}/${toolId}: ${existing.length} files exceeds the ${MAX_SCOPED_FILES}-file scoping ceiling — this caller needs its own design, not silent truncation`);
    }
    // Trailing '.' is the profile's whole-repo positional arg; replace it
    // with '--' (end-of-options — so a filename like '-rf.js' is never read
    // as a flag) followed by the scoped files.
    args = [...toolConfig.args.slice(0, -1), '--', ...existing];
  }

  process.stderr.write(`  [tool] ${profileId}/${toolId}: executing ${toolConfig.command} ${oneLine(args.join(' '))}\n`);

  try {
    const stdout = _execFileSync(toolConfig.command, args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: TOOL_TIMEOUT_MS,
      cwd: process.cwd(),
      maxBuffer: computeMaxBuffer(auditedFiles.length),
    });
    const rawFindings = parser(stdout);
    const fault = rawFindings.find((f) => f.toolFault);
    if (fault) return toolFailure(toolConfig, profileId, startMs, `tool fault: ${fault.rule} ${fault.message}`.slice(0, 300));
    const filtered = rawFindings.filter(f => fileSet.has(normalizePath(f.file)));
    const filteredOut = rawFindings.length - filtered.length;
    process.stderr.write(`  [tool] ${profileId}/${toolId}: ${filtered.length} findings${filteredOut > 0 ? ` (${filteredOut} out-of-scope filtered)` : ''} in ${((Date.now() - startMs) / 1000).toFixed(1)}s\n`);
    return { status: 'ok', findings: filtered, usage: { files: auditedFiles.length }, latencyMs: Date.now() - startMs, stderr: '', toolId, toolKind };
  } catch (err) {
    // Tools commonly exit non-zero when findings exist — parse stdout anyway.
    if (err.stdout || (toolConfig.combineStderr && err.stderr)) {
      try {
        const rawFindings = parser(joinOutput(err.stdout, err.stderr, toolConfig));
        // A non-zero exit that produced NOTHING locatable is a tool that did not run (a config crash, a bad flag, an
        // unrestored project): recording it `ok` with zero findings was the false clean this guards.
        const fault = rawFindings.find((f) => f.toolFault);
        if (fault) return toolFailure(toolConfig, profileId, startMs, `tool fault: ${fault.rule} ${fault.message}`.slice(0, 300));
        if (rawFindings.length === 0) return toolFailure(toolConfig, profileId, startMs, `exited ${err.status ?? 'non-zero'} with no parseable findings`);
        const filtered = rawFindings.filter(f => fileSet.has(normalizePath(f.file)));
        process.stderr.write(`  [tool] ${profileId}/${toolId}: ${filtered.length} findings (non-zero exit, stdout parsed) in ${((Date.now() - startMs) / 1000).toFixed(1)}s\n`);
        return { status: 'ok', findings: filtered, usage: { files: auditedFiles.length }, latencyMs: Date.now() - startMs, stderr: err.stderr?.toString() || '', toolId, toolKind };
      } catch { /* fall through to failure */ }
    }
    const isTimeout = err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT';
    process.stderr.write(`  [tool] ${profileId}/${toolId}: ${isTimeout ? 'timeout' : 'failed'}: ${(err.message || '').slice(0, 120)}\n`);
    return { status: isTimeout ? 'timeout' : 'failed', findings: [], usage: { files: 0 }, latencyMs: Date.now() - startMs, stderr: err.message || '', toolId, toolKind };
  }
}

function joinOutput(stdout, stderr, toolConfig) {
  const out = stdout ? stdout.toString() : '';
  return toolConfig.combineStderr && stderr ? `${out}\n${stderr.toString()}` : out;
}

function toolFailure(toolConfig, profileId, startMs, reason) {
  process.stderr.write(`  [tool] ${profileId}/${toolConfig.id}: failed: ${reason}\n`);
  return { status: 'failed', findings: [], usage: { files: 0 }, latencyMs: Date.now() - startMs, stderr: reason, toolId: toolConfig.id, toolKind: toolConfig.kind };
}

/**
 * Run all applicable tools across the audited file set.
 * Deduplicates tools by `id` — ESLint is ONE tool for both JS and TS profiles
 * (runs once, not twice). Files from all contributing languages are unioned
 * before post-filtering.
 * @param {string[]} files
 * @returns {ToolRunResult[]}
 */
export function executeTools(files) {
  const toolsById = new Map(); // toolId → { config, profileId, files: Set }
  for (const f of files) {
    const profile = getProfileForFile(f);
    if (profile.id === 'unknown' || !profile.tools) continue;
    for (const toolConfig of profile.tools) {
      // Project-scoped tools (`projectMarkers`) are run by executeAllTools, per project — never at the repo root.
      if (toolConfig.projectMarkers) continue;
      if (!toolsById.has(toolConfig.id)) {
        toolsById.set(toolConfig.id, { config: toolConfig, profileId: profile.id, files: new Set() });
      }
      toolsById.get(toolConfig.id).files.add(f);
    }
  }

  const results = [];
  for (const { config, profileId, files: toolFiles } of toolsById.values()) {
    const r = runTool(config, [...toolFiles], profileId);
    results.push({ ...r, profileId, files: [...toolFiles] });
  }
  return results;
}

// ── Project-scoped tools ─────────────────────────────────────────────────────

/**
 * Resolve the project that owns `file`: walk from its directory up to the repo root and stop at the first directory
 * holding a project file. Within that directory the FIRST marker (in `markers` order) with any match decides, and it
 * must match exactly ONE file — two `.csproj` in one directory is `ambiguous_project`, reported, never guessed.
 *
 * @param {string} file repo-relative path
 * @param {readonly string[]} markers extensions in precedence order, e.g. ['.csproj', '.sln']
 * @param {{readdir?: (dir: string) => string[], root?: string}} [opts]
 * @returns {{status: 'ok', path: string, kind: string} | {status: 'ambiguous_project', candidates: string[]} | {status: 'no_project'}}
 */
export function resolveToolProject(file, markers, { readdir = (d) => readdirSync(d), root = '.' } = {}) {
  let dir = path.posix.dirname(normalizePath(file));
  const atRoot = (d) => d === '.' || d === '' || d === root;
  for (let guard = 0; guard < 64; guard++) {
    let entries = [];
    try { entries = readdir(dir === '' ? '.' : dir); } catch { entries = []; }
    for (const marker of markers) {
      const hits = entries.filter((e) => e.toLowerCase().endsWith(marker));
      if (hits.length === 1) return { status: 'ok', path: dir === '.' || dir === '' ? hits[0] : `${dir}/${hits[0]}`, kind: marker.slice(1) };
      if (hits.length > 1) return { status: 'ambiguous_project', candidates: hits.map((h) => (dir === '.' ? h : `${dir}/${h}`)) };
    }
    if (atRoot(dir)) break;
    dir = path.posix.dirname(dir);
  }
  return { status: 'no_project' };
}

/**
 * Group files by owning project (each project built once). Files whose project is ambiguous or absent are returned
 * as `problems`, to be reported — a file with no project is not a file a build says anything about.
 *
 * @returns {{groups: Map<string, {project: {path: string, kind: string}, files: string[]}>,
 *   problems: Array<{status: string, reason: string, files: string[]}>}}
 */
export function groupFilesByProject(files, markers, opts = {}) {
  const groups = new Map();
  const problemsByKey = new Map();
  for (const f of files) {
    const r = resolveToolProject(f, markers, opts);
    if (r.status === 'ok') {
      if (!groups.has(r.path)) groups.set(r.path, { project: { path: r.path, kind: r.kind }, files: [] });
      groups.get(r.path).files.push(f);
    } else {
      const reason = r.status === 'ambiguous_project' ? `several project files in one directory: ${r.candidates.join(', ')}` : 'no project file found above this file';
      const key = `${r.status}|${reason}`;
      if (!problemsByKey.has(key)) problemsByKey.set(key, { status: r.status, reason, files: [] });
      problemsByKey.get(key).files.push(f);
    }
  }
  return { groups, problems: [...problemsByKey.values()] };
}

/** Kill `pid` and every descendant. taskkill /T on Windows; a detached process group elsewhere. */
export function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/**
 * Spawn a command with a hard timeout that kills the whole process TREE. Never throws.
 * @returns {Promise<{kind: 'exit', code: number|null, stdout: string, stderr: string}
 *   | {kind: 'timeout', stdout: string, stderr: string} | {kind: 'spawn_error', error: Error}>}
 */
export function spawnWithTreeKill(command, args, { cwd = process.cwd(), timeoutMs, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    } catch (error) {
      resolve({ kind: 'spawn_error', error });
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    let timedOut = false;
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const text = () => ({ stdout: Buffer.concat(out).toString('utf-8'), stderr: Buffer.concat(err).toString('utf-8') });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
      // If a stray descendant still holds the pipes open, do not wait for it forever.
      setTimeout(() => finish({ kind: 'timeout', ...text() }), 2000).unref();
    }, Math.max(1, timeoutMs));
    const collect = (bucket) => (d) => { size += d.length; if (size > maxBuffer) killProcessTree(child.pid); else bucket.push(d); };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('error', (error) => finish({ kind: 'spawn_error', error }));
    child.on('close', (code) => finish(timedOut ? { kind: 'timeout', ...text() } : { kind: 'exit', code, ...text() }));
  });
}

const RESTORE_HINT = ' — the project is not restored; run `dotnet restore` (or set AUDIT_DOTNET_RESTORE=1 to let the audit do it)';

/**
 * Run one project-scoped tool against ONE project. Returns a per-project state, never throws.
 * @returns {Promise<{status: string, findings: RawLintFinding[], reason: string|null, latencyMs: number}>}
 */
export async function runProjectTool(toolConfig, project, auditedFileSet, ctx) {
  const { profileId, deadlineAt, restore = false, now = () => performance.now(), spawnFn = spawnWithTreeKill } = ctx;
  const startMs = now();
  const done = (status, reason = null, findings = []) => ({ status, findings, reason, latencyMs: Math.round(now() - startMs) });

  const remaining = deadlineAt - startMs;
  if (remaining <= 0) return done('deadline_exceeded', 'the audit-wide tool deadline had already passed');
  const toolTimeout = toolConfig.timeoutMs ?? TOOL_TIMEOUT_MS;
  const timeoutMs = Math.min(toolTimeout, remaining);
  const deadlineBound = remaining < toolTimeout;

  const parser = PARSERS[toolConfig.parser];
  if (!parser) return done('failed', `unknown parser: ${toolConfig.parser}`);
  // The audited set arrives normalised from executeAllTools; normalise defensively so a caller cannot get a silent empty filter.
  auditedFileSet = new Set([...auditedFileSet].map((f) => normalizePath(f)));

  let args = toolConfig.args.map((a) => (a === '{project}' ? project.path : a));
  if (toolConfig.restoreToggle && restore) args = args.filter((a) => a !== '--no-restore');
  process.stderr.write(`  [tool] ${profileId}/${toolConfig.id}: executing ${toolConfig.command} ${oneLine(args.join(' '))} (timeout ${Math.round(timeoutMs / 1000)}s)\n`);

  const res = await spawnFn(toolConfig.command, args, { cwd: process.cwd(), timeoutMs, maxBuffer: computeMaxBuffer(auditedFileSet.size) });
  if (res.kind === 'spawn_error') return done('spawn_error', `${res.error?.code || 'spawn failed'}: ${(res.error?.message || '').slice(0, 160)}`);
  if (res.kind === 'timeout') {
    return deadlineBound
      ? done('deadline_exceeded', `killed at the audit-wide deadline after ${Math.round(timeoutMs / 1000)}s`)
      : done('timeout', `killed after ${Math.round(timeoutMs / 1000)}s`);
  }

  let raw;
  try { raw = parser(joinOutput(res.stdout, res.stderr, toolConfig)); } catch (e) { return done('failed', `parser threw: ${(e.message || '').slice(0, 120)}`); }
  const fault = raw.find((f) => f.toolFault);
  if (fault) {
    const hint = /NETSDK1004|NU1101|NU1301|NETSDK1064/.test(fault.rule) ? RESTORE_HINT : '';
    return done('failed', `tool fault ${fault.rule}: ${fault.message.slice(0, 160)}${hint}`);
  }
  if (res.code !== 0 && raw.length === 0) {
    return done('failed', `exited ${res.code} with no parseable diagnostics: ${(res.stderr || res.stdout || '').trim().split('\n')[0]?.slice(0, 160) ?? ''}`);
  }
  return done('ok', null, raw.filter((f) => auditedFileSet.has(normalizePath(f.file))));
}

/**
 * Run EVERY applicable tool: the whole-repo tools via `executeTools` (unchanged), then each project-scoped tool per
 * project — serially, under `maxProjects` and ONE monotonic deadline. Every non-clean state is recorded per project;
 * none is ever folded into a clean result.
 *
 * @param {string[]} files audited files
 * @param {{policy?: {deadlineMs: number, restore: boolean}, now?: () => number, spawnFn?: Function,
 *   readdir?: Function, exists?: (p: string) => boolean}} [opts]
 * @returns {Promise<Array<ToolRunResult & {profileId?: string, files?: string[], projects?: object[]}>>}
 */
export async function executeAllTools(files, { policy = toolRunConfig, now = () => performance.now(), spawnFn = spawnWithTreeKill, readdir, exists = (p) => _existsSync(p) } = {}) {
  const results = executeTools(files);

  const deadlineAt = now() + policy.deadlineMs;
  const projectTools = new Map(); // toolId -> {config, profileId, files:Set}
  for (const f of files) {
    const profile = getProfileForFile(f);
    if (profile.id === 'unknown' || !profile.tools) continue;
    for (const config of profile.tools) {
      if (!config.projectMarkers) continue;
      if (!projectTools.has(config.id)) projectTools.set(config.id, { config, profileId: profile.id, files: new Set() });
      projectTools.get(config.id).files.add(f);
    }
  }

  for (const { config, profileId, files: toolFiles } of projectTools.values()) {
    const startMs = now();
    const existing = [...toolFiles].filter((f) => exists(f)); // a deleted file has nothing to build
    const base = { toolId: config.id, toolKind: config.kind, profileId, usage: { files: existing.length }, stderr: '', files: existing };
    if (existing.length === 0) continue;

    if (!isToolAvailable(config.availabilityProbe)) {
      process.stderr.write(`  [tool] ${profileId}/${config.id} not available — skipping\n`);
      results.push({ ...base, status: 'no_tool', findings: [], latencyMs: 0, projects: [{ path: null, kind: null, status: 'no_tool', reason: `${config.availabilityProbe[0]} not available`, files: existing }] });
      continue;
    }

    const { groups, problems } = groupFilesByProject(existing, config.projectMarkers, readdir ? { readdir } : {});
    const projects = [];
    const findings = [];
    const cap = config.maxProjects ?? Infinity;
    let started = 0;
    for (const { project, files: projFiles } of groups.values()) {
      if (started >= cap) {
        projects.push({ path: project.path, kind: project.kind, status: 'skipped_budget', reason: `over the ${cap}-project cap`, files: projFiles });
        continue;
      }
      started++;
      const r = await runProjectTool(config, project, new Set(existing.map((f) => normalizePath(f))), { profileId, deadlineAt, restore: policy.restore, now, spawnFn });
      projects.push({ path: project.path, kind: project.kind, status: r.status, reason: r.reason, files: projFiles });
      findings.push(...r.findings);
    }
    for (const pr of problems) projects.push({ path: null, kind: null, status: pr.status, reason: pr.reason, files: pr.files });

    const status = worstToolState(projects.map((p) => p.status));
    process.stderr.write(`  [tool] ${profileId}/${config.id}: ${status} — ${projects.length} project(s), ${findings.length} finding(s)\n`);
    results.push({ ...base, status, findings, latencyMs: Math.round(now() - startMs), projects });
  }
  return results;
}

/**
 * Project tool results into the shape the coverage ledger takes (`buildCoverageReport({tools})`): a sync tool becomes one
 * synthetic project entry covering the files it ran on.
 */
export function coverageToolsFrom(results) {
  return (results || []).map((r) => ({
    id: r.toolId,
    profile: r.profileId ?? null,
    status: r.status,
    projects: r.projects ?? [{ path: null, kind: null, status: r.status, reason: r.stderr || null, files: r.files ?? [] }],
    filesCovered: r.status === 'ok' || r.status === 'timeout' ? (r.files ?? []).length : 0,
  }));
}

// ── Parsers ──────────────────────────────────────────────────────────────────

export function parseEslintOutput(stdout) {
  if (!stdout || !stdout.trim()) return [];
  const data = JSON.parse(stdout);
  const findings = [];
  for (const file of data) {
    for (const msg of (file.messages || [])) {
      // ESLint fatal errors (parse/config failures) have `fatal: true` and no ruleId.
      // Treat them as a distinct rule so rule-metadata can map them to HIGH — otherwise
      // they fall through to the LOW CODE_SMELL _default and hide real breakage.
      let rule;
      if (msg.fatal) {
        rule = 'fatal-parse-error';
      } else {
        rule = msg.ruleId || 'unknown';
      }
      findings.push({
        file: file.filePath ? path.relative(process.cwd(), file.filePath).replaceAll(/\\/g, '/') : '',
        line: msg.line || 1,
        endLine: msg.endLine,
        column: msg.column,
        rule,
        message: msg.message || '',
        fixable: !!msg.fix,
      });
    }
  }
  return findings;
}

export function parseRuffOutput(stdout) {
  if (!stdout || !stdout.trim()) return [];
  const data = JSON.parse(stdout);
  return data.map(item => ({
    file: item.filename ? path.relative(process.cwd(), item.filename).replaceAll(/\\/g, '/') : '',
    line: item.location?.row || 1,
    endLine: item.end_location?.row,
    column: item.location?.column,
    rule: item.code || 'unknown',
    message: item.message || '',
    fixable: !!item.fix,
  }));
}

export function parseTscOutput(stdout) {
  // tsc --pretty false: "path/to/file.ts(10,5): error TS2304: Cannot find name 'foo'."
  const findings = [];
  const regex = /^(.+?)\((\d+),(\d+)\):\s+\w+\s+(TS\d+):\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(stdout)) !== null) {
    findings.push({
      file: match[1].replaceAll(/\\/g, '/'),
      line: Number.parseInt(match[2], 10),
      column: Number.parseInt(match[3], 10),
      rule: match[4],
      message: match[5].trim(),
      fixable: false,
    });
  }
  return findings;
}

export function parseFlake8PylintOutput(stdout) {
  // pylint format: "path:line: [code] message"
  const findings = [];
  const regex = /^(.+?):(\d+):\s*\[(\w+)\]\s*(.+)$/gm;
  let match;
  while ((match = regex.exec(stdout)) !== null) {
    findings.push({
      file: match[1].replaceAll(/\\/g, '/'),
      line: Number.parseInt(match[2], 10),
      rule: match[3],
      message: match[4].trim(),
      fixable: false,
    });
  }
  return findings;
}

// MSBuild diagnostics: `ABS\File.cs(line,col): warning CS8618: message [ABS\proj.csproj]`. The same line appears twice
// in a build's output (inline, then in the summary) unless `-clp:NoSummary` is passed — the parser de-duplicates either way.
// Codes are letters then digits (CS0168, NU1101) — or a bare word for dotnet format (WHITESPACE, CHARSET).
const MSBUILD_LOC = /^(?:[ \t]*\d+>)?(.+?)\((\d+)(?:,(\d+))?(?:,\d+,\d+)?\):\s+(error|warning)\s+([A-Za-z][A-Za-z0-9]*):\s+(.*?)(?:\s+\[[^\]]+\])?\s*$/;
// No position: `MSBUILD : error MSB1003: …`, `/p/App.csproj : error NU1101: …`
const MSBUILD_GLOBAL = /^(?:[ \t]*\d+>)?(.+?)\s*:\s+(error|warning)\s+([A-Za-z][A-Za-z0-9]*):\s+(.*?)(?:\s+\[[^\]]+\])?\s*$/;
// Codes are letters then digits (CS0168, NU1101) — or a bare word for dotnet format (WHITESPACE, CHARSET).
const NON_SOURCE_DIAGNOSTIC_FILE = /\.(csproj|vbproj|fsproj|props|targets|sln|slnx)$/i;

/** Absolute Windows or POSIX path under `cwd` -> repo-relative, forward slashes. Portable: tests feed Windows paths on Linux. */
function toRepoRelative(file, cwd = process.cwd()) {
  const f = file.trim().replaceAll('\\', '/');
  const c = cwd.replaceAll('\\', '/').replace(/\/$/, '');
  if (c && f.toLowerCase().startsWith(`${c.toLowerCase()}/`)) return f.slice(c.length + 1);
  return f;
}

// A compiler/restore ERROR about the tool's own run rather than the code: an MSB/NU/NETSDK code, a diagnostic located in a
// project file, or one with no path at all (`MSBUILD : error MSB1003`).
function defaultFault(isError, code, rel) {
  return isError && (/^(MSB|NU|NETSDK)\d+$/i.test(code) || NON_SOURCE_DIAGNOSTIC_FILE.test(rel) || !/[\\/.]/.test(rel));
}

function parseMsbuildLines(text, { levelFor, cwd, faultFor = defaultFault }) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    let m = MSBUILD_LOC.exec(line);
    let file; let ln = 1; let col; let severity; let code; let message;
    if (m) {
      [, file, , , severity, code, message] = m;
      ln = Number.parseInt(m[2], 10);
      col = m[3] ? Number.parseInt(m[3], 10) : undefined;
    } else {
      m = MSBUILD_GLOBAL.exec(line);
      if (!m) continue;
      [, file, severity, code, message] = m;
    }
    const rel = toRepoRelative(file, cwd);
    const key = `${rel}|${ln}|${col ?? ''}|${code}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isError = severity === 'error';
    const toolFault = faultFor(isError, code, rel);
    out.push({
      file: rel, line: ln, column: col, rule: code, message: message.trim(),
      fixable: false, level: levelFor(severity), ...(toolFault ? { toolFault: true } : {}),
    });
  }
  return out;
}

/** `dotnet build` output. An `error` is a compile error (level error); a warning is a warning. */
export function parseMsbuildOutput(text, { cwd } = {}) {
  return parseMsbuildLines(text, { levelFor: (s) => (s === 'error' ? 'error' : 'warning'), cwd });
}

/** `dotnet format --verify-no-changes` output (stderr): the SAME line format, but every diagnostic is a style note. */
export function parseDotnetFormatOutput(text, { cwd } = {}) {
  // Style notes are `error`-severity in dotnet format's own output; only a genuine MSB/NU/NETSDK error is a tool fault.
  return parseMsbuildLines(text, { levelFor: () => 'style', cwd, faultFor: (isError, code) => isError && /^(MSB|NU|NETSDK)\d+$/i.test(code) });
}

const PARSERS = {
  parseMsbuildOutput,
  parseDotnetFormatOutput,
  parseEslintOutput,
  parseTscOutput,
  parseRuffOutput,
  parseFlake8PylintOutput,
};

// ── Normalization to FindingSchema ───────────────────────────────────────────

/**
 * Normalize a single raw lint finding to FindingSchema (with classification).
 * @param {RawLintFinding} raw
 * @param {ToolRunResult} result
 * @param {number} autoIndex - 1-based sequence for ID generation
 * @returns {object} FindingSchema-shaped object
 */
export function normalizeExternalFinding(raw, result, autoIndex) {
  const meta = getRuleMetadata(result.toolId, raw.rule);
  const sourceKind = result.toolKind === 'typeChecker' ? 'TYPE_CHECKER' : 'LINTER';
  // A compiler `error` is a real defect whatever the rule table says; a `style` note is never above LOW.
  const severity = raw.level === 'error' ? 'HIGH' : (raw.level === 'style' ? 'LOW' : meta.severity);
  const sonarType = raw.level === 'error' ? 'BUG' : meta.sonarType;

  return {
    id: `T${autoIndex}`,
    severity,
    category: `[${sonarType}] ${raw.rule}`,
    section: `${raw.file}:${raw.line}`,
    detail: (raw.message || '').slice(0, 600),
    risk: `Static analysis rule violation: ${raw.rule}`,
    recommendation: `Review and resolve rule: ${raw.rule}. ${raw.fixable ? 'Auto-fix available via tool --fix flag.' : 'Manual fix required.'}`,
    is_quick_fix: meta.isQuickFix,
    is_mechanical: true,
    // A tool-derived finding is never a reopen of a prior human/LLM ruling —
    // `is_reopened` is required on ProducerFindingSchema (2026-08-14) and this
    // constructor must satisfy it explicitly, exactly as it does the two
    // booleans above.
    is_reopened: false,
    principle: raw.rule,
    classification: {
      sonarType,
      effort: meta.effort,
      sourceKind,
      sourceName: result.toolId,
    },
  };
}

/**
 * Normalize all tool results into canonical findings. Skips non-OK results.
 * @param {ToolRunResult[]} results
 * @returns {object[]}
 */
export function normalizeToolResults(results) {
  const findings = [];
  let idx = 0;
  for (const result of results) {
    // A whole-repo tool contributes only when `ok`. A PROJECT tool can be `timeout` overall yet carry real findings from
    // the projects that DID finish (its `findings` are the union of the ok projects', by construction), so those count.
    if (result.status !== 'ok' && !(result.projects && result.findings?.length)) continue;
    for (const raw of result.findings) {
      findings.push(normalizeExternalFinding(raw, result, ++idx));
    }
  }
  return findings;
}

// ── Lint Context Injection ───────────────────────────────────────────────────

const LINT_CONTEXT_TOKEN_BUDGET = 2000; // ~8K chars

/**
 * Format normalized tool findings as a summarized block for GPT prompts.
 * Tells GPT "these are already covered — focus on architectural issues".
 * @param {object[]} normalizedFindings
 * @param {number} [budget=LINT_CONTEXT_TOKEN_BUDGET]
 * @returns {string}
 */
export function formatLintSummary(normalizedFindings, budget = LINT_CONTEXT_TOKEN_BUDGET) {
  if (normalizedFindings.length === 0) return '';

  const header = '## Pre-detected Static Analysis Findings (mechanical — already flagged)\n' +
    'The following have been detected by linters/type-checkers. Do NOT re-raise them.\n' +
    'Focus on architectural, design, and logic issues that static analysis cannot detect.\n\n';

  const charBudget = budget * 4;

  // Small set: list directly
  if (normalizedFindings.length <= 15) {
    const lines = normalizedFindings.map(f =>
      `- ${f.section}: [${f.principle}] ${(f.detail || '').slice(0, 80)}`
    );
    const block = header + lines.join('\n');
    if (block.length <= charBudget) return block;
  }

  // Large set: summarize by rule
  const ruleCount = {};
  const sevCount = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of normalizedFindings) {
    ruleCount[f.principle] = (ruleCount[f.principle] || 0) + 1;
    sevCount[f.severity]++;
  }
  const topRules = Object.entries(ruleCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([rule, count]) => `  - ${rule}: ${count}x`)
    .join('\n');
  return header +
    `**Summary**: ${normalizedFindings.length} findings (H:${sevCount.HIGH} M:${sevCount.MEDIUM} L:${sevCount.LOW})\n` +
    `**Top rules**:\n${topRules}\n\n` +
    `Do NOT re-raise these patterns.`;
}
