#!/usr/bin/env node
/**
 * @fileoverview Spike for the two measurements blocking
 * `docs/plans/observed-graph-discovery-unification.md` (§3).
 *
 * The plan is Draft and explicitly says **do not start building** until these
 * are answered: design (e) is "unimplementable if #1 fails and unaffordable if
 * #2 is bad". This script answers both by measuring, and deliberately builds
 * nothing.
 *
 *   M1 — FEASIBILITY (boolean, make-or-break)
 *        Does dep-cruiser cleanly accept an explicit list of ~3,000 file paths?
 *
 *        Worth noting up front: `extract.mjs` calls the dependency-cruiser JS
 *        API (`cruise(targets, opts)`), NOT the CLI, so the obvious failure
 *        mode — argv / command-line length limits, which is what "~3,000 paths"
 *        sounds like it's about — cannot occur. An in-process call takes a JS
 *        array. So M1 is really asking three narrower questions, which is what
 *        this spike reports separately:
 *          (a) does it complete without throwing on an explicit file list?
 *          (b) is the resulting graph EQUIVALENT to the directory-target graph
 *              (same edges), or does explicit-file mode change resolution
 *              semantics?
 *          (c) what does it cost in peak memory?
 *        (b) is the one that could still sink design (e), and it is not
 *        answerable by "did it throw?" alone.
 *
 *   M2 — COST (latency)
 *        What does a root/full cruise cost on a large repo? The only number in
 *        the plan is 1.1s, "measured on THIS repo — the one repo where the
 *        allowlist happens to work". Point `--repo` at a real consumer /
 *        monorepo to get an honest number. The plan sets NO numeric pass
 *        threshold for this ("unaffordable if bad"), so this script reports the
 *        measurement and refuses to invent a verdict — see the printed note.
 *
 * It also reports the COVERAGE DELTA (files the symbol layer sees that the
 * current allowlist-driven cruise does not), which is the evidence for the
 * plan's §4 null-domain accounting and the reason any of this matters: our own
 * `tests` domain — the largest in this repo — produced zero observed edges for
 * months while being fully symbol-indexed.
 *
 * Usage:
 *   node scripts/spikes/observed-graph-discovery-spike.mjs [--repo <path>] [--json]
 *
 * Read-only: no DB writes, no file writes, no mutation of any repo it points at.
 */
import fs from 'node:fs';
import path from 'node:path';
import { cruise } from 'dependency-cruiser';
import { enumerateFiles } from '../symbol-index/extract.mjs';

// Extensions dependency-cruiser can actually resolve. The symbol-layer walker
// returns every file it doesn't skip (including .md, .json, .sql); handing
// those to cruise is not a fair test of design (e), which would feed it the
// source inventory.
const CRUISABLE = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte',
]);

// Mirrors extract.mjs's cruiseOpts exactly — a spike that measures different
// options measures a different system.
function buildCruiseOpts(repoRoot) {
  const opts = {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|\\.git|\\.audit-loop|dist|build|coverage|out|\\.next|\\.nuxt|\\.cache)(/|$)' },
  };
  const localConfig = path.join(repoRoot, '.dependency-cruiser.cjs');
  return { opts, localConfig: fs.existsSync(localConfig) ? localConfig : null };
}

// The CURRENT production target selection, copied verbatim from extract.mjs so
// the baseline is the real baseline (including 'tests', added by the interim
// patch this plan is the follow-on to).
const COMMON_SOURCE_DIRS = [
  'scripts', 'src', 'lib', 'app', 'apps', 'packages',
  'components', 'pages', 'server', 'api', 'routes',
  'frontend', 'backend', 'client',
  'tests',
];

function currentTargets(repoRoot) {
  const targets = COMMON_SOURCE_DIRS
    .map((d) => path.join(repoRoot, d))
    .filter((p) => fs.existsSync(p));
  return targets.length === 0 ? [repoRoot] : targets;
}

/** Normalised edge set, so two graphs can be compared for genuine equivalence. */
function edgeSet(result) {
  const edges = new Set();
  for (const mod of result.output?.modules || []) {
    for (const dep of mod.dependencies || []) {
      edges.add(`${mod.source} -> ${dep.resolved}`);
    }
  }
  return edges;
}

async function timedCruise(label, targets, opts) {
  // peak RSS is sampled, not exact — enough to answer "does this blow up?",
  // which is the only memory question the plan asks.
  const before = process.memoryUsage().rss;
  let peak = before;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 50);
  const t0 = process.hrtime.bigint();
  let result = null;
  let error = null;
  try {
    result = await cruise(targets, opts);
  } catch (err) {
    error = err;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);

  if (error) {
    return { label, ok: false, error: error.message, ms, peakRssMb: (peak - before) / 1024 / 1024 };
  }
  const modules = result.output?.modules || [];
  return {
    label,
    ok: true,
    ms,
    peakRssMb: (peak - before) / 1024 / 1024,
    moduleCount: modules.length,
    edgeCount: modules.reduce((n, m) => n + (m.dependencies?.length || 0), 0),
    edges: edgeSet(result),
    sources: new Set(modules.map((m) => m.source)),
  };
}

function fmt(n, digits = 1) {
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  const repoIdx = argv.indexOf('--repo');
  const repoRoot = path.resolve(repoIdx !== -1 ? argv[repoIdx + 1] : process.cwd());
  const jsonMode = argv.includes('--json');

  if (!fs.existsSync(repoRoot)) {
    process.stderr.write(`spike: --repo path does not exist: ${repoRoot}\n`);
    process.exit(2);
  }

  const { opts, localConfig } = buildCruiseOpts(repoRoot);
  if (localConfig) opts.ruleSet = (await import(`file://${localConfig}`)).default;

  process.stderr.write(`\n═══ observed-graph discovery spike ═══\nrepo: ${repoRoot}\n`);
  if (localConfig) process.stderr.write(`using local .dependency-cruiser.cjs\n`);

  // ── Inventory: what the SYMBOL layer thinks this repo is made of ──────────
  const tInv0 = process.hrtime.bigint();
  const allFiles = enumerateFiles(repoRoot, null);
  const invMs = Number(process.hrtime.bigint() - tInv0) / 1e6;
  const sourceFiles = allFiles.filter((f) => CRUISABLE.has(path.extname(f).toLowerCase()));
  process.stderr.write(
    `\ninventory (symbol layer): ${allFiles.length} files walked in ${fmt(invMs)}ms `
    + `→ ${sourceFiles.length} cruisable\n`);

  // ── Baseline: the CURRENT allowlist-driven directory cruise ───────────────
  const targets = currentTargets(repoRoot);
  process.stderr.write(`\n[baseline] allowlist targets (${targets.length}): `
    + `${targets.map((t) => path.relative(repoRoot, t) || '.').join(', ')}\n`);
  const baseline = await timedCruise('baseline (allowlist dirs)', targets, opts);

  // ── M1: explicit file list (design (e)) ──────────────────────────────────
  process.stderr.write(`\n[M1] explicit file list (${sourceFiles.length} paths)…\n`);
  const explicit = await timedCruise('M1 (explicit file list)', sourceFiles, opts);

  // ── M2: root cruise (the fallback if M1 fails) ───────────────────────────
  process.stderr.write(`\n[M2] root cruise…\n`);
  const root = await timedCruise('M2 (root cruise)', [repoRoot], opts);

  // ── Analysis ─────────────────────────────────────────────────────────────
  const runs = [baseline, explicit, root];
  let equivalence = null;
  if (explicit.ok && root.ok) {
    // Is the explicit-file graph the same graph as the exhaustive root cruise?
    // This is M1(b) — the question "did it throw?" cannot answer.
    //
    // CRUCIAL DISTINCTION, or this measurement lies. A differing edge has two
    // very different possible causes:
    //   (i)  INPUT difference — the edge's source file was never handed to one
    //        of the two runs (e.g. the symbol walker's SKIP_DIRS excludes
    //        `.claude/`, so `.claude/hooks/*.mjs` cannot appear in the explicit
    //        graph). This says nothing about dep-cruiser; it is the two layers
    //        disagreeing about the INVENTORY, which is the plan's actual thesis.
    //   (ii) SEMANTIC difference — both runs were given the same source file
    //        and still produced different edges from it. THIS is the thing that
    //        could sink design (e), because it means an explicit file list is
    //        not a faithful substitute for a directory walk.
    // Reporting (i) as if it were (ii) would manufacture a blocker that isn't
    // there. Partition them.
    const explicitInputs = new Set(sourceFiles.map((f) => path.resolve(f)));
    const rootSources = new Set([...root.sources].map((s) => path.resolve(repoRoot, s)));
    const srcOf = (edge) => path.resolve(repoRoot, edge.split(' -> ')[0]);

    const classify = (edges, presentInOtherInput) => {
      const semantic = [];
      const input = [];
      for (const e of edges) (presentInOtherInput(srcOf(e)) ? semantic : input).push(e);
      return { semantic, input };
    };

    // An edge only in the root graph is SEMANTIC only if its source file was
    // actually in the explicit run's input list.
    const onlyRoot = classify(
      [...root.edges].filter((e) => !explicit.edges.has(e)),
      (src) => explicitInputs.has(src));
    // An edge only in the explicit graph is SEMANTIC only if the root cruise
    // also saw that source file.
    const onlyExplicit = classify(
      [...explicit.edges].filter((e) => !root.edges.has(e)),
      (src) => rootSources.has(src));

    equivalence = {
      semanticDiffs: onlyRoot.semantic.length + onlyExplicit.semantic.length,
      inputDiffs: onlyRoot.input.length + onlyExplicit.input.length,
      sampleSemantic: [...onlyRoot.semantic.slice(0, 4), ...onlyExplicit.semantic.slice(0, 4)],
      sampleInput: [...onlyRoot.input.slice(0, 3), ...onlyExplicit.input.slice(0, 3)],
    };
  }

  // Coverage delta — the motivating bug, quantified.
  let coverage = null;
  if (baseline.ok) {
    const seen = new Set([...baseline.sources].map((s) => path.resolve(repoRoot, s)));
    const missed = sourceFiles.filter((f) => !seen.has(path.resolve(f)));
    // Report ONLY inventory-relative numbers, so the three figures add up.
    // `seen.size` is not one of them: the baseline graph also contains modules
    // that are not in the symbol-layer inventory at all (dependencies pulled in
    // from excluded dirs), so printing it alongside the inventory count made
    // `inventory - inGraph` disagree with `missed` and read like an arithmetic
    // bug. Covered is defined as inventory ∩ graph.
    coverage = {
      inventory: sourceFiles.length,
      covered: sourceFiles.length - missed.length,
      missed: missed.length,
      alsoInGraphButNotInInventory: seen.size - (sourceFiles.length - missed.length),
      sample: missed.slice(0, 8).map((f) => path.relative(repoRoot, f)),
    };
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      repoRoot,
      inventory: { walked: allFiles.length, cruisable: sourceFiles.length, walkMs: invMs },
      runs: runs.map(({ edges, sources, ...r }) => r),
      equivalence,
      coverage,
    }, null, 2));
    return;
  }

  process.stderr.write(`\n─── results ───\n`);
  for (const r of runs) {
    if (!r.ok) {
      process.stderr.write(`  ${r.label.padEnd(28)} THREW after ${fmt(r.ms)}ms — ${r.error}\n`);
      continue;
    }
    process.stderr.write(
      `  ${r.label.padEnd(28)} ${fmt(r.ms).padStart(9)}ms  `
      + `${String(r.moduleCount).padStart(6)} modules  ${String(r.edgeCount).padStart(7)} edges  `
      + `+${fmt(r.peakRssMb)}MB\n`);
  }

  process.stderr.write(`\n─── M1: does an explicit file list work? ───\n`);
  if (!explicit.ok) {
    process.stderr.write(`  VERDICT: NO — cruise() threw on an explicit file list.\n`);
    process.stderr.write(`  → design (e) is unimplementable as written; fall back to the plan's\n`);
    process.stderr.write(`    stated alternative (cruise repoRoot, delegate exclusions to a real\n`);
    process.stderr.write(`    .gitignore parser). M2 below is then the binding cost.\n`);
  } else if (equivalence && equivalence.semanticDiffs > 0) {
    process.stderr.write(`  VERDICT: RUNS, but dep-cruiser produced DIFFERENT edges from the same\n`);
    process.stderr.write(`  source files (${equivalence.semanticDiffs} semantic diff(s)).\n`);
    for (const e of equivalence.sampleSemantic) process.stderr.write(`      ${e}\n`);
    process.stderr.write(`  → explicit-file mode is not a faithful substitute for a directory walk.\n`);
    process.stderr.write(`    Design (e) needs a decision on which graph is CORRECT before shipping.\n`);
  } else if (equivalence) {
    process.stderr.write(`  VERDICT: YES — completed, and produced NO semantic differences: every\n`);
    process.stderr.write(`  edge derived from a file both runs saw is identical.\n`);
    if (equivalence.inputDiffs > 0) {
      process.stderr.write(`\n  ${equivalence.inputDiffs} edge(s) differ purely because the two runs were given\n`);
      process.stderr.write(`  different INPUTS — not a dep-cruiser behaviour difference:\n`);
      for (const e of equivalence.sampleInput) process.stderr.write(`      ${e}\n`);
      process.stderr.write(`  That gap IS the plan's thesis (the two layers disagree about what the\n`);
      process.stderr.write(`  repo contains), and it is what design (e) would fix — but it is\n`);
      process.stderr.write(`  evidence FOR the design, not an obstacle to it.\n`);
    }
    process.stderr.write(`  → design (e) is feasible on this repo.\n`);
  }

  process.stderr.write(`\n─── M2: what does a full cruise cost? ───\n`);
  if (root.ok) {
    process.stderr.write(`  ${fmt(root.ms)}ms, +${fmt(root.peakRssMb)}MB peak, `
      + `${root.moduleCount} modules on ${path.basename(repoRoot)}.\n`);
    process.stderr.write(`  NOTE: the plan sets no numeric pass threshold for M2 ("unaffordable if\n`);
    process.stderr.write(`  bad"), so this script does NOT emit a pass/fail. It is a number for a\n`);
    process.stderr.write(`  human to judge — and it is only meaningful on a repo that actually\n`);
    process.stderr.write(`  resembles the adversarial case the plan names (a ~40k-file packages/\n`);
    process.stderr.write(`  tree). Re-run with --repo pointed at one before deciding.\n`);
  } else {
    process.stderr.write(`  root cruise THREW: ${root.error}\n`);
  }

  if (coverage) {
    process.stderr.write(`\n─── coverage delta (the motivating bug) ───\n`);
    process.stderr.write(`  symbol-layer cruisable files:      ${coverage.inventory}\n`);
    process.stderr.write(`  ├─ covered by the allowlist graph: ${coverage.covered}\n`);
    process.stderr.write(`  └─ INVISIBLE to the import layer:  ${coverage.missed}\n`);
    process.stderr.write(`  (graph also contains ${coverage.alsoInGraphButNotInInventory} module(s) outside the inventory)\n`);
    for (const f of coverage.sample) process.stderr.write(`      ${f}\n`);
    if (coverage.missed > 0) {
      process.stderr.write(`  → these are symbol-indexed but contribute no observed edges, and\n`);
      process.stderr.write(`    nothing warns. This is the §4 null-domain accounting evidence.\n`);
    }
  }
  process.stderr.write('\n');
}

main().catch((err) => {
  process.stderr.write(`spike failed: ${err.stack || err.message}\n`);
  process.exit(1);
});
