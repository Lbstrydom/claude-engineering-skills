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
  if (configError) return { source: 'unknown', names: [], reason: `.fleet.json could not be loaded (${configError}) — fix it before approving` };
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
      return { source: 'unknown', names: [], reason: 'neither rulesets nor branch protection require a status check — declare .fleet.json "requiredChecks": [] to confirm none are required' };
    }
    return { source: hasConfig ? 'github+config' : 'github', names };
  }
  if (hasConfig) return { source: 'config', names, partial: [rules, classic].filter((x) => !x.ok).map((x) => x.reason) };
  const why = [!rules.ok && `rulesets not readable (${rules.reason})`, !classic.ok && `branch protection not readable (${classic.reason})`].filter(Boolean).join('; ');
  return { source: 'unknown', names: [], reason: `${why} — declare the required checks in .fleet.json "requiredChecks" ([] if none)` };
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
