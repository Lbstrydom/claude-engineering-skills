/**
 * @fileoverview The loosening authorization (the verification-lessons plan, section 2.2, step 3): a PR whose gate diff
 * is `loosening` or `unknown` is allowed only when (a) it touches NOTHING but registered files, (b) it carries the label
 * `gate-loosening`, and (c) an approving review by the owner stands. Facts come from `gh api`; when they cannot be read the
 * answer is `unmeasured`, never "not authorized" and never "authorized".
 *
 * @module scripts/lib/gate-provenance/authorize
 */
import { spawnSync } from 'node:child_process';

export const LOOSENING_LABEL = 'gate-loosening';
export const APPROVING_REVIEWER = 'Lbstrydom';

/** Names of the repo shaped `owner/name`; anything else never reaches a gh argv. */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Read the PR facts through the gh CLI.
 * @param {{repo?: string, pr?: string|number, run?: (args: string[]) => {status: number|null, stdout: string}}} args
 * @returns {{measured: true, labels: string[], reviews: Array<{user: string, state: string}>} | {measured: false, reason: string}}
 */
export function fetchPrFacts({ repo, pr, run } = {}) {
  if (!repo || !REPO_RE.test(String(repo))) return { measured: false, reason: 'no valid --repo / GITHUB_REPOSITORY' };
  if (pr == null || !/^\d+$/.test(String(pr))) return { measured: false, reason: 'no valid --pr number' };
  const exec = run ?? ((args) => {
    const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 60_000 });
    return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
  });
  const call = (endpoint) => {
    const r = exec(['api', endpoint, '--paginate']);
    if (r.status !== 0) return null;
    try {
      // --paginate concatenates JSON arrays as `][`; normalise before parsing.
      return JSON.parse(r.stdout.replace(/\]\s*\[/g, ','));
    } catch { return null; }
  };
  const prDoc = call(`repos/${repo}/pulls/${pr}`);
  if (!prDoc || !Array.isArray(prDoc.labels)) return { measured: false, reason: 'gh api could not read the pull request (gh missing, unauthenticated or offline)' };
  const reviews = call(`repos/${repo}/pulls/${pr}/reviews?per_page=100`);
  if (!Array.isArray(reviews)) return { measured: false, reason: 'gh api could not read the reviews' };
  return {
    measured: true,
    labels: prDoc.labels.map((l) => l.name),
    reviews: reviews.map((r) => ({ user: r.user?.login ?? '', state: r.state })),
  };
}

/** The latest review per user decides: an APPROVED later dismissed or superseded by CHANGES_REQUESTED does not count. */
export function hasApproval(reviews, reviewer = APPROVING_REVIEWER) {
  const mine = reviews.filter((r) => r.user === reviewer && r.state !== 'COMMENTED' && r.state !== 'PENDING');
  return mine.length > 0 && mine[mine.length - 1].state === 'APPROVED';
}

/**
 * Pure decision over already-read facts.
 * @param {{changedFiles: string[], registeredPaths: Set<string>, facts: ReturnType<typeof fetchPrFacts>}} args
 * @returns {{state: 'authorized'|'not-authorized'|'unmeasured', reasons: string[]}}
 */
export function evaluateLoosening({ changedFiles, registeredPaths, facts }) {
  const reasons = [];
  const outside = changedFiles.filter((f) => !registeredPaths.has(f));
  if (outside.length) reasons.push(`touches non-registered files: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ` (+${outside.length - 5})` : ''}`);
  if (!facts.measured) return { state: 'unmeasured', reasons: [facts.reason, ...reasons] };
  if (!facts.labels.includes(LOOSENING_LABEL)) reasons.push(`missing label ${LOOSENING_LABEL}`);
  if (!hasApproval(facts.reviews)) reasons.push(`no standing approving review by ${APPROVING_REVIEWER}`);
  return { state: reasons.length ? 'not-authorized' : 'authorized', reasons };
}
