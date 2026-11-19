/**
 * @fileoverview Did every REQUIRED check actually RUN, and pass, on this PR head?
 *
 * GitHub counts a SKIPPED check as satisfying a required check, so a PR made
 * ready while its draft-time runs were skipped can merge seconds later on checks
 * that never ran (wine-cellar-app #802). This module answers the question that
 * matters for landing, with three facts kept apart:
 *
 *  - **inventory** — which checks are required, ASKED (rulesets via `gh api`, or
 *    `.fleet.json` `requiredChecks`), never inferred from what happened to run;
 *  - **observation** — every check on the PR, so a required check that never
 *    appeared is `missing`, not "not required";
 *  - **head binding** — the PR head read before AND after the observation; a head
 *    that moved in between makes the observation `unknown`.
 *
 * `requiredChecksVerdict` is the ONE predicate (status, pr-mode approval, serial
 * landing). Nothing here throws.
 *
 * Plan: docs/plans/fleet-consumer-feedback-oct.md §2.2.
 *
 * @module scripts/lib/fleet/required-checks
 */
import { classifyGhFailure, ghSpawnFailure, spawnGh } from './gh-facts.mjs';
import { readBranchProtection, readBranchRules, readCheckRuns, readCommitStatuses, readPrCandidate } from './github-ci-facts.mjs';

/** `gh pr checks --json` fields requested (all real — see the recorded fixture). */
export const CHECKS_FIELDS = Object.freeze(['name', 'state', 'bucket', 'completedAt']);

/** Verdicts, worst first. `pass` and `none-required` are the only ones that permit a merge. */
export const VERDICTS = Object.freeze(['failed', 'not-run', 'missing', 'pending', 'unknown', 'pass', 'none-required']);
export const MERGEABLE = Object.freeze(new Set(['pass', 'none-required']));

/**
 * A `gh` runner in `train.mjs:ghRun`'s shape — `(args, cwd) => {ok, status, stdout,
 * stderr, reason}` — so `land` can inject its own `deps.gh`. A spawn failure is
 * `{ok:false, status:null}` with the reason.
 */
export function ghRunner({ ghBin = 'gh', env } = {}) {
  return (args, cwd) => {
    const res = spawnGh(cwd, args, { ghBin, env });
    if (res.error) return { ok: false, status: null, stdout: '', stderr: '', reason: ghSpawnFailure(res) };
    const stderr = String(res.stderr ?? '');
    return { ok: res.status === 0, status: res.status, stdout: String(res.stdout ?? ''), stderr, reason: res.status === 0 ? null : classifyGhFailure(stderr) };
  };
}

const parseJson = (text) => { try { return { ok: true, value: JSON.parse(String(text)) }; } catch { return { ok: false }; } };

/**
 * Required-check context names from a `GET repos/{o}/{r}/rules/branches/{b}`
 * response (the rules that apply to the branch; readable without admin).
 * @param {string} text
 * @returns {{ok: true, names: string[]} | {ok: false, reason: string}}
 */
export function parseRulesInventory(text) {
  const j = parseJson(text);
  if (!j.ok || !Array.isArray(j.value)) return { ok: false, reason: 'rules API returned an unparseable or non-list response' };
  const names = new Set();
  for (const rule of j.value) {
    if (!rule || typeof rule !== 'object' || rule.type !== 'required_status_checks') continue;
    const list = rule.parameters?.required_status_checks;
    if (!Array.isArray(list)) return { ok: false, reason: 'rules API returned a required_status_checks rule without a list' };
    for (const c of list) {
      if (!c || typeof c.context !== 'string' || !c.context) return { ok: false, reason: 'rules API returned a required check without a context name' };
      names.add(c.context);
    }
  }
  return { ok: true, names: [...names].sort() };
}

/**
 * Classic branch protection's required contexts from `GET repos/{o}/{r}/branches/{b}`
 * (readable without admin, unlike the protection endpoint). An unprotected branch is
 * a valid EMPTY answer.
 * @returns {{ok: true, names: string[]} | {ok: false, reason: string}}
 */
export function parseBranchProtection(text) {
  const j = parseJson(text);
  if (!j.ok || !j.value || typeof j.value !== 'object' || Array.isArray(j.value)) return { ok: false, reason: 'branch API returned an unparseable response' };
  if (j.value.protected === false) return { ok: true, names: [] };
  const protection = j.value.protection;
  if (!protection || typeof protection !== 'object') return { ok: false, reason: 'branch is protected but its protection details are not readable' };
  const rsc = protection.required_status_checks;
  if (rsc === undefined || rsc === null) return { ok: true, names: [] };
  const contexts = Array.isArray(rsc.contexts) ? rsc.contexts : Array.isArray(rsc.checks) ? rsc.checks.map((c) => c?.context) : null;
  if (!contexts || contexts.some((c) => typeof c !== 'string' || !c)) return { ok: false, reason: 'branch API returned malformed required contexts' };
  return { ok: true, names: [...new Set(contexts)].sort() };
}

/**
 * Which checks are required on `base`: the union of rulesets (`rules/branches`),
 * classic branch protection (`branches/<b>`) and `.fleet.json` `requiredChecks`.
 * BOTH GitHub sources must answer for the inventory to be complete; if either
 * cannot be read, only an explicit config list (which the operator vouches for)
 * keeps it known — otherwise `unknown`, never "none required". A config that
 * failed to load is `unknown` too, never "not declared".
 * @param {string} cwd
 * @param {{repo: string|null, base: string, configured?: string[]|undefined, configError?: string|null, gh?: Function}} a
 * @returns {{source: 'rules-api'|'config'|'rules-api+config'|'unknown', names: string[], reason?: string}}
 */
export function requiredInventory(cwd, { repo, base, configured, configError = null, gh = ghRunner() }) {
  if (configError) return { source: 'unknown', cause: 'config', names: [], reason: `.fleet.json could not be loaded (${configError}) — fix it before approving` };
  const hasConfig = Array.isArray(configured);
  const ask = (args, parse) => {
    if (!repo) return { ok: false, reason: 'no repository to ask' };
    const res = gh(args, cwd);
    return res.ok ? parse(res.stdout) : { ok: false, reason: res.reason ?? 'gh api failed' };
  };
  const enc = encodeURIComponent(base);
  const rules = ask(['api', `repos/${repo}/rules/branches/${enc}`], parseRulesInventory);
  const classic = ask(['api', `repos/${repo}/branches/${enc}`], parseBranchProtection);
  const names = [...new Set([...(rules.ok ? rules.names : []), ...(classic.ok ? classic.names : []), ...(configured ?? [])])].sort();
  if (rules.ok && classic.ok) {
    if (!names.length && !hasConfig) {
      return { source: 'unknown', cause: 'none-declared', names: [], reason: 'neither rulesets nor branch protection require a status check — declare .fleet.json "requiredChecks": [] to confirm none are required' };
    }
    return { source: hasConfig ? 'github+config' : 'github', names };
  }
  if (hasConfig) return { source: 'config', names, partial: [rules, classic].filter((x) => !x.ok).map((x) => x.reason) };
  const why = [!rules.ok && `rulesets not readable (${rules.reason})`, !classic.ok && `branch protection not readable (${classic.reason})`].filter(Boolean).join('; ');
  return { source: 'unknown', cause: 'unreadable', names: [], reason: `${why} — declare the required checks in .fleet.json "requiredChecks" ([] if none)` };
}

/**
 * Parse `gh pr checks --json name,state,bucket,completedAt` stdout.
 * @returns {{ok: true, checks: Array<{name: string, bucket: string, state: string, completedAt: string|null}>} | {ok: false, reason: string}}
 */
export function parseChecksJson(text) {
  const j = parseJson(text);
  if (!j.ok || !Array.isArray(j.value)) return { ok: false, reason: 'gh pr checks returned unparseable JSON' };
  const checks = [];
  for (const c of j.value) {
    if (typeof c?.name !== 'string' || typeof c?.bucket !== 'string') return { ok: false, reason: 'gh pr checks returned a malformed record' };
    checks.push({ name: c.name, bucket: c.bucket, state: typeof c.state === 'string' ? c.state : '', completedAt: typeof c.completedAt === 'string' && c.completedAt ? c.completedAt : null });
  }
  return { ok: true, checks };
}

/** One record per check name: any in-flight run wins (a re-run is in progress); else the latest completed. */
function latestByName(checks) {
  const by = new Map();
  for (const c of checks) {
    const cur = by.get(c.name);
    if (!cur) { by.set(c.name, c); continue; }
    if (cur.bucket === 'pending') continue;
    if (c.bucket === 'pending' || String(c.completedAt ?? '') > String(cur.completedAt ?? '')) by.set(c.name, c);
  }
  return by;
}

/**
 * THE predicate. `pass` only when every inventory name was observed with bucket
 * `pass` on the bound head. A required check observed as `skipping` is `not-run`
 * — SKIPPED never satisfies a required check — and one never observed is
 * `missing`, never "not required".
 * @param {{inventory: {source: string, names: string[], reason?: string}, observed: object[]|null, headBound: boolean, reason?: string}} r
 * @returns {{verdict: string, names: Record<string, string[]>, reason?: string}}
 */
export function requiredChecksVerdict({ inventory, observed, headBound, reason }) {
  const empty = { failed: [], 'not-run': [], missing: [], pending: [] };
  if (!inventory || inventory.source === 'unknown') return { verdict: 'unknown', names: empty, reason: inventory?.reason ?? 'required-check inventory unknown' };
  if (inventory.names.length === 0) return { verdict: 'none-required', names: empty };
  if (!observed || !headBound) return { verdict: 'unknown', names: empty, reason: reason ?? 'checks not observed on a bound head' };
  const by = latestByName(observed);
  const names = { failed: [], 'not-run': [], missing: [], pending: [] };
  for (const n of inventory.names) {
    const c = by.get(n);
    if (!c) names.missing.push(n);
    else if (c.bucket === 'pass') continue;
    else if (c.bucket === 'skipping') names['not-run'].push(n);
    else if (c.bucket === 'pending') names.pending.push(n);
    else names.failed.push(n); // fail, cancel, and anything unrecognised: never a pass
  }
  const verdict = ['failed', 'not-run', 'missing', 'pending'].find((v) => names[v].length) ?? 'pass';
  return { verdict, names };
}

/** `headRefOid` of PR `n`, or a reason. */
function prHead(cwd, { pr, repo, gh }) {
  const res = gh(['pr', 'view', String(pr), '-R', repo, '--json', 'headRefOid'], cwd);
  if (!res.ok) return { ok: false, reason: res.reason ?? 'gh pr view failed' };
  const j = parseJson(res.stdout);
  return j.ok && typeof j.value?.headRefOid === 'string' ? { ok: true, oid: j.value.headRefOid } : { ok: false, reason: 'gh pr view returned no headRefOid' };
}

/**
 * Observe PR `pr`'s checks against `inventory`, bound to its head.
 * `gh pr checks` exits 1 (a check failed) or 8 (pending) WITH a valid JSON answer,
 * so stdout is parsed whatever the exit status; only an unparseable answer is a failure.
 * @param {string} cwd
 * @param {{pr: number, repo: string, inventory: object, expectHead?: string|null, gh?: ReturnType<typeof ghRunner>}} a
 * @returns {{headOid: string|null, inventory: object, observed: object[], complete: boolean, verdict: string, names: object, reason?: string}}
 */
export function observeRequiredChecks(cwd, { pr, repo, inventory, expectHead = null, gh = ghRunner() }) {
  const done = (headOid, observed, complete, reason) => {
    const v = requiredChecksVerdict({ inventory, observed, headBound: complete, reason });
    return { headOid, inventory, observed: observed ?? [], complete, ...v, ...(v.reason || reason ? { reason: v.reason ?? reason } : {}) };
  };
  if (inventory?.source === 'unknown') return done(null, null, false, inventory.reason);
  const before = prHead(cwd, { pr, repo, gh });
  if (!before.ok) return done(null, null, false, before.reason);
  if (expectHead && before.oid !== expectHead) return done(before.oid, null, false, `PR head is ${before.oid.slice(0, 12)}, not the expected ${expectHead.slice(0, 12)}`);
  const res = gh(['pr', 'checks', String(pr), '-R', repo, '--json', CHECKS_FIELDS.join(',')], cwd);
  if (res.status === null) return done(before.oid, null, false, res.reason ?? 'gh pr checks did not run');
  let parsed = parseChecksJson(res.stdout);
  // "no checks reported" is a valid, empty observation (exit 1 with that message and no JSON).
  if (!parsed.ok && /no checks reported/i.test(String(res.stderr))) parsed = { ok: true, checks: [] };
  if (!parsed.ok) return done(before.oid, null, false, res.status === 0 ? parsed.reason : (res.reason ?? classifyGhFailure(res.stderr)));
  const after = prHead(cwd, { pr, repo, gh });
  if (!after.ok) return done(before.oid, parsed.checks, false, after.reason);
  if (after.oid !== before.oid) return done(after.oid, parsed.checks, false, 'PR head moved during observation');
  return done(before.oid, parsed.checks, true);
}

/** One line naming what blocks a merge, e.g. "not-run: ci, lint; missing: e2e". Empty for a mergeable verdict. */
export function describeVerdict(v) {
  if (MERGEABLE.has(v.verdict)) return '';
  if (v.verdict === 'unknown') return `required checks unknown (${v.reason ?? 'not observed'})`;
  return ['failed', 'not-run', 'missing', 'pending'].filter((k) => v.names?.[k]?.length).map((k) => `${k}: ${v.names[k].join(', ')}`).join('; ');
}

// ---- the CI-evidence contract (docs/plans/ci-evidence-oracle.md §2.1-2.2) -------------------------------------------------------
// Evidence is WHAT IS KNOWN about a PR head's required CI, from a closed tag set. A disposition is WHAT A CALLER DOES about it.
// The oracle that produces evidence (`assessRequiredCi`, PR 2) never returns an action; `decideCiAdmission` never reads GitHub.

/** The closed evidence tag set. `passed` and `none-required` are the only ones that can permit a merge. */
export const CI_EVIDENCE_TAGS = Object.freeze(['passed', 'none-required', 'failed', 'not-run', 'missing', 'pending', 'ineligible', 'unknown']);

/** The closed fault kinds an `unknown` may carry (§2.4). `unimplemented-oracle` exists only while the oracle is a stub (PR 1). */
export const CI_FAULT_KINDS = Object.freeze([
  'transport', 'malformed', 'too-many-results', 'unsupported-classic-protection', 'unsupported-unpinned-requirement',
  'status-context-present', 'unsupported-rule-type', 'config-error', 'config-drift', 'duplicate-conflict', 'unknown-conclusion', 'unexpected-tag', 'unimplemented-oracle',
]);

/** The closed `ineligible` codes. `head-moved` is the only one a caller may retry. */
export const CI_INELIGIBLE_CODES = Object.freeze(['closed', 'merged', 'draft', 'retargeted', 'head-moved']);

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

/**
 * The stub oracle (PR 1): it establishes nothing, so every assessment is `unknown` and every caller stops the run. A production
 * default of this keeps `--ship-batch` and `--rollup` unable to merge until `assessRequiredCi` replaces it.
 * @returns {{tag: 'unknown', fault: {kind: 'unimplemented-oracle', detail: string}}}
 */
export function unimplementedOracle() {
  return { tag: 'unknown', fault: { kind: 'unimplemented-oracle', detail: 'the CI-evidence oracle is not implemented yet (docs/plans/ci-evidence-oracle.md, PR 2): this command cannot merge' } };
}

/** One line naming the evidence, for a refusal or stop reason. Never empty. */
export function describeEvidence(evidence, decision = decideCiAdmission(evidence)) {
  const list = (k) => (Array.isArray(evidence?.names?.[k]) ? evidence.names[k].map((x) => show(x)) : []);
  const names = ['failed', 'not-run', 'missing', 'pending'].filter((k) => list(k).length).map((k) => `${k}: ${list(k).join(', ')}`);
  if (evidence?.tag === 'unknown' || decision.disposition === 'stop-run') return `CI evidence unknown (${decision.fault?.kind ?? 'unknown'}: ${decision.fault?.detail ?? 'no detail'})`;
  if (evidence?.tag === 'ineligible') return `the PR is not a merge candidate (${show(evidence.code)})`;
  if (decision.disposition === 'permit') return `required checks ${decision.tag}`;
  return `required checks ${decision.tag}${names.length ? `: ${names.join('; ')}` : ''}`;
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

/** Why a PR is not a merge candidate at the expected base and head, or null. The ONE copy of the eligibility rule. */
function ineligibleCode(pr, { expectedBase, expectedHead }) {
  const state = pr.state.toUpperCase();
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
 * THE oracle: the CI evidence for PR `prNumber` at `expectedHead`, as ONE value from the closed tag set. It reads (in this order, each
 * step needing the last): the PR, the branch (proving it exists and that classic protection is off), the rules, the config assertion, the
 * check runs and statuses of the immutable head, and the PR again. It never returns an action and never throws; every doubt is `unknown`.
 * @param {{repo: string, prNumber: number, expectedBase: string, expectedHead: string, configAssertion?: {requiredChecks?: string[], error?: string|null}}} a
 * @param {{gh: Function, cwd?: string}} deps
 * @returns {{tag: string, head?: string, code?: string, names?: object, required?: object[], wrongApp?: object, fault?: {kind: string, detail: string}}}
 */
export function assessRequiredCi({ repo, prNumber, expectedBase, expectedHead, configAssertion }, deps) {
  const cwd = deps?.cwd ?? '.';
  const ctx = { expectedBase, expectedHead };
  try {
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

      const names = { failed: [], 'not-run': [], missing: [], pending: [] }; const wrongApp = {}; const passed = [];
      for (const pair of pairs) {
        const r = assessPair(pair, runs.value);
        if (r.fault) return { tag: 'unknown', fault: r.fault };
        if (r.cls === 'passed') passed.push({ name: pair.context, conclusion: 'success', appId: pair.integrationId });
        else { names[r.cls].push(pair.context); if (r.wrongApp?.length) wrongApp[pair.context] = r.wrongApp; }
      }
      const worst = ['failed', 'not-run', 'missing', 'pending'].find((k) => names[k].length);
      evidence = worst
        ? { tag: worst, head: expectedHead, names, ...(Object.keys(wrongApp).length ? { wrongApp } : {}) }
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
