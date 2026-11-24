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
import { LAYOUT_CONSTANTS } from '../sync-path-map.mjs';

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

/** First 16 hex of sha256(AGENTS.md), hashed once per process; null when absent, and a null says so once. */
export function policyVersion(root = REPO_ROOT) {
  const key = `policy:${root}`;
  if (key in cache) return cache[key];
  let v = null;
  try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'AGENTS.md'))).digest('hex').slice(0, 16); } catch (err) {
    // Absent by design in some consumers; any other read failure is a fault. Either way the NULL is explained, not silent.
    warnNullOnce(key, 'policy_version', err?.code === 'ENOENT' ? 'no AGENTS.md at the repo root' : `AGENTS.md unreadable (${err?.code ?? err?.message})`);
  }
  cache[key] = v;
  return v;
}

/** The sync manifest, relative to a repo root (a sibling of `scripts/.claude-skills/`, gitignored with it). */
export const SYNC_MANIFEST_REL = 'scripts/.sync-manifest.json';
/** This file's key in a consumer manifest's `files` map (the sync's destination path for it). */
export const SELF_MANIFEST_KEY = 'scripts/.claude-skills/lib/telemetry/provenance.mjs';
/** The manifest keys that make up the bundle a borrowed manifest is checked against. */
const BUNDLE_KEY_PREFIX = 'scripts/.claude-skills/';
/** The sync's own bookkeeping inside the bundle: written there, never listed in a manifest, never code. */
const SYNC_METADATA = new Set([LAYOUT_CONSTANTS.OWNERSHIP_WATERMARK, LAYOUT_CONSTANTS.SYNC_LOCK]);
const SHA_RE = /^[0-9a-f]{7,40}$/;

function parseManifest(text) {
  if (typeof text !== 'string') return null;
  try { const m = JSON.parse(text); return m && typeof m === 'object' ? m : null; } catch { return null; }
}

/**
 * Which commit does the running consumer bundle come from? Pure given `hashOf`.
 *
 * The bundle's own manifest wins. A linked worktree hydrated by an older hydrator
 * (or created by hand) has the bundle but not the manifest (field report 5: 7 of 9
 * consumer worktrees), so the main checkout's manifest is the fallback, but only
 * when the bundle here is exactly the one it lists, in both directions: every bundle file it
 * lists hashes to the bytes in this tree, and this tree has no bundle file it does not list
 * (an old overlay-only hydration leaves removed files behind). The main checkout
 * may have been re-synced since the worktree was hydrated, and the commit is claimed
 * for the whole bundle, so one matching file proves nothing. An unverifiable borrow
 * is null with its reason, never a guess.
 *
 * @param {object} facts
 * @param {string|null} facts.localManifestText this bundle's sibling manifest, or null
 * @param {string|null|undefined} facts.mainManifestText the main checkout's manifest; null = none there, undefined = no main checkout
 * @param {boolean} facts.mainIsSelf the main checkout IS this tree (nothing to borrow)
 * @param {string[]} [facts.presentKeys] manifest-style keys of every file under this tree's bundle
 * @param {(key: string) => string|null} facts.hashOf `sha256:<hex>` of this tree's file at a manifest key, null when absent
 * @returns {{sha: string|null, source: 'bundle-manifest'|'main-worktree-manifest'|null, reason: string|null}}
 */
export function decideBundleToolSha({ localManifestText, mainManifestText, mainIsSelf, hashOf, presentKeys = [] }) {
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
  const files = main.files && typeof main.files === 'object' ? main.files : {};
  const keys = Object.keys(files).filter((k) => k.startsWith(BUNDLE_KEY_PREFIX));
  if (!keys.includes(SELF_MANIFEST_KEY)) return { sha: null, source: null, reason: `${why}; the main worktree's manifest does not list this bundle` };
  const differing = keys.filter((k) => hashOf(k) !== files[k]);
  if (differing.length) {
    return { sha: null, source: null, reason: `${why}; the main worktree's manifest describes a different bundle (${differing.length} of ${keys.length} files differ; re-run skills:hydrate)` };
  }
  const listed = new Set(keys);
  const extra = presentKeys.filter((k) => k.startsWith(BUNDLE_KEY_PREFIX) && !listed.has(k) && !SYNC_METADATA.has(k));
  if (extra.length) {
    return { sha: null, source: null, reason: `${why}; this bundle has ${extra.length} file(s) the main worktree's manifest does not list, e.g. ${extra.slice(0, 3).join(', ')} (re-run skills:hydrate)` };
  }
  return { sha: main.commitSha, source: 'main-worktree-manifest', reason: null };
}

const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
/** Windows paths compare case-insensitively; POSIX paths do not (two roots differing only in case are two trees). */
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * The impure shell around `decideBundleToolSha`: reads the bundle's manifest, and
 * only when it is absent asks for the main checkout (`resolveMainRoot`, the one
 * main-checkout oracle), reads that one, and hashes this tree's copies of its files.
 * @param {string} scriptsDir the `scripts/.claude-skills` directory of the running bundle
 */
export function resolveBundleToolSha(scriptsDir, { mainRootOf = resolveMainRoot } = {}) {
  const repoRoot = path.resolve(scriptsDir, '..', '..');
  const localManifestText = readOrNull(path.join(repoRoot, SYNC_MANIFEST_REL));
  let mainManifestText; let mainIsSelf = false;
  if (localManifestText == null) {
    try {
      const mainRoot = mainRootOf(repoRoot);
      if (mainRoot) {
        mainIsSelf = samePath(path.resolve(mainRoot), repoRoot);
        mainManifestText = mainIsSelf ? null : readOrNull(path.join(mainRoot, SYNC_MANIFEST_REL));
      }
    } catch { /* not a git checkout: nothing to borrow from */ }
  }
  const hashOf = (key) => {
    try { return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(path.join(repoRoot, key))).digest('hex'); } catch { return null; }
  };
  const presentKeys = [];
  if (localManifestText == null && typeof mainManifestText === 'string') {
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(r); else presentKeys.push(r);
      }
    };
    try { walk(BUNDLE_KEY_PREFIX.slice(0, -1)); } catch { /* unreadable bundle: the hash comparison already refuses */ }
  }
  return decideBundleToolSha({ localManifestText, mainManifestText, mainIsSelf, hashOf, presentKeys });
}

const warned = new Set();
/** A NULL stamp says why, once per process, so a run is not silently unversioned. */
function warnNullOnce(key, column, reason) {
  if (warned.has(key)) return;
  warned.add(key);
  try { process.stderr.write(`  [provenance] ${column} not recorded: ${reason}\n`); } catch { /* never throw from telemetry */ }
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
  if (v == null) warnNullOnce(key, 'tool_sha', reason);
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
