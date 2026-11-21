/**
 * @fileoverview Orchestration for gate provenance: classify base vs head, run each registered ratchet gate from the verdict
 * snapshot (and as a shadow from a clean worktree of the head), check the loosening authorization, and assemble ONE report
 * whose states never read an unmeasured thing as clean.
 *
 * States: `violation` | `unmeasured` | `authorized` | `clean`, in that order of dominance. ANY unmeasured input (a git read,
 * the registry, the snapshot, the base install, the gate runs, a skipped run, unreadable PR facts) makes the overall
 * state `unmeasured`, never `clean` or `authorized`; the parts are listed in `unmeasuredParts`. A definite violation
 * still outranks it, because a measured failure is not made softer by an unmeasured neighbour.
 *
 * @module scripts/lib/gate-provenance/analyze
 */
import { execFileSync } from 'node:child_process';
import { sanitizeGitEnv } from '../git-env-sanitize.mjs';
import { classifyGateDiff, needsAuthorization, GATE_DIFF_CONTRACT_VERSION } from './classify.mjs';
import { buildSnapshot, loadSide, computeProtected, runGate } from './snapshot.mjs';
import { evaluateLoosening, fetchPrFacts } from './authorize.mjs';
import { escapeData as E, neutralizeLeadingCommand } from './actions-escape.mjs';

/** Files changed between the two revisions. `--no-renames` lists BOTH sides of a move, so a move out of or into a registered path is seen. */
function changedBetween(repoRoot, base, head) {
  const out = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head], { cwd: repoRoot, encoding: 'utf8', env: sanitizeGitEnv(repoRoot), maxBuffer: 256 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

/**
 * Run every registered gate twice: VERDICT (base protected set, in the snapshot) and SHADOW (a clean worktree of the head).
 * @returns {{state: 'measured'|'unmeasured', reason?: string, runs: object[]}}
 */
function runGates({ repoRoot, base, head, baseSide, headSide, prot, install, installDeps, baseInstallDir, fsImpl, shadow, run }) {
  const gates = baseSide.registry.gates;
  if (!gates.length) return { state: 'unmeasured', reason: 'the base registry declares no gates', runs: [] };
  let snap;
  try {
    snap = buildSnapshot({ repoRoot, base, head, install, installDeps, baseInstallDir, baseSide, headSide, prot, fsImpl, shadow });
  } catch (e) {
    return { state: 'unmeasured', reason: `snapshot construction failed: ${String(e.message).split('\n')[0]}`, runs: [] };
  }
  try {
    if (snap.nodeModules !== 'linked') {
      return { state: 'unmeasured', reason: `no base dependency install (${snap.nodeModulesReason})`, runs: [], inventories: snap.inventories };
    }
    // ALL verdict runs complete and are recorded before ANY shadow run starts: the shadow shares the base node_modules, so a
    // shadow gate that writes there must not be able to change a verdict.
    const verdicts = gates.map((g) => run({ cwd: snap.dir, argv: g.argv }));
    // A verdict run with no exit status measured nothing: the whole gate run is unmeasured, never a violation.
    const unrun = gates.map((g, i) => ({ id: g.id, v: verdicts[i] })).filter((x) => x.v?.measured === false || !Number.isInteger(x.v?.exit));
    if (unrun.length) {
      return {
        state: 'unmeasured',
        reason: `verdict run did not complete: ${unrun.map((x) => `${x.id} (${x.v?.reason ?? 'no exit status'})`).join('; ')}`,
        runs: gates.map((g, i) => ({ id: g.id, verdict: verdicts[i], diverges: false })), inventories: snap.inventories,
      };
    }
    // The shadow executes PR code, so it is opt-in (--shadow) and never requested by CI.
    const shadows = shadow ? gates.map((g) => run({ cwd: snap.shadowDir, argv: g.argv })) : null;
    // A shadow run with no exit status measured nothing: it is never a divergence, and the shadow block says it was partial.
    const shadowMeasured = (s) => s?.measured !== false && Number.isInteger(s?.exit);
    const runs = gates.map((g, i) => (shadows
      ? { id: g.id, verdict: verdicts[i], shadow: shadows[i], diverges: shadowMeasured(shadows[i]) && verdicts[i].exit !== shadows[i].exit }
      : { id: g.id, verdict: verdicts[i], diverges: false }));
    const shadowUnrun = shadows ? gates.filter((g, i) => !shadowMeasured(shadows[i])).map((g) => g.id) : [];
    const shadowState = !shadow ? { state: 'not-run', reason: SHADOW_NOT_RUN }
      : shadowUnrun.length ? { state: 'partial', reason: `shadow run did not complete: ${shadowUnrun.join(', ')}` } : { state: 'run' };
    return { state: 'measured', runs, inventories: snap.inventories, shadow: shadowState };
  } finally {
    snap.cleanup();
  }
}

/** The ONE report constructor: every report, including the synthetic ones for a failed range or revision, has this shape. */
export function newReport({ mode, base, head }) {
  return {
    contractVersion: GATE_DIFF_CONTRACT_VERSION, mode, base, head, state: 'unmeasured', reason: null,
    classification: null, authorization: null, gateRuns: null, unmeasuredParts: [],
  };
}

/** A report for a run that could not even start measuring: unmeasured, with the reason listed as its one unmeasured part. */
export function unmeasuredReport({ mode, base, head, reason }) {
  const r = newReport({ mode, base, head });
  r.reason = reason;
  r.unmeasuredParts.push(reason);
  return r;
}

export const SHADOW_NOT_RUN = 'PR code is never executed by the provenance step; the test job runs it';

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
 * @param {boolean} [args.shadow] true = ALSO run each gate from a clean worktree of the head (executes PR code; off by default)
 * @param {boolean} [args.gateRuns] false = skip the snapshot-and-run step (reported as unmeasured)
 * @param {string} [args.repo] owner/name for gh
 * @param {string|number} [args.pr] PR number for gh
 * @param {string} [args.baseInstallDir] an existing trusted base install to reuse
 * @param {object} [args.deps] injected seams for tests: facts, installDeps, install, runGate, show
 */
export function analyze({ repoRoot, base, head, mode, gateRuns = true, shadow = false, repo, pr, baseInstallDir, deps = {} }) {
  const report = newReport({ mode, base, head });
  const unmeasured = (why) => report.unmeasuredParts.push(why);
  const finish = () => {
    // Only a MEASURED non-zero exit is a failure; a run with no exit status measured nothing (it is listed as unmeasured).
    const failing = (report.gateRuns?.runs ?? []).filter((r) => r.verdict?.measured !== false && Number.isInteger(r.verdict?.exit) && r.verdict.exit !== 0).map((r) => r.id);
    if (report.authorization?.state === 'not-authorized') {
      report.state = 'violation';
      report.reason = `the gate diff is ${report.classification.verdict} and not authorized: ${report.authorization.reasons.join('; ')}`;
    } else if (failing.length) {
      report.state = 'violation';
      report.reason = `a registered gate fails under the base protected set: ${failing.join(', ')}`;
    } else if (report.unmeasuredParts.length) {
      report.state = 'unmeasured';
      report.reason = report.unmeasuredParts.join('; ');
    } else {
      report.state = report.authorization?.state === 'authorized' ? 'authorized' : 'clean';
    }
    return report;
  };

  let baseSide;
  let headSide;
  let prot;
  try {
    baseSide = loadSide(repoRoot, base, { show: deps.show });
    headSide = loadSide(repoRoot, head, { show: deps.show });
    if (!baseSide.registry) { unmeasured(bootstrapReason(baseSide)); return finish(); }
    prot = computeProtected(baseSide, headSide);
    if (prot.missingEntryPoints?.length) unmeasured(`base registry names gate roots the base tree lacks: ${prot.missingEntryPoints.join(', ')}`);
    report.classification = classifyGateDiff({
      baseRegistry: baseSide.registry, headRegistry: headSide.registry,
      baseFiles: baseSide.files, headFiles: headSide.files, readBase: baseSide.read, readHead: headSide.read,
      protectedPaths: new Set(prot.protectedPaths),
    });
  } catch (e) {
    unmeasured(`git read failed: ${String(e.message).split('\n')[0]}`);
    return finish();
  }

  if (needsAuthorization(report.classification.verdict)) {
    try {
      // The registered-only check uses the BASE registry set (authorizedPaths): a PR cannot widen it by registering its own file.
      report.authorization = evaluateLoosening({
        changedFiles: changedBetween(repoRoot, base, head), protectedPaths: new Set(prot.authorizedPaths),
        facts: () => deps.facts ?? fetchPrFacts({ repo, pr }), base, head,
      });
      if (report.authorization.state === 'unmeasured') unmeasured(`loosening authorization unreadable: ${report.authorization.reasons[0]}`);
    } catch (e) {
      unmeasured(`git read failed: ${String(e.message).split('\n')[0]}`);
    }
  }

  if (!gateRuns) {
    report.gateRuns = { state: 'unmeasured', reason: 'skipped by --no-gate-runs', runs: [] };
  } else {
    report.gateRuns = runGates({
      repoRoot, base, head, baseSide, headSide, prot, install: deps.install ?? true, installDeps: deps.installDeps,
      baseInstallDir, fsImpl: deps.fsImpl, shadow, run: deps.runGate ?? runGate,
    });
  }
  if (report.gateRuns.state !== 'measured') unmeasured(`gate runs unmeasured: ${report.gateRuns.reason}`);
  return finish();
}

/** One line, for the CI notice and the tail of a report. Names every unmeasured part. */
export function summaryLine(r) {
  const parts = [`state=${r.state}`, `mode=${r.mode}`];
  if (r.classification) parts.push(`gateDiff=${r.classification.verdict}`, `files=${r.classification.files.length}`);
  if (r.gateRuns?.state === 'measured') parts.push(`gateRuns=${r.gateRuns.runs.filter((g) => g.verdict.exit === 0).length}/${r.gateRuns.runs.length} pass from base`);
  if (r.reason) parts.push(E(r.reason));
  return parts.join(' | ');
}

export function formatReport(r) {
  const lines = [`gate provenance (contract v${r.contractVersion}, ${r.mode} mode)`, `base ${E(r.base)}  head ${E(r.head)}`, ''];
  if (!r.classification) lines.push(`UNMEASURED: ${E(r.reason)}`);
  else {
    lines.push(`gate diff: ${r.classification.verdict}`);
    for (const f of r.classification.files) {
      lines.push(`  ${f.verdict.padEnd(10)} ${E(f.path)} [${f.kind}]`);
      for (const why of f.reasons.slice(0, 6)) lines.push(`      ${E(why)}`);
    }
    if (r.authorization) lines.push('', `authorization: ${r.authorization.state}${r.authorization.reasons.length ? ` (${E(r.authorization.reasons.join('; '))})` : ''}`);
    lines.push('');
    if (r.gateRuns?.state === 'measured') {
      lines.push(['run', 'partial'].includes(r.gateRuns.shadow?.state) ?'registered gates (verdict = base protected set; shadow = clean worktree of the head):' : 'registered gates (verdict = base protected set, base code over PR data):');
      for (const g of r.gateRuns.runs) lines.push(`  ${E(g.id).padEnd(22)} verdict exit ${g.verdict.exit}${g.shadow ? `  shadow exit ${g.shadow.exit}${g.diverges ? '  DIVERGES' : ''}` : ''}`);
      if (r.gateRuns.shadow?.state === 'not-run') lines.push(`shadow: not run (${E(r.gateRuns.shadow.reason)})`);
      const inv = r.gateRuns.inventories;
      if (inv) lines.push(`protected set: ${inv.protectedPaths.length} paths (${inv.restored.length} restored from base, ${inv.removed.length} removed as absent at base, ${inv.helperScripts.length} spawned helper scripts)`);
    } else if (r.gateRuns) lines.push(`gate runs: UNMEASURED (${E(r.gateRuns.reason)})`);
  }
  for (const p of r.unmeasuredParts) lines.push(`UNMEASURED: ${E(p)}`);
  lines.push('', summaryLine(r));
  return lines.map(neutralizeLeadingCommand).join('\n');
}
