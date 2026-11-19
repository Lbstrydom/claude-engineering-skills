/**
 * @fileoverview A scripted GitHub for the CI-evidence suites, answering the REAL read shapes the oracle makes
 * (docs/plans/ci-evidence-oracle.md section 2.1) from RECORDED fixtures (tests/fixtures/fleet/github-ci/). A scenario is a plain object
 * (one answer per endpoint); `scenario.pr` may be an ARRAY, answered in order with the last repeating, so a head that moves mid-observation
 * is one line. Every call is recorded. Used by the adapter, oracle and admission suites, so the three cannot disagree on a shape.
 *
 * @module tests/helpers/fleet-github-fake
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '..', 'fixtures', 'fleet', 'github-ci');
/** The BODY of a recorded fixture (a deep copy, safe to mutate). */
export const fixture = (name) => structuredClone(JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')).body);

export const REPO = 'Lbstrydom/claude-engineering-skills';
export const HEAD = '90c60bf286f891ad6fe2168321a30fbe843921a6';
export const OTHER_HEAD = 'b'.repeat(40);

/** An answer that is a failed `gh` run. */
export const failed = (status = 1, stderr = 'gh: Not Found (HTTP 404)', stdout = '') => ({ __fail: { status, stderr, stdout } });

/** The CES-shaped GitHub at #395's head: a ruleset-only `main` requiring `full-suite` from app 15368, which passed. */
export function cesScenario(over = {}) {
  return {
    pr: fixture('ces-pr-395-view.json'),
    branch: fixture('ces-branch-main.json'),
    rules: fixture('ces-rules-main.json'),
    checkRuns: fixture('ces-check-runs-395.json'),
    statuses: fixture('ces-statuses-395.json'),
    ...over,
  };
}

/** The AIO-shaped GitHub: nothing required, proven (an unprotected branch and an empty rules list). */
export function emptyScenario(over = {}) {
  return cesScenario({ branch: fixture('aio-branch-main.json'), rules: fixture('aio-rules-main.json'), checkRuns: { total_count: 0, check_runs: [] }, ...over });
}

const asRes = (answer) => (answer && answer.__fail
  ? { ok: false, status: answer.__fail.status, stdout: answer.__fail.stdout ?? '', stderr: answer.__fail.stderr, reason: 'gh failed' }
  : { ok: true, status: 0, stdout: JSON.stringify(answer), stderr: '' });

/** @returns {{gh: Function, calls: string[][], merges: string[][], deps: {gh: Function, cwd: string}}} */
export function githubFake(scenario, { onMerge, repo = REPO, base = 'main', head = HEAD, prNumber = 395 } = {}) {
  const calls = []; const merges = []; let prReads = 0;
  const pick = (a) => (Array.isArray(a) ? a[Math.min(prReads - 1, a.length - 1)] : typeof a === 'function' ? a(prReads) : a);
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'merge') { merges.push(args); return onMerge ? onMerge(args) : asRes({}); }
    if (args[0] === 'pr' && args[1] === 'view') {
      if (args[2] !== String(prNumber) || args[args.indexOf('-R') + 1] !== repo) return { ok: false, status: 1, stdout: '', stderr: `unexpected PR read ${args.join(' ')}`, reason: 'unexpected' };
      prReads += 1; return asRes(pick(scenario.pr));
    }
    if (args[0] === 'api') {
      const p = args[1];
      const at = `repos/${repo}/`;
      const b = encodeURIComponent(base); // the readers encode the branch name, so the fake expects the encoded path
      if (p === `${at}rules/branches/${b}?per_page=100`) return asRes(scenario.rules);
      if (p === `${at}branches/${b}`) return asRes(scenario.branch);
      if (p === `${at}commits/${head}/check-runs?filter=latest&per_page=100`) return asRes(scenario.checkRuns);
      if (p === `${at}commits/${head}/statuses?per_page=100`) return asRes(scenario.statuses);
    }
    return { ok: false, status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}`, reason: 'unexpected' };
  };
  return { gh, calls, merges, deps: { gh, cwd: '.' } };
}
