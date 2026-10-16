/**
 * @fileoverview The merge-verdict READER for repos that run their full suite in CI (docs/plans/ci-full-suite-actions.md,
 * D6-D8). Given a PR (or a head sha), it answers: did the trusted full-suite workflow succeed on exactly this head, for
 * this PR, into the default branch? If so it prints the existing one-line grammar, `test-tier/v1 full <head> ...`, so
 * merge rule 8 keeps reading ONE line. Anything else is `failed`, `pending` or `unverified` and prints no such line.
 *
 * **Absence is never green.** The classifier is an exhaustive map: only `completed/success` on an ACCEPTED run is a
 * verdict. No run, a run for another PR or base or workflow path, an unfetchable default branch, a missing `gh`, a
 * malformed answer, a PR that edits the workflow that grades it: every one of those is `unverified` with the reason
 * named, because an unasked question must never render as an empty (clean) result.
 *
 * Pure decision (`classifyCiVerdict`) over an injected evidence record; `gatherCiEvidence` does the I/O through an
 * injected `run(cmd, args)` so every branch is testable without GitHub.
 *
 * @module scripts/lib/ci-verdict
 */
import { parseHeavyList, summaryLine } from './test-tier.mjs';

export const CI_VERDICT_VERSION = 'ci-verdict/v1';
/** Process exit codes of `test-tier.mjs ci-verdict`: 1 error and 2 usage keep the CLI's own meanings. */
export const CI_VERDICT_EXIT = Object.freeze({ full: 0, error: 1, argv: 2, notYet: 3, failed: 4 });

const PENDING_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
const SHA40 = /^[0-9a-f]{40}$/;

/** A run's workflow path as GitHub reports it, without any `@ref` suffix. */
const runPath = (r) => String(r?.path ?? '').replace(/@.*$/, '');

/**
 * Does this run count as evidence for the question asked?
 * @returns {{ok: true} | {ok: false, why: string}}
 */
function acceptRun(r, { head, pr, defaultBranch, workflowPath }) {
  if (!r || typeof r !== 'object') return { ok: false, why: 'malformed run record' };
  if (runPath(r) !== workflowPath) return { ok: false, why: `a different workflow (${runPath(r) || 'no path'})` };
  if (r.head_sha !== head) return { ok: false, why: 'a different head sha' };
  const prs = Array.isArray(r.pull_requests) ? r.pull_requests : [];
  if (pr !== null) {
    if (r.event !== 'pull_request') return { ok: false, why: `event ${r.event}, not pull_request` };
    const match = prs.find((p) => p?.number === pr);
    if (!match) return { ok: false, why: `not associated with PR #${pr}` };
    if (match.base?.ref !== defaultBranch) return { ok: false, why: `PR #${pr} run targets ${match.base?.ref ?? 'an unknown base'}, not ${defaultBranch}` };
    return { ok: true };
  }
  if (r.event === 'push' && r.head_branch === defaultBranch) return { ok: true };
  if (r.event === 'pull_request' && prs.some((p) => p?.base?.ref === defaultBranch)) return { ok: true };
  return { ok: false, why: `event ${r.event} on ${r.head_branch ?? 'an unknown branch'} is not a push to ${defaultBranch} or a PR into it` };
}

/**
 * The ONE place a run is chosen as the evidence for a question: accepted runs only, newest first (a re-run is the same run id at a
 * higher attempt, which the API already reports as its latest). The classifier judges this run; evidence gathering reads the
 * provenance of this same run, so the two can never look at different runs.
 * @returns {{run: object|null, rejected: string[]}}
 */
export function selectRun({ runs, head, pr = null, defaultBranch, workflowPath }) {
  const accepted = [];
  const rejected = [];
  for (const r of Array.isArray(runs) ? runs : []) {
    const a = acceptRun(r, { head, pr, defaultBranch, workflowPath });
    if (a.ok) accepted.push(r); else rejected.push(a.why);
  }
  const newest = [...accepted].sort((a, b) => (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0) || (b.run_attempt ?? 0) - (a.run_attempt ?? 0) || (b.id ?? 0) - (a.id ?? 0))[0] ?? null;
  return { run: newest, rejected: [...new Set(rejected)] };
}

/**
 * THE decision. `evidence`:
 *   head, pr (number|null), defaultBranch, defaultSha, workflowPath (from the TRUSTED default branch),
 *   workflowBlobHead / workflowBlobDefault (git blob ids of that workflow at each), runs (the Actions runs for head),
 *   mergeable (the PR's GitHub mergeable state, or null).
 * @returns {{verdict: 'full'|'failed'|'pending'|'unverified', reason: string, runId?: number, url?: string, testedBase?: string|null, summary?: string, staleBase?: {tested: string, current: string}|null}}
 */
export function classifyCiVerdict(evidence) {
  const unverified = (reason) => ({ verdict: 'unverified', reason });
  const { head, pr = null, defaultBranch, defaultSha, workflowPath, workflowBlobHead, workflowBlobDefault, runs, workflowBlobErrors = {}, workflowBlobAtBase = {}, mergeable = null } = evidence ?? {};
  // GitHub runs no pull_request workflow on a CONFLICTING PR, so "no run" there has a cause the reader must name (400e).
  const noRun = (reason) => (pr !== null && mergeable === 'CONFLICTING'
    ? { ...unverified(`conflicting: GitHub runs no pull_request workflow on a conflicting PR; merge the base in first (${reason})`), blocker: 'conflicting' }
    : unverified(reason));
  if (!SHA40.test(String(head ?? ''))) return unverified('the head is not a full 40-hex commit id');
  if (!defaultBranch || !SHA40.test(String(defaultSha ?? ''))) return unverified('the default branch could not be resolved to a fresh commit');
  if (!workflowPath) return unverified(`no ciVerdict workflow is declared in .test-tiers.json on ${defaultBranch}`);
  // A blob we could not READ (auth, rate limit, network) is a different fact from a blob that is confirmed ABSENT; the reason keeps the cause.
  if (!workflowBlobDefault) return unverified(workflowBlobErrors.default ? `cannot read ${workflowPath} on ${defaultBranch}: ${workflowBlobErrors.default}` : `the workflow ${workflowPath} does not exist on ${defaultBranch}: there is no trusted copy to grade against`);
  if (!workflowBlobHead && workflowBlobErrors.head) return unverified(`cannot read ${workflowPath} at ${head.slice(0, 8)}: ${workflowBlobErrors.head}`);
  if (!workflowBlobHead || workflowBlobHead !== workflowBlobDefault) {
    return unverified(`this head changes ${workflowPath} (or it is absent there): the run that would grade it is not the trusted workflow, so its own green proves nothing`);
  }
  if (!Array.isArray(runs)) return unverified('the Actions runs could not be read (malformed response)');
  if (runs.length === 0) return noRun(`no ${workflowPath} run exists for ${head.slice(0, 8)}`);

  const sel = selectRun({ runs, head, pr, defaultBranch, workflowPath });
  if (!sel.run) return noRun(`${runs.length} run(s) exist for ${head.slice(0, 8)} but none counts as evidence: ${sel.rejected.slice(0, 3).join('; ')}`);
  const run = sel.run;
  const common = { runId: run.id, url: run.html_url };
  const status = String(run.status ?? '');
  const conclusion = run.conclusion ?? null;

  if (PENDING_STATUSES.has(status)) return { verdict: 'pending', reason: `run ${run.id} is ${status}`, ...common };
  if (status !== 'completed') return { ...unverified(`run ${run.id} has an unrecognised status ${JSON.stringify(status)}`), ...common };
  if (FAILED_CONCLUSIONS.has(conclusion)) return { verdict: 'failed', reason: `run ${run.id} concluded ${conclusion}`, ...common };
  if (conclusion !== 'success') return { ...unverified(`run ${run.id} concluded ${JSON.stringify(conclusion)}, which is not a pass`), ...common };

  const match = pr !== null ? (run.pull_requests ?? []).find((p) => p?.number === pr) : (run.pull_requests ?? [])[0];
  const testedBase = SHA40.test(String(match?.base?.sha ?? '')) ? match.base.sha : null;

  // PROVENANCE of the workflow the run actually EXECUTED (audit R1 H1/H4). A pull_request run executes the workflow of the
  // MERGE of the head with the base it was tested against, and the current default's file says nothing about that older base.
  // The head's copy is already proven equal to the trusted one above, so the merged file is the trusted one exactly when the
  // tested base's copy is too. A push run executes the head's own copy: already proven.
  if (run.event === 'pull_request') {
    if (!testedBase) return { ...unverified(`run ${run.id} does not say which base it was tested against, so the workflow revision it executed cannot be established`), ...common };
    const atBase = workflowBlobAtBase[testedBase];
    if (!atBase || (!atBase.blob && atBase.why)) return { ...unverified(`cannot read ${workflowPath} at the base run ${run.id} was tested against (${testedBase.slice(0, 8)})${atBase?.why ? `: ${atBase.why}` : ''}`), ...common };
    if (atBase.blob !== workflowBlobDefault) return { ...unverified(`run ${run.id} executed the merge of this head with base ${testedBase.slice(0, 8)}, whose ${workflowPath} differs from the trusted one: the executed workflow is not the trusted workflow`), ...common };
  }
  return {
    verdict: 'full', reason: `run ${run.id} succeeded on ${head.slice(0, 8)}`, ...common, testedBase,
    summary: summaryLine({ tier: 'full', head, skipped: 0, base: testedBase, reason: `ci:${run.id}` }),
    // Reported, never hidden: head pinning pins the head, not the base it was tested against.
    staleBase: testedBase && testedBase !== defaultSha ? { tested: testedBase, current: defaultSha } : null,
  };
}

/** Run a command through the injected runner and parse JSON stdout. Never throws: a failure is a labelled string. */
export function runJson(run, cmd, args) {
  let r;
  try { r = run(cmd, args); } catch (e) { return { ok: false, why: `${cmd} could not be run (${e.message})` }; }
  if (!r || r.error) return { ok: false, why: `${cmd} could not be run (${r?.error?.message ?? 'no result'})` };
  if (r.status !== 0) return { ok: false, why: `${cmd} ${args.slice(0, 2).join(' ')} exited ${r.status}: ${String(r.stderr ?? '').trim().split('\n')[0].slice(0, 160)}` };
  try { return { ok: true, value: JSON.parse(r.stdout) }; } catch { return { ok: false, why: `${cmd} ${args.slice(0, 2).join(' ')} did not return JSON` }; }
}
/** As runJson, for text stdout (trimmed). */
export function runText(run, cmd, args) {
  let r;
  try { r = run(cmd, args); } catch (e) { return { ok: false, why: `${cmd} could not be run (${e.message})` }; }
  if (!r || r.error) return { ok: false, why: `${cmd} could not be run (${r?.error?.message ?? 'no result'})` };
  if (r.status !== 0) return { ok: false, why: `${cmd} ${args.slice(0, 2).join(' ')} exited ${r.status}: ${String(r.stderr ?? '').trim().split('\n')[0].slice(0, 160)}` };
  return { ok: true, value: String(r.stdout ?? '').trim() };
}

/**
 * Gather the evidence `classifyCiVerdict` judges, in the order the plan fixes (D6): repo, a FRESH trusted default, the
 * workflow path from that default's `.test-tiers.json`, the PR (its head and base), the workflow blobs at both
 * commits, and the runs for the head. Every failed step is an `unverified` result with its reason, never a throw and
 * never a partial pass.
 *
 * @param {object} a
 * @param {(cmd: string, args: string[]) => {status: number|null, stdout?: string, stderr?: string, error?: Error}} a.run
 * @param {number|null} a.pr
 * @param {string|null} a.head the head to verify when no PR is given
 * @returns {{ok: true, evidence: object} | {ok: false, reason: string}}
 */
export function gatherCiEvidence({ run, pr = null, head = null }) {
  const repoInfo = runJson(run, 'gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']);
  if (!repoInfo.ok) return { ok: false, reason: `cannot identify the repository: ${repoInfo.why}` };
  const nwo = repoInfo.value?.nameWithOwner;
  const defaultBranch = repoInfo.value?.defaultBranchRef?.name;
  if (!nwo || !defaultBranch) return { ok: false, reason: 'gh did not name the repository and its default branch' };

  // A FRESH trusted default: a stale remote-tracking ref would grade against yesterday's workflow.
  const fetched = runText(run, 'git', ['fetch', '--quiet', 'origin', defaultBranch]);
  if (!fetched.ok) return { ok: false, reason: `cannot refresh ${defaultBranch} from origin, so the trusted copy may be stale: ${fetched.why}` };
  const sha = runText(run, 'git', ['rev-parse', 'FETCH_HEAD']);
  if (!sha.ok || !SHA40.test(sha.value)) return { ok: false, reason: `cannot resolve the fetched ${defaultBranch}: ${sha.ok ? sha.value : sha.why}` };
  const defaultSha = sha.value;

  const listText = runText(run, 'git', ['show', `${defaultSha}:.test-tiers.json`]);
  if (!listText.ok) return { ok: false, reason: `${defaultBranch} has no readable .test-tiers.json: ${listText.why}` };
  const list = parseHeavyList(listText.value);
  if (!list.ok) return { ok: false, reason: `.test-tiers.json on ${defaultBranch} is unusable: ${list.reason}` };
  const workflowPath = list.list.ciVerdict?.workflow ?? null;

  let headSha = head;
  let mergeable = null;
  if (pr !== null) {
    const view = runJson(run, 'gh', ['pr', 'view', String(pr), '--json', 'number,headRefOid,baseRefName,state,mergeable']);
    if (!view.ok) return { ok: false, reason: `cannot read PR #${pr}: ${view.why}` };
    if (view.value?.baseRefName !== defaultBranch) return { ok: false, reason: `PR #${pr} targets ${view.value?.baseRefName}, not ${defaultBranch}: no verdict applies` };
    headSha = view.value?.headRefOid;
    mergeable = typeof view.value?.mergeable === 'string' ? view.value.mergeable : null;
  } else {
    const r = runText(run, 'git', ['rev-parse', '--verify', `${head}^{commit}`]);
    if (!r.ok) return { ok: false, reason: `cannot resolve ${head} to a commit: ${r.why}` };
    headSha = r.value;
  }
  if (!SHA40.test(String(headSha ?? ''))) return { ok: false, reason: 'the head did not resolve to a full commit id' };

  // The workflow's blob at a commit, from the GitHub API so no local objects are needed. Three outcomes, never conflated:
  // a blob; confirmed absent (HTTP 404); or a read that FAILED (auth, rate limit, network: `why` keeps the labelled cause).
  const blobAt = (ref) => {
    if (!workflowPath) return { blob: null, why: null };
    const r = runText(run, 'gh', ['api', `repos/${nwo}/contents/${workflowPath}?ref=${ref}`, '--jq', '.sha']);
    if (r.ok) return /^[0-9a-f]{40}$/.test(r.value) ? { blob: r.value, why: null } : { blob: null, why: `unexpected answer ${JSON.stringify(r.value.slice(0, 40))}` };
    return /HTTP 404|Not Found/i.test(r.why) ? { blob: null, why: null } : { blob: null, why: r.why };
  };

  const runsResp = runJson(run, 'gh', ['api', `repos/${nwo}/actions/runs?head_sha=${headSha}&per_page=100`]);
  if (!runsResp.ok) return { ok: false, reason: `cannot read the Actions runs: ${runsResp.why}` };

  const runs = Array.isArray(runsResp.value?.workflow_runs) ? runsResp.value.workflow_runs : null;
  const atHead = blobAt(headSha);
  const atDefault = blobAt(defaultSha);
  // The workflow a pull_request run executed is the merge of the head with the base it was tested against, so the verdict needs
  // that base's copy. Which run? The very one the classifier will judge (selectRun is shared), so no window or cap can leave the
  // judged run without its provenance.
  const workflowBlobAtBase = {};
  const judged = selectRun({ runs, head: headSha, pr, defaultBranch, workflowPath }).run;
  for (const p of Array.isArray(judged?.pull_requests) ? judged.pull_requests : []) {
    const b = p?.base?.sha;
    if (SHA40.test(String(b ?? '')) && !(b in workflowBlobAtBase)) workflowBlobAtBase[b] = blobAt(b);
  }

  return {
    ok: true,
    evidence: {
      head: headSha, pr, defaultBranch, defaultSha, workflowPath,
      workflowBlobHead: atHead.blob, workflowBlobDefault: atDefault.blob,
      workflowBlobErrors: { head: atHead.why, default: atDefault.why },
      workflowBlobAtBase,
      runs,
      mergeable,
      nwo,
    },
  };
}

/**
 * The CLI's argument grammar, pure so it is testable as a table. Exactly one of `pr` / `head`.
 * @returns {{pr: number|null, head: string|null}}  throws Error with a usable message otherwise
 */
export function parseVerdictTarget(prArg, headArg) {
  const hasPr = prArg !== null && prArg !== undefined;
  const hasHead = headArg !== null && headArg !== undefined;
  if (hasPr === hasHead) throw new Error('exactly one of --pr <n> or --head <rev> is required');
  if (hasPr) {
    if (!/^[1-9]\d{0,8}$/.test(String(prArg))) throw new Error(`--pr must be a PR number, got ${JSON.stringify(prArg)}`);
    return { pr: Number(prArg), head: null };
  }
  if (!/^[0-9a-zA-Z][\w./-]*$/.test(String(headArg))) throw new Error(`--head ${JSON.stringify(headArg)} is not a revision`);
  return { pr: null, head: String(headArg) };
}

/** One call for the CLI: gather, classify, and say it. A gather failure is `unverified`, never an exception. */
export function ciVerdict({ run, pr = null, head = null }) {
  const g = gatherCiEvidence({ run, pr, head });
  if (!g.ok) return { version: CI_VERDICT_VERSION, verdict: 'unverified', reason: g.reason };
  return { version: CI_VERDICT_VERSION, head: g.evidence.head, pr, defaultBranch: g.evidence.defaultBranch, ...classifyCiVerdict(g.evidence) };
}
