/**
 * @fileoverview Orchestration for gate provenance: classify base vs head, run each registered ratchet gate from the verdict
 * snapshot (and as a shadow from the PR tree), check the loosening authorization, and assemble ONE report whose states
 * never read an unmeasured thing as clean.
 *
 * States: `clean` (nothing loosening or unknown) | `authorized` (loosening, with the label and the approval) |
 * `violation` | `unmeasured`. `unmeasured` is a first-class state with a reason; it is printed, never collapsed to clean.
 *
 * @module scripts/lib/gate-provenance/analyze
 */
import { execFileSync } from 'node:child_process';
import { sanitizeGitEnv } from '../git-env-sanitize.mjs';
import { classifyGateDiff, needsAuthorization, GATE_DIFF_CONTRACT_VERSION } from './classify.mjs';
import { expandRegistry } from './registry.mjs';
import { buildSnapshot, loadSide, runGate } from './snapshot.mjs';
import { evaluateLoosening, fetchPrFacts } from './authorize.mjs';

/** Files changed between the two revisions, NUL-delimited so a special path is never C-quoted. */
function changedBetween(repoRoot, base, head) {
  const out = execFileSync('git', ['diff', '--name-only', '-z', base, head], { cwd: repoRoot, encoding: 'utf8', env: sanitizeGitEnv(repoRoot), maxBuffer: 256 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

/**
 * Run every registered gate twice: VERDICT (base protected set, in the snapshot) and SHADOW (the PR tree as it is).
 * @returns {{state: 'measured'|'unmeasured', reason?: string, runs: object[]}}
 */
function runGates({ repoRoot, base, head, baseSide, headSide, install, installDeps, run }) {
  const gates = baseSide.registry.gates;
  if (!gates.length) return { state: 'unmeasured', reason: 'the base registry declares no gates', runs: [] };
  let snap;
  try {
    snap = buildSnapshot({ repoRoot, base, head, install, installDeps, baseSide, headSide });
  } catch (e) {
    return { state: 'unmeasured', reason: `snapshot construction failed: ${String(e.message).split('\n')[0]}`, runs: [] };
  }
  try {
    if (snap.nodeModules !== 'linked') {
      return { state: 'unmeasured', reason: `no base dependency install (${snap.nodeModulesReason})`, runs: [], inventories: snap.inventories };
    }
    const runs = gates.map((g) => {
      const verdict = run({ cwd: snap.dir, argv: g.argv });
      const shadow = run({ cwd: repoRoot, argv: g.argv });
      return { id: g.id, verdict, shadow, diverges: verdict.exit !== shadow.exit };
    });
    return { state: 'measured', runs, inventories: snap.inventories };
  } finally {
    snap.cleanup();
  }
}

function registeredPathSet(baseSide, headSide) {
  return new Set([
    ...expandRegistry(baseSide.registry, baseSide.files).keys(),
    ...(headSide.registry ? expandRegistry(headSide.registry, headSide.files).keys() : []),
  ]);
}

function bootstrapReason(baseSide) {
  return baseSide.registryError === 'absent'
    ? 'the base has no .gate-files.json (bootstrap: the one change that cannot be judged by base rules)'
    : `the base registry does not parse: ${baseSide.registryError}`;
}

/**
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.base resolved base sha
 * @param {string} args.head resolved head sha
 * @param {'observe'|'enforce'} args.mode
 * @param {boolean} [args.gateRuns] false = skip the snapshot-and-run step (reported as unmeasured)
 * @param {string} [args.repo] owner/name for gh
 * @param {string|number} [args.pr] PR number for gh
 * @param {object} [args.deps] injected seams for tests: facts, installDeps, install, runGate
 */
export function analyze({ repoRoot, base, head, mode, gateRuns = true, repo, pr, deps = {} }) {
  const report = { contractVersion: GATE_DIFF_CONTRACT_VERSION, mode, base, head, state: 'unmeasured', reason: null, classification: null, authorization: null, gateRuns: null };
  let baseSide;
  let headSide;
  try {
    baseSide = loadSide(repoRoot, base);
    headSide = loadSide(repoRoot, head);
  } catch (e) {
    report.reason = `cannot read the revisions: ${String(e.message).split('\n')[0]}`;
    return report;
  }
  if (!baseSide.registry) {
    report.reason = bootstrapReason(baseSide);
    return report;
  }
  report.classification = classifyGateDiff({
    baseRegistry: baseSide.registry, headRegistry: headSide.registry,
    baseFiles: baseSide.files, headFiles: headSide.files, readBase: baseSide.read, readHead: headSide.read,
  });
  const verdict = report.classification.verdict;
  if (needsAuthorization(verdict)) {
    const facts = deps.facts ?? fetchPrFacts({ repo, pr });
    report.authorization = evaluateLoosening({ changedFiles: changedBetween(repoRoot, base, head), registeredPaths: registeredPathSet(baseSide, headSide), facts });
  }
  let failing = [];
  if (!gateRuns) {
    report.gateRuns = { state: 'unmeasured', reason: 'skipped by --no-gate-runs', runs: [] };
  } else {
    report.gateRuns = runGates({ repoRoot, base, head, baseSide, headSide, install: deps.install ?? true, installDeps: deps.installDeps, run: deps.runGate ?? runGate });
    failing = report.gateRuns.runs.filter((r) => r.verdict.exit !== 0).map((r) => r.id);
  }
  if (needsAuthorization(verdict)) {
    const a = report.authorization.state;
    if (a === 'authorized') report.state = 'authorized';
    else if (a === 'unmeasured') {
      report.state = 'unmeasured';
      report.reason = `the gate diff is ${verdict}; authorization could not be read: ${report.authorization.reasons[0]}`;
    } else {
      report.state = 'violation';
      report.reason = `the gate diff is ${verdict} and not authorized: ${report.authorization.reasons.join('; ')}`;
    }
  } else report.state = 'clean';
  if (failing.length && report.state !== 'violation') {
    report.state = 'violation';
    report.reason = `a registered gate fails under the base protected set: ${failing.join(', ')}`;
  }
  return report;
}

/** One line, for the CI notice and the tail of a report. Names every unmeasured part. */
export function summaryLine(r) {
  const parts = [`state=${r.state}`, `mode=${r.mode}`];
  if (r.classification) parts.push(`gateDiff=${r.classification.verdict}`, `files=${r.classification.files.length}`);
  if (r.gateRuns) {
    parts.push(r.gateRuns.state === 'measured'
      ? `gateRuns=${r.gateRuns.runs.filter((g) => g.verdict.exit === 0).length}/${r.gateRuns.runs.length} pass from base`
      : `gateRuns=unmeasured (${r.gateRuns.reason})`);
  }
  if (r.reason) parts.push(r.reason);
  return parts.join(' | ');
}

export function formatReport(r) {
  const lines = [`gate provenance (contract v${r.contractVersion}, ${r.mode} mode)`, `base ${r.base}  head ${r.head}`, ''];
  if (!r.classification) lines.push(`UNMEASURED: ${r.reason}`);
  else {
    lines.push(`gate diff: ${r.classification.verdict}`);
    for (const f of r.classification.files) {
      lines.push(`  ${f.verdict.padEnd(10)} ${f.path} [${f.kind}]`);
      for (const why of f.reasons.slice(0, 6)) lines.push(`      ${why}`);
    }
    if (r.authorization) lines.push('', `authorization: ${r.authorization.state}${r.authorization.reasons.length ? ` (${r.authorization.reasons.join('; ')})` : ''}`);
    lines.push('');
    if (r.gateRuns.state === 'measured') {
      lines.push('registered gates (verdict = base protected set; shadow = PR tree):');
      for (const g of r.gateRuns.runs) lines.push(`  ${g.id.padEnd(22)} verdict exit ${g.verdict.exit}  shadow exit ${g.shadow.exit}${g.diverges ? '  DIVERGES' : ''}`);
      const inv = r.gateRuns.inventories;
      if (inv) lines.push(`protected set: ${inv.protectedPaths.length} paths (${inv.restored.length} restored from base, ${inv.removed.length} removed as absent at base)`);
    } else lines.push(`gate runs: UNMEASURED (${r.gateRuns.reason})`);
  }
  lines.push('', summaryLine(r));
  return lines.join('\n');
}
