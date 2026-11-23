/**
 * @fileoverview Run one CLI with `--help` under the instrumented preload and
 * report whether it stayed read-only. Library for `check-help-readonly.mjs`.
 *
 * `--help` must be a pure read: AGENTS.md's unknown-flag rule exists because a
 * CLI that does not recognise `--help` simply RUNS (`arch-intent-bootstrap.mjs
 * --help` ran the bootstrap, 2026-11-21). The probe therefore treats "ignored
 * `--help`" and "handled it" alike — it only asks what the process TRIED to do.
 *
 * @module scripts/lib/help-probe/probe
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PRELOAD = path.join(import.meta.dirname, 'preload.mjs');

/** Captured stdout cap; ANY byte beyond it sets `stdoutTruncated` (a usage block that large is itself a finding). */
export const STDOUT_CAP = 65536;

/** Seconds a `--help` may take before it counts as having started real work. */
export const HELP_TIMEOUT_MS = 60000;

/**
 * @param {string} scriptAbs absolute path of the CLI
 * @param {{cwd: string, timeoutMs?: number, args?: string[], label?: string, captureStdout?: boolean}} opts
 * @returns {Promise<{file: string, kinds: string[], violations: Array<{kind:string, detail:string}>, exitCode: number|null, timedOut: boolean}>}
 */
export function probeHelp(scriptAbs, { cwd, timeoutMs = HELP_TIMEOUT_MS, args = ['--help'], label = path.basename(scriptAbs), captureStdout = false }) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'help-probe-'));
  const log = path.join(logDir, 'log.jsonl');
  fs.writeFileSync(log, '');
  // Poisoned env: nothing the CLI reads can point it at a real store or service.
  const env = {
    ...process.env,
    HELP_PROBE_LOG: log,
    // APPENDED to any ambient NODE_OPTIONS (--no-warnings, memory limits, loaders), never replacing it.
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(PRELOAD).href}`].filter(Boolean).join(' '),
    AUDIT_DB_URL: '', AUDIT_DB_TEST_URL: '', DATABASE_URL: '',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9',
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptAbs, ...args], { cwd, env, stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'ignore'] });
    let stdout = '';
    let stdoutTruncated = false;
    if (captureStdout) { child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => {
      const room = STDOUT_CAP - stdout.length;
      if (d.length > room) stdoutTruncated = true; // ANY discarded output, even past an exactly-full buffer
      if (room > 0) stdout += d.slice(0, room);
    }); }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const violations = [];
      // An unobservable probe is NOT a clean one: an unreadable log or a torn line
      // means this run cannot vouch for the CLI, so it is itself a finding.
      try {
        for (const line of fs.readFileSync(log, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          try { violations.push(JSON.parse(line)); } catch { violations.push({ kind: 'probe-error', detail: 'torn log line' }); }
        }
      } catch (err) { violations.push({ kind: 'probe-error', detail: `log unreadable: ${err.message}` }); }
      fs.rmSync(logDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      if (timedOut) violations.push({ kind: 'hang', detail: `no exit within ${timeoutMs}ms` });
      const kinds = [...new Set(violations.map((v) => v.kind))].sort();
      resolve({ file: label, kinds, violations, exitCode, timedOut, stdout, stdoutTruncated });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      fs.rmSync(logDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      // A CLI that could not even be spawned was not shown read-only.
      resolve({ file: label, kinds: ['probe-error'], violations: [{ kind: 'probe-error', detail: `spawn failed: ${err.message}` }], exitCode: null, timedOut: false });
    });
  });
}

/** Run `fn` over `items` with bounded concurrency, preserving order. */
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}
