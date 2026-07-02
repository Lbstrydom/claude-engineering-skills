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
import { parseDevicesFlag } from './lib/device-presets.mjs';
import {
  VISUAL_TOOL_VERSION, computeContractDigest, computeConfigDigest, BASELINE_FILE,
} from './lib/visual/schema.mjs';
import { readContract, writeContract, bootstrapContract, contractExists } from './lib/visual/contract.mjs';
import { extractAllowedSet } from './lib/visual/tokens.mjs';
import { runSourceCoherence } from './lib/visual/source-coherence.mjs';
import { lintInteractiveColor } from './lib/visual/interactive-color-lint.mjs';
import { assessColorCoverage } from './lib/visual/unadapted-color.mjs';
import { assessParityCoverage, assessParityKeyAmbiguity, assessThemePairResolution } from './lib/visual/theme-parity.mjs';
import { runExtract } from './lib/visual/extract.mjs';
import { assembleLiveFindings } from './lib/visual/findings.mjs';
import { partitionFindings, scopeToChanged, divergenceKey, assessCaptureIntegrity, gateUnverifiedReason } from './lib/visual/drift.mjs';
import { writeObservedEnvelope, writeVerifyResult, readBaseline, writeBaseline } from './lib/visual/store.mjs';
import { renderHuman, buildJson, buildScorecard } from './lib/visual/render.mjs';

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const root = args.root || process.cwd();

  // Theme-safety v2 (plan decision 2): --full-dom is a verify-only capture flag.
  // A silent no-op without --verify would read as "full-DOM ran, found nothing".
  if (args.fullDom && !args.verify) {
    process.stderr.write('  [visual-audit] --full-dom requires --verify <url>: the full-DOM parity-delta sweep is a live capture; without --verify it would silently not run.\n');
    process.exit(2);
  }

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
  // Theme-safety PIECE 1a — deterministic, browser-free ADVISORY lint over the
  // contracted style sources ("styled the box, forgot the text"). Report-only.
  const themeSafetyFindings = lintInteractiveColor(readStyleSources(root, contract));

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
    // --gate / --update-baseline are paint-finding operations; static mode emits NO
    // paint findings, so honoring them would silently pass the gate / write an empty
    // baseline (looks-protected-but-isn't). Refuse rather than exit 0.
    if (args.gate || args.updateBaseline) {
      const flag = args.gate ? '--gate' : '--update-baseline';
      process.stderr.write(`  [visual-audit] ${flag} requires --verify <url>: static mode emits no paint findings, so ${flag} would ${args.gate ? 'pass without checking any paint' : 'write an empty baseline'}.\n`);
      process.exit(2);
    }
    // Static mode now emits the deterministic ADVISORY theme-safety lint (still no
    // paint findings, so the --gate refusal above is unchanged — plan decision 7).
    const out = buildJson({ staticMode: true, url: null, findings: themeSafetyFindings, diagnostics, scorecard: [], unverifiableSurfaces: [], statesCollected: [], warnings: tokenWarnings, gateBlockers: 0 });
    emit(args, out, renderHuman({ staticMode: true, diagnostics, findings: themeSafetyFindings }));
    process.exit(0);
  }

  // ── Verify mode ──
  const devices = resolveDevices(args.devices);
  const themeNames = args.themes ? args.themes.split(',').map((s) => s.trim()).filter(Boolean) : null;
  // --themes validation (audit B-R1-H2): the contract theme list is the single
  // source of truth. An unknown requested name must FAIL, not silently drop or
  // fall back to the synthetic default theme (a typo would flip the whole run
  // to a different capture matrix than the operator asked for).
  if (themeNames) {
    const declared = new Set((contract.themes || []).map((t) => t.name));
    const unknown = themeNames.filter((n) => !declared.has(n));
    if (unknown.length) {
      process.stderr.write(`  [visual-audit] --themes: unknown theme name(s) [${unknown.join(', ')}] — contract declares [${[...declared].join(', ') || 'none'}]. Refusing (a silent drop would capture a different matrix than requested).\n`);
      process.exit(2);
    }
  }
  const ext = await runExtract({ url: args.verify, contract, devices, themeNames, storageState: args.storageState, timeoutMs: args.timeoutMs, fullDom: args.fullDom, fullDomNodeBudget: args.fullDomNodeBudget });
  if (!ext.ok) { process.stderr.write(`  [visual-audit] extract failed (${ext.code}): ${ext.reason}\n`); process.exit(2); }
  // Capture honesty: zero states captured (every device×theme navigation failed —
  // e.g. the server is down → ERR_CONNECTION_REFUSED) is NOT a clean pass. A dead
  // server must never be indistinguishable from a clean audit (shakedown pass-3 #2).
  if (!ext.perState.length) {
    const why = (ext.warnings && ext.warnings.length) ? ext.warnings.join('; ') : 'navigation failed for all device×theme cells';
    process.stderr.write(`  [visual-audit] no states captured (${why}) — is ${args.verify} reachable? Reporting UNVERIFIED, not a clean pass.\n`);
    process.exit(2);
  }

  const liveFindings = assembleLiveFindings({ perState: ext.perState, allowedSet, tokenIndex, contract });
  // The static theme-safety lint is advisory in BOTH modes — include it here too.
  const findings = [...liveFindings, ...themeSafetyFindings];
  // Theme-safety PIECE 2 coverage honesty (plan decision 6): if form controls exist
  // but NONE yielded provenance evidence (CDP declarations), the unadapted-color check
  // saw nothing — surface it as a warning rather than a silent clean.
  // Decision 6 is realized as a per-CHECK `unverified` warning (not a whole-surface
  // flip) — a color-coverage miss must not mask the surface's valid token/contrast/
  // layout tiers. Non-silent: pushed to the output warnings AND stderr.
  for (const state of ext.perState) {
    const cov = assessColorCoverage(state.nodes || []);
    if (cov.eligible > 0 && cov.withEvidence === 0) {
      const msg = `theme-safety: ${cov.eligible} form control(s) in ${state.device}/${state.theme} had no provenance evidence — unadapted-color check UNVERIFIED for that state (not a clean pass)`;
      (ext.warnings ||= []).push(msg);
      process.stderr.write(`  [visual-audit] ${msg}\n`);
    }
  }

  // ── Theme-safety v2 honesty surfacing (audit R2-H1 / R3-H2 / R3-H3): the pure
  // assessors' non-ok states land in the verify result's warnings — machine-
  // readable, never just a log line, never a silent clean. Per-device, mirroring
  // findings.mjs's grouping. The parity-delta coverage runs ONLY when --full-dom
  // was requested (an unconditional check would falsely degrade contracted-only
  // runs on 1/3+-theme apps — arm-eval 1c388890).
  {
    const warn = (msg) => { (ext.warnings ||= []).push(msg); process.stderr.write(`  [visual-audit] ${msg}\n`); };
    // Partial capture matrix (audit B-R1-H1): a device×theme cell that failed to
    // capture shrinks every theme-pair tier to whatever DID capture — surfaced
    // per cell (machine-readable via ext.missingStates → warnings → verify
    // result). Under --gate a partial matrix is UNVERIFIED coverage → exit 2
    // below (a blocking gate must not claim a matrix it didn't capture).
    for (const m of ext.missingStates || []) {
      warn(`capture: ${m.device}/${m.theme} FAILED (${String(m.reason).slice(0, 120)}) — theme-pair tiers for ${m.device} are degraded to the captured subset (not a clean pass)`);
    }
    const byDevice = new Map();
    for (const state of ext.perState) {
      const m = byDevice.get(state.device) || { contracted: {}, fullDom: {}, stats: [] };
      m.contracted[state.theme] = (state.nodes || []).filter((n) => (n.scope ?? 'contracted') === 'contracted');
      m.fullDom[state.theme] = (state.nodes || []).filter((n) => n.scope === 'fullDom');
      if (state.captureStats) m.stats.push(state.captureStats);
      byDevice.set(state.device, m);
    }
    for (const [device, m] of byDevice) {
      // Contracted parity tier: unassessable pair resolution + join ambiguity.
      const res = assessThemePairResolution(m.contracted, contract);
      if (res.status === 'contract_capture_mismatch') {
        warn(`theme-parity: ${device}: contract declares themes [${res.declaredThemes.join(', ')}] but captured [${res.capturedThemes.join(', ')}] — theme parity UNVERIFIED for that device (capture/config mismatch, not a clean pass)`);
      } else if (res.status === 'single_theme' && res.declaredThemes.length >= 2) {
        // Two themes declared but only one captured for this device (a cell
        // failed) — parity for this device compared nothing (B-R1-H1).
        warn(`theme-parity: ${device}: only [${res.capturedThemes.join(', ')}] captured of declared [${res.declaredThemes.join(', ')}] — theme parity UNVERIFIED for that device (partial capture, not a clean pass)`);
      }
      const amb = assessParityKeyAmbiguity(m.contracted);
      if (amb.ambiguousKeys > 0) {
        warn(`theme-parity: ${device}: ${amb.ambiguousKeys} ambiguous node key(s) (${Object.entries(amb.byTheme).map(([t, n]) => `${t}:${n}`).join(', ')}) dropped from the parity join — those nodes are UNVERIFIED for parity`);
      }
      // Full-DOM parity-delta coverage (only when the sweep was requested).
      if (args.fullDom) {
        const cov = assessParityCoverage({ nodesByTheme: m.fullDom, contract, captureStatsByState: m.stats });
        if (cov.status === 'unverified') {
          warn(`parity-delta: ${device}: UNVERIFIED (${cov.reason}) — the full-DOM sweep assessed nothing for that device (not a clean pass)`);
        }
      }
    }
    for (const state of ext.perState) {
      if (state.captureStats?.truncated) {
        warn(`parity-delta: ${state.device}/${state.theme}: full-DOM sweep TRUNCATED at budget (${args.fullDomNodeBudget} emitted or visit ceiling) — coverage is partial, not exhaustive`);
      }
    }
    if (args.fullDom) {
      process.stderr.write('  [visual-audit] full-DOM contrast parity-delta ran (advisory — contrast_parity_delta findings never gate)\n');
    }
  }
  const { gateEligible } = partitionFindings(findings);

  // Capture integrity: a page can load yet every contracted surface stall (empty/
  // unverifiable) → zero findings → gate/baseline would treat "nothing checked" as
  // "nothing wrong" (dead-server honesty at surface granularity).
  const integrity = assessCaptureIntegrity((contract.surfaces || []).map((s) => s.id), ext.unverifiableSurfaces);

  // --update-baseline: snapshot ALL current gate-eligible findings as accepted, so a
  // noisy app can adopt a blocking gate that then fires only on NEW regressions.
  if (args.updateBaseline) {
    if (integrity.degraded) {
      process.stderr.write(`  [visual-audit] refusing --update-baseline: all ${integrity.total} contracted surface(s) are unverifiable (capture stall/empty) — snapshotting a degraded capture would record an empty/wrong baseline. Fix capture first.\n`);
      process.exit(2);
    }
    if (integrity.partial) process.stderr.write(`  [visual-audit] --update-baseline: ${integrity.total - integrity.verifiedCount} surface(s) unverifiable — baseline omits them (they'll block until re-captured).\n`);
    const n = writeBaseline(root, gateEligible.map(divergenceKey), gitHeadDate(root) || '');
    process.stderr.write(`  [visual-audit] baseline updated: ${n} accepted gate-eligible finding(s) → ${BASELINE_FILE}\n`);
  }

  // Gate scope (only meaningful with --gate).
  let gateBlockers = 0;
  if (args.gate) {
    const isFull = args.scope === 'full';
    // `--scope full` gates the WHOLE contracted surface (allSurfaces sentinel), NOT
    // changedPaths=null — null means "no merge-base, never block" and would silently
    // pass the whole-surface gate (gate-scope-full no-op fix).
    const changedPaths = isFull ? null : gitChangedFiles(root);
    // Gate honesty: a blocking gate that could not evaluate anything (no surfaces,
    // all surfaces unverifiable, or no merge-base in --scope diff) is UNVERIFIED →
    // exit 2, never a clean exit-0 pass. Mirrors the dead-server convention the
    // degraded branch already enforced; the no-surfaces / no-merge-base siblings
    // used to only WARN and fall through (silent false-green). Single source: the
    // pure gateUnverifiedReason helper (tested in tests/visual-drift.test.mjs).
    const unverified = gateUnverifiedReason({ integrity, isFull, changedPathsResolved: isFull || changedPaths != null });
    if (unverified) {
      process.stderr.write(`  [visual-audit] --gate: ${unverified}. UNVERIFIED, not a clean pass (exit 2).\n`);
      process.exit(2);
    }
    // Partial capture matrix under a BLOCKING gate (audit B-R1-H1): a gate that
    // could not capture every requested device×theme cell cannot claim the
    // theme-pair tiers it is gating — required-cell loss is exit 2, not a warn.
    if ((ext.missingStates || []).length > 0) {
      process.stderr.write(`  [visual-audit] --gate: ${ext.missingStates.length} device×theme cell(s) failed to capture (${ext.missingStates.map((m) => `${m.device}/${m.theme}`).join(', ')}) — gate coverage is partial. UNVERIFIED, not a clean pass (exit 2).\n`);
      process.exit(2);
    }
    if (integrity.partial) process.stderr.write(`  [visual-audit] --gate: ${integrity.total - integrity.verifiedCount} surface(s) unverifiable — gate covers only the ${integrity.verifiedCount} verified surface(s).\n`);
    const contractChanged = changedPaths ? [...changedPaths].some((p) => p.endsWith('visual-contract.json')) : false;
    const changedTokenFamilies = tokenSourceFamiliesChanged(contract, changedPaths);
    let blockers = scopeToChanged(gateEligible, {
      allSurfaces: isFull,
      changedPaths: changedPaths ? [...changedPaths] : null,
      contractChanged,
      changedTokenFamilies,
      surfaces: contract.surfaces || [],
      globalStyleGlobs: contract.globalStyleGlobs || [],
    });
    // Novelty ratchet: block only on findings NOT in the committed baseline, so the
    // gate fires on new regressions rather than pre-existing defensible findings.
    const baseline = readBaseline(root);
    if (baseline) blockers = blockers.filter((b) => !baseline.has(divergenceKey(b)));
    else if (blockers.length) {
      process.stderr.write(`  [visual-audit] no ${BASELINE_FILE} — gate blocks on ALL ${blockers.length} changed-surface finding(s). Run with --update-baseline to accept today's findings and block only on new ones.\n`);
    }
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
    fullDom: argv.includes('--full-dom'),
    fullDomNodeBudget: parseInt(get('--full-dom-node-budget') || '4000', 10),
    scope: get('--scope') || 'diff',
    gate: argv.includes('--gate'),
    updateBaseline: argv.includes('--update-baseline'),
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
  // parseDevicesFlag already resolves each name to a full preset OBJECT (via
  // getPreset) and dedupes — do NOT re-resolve here (that passed an object back to
  // getPreset → "Unknown device preset [object Object]"; the matrix path was broken).
  const presets = parseDevicesFlag(spec);
  return presets.map((p) => ({
    name: p.name, viewport: p.viewport, deviceScaleFactor: p.deviceScaleFactor,
    isMobile: p.isMobile, hasTouch: p.hasTouch, userAgent: p.userAgent,
  }));
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

/** Per-file style-source records for the theme-safety static lint (file attribution).
 *  Reads tokenSources + globalStyleGlobs' declared paths; unreadable files are skipped. */
function readStyleSources(root, contract) {
  const out = [];
  const seen = new Set();
  const paths = [
    ...(contract.tokenSources || []).map((ts) => ts.path),
    ...(contract.globalStyleGlobs || []),
  ].filter((p) => typeof p === 'string' && !/[*?[\]{}]/.test(p)); // literal paths only (globs skipped in v1)
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    try { out.push({ path: p, content: readFileSync(path.resolve(root, p), 'utf-8') }); } catch { /* skip unreadable */ }
  }
  return out;
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
