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
 * @param {object} f already-gathered facts
 * @param {string|null} f.gate the EFFECTIVE gate value (after every cap ship-commit applies)
 * @param {boolean} [f.noTests] --no-tests was passed (it caps the gate downward and is refused outright here)
 * @param {boolean} [f.gateDeferred] the preflight has no `--gate` to judge: the gate row then reads "checked at commit"
 * @param {{roundConvergedAfter: number|null, geminiVerdict?: string|null}|null} f.convergence the store row for the evidence run, or null when unreadable
 * @param {{runId: string, auditedTree: string, round: number|null, auditedBranch?: string|null}|null} f.evidence the gate-evidence marker
 * @param {string|null} [f.currentBranch] the branch being shipped (null = detached or unresolved)
 * @param {{ok: boolean, reason?: string, marker?: {runId: string, auditedTree: string, round: number, verdict: string}}|null} f.finalReview readFinalReviewMarker's result
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
  if (!conv) c.push(row('audit-converged', false, 'the store has no readable audit_runs row for the evidence run (cloud off, unreachable, or run not found)'));
  else if (!Number.isInteger(conv.roundConvergedAfter)) c.push(row('audit-converged', false, 'audit_runs.round_converged_after is null: the audit did not converge'));
  else if (f.evidence && f.evidence.auditedBranch !== f.currentBranch) {
    // The marker is a local file, so a stale one from ANOTHER branch's audit can sit in .audit/ and read fresh.
    // (Not the audited commit's ancestry: a rebase after the audit legitimately rewrites it.)
    c.push(row('audit-converged', false, `the audit evidence is for branch ${JSON.stringify(f.evidence.auditedBranch ?? null)}, not ${JSON.stringify(f.currentBranch ?? null)}`));
  } else c.push(row('audit-converged', true, `converged after round ${conv.roundConvergedAfter}`));

  // 3. the final review approved THIS audited tree and round, not merely this run (the column has no target identity).
  const ev = f.evidence;
  const fr = f.finalReview;
  if (!ev) c.push(row('final-review', false, 'there is no gate-evidence marker to bind the final review to'));
  else if (!fr || !fr.ok) c.push(row('final-review', false, `no final-review marker (${fr?.reason ?? 'not read'}): gemini-review has not recorded what it approved`));
  else if (fr.marker.verdict !== 'APPROVE') c.push(row('final-review', false, `the recorded final review is ${fr.marker.verdict}, not APPROVE`));
  else if (!Number.isInteger(ev.round)) c.push(row('final-review', false, 'the gate-evidence marker carries no round, so the approval cannot be bound to one'));
  else if (fr.marker.runId !== ev.runId) c.push(row('final-review', false, `the approval is for run ${fr.marker.runId.slice(0, 8)}, the audit evidence is run ${ev.runId.slice(0, 8)}`));
  else if (fr.marker.auditedTree !== ev.auditedTree) c.push(row('final-review', false, 'the approval is for a different audited tree than the audit evidence names'));
  else if (fr.marker.round !== ev.round) c.push(row('final-review', false, `the approval is for round ${fr.marker.round}, the audit evidence is round ${ev.round}`));
  else if (conv?.geminiVerdict !== 'APPROVE') c.push(row('final-review', false, `the store records gemini_verdict ${JSON.stringify(conv?.geminiVerdict ?? null)}, not APPROVE`));
  else c.push(row('final-review', true, `APPROVE on run ${ev.runId.slice(0, 8)}, round ${ev.round}, the audited tree`));

  // 4-6. paths. An unresolvable change set fails all three rather than passing them vacuously.
  const paths = Array.isArray(f.changedPaths) ? f.changedPaths : null;
  const pathRow = (id, test, what) => {
    if (!paths) return row(id, false, 'the changed paths could not be resolved (no merge base or tree), so nothing was checked');
    if (paths.length === 0) return row(id, false, 'the branch changes no paths against the default branch: nothing to ship, and an empty set must not read as clean');
    const hit = paths.filter(test);
    return hit.length ? row(id, false, `${what}: ${hit.slice(0, 3).join(', ')}${hit.length > 3 ? `, +${hit.length - 3} more` : ''}`) : row(id, true, `none of ${paths.length} changed path(s)`);
  };
  c.push(pathRow('sensitive-path', isSensitivePath, 'touches sensitive path(s)'));
  c.push(pathRow('migration', isMigrationPath, 'touches a database migration'));
  c.push(pathRow('repo-policy', isPolicyPath, 'touches repository-policy file(s) (.github/, CODEOWNERS, .test-tiers.json)'));

  const refusals = c.filter((x) => !x.ok).map((x) => `${x.id}: ${x.reason}`);
  return { ok: refusals.length === 0, conditions: c, refusals };
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
 * @returns {string[]|null}
 */
export function gatherChangedPaths(run, tree) {
  const out = (args) => { const r = run(args); return r && r.status === 0 ? String(r.stdout ?? '').trim() : null; };
  const defaultRef = out(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const candidates = [defaultRef && defaultRef.replace(/^refs\/remotes\//, ''), 'origin/main', 'main'].filter(Boolean);
  let base = null;
  for (const ref of candidates) { base = out(['merge-base', 'HEAD', ref]); if (base) break; }
  if (!base || !tree) return null;
  const r = run(['diff', '--name-only', '--no-renames', '-z', base, tree]);
  if (!r || r.status !== 0) return null;
  return String(r.stdout ?? '').split('\0').filter(Boolean);
}
