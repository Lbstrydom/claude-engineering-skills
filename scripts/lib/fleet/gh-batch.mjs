/**
 * @fileoverview Run several independent `gh` invocations CONCURRENTLY from
 * synchronous code, and get back exactly what `spawnSync` would have returned
 * for each — so every caller keeps its own classification and parsing.
 *
 * Why: `fleet status` asks gh three questions (open PRs, their checks, recently
 * merged PRs). Each is a network round trip of ~0.5-0.7 s, and sequentially they
 * were ~70% of a warm status run (measured 2026-10-10: 1.8 s of 2.5 s). fleet's
 * fact gathering is synchronous, so the batch runs in one short-lived worker
 * process (`spawnSync` of this module) that spawns the gh processes in parallel.
 *
 * Each job is independent: one failing, timing out or missing gh never affects
 * another's result. The worker's own failure (it could not start, or printed
 * something unparseable) is reported for every job as a spawn error, which the
 * callers already classify as "gh failed to run".
 *
 * @module scripts/lib/fleet/gh-batch
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

/**
 * @param {string} cwd
 * @param {string[][]} jobs argv for each gh invocation
 * @param {{ghBin?: string, env?: NodeJS.ProcessEnv, timeoutMs: number}} opts
 * @returns {Array<{status: number|null, stdout: string, stderr: string, error?: {code: string, message: string}}>}
 */
export function ghBatch(cwd, jobs, { ghBin = 'gh', env, timeoutMs }) {
  if (!jobs.length) return [];
  const childEnv = { ...(env ?? process.env), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  const res = spawnSync(process.execPath, [SELF, '--gh-batch-worker'], {
    cwd, encoding: 'utf-8', input: JSON.stringify({ ghBin, jobs, timeoutMs }),
    env: childEnv, timeout: timeoutMs + 10_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true,
  });
  const fail = (message) => jobs.map(() => ({ status: null, stdout: '', stderr: '', error: { code: 'EBATCH', message } }));
  if (res.error) return fail(`gh batch worker failed: ${res.error.message}`);
  try {
    const out = JSON.parse(res.stdout);
    if (!Array.isArray(out) || out.length !== jobs.length) return fail('gh batch worker returned a malformed result');
    return out;
  } catch {
    return fail(`gh batch worker returned no result (exit ${res.status}): ${String(res.stderr).trim().split('\n')[0] || 'no output'}`);
  }
}

/** The worker: read jobs on stdin, run them in parallel, print results as JSON. */
async function worker() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const { ghBin, jobs, timeoutMs } = JSON.parse(raw);
  const one = (args) => new Promise((resolve) => {
    let stdout = ''; let stderr = ''; let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    let child;
    try {
      child = spawn(ghBin, args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      done({ status: null, stdout: '', stderr: '', error: { code: err.code ?? 'ESPAWN', message: err.message } });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done({ status: null, stdout, stderr, error: { code: 'ETIMEDOUT', message: `timed out after ${timeoutMs}ms` } });
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (err) => done({ status: null, stdout, stderr, error: { code: err.code ?? 'ESPAWN', message: err.message } }));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
  const results = await Promise.all(jobs.map(one));
  process.stdout.write(JSON.stringify(results));
}

// Worker entry: only when THIS file is the script being run, with the worker flag.
const canon = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv.includes('--gh-batch-worker') && process.argv[1] && canon(process.argv[1]) === canon(SELF)) await worker();
