#!/usr/bin/env node
/**
 * @fileoverview Single verifier for the engineering-skills isolation contract.
 *
 * Consolidates every migration acceptance gate from plan §9 into one CLI.
 * Operators run this from the CONSUMER side after sync; it reads the
 * consumer's manifest as the source of truth and never scans the source
 * repo's filesystem (plan Gemini v2 G2 fix).
 *
 * Gates (each runnable independently via --gates 1,2A,2B,3,4,5,6,7):
 *   1   Pre-migration git status / approval contract (read-only inspection)
 *   2A  Tracked-diff whitelist
 *   2B  Hydration-on-disk manifest hash check
 *   3   No-stale-path verification (ownership-aware)
 *   4   Fresh-clone executable contract (CLI smoke + library import test)
 *   5   Consumer package.json npm-run reconciliation
 *   6   Manifest layout === 'isolated'
 *   7   .gitignore managed block presence + well-formedness
 *
 * @module scripts/lib/sync-isolation-verify
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildOwnedSourceTailsFromConsumerManifest, COMMAND_REGEX as SHARED_COMMAND_REGEX } from './sync-rewriter.mjs';
import { parseGitignoreState } from './sync-gitignore.mjs';
import { LAYOUT_CONSTANTS } from './sync-path-map.mjs';
import { SyncManifestSchema } from './sync-manifest.mjs';
import { enumerateNpmRunRefs } from './npm-script-enumerator.mjs';

// NOTE: this module intentionally does NOT import sync-inventory.mjs.
// Inventory is source-only (depends on consumer-repos.mjs which uses
// path resolution relative to the source repo's parent). The
// `--selfcheck-inventory` source-side smoke now lives in
// `scripts/check-isolation-inventory.mjs` instead — that script is
// source-only and never shipped to consumers.

const ALL_GATES = ['1', '2A', '2B', '3', '4', '5', '6', '7'];
// Reuse the single source of truth from sync-rewriter — eliminates
// parser drift between rewrite and detect surfaces (R1 M1 fix).
const COMMAND_REGEX = SHARED_COMMAND_REGEX;

const CLI_SMOKE_SET = [
  'check-setup.mjs',
  'cross-skill.mjs',
  'cache-hitrate-check.mjs',
  'symbol-index/drift.mjs',
  'security-memory/refresh-incidents.mjs',
  'reconcile-repo-identity.mjs',
  'ux-lock-run.mjs', // WS2 deterministic /ux-lock runner
  'nav-audit.mjs',   // /nav-audit CLI orchestrator
  'visual-audit.mjs',// /visual-audit CLI orchestrator
  'setup-postgres.mjs', // layout-aware repo-root resolution — must survive the scripts/.claude-skills relocation
  'efficacy-lints-check.mjs', // GREEN≠REALIZED Cluster A CLI — relocation-sensitive lib import
  'model-eval-auditor.mjs', // model-swap-eval-harness Phase 3 auditor-role CLI
  'model-eval-adjudicator.mjs', // model-swap-eval-harness Phase 4 adjudicator-role CLI
  'tiered-shadow-report.mjs', // tiered-recall Close-out shadow-validation report — reads the consumer's own shadow log
];

const LIB_IMPORT_SET = [
  { rel: 'lib/redact.mjs', mustExport: ['redact', 'redactObject'] },
  { rel: 'lib/sync-path-map.mjs', mustExport: ['sourceRelToDestRel', 'destRelToSourceRel'] },
  { rel: 'lib/sync-rewriter.mjs', mustExport: ['rewriteCommandSurface'] },
  { rel: 'security-memory/incident-status.mjs', mustExport: ['classifyMitigation'] },
  { rel: 'lib/nav/extract.mjs', mustExport: ['extractEdges', 'readSources'] },
  { rel: 'lib/nav/model.mjs', mustExport: ['buildModel'] },
  { rel: 'lib/nav/findings.mjs', mustExport: ['runTaxonomy'] },
  { rel: 'lib/nav/drift.mjs', mustExport: ['partitionFindings', 'ageDivergences'] },
  { rel: 'lib/ux-lock/selector-policy.mjs', mustExport: ['scanSpecSource', 'classifySelector', 'resolveTestRoot'] },
];

const CMD_SCAN_PATHS = [
  '.claude/skills',
  '.claude/hooks',
  '.github/prompts',
  '.vscode',
  '.claude/settings.json',
];

function hashFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

function parseArgs(argv) {
  const out = {
    consumerRoot: process.cwd(),
    legacyManifest: null,
    gates: ALL_GATES,
    format: 'text',
    selfcheckInventory: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--consumer-root') out.consumerRoot = argv[++i];
    else if (a === '--legacy-manifest') out.legacyManifest = argv[++i];
    else if (a === '--gates') out.gates = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--format') out.format = argv[++i];
    else if (a === '--selfcheck-relocation') out.selfcheckRelocation = true;
    else if (a === '--selfcheck-inventory') out.selfcheckInventory = true;
  }
  return out;
}

function loadConsumerManifest(consumerRoot) {
  // M2 fix: validate the manifest shape via SyncManifestSchema before any
  // gate consumes its contents. Malformed `files` map, invalid hashes, or
  // unexpected layout values get reported as structured errors rather
  // than silently passing into gate logic.
  const p = path.join(consumerRoot, LAYOUT_CONSTANTS.MANIFEST_PATH);
  if (!fs.existsSync(p)) return { ok: false, error: `manifest missing at ${p}` };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    return { ok: false, error: `manifest parse failed: ${err.message}` };
  }
  const parsed = SyncManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
    return { ok: false, error: `manifest schema invalid:\n  ${issues.join('\n  ')}` };
  }
  return { ok: true, manifest: parsed.data, path: p };
}

function* walkDir(absDir) {
  if (!fs.existsSync(absDir)) return;
  const stack = [absDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    // Fail CLOSED: an unreadable command-bearing directory must abort the
    // walk, not be silently skipped — otherwise the relocation/command-surface
    // gates that consume this walk would pass while never having scanned the
    // directory (a false clean; the green-path-honesty rule).
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch (err) {
      throw new Error(`walkDir: cannot read directory ${cur} — verification aborted rather than silently skipping it (${err.message})`);
    }
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile()) yield abs;
    }
  }
}

function listCommandBearingFiles(consumerRoot) {
  const out = [];
  for (const rel of CMD_SCAN_PATHS) {
    const abs = path.join(consumerRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    if (stat.isFile()) out.push(abs);
    else if (stat.isDirectory()) for (const f of walkDir(abs)) out.push(f);
  }
  return out;
}

function relativize(consumerRoot, abs) {
  return path.relative(consumerRoot, abs).replace(/\\/g, '/');
}

// ── Gate implementations ────────────────────────────────────────────────────

function gate2A(consumerRoot, manifest) {
  // Tracked-diff whitelist: no scripts/.claude-skills/** in EITHER
  //   (a) `git status --porcelain` — uncommitted/staged entries, OR
  //   (b) `git ls-files -- scripts/.claude-skills` — files that have been
  //       silently committed (R2 M1 fix: clean tracked files don't appear
  //       in `git status` but they DO appear in `git ls-files`).
  const offenders = [];

  // Part A: status entries with -z parsing (M4 fix preserved).
  let porcelain;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain', '-z'], {
      cwd: consumerRoot,
      encoding: 'utf-8',
    });
  } catch (err) {
    return { gate: '2A', pass: false, error: `git status failed: ${err.message}` };
  }
  const records = porcelain.split('\0').filter(Boolean);
  let i = 0;
  while (i < records.length) {
    const r = records[i];
    if (r.length < 3) { i++; continue; }
    const xy = r.slice(0, 2);
    const relPath = r.slice(3);
    const isRename = xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C';
    if (relPath.startsWith('scripts/.claude-skills/')) offenders.push(relPath);
    i++;
    if (isRename) {
      if (i < records.length && records[i].startsWith('scripts/.claude-skills/')) {
        offenders.push(records[i]);
      }
      i++;
    }
  }

  // Part B: clean tracked files under the isolated tree (R2 M1 fix).
  try {
    const lsFiles = execFileSync(
      'git', ['ls-files', '--', 'scripts/.claude-skills'],
      { cwd: consumerRoot, encoding: 'utf-8' },
    );
    for (const line of lsFiles.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && trimmed.startsWith('scripts/.claude-skills/')) {
        offenders.push(`${trimmed} (committed-tracked)`);
      }
    }
  } catch (err) {
    return { gate: '2A', pass: false, error: `git ls-files failed: ${err.message}` };
  }

  if (offenders.length) {
    return {
      gate: '2A',
      pass: false,
      error: `scripts/.claude-skills/ entries appear in tracked git state (${offenders.length}). The tooling tree must be gitignored AND not committed.`,
      details: { offenders: offenders.slice(0, 50) },
    };
  }
  return { gate: '2A', pass: true };
}

function gate2B(consumerRoot, manifest) {
  // Hydration-on-disk hash check.
  //
  // R2 M3 fix: check the FULL set of manifest entries, not only those
  // under `scripts/.claude-skills/`. The manifest also governs
  // .claude/skills/, .claude/hooks/, .github/prompts/, .vscode/mcp.json
  // and .claude/settings.json — those files are written by sync too and
  // their hashes are recorded. Verifying only the isolated tree leaves
  // a coverage gap where a corrupted skill .md would pass the gate.
  const missing = [];
  const mismatched = [];
  for (const [destRel, expected] of Object.entries(manifest.files || {})) {
    // The manifest cannot record its own final hash: writing the self-entry
    // mutates the file, which changes the hash (chicken-and-egg). Skip it —
    // gate 2B verifies the files the manifest governs, not the manifest body.
    // Use the layout constant so this never drifts from the actual manifest path.
    if (destRel === LAYOUT_CONSTANTS.MANIFEST_PATH) continue;
    const abs = path.join(consumerRoot, destRel);
    if (!fs.existsSync(abs)) { missing.push(destRel); continue; }
    let actual;
    try { actual = hashFile(abs); } catch (err) { missing.push(destRel); continue; }
    if (actual !== expected) mismatched.push({ path: destRel, expected, actual });
  }
  if (missing.length || mismatched.length) {
    return {
      gate: '2B',
      pass: false,
      error: `${missing.length} missing + ${mismatched.length} hash-mismatched manifest entries.`,
      details: { missing: missing.slice(0, 50), mismatched: mismatched.slice(0, 50) },
    };
  }
  return { gate: '2B', pass: true };
}

function gate3(consumerRoot, manifest) {
  const ownedSourceTails = buildOwnedSourceTailsFromConsumerManifest(manifest);
  const files = listCommandBearingFiles(consumerRoot);
  const stale = [];
  for (const abs of files) {
    let content;
    // Fail CLOSED: an unreadable command-bearing file must abort the gate, not
    // be silently skipped — else a stale synced path hiding in it passes the
    // isolation check unverified (same fail-open class as the old walkDir).
    try { content = fs.readFileSync(abs, 'utf-8'); }
    catch (err) { throw new Error(`gate3: cannot read command-bearing file ${abs} — failing closed rather than skipping it unverified (${err.message})`); }
    let m;
    COMMAND_REGEX.lastIndex = 0;
    while ((m = COMMAND_REGEX.exec(content)) !== null) {
      const tail = m[1];
      if (tail.startsWith('.claude-skills/')) continue;
      if (!ownedSourceTails.has(tail)) continue;
      stale.push({ file: relativize(consumerRoot, abs), invocation: m[0] });
    }
  }
  if (stale.length) {
    return {
      gate: '3',
      pass: false,
      error: `${stale.length} stale ownership-confirmed paths in command-bearing files.`,
      details: { stale: stale.slice(0, 50) },
    };
  }
  return { gate: '3', pass: true };
}

function gate4(consumerRoot) {
  const failures = [];
  const TOOL_DIR = LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR;
  for (const rel of CLI_SMOKE_SET) {
    const abs = path.join(consumerRoot, TOOL_DIR, rel);
    if (!fs.existsSync(abs)) {
      failures.push({ kind: 'cli-missing', rel, path: abs });
      continue;
    }
    const result = spawnSync(process.execPath, [abs, '--selfcheck-relocation'], {
      cwd: consumerRoot,
      timeout: 30_000,
      encoding: 'utf-8',
    });
    if (result.error) {
      failures.push({ kind: 'cli-spawn-error', rel, message: result.error.message });
    } else if (result.status !== 0) {
      failures.push({ kind: 'cli-nonzero-exit', rel, status: result.status, stderr: (result.stderr || '').slice(0, 500) });
    }
  }
  // We can't `await import` synchronously from a sync gate runner without
  // making the whole verifier async; do that with a small sync workaround
  // by spawning a child to attempt the import.
  for (const { rel, mustExport } of LIB_IMPORT_SET) {
    const abs = path.join(consumerRoot, TOOL_DIR, rel);
    if (!fs.existsSync(abs)) {
      failures.push({ kind: 'lib-missing', rel, path: abs });
      continue;
    }
    // M5 fix: pass the target URL via process.argv to the probe child
    // process, eliminating JS source-string interpolation. The probe
    // body is static; only safe JSON literals from mustExport are
    // interpolated, and those are validated by the LIB_IMPORT_SET
    // schema, not from external input.
    const probeBody = `
      const target = process.argv[1];
      const required = ${JSON.stringify(mustExport)};
      import(target).then((mod) => {
        const missing = required.filter((k) => typeof mod[k] === 'undefined');
        if (missing.length) { console.error('missing:' + missing.join(',')); process.exit(2); }
        process.exit(0);
      }).catch((err) => { console.error('import-failed:' + err.message); process.exit(3); });
    `;
    const targetUrl = pathToFileURL(abs).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probeBody, targetUrl], {
      cwd: consumerRoot,
      timeout: 30_000,
      encoding: 'utf-8',
    });
    if (result.error) {
      failures.push({ kind: 'lib-spawn-error', rel, message: result.error.message });
    } else if (result.status !== 0) {
      failures.push({ kind: 'lib-import-failed', rel, status: result.status, stderr: (result.stderr || '').slice(0, 500) });
    }
  }
  if (failures.length) {
    return {
      gate: '4',
      pass: false,
      error: `${failures.length} relocation smoke failures.`,
      details: { failures },
    };
  }
  return { gate: '4', pass: true };
}

function gate5(consumerRoot, manifest) {
  const mdKeys = Object.keys(manifest.files || {}).filter((k) => k.endsWith('.md'));
  const allRefs = new Set();
  for (const k of mdKeys) {
    const abs = path.join(consumerRoot, k);
    if (!fs.existsSync(abs)) continue;
    let content;
    // Fail CLOSED (same rationale as gate3): a present-but-unreadable file
    // must not be silently skipped from the npm-ref reconciliation.
    try { content = fs.readFileSync(abs, 'utf-8'); }
    catch (err) { throw new Error(`npm-ref scan: cannot read ${abs} — failing closed (${err.message})`); }
    for (const r of enumerateNpmRunRefs(content)) allRefs.add(r);
  }

  const pkgPath = path.join(consumerRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    // No package.json — nothing for us to reconcile against; pass silently.
    return { gate: '5', pass: true, details: { skipped: 'no package.json' } };
  }
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); }
  catch (err) {
    return { gate: '5', pass: false, error: `package.json parse failed: ${err.message}` };
  }
  const scripts = pkg.scripts || {};
  const stale = [];
  for (const ref of allRefs) {
    const body = scripts[ref];
    if (!body) continue; // script doesn't exist in consumer; informational only
    // Look for `node scripts/X` where X is NOT under .claude-skills/.
    let m;
    COMMAND_REGEX.lastIndex = 0;
    while ((m = COMMAND_REGEX.exec(body)) !== null) {
      const tail = m[1];
      if (tail.startsWith('.claude-skills/')) continue;
      stale.push({ npmScript: ref, body, staleInvocation: m[0] });
    }
  }
  if (stale.length) {
    return {
      gate: '5',
      pass: false,
      error: `${stale.length} stale node-scripts/ invocation(s) in consumer package.json scripts referenced by synced skills.`,
      details: { stale },
    };
  }
  return { gate: '5', pass: true };
}

function gate6(manifest) {
  if (manifest.layout === 'isolated') return { gate: '6', pass: true };
  return {
    gate: '6',
    pass: false,
    error: `manifest.layout is "${manifest.layout || '<absent>'}"; expected "isolated".`,
  };
}

function gate7(consumerRoot) {
  const giPath = path.join(consumerRoot, '.gitignore');
  if (!fs.existsSync(giPath)) {
    return { gate: '7', pass: false, error: '.gitignore missing' };
  }
  const content = fs.readFileSync(giPath, 'utf-8');
  const state = parseGitignoreState(content);
  if (state.beginIndices.length === 1 && state.endIndices.length === 1 && state.orderValid) {
    return { gate: '7', pass: true };
  }
  return {
    gate: '7',
    pass: false,
    error: `managed block malformed: ${state.beginIndices.length} begin marker(s), ${state.endIndices.length} end marker(s), orderValid=${state.orderValid}`,
  };
}

function gate1(consumerRoot) {
  // Read-only — surfaces uncommitted state for the operator to decide on.
  // The actual approval is recorded out-of-band (AskUserQuestion in the
  // migration runner); this gate just reports.
  let porcelain;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: consumerRoot,
      encoding: 'utf-8',
    });
  } catch (err) {
    return { gate: '1', pass: false, error: `git status failed: ${err.message}` };
  }
  const lines = porcelain.split('\n').filter(Boolean);
  return { gate: '1', pass: true, details: { dirtyEntries: lines.length, lines: lines.slice(0, 50) } };
}

// ── Main ────────────────────────────────────────────────────────────────────

function runGates(opts) {
  const { consumerRoot, gates } = opts;
  const manifestRes = loadConsumerManifest(consumerRoot);
  const results = [];

  const needManifest = gates.some((g) => ['2A', '2B', '3', '5', '6'].includes(g));
  if (needManifest && !manifestRes.ok) {
    return [{ gate: 'preflight', pass: false, error: manifestRes.error }];
  }
  const manifest = manifestRes.ok ? manifestRes.manifest : null;

  for (const g of gates) {
    try {
      if (g === '1') results.push(gate1(consumerRoot));
      else if (g === '2A') results.push(gate2A(consumerRoot, manifest));
      else if (g === '2B') results.push(gate2B(consumerRoot, manifest));
      else if (g === '3') results.push(gate3(consumerRoot, manifest));
      else if (g === '4') results.push(gate4(consumerRoot));
      else if (g === '5') results.push(gate5(consumerRoot, manifest));
      else if (g === '6') results.push(gate6(manifest));
      else if (g === '7') results.push(gate7(consumerRoot));
      else results.push({ gate: g, pass: false, error: `unknown gate: ${g}` });
    } catch (err) {
      results.push({ gate: g, pass: false, error: `gate threw: ${err.message}` });
    }
  }
  return results;
}

function selfcheckInventoryNotAvailable() {
  process.stderr.write(
    '--selfcheck-inventory is source-side only. Run from the\n' +
    'claude-engineering-skills source repo: node scripts/check-isolation-inventory.mjs\n'
  );
  process.exit(2);
}

function formatText(results) {
  const lines = [];
  let allPass = true;
  for (const r of results) {
    if (r.pass) {
      lines.push(`  ✓ gate ${r.gate}`);
    } else {
      allPass = false;
      lines.push(`  ✗ gate ${r.gate}: ${r.error || '(no message)'}`);
      if (r.details) lines.push('     ' + JSON.stringify(r.details).slice(0, 400));
    }
  }
  return { text: lines.join('\n'), allPass };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.selfcheckRelocation) {
    console.log('OK');
    process.exit(0);
  }

  if (opts.selfcheckInventory) {
    selfcheckInventoryNotAvailable();
    return;
  }

  const results = runGates(opts);
  if (opts.format === 'json') {
    process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
  } else {
    const { text, allPass } = formatText(results);
    process.stdout.write(text + '\n');
  }
  const firstFail = results.find((r) => !r.pass);
  if (firstFail) {
    const code = firstFail.gate === 'preflight' ? 2 : (Number.isFinite(+firstFail.gate) ? +firstFail.gate : 1);
    process.exit(code || 1);
  }
  process.exit(0);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  main().catch((err) => {
    process.stderr.write(`[sync-isolation-verify] fatal: ${err?.message || err}\n`);
    process.exit(1);
  });
}

export const _internals = {
  CLI_SMOKE_SET, LIB_IMPORT_SET, CMD_SCAN_PATHS, COMMAND_REGEX,
  parseArgs, gate1, gate2A, gate2B, gate3, gate4, gate5, gate6, gate7,
  runGates,
};
