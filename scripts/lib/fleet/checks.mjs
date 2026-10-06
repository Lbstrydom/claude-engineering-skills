/**
 * @fileoverview /fleet's consumer extension hook (plan §2b) — a repo-owned
 * script that sees what git cannot (two sessions both bumping a contract hash,
 * both claiming a migration number) and reports it as findings.
 *
 * Contract. The spawned argv is `[...runner, script, ...args]` with
 * `shell:false` — never a shell string, so there is no quoting or injection
 * surface. `script` is a NAMED field (an interpreter such as `node` is never
 * mistaken for the file that gets hashed). fleet writes one JSON document to the
 * script's stdin and expects `{schemaVersion:1, findings:[...]}` on stdout;
 * anything else — non-JSON, a schema failure, a non-zero exit, a timeout, an
 * unreadable script — is a `check-failed` RESULT, never an exception.
 *
 * An unmeasured hook never reads as a pass: a `block` finding, or a
 * check-failed/timeout on a `severity:'block'` check, makes a train not
 * approvable. `warn`-severity checks only disclose.
 *
 * `checksBlockApproval` delegates to `overlap.mjs:checkBlocksApproval`, the
 * predicate `approvable` itself consumes, so the two cannot disagree.
 *
 * Plan: docs/plans/fleet-multi-session-coordination.md §2b, §7 (Phase 5).
 *
 * @module scripts/lib/fleet/checks
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { canonicalizeEol } from '../file-io.mjs';
import { isInside } from './contracts.mjs';
import { checkBlocksApproval } from './overlap.mjs';

const FindingSchema = z.strictObject({
  level: z.enum(['info', 'warn', 'block']),
  message: z.string(),
  sessions: z.array(z.string()).optional(),
  evidence: z.string().optional(),
});

/** What a check script must print on stdout. Strict: an unknown key is a failure. */
export const CheckOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  findings: z.array(FindingSchema),
});

const JS_EXT = /\.(?:mjs|cjs|js)$/i;
const MAX_STDOUT = 16 * 1024 * 1024;
const STDERR_TAIL = 2048;

/** The last 2KB of a hook's stderr, for a failure reason (empty string when none). */
export function stderrTail(stderr) {
  const t = String(stderr ?? '').trim();
  if (!t) return '';
  return ` — stderr: ${t.length > STDERR_TAIL ? `…${t.slice(-STDERR_TAIL)}` : t}`;
}

/**
 * Hash of a check script for the manifest. Takes the explicit `script` path.
 * Returns `{hash:null, reason}` when the file cannot be read or resolves outside
 * the repo — never throws.
 * @param {string} cwd - repo root the script path is relative to
 * @param {string} script
 * @returns {{hash: string|null, reason?: string}}
 */
export function checkScriptHash(cwd, script) {
  try {
    const abs = path.resolve(cwd, script);
    if (!isInside(abs, cwd, { strict: true })) return { hash: null, reason: `script ${script} resolves outside the repo` };
    const real = fs.realpathSync.native(abs);
    if (!isInside(real, fs.realpathSync.native(cwd), { strict: true })) return { hash: null, reason: `script ${script} resolves (via a link) outside the repo` };
    const bytes = canonicalizeEol(fs.readFileSync(real));
    return { hash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` };
  } catch (e) {
    return { hash: null, reason: `script ${script} unreadable: ${e.code ?? e.message}` };
  }
}

/**
 * The argv for one check: `[...runner, script, ...args]`. With no `runner`,
 * `.mjs/.js/.cjs` run under the current node and any other extension is run
 * directly (it must be an executable file).
 * @param {{script: string, runner?: string[], args?: string[]}} check
 * @returns {{argv: string[], scriptIndex: number}}
 */
export function checkArgv(check) {
  const runner = check.runner ?? (JS_EXT.test(check.script) ? [process.execPath] : []);
  return { argv: [...runner, check.script, ...(check.args ?? [])], scriptIndex: runner.length };
}

const STDOUT_CAP = 1024 * 1024; // a findings document larger than this is a failure, never a partial parse
const STDERR_CAP = 64 * 1024; // only the TAIL of stderr matters (see stderrTail)

/**
 * The supervisor runs the hook in its OWN PROCESS GROUP (POSIX) / job tree (win32).
 *  - On timeout, or when stdout overflows its cap, it kills the whole tree.
 *  - A hook that has EXITED is done: anything it left running that still holds the
 *    pipes is a leak, which is terminated (group kill on POSIX; on win32 its
 *    orphaned descendants are found by ParentProcessId) - never waited on.
 *  - Output is kept as Buffers, bounded, and decoded ONCE at the end, so a
 *    multi-byte character split across chunks survives.
 * It is a tiny node program run via process.execPath that relays stdin and prints
 * one JSON envelope; spawnSync still bounds the supervisor itself.
 */
const SUPERVISOR = `
const cfg = JSON.parse(process.argv[1]);
const { spawn, spawnSync } = require('node:child_process');
const win = process.platform === 'win32';
const child = spawn(cfg.argv[0], cfg.argv.slice(1), { cwd: cfg.cwd, shell: false, windowsHide: true, detached: !win, stdio: ['pipe', 'pipe', 'pipe'] });
const outChunks = []; let outLen = 0; let outOver = false;
let errChunks = []; let errLen = 0;
let done = false, closed = false, timedOut = false, spawnErr = null, exitInfo = null;
child.stdout.on('data', (d) => {
  if (outOver) return;
  if (outLen + d.length > cfg.stdoutCap) { outOver = true; killTree(); return; }
  outChunks.push(d); outLen += d.length;
});
child.stderr.on('data', (d) => {
  errChunks.push(d); errLen += d.length;
  if (errLen > cfg.stderrCap * 2) { const all = Buffer.concat(errChunks); errChunks = [all.subarray(all.length - cfg.stderrCap)]; errLen = errChunks[0].length; }
});
child.stdin.on('error', () => {});
process.stdin.pipe(child.stdin);
// GUARANTEE (and its limit): descendants in the hook's process group (POSIX) / process tree (win32) are
// terminated. A descendant that deliberately escapes via setsid/detached or a job object is NOT. The check
// result does not depend on it: output is bounded and the supervisor finishes on a bounded timer.
function killTree() {
  try {
    if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* nothing left to kill */ }
}
// Same guarantee and limit as killTree, applied after the hook itself has exited.
function killLeftovers() {
  try {
    if (win) {
      const ps = 'function K($p){ Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" | ForEach-Object { K $_.ProcessId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }; K ' + child.pid;
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, shell: false });
    } else process.kill(-child.pid, 'SIGKILL');
  } catch { /* nothing left to kill */ }
}
function finish() {
  if (done) return; done = true; clearTimeout(timer);
  const tail = Buffer.concat(errChunks);
  process.stdout.write(JSON.stringify({
    status: exitInfo ? exitInfo[0] : null, signal: exitInfo ? exitInfo[1] : null, timedOut, outOver, error: spawnErr,
    stdout: Buffer.concat(outChunks).toString('utf8'),
    stderr: (tail.length > cfg.stderrCap ? tail.subarray(tail.length - cfg.stderrCap) : tail).toString('utf8'),
  }));
}
const timer = setTimeout(() => { timedOut = true; killTree(); }, cfg.timeoutMs);
child.on('error', (e) => { spawnErr = { code: e.code, message: e.message }; finish(); });
child.on('close', () => { closed = true; finish(); });
child.on('exit', (status, signal) => {
  exitInfo = [status, signal];
  // Normally the pipes close right away. If they do not, a descendant is holding them: kill it.
  setTimeout(() => { if (!closed) { killLeftovers(); setTimeout(finish, 1000); } }, 150).unref();
});
`;

/**
 * Default process runner. `shell:false`, JSON on stdin, bounded by `timeoutMs`; the
 * whole process tree is killed on timeout, leftovers are killed on exit (see SUPERVISOR).
 * @param {string[]} argv
 * @param {{cwd: string, input: string, timeoutMs: number}} opts
 * @returns {{status: number|null, stdout: string, stderr: string, error?: Error, signal?: string|null}}
 */
export function spawnExec(argv, { cwd, input, timeoutMs }) {
  const res = spawnSync(process.execPath, ['-e', SUPERVISOR, JSON.stringify({ argv, cwd, timeoutMs, stdoutCap: STDOUT_CAP, stderrCap: STDERR_CAP })], {
    input, encoding: 'utf-8', shell: false, windowsHide: true, timeout: timeoutMs + 15_000,
    killSignal: 'SIGKILL', maxBuffer: MAX_STDOUT, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (res.error) return { status: null, stdout: '', stderr: String(res.stderr ?? ''), error: res.error, signal: res.signal };
  let env;
  try { env = JSON.parse(res.stdout); } catch { return { status: null, stdout: '', stderr: String(res.stderr ?? ''), error: new Error('check supervisor produced no result') }; }
  const error = env.timedOut ? Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
    : env.outOver ? Object.assign(new Error(`hook output exceeded ${STDOUT_CAP} bytes`), { code: 'EOUTPUT' })
      : env.error ? Object.assign(new Error(env.error.message), { code: env.error.code }) : undefined;
  return { status: env.status, stdout: String(env.stdout ?? ''), stderr: String(env.stderr ?? ''), error, signal: env.signal };
}

/** Build the stdin document (§2b contract). */
export function buildCheckPayload({ phase, baseOid = null, sessions = [], overlaps = [], trainSources }) {
  return {
    schemaVersion: 1, phase, baseOid, sessions, overlaps,
    ...(trainSources ? { trainSources } : {}),
  };
}

function runOne({ cwd, check, payload, exec }) {
  const { argv, scriptIndex } = checkArgv(check);
  const h = checkScriptHash(cwd, check.script);
  const base = {
    name: check.name, severity: check.severity ?? 'warn', argv, scriptHash: h.hash,
    ...(check.note ? { note: check.note } : {}),
    ...(h.hash === null ? { scriptHashReason: h.reason } : {}),
  };
  const failed = (reason) => ({ ...base, status: 'check-failed', findings: [], reason });
  if (h.hash === null) return failed(h.reason);

  const execArgv = [...argv];
  execArgv[scriptIndex] = path.resolve(cwd, check.script);
  const timeoutMs = check.timeoutMs ?? 60_000;
  let res;
  try { res = exec(execArgv, { cwd, input: JSON.stringify(payload), timeoutMs }); } catch (e) { return failed(`could not run: ${e.message}`); }
  if (res.error) {
    return failed(res.error.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs}ms` : res.error.code === 'EOUTPUT' ? res.error.message : `could not run: ${res.error.message}`);
  }
  if (res.status !== 0) return failed(`exited ${res.status}${res.signal ? ` (${res.signal})` : ''}${stderrTail(res.stderr)}`);
  let doc;
  try { doc = JSON.parse(res.stdout); } catch { return failed(`stdout is not valid JSON${stderrTail(res.stderr)}`); }
  const parsed = CheckOutputSchema.safeParse(doc);
  if (!parsed.success) {
    return failed(`stdout failed the findings schema: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}${stderrTail(res.stderr)}`);
  }
  const findings = parsed.data.findings;
  return { ...base, status: findings.length ? 'findings' : 'ok', findings };
}

/**
 * Run every check whose `runIn` includes `phase`. Never throws.
 *
 * @param {object} args
 * @param {string} args.cwd - repo root
 * @param {Array<object>} args.checks - validated config checks
 * @param {'status'|'land'} args.phase
 * @param {object} args.payload - see `buildCheckPayload`
 * @param {typeof spawnExec} [args.exec] - injectable for tests
 * @returns {Array<{name: string, severity: string, status: 'ok'|'findings'|'check-failed', findings: object[], reason?: string, argv: string[], scriptHash: string|null}>}
 */
export function runChecks({ cwd, checks, phase, payload, exec = spawnExec }) {
  const out = [];
  for (const check of checks ?? []) {
    if (!(check.runIn ?? ['status', 'land']).includes(phase)) continue;
    try {
      out.push(runOne({ cwd, check, payload: { ...payload, schemaVersion: 1, phase }, exec }));
    } catch (e) {
      out.push({ name: check.name, severity: check.severity ?? 'warn', ...(check.note ? { note: check.note } : {}), status: 'check-failed', findings: [], reason: `internal error: ${e.message}`, argv: [], scriptHash: null });
    }
  }
  return out;
}

/**
 * Do the recorded results forbid approval? Pure.
 * @returns {{blocks: boolean, reason: string|null}}
 */
export function checksBlockApproval(results) {
  const reason = checkBlocksApproval(results);
  return { blocks: reason !== null, reason };
}

/**
 * Turn results into advisory status findings (`status` renders them and NEVER
 * fails on them — a block-level finding is shown, not enforced, on a read).
 * @returns {Array<{level: string, message: string, sessions?: string[]}>}
 */
export function resultsToFindings(results) {
  const out = [];
  for (const r of results) {
    if (r.status === 'check-failed') {
      out.push({ level: 'warn', message: `check "${r.name}" failed to run (${r.reason})` });
      continue;
    }
    for (const f of r.findings) {
      out.push({ level: f.level, message: `[${r.name}] ${f.message}${f.evidence ? ` — ${f.evidence}` : ''}`, ...(f.sessions ? { sessions: f.sessions } : {}) });
    }
  }
  return out;
}
