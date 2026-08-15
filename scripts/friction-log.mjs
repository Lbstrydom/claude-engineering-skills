#!/usr/bin/env node
/**
 * @fileoverview Capture real-time operator friction (`npm run audit:wtf "..."`).
 * The point: lower the cost of complaining about the system below the
 * cost of ignoring the friction, so the dogfooding cycle generates
 * qualitative signal alongside quantitative learning_decisions telemetry.
 *
 * Sub-second latency target.  Cloud-offline → falls back to a local
 * `.audit/friction-log.jsonl` outbox so the note is never lost.
 *
 * Usage:
 *   npm run audit:wtf -- "the quickfix hook fired 4× on the same line"
 *   npm run audit:wtf -- --severity blocker "telemetry hangs on R3"
 *   npm run audit:wtf -- --repo wine "auto-defer caught a real bug"
 *
 * Plan: docs/plans/friction-log-and-digest-v1.md §B
 *
 * @module scripts/friction-log
 */
import './lib/load-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertRepoRoot } from './lib/assert-repo-root.mjs';

const VALID_SEVERITIES = ['note', 'annoyance', 'blocker'];
const FALLBACK_PATH    = '.audit/friction-log.jsonl';

// ── CLI arg parsing ────────────────────────────────────────────────────────

export function parseArgs(args) {
  const out = { severity: 'note', repo: null, message: null, json: false };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--severity') { out.severity = args[++i]; continue; }
    if (a === '--repo')     { out.repo     = args[++i]; continue; }
    if (a === '--json')     { out.json = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    positional.push(a);
  }
  out.message = positional.join(' ').trim() || null;
  return out;
}

export function validateArgs(parsed) {
  const errors = [];
  if (!parsed.message) errors.push('message is required (positional argument)');
  if (!VALID_SEVERITIES.includes(parsed.severity)) {
    errors.push(`severity must be one of ${VALID_SEVERITIES.join('|')} (got "${parsed.severity}")`);
  }
  return errors;
}

// ── Repo resolution ───────────────────────────────────────────────────────

/**
 * Resolve the repo name from --repo flag, or from cwd's `git config
 * remote.origin.url`, or from `path.basename(cwd)` as the last fallback.
 */
export function detectRepoName({ flagValue, cwd = process.cwd(), execGit = defaultExecGit }) {
  if (flagValue) return flagValue;
  // Try `git remote get-url origin` and pull the basename.
  try {
    const url = execGit(['remote', 'get-url', 'origin'], { cwd });
    if (typeof url === 'string') {
      const m = /([^/]+?)(?:\.git)?$/.exec(url.trim());
      if (m) return m[1];
    }
  } catch { /* fall through */ }
  // Last resort: basename of cwd.
  return path.basename(path.resolve(cwd));
}

function defaultExecGit(args, opts) {
  try {
    return execFileSync('git', args, {
      cwd: opts?.cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 1500,
    });
  } catch { return null; }
}

// ── Local fallback (cloud offline) ────────────────────────────────────────

export function appendLocalFallback(record, fallbackPath = FALLBACK_PATH) {
  try {
    fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
    fs.appendFileSync(fallbackPath, JSON.stringify(record) + '\n');
    return true;
  } catch { return false; }
}

// ── Main runner ──────────────────────────────────────────────────────────

export async function runFrictionLog(args, deps = {}) {
  const parsed = parseArgs(args);
  if (parsed.help) {
    return { ok: true, help: helpText() };
  }
  const errors = validateArgs(parsed);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const repoName = parsed.repo || detectRepoName({ flagValue: parsed.repo, cwd: deps.cwd });
  const cwd      = deps.cwd || process.cwd();
  const ts       = new Date().toISOString();

  // Try cloud first.
  const ls = deps.learningStore || await import('./learning-store.mjs');
  if (typeof ls.initLearningStore === 'function') {
    await ls.initLearningStore().catch(() => {});
  }
  const cloudEnabled = typeof ls.isCloudEnabled === 'function' && await ls.isCloudEnabled();

  let cloudResult = null;
  if (cloudEnabled) {
    const repoId = repoName ? await ls.getRepoIdByName(repoName).catch(() => null) : null;
    const auditRunId = repoId ? await ls.getMostRecentAuditRunIdForRepo(repoId).catch(() => null) : null;
    // Audit-fix R1 H1: wrap the cloud call in try/catch.  Without this,
    // a network/auth/SDK exception bypasses the local fallback and the
    // friction note is silently dropped.  Now: any throw is downgraded
    // to { ok: false, error } so the fallback path always runs.
    try {
      cloudResult = await ls.insertFrictionNote({
        repoId,
        auditRunId,
        message:  parsed.message,
        cwd,
        severity: parsed.severity,
      });
    } catch (err) {
      cloudResult = { ok: false, error: err.message || String(err) };
    }
    if (cloudResult.ok) {
      return { ok: true, cloud: true, id: cloudResult.id, repo: repoName, severity: parsed.severity, ts };
    }
  }

  // Cloud offline OR cloud insert failed → local fallback.
  const fallbackRecord = {
    ts,
    severity: parsed.severity,
    repo:     repoName,
    cwd,
    message:  parsed.message,
    cloudError: cloudResult?.error || (cloudEnabled ? 'unknown' : 'cloud-disabled'),
  };
  const writtenLocally = appendLocalFallback(fallbackRecord);
  return {
    ok: writtenLocally,           // exit 0 if we at least captured locally
    cloud: false,
    fallback: writtenLocally ? FALLBACK_PATH : null,
    repo: repoName,
    severity: parsed.severity,
    ts,
    error: writtenLocally ? null : 'both cloud and local fallback failed',
  };
}

function helpText() {
  return `Usage: audit:wtf [--severity note|annoyance|blocker] [--repo <name>] <message>

Captures real-time friction with the audit-loop system.  Sub-second target.

Examples:
  npm run audit:wtf -- "the quickfix hook fired 4× on the same line"
  npm run audit:wtf -- --severity blocker "telemetry hangs on R3"
  npm run audit:wtf -- --repo wine-cellar-app "out-of-scope auto-defer caught a real security finding"
`;
}

// ── CLI entry ────────────────────────────────────────────────────────────

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

async function main() {
  assertRepoRoot(import.meta.url);
  const result = await runFrictionLog(process.argv.slice(2));
  if (result.help) {
    process.stdout.write(result.help);
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.ok) {
    if (result.errors) {
      for (const e of result.errors) process.stderr.write(`✗ ${e}\n`);
    } else if (result.error) {
      process.stderr.write(`✗ ${result.error}\n`);
    }
    process.exit(1);
  }
  // Human-readable confirmation to stderr (stdout stays JSON).
  if (result.cloud) {
    process.stderr.write(`✓ logged [${result.severity}] to cloud (id=${result.id?.slice(0, 8)})\n`);
  } else {
    process.stderr.write(`✓ logged [${result.severity}] to local fallback (${result.fallback}) — will replay on next cloud sync\n`);
  }
}

if (isMain) {
  await main();
}
