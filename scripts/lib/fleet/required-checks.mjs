/**
 * @fileoverview The CI evidence for landing: did every REQUIRED check actually RUN, and pass, on this PR head? ONE oracle, ONE table
 * (docs/plans/ci-evidence-oracle.md).
 *
 * GitHub counts a SKIPPED check as satisfying a required check, so a PR made ready while its draft-time runs were skipped can merge
 * seconds later on checks that never ran (wine-cellar-app #802). Three layers, each with one owner:
 *  - `github-ci-facts.mjs` reads GitHub (the PR, the branch, the rules, the check runs, the commit statuses): decoded, schema-checked,
 *    one page, typed faults, never a stderr match;
 *  - `assessRequiredCi` turns those facts into EVIDENCE from a closed tag set (`passed`, `none-required`, `failed`, `not-run`, `missing`,
 *    `pending`, `ineligible`, `unknown`); GitHub defines what is required, `.fleet.json` `requiredChecks` only asserts exact agreement;
 *  - `decideCiAdmission` maps a tag to ONE disposition (`permit`, `refuse-member`, `retry`, `stop-run`); only `passed` and a PROVEN
 *    `none-required` permit. Every caller (approve, serial, ship-batch, rollup) uses it and none reads a reason string.
 * Nothing here throws, and a doubt is `unknown`, never a pass.
 *
 * @module scripts/lib/fleet/required-checks
 */
import { readBranchProtection, readBranchRules, readCheckRuns, readCommitStatuses, readPrCandidate } from './github-ci-facts.mjs';

// ---- the CI-evidence contract (docs/plans/ci-evidence-oracle.md §2.1-2.2) -------------------------------------------------------
// Evidence is WHAT IS KNOWN about a PR head's required CI, from a closed tag set. A disposition is WHAT A CALLER DOES about it.
// The oracle that produces evidence (`assessRequiredCi`, PR 2) never returns an action; `decideCiAdmission` never reads GitHub.

/** The closed evidence tag set. `passed` and `none-required` are the only ones that can permit a merge. */
export const CI_EVIDENCE_TAGS = Object.freeze(['passed', 'none-required', 'failed', 'not-run', 'missing', 'pending', 'ineligible', 'unknown']);

/** The closed fault kinds an `unknown` may carry (§2.4). */
export const CI_FAULT_KINDS = Object.freeze([
  'transport', 'malformed', 'too-many-results', 'unsupported-classic-protection', 'unsupported-unpinned-requirement',
  'status-context-present', 'unsupported-rule-type', 'config-error', 'config-drift', 'duplicate-conflict', 'unknown-conclusion', 'unexpected-tag',
]);

/** The closed `ineligible` codes. `head-moved` is the only one a caller may retry. */
export const CI_INELIGIBLE_CODES = Object.freeze(['closed', 'merged', 'draft', 'retargeted', 'head-moved', 'not-merged']);

/** The closed disposition set. */
export const CI_DISPOSITIONS = Object.freeze(['permit', 'refuse-member', 'retry', 'stop-run']);

/** A value as short, safe text for a diagnostic: never throws (a BigInt, a cycle or a hostile toString must not escape as an exception). */
const show = (v, max = 120) => { try { const t = typeof v === 'string' ? v : JSON.stringify(v); return String(t ?? typeof v).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, max); } catch { return `<${typeof v}>`; } };

/**
 * The ONE evidence → disposition table. `permit` is returned from exactly one branch (a positive allowlist); a tag the table does
 * not name, a non-object, or an `ineligible` with an unknown code is `stop-run`, never a refusal a caller could read as routine.
 * @param {{tag?: string, fault?: {kind: string, detail?: string}, code?: string}|null|undefined} evidence
 * @returns {{disposition: 'permit'|'refuse-member'|'retry'|'stop-run', tag: string, fault?: {kind: string, detail: string}, code?: string}}
 */
export function decideCiAdmission(evidence) {
  const tag = evidence && typeof evidence === 'object' ? evidence.tag : undefined;
  if (tag === 'passed' || tag === 'none-required') return { disposition: 'permit', tag };
  if (tag === 'failed' || tag === 'not-run') return { disposition: 'refuse-member', tag };
  if (tag === 'missing' || tag === 'pending') return { disposition: 'retry', tag };
  if (tag === 'ineligible') {
    const code = evidence.code;
    if (!CI_INELIGIBLE_CODES.includes(code)) return { disposition: 'stop-run', tag, code: show(code), fault: { kind: 'unexpected-tag', detail: `ineligible with an unrecognised code ${show(code)}` } };
    return { disposition: code === 'head-moved' ? 'retry' : 'refuse-member', tag, code };
  }
  if (tag === 'unknown') {
    const kind = CI_FAULT_KINDS.includes(evidence.fault?.kind) ? evidence.fault.kind : 'unexpected-tag';
    return { disposition: 'stop-run', tag, fault: { kind, detail: show(evidence.fault?.detail ?? 'no detail', 300) } };
  }
  return { disposition: 'stop-run', tag: show(tag), fault: { kind: 'unexpected-tag', detail: `the CI evidence carried no recognised tag (${show(tag)})` } };
}

/** One line naming the evidence, for a refusal or stop reason. Never empty. */
export function describeEvidence(evidence, decision = decideCiAdmission(evidence)) {
  const list = (k) => (Array.isArray(evidence?.names?.[k]) ? evidence.names[k].map((x) => show(x)) : []);
  const names = ['failed', 'not-run', 'missing', 'pending'].filter((k) => list(k).length).map((k) => `${k}: ${list(k).join(', ')}`);
  if (evidence?.tag === 'unknown' || decision.disposition === 'stop-run') return `CI evidence unknown (${decision.fault?.kind ?? 'unknown'}: ${decision.fault?.detail ?? 'no detail'})`;
  if (evidence?.tag === 'ineligible') return `the PR is not a merge candidate (${show(evidence.code)})`;
  if (decision.disposition === 'permit') return `required checks ${decision.tag}`;
  return names.length ? `required checks ${names.join('; ')}` : `required checks ${decision.tag}`;
}

// ---- the oracle: assessRequiredCi (docs/plans/ci-evidence-oracle.md section 2.1) -------------------------------------------------

/** A check run's `conclusion`, as the class it counts as. A conclusion not listed is `unknown-conclusion`, never a guess. */
const CONCLUSION_CLASS = Object.freeze({ __proto__: null,
  success: 'passed', failure: 'failed', cancelled: 'failed', timed_out: 'failed', startup_failure: 'failed',
  skipped: 'not-run', neutral: 'not-run', stale: 'not-run', action_required: 'not-run',
});
const OPEN_STATUSES = Object.freeze(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

const unknownOf = (kind, detail) => ({ tag: 'unknown', fault: { kind, detail } });
const fromFault = (r) => ({ tag: 'unknown', fault: r.fault });

/**
 * Why a PR is not a merge candidate at the expected base and head, or null. The ONE copy of the eligibility rule. In the `post-merge` phase (the
 * verification after a merge, docs/plans/ci-evidence-oracle.md Amendment A) the PR must be MERGED, into the expected base, from the expected head.
 */
function ineligibleCode(pr, { expectedBase, expectedHead, phase }) {
  const state = pr.state.toUpperCase();
  if (phase === 'post-merge') {
    if (state !== 'MERGED') return 'not-merged';
    if (pr.baseRefName !== expectedBase) return 'retargeted';
    return pr.headRefOid === expectedHead ? null : 'head-moved';
  }
  if (state === 'MERGED') return 'merged';
  if (state !== 'OPEN') return 'closed';
  if (pr.isDraft) return 'draft';
  if (pr.baseRefName !== expectedBase) return 'retargeted';
  if (pr.headRefOid !== expectedHead) return 'head-moved';
  return null;
}

/** The config assertion (section 2.5): exact agreement with GitHub's required contexts, or a typed fault. `undefined` asserts nothing. */
function configFault(assertion, contexts) {
  if (!assertion) return null;
  if (assertion.error) return { kind: 'config-error', detail: `.fleet.json could not be loaded: ${show(assertion.error, 200)}` };
  const want = assertion.requiredChecks;
  if (want === undefined) return null;
  if (!Array.isArray(want) || want.some((x) => typeof x !== 'string' || !x)) return { kind: 'config-error', detail: '.fleet.json requiredChecks is not a list of check names' };
  const have = new Set(contexts); const asked = new Set(want);
  const missingFromGithub = [...asked].filter((x) => !have.has(x)).sort();
  const missingFromConfig = [...have].filter((x) => !asked.has(x)).sort();
  if (!missingFromGithub.length && !missingFromConfig.length) return null;
  return { kind: 'config-drift', detail: `.fleet.json requiredChecks disagrees with GitHub: configured but not required by GitHub [${missingFromGithub.map((x) => show(x, 60)).join(', ')}]; required by GitHub but not configured [${missingFromConfig.map((x) => show(x, 60)).join(', ')}]` };
}

/** One required pair against the runs of its head: a class, or a fault. Both status and conclusion domains are closed. */
function assessPair(pair, runs) {
  const same = runs.filter((r) => r.name === pair.context);
  const mine = same.filter((r) => r.appId === pair.integrationId);
  const classes = [];
  for (const r of mine) {
    if (r.status !== 'completed' && !OPEN_STATUSES.includes(r.status)) return { fault: { kind: 'unknown-conclusion', detail: `check run ${r.id} (${show(pair.context, 60)}) has the status ${show(r.status, 40)}` } };
    if ((r.status === 'completed') !== (r.conclusion !== null)) return { fault: { kind: 'malformed', detail: `check run ${r.id} (${show(pair.context, 60)}) is ${show(r.status, 40)} with the conclusion ${show(r.conclusion, 40)}` } };
    if (r.status !== 'completed') { classes.push('pending'); continue; }
    const c = CONCLUSION_CLASS[r.conclusion];
    if (!c) return { fault: { kind: 'unknown-conclusion', detail: `check run ${r.id} (${show(pair.context, 60)}) concluded ${show(r.conclusion, 40)}` } };
    classes.push(c);
  }
  if (!mine.length) return { cls: 'missing', wrongApp: [...new Set(same.map((r) => r.appId))] };
  if (classes.includes('pending')) return { cls: 'pending' };
  const kinds = [...new Set(classes)];
  if (kinds.length > 1) return { fault: { kind: 'duplicate-conflict', detail: `${show(pair.context, 60)} has runs from the pinned app that disagree (${kinds.join(', ')})` } };
  return { cls: kinds[0] };
}

/**
 * Branch rule types that impose NO check or workflow requirement, so an inventory built only from `required_status_checks` is complete for
 * them (every type measured so far is here: deletion, non_fast_forward, pull_request, required_status_checks). A rule type NOT listed (a
 * required `workflows` rule, `required_deployments`, `code_scanning`, a merge queue, or a type GitHub adds tomorrow) might require CI
 * evidence the oracle does not read, so it is `unsupported-rule-type`, never "none required".
 */
const NON_CI_RULE_TYPES = Object.freeze(new Set([
  'creation', 'update', 'deletion', 'required_linear_history', 'required_signatures', 'pull_request', 'non_fast_forward', 'commit_message_pattern',
  'commit_author_email_pattern', 'committer_email_pattern', 'branch_name_pattern', 'tag_name_pattern', 'file_path_restriction', 'max_file_path_length',
  'file_extension_restriction', 'max_file_size', 'required_status_checks',
]));

/**
 * Ask an oracle (the real one, or an injected one in a test) for evidence and NEVER let it throw: an oracle that throws is `unknown`, so every
 * caller asks through this one wrapper and none carries its own try/catch (docs/plans/ci-evidence-oracle.md section 2.2).
 */
export function askCiOracle(oracle, args, deps) {
  try { return (oracle ?? assessRequiredCi)(args, deps); } catch (e) {
    return { tag: 'unknown', fault: { kind: 'unexpected-tag', detail: `the CI oracle threw: ${show(e?.message ?? e, 200)}` } };
  }
}

/**
 * THE oracle: the CI evidence for PR `prNumber` at `expectedHead`, as ONE value from the closed tag set. It reads (in this order, each
 * step needing the last): the PR, the branch (proving it exists and that classic protection is off), the rules, the config assertion, the
 * check runs and statuses of the immutable head, and the PR again. It never returns an action and never throws; every doubt is `unknown`.
 * @param {{repo: string, prNumber: number, expectedBase: string, expectedHead: string, phase?: 'pre-merge'|'post-merge', configAssertion?: {requiredChecks?: string[], error?: string|null}}} a
 * @param {{gh: Function, cwd?: string}} deps
 * @returns {{tag: string, head?: string, code?: string, names?: object, required?: object[], wrongApp?: object, fault?: {kind: string, detail: string}}}
 */
export function assessRequiredCi(args, deps) {
  try {
    const { repo, prNumber, expectedBase, expectedHead, configAssertion, phase } = args ?? {};
    const cwd = deps?.cwd ?? '.';
    const ctx = { expectedBase, expectedHead, phase: phase === 'post-merge' ? 'post-merge' : 'pre-merge' };
    const pr1 = readPrCandidate(deps, cwd, { repo, prNumber });
    if (!pr1.ok) return fromFault(pr1);
    const code1 = ineligibleCode(pr1.value, ctx);
    if (code1) return { tag: 'ineligible', code: code1, head: pr1.value.headRefOid };

    const branch = readBranchProtection(deps, cwd, { repo, base: expectedBase });
    if (!branch.ok) return fromFault(branch);
    if (branch.value.classicEnabled) return unknownOf('unsupported-classic-protection', `classic branch protection is enabled on ${show(expectedBase, 60)}: fleet reads rulesets only, so pin the requirement in a ruleset`);

    const rules = readBranchRules(deps, cwd, { repo, base: expectedBase });
    if (!rules.ok) return fromFault(rules);
    const unsupported = [...new Set(rules.value.types.filter((t) => !NON_CI_RULE_TYPES.has(t)))].map((t) => show(t, 60));
    if (unsupported.length) return unknownOf('unsupported-rule-type', `the branch has rule type(s) the oracle does not read: ${unsupported.join(', ')} (they may require CI evidence it cannot see)`);
    const unpinned = rules.value.pairs.filter((p) => p.integrationId === null).map((p) => show(p.context, 60));
    if (unpinned.length) return unknownOf('unsupported-unpinned-requirement', `required without a pinned integration: ${unpinned.join(', ')} (a check cannot be matched to an app, so identity cannot be established)`);
    const seen = new Set();
    const pairs = rules.value.pairs.filter((p) => { const k = `${p.context}\u0000${p.integrationId}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const contexts = [...new Set(pairs.map((p) => p.context))];

    const cf = configFault(configAssertion, contexts);
    if (cf) return { tag: 'unknown', fault: cf };

    let evidence;
    if (!pairs.length) {
      evidence = { tag: 'none-required', head: expectedHead, required: [], proof: `the branch ${show(expectedBase, 60)} exists, classic protection is off and no required_status_checks rule applies` };
    } else {
      const runs = readCheckRuns(deps, cwd, { repo, head: expectedHead });
      if (!runs.ok) return fromFault(runs);
      const statuses = readCommitStatuses(deps, cwd, { repo, head: expectedHead });
      if (!statuses.ok) return fromFault(statuses);
      const lowered = new Set(contexts.map((c) => c.toLowerCase())); // status contexts are compared case-insensitively: a near-miss is a collision, not a pass
      const clash = statuses.value.filter((s) => lowered.has(s.context.toLowerCase())).map((s) => show(s.context, 60));
      if (clash.length) return unknownOf('status-context-present', `a commit status shares the required context ${[...new Set(clash)].join(', ')}: a status carries no app id, so identity cannot be established`);

      const names = { failed: [], 'not-run': [], missing: [], pending: [] }; const wrongApp = new Map(); const passed = [];
      for (const pair of pairs) {
        const r = assessPair(pair, runs.value);
        if (r.fault) return { tag: 'unknown', fault: r.fault };
        if (r.cls === 'passed') passed.push({ name: pair.context, conclusion: 'success', appId: pair.integrationId });
        else { names[r.cls].push(pair.context); if (r.wrongApp?.length) wrongApp.set(pair.context, r.wrongApp); }
      }
      const worst = ['failed', 'not-run', 'missing', 'pending'].find((k) => names[k].length);
      evidence = worst
        ? { tag: worst, head: expectedHead, names, ...(wrongApp.size ? { wrongApp: Object.fromEntries(wrongApp) } : {}) }
        : { tag: 'passed', head: expectedHead, required: passed };
    }

    // The final re-read, for EVERY outcome (a proven-empty inventory included): the evidence stands only if the PR is still this candidate.
    const pr2 = readPrCandidate(deps, cwd, { repo, prNumber });
    if (!pr2.ok) return fromFault(pr2);
    const code2 = ineligibleCode(pr2.value, ctx);
    if (code2) return { tag: 'ineligible', code: code2, head: pr2.value.headRefOid };
    return evidence;
  } catch (e) {
    return unknownOf('unexpected-tag', `the oracle threw: ${show(e?.message ?? e)}`);
  }
}
