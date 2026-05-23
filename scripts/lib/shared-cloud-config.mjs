/**
 * @fileoverview Pure-ish helpers + executor for the cross-repo shared-cloud-config
 * feature. Per-user `~/.audit-loop.env` holds DSN + LLM keys; consumer repos
 * auto-inherit via the config.mjs loader (override:false fallback).
 *
 * Lib/CLI separation: this module owns assess + execute + helpers (with
 * injectable prompt/stdio). `scripts/setup-cloud.mjs` is the argv → executor
 * adapter. `scripts/sync-to-repos.mjs` imports the assess + executor from
 * here, never from setup-cloud.mjs.
 *
 * Plan: docs/plans/shared-cloud-config.md.
 *
 * @module scripts/lib/shared-cloud-config
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import dotenv from 'dotenv';
import { atomicWriteFileSync } from './file-io.mjs';

// ── Constants ──────────────────────────────────────────────────────────────

// Vars that are SHARED across consumer repos (single rotation surface).
// Adding a new shared var: append here. The loader doesn't change.
export const SHARED_VARS = Object.freeze([
  'AUDIT_DB_URL', 'AUDIT_DB_SSL_MODE',
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY',
]);

// REQUIRED_VARS is a strict subset — source .env without these can't usefully
// populate the shared file. The assessor reports `misconfigured` when any
// REQUIRED_VAR is missing from source.
export const REQUIRED_VARS = Object.freeze(['AUDIT_DB_URL']);

// Outcome model — single source of truth for both assess + execute + CLI exit.
export const OUTCOMES = Object.freeze({
  CREATED:         'created',          // file didn't exist; we wrote it
  UPDATED:         'updated',          // file existed; we applied add/change/remove
  ALREADY_CURRENT: 'already_current',  // file matches source; nothing to do
  USER_SKIPPED:    'user_skipped',     // operator declined the prompt
  MISCONFIGURED:   'misconfigured',    // source repo unresolvable / no .env / no required vars
  FATAL:           'fatal',            // unexpected error (parse failure, fs error)
});
export const EXIT_CODE_FOR = Object.freeze({
  created:         0,
  updated:         0,
  already_current: 0,
  user_skipped:    0,
  misconfigured:   4,
  fatal:           1,
});

// ── Paths ──────────────────────────────────────────────────────────────────

export function sharedEnvPath(homedir = os.homedir()) {
  return path.join(homedir, '.audit-loop.env');
}

// Walk-up + git-root discovery, same rule as config.mjs::discoverDotenv.
// Extracted so check-setup + runtime share one local-env-path semantic.
export function discoverLocalEnvPath(cwd = process.cwd()) {
  let dir = cwd;
  while (dir) {
    const p = path.join(dir, '.env');
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const p = path.join(gitRoot, '.env');
    if (fs.existsSync(p)) return p;
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const mainRoot = path.resolve(gitCommonDir, '..');
    const main = path.join(mainRoot, '.env');
    if (fs.existsSync(main)) return main;
  } catch { /* not a git repo */ }
  return null;
}

// ── Env parsing + serialization ────────────────────────────────────────────

// Standardise on dotenv.parse for all .env reads — same semantics as the
// runtime loader (config.mjs).
export function parseEnvText(text) {
  return dotenv.parse(text);
}
export function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return parseEnvText(fs.readFileSync(filePath, 'utf-8'));
}

// Round-trip-safe writer. Raw `KEY=value` doesn't round-trip values with
// whitespace, quotes, $, #, newlines.
//
// dotenv quirks (empirically verified — see tests/shared-cloud-config.test.mjs):
//   - Double-quoted: expands `\n` → newline, `\\` → `\`, but NOT `\"` → `"`.
//   - Single-quoted: literal (no escape processing; embedded `'` terminates).
//   - Unquoted (bare) value: read until newline, BUT `#` starts a comment
//     and truncates the value. No escape processing inside the bare value.
//     This is the lossless escape hatch for values containing both quote
//     types — provided the value also avoids `#`.
//
// Strategy:
//   - Safe-alphanumeric → emit as-is (case A).
//   - Contains `"` but no `'` → wrap in single quotes (lossless, case B).
//   - Contains `'` but no `"` → wrap in double quotes + escape `\\` `\n` (case C).
//   - Contains BOTH `"` AND `'` (case D) — Gemini-r3 corrected R2-audit's
//     fail-fast: unquoted (bare) values ARE losslessly readable when none
//     of dotenv's bare-value pitfalls apply (no newline; no surrounding
//     whitespace; doesn't start with `'` / `"`, which would trigger
//     quote-parsing). For these values, emit bare. Only throw when the
//     value genuinely can't be represented in any dotenv form.
//   - Otherwise → double-quote + escape backslashes + newlines.
export function serializeEnvValue(value) {
  if (typeof value !== 'string') value = String(value ?? '');
  if (/^[A-Za-z0-9._:/?=&@%+~-]*$/.test(value)) return value;
  const hasDouble = value.includes('"');
  const hasSingle = value.includes("'");
  if (hasDouble && hasSingle) {
    // Gemini-r3 fix to R2-audit H1/H4: attempt lossless unquoted emission
    // before throwing. Bare values parse verbatim — safe iff they don't
    // collide with dotenv's lexer rules for the unquoted form.
    const bareSafe =
      !/[\r\n]/.test(value)                && // no newlines (would split lines)
      !value.includes('#')                 && // `#` starts a comment (truncates)
      !/^[\s]/.test(value) && !/[\s]$/.test(value) && // no surrounding WS
      !/^["']/.test(value);                   // doesn't open with quote
    if (bareSafe) return value;
    throw new Error(
      'serializeEnvValue: value contains both single and double quotes ' +
      'AND has a bare-form blocker (newline / `#` / leading or trailing ' +
      'whitespace / leading quote). No lossless dotenv encoding exists. ' +
      'Pre-encode the value (JSON / base64) before writing to the shared file.'
    );
  }
  if (hasDouble) return `'${value}'`;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

// ── Source-repo identity ───────────────────────────────────────────────────

// Deterministic single-signal sentinel: `scripts/sync-to-repos.mjs` is
// source-exclusive (NOT in CORE_ENTRY / ARCH_ENTRY; never synced to
// consumer repos). Its presence is sufficient proof of source-repo identity.
function isSourceRepo(candidatePath) {
  return fs.existsSync(path.join(candidatePath, 'scripts/sync-to-repos.mjs'));
}

// Resolution order:
//   1. explicit `--source-repo <path>` flag (CLI) or `explicitFlag` arg
//   2. CLAUDE_AUDIT_LOOP_DIR env override
//   3. cwd IF it's the source repo (verified by sentinel)
//   4. parent's siblings — ONLY if exactly one matches the sentinel.
//      R1-audit H4/H7: multiple matches → return null with `reason:
//      'ambiguous-siblings'` and the candidate list. Operator must set
//      CLAUDE_AUDIT_LOOP_DIR or --source-repo to disambiguate. The prior
//      "first match wins" was filesystem-iteration-order-dependent →
//      different machines/file-system orderings could pick different repos.
// R2-audit M2/M8: unified discriminated return contract. Always returns
// {type: 'resolved'|'ambiguous'|'invalid-override'|'none', ...}. Callers
// branch on `.type` only.
export function resolveSourceRepo({ explicitFlag = null, cwd = process.cwd() } = {}) {
  // (1) explicit flag — operator's wishes win, fail-fast if invalid
  if (explicitFlag) {
    return isSourceRepo(explicitFlag)
      ? { type: 'resolved', path: explicitFlag, source: 'flag' }
      : { type: 'invalid-override', source: 'flag', value: explicitFlag };
  }
  // (2) env override — R2-audit H3: explicit override that points at a
  // non-source path must NOT silently fall through to cwd/sibling scan.
  // Operator who set CLAUDE_AUDIT_LOOP_DIR meant it; report the bad value.
  if (process.env.CLAUDE_AUDIT_LOOP_DIR) {
    return isSourceRepo(process.env.CLAUDE_AUDIT_LOOP_DIR)
      ? { type: 'resolved', path: process.env.CLAUDE_AUDIT_LOOP_DIR, source: 'env' }
      : { type: 'invalid-override', source: 'env', value: process.env.CLAUDE_AUDIT_LOOP_DIR };
  }
  // (3) cwd
  if (isSourceRepo(cwd)) {
    return { type: 'resolved', path: cwd, source: 'cwd' };
  }
  // (4) sibling scan — ambiguous if >1 match
  const parent = path.dirname(cwd);
  let entries;
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { return { type: 'none' }; }
  const matches = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = path.join(parent, e.name);
    if (candidate === cwd) continue;
    if (isSourceRepo(candidate)) matches.push(candidate);
  }
  if (matches.length === 0) return { type: 'none' };
  if (matches.length === 1) return { type: 'resolved', path: matches[0], source: 'sibling' };
  return { type: 'ambiguous', candidates: matches.sort() };
}

// ── Diff model ─────────────────────────────────────────────────────────────

// Full add/change/remove diff. Unmanaged keys (anything outside SHARED_VARS)
// are NEVER included — operator-added vars in the shared file survive updates.
export function diffSharedEnv({ sharedPath: sp, sourcePath, managedKeys = SHARED_VARS }) {
  const shared = parseEnvFile(sp);
  const source = parseEnvFile(sourcePath);
  const result = { add: {}, change: {}, remove: {}, unchanged: {} };
  for (const key of managedKeys) {
    const s = shared[key];
    const src = source[key];
    if (src !== undefined && s === undefined)      result.add[key] = src;
    else if (src !== undefined && s !== src)       result.change[key] = { from: s, to: src };
    else if (src === undefined && s !== undefined) result.remove[key] = s;
    else if (src !== undefined && s === src)       result.unchanged[key] = s;
  }
  return result;
}

// ── Write (secure-mode-at-open, atomic) ────────────────────────────────────

/**
 * Atomically rewrite the shared cloud-config file with the managed key set,
 * preserving operator-added unmanaged keys.
 *
 * Preservation contract (R2-audit M9): only the *parsed key/value pairs*
 * for non-SHARED_VARS keys survive a round-trip. Specifically dropped:
 *   - all comments (header + inline)
 *   - original line ordering (managed keys are re-emitted in SHARED_VARS
 *     order, then unmanaged keys in `Object.entries(existing)` order)
 *   - original quoting style (every value is re-serialised via
 *     `serializeEnvValue`, which may switch quote style or strip outer
 *     quotes that were redundant)
 *
 * Operators who need to keep their own comments / formatting in the shared
 * file should manage those keys outside the SHARED_VARS set AND accept that
 * any rewrite (sync trigger, setup:cloud run) erases their formatting. The
 * file is intentionally a managed artifact — not a hand-edited config.
 *
 * @param {string} filePath - absolute path to the shared env file
 * @param {Record<string,string>} managedVars - new values for SHARED_VARS keys
 * @param {{mode?: number}} [opts] - file mode (default 0o600)
 */
export function writeSharedEnv(filePath, managedVars, { mode = 0o600 } = {}) {
  const existing = parseEnvFile(filePath);
  const preserved = {};
  for (const [k, v] of Object.entries(existing)) {
    if (!SHARED_VARS.includes(k)) preserved[k] = v;
  }
  const lines = [
    '# managed by scripts/lib/shared-cloud-config.mjs — edit source repo .env + run `npm run sync` to update',
  ];
  for (const k of SHARED_VARS) {
    if (managedVars[k] !== undefined) lines.push(`${k}=${serializeEnvValue(managedVars[k])}`);
  }
  if (Object.keys(preserved).length > 0) {
    // Gemini-r3-r3 M4: header text rewritten to be HONEST about what
    // survives. The previous "preserved across updates" wording invited
    // operators to hand-add comments and formatting that dotenv.parse
    // silently strips on the next rewrite. The current behaviour preserves
    // KEY=VALUE pairs only; comments and ordering die. Say so plainly.
    lines.push('',
      '# unmanaged keys — KEY=VALUE pairs survive rewrites, but any',
      '# comments / blank lines / formatting in this section will be',
      '# stripped by the next `setup:cloud` or sync trigger.');
    for (const [k, v] of Object.entries(preserved)) lines.push(`${k}=${serializeEnvValue(v)}`);
  }
  // Atomic write with secure mode at open (file-io.mjs extension).
  atomicWriteFileSync(filePath, lines.join('\n') + '\n', { mode });
  // Windows: mode is largely ignored at file creation; best-effort chmod
  // after for parity (Windows ACLs aren't meaningfully changed by chmod
  // either, so this is symbolic).
  if (process.platform === 'win32') {
    try { fs.chmodSync(filePath, mode); } catch { /* expected */ }
  }
}

// ── Effective-config resolution (used by check-setup) ──────────────────────

// Models the full runtime precedence:
//   1. process.env IFF differs from both files (genuine external override)
//   2. local .env
//   3. shared ~/.audit-loop.env
// The differ-check is load-bearing: config.mjs's dotenv.config() ALREADY
// copies local + shared into process.env, so a naïve "process.env first"
// check would always report source: 'process-env' after the loader runs.
export function resolveCloudConfig({
  processEnv     = process.env,
  localEnvPath   = discoverLocalEnvPath(),
  sharedPath: sp = sharedEnvPath(),
} = {}) {
  const local  = localEnvPath ? parseEnvFile(localEnvPath) : {};
  const shared = parseEnvFile(sp);
  const result = {};
  for (const key of SHARED_VARS) {
    const peVal     = processEnv[key];
    const localVal  = local[key];
    const sharedVal = shared[key];
    // Gemini-r3-r4 G2: peSet = present in env, INCLUDING explicit empty
    // string. `export AUDIT_DB_URL=""` is a deliberate operator override
    // (disable cloud). The previous `peVal !== ''` short-circuit silently
    // fell through to file values, misreporting the source. Downstream
    // consumers (check-setup, store) interpret value === '' however they
    // want; resolveCloudConfig's job is to report the truth.
    const peSet     = peVal !== undefined;
    if (peSet && peVal !== localVal && peVal !== sharedVal) {
      result[key] = { value: peVal, source: 'process-env' };
    } else if (localVal !== undefined) {
      result[key] = { value: localVal,  source: 'local'  };
    } else if (sharedVal !== undefined) {
      result[key] = { value: sharedVal, source: 'shared' };
    } else if (peSet) {
      // peVal == localVal == undefined branch above, OR all three undefined.
      // If we reach here, peSet is true but files are empty → external set.
      result[key] = { value: peVal, source: 'process-env' };
    } else {
      result[key] = { value: null, source: 'unset' };
    }
  }
  return result;
}

// ── Assess (pure) ──────────────────────────────────────────────────────────

// Returns the plan without acting. Sync trigger consumes this and skips
// silently on `already_current`; CLI executor renders human / writes file.
export function assessSharedCloudConfig({
  sourceRepoDir,
  sharedPath: spOverride = null,
  homedir = os.homedir(),
  explicitFlag = null,
} = {}) {
  const sp = spOverride ?? sharedEnvPath(homedir);
  // Source-repo resolution with discriminated-union output.
  const resolution = sourceRepoDir
    ? (isSourceRepo(sourceRepoDir)
        ? { type: 'resolved', path: sourceRepoDir, source: 'arg' }
        : { type: 'invalid-override', source: 'arg', value: sourceRepoDir })
    : resolveSourceRepo({ explicitFlag, cwd: process.cwd() });

  if (resolution.type === 'none') {
    return {
      outcome: OUTCOMES.MISCONFIGURED,
      reason: 'no-source-repo',
      sharedPath: sp,
      message:
        `Source repo not found. Resolution order tried: --source-repo flag, ` +
        `CLAUDE_AUDIT_LOOP_DIR env, cwd, sibling dirs.\nEither set ` +
        `CLAUDE_AUDIT_LOOP_DIR=<path>, run from the source repo, or write ${sp} manually with:\n` +
        `  AUDIT_DB_URL=postgresql://...\n  AUDIT_DB_SSL_MODE=no-verify\n`,
    };
  }
  // R2-audit H3: explicit override pointed at a non-source path. Surface
  // the bad value rather than silently falling back to auto-discovery.
  if (resolution.type === 'invalid-override') {
    return {
      outcome: OUTCOMES.MISCONFIGURED,
      reason: 'invalid-override',
      sharedPath: sp,
      override: { source: resolution.source, value: resolution.value },
      message:
        `Explicit override via ${resolution.source === 'env' ? 'CLAUDE_AUDIT_LOOP_DIR' : '--source-repo'} ` +
        `points at "${resolution.value}", but that directory is not a source repo ` +
        `(missing scripts/sync-to-repos.mjs sentinel). Fix the path or unset the override.\n`,
    };
  }
  // R1-audit H4/H7: ambiguous sibling scan → refuse to pick.
  if (resolution.type === 'ambiguous') {
    return {
      outcome: OUTCOMES.MISCONFIGURED,
      reason: 'ambiguous-source-repo',
      sharedPath: sp,
      candidates: resolution.candidates,
      message:
        `Multiple source-repo candidates found in sibling dirs:\n` +
        resolution.candidates.map(c => `  - ${c}`).join('\n') +
        `\nDisambiguate by setting CLAUDE_AUDIT_LOOP_DIR=<path> or passing --source-repo <path>.\n`,
    };
  }
  // type === 'resolved' falls through.
  const sourcePath = path.join(resolution.path, '.env');
  if (!fs.existsSync(sourcePath)) {
    return {
      outcome: OUTCOMES.MISCONFIGURED,
      reason: 'source-env-missing',
      sharedPath: sp, sourcePath, resolution,
      message: `Source repo at ${resolution.path} has no .env file. Set up the source repo first.\n`,
    };
  }
  const sourceParsed = parseEnvFile(sourcePath);
  const missingRequired = REQUIRED_VARS.filter(k => !sourceParsed[k]);
  if (missingRequired.length > 0) {
    return {
      outcome: OUTCOMES.MISCONFIGURED,
      reason: 'source-missing-required',
      sharedPath: sp, sourcePath, resolution, missingRequired,
      message:
        `Source repo .env (${sourcePath}) is missing required var(s): ` +
        `${missingRequired.join(', ')}. Set them in the source repo .env before running setup:cloud.\n`,
    };
  }

  const deltas = diffSharedEnv({ sharedPath: sp, sourcePath });
  const totalChanges = Object.keys(deltas.add).length
                      + Object.keys(deltas.change).length
                      + Object.keys(deltas.remove).length;
  if (totalChanges === 0) {
    return { outcome: OUTCOMES.ALREADY_CURRENT, sharedPath: sp, sourcePath, resolution, deltas };
  }
  return {
    outcome: fs.existsSync(sp) ? OUTCOMES.UPDATED : OUTCOMES.CREATED,
    proposed: true,
    sharedPath: sp, sourcePath, resolution, deltas,
  };
}

// ── Renderers ──────────────────────────────────────────────────────────────

function maskDsn(v) {
  return typeof v === 'string' ? v.replace(/:[^:@\s/]+@/, ':***@') : v;
}

export function formatDeltaPreview(deltas) {
  const lines = [];
  for (const [k, v] of Object.entries(deltas.add)) {
    lines.push(`  + ${k}=${k === 'AUDIT_DB_URL' ? maskDsn(v) : '***'}  (new)`);
  }
  for (const [k, { from, to }] of Object.entries(deltas.change)) {
    const f = k === 'AUDIT_DB_URL' ? maskDsn(from) : '***';
    const t = k === 'AUDIT_DB_URL' ? maskDsn(to)   : '***';
    lines.push(`  ~ ${k}: ${f} → ${t}`);
  }
  for (const k of Object.keys(deltas.remove)) {
    lines.push(`  - ${k}  (revoked in source)`);
  }
  return lines.join('\n');
}

// ── Executor (CLI + sync trigger both call this) ───────────────────────────

export async function runSetupCloud({
  prompt,
  dryRun        = false,
  autoYes       = false,
  sourceRepoDir = null,
  explicitFlag  = null,
  stdio         = process.stderr,
  homedir       = undefined,
  format        = 'human',
} = {}) {
  if (!autoYes && !prompt) {
    throw new Error('runSetupCloud: prompt is required unless autoYes:true');
  }
  const assessment = assessSharedCloudConfig({ sourceRepoDir, homedir, explicitFlag });

  if (assessment.outcome === OUTCOMES.MISCONFIGURED ||
      assessment.outcome === OUTCOMES.ALREADY_CURRENT) {
    return emitResult(assessment, { format, stdio });
  }

  if (!autoYes) {
    const verb = assessment.outcome === OUTCOMES.CREATED ? 'Create' : 'Update';
    const ok = await prompt(
      `${verb} ${assessment.sharedPath}?\n${formatDeltaPreview(assessment.deltas)}\n(Y/n) `
    );
    if (!ok) {
      return emitResult({ ...assessment, outcome: OUTCOMES.USER_SKIPPED }, { format, stdio });
    }
  }
  if (dryRun) {
    return emitResult({ ...assessment, dryRun: true }, { format, stdio });
  }

  const desired = {};
  for (const k of Object.keys(assessment.deltas.unchanged)) desired[k] = assessment.deltas.unchanged[k];
  for (const k of Object.keys(assessment.deltas.add))       desired[k] = assessment.deltas.add[k];
  for (const k of Object.keys(assessment.deltas.change))    desired[k] = assessment.deltas.change[k].to;
  writeSharedEnv(assessment.sharedPath, desired);

  return emitResult(assessment, { format, stdio });
}

// Dogfooding finding (post-/ship 2026-05-23): the JSON renderer was
// emitting cleartext secret values from the `add` / `change` buckets,
// defeating the chmod 0600 design. Mask the same way `formatDeltaPreview`
// does — AUDIT_DB_URL keeps its host/port (masked password) for
// diagnostic value; all other SHARED_VARS render as `***`.
function maskDeltasForOutput(deltas) {
  if (!deltas) return deltas;
  const m = { add: {}, change: {}, remove: { ...deltas.remove }, unchanged: { ...deltas.unchanged } };
  for (const [k, v] of Object.entries(deltas.add)) {
    m.add[k] = k === 'AUDIT_DB_URL' ? maskDsn(v) : '***';
  }
  for (const [k, { from, to }] of Object.entries(deltas.change)) {
    m.change[k] = {
      from: k === 'AUDIT_DB_URL' ? maskDsn(from) : '***',
      to:   k === 'AUDIT_DB_URL' ? maskDsn(to)   : '***',
    };
  }
  // `unchanged` is operator-controlled data we read back from the file;
  // mask the same way for consistency (a value being "unchanged" is itself
  // information, but the raw secret in stdout is the leak we're closing).
  for (const k of Object.keys(deltas.unchanged)) {
    m.unchanged[k] = k === 'AUDIT_DB_URL' ? maskDsn(deltas.unchanged[k]) : '***';
  }
  return m;
}

function emitResult(assessment, { format, stdio }) {
  const result = { ...assessment, exitCode: EXIT_CODE_FOR[assessment.outcome] };
  if (format === 'json') {
    // JSON output is contractual; goes to stdout regardless of stdio injection.
    // Mask secret values — the JSON output is for machine introspection
    // ("did the assessment succeed? what bucket is each key in?"), NOT for
    // exfiltrating the raw secrets which the operator already has in .env.
    const safe = { ...result, deltas: maskDeltasForOutput(result.deltas) };
    process.stdout.write(JSON.stringify(safe, null, 2) + '\n');
  } else {
    renderHumanResult(result, stdio);
  }
  return result;
}

function renderHumanResult(r, stdio) {
  if (r.outcome === OUTCOMES.MISCONFIGURED) { stdio.write(r.message); return; }
  if (r.outcome === OUTCOMES.ALREADY_CURRENT) {
    stdio.write(`shared cloud config: ${r.sharedPath} — in sync with source repo .env\n`);
    return;
  }
  if (r.outcome === OUTCOMES.USER_SKIPPED) { stdio.write('Skipped.\n'); return; }
  if (r.dryRun) {
    stdio.write(
      `(dry-run) would ${r.outcome === OUTCOMES.CREATED ? 'create' : 'update'} ${r.sharedPath}:\n` +
      `${formatDeltaPreview(r.deltas)}\n`
    );
    return;
  }
  stdio.write(`${r.outcome === OUTCOMES.CREATED ? 'Created' : 'Updated'} ${r.sharedPath} (mode 0600).\n`);
  if (process.platform === 'win32') {
    stdio.write(
      '[setup:cloud] note: chmod is a no-op on Windows; file permissions inherit from %USERPROFILE%\n'
    );
  }
  if (r.outcome === OUTCOMES.CREATED) {
    stdio.write(
      'Consumer repos will now inherit these on next run. ' +
      'Run `npm run arch:refresh` to populate the symbol index.\n'
    );
  }
}

// Test-only — match the project's _internals export pattern.
export const _internals = Object.freeze({
  isSourceRepo,
  maskDsn,
  maskDeltasForOutput,
  emitResult,
  renderHumanResult,
});
