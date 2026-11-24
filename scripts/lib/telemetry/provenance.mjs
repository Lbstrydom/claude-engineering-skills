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
import { resolveMainRoot } from '../pinned-worktree/paths.mjs';

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

/** The sync manifest, relative to a repo root (a sibling of `scripts/.claude-skills/`, gitignored with it). */
export const SYNC_MANIFEST_REL = 'scripts/.sync-manifest.json';
/** This file's key in a consumer manifest's `files` map: how a borrowed manifest is checked against the running bundle. */
export const SELF_MANIFEST_KEY = 'scripts/.claude-skills/lib/telemetry/provenance.mjs';
const SHA_RE = /^[0-9a-f]{7,40}$/;

function parseManifest(text) {
  if (typeof text !== 'string') return null;
  try { const m = JSON.parse(text); return m && typeof m === 'object' ? m : null; } catch { return null; }
}

/**
 * PURE. Which commit does the running consumer bundle come from?
 *
 * The bundle's own manifest wins. A linked worktree hydrated by an older hydrator
 * (or created by hand) has the bundle but not the manifest (field report 5: 7 of 9
 * consumer worktrees), so the main checkout's manifest is the fallback, but only
 * when its `files` entry for THIS module matches the bytes running here: the main
 * checkout may have been re-synced since the worktree was hydrated, and then its
 * commit describes a different bundle. An unverifiable borrow is null, not a guess.
 *
 * @param {object} facts
 * @param {string|null} facts.localManifestText this bundle's sibling manifest, or null
 * @param {string|null} facts.mainManifestText the main checkout's manifest, or null
 * @param {boolean} facts.mainIsSelf the main checkout IS this tree (nothing to borrow)
 * @param {string|null} facts.selfHash `sha256:<hex>` of this module's bytes
 * @returns {{sha: string|null, source: 'bundle-manifest'|'main-worktree-manifest'|null, reason: string|null}}
 */
export function decideBundleToolSha({ localManifestText, mainManifestText, mainIsSelf, selfHash }) {
  const local = parseManifest(localManifestText);
  if (local) {
    return SHA_RE.test(local.commitSha ?? '')
      ? { sha: local.commitSha, source: 'bundle-manifest', reason: null }
      : { sha: null, source: null, reason: `${SYNC_MANIFEST_REL} has no commitSha` };
  }
  const why = localManifestText == null ? `no ${SYNC_MANIFEST_REL} beside the bundle` : `${SYNC_MANIFEST_REL} is not valid JSON`;
  if (mainIsSelf || mainManifestText === undefined) return { sha: null, source: null, reason: `${why}, and no main worktree to borrow from (run skills:hydrate, or re-sync)` };
  const main = parseManifest(mainManifestText);
  if (!main) return { sha: null, source: null, reason: `${why}, and the main worktree has none either (re-sync)` };
  if (!SHA_RE.test(main.commitSha ?? '')) return { sha: null, source: null, reason: `${why}; the main worktree's manifest has no commitSha` };
  const recorded = main.files && typeof main.files === 'object' ? main.files[SELF_MANIFEST_KEY] : undefined;
  if (!selfHash || recorded !== selfHash) {
    return { sha: null, source: null, reason: `${why}; the main worktree's manifest describes a different bundle (re-run skills:hydrate)` };
  }
  return { sha: main.commitSha, source: 'main-worktree-manifest', reason: null };
}

const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

/**
 * The impure shell around `decideBundleToolSha`: reads the bundle's manifest, and
 * only when it is absent asks for the main checkout (`resolveMainRoot`, the one
 * main-checkout oracle) and reads that one.
 * @param {string} scriptsDir the `scripts/.claude-skills` directory of the running bundle
 */
export function resolveBundleToolSha(scriptsDir, { mainRootOf = resolveMainRoot, selfPath = fileURLToPath(import.meta.url) } = {}) {
  const repoRoot = path.resolve(scriptsDir, '..', '..');
  const localManifestText = readOrNull(path.join(repoRoot, SYNC_MANIFEST_REL));
  let mainManifestText; let mainIsSelf = false; let selfHash = null;
  if (localManifestText == null) {
    try {
      const mainRoot = mainRootOf(repoRoot);
      if (mainRoot) {
        mainIsSelf = mainRoot.toLowerCase() === repoRoot.toLowerCase();
        mainManifestText = mainIsSelf ? null : readOrNull(path.join(mainRoot, SYNC_MANIFEST_REL));
      }
    } catch { /* not a git checkout: nothing to borrow from */ }
    try { selfHash = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(selfPath)).digest('hex'); } catch { selfHash = null; }
  }
  return decideBundleToolSha({ localManifestText, mainManifestText, mainIsSelf, selfHash });
}

const warned = new Set();
/** A NULL stamp says why, once per process, so a run is not silently unversioned. */
function warnNullOnce(key, reason) {
  if (warned.has(key)) return;
  warned.add(key);
  try { process.stderr.write(`  [provenance] tool_sha not recorded: ${reason}\n`); } catch { /* never throw from telemetry */ }
}

/**
 * The version of the running tooling: the sync manifest's source commit when this
 * runs from a consumer's synced bundle (the consumer's own HEAD is NOT the tool
 * version), else the git HEAD of the source tree. null when unreadable, and a null
 * logs its reason once.
 */
export function toolSha(root) {
  const key = `sha:${root ?? ''}`;
  if (key in cache) return cache[key];
  let v = null;
  let reason = null;
  if (root === undefined && IS_BUNDLE) {
    ({ sha: v, reason } = resolveBundleToolSha(SCRIPTS_DIR));
  } else {
    try { v = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root ?? REPO_ROOT, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { v = null; }
    if (!v) reason = 'git rev-parse HEAD failed in the source tree';
  }
  if (v == null) warnNullOnce(key, reason);
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
export function _resetProvenanceCache() { for (const k of Object.keys(cache)) delete cache[k]; warned.clear(); }
