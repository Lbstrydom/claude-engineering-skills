/**
 * @fileoverview Decision-time provenance stamps (docs/plans/own-model-telemetry-pr3.md
 * decision 2; memo section 6.8 rows 2, 4, 6, 11).
 *
 * `stampDecision` is the ONE place that adds `tool_sha`, `policy_version` and
 * `schema_version` to a learning-decision entry, so a caller cannot forget them.
 * `normalizeSnapshot` is the executable form of "the input snapshot holds hashes
 * and ids only": an allowlist, a format check per key and a size cap, so
 * content-free is a property of the code, not a convention.
 *
 * Never throws: provenance is optional telemetry and must not break a decision.
 *
 * @module scripts/lib/telemetry/provenance
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PROVENANCE_SCHEMA_VERSION = 1;
export const SNAPSHOT_MAX_BYTES = 2048;
const HASH_KEYS = ['diff_hash', 'prompt_hash', 'state_hash'];
const HASH_RE = /^[0-9a-f]{8,64}$/;
const PRECEDENT_ID_RE = /^[0-9a-zA-Z_.:-]{1,64}$/;
const MAX_PRECEDENTS = 20;

/**
 * PURE. Reduce a caller-supplied snapshot to the allowed, well-formed keys.
 * @param {unknown} raw
 * @returns {{snapshot: object|null, dropped: number, rejected?: string}}
 */
export function normalizeSnapshot(raw) {
  if (raw == null) return { snapshot: null, dropped: 0 };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { snapshot: null, dropped: 1, rejected: 'not-an-object' };
  const out = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (HASH_KEYS.includes(k)) {
      if (typeof v === 'string' && HASH_RE.test(v)) out[k] = v; else dropped++;
    } else if (k === 'precedent_ids') {
      if (Array.isArray(v)) {
        const ok = v.filter((x) => typeof x === 'string' && PRECEDENT_ID_RE.test(x)).slice(0, MAX_PRECEDENTS);
        dropped += v.length - ok.length;
        if (ok.length) out[k] = ok;
      } else dropped++;
    } else dropped++;
  }
  if (Object.keys(out).length === 0) return { snapshot: null, dropped };
  if (Buffer.byteLength(JSON.stringify(out)) > SNAPSHOT_MAX_BYTES) return { snapshot: null, dropped, rejected: 'too-large' };
  return { snapshot: out, dropped };
}

// scripts/ (source repo) or scripts/.claude-skills (consumer bundle): this file is <scriptsDir>/lib/telemetry/.
const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IS_BUNDLE = path.basename(SCRIPTS_DIR) === '.claude-skills';
const REPO_ROOT = IS_BUNDLE ? path.resolve(SCRIPTS_DIR, '..', '..') : path.resolve(SCRIPTS_DIR, '..');
const cache = {};

/** First 16 hex of sha256(AGENTS.md), hashed once per process; null when absent. */
export function policyVersion(root = REPO_ROOT) {
  const key = `policy:${root}`;
  if (key in cache) return cache[key];
  let v = null;
  try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'AGENTS.md'))).digest('hex').slice(0, 16); } catch { /* absent in some consumers */ }
  cache[key] = v;
  return v;
}

/**
 * The version of the running tooling: the sync manifest's source commit when this
 * runs from a consumer's synced bundle (the consumer's own HEAD is NOT the tool
 * version), else the git HEAD of the source tree. null when unreadable.
 */
export function toolSha(root) {
  const key = `sha:${root ?? ''}`;
  if (key in cache) return cache[key];
  let v = null;
  if (root === undefined && IS_BUNDLE) {
    try {
      const m = fs.readFileSync(path.join(SCRIPTS_DIR, '..', '.sync-manifest.json'), 'utf8').slice(0, 2048).match(/"commitSha"\s*:\s*"([0-9a-f]{7,40})"/);
      v = m ? m[1] : null;
    } catch { v = null; }
  } else {
    try { v = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root ?? REPO_ROOT, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { v = null; }
  }
  cache[key] = v;
  return v;
}

/**
 * The provenance columns for one decision, merged over any caller-supplied
 * optional fields. A caller value wins; nothing is ever fabricated.
 * @param {object} input optional: selectionRule, selectionProbability, randomised, inputSnapshot, optionsNotChosen, eligiblePopulation
 * @returns {object} camelCase entry fields
 */
export function stampDecision(input = {}, { root } = {}) {
  const snap = normalizeSnapshot(input.inputSnapshot);
  const prob = Number.isFinite(input.selectionProbability) && input.selectionProbability >= 0 && input.selectionProbability <= 1 ? input.selectionProbability : null;
  return {
    toolSha: toolSha(root),
    policyVersion: policyVersion(root ?? REPO_ROOT),
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    selectionRule: typeof input.selectionRule === 'string' && input.selectionRule ? input.selectionRule.slice(0, 80) : null,
    selectionProbability: prob,
    randomised: typeof input.randomised === 'boolean' ? input.randomised : null,
    inputSnapshot: snap.snapshot,
    optionsNotChosen: Array.isArray(input.optionsNotChosen) ? input.optionsNotChosen.slice(0, 50).map((x) => String(x).slice(0, 80)) : null,
    eligiblePopulation: Number.isInteger(input.eligiblePopulation) && input.eligiblePopulation >= 0 ? input.eligiblePopulation : null,
  };
}

/**
 * The propensity/denominator fields for the `pass_selection` decision while every
 * pass always runs: a deterministic rule, probability 1, nothing skipped. Recording
 * the degenerate case is what lets a later non-trivial selector be compared to it.
 * @param {number} passCount
 * @param {string|null|undefined} auditedTree git tree hash of the audited target, when known
 */
export function allPassesPropensity(passCount, auditedTree) {
  return {
    selectionRule: 'all-passes', selectionProbability: 1, randomised: false, optionsNotChosen: [],
    eligiblePopulation: passCount,
    inputSnapshot: auditedTree ? { diff_hash: String(auditedTree).toLowerCase() } : null,
  };
}

/** Test seam: forget cached values. */
export function _resetProvenanceCache() { for (const k of Object.keys(cache)) delete cache[k]; }
