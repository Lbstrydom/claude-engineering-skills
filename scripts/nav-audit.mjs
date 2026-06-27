#!/usr/bin/env node
/**
 * @fileoverview /nav-audit CLI — static navigation / information-architecture
 * audit (plan §4a.E). Ties extract → model → findings → drift → render.
 *
 *   node scripts/nav-audit.mjs [--scope diff|full] [--bootstrap] [--verify <url>]
 *                              [--format human|json] [--gate] [--out <file>] [--root <dir>]
 *
 * Exit codes (mirror setup-postgres.mjs): 0 clean/advisory · 1 hard-gate
 * divergence (with --gate) · 2 tool error · 3 needs-bootstrap (no contract).
 *
 * @module scripts/nav-audit
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { writeOutput } from './lib/file-io.mjs';
import { readSources, extractEdges } from './lib/nav/extract.mjs';
import { readContract, parseNavMeta, bootstrapContract, writeContract, contractExists } from './lib/nav/contract.mjs';
import { draftContractFromLive, buildDraftCaptureWarning } from './lib/nav/bootstrap-draft.mjs';
import { buildModel } from './lib/nav/model.mjs';
import { runTaxonomy, runLiveTaxonomy, personaScorecard } from './lib/nav/findings.mjs';
import { partitionFindings, scopeToChanged, divergenceKey } from './lib/nav/drift.mjs';
import { renderFindings, renderLiveFindings, renderTable, renderMermaid, renderScorecard } from './lib/nav/render.mjs';
import { assembleEnvelope, writeObservedEnvelope } from './lib/nav/envelope.mjs';
import { computeContractDigest, NAV_VERIFY_TOOL_VERSION } from './lib/nav/schema.mjs';
import { runVerify } from './lib/nav/verify.mjs';
import { mapPersonasToIntents } from './lib/nav/persona-seed.mjs';
import { writeVerifyResult } from './lib/nav/verify-store.mjs';

async function main() {
  // CLI smoke contract — must prove imports survive relocation (AGENTS.md).
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const root = args.root || '.';

  let sourceFiles = [];
  let changedFiles = null;
  try {
    sourceFiles = listSourceFiles(root);
    if (args.scope === 'diff' && !args.verify) changedFiles = new Set(gitChangedFiles(root));
  } catch (err) {
    // Non-fatal: --bootstrap --from-url and --verify are live-driven and need no
    // local source/git. Static extraction simply yields nothing here.
    process.stderr.write(`[nav-audit] no git/source files (${err.message.split('\n')[0]}) — continuing (live modes don't need them).\n`);
  }

  // Read the contract early so its appRoots/exclude drive extraction.
  const { contract: earlyContract, present: earlyPresent, error: earlyError } = readContract(root);
  // A MALFORMED contract (present but unparseable) would otherwise be silently
  // treated as "no contract", producing a misleading contract-less scorecard.
  // Bootstrap can regenerate it (warn + proceed); every other mode FAILS so a
  // typo in the committed contract can't downgrade the run to exploratory.
  if (earlyPresent && earlyError && !earlyContract) {
    if (args.bootstrap) {
      process.stderr.write(`[nav-audit] ⚠ nav-contract.json present but invalid — ${earlyError}; bootstrap will draft a fresh one.\n`);
    } else {
      process.stderr.write(`[nav-audit] ✗ nav-contract.json is present but invalid — ${earlyError}. Fix it, or delete it for exploratory mode, then re-run.\n`);
      process.exit(2);
    }
  }
  const appRoots = earlyContract?.appRoots ?? [];

  const { sources } = readSources(root, sourceFiles, { exclude: earlyContract?.exclude ?? [] });
  const { edges, destinations, adapters, recall, warnings } = extractEdges(sources, { root, appRoots });

  // Bootstrap mode: emit a review-queue contract skeleton and stop.
  if (args.bootstrap) {
    // Refuse to clobber an existing contract without --force (the accidental-
    // overwrite incident — plan §2.4).
    if (contractExists(root) && !args.force) {
      process.stderr.write('[nav-audit] nav-contract.json already exists — refusing to overwrite. Pass --force to replace it.\n');
      process.exit(2);
    }
    // Optional: draft navLayers + observedTargets from the LIVE app.
    let draftNavLayers = null;
    let observedTargets = null;
    let emptyNavShells = [];
    const bootUrl = args.fromUrl || args.verify;
    if (bootUrl) {
      const model = buildModel(edges, { contract: null, sources, destinations });
      const report = await runVerify({ url: bootUrl, model, contract: null, breakpoints: args.breakpoints, storageState: args.storageState });
      if (!report.ok) {
        process.stderr.write(`[nav-audit] bootstrap --from-url limited mode — ${report.reason}\n`);
        process.exit(2);
      }
      const draft = draftContractFromLive(report.liveEvidence);
      draftNavLayers = draft.navLayers;
      observedTargets = draft.observedTargets;
      // Capture-honesty (field-test #3/#4): an auth-gated app renders its primary nav
      // only AFTER login, so a draft from an unauthenticated/empty shell silently
      // mis-picks the primary layer. An EMPTY visible nav container is the precise
      // fingerprint → specific warning (fires even WITH --storage-state, catching an
      // expired token); otherwise a generic "no auth state" warning. Draft is always a
      // HYPOTHESIS to review, never trusted.
      emptyNavShells = report.emptyNavShells || [];
      const warn = buildDraftCaptureWarning({ emptyNavShells, hasStorageState: Boolean(args.storageState) });
      if (warn) process.stderr.write(`[nav-audit] ⚠ ${warn}\n`);
    }
    // Seed personaIntents from REAL reachability evidence (the path personas walked
    // in /persona-test) when PERSONA_TEST_REPO_NAME is set. Any failure (cloud off,
    // reader error, no evidence) → no seeds, and bootstrap proceeds normally (R2-H2).
    const personaIntents = seedPersonaIntents(process.env.PERSONA_TEST_REPO_NAME, bootUrl);
    const { contract, inferredUtility } = bootstrapContract({ destinations: destinations.map((d) => d.id), personaIntents, draftNavLayers, observedTargets });
    const written = writeContract(root, contract);
    const payload = { ok: true, mode: 'bootstrap', written, inferredUtility, adapters, draftedFrom: bootUrl || null, navLayers: contract.navLayers, personaIntents: personaIntents.length, unauthenticatedDraft: Boolean(bootUrl && !args.storageState), emptyNavShells };
    const layerNote = draftNavLayers ? ` · drafted navLayers from ${bootUrl} (primary: ${draftNavLayers.primary.join(',') || '—'}; secondary: ${draftNavLayers.secondary.join(',') || '—'})` : '';
    writeOutput(payload, args.out, `[nav-audit] bootstrap → ${written}${layerNote}`);
    process.exit(0);
  }

  // --verify: drive the live app and reconcile against the static model. Works
  // with OR without a committed contract (exploratory) — intent reachability is
  // only checked when a contract is present.
  if (args.verify) {
    const model = buildModel(edges, { contract: earlyContract, sources, destinations });
    const report = await runVerify({
      url: args.verify, model, contract: earlyContract,
      breakpoints: args.breakpoints, storageState: args.storageState,
      activate: !args.noActivate,
    });
    // runVerify is a library fn — the CLI owns the exit code (plan §4a).
    if (!report.ok) {
      process.stderr.write(`[nav-audit] limited mode — ${report.reason}\n`);
      if (report.code === 'NO_PLAYWRIGHT' || report.code === 'NO_CHROMIUM') {
        process.stderr.write('  install the browser: npx playwright install chromium\n');
      }
      process.exit(2);
    }
    // Merge live evidence into the per-persona scorecard — the headline.
    const scorecard = personaScorecard(model, earlyContract, {
      liveAttribution: report.liveAttribution,
      statesRequested: report.statesRequested,
      statesCollected: report.statesCollected,
      unverifiableLayers: report.unverifiableLayers ?? [],   // v1.4 capture honesty
    });
    // Run the layer-attribution-dependent finding classes over LIVE evidence
    // (v1.3 #4) — competing-models / over-exposure / sequencing finally fire on
    // data-driven apps the static taxonomy can't model. source:'live' tagged.
    // Suppressed when a prominent layer couldn't be captured (v1.4 honesty).
    const liveFindings = runLiveTaxonomy(report.liveAttribution, earlyContract, {
      destinations: model.destinations, states: report.statesCollected,
      unverifiableLayers: report.unverifiableLayers ?? [],
    });
    if (args.storageState) process.stderr.write('[nav-audit] authenticated run (--storage-state) — live labels may include account text (redacted on persist).\n');
    // Persist the live result (gitignored, Category-A) so the dashboard can show
    // the authoritative live verdicts. Only when a contract is present (the digest
    // ties freshness to it). generatedAt is a real wall-clock event (volatile
    // artifact — the no-Date.now() rule is for committed deterministic paths).
    if (earlyContract) {
      try {
        writeVerifyResult(root, {
          version: 2, url: args.verify, generatedAt: new Date().toISOString(),
          contractDigest: computeContractDigest(earlyContract),
          toolVersion: NAV_VERIFY_TOOL_VERSION,
          statesRequested: report.statesRequested, statesCollected: report.statesCollected,
          liveAttribution: report.liveAttribution,
          liveFindings,
          unverifiableLayers: report.unverifiableLayers ?? [],
        });
      } catch (err) { process.stderr.write(`[nav-audit] verify-result persist skipped: ${err.message}\n`); }
    }
    const out = { ...report, scorecard, liveFindings };
    if (args.format === 'json') {
      writeOutput(out, args.out, `[nav-audit] verify (${report.statesCollected.join('+')}): ${report.confirmed.length} confirmed, ${report.staticOnly.length} static-only, ${report.runtimeOnly.length} runtime-only`);
    } else {
      const lines = [
        renderScorecard(scorecard), '',
        `NAV VERIFY — ${report.url}  (states: ${report.statesCollected.join(', ')})`, '─'.repeat(48),
        `Live nav occurrences: ${report.liveNavCount}`,
        `✓ Confirmed (static ∩ live):   ${report.confirmed.join(', ') || '—'}`,
        `△ Static-only (not in live nav): ${report.staticOnly.join(', ') || '—'}`,
        `● Runtime-only (live, not static): ${report.runtimeOnly.join(', ') || '—'}`,
        ...(report.stateWarnings?.length ? ['', `⚠ ${report.stateWarnings.join(' · ')}`] : []),
        ...(liveFindings.length ? [renderLiveFindings(liveFindings)] : []),
      ];
      if (args.out) writeOutput(out, args.out, lines.join('\n')); else process.stdout.write(lines.join('\n') + '\n');
    }
    process.exit(0);
  }

  // Normal audit path requires a committed contract.
  const { contract, present, error } = readContract(root);
  if (error) { process.stderr.write(`[nav-audit] ${error}\n`); process.exit(2); }
  if (!present) {
    process.stderr.write('[nav-audit] no nav-contract.json — run `node scripts/nav-audit.mjs --bootstrap` first.\n');
    process.exit(3);
  }

  // Colocated route-owned metadata (navMeta / @nav docblocks) → routeMeta map.
  const routeMeta = collectRouteMeta(sources, destinations);

  const model = buildModel(edges, { contract, sources, destinations });
  const findings = runTaxonomy(model, { contract, routeMeta });
  const { gateEligible, advisory } = partitionFindings(findings);
  const blocking = scopeToChanged(gateEligible, changedFiles, { contractChanged: changedFiles?.has('nav-contract.json') });

  // Persist the observed envelope (gitignored Category-A artifact).
  try {
    const envelope = assembleEnvelope({
      refreshId: `nav-${gitHeadSha(root) || 'local'}`,
      contractDigest: computeContractDigest(contract),
      headSha: gitHeadSha(root),
      generatedAt: gitHeadDate(root) || new Date(0).toISOString(),
      edges,
      destinations,
      recall,
    });
    writeObservedEnvelope(root, envelope);
  } catch (err) {
    process.stderr.write(`[nav-audit] envelope write skipped: ${err.message}\n`);
  }

  // Per-persona reachability scorecard — the headline feature; ALWAYS surfaced
  // (was previously dashboard-only — feedback #7).
  const scorecard = personaScorecard(model, contract);

  const result = {
    ok: true,
    scope: args.scope,
    adapters,
    recall,
    warnings,
    findingCounts: countBySeverity(findings),
    findings,
    scorecard,
    blockingDivergences: blocking.map(divergenceKey),
  };

  if (args.format === 'json') {
    writeOutput(result, args.out, `[nav-audit] ${findings.length} findings (${blocking.length} gate-eligible on changed surface)`);
  } else {
    const out = [
      renderScorecard(scorecard), '',
      renderFindings(findings), '',
      renderTable(model), '',
      renderMermaid(model),
      '', `Adapters: ${adapters.join(', ') || 'none'} · recall: ${recall.extracted} edges (${recall.lowConfidence} low-conf, ${recall.opaque} opaque)`,
    ].join('\n');
    if (args.out) writeOutput(result, args.out, out); else process.stdout.write(out + '\n');
  }

  // Gate: hard-fail only with --gate AND a gate-eligible divergence on the changed
  // surface. Clarify the advisory-vs-blocking distinction so the message can't read
  // as a contradiction (feedback #8).
  const gateEligibleTotal = gateEligible.length;
  if (args.gate) {
    if (blocking.length > 0) {
      process.stderr.write(`[nav-audit] GATE FAIL: ${blocking.length} declared-intent divergence(s) ON THE CHANGED SURFACE — ${blocking.map(divergenceKey).join(', ')}\n`);
      process.exit(1);
    }
    process.stderr.write(`[nav-audit] GATE PASS: ${gateEligibleTotal} gate-eligible finding(s) total, 0 on the changed surface (advisory only).\n`);
  } else if (gateEligibleTotal > 0) {
    process.stderr.write(`[nav-audit] ${gateEligibleTotal} gate-eligible finding(s) — advisory (run with --gate to block on changed-surface regressions).\n`);
  }
  process.exit(0);
}

function collectRouteMeta(sources, destinations) {
  const meta = new Map();
  const destSet = new Set(destinations.map((d) => d.id));
  for (const s of sources) {
    const claims = parseNavMeta(s.content, s.path);
    if (!claims.length) continue;
    // Bind module-scope claims to the file's single discovered destination if
    // unambiguous (plan §4a.G). Conservative: only bind when exactly one dest
    // was discovered in this file.
    const fileDests = destinations.filter((d) => d.sourceLoc?.startsWith(s.path));
    for (const claim of claims) {
      if (fileDests.length === 1 && destSet.has(fileDests[0].id)) {
        meta.set(fileDests[0].id, { ...(meta.get(fileDests[0].id) || {}), ...claim.fields });
      }
    }
  }
  return meta;
}

function parseArgs(argv) {
  const a = { scope: 'diff', format: 'human', gate: false, bootstrap: false, verify: null, out: null, root: null,
    breakpoints: ['mobile', 'desktop'], storageState: null, fromUrl: null, force: false, noActivate: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--scope') a.scope = argv[++i];
    else if (t === '--format') a.format = argv[++i];
    else if (t === '--gate') a.gate = true;
    else if (t === '--bootstrap') a.bootstrap = true;
    else if (t === '--verify') a.verify = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--root') a.root = argv[++i];
    else if (t === '--breakpoints') a.breakpoints = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (t === '--storage-state') a.storageState = argv[++i];
    else if (t === '--from-url') a.fromUrl = argv[++i];
    else if (t === '--force') a.force = true;
    else if (t === '--no-activate') a.noActivate = true; // skip the collapsed-menu activation pass (#3)
  }
  return a;
}

function countBySeverity(findings) {
  const c = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of findings) if (f.severity in c) c[f.severity]++;
  return c;
}

function listSourceFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '*.js', '*.jsx', '*.ts', '*.tsx'], { encoding: 'utf-8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function gitChangedFiles(root) {
  let base = 'HEAD';
  try {
    const def = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'origin/HEAD'], { encoding: 'utf-8' }).trim() || 'origin/main';
    base = execFileSync('git', ['-C', root, 'merge-base', def, 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch { base = 'HEAD'; }
  try {
    const out = execFileSync('git', ['-C', root, 'diff', '--name-only', base], { encoding: 'utf-8' });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

function gitHeadSha(root) {
  try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(); } catch { return null; }
}
function gitHeadDate(root) {
  try { return execFileSync('git', ['-C', root, 'show', '-s', '--format=%cI', 'HEAD'], { encoding: 'utf-8' }).trim(); } catch { return null; }
}

/**
 * Fetch persona reachability evidence via the cross-skill CLI boundary (the contract
 * between persona-test and nav-audit), then map it to personaIntents (pure mapping
 * in lib/nav/persona-seed.mjs). ANY failure (no env, cloud off, reader error, no
 * evidence) → `[]`, and bootstrap proceeds normally (R2-H2).
 * @param {string|undefined} repoName  PERSONA_TEST_REPO_NAME
 * @param {string|null} bootUrl  the live URL (origin for normalization)
 * @returns {Array<{personaId:string, intentId:string, destination:string, label:string|null, source:string}>}
 */
function seedPersonaIntents(repoName, bootUrl) {
  if (!repoName) return [];
  let personas;
  try {
    const csPath = fileURLToPath(new URL('./cross-skill.mjs', import.meta.url));
    const out = execFileSync(process.execPath, [csPath, 'get-reachability-evidence', '--repo', repoName],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const json = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || '{}');
    personas = Array.isArray(json.personas) ? json.personas : [];
  } catch {
    return []; // reader unavailable → seed nothing, never abort --bootstrap
  }
  return mapPersonasToIntents(personas, bootUrl);
}

main().catch((err) => { process.stderr.write(`[nav-audit] fatal: ${err.stack || err.message}\n`); process.exit(2); });
