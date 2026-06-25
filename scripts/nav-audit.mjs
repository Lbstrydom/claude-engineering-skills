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
import { writeOutput } from './lib/file-io.mjs';
import { readSources, extractEdges } from './lib/nav/extract.mjs';
import { readContract, parseNavMeta, bootstrapContract, writeContract } from './lib/nav/contract.mjs';
import { buildModel } from './lib/nav/model.mjs';
import { runTaxonomy, personaScorecard } from './lib/nav/findings.mjs';
import { partitionFindings, scopeToChanged, divergenceKey } from './lib/nav/drift.mjs';
import { renderFindings, renderTable, renderMermaid, renderScorecard } from './lib/nav/render.mjs';
import { assembleEnvelope, writeObservedEnvelope } from './lib/nav/envelope.mjs';
import { computeContractDigest } from './lib/nav/schema.mjs';
import { runVerify } from './lib/nav/verify.mjs';

async function main() {
  // CLI smoke contract — must prove imports survive relocation (AGENTS.md).
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const root = args.root || '.';

  let sourceFiles;
  let changedFiles = null;
  try {
    sourceFiles = listSourceFiles(root);
    if (args.scope === 'diff' && !args.verify) changedFiles = new Set(gitChangedFiles(root));
  } catch (err) {
    process.stderr.write(`[nav-audit] git/file error: ${err.message}\n`);
    process.exit(2);
  }

  // Read the contract early so its appRoots/exclude drive extraction.
  const { contract: earlyContract } = readContract(root);
  const appRoots = earlyContract?.appRoots ?? [];

  const { sources } = readSources(root, sourceFiles, { exclude: earlyContract?.exclude ?? [] });
  const { edges, destinations, adapters, recall, warnings } = extractEdges(sources, { root, appRoots });

  // Bootstrap mode: emit a review-queue contract skeleton and stop.
  if (args.bootstrap) {
    const { contract, inferredUtility } = bootstrapContract({ destinations: destinations.map((d) => d.id) });
    const written = writeContract(root, contract);
    const payload = { ok: true, mode: 'bootstrap', written, inferredUtility, adapters };
    writeOutput(payload, args.out, `[nav-audit] bootstrap → ${written} (${inferredUtility.length} inferred-utility routes flagged)`);
    process.exit(0);
  }

  // --verify: drive the live app and reconcile against the static model. Works
  // with OR without a committed contract (exploratory) — intent reachability is
  // only checked when a contract is present.
  if (args.verify) {
    const model = buildModel(edges, { contract: earlyContract, sources, destinations });
    let report;
    try {
      report = await runVerify({ url: args.verify, model, contract: earlyContract });
    } catch (err) {
      process.stderr.write(`[nav-audit] verify failed: ${err.message}\n`);
      process.exit(2);
    }
    if (args.format === 'json') {
      writeOutput(report, args.out, `[nav-audit] verify: ${report.confirmed.length} confirmed, ${report.staticOnly.length} static-only, ${report.runtimeOnly.length} runtime-only`);
    } else {
      const lines = [
        `NAV VERIFY — ${report.url}`, '─'.repeat(48),
        `Live nav targets: ${report.liveNavCount}`,
        `✓ Confirmed (static ∩ live):   ${report.confirmed.join(', ') || '—'}`,
        `△ Static-only (not in live nav): ${report.staticOnly.join(', ') || '—'}`,
        `● Runtime-only (live, not static): ${report.runtimeOnly.join(', ') || '—'}`,
        '',
        'Declared-intent landing reachability:',
        ...report.intentReachability.map((r) => `  [${r.reachableInLandingNav ? '✓' : '✗'}] ${r.persona}/${r.intent} → ${r.destination}`),
      ];
      if (args.out) writeOutput(report, args.out, lines.join('\n')); else process.stdout.write(lines.join('\n') + '\n');
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
  const a = { scope: 'diff', format: 'human', gate: false, bootstrap: false, verify: null, out: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--scope') a.scope = argv[++i];
    else if (t === '--format') a.format = argv[++i];
    else if (t === '--gate') a.gate = true;
    else if (t === '--bootstrap') a.bootstrap = true;
    else if (t === '--verify') a.verify = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--root') a.root = argv[++i];
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

main().catch((err) => { process.stderr.write(`[nav-audit] fatal: ${err.stack || err.message}\n`); process.exit(2); });
