/**
 * @fileoverview The conditions under which a chip may ship ITSELF — the pre-authorised ship (coordinator rules 1 and 4;
 * docs/plans/fleet-chips-and-merge-friction.md section 2.2b).
 *
 * `/ship` is user-only by design (it cannot be invoked programmatically). A chip's launch prompt may nevertheless pre-authorise
 * the ship steps, but only while a fixed set of conditions holds. Until now those conditions lived in prose a chip read about
 * itself, which is the weakest place for a check on the actor it constrains: a chip that has just spent hours on a change is the
 * one most able to talk itself past "no sensitive paths". So the decision is code, in ONE place, and `ship-commit.mjs
 * --preauthorised` refuses to commit unless it returns `ok`.
 *
 * **Pure.** `evaluatePreauthorisedShip` takes already-gathered facts and returns a verdict with one row per condition, so
 * every refusal names its own reason and the direction the check must NOT fire is as testable as the one it must. The CLI
 * only gathers. **Fail closed**: an unknown fact (cloud off, a store read that failed, no evidence run, an unresolvable base
 * or tree, a missing or mismatched final-review marker) refuses with its own reason; nothing here ever turns an unknown
 * into a pass.
 *
 * @module scripts/lib/ship-preauth
 */
import { classifyPath, normalisePath } from './sensitive-paths.mjs';
import { matchFinalReviewMarker } from './final-review-marker.mjs';

/** The conditions, in the order they are reported. The ids are the refusal names the plan fixes. */
export const PREAUTH_CONDITIONS = Object.freeze([
  'gate', 'audit-converged', 'final-review', 'sensitive-path', 'migration', 'repo-policy',
]);

/**
 * Repository-policy files: what decides who may merge and what grades a merge. An EXPLICIT list, not a reuse of the
 * sensitive-path classifier: `classifyPath` answers "may this be sent to a third-party LLM" and says nothing about
 * ownership or merge policy (it returns null for `.github/workflows/x.yml` and for `docs/CODEOWNERS`).
 *
 * `.github/` covers workflows, rulesets-as-code and CODEOWNERS. The root `CODEOWNERS` and `docs/CODEOWNERS` are the other
 * two places GitHub reads it from. `.test-tiers.json` names the workflow that grades a merge (`ciVerdict`). GitHub
 * settings changed through the API are outside a chip's authority by its launch prompt and are not a file.
 */
export const PREAUTH_POLICY_PATHS = Object.freeze({ prefixes: ['.github/'], exact: ['codeowners', 'docs/codeowners', '.test-tiers.json'] });

const norm = (p) => normalisePath(String(p ?? ''));

/** A path inside any `migrations` directory (`supabase/migrations/**`, `scripts/migrations/**`, or any other). */
export const isMigrationPath = (p) => norm(p).split('/').slice(0, -1).includes('migrations');

/** A repository-policy file (see PREAUTH_POLICY_PATHS). Matched on the normalised repo-relative path. */
export function isPolicyPath(p) {
  const n = norm(p);
  return PREAUTH_POLICY_PATHS.prefixes.some((x) => n.startsWith(x)) || PREAUTH_POLICY_PATHS.exact.includes(n);
}

/** Sensitive per the single oracle (scripts/lib/sensitive-paths.mjs). */
export const isSensitivePath = (p) => classifyPath(p) === 'sensitive';

const row = (id, ok, reason) => ({ id, ok, reason });

/**
 * The three path rows (sensitive, migration, repo-policy) over one change set. Shared by the chip's own pre-authorised ship and
 * the coordinator's batch re-check, so the two cannot disagree about what a shippable change set is. An unresolvable or empty
 * set fails all three: nothing was checked, and nothing may read as clean.
 */
function pathRows(changedPaths) {
  const paths = Array.isArray(changedPaths) ? changedPaths : null;
  const pathRow = (id, test, what) => {
    if (!paths) return row(id, false, 'the changed paths could not be resolved (no merge base or tree), so nothing was checked');
    if (paths.length === 0) return row(id, false, 'the branch changes no paths against the default branch: nothing to ship, and an empty set must not read as clean');
    const hit = paths.filter(test);
    return hit.length ? row(id, false, `${what}: ${hit.slice(0, 3).join(', ')}${hit.length > 3 ? `, +${hit.length - 3} more` : ''}`) : row(id, true, `none of ${paths.length} changed path(s)`);
  };
  return [
    pathRow('sensitive-path', isSensitivePath, 'touches sensitive path(s)'),
    pathRow('migration', isMigrationPath, 'touches a database migration'),
    pathRow('repo-policy', isPolicyPath, 'touches repository-policy file(s) (.github/, CODEOWNERS, .test-tiers.json)'),
  ];
}

/**
 * @param {object} f already-gathered facts
 * @param {string|null} f.gate the EFFECTIVE gate value (after every cap ship-commit applies)
 * @param {boolean} [f.noTests] --no-tests was passed (it caps the gate downward and is refused outright here)
 * @param {boolean} [f.gateDeferred] the preflight has no `--gate` to judge: the gate row then reads "checked at commit"
 * @param {{roundConvergedAfter: number|null}|null} f.convergence the store row for the evidence run, or null when unreadable
 * @param {string} [f.convergenceWhy] why the row is null (cloud off, the query failed, no row): named in the refusal, never folded into one
 * @param {{runId: string, auditedTree: string, round: number|null, auditedBranch?: string|null}|null} f.evidence the gate-evidence marker
 * @param {string|null} [f.currentBranch] the branch being shipped (null = detached or unresolved)
 * @param {{ok: boolean, reason?: string, marker?: {runId: string, auditedTree: string, round: number, verdict: string, disposition: string|null}}|null} f.finalReview readFinalReviewMarker's result
 * @param {string[]|null} f.changedPaths every path the branch changes against the default branch, or null when it could not be resolved
 * @returns {{ok: boolean, conditions: Array<{id: string, ok: boolean, reason: string}>, refusals: string[]}}
 */
export function evaluatePreauthorisedShip(f = {}) {
  const c = [];

  // 1. gate — the EFFECTIVE gate. `--no-tests` caps it to waived/not-run, so a supplied `--gate passed` can never authorise
  //    a commit whose final gate was downgraded (REQ-behavioural-19096e7a); it is refused outright rather than reconciled.
  if (f.noTests) c.push(row('gate', false, '--no-tests skips the hooks and caps AI-Gate at waived/not-run; a pre-authorised ship may not skip them'));
  else if (f.gateDeferred) c.push(row('gate', true, 'checked at commit (the commit path verifies passed/converged against the store)'));
  else if (f.gate === 'passed' || f.gate === 'converged') c.push(row('gate', true, `effective gate is ${f.gate}`));
  else c.push(row('gate', false, `effective gate is ${JSON.stringify(f.gate ?? null)}; only passed or converged may be pre-authorised`));

  // 2. the audit converged — the store's own record for the evidence run, never a local claim.
  const conv = f.convergence;
  if (!conv) c.push(row('audit-converged', false, `no audit_runs row could be read for the evidence run (${f.convergenceWhy ?? 'cloud off, unreachable, or run not found'})`));
  else if (!Number.isInteger(conv.roundConvergedAfter)) c.push(row('audit-converged', false, 'audit_runs.round_converged_after is null: the audit did not converge'));
  else if (!f.evidence || typeof f.evidence.auditedBranch !== 'string' || !f.evidence.auditedBranch || typeof f.currentBranch !== 'string' || !f.currentBranch) {
    // Two unknowns are not equal: both null (a detached audit shipped from a detached head, or an unresolved branch) must
    // not satisfy the binding by coincidence.
    c.push(row('audit-converged', false, `the branch identity is unknown (audit evidence: ${JSON.stringify(f.evidence?.auditedBranch ?? null)}, shipping: ${JSON.stringify(f.currentBranch ?? null)}); both must be known branch names`));
  } else if (f.evidence.auditedBranch !== f.currentBranch) {
    // The marker is a local file, so a stale one from ANOTHER branch's audit can sit in .audit/ and read fresh.
    // (Not the audited commit's ancestry: a rebase after the audit legitimately rewrites it.)
    c.push(row('audit-converged', false, `the audit evidence is for branch ${JSON.stringify(f.evidence.auditedBranch)}, not ${JSON.stringify(f.currentBranch)}`));
  } else c.push(row('audit-converged', true, `converged after round ${conv.roundConvergedAfter}`));

  // 3. the final review approved THIS audited tree and round, not merely this run (the column has no target identity). The binding
  //    is the shared predicate; the policy below it is this caller's: the verdict word AND the review's result must both approve.
  //    The result is the stronger fact (an APPROVE can be `blocked`: a release-blocking finding, a coverage downgrade, a required
  //    subject not received in full), and the one place that ships without a human must not leave a recorded block unenforced.
  const ev = f.evidence;
  const fr = f.finalReview;
  const bound = matchFinalReviewMarker(ev, fr);
  if (!bound.ok) c.push(row('final-review', false, bound.reason));
  else if (fr.marker.verdict !== 'APPROVE') c.push(row('final-review', false, `the recorded final review is ${fr.marker.verdict}, not APPROVE`));
  else if (fr.marker.disposition == null) c.push(row('final-review', false, 'the final-review marker predates dispositions: re-run the final review'));
  else if (fr.marker.disposition !== 'approve') c.push(row('final-review', false, `the recorded final-review result is ${fr.marker.disposition}, not approve`));
  else c.push(row('final-review', true, `APPROVE (result approve) on run ${ev.runId.slice(0, 8)}, round ${ev.round}, the audited tree`));

  // 4-6. paths. An unresolvable change set fails all three rather than passing them vacuously.
  c.push(...pathRows(f.changedPaths));

  const refusals = c.filter((x) => !x.ok).map((x) => `${x.id}: ${x.reason}`);
  return { ok: refusals.length === 0, conditions: c, refusals };
}

/** The batch re-check's conditions, in the order they are reported (docs/plans/coordinator-aggregate-ship.md section 2.3, C1-C5). */
export const SHIPPED_HEAD_CONDITIONS = Object.freeze([
  'trailers', 'evidence', 'final-review', 'post-audit-delta', 'sensitive-path', 'migration', 'repo-policy',
]);

const AI_GATE_SHIPPABLE = new Set(['passed', 'converged']);

/**
 * May a coordinator land THIS already-shipped member without the user (docs/plans/coordinator-aggregate-ship.md section 2.3)?
 * The chip ships itself through `ship-commit.mjs --preauthorised`; this re-judges the result from durable facts alone, at merge
 * time, by an actor that is not the chip. **Pure** and **fail closed**: an unknown fact refuses with its own reason; the
 * evaluator READS the member's gate and never raises it, so a `waived` or `not-run` member cannot become shippable here.
 *
 * @param {object} f already-gathered facts (lib/ship-shipped-head.mjs gathers them)
 * @param {Array<{key: string, value: string}>|null} f.trailers the parsed trailers of the head commit's message, or null when unreadable
 * @param {{runId: string, auditedTree?: string|null, round?: number|null, auditedBranch?: string|null}|null} f.evidence the member worktree's gate-evidence marker, when content-verifiable
 * @param {string} [f.evidenceWhy] why `evidence` is null
 * @param {string|null} f.currentBranch the branch checked out in the member worktree
 * @param {{repoId: string|null, roundConvergedAfter: number|null, auditedTree?: string|null, geminiVerdict?: string|null}|null} f.runRow the store row for the run
 * @param {string} [f.runRowWhy] why `runRow` is null
 * @param {string|null} f.repoId this repository's row id in the store
 * @param {ReturnType<typeof import('./final-review-marker.mjs').readFinalReviewMarker>|null} f.finalReview the member worktree's final-review marker
 * @param {{ok: boolean, reason?: string}|null} f.delta the post-audit delta verdict (null = not measured)
 * @param {string[]|null} f.changedPaths every path the branch changes against the default branch
 * @returns {{ok: boolean, gate: string|null, runId: string|null, conditions: Array<{id: string, ok: boolean, reason: string}>, refusals: string[]}}
 */
export function evaluateShippedHead(f = {}) {
  const c = [];
  const tr = Array.isArray(f.trailers) ? f.trailers : null;
  const all = (key) => (tr ?? []).filter((t) => t.key === key).map((t) => t.value);
  const one = (key) => { const v = all(key); return v.length === 1 ? v[0] : null; };
  const gate = one('AI-Gate');
  const runId = one('AI-Run-ID');

  // 1. trailers — parseable git trailers on the head commit, exactly one of each, and a shippable verified gate.
  if (!tr) c.push(row('trailers', false, 'the head commit message could not be read, so its trailers were not checked'));
  else {
    const bad = [];
    for (const key of ['AI-Skill', 'AI-Ship-Authority', 'AI-Gate', 'AI-Final-Review', 'AI-Run-ID']) {
      const n = all(key).length;
      if (n === 0) bad.push(`${key} is missing (an inline text block is not a trailer)`);
      else if (n > 1) bad.push(`${key} appears ${n} times`);
    }
    if (one('AI-Skill') !== null && one('AI-Skill') !== 'ship') bad.push(`AI-Skill is ${JSON.stringify(one('AI-Skill'))}, not ship`);
    if (one('AI-Ship-Authority') !== null && one('AI-Ship-Authority') !== 'launch-prompt') bad.push(`AI-Ship-Authority is ${JSON.stringify(one('AI-Ship-Authority'))}, not launch-prompt`);
    if (gate !== null && !AI_GATE_SHIPPABLE.has(gate)) bad.push(`AI-Gate is ${JSON.stringify(gate)}; only passed or converged may ship without the user`);
    if (one('AI-Final-Review') !== null && one('AI-Final-Review') !== 'approve') bad.push(`AI-Final-Review is ${JSON.stringify(one('AI-Final-Review'))}, not approve`);
    c.push(bad.length ? row('trailers', false, bad.join('; ')) : row('trailers', true, `AI-Gate ${gate}, final review approve, launch-prompt ship, run ${runId.slice(0, 8)}`));
  }

  // 2. evidence — the SAME local marker the chip shipped against, bound to this run, this branch and this repository, and the
  //    store's own record of that run. A trailer alone proves nothing: it is text any commit can carry.
  const ev = f.evidence ?? null;
  const rr = f.runRow ?? null;
  if (!ev) c.push(row('evidence', false, `no usable gate-evidence marker in the member worktree (${f.evidenceWhy ?? 'absent, unreadable or not content-verifiable'}): evidence-unavailable`));
  else if (runId === null) c.push(row('evidence', false, 'the head commit carries no single AI-Run-ID to bind the evidence to'));
  else if (ev.runId !== runId) c.push(row('evidence', false, `the gate-evidence marker is run ${String(ev.runId).slice(0, 8)}, the commit's AI-Run-ID is ${runId.slice(0, 8)}`));
  else if (typeof ev.auditedBranch !== 'string' || !ev.auditedBranch || typeof f.currentBranch !== 'string' || !f.currentBranch) {
    c.push(row('evidence', false, `the branch identity is unknown (audit evidence: ${JSON.stringify(ev.auditedBranch ?? null)}, shipping: ${JSON.stringify(f.currentBranch ?? null)}); both must be known branch names`));
  } else if (ev.auditedBranch !== f.currentBranch) c.push(row('evidence', false, `the audit evidence is for branch ${JSON.stringify(ev.auditedBranch)}, not ${JSON.stringify(f.currentBranch)}`));
  else if (!rr) c.push(row('evidence', false, `no audit_runs row could be read for the run (${f.runRowWhy ?? 'cloud off, unreachable, or run not found'})`));
  else if (!Number.isInteger(rr.roundConvergedAfter)) c.push(row('evidence', false, 'audit_runs.round_converged_after is null: the audit did not converge'));
  else if (!Number.isInteger(ev.round) || ev.round < rr.roundConvergedAfter) c.push(row('evidence', false, `the evidence marker is round ${ev.round ?? 'unknown'} but the store says the audit converged after round ${rr.roundConvergedAfter}: the marker is from before it converged`));
  else if (rr.branch != null && rr.branch !== f.currentBranch) c.push(row('evidence', false, `the store records the run on branch ${JSON.stringify(rr.branch)}, this worktree is on ${JSON.stringify(f.currentBranch)}`));
  else if (f.repoId == null || rr.repoId == null) c.push(row('evidence', false, `the repository identity could not be established (this repo: ${JSON.stringify(f.repoId ?? null)}, the run's repo: ${JSON.stringify(rr.repoId ?? null)})`));
  else if (rr.repoId !== f.repoId) c.push(row('evidence', false, 'the run belongs to another repository'));
  else if (rr.auditedTree == null || ev.auditedTree == null) c.push(row('evidence', false, `the audited tree is not recorded on both sides (store: ${rr.auditedTree == null ? 'none, a row from before audited-tree identity' : 'yes'}; marker: ${ev.auditedTree == null ? 'none' : 'yes'}), so the run cannot be bound to the tree the review approved`));
  else if (rr.auditedTree !== ev.auditedTree) c.push(row('evidence', false, 'the store records a different audited tree for the run than the evidence marker names'));
  else if (rr.auditedSha == null || ev.auditedSha == null || rr.auditedSha !== ev.auditedSha) c.push(row('evidence', false, `the audited COMMIT is not corroborated (store: ${rr.auditedSha ? rr.auditedSha.slice(0, 12) : 'none'}, marker: ${ev.auditedSha ? ev.auditedSha.slice(0, 12) : 'none'}): it picks the fork point the audited paths are measured from, so it must match what the store recorded`));
  else c.push(row('evidence', true, `run ${runId.slice(0, 8)} converged after round ${rr.roundConvergedAfter}, this repository, branch ${ev.auditedBranch}`));

  // 3. final review — bound to the SAME run, audited tree and round, saying APPROVE with result approve, and the store's
  //    recorded verdict must agree (it carries no target of its own, so it corroborates and never replaces the marker).
  const fr = f.finalReview ?? null;
  const bound = matchFinalReviewMarker(ev, fr);
  if (!bound.ok) c.push(row('final-review', false, bound.reason));
  else if (fr.marker.verdict !== 'APPROVE') c.push(row('final-review', false, `the recorded final review is ${fr.marker.verdict}, not APPROVE`));
  else if (fr.marker.disposition == null) c.push(row('final-review', false, 'the final-review marker predates dispositions: re-run the final review'));
  else if (fr.marker.disposition !== 'approve') c.push(row('final-review', false, `the recorded final-review result is ${fr.marker.disposition}, not approve`));
  else if (!rr || rr.geminiVerdict == null) c.push(row('final-review', false, 'final-review-unrecorded: the store holds no final-review verdict for the run, so the marker is uncorroborated'));
  else if (String(rr.geminiVerdict).toUpperCase() !== 'APPROVE') c.push(row('final-review', false, `the store records the run's final review as ${rr.geminiVerdict}, the marker says APPROVE`));
  else c.push(row('final-review', true, `APPROVE (result approve) on run ${runId?.slice(0, 8)}, round ${ev.round}, the audited tree, corroborated by the store`));

  // 4. the delta between the AUDITED tree and the shipped head is only what /ship itself writes.
  if (!f.delta) c.push(row('post-audit-delta', false, 'the post-audit delta was not measured, so nothing was checked'));
  else c.push(f.delta.ok ? row('post-audit-delta', true, f.delta.reason ?? 'only ship-step edits since the audit') : row('post-audit-delta', false, f.delta.reason ?? 'a change since the audit is not a ship-step edit'));

  // 5. paths — the same three rows the chip's own ship ran.
  c.push(...pathRows(f.changedPaths));

  const refusals = c.filter((x) => !x.ok).map((x) => `${x.id}: ${x.reason}`);
  return { ok: refusals.length === 0, gate, runId, conditions: c, refusals };
}

/** One printable line per batch re-check condition. */
export function renderShippedHeadConditions(verdict) {
  return verdict.conditions.map((x) => `  ${x.ok ? 'ok     ' : 'REFUSED'} ${x.id.padEnd(16)} ${x.reason}`);
}

/** One printable line per condition, for the preflight and for a refusal. */
export function renderPreauthConditions(verdict) {
  return verdict.conditions.map((x) => `  ${x.ok ? 'ok     ' : 'REFUSED'} ${x.id.padEnd(15)} ${x.reason}`);
}

/**
 * Every path the branch changes against the default branch: `git diff --name-only --no-renames -z <merge-base> <tree>`.
 * `--no-renames` lists BOTH ends of a rename, so moving CODEOWNERS to docs/OWNERS is two paths and the first is policy.
 * `run(args)` is `git` in the repo; returns `{status, stdout}`. Returns null whenever any step cannot be resolved.
 *
 * @param {(args: string[]) => {status: number|null, stdout?: string}} run
 * @param {string} tree the tree-ish the commit will carry (a tree id, or HEAD)
 * @param {string} [head] the commit whose fork point is measured (default HEAD). The batch re-check passes the commit it was asked
 *   about, so no later read depends on what HEAD happens to be.
 * @param {string|null} [baseBranch] the branch the change targets (default: what `<remote>/HEAD` names). The batch re-check passes the
 *   branch the PR actually targets, so a PR into a non-default branch is measured against THAT branch.
 * @param {string} [remote] the remote that branch lives on (the train's destination remote; default `origin`)
 * @returns {string[]|null}
 */
export function gatherChangedPaths(run, tree, head = 'HEAD', baseBranch = null, remote = 'origin') {
  const out = (args) => { const r = run(args); return r && r.status === 0 ? String(r.stdout ?? '').trim() : null; };
  // ONE resolver for "the base": the head's change set and the audited tree's use the same function (defaultBaseRef), so they cannot disagree.
  const defaultRef = defaultBaseRef(run, baseBranch, remote);
  // origin/HEAD is the authoritative default branch; `origin/main` is the conventional remote-tracking name when HEAD is unset.
  // A LOCAL `main` is never substituted: it can differ from the remote's, and an unverified base can hide what the PR changes.
  // Discovery and resolution are separate: once origin/HEAD NAMES the default branch, that branch's merge base is the only
  // acceptable base. Failing to resolve it is a failure, never a reason to try a different branch; the conventional
  // `origin/main` is consulted only when origin/HEAD itself is unavailable.
  // FULLY QUALIFIED, never shortened: `origin/develop` can resolve to a LOCAL branch of that name (refs/heads/origin/develop is
  // searched before refs/remotes/), whose merge base with HEAD is HEAD itself and would hide every change.
  const base = out(['merge-base', head, defaultRef]);
  if (!base || !tree) return null;
  // `--ignore-submodules=none`: a `diff.ignoreSubmodules` setting must never hide a changed gitlink from a path gate.
  const r = run(['diff', '--name-only', '--no-renames', '--ignore-submodules=none', '-z', base, tree]);
  if (!r || r.status !== 0) return null;
  return String(r.stdout ?? '').split('\0').filter(Boolean);
}

/**
 * The fully-qualified default-branch ref the change set is measured against: `origin/HEAD`'s target, else the conventional
 * `refs/remotes/origin/main` (never a local `main`; see gatherChangedPaths). One resolver for the head's merge base and for the
 * AUDITED tree's, so the two candidate sets of the batch re-check are measured from the same base.
 * @param {(args: string[]) => {status: number|null, stdout?: string}} run
 * @param {string|null} [baseBranch] the branch the change targets, when it is not the default
 * @returns {string}
 */
export function defaultBaseRef(run, baseBranch = null, remote = 'origin') {
  if (baseBranch) return `refs/remotes/${remote}/${baseBranch}`;
  const r = run(['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`]);
  const ref = r && r.status === 0 ? String(r.stdout ?? '').trim() : '';
  return ref || `refs/remotes/${remote}/main`;
}
