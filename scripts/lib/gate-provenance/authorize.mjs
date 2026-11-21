/**
 * @fileoverview The loosening authorization (the verification-lessons plan, section 2.2, step 3): a PR whose gate diff is
 * `loosening` or `unknown` is allowed only when (a) it touches NOTHING outside the protected set, (b) it carries the label
 * `gate-loosening`, and (c) the owner approval STANDS for the analyzed head: it is the reviewer latest review state, it is
 * APPROVED, and its commit_id equals the analyzed head sha. The PR base and head shas read from the API must equal the
 * analyzed ones, or the facts describe another change and the answer is `unmeasured`. Facts come from `gh api`; when they
 * cannot be read the answer is `unmeasured`, never "not authorized" and never "authorized".
 *
 * @module scripts/lib/gate-provenance/authorize
 */
import { spawnSync } from 'node:child_process';

export const LOOSENING_LABEL = 'gate-loosening';
export const APPROVING_REVIEWER = 'Lbstrydom';

/** Names of the repo shaped `owner/name`; anything else never reaches a gh argv. */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Flatten the output of `gh api --paginate --slurp` (an array of pages) into one list. */
const flattenPages = (v) => (Array.isArray(v) ? v.flat() : null);

/**
 * Read the PR facts through the gh CLI.
 * @param {{repo?: string, pr?: string|number, run?: (args: string[]) => {status: number|null, stdout: string}}} args
 */
export function fetchPrFacts({ repo, pr, run } = {}) {
  if (!repo || !REPO_RE.test(String(repo))) return { measured: false, reason: 'no valid --repo / GITHUB_REPOSITORY' };
  if (pr == null || !/^\d+$/.test(String(pr))) return { measured: false, reason: 'no valid --pr number' };
  const exec = run ?? ((args) => {
    const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 60_000 });
    return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
  });
  const call = (args) => {
    const r = exec(['api', ...args]);
    if (r.status !== 0) return null;
    try { return JSON.parse(r.stdout); } catch { return null; }
  };
  const prDoc = call([`repos/${repo}/pulls/${pr}`]);
  if (!prDoc || !Array.isArray(prDoc.labels) || !prDoc.base?.sha || !prDoc.head?.sha) {
    return { measured: false, reason: 'gh api could not read the pull request (gh missing, unauthenticated or offline)' };
  }
  // Every page: a later review that lands on page 2 must be seen, since the LATEST review decides.
  const reviews = flattenPages(call([`repos/${repo}/pulls/${pr}/reviews?per_page=100`, '--paginate', '--slurp']));
  if (!reviews) return { measured: false, reason: 'gh api could not read the reviews' };
  return {
    measured: true,
    baseSha: prDoc.base.sha,
    headSha: prDoc.head.sha,
    labels: prDoc.labels.map((l) => l.name),
    reviews: reviews.map((r) => ({ user: r.user?.login ?? '', state: r.state, commitId: r.commit_id ?? null })),
  };
}

/**
 * A standing approval: the reviewer LATEST review state is APPROVED (a later CHANGES_REQUESTED or DISMISSED voids it; a
 * bare comment does not) AND that review was made on the analyzed head, so an approval of an earlier push never carries over.
 */
export function hasApproval(reviews, headSha, reviewer = APPROVING_REVIEWER) {
  const mine = reviews.filter((r) => r.user === reviewer && r.state !== 'COMMENTED' && r.state !== 'PENDING');
  const latest = mine[mine.length - 1];
  return Boolean(latest) && latest.state === 'APPROVED' && Boolean(headSha) && latest.commitId === headSha;
}

/**
 * Pure decision over already-read facts.
 * @param {{changedFiles: string[], protectedPaths: Set<string>, facts: object, base: string, head: string}} args
 * @returns {{state: 'authorized'|'not-authorized'|'unmeasured', reasons: string[]}}
 */
export function evaluateLoosening({ changedFiles, protectedPaths, facts: factsOrReader, base, head }) {
  const reasons = [];
  const outside = changedFiles.filter((f) => !protectedPaths.has(f));
  // A change outside the protected set is decided from the diff alone: a measured violation, whatever the PR facts say, and
  // the facts are not even read (a lazy reader is never called).
  if (outside.length) {
    return { state: 'not-authorized', reasons: [`touches files outside the protected set: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ` (+${outside.length - 5})` : ''}`] };
  }
  const facts = typeof factsOrReader === 'function' ? factsOrReader() : factsOrReader;
  if (!facts.measured) return { state: 'unmeasured', reasons: [facts.reason, ...reasons] };
  if (facts.baseSha !== base || facts.headSha !== head) {
    return { state: 'unmeasured', reasons: [`the PR facts describe ${String(facts.baseSha).slice(0, 8)}..${String(facts.headSha).slice(0, 8)}, not the analyzed ${base.slice(0, 8)}..${head.slice(0, 8)}`, ...reasons] };
  }
  if (!facts.labels.includes(LOOSENING_LABEL)) reasons.push(`missing label ${LOOSENING_LABEL}`);
  if (!hasApproval(facts.reviews, head)) reasons.push(`no standing approving review by ${APPROVING_REVIEWER} on ${head.slice(0, 8)}`);
  return { state: reasons.length ? 'not-authorized' : 'authorized', reasons };
}
