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
 * THE decision. `evidence`:
 *   head, pr (number|null), defaultBranch, defaultSha, workflowPath (from the TRUSTED default branch),
 *   workflowBlobHead / workflowBlobDefault (git blob ids of that workflow at each), runs (the Actions runs for head).
 * @returns {{verdict: 'full'|'failed'|'pending'|'unverified', reason: string, runId?: number, url?: string, testedBase?: string|null, summary?: string, staleBase?: {tested: string, current: string}|null}}
 */
export function classifyCiVerdict(evidence) {
  const unverified = (reason) => ({ verdict: 'unverified', reason });
  const { head, pr = null, defaultBranch, defaultSha, workflowPath, workflowBlobHead, workflowBlobDefault, runs } = evidence ?? {};
  if (!SHA40.test(String(head ?? ''))) return unverified('the head is not a full 40-hex commit id');
  if (!defaultBranch || !SHA40.test(String(defaultSha ?? ''))) return unverified('the default branch could not be resolved to a fresh commit');
  if (!workflowPath) return unverified(`no ciVerdict workflow is declared in .test-tiers.json on ${defaultBranch}`);
  if (!workflowBlobDefault) return unverified(`the workflow ${workflowPath} does not exist on ${defaultBranch}: there is no trusted copy to grade against`);
  if (!workflowBlobHead || workflowBlobHead !== workflowBlobDefault) {
    return unverified(`this head changes ${workflowPath} (or it is absent there): the run that would grade it is not the trusted workflow, so its own green proves nothing`);
  }
  if (!Array.isArray(runs)) return unverified('the Actions runs could not be read (malformed response)');
  if (runs.length === 0) return unverified(`no ${workflowPath} run exists for ${head.slice(0, 8)}`);

  const accepted = [];
  const rejected = [];
  for (const r of runs) {
    const a = acceptRun(r, { head, pr, defaultBranch, workflowPath });
    if (a.ok) accepted.push(r); else rejected.push(a.why);
  }
  if (!accepted.length) return unverified(`${runs.length} run(s) exist for ${head.slice(0, 8)} but none counts as evidence: ${[...new Set(rejected)].slice(0, 3).join('; ')}`);

  // The latest run for the question asked (a re-run is the same run id at a higher attempt: the API already reports its latest attempt).
  const run = [...accepted].sort((a, b) => (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0) || (b.run_attempt ?? 0) - (a.run_attempt ?? 0) || (b.id ?? 0) - (a.id ?? 0))[0];
  const common = { runId: run.id, url: run.html_url };
  const status = String(run.status ?? '');
  const conclusion = run.conclusion ?? null;

  if (PENDING_STATUSES.has(status)) return { verdict: 'pending', reason: `run ${run.id} is ${status}`, ...common };
  if (status !== 'completed') return { ...unverified(`run ${run.id} has an unrecognised status ${JSON.stringify(status)}`), ...common };
  if (FAILED_CONCLUSIONS.has(conclusion)) return { verdict: 'failed', reason: `run ${run.id} concluded ${conclusion}`, ...common };
  if (conclusion !== 'success') return { ...unverified(`run ${run.id} concluded ${JSON.stringify(conclusion)}, which is not a pass`), ...common };

  const match = pr !== null ? (run.pull_requests ?? []).find((p) => p?.number === pr) : (run.pull_requests ?? [])[0];
  const testedBase = SHA40.test(String(match?.base?.sha ?? '')) ? match.base.sha : null;
  return {
    verdict: 'full', reason: `run ${run.id} succeeded on ${head.slice(0, 8)}`, ...common, testedBase,
    summary: summaryLine({ tier: 'full', head, skipped: 0, base: testedBase, reason: `ci:${run.id}` }),
    // Reported, never hidden: head pinning pins the head, not the base it was tested against.
    staleBase: testedBase && testedBase !== defaultSha ? { tested: testedBase, current: defaultSha } : null,
  };
}

/** Run a command through the injected runner and parse JSON stdout. Never throws: a failure is a labelled string. */
function runJson(run, cmd, args) {
  let r;
  try { r = run(cmd, args); } catch (e) { return { ok: false, why: `${cmd} could not be run (${e.message})` }; }
  if (!r || r.error) return { ok: false, why: `${cmd} could not be run (${r?.error?.message ?? 'no result'})` };
  if (r.status !== 0) return { ok: false, why: `${cmd} ${args.slice(0, 2).join(' ')} exited ${r.status}: ${String(r.stderr ?? '').trim().split('\n')[0].slice(0, 160)}` };
  try { return { ok: true, value: JSON.parse(r.stdout) }; } catch { return { ok: false, why: `${cmd} ${args.slice(0, 2).join(' ')} did not return JSON` }; }
}
function runText(run, cmd, args) {
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
  if (pr !== null) {
    const view = runJson(run, 'gh', ['pr', 'view', String(pr), '--json', 'number,headRefOid,baseRefName,state']);
    if (!view.ok) return { ok: false, reason: `cannot read PR #${pr}: ${view.why}` };
    if (view.value?.baseRefName !== defaultBranch) return { ok: false, reason: `PR #${pr} targets ${view.value?.baseRefName}, not ${defaultBranch}: no verdict applies` };
    headSha = view.value?.headRefOid;
  } else {
    const r = runText(run, 'git', ['rev-parse', '--verify', `${head}^{commit}`]);
    if (!r.ok) return { ok: false, reason: `cannot resolve ${head} to a commit: ${r.why}` };
    headSha = r.value;
  }
  if (!SHA40.test(String(headSha ?? ''))) return { ok: false, reason: 'the head did not resolve to a full commit id' };

  // The workflow's blob at each commit, from the GitHub API so no local objects are needed. Absent -> null (D8 reads that as "differs").
  const blobAt = (ref) => {
    if (!workflowPath) return null;
    const r = runText(run, 'gh', ['api', `repos/${nwo}/contents/${workflowPath}?ref=${ref}`, '--jq', '.sha']);
    return r.ok && /^[0-9a-f]{40}$/.test(r.value) ? r.value : null;
  };

  const runsResp = runJson(run, 'gh', ['api', `repos/${nwo}/actions/runs?head_sha=${headSha}&per_page=100`]);
  if (!runsResp.ok) return { ok: false, reason: `cannot read the Actions runs: ${runsResp.why}` };

  return {
    ok: true,
    evidence: {
      head: headSha, pr, defaultBranch, defaultSha, workflowPath,
      workflowBlobHead: blobAt(headSha), workflowBlobDefault: blobAt(defaultSha),
      runs: Array.isArray(runsResp.value?.workflow_runs) ? runsResp.value.workflow_runs : null,
    },
  };
}

/** One call for the CLI: gather, classify, and say it. A gather failure is `unverified`, never an exception. */
export function ciVerdict({ run, pr = null, head = null }) {
  const g = gatherCiEvidence({ run, pr, head });
  if (!g.ok) return { version: CI_VERDICT_VERSION, verdict: 'unverified', reason: g.reason };
  return { version: CI_VERDICT_VERSION, head: g.evidence.head, pr, defaultBranch: g.evidence.defaultBranch, ...classifyCiVerdict(g.evidence) };
}
