#!/usr/bin/env node
/**
 * @fileoverview /visual-audit — the visual/paint inspection lens (4th UX lens).
 * Math-first, deterministic visual-contract auditor. Orchestrator only; all logic
 * lives in scripts/lib/visual/*. Mirrors scripts/nav-audit.mjs control flow.
 *
 * Modes:
 *   visual-audit [--scope diff|full]            static map + source-coherence (no browser)
 *   visual-audit --bootstrap [--from-url <url>] emit a review-queue visual-contract.json
 *   visual-audit --verify <url> [...]           live computed-style reconcile + findings
 *   visual-audit --verify <url> --gate          drift-only CI exit on the changed surface
 *
 * Exit codes: 0 clean/advisory · 1 gate-blocking divergence (with --gate) · 2 tool
 * error · 3 needs-bootstrap (no contract).
 *
 * @module scripts/visual-audit
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { writeOutput } from './lib/file-io.mjs';
import { getPreset, parseDevicesFlag } from './lib/device-presets.mjs';
import {
  VISUAL_TOOL_VERSION, computeContractDigest, computeConfigDigest,
} from './lib/visual/schema.mjs';
import { readContract, writeContract, bootstrapContract, contractExists } from './lib/visual/contract.mjs';
import { extractAllowedSet } from './lib/visual/tokens.mjs';
import { runSourceCoherence } from './lib/visual/source-coherence.mjs';
import { runExtract } from './lib/visual/extract.mjs';
import { assembleLiveFindings } from './lib/visual/findings.mjs';
import { partitionFindings, scopeToChanged } from './lib/visual/drift.mjs';
import { writeObservedEnvelope, writeVerifyResult } from './lib/visual/store.mjs';
import { renderHuman, buildJson, buildScorecard } from './lib/visual/render.mjs';

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const root = args.root || process.cwd();

  // ── Bootstrap ──
  if (args.bootstrap) {
    const draft = bootstrapContract({ surfaceSelectors: args.fromUrl ? ['main'] : [] });
    const res = writeContract(root, draft, { force: args.force });
    if (!res.ok) { process.stderr.write(`  [visual-audit] ${res.error}\n`); process.exit(2); }
    process.stderr.write(`  [visual-audit] wrote review-queue ${res.path} — fill sourceGlobs/tokenSources/themes, then remove _note\n`);
    process.exit(0);
  }

  // ── Read contract ──
  const { contract, present, error } = readContract(root);
  if (error) { process.stderr.write(`  [visual-audit] ${error}\n`); process.exit(2); }
  if (!present) {
    process.stderr.write('  [visual-audit] no visual-contract.json — run `node scripts/visual-audit.mjs --bootstrap`\n');
    process.exit(3);
  }

  const contractDigest = computeContractDigest(contract);

  // ── Static layer (token extraction + coherence) — always runs ──
  const { allowedSet, tokenIndex, warnings: tokenWarnings } = await extractAllowedSet(root, contract);
  const usageCorpus = readUsageCorpus(root, contract);
  const diagnostics = runSourceCoherence({ tokenIndex, usageCorpus, duplicateWarnings: tokenWarnings });

  const envelope = {
    version: VISUAL_TOOL_VERSION,
    refreshId: `vis-${gitHeadSha(root) || 'local'}`,
    configDigest: computeConfigDigest({ contractDigest }),
    headSha: gitHeadSha(root),
    generatedAt: gitHeadDate(root) || new Date(0).toISOString().replace('Z', '+00:00'),
    allowedSet,
    surfaces: (contract.surfaces || []).map((s) => ({ id: s.id, sourceGlobs: s.sourceGlobs || [] })),
    diagnostics,
  };
  const envRes = writeObservedEnvelope(root, envelope);
  if (!envRes.ok) process.stderr.write(`  [visual-audit] envelope: ${envRes.error}\n`);

  // ── Static mode (no --verify) ──
  if (!args.verify) {
    const out = buildJson({ staticMode: true, url: null, findings: [], diagnostics, scorecard: [], unverifiableSurfaces: [], statesCollected: [], warnings: tokenWarnings, gateBlockers: 0 });
    emit(args, out, renderHuman({ staticMode: true, diagnostics }));
    process.exit(0);
  }

  // ── Verify mode ──
  const devices = resolveDevices(args.devices);
  const themeNames = args.themes ? args.themes.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const ext = await runExtract({ url: args.verify, contract, devices, themeNames, storageState: args.storageState, timeoutMs: args.timeoutMs });
  if (!ext.ok) { process.stderr.write(`  [visual-audit] extract failed (${ext.code}): ${ext.reason}\n`); process.exit(2); }

  const findings = assembleLiveFindings({ perState: ext.perState, allowedSet, tokenIndex, contract });

  // Gate scope (only meaningful with --gate).
  const { gateEligible } = partitionFindings(findings);
  let gateBlockers = 0;
  if (args.gate) {
    const changedPaths = args.scope === 'full' ? null : gitChangedFiles(root);
    const contractChanged = changedPaths ? [...changedPaths].some((p) => p.endsWith('visual-contract.json')) : false;
    const changedTokenFamilies = tokenSourceFamiliesChanged(contract, changedPaths);
    const blockers = scopeToChanged(gateEligible, {
      changedPaths: changedPaths ? [...changedPaths] : (args.scope === 'full' ? null : changedPaths),
      contractChanged,
      changedTokenFamilies,
      surfaces: contract.surfaces || [],
      globalStyleGlobs: contract.globalStyleGlobs || [],
    });
    gateBlockers = blockers.length;
  }

  const statesCollected = ext.perState.map((s) => `${s.device}/${s.theme}`);
  const scorecard = buildScorecard(contract.surfaces, findings, ext.unverifiableSurfaces);
  const verifyResult = {
    version: 1,
    url: args.verify,
    generatedAt: gitHeadDate(root) || new Date(0).toISOString().replace('Z', '+00:00'),
    contractDigest,
    statesRequested: devices.flatMap((d) => (themeNames || (contract.themes || []).map((t) => t.name) || ['default']).map((t) => `${d.name}/${t}`)),
    statesCollected,
    unverifiableSurfaces: ext.unverifiableSurfaces,
    findings,
    warnings: ext.warnings,
  };
  const vrRes = writeVerifyResult(root, verifyResult);
  if (!vrRes.ok) process.stderr.write(`  [visual-audit] verify-result: ${vrRes.error}\n`);

  const out = buildJson({ staticMode: false, url: args.verify, findings, diagnostics, scorecard, unverifiableSurfaces: ext.unverifiableSurfaces, statesCollected, warnings: ext.warnings, gateBlockers });
  emit(args, out, renderHuman({ staticMode: false, url: args.verify, findings, scorecard, unverifiableSurfaces: ext.unverifiableSurfaces, statesCollected, warnings: ext.warnings, gateBlockers }));

  if (args.gate && gateBlockers > 0) process.exit(1);
  process.exit(0);
}

// ── helpers ──

function parseArgs(argv) {
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const verifyIdx = argv.indexOf('--verify');
  return {
    bootstrap: argv.includes('--bootstrap'),
    fromUrl: get('--from-url'),
    force: argv.includes('--force'),
    verify: verifyIdx >= 0 ? argv[verifyIdx + 1] : null,
    scope: get('--scope') || 'diff',
    gate: argv.includes('--gate'),
    devices: get('--device') || get('--devices') || 'desktop,mobile',
    themes: get('--theme') || get('--themes'),
    storageState: get('--storage-state'),
    timeoutMs: parseInt(get('--timeout') || '30000', 10),
    explain: argv.includes('--explain'),
    allowScreenshot: argv.includes('--allow-external-screenshot'),
    out: get('--out'),
    format: get('--format') || 'human',
    root: get('--root'),
  };
}

function resolveDevices(spec) {
  const names = parseDevicesFlag(spec) || spec.split(',').map((s) => s.trim()).filter(Boolean);
  return names.map((n) => {
    const p = getPreset(n);
    return { name: p.name, viewport: p.viewport, deviceScaleFactor: p.deviceScaleFactor, isMobile: p.isMobile, hasTouch: p.hasTouch, userAgent: p.userAgent };
  });
}

function emit(args, jsonOut, humanOut) {
  if (args.out) { writeOutput(jsonOut, args.out, `visual-audit: ${jsonOut.findings.length} findings, ${jsonOut.gateBlockers} gate-blocking`); return; }
  if (args.format === 'json') { process.stdout.write(`${JSON.stringify(jsonOut, null, 2)}\n`); return; }
  process.stdout.write(`${humanOut}\n`);
}

/** Read the contracted-surface source + token-source files into one corpus for
 *  the source-coherence lint (defensive; missing files are skipped). */
function readUsageCorpus(root, contract) {
  let corpus = '';
  for (const ts of contract.tokenSources || []) {
    try { corpus += readFileSync(path.resolve(root, ts.path), 'utf-8'); } catch { /* skip */ }
  }
  return corpus;
}

function tokenSourceFamiliesChanged(contract, changedPaths) {
  if (!changedPaths) return [];
  const changed = changedPaths instanceof Set ? changedPaths : new Set(changedPaths);
  const fams = new Set();
  for (const ts of contract.tokenSources || []) {
    if ([...changed].some((p) => p.endsWith(ts.path) || p.includes(ts.path))) {
      for (const f of ts.families || []) fams.add(f);
    }
  }
  return [...fams];
}

const GIT_OPTS = { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] };

function gitChangedFiles(root) {
  try {
    const def = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'origin/HEAD'], GIT_OPTS).trim() || 'origin/main';
    const base = execFileSync('git', ['-C', root, 'merge-base', def, 'HEAD'], GIT_OPTS).trim();
    const out = execFileSync('git', ['-C', root, 'diff', '--name-only', base], GIT_OPTS);
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch { return null; } // no merge-base → never false-block
}

function gitHeadSha(root) {
  try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], GIT_OPTS).trim(); } catch { return null; }
}
function gitHeadDate(root) {
  try { return execFileSync('git', ['-C', root, 'show', '-s', '--format=%cI', 'HEAD'], GIT_OPTS).trim(); } catch { return null; }
}

main().catch((err) => { process.stderr.write(`  [visual-audit] fatal: ${err.stack || err.message}\n`); process.exit(2); });
