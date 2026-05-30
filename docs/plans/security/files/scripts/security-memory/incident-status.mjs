/**
 * @fileoverview Status resolution for security incidents.
 * Plan: docs/plans/security-strategy-postgres-port.md §5 (Phase 2 — lift verbatim).
 *
 * Two functions:
 *   - classifyMitigation(): pure, given evidence picks the status enum value.
 *   - runSemgrepIfNeeded(): impure, shells out to semgrep with caching.
 *
 * Semgrep ref formats supported:
 *   - "semgrep:my-rule-id"        → local rule at semgrep/my-rule-id.yml
 *   - "semgrep:p/owasp-top-ten"   → registry ruleset (no local file)
 *   - "semgrep:r/python.lang..."  → registry rule
 *
 * False-comfort guard: file-ref / manual mitigations NEVER auto-claim
 * mitigation-passing — only semgrep rules that exist AND last-passed do.
 *
 * @module scripts/security-memory/incident-status
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Pure function — given mitigation kind + evidence, pick the status enum.
 * Testable without I/O.
 *
 * @param {object} args
 * @param {'semgrep'|'manual'|'file-ref'} args.mitigation_kind
 * @param {{passed:boolean, ranSemgrep:boolean, ruleFileFound:boolean, toolError?:boolean}|null} args.semgrepRunResult
 * @returns {{status: string, status_evidence: string}}
 */
export function classifyMitigation({ mitigation_kind, semgrepRunResult }) {
  if (mitigation_kind === 'semgrep') {
    if (!semgrepRunResult) {
      return { status: 'manual-verification-required', status_evidence: 'semgrep-not-run' };
    }
    // Rule-file check comes BEFORE binary-presence check: the runner
    // short-circuits to {ranSemgrep:false, ruleFileFound:false} when the local
    // rule is missing — a real failing mitigation, not a binary-not-found case.
    if (!semgrepRunResult.ruleFileFound) {
      return { status: 'mitigation-failing', status_evidence: 'rule-not-found' };
    }
    if (!semgrepRunResult.ranSemgrep) {
      const evidence = semgrepRunResult.toolError ? 'semgrep-tool-error' : 'semgrep-binary-not-found';
      return { status: 'manual-verification-required', status_evidence: evidence };
    }
    return semgrepRunResult.passed
      ? { status: 'mitigation-passing', status_evidence: 'semgrep-passed' }
      : { status: 'mitigation-failing', status_evidence: 'semgrep-failed' };
  }
  // file-ref + manual: NEVER auto-claim mitigation-passing (false-comfort guard).
  return { status: 'manual-verification-required', status_evidence: `kind-${mitigation_kind}` };
}

/**
 * Impure: shells out to semgrep when needed, caches result by
 * sha256(rule + repo_HEAD).
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string|null} args.mitigationRef
 * @param {string} args.mitigationKind
 * @param {Map<string, object>} args.fingerprintCache
 * @param {string} args.repoHeadSha
 * @returns {{passed:boolean, ranSemgrep:boolean, ruleFileFound:boolean, toolError?:boolean}|null}
 */
export function runSemgrepIfNeeded({ repoRoot, mitigationRef, mitigationKind, fingerprintCache, repoHeadSha }) {
  if (mitigationKind !== 'semgrep' || !mitigationRef) return null;

  const ref = mitigationRef.replace(/^semgrep:/, '');
  const isRegistry = ref.startsWith('p/') || ref.startsWith('r/');

  let cacheKey;
  let ruleFileFound = false;
  let rulePath = null;
  if (isRegistry) {
    cacheKey = sha256(ref + '\n' + repoHeadSha);
    ruleFileFound = true; // trust semgrep to fetch; "not found" means tool error
  } else {
    // Path-traversal guard: the mitigation_ref regex accepts dots and slashes
    // (namespaced rule IDs), so ref can contain `..`. Resolve and verify the
    // path stays inside <repoRoot>/semgrep/ before any I/O.
    const semgrepDir = path.resolve(repoRoot, 'semgrep');
    rulePath = path.resolve(semgrepDir, `${ref}.yml`);
    if (rulePath !== semgrepDir && !rulePath.startsWith(semgrepDir + path.sep)) {
      return { passed: false, ranSemgrep: false, ruleFileFound: false };
    }
    if (!existsSync(rulePath)) {
      return { passed: false, ranSemgrep: false, ruleFileFound: false };
    }
    ruleFileFound = true;
    const ruleContent = readFileSync(rulePath, 'utf-8');
    cacheKey = sha256(ruleContent + '\n' + repoHeadSha);
  }

  if (fingerprintCache.has(cacheKey)) {
    return fingerprintCache.get(cacheKey);
  }

  // Detect semgrep binary presence first (graceful degradation). Distinguish
  // "binary missing" from "tool error during scan" so operators can triage
  // env-misconfig vs a broken rule file.
  const probe = spawnSync('semgrep', ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    const result = { passed: false, ranSemgrep: false, ruleFileFound, toolError: false };
    fingerprintCache.set(cacheKey, result);
    return result;
  }

  // stdio:'ignore' (not 'pipe') — we only care about the exit code; piping
  // would buffer stdout up to maxBuffer and a broad rule could throw ENOBUFS.
  const configArg = isRegistry ? ref : rulePath;
  let result;
  try {
    execFileSync('semgrep', ['--config', configArg, '--json', '--quiet', repoRoot], {
      stdio: 'ignore',
      timeout: 60000,
    });
    result = { passed: true, ranSemgrep: true, ruleFileFound, toolError: false };
  } catch (err) {
    if (err.status === 1) {
      result = { passed: false, ranSemgrep: true, ruleFileFound, toolError: false };
    } else {
      // Exit 2+ or signal: tool error (broken YAML, timeout, perms) → degrade
      // to manual but PRESERVE toolError for a distinct evidence string.
      result = { passed: false, ranSemgrep: false, ruleFileFound, toolError: true };
    }
  }

  fingerprintCache.set(cacheKey, result);
  return result;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}
