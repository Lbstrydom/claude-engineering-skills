/**
 * @fileoverview Wait for CI on the EXACT head of a PR, report a verdict per check, and (only when the caller asked)
 * merge safely. The decision logic behind `scripts/ci-merge.mjs`; every effect (gh, clock, sleep) is injected, so a
 * fake `gh` drives each branch in tests.
 *
 * Rules, each from a consumer incident (docs/research/consumer-feedback-2026-11-11.md theme 2):
 *  - EVERY check on the head is waited for, never one named check (WCA #1261 ended early tracking one).
 *  - A failing check passes only when its NAME is on the allowed list. `UNSTABLE` is refused unless every failing
 *    check is allowed, and an UNSTABLE with no failing check to explain it is refused too (WCA #1278 merged gitleaks red).
 *  - A rollup with no checks is "nothing measured", never green: it is polled for a grace period, then refused.
 *  - BEHIND -> `gh pr update-branch`, then re-wait on the NEW head. Merge uses `--squash --match-head-commit <sha>` with
 *    the head the checks passed on, so a push after the wait is rejected by GitHub itself.
 *  - Merging happens only when `merge` is set by the caller. Waiting alone never mutates anything.
 *  - A head that moves while waiting, when we did not move it, refuses a merge (the caller approved a different commit);
 *    in report mode it is followed and recorded.
 *  - A timeout names what is still pending.
 *
 * @module scripts/lib/ci-merge
 */

export const MERGE_RE_READ_TRIES = 3;
const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const STATUS_PENDING = new Set(['PENDING', 'EXPECTED']);

/**
 * One rollup entry -> `{name, state: 'pass'|'fail'|'pending', conclusion}`. A malformed entry is pending, never a pass.
 * @param {any} c
 */
export function classifyCheck(c) {
  if (!c || typeof c !== 'object') return { name: '(unreadable check)', state: 'pending', conclusion: null };
  const name = String(c.name ?? c.context ?? '(unnamed check)');
  if (c.__typename === 'StatusContext' || (c.context && !c.name)) {
    const s = String(c.state ?? '').toUpperCase();
    if (s === 'SUCCESS') return { name, state: 'pass', conclusion: s };
    if (STATUS_PENDING.has(s) || !s) return { name, state: 'pending', conclusion: s || null };
    return { name, state: 'fail', conclusion: s };
  }
  const status = String(c.status ?? '').toUpperCase();
  const conclusion = String(c.conclusion ?? '').toUpperCase();
  if (status !== 'COMPLETED') return { name, state: 'pending', conclusion: conclusion || status || null };
  return { name, state: PASS.has(conclusion) ? 'pass' : 'fail', conclusion };
}

/** @param {unknown} rollup */
export function classifyRollup(rollup) {
  return (Array.isArray(rollup) ? rollup : []).map(classifyCheck);
}

/** `--allow-fail a,b` (repeatable) -> a Set of exact check names. */
export function parseNameList(values) {
  return new Set([].concat(values ?? []).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean));
}

/** `owner/name` out of a PR url, or null. */
export function repoFromUrl(url) {
  const m = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(String(url ?? ''));
  return m ? m[1] : null;
}

const VIEW_FIELDS = 'number,url,state,isDraft,headRefOid,mergeStateStatus,statusCheckRollup,mergeCommit,baseRefName';

/**
 * @typedef {object} Deps
 * @property {(args: string[]) => {status: number|null, stdout: string, stderr: string, error?: any}} gh
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} now
 * @property {(msg: string) => void} [log]
 *
 * @typedef {object} Opts
 * @property {boolean} [merge]            the caller's explicit merge decision; absent = report only
 * @property {Set<string>} [allowFail]    check names whose failure is tolerated
 * @property {Set<string>} [expect]       check names that must be present in the rollup before a verdict
 * @property {boolean} [failFast]         stop at the first disallowed failure instead of waiting for the rest
 * @property {boolean} [followHead]       merge mode: follow a head someone else moved instead of refusing
 * @property {string|null} [deployWait]   check-run name on the merge commit to wait for after merging
 * @property {number} [timeoutMs] @property {number} [pollMs] @property {number} [blockedGraceMs]
 * @property {number} [noChecksGraceMs] @property {number} [updateSettleMs] @property {number} [maxUpdates]
 * @property {number} [deployTimeoutMs]
 */

export const DEFAULTS = Object.freeze({
  timeoutMs: 45 * 60_000, pollMs: 20_000, blockedGraceMs: 90_000, noChecksGraceMs: 120_000,
  updateSettleMs: 90_000, maxUpdates: 3, deployTimeoutMs: 20 * 60_000,
});

const prArgs = (ref, repo) => [...(ref === 'current' ? [] : [String(ref)]), ...(repo ? ['--repo', repo] : [])];

function readView(ref, repo, d) {
  let last = '';
  for (let i = 0; i < MERGE_RE_READ_TRIES; i += 1) {
    const r = d.gh(['pr', 'view', ...prArgs(ref, repo), '--json', VIEW_FIELDS]);
    if (r.error || r.status !== 0) { last = (r.error?.message ?? r.stderr ?? '').toString().trim().split('\n')[0] || `gh exited ${r.status}`; continue; }
    try { return { ok: true, view: JSON.parse(r.stdout) }; } catch { last = 'gh printed unparseable JSON'; }
  }
  return { ok: false, error: last };
}

/**
 * Wait for, report on, and optionally merge ONE pull request.
 * @param {string|number} ref  PR number, or `current` for the current branch's PR
 * @param {{repo?: string|null} & Opts} options
 * @param {Deps} d
 */
export async function processPr(ref, options, d) {
  const o = { ...DEFAULTS, ...options };
  const repo = options.repo ?? null;
  const allow = o.allowFail ?? new Set();
  const expect = o.expect ?? new Set();
  const log = d.log ?? (() => {});
  const started = d.now();
  const out = { pr: ref, head: null, verdict: 'pending', reason: null, ok: false, merged: false, checks: [], pending: [], failures: [], allowedFailures: [], headChanges: [], updates: 0, mergeState: null };
  const finish = (verdict, reason, extra = {}) => Object.assign(out, { verdict, reason, ok: verdict === 'green' || verdict === 'merged', ...extra });

  let expectedHead = null;
  let ownMove = false;
  let awaitingNewHeadFrom = null;
  let awaitSince = 0;
  let blockedSince = null;
  let noChecksSince = null;

  for (;;) {
    const elapsed = d.now() - started;
    const rv = readView(ref, repo, d);
    if (!rv.ok) return finish('refused', 'gh-error', { detail: rv.error });
    const v = rv.view;
    if (v.number != null) out.number = v.number;
    out.url = v.url ?? out.url;
    if (v.state && v.state !== 'OPEN') return finish('refused', `not-open:${v.state}`, { head: v.headRefOid ?? out.head });
    if (v.isDraft) return finish('refused', 'draft', { head: v.headRefOid });

    const head = v.headRefOid;
    out.head = head;
    if (expectedHead && head !== expectedHead) {
      out.headChanges.push({ from: expectedHead, to: head });
      if (ownMove && awaitingNewHeadFrom === expectedHead) { ownMove = false; awaitingNewHeadFrom = null; }
      else if (o.merge && !o.followHead) {
        return finish('refused', 'head-moved', { detail: `head moved ${expectedHead} -> ${head} while waiting; the merge decision covered ${expectedHead}` });
      }
      blockedSince = null; noChecksSince = null;
    }
    expectedHead = head;

    const checks = classifyRollup(v.statusCheckRollup);
    const names = new Set(checks.map((c) => c.name));
    const missing = [...expect].filter((n) => !names.has(n));
    const failures = checks.filter((c) => c.state === 'fail');
    const bad = failures.filter((c) => !allow.has(c.name));
    const pendingChecks = checks.filter((c) => c.state === 'pending');
    Object.assign(out, {
      checks: checks.map((c) => ({ ...c, allowed: c.state === 'fail' && allow.has(c.name) })),
      pending: pendingChecks.map((c) => c.name),
      failures: bad.map((c) => c.name), allowedFailures: failures.filter((c) => allow.has(c.name)).map((c) => c.name),
      mergeState: v.mergeStateStatus ?? null,
    });

    if (bad.length && (o.failFast || pendingChecks.length === 0)) {
      return finish('failed', 'check-failed', { head });
    }

    const timedOut = () => finish('timeout', 'timeout', {
      head, detail: `no verdict after ${Math.round(elapsed / 1000)}s`,
      pending: [...pendingChecks.map((c) => c.name), ...missing.map((n) => `${n} (expected, not reported)`), ...(checks.length === 0 ? ['(no checks reported yet)'] : [])],
    });

    // Not everything is in yet: no checks at all, an expected check not yet reported, or a check still running.
    if (checks.length === 0) {
      noChecksSince ??= d.now();
      if (d.now() - noChecksSince >= o.noChecksGraceMs) return finish('refused', 'no-checks-reported', { head, detail: 'nothing was measured; a PR with no checks is not green' });
    }
    if (checks.length === 0 || pendingChecks.length || missing.length) {
      if (missing.length && checks.length && !pendingChecks.length) {
        noChecksSince ??= d.now();
        if (d.now() - noChecksSince >= o.noChecksGraceMs) return finish('refused', 'expected-check-missing', { head, pending: missing, detail: `expected check(s) never reported: ${missing.join(', ')}` });
      }
      if (elapsed >= o.timeoutMs) return timedOut();
      log(`${ref}: waiting on ${pendingChecks.length || missing.length || 'any'} check(s) for ${head.slice(0, 8)}`);
      await d.sleep(o.pollMs);
      continue;
    }
    if (bad.length) return finish('failed', 'check-failed', { head });

    // Every check on this head is terminal, none disallowed-failing. Report mode stops here.
    if (!o.merge) {
      return finish('green', out.allowedFailures.length ? 'green-with-allowed-failures' : 'all-checks-passed', { head });
    }

    const ms = v.mergeStateStatus;
    if (awaitingNewHeadFrom === head) { // update-branch accepted but the head has not moved yet
      if (d.now() - awaitSince > o.updateSettleMs) return finish('refused', 'update-branch-no-new-head', { head });
      await d.sleep(o.pollMs);
      continue;
    }
    if (ms === 'BEHIND') {
      if (out.updates >= o.maxUpdates) return finish('refused', 'behind-after-max-updates', { head });
      const u = d.gh(['pr', 'update-branch', ...prArgs(ref, repo)]);
      if (u.error || u.status !== 0) return finish('refused', 'update-branch-failed', { head, detail: String(u.stderr ?? u.error?.message ?? '').trim() });
      out.updates += 1; ownMove = true; awaitingNewHeadFrom = head; awaitSince = d.now();
      log(`${ref}: BEHIND, update-branch #${out.updates}; re-waiting on the new head`);
      await d.sleep(o.pollMs);
      continue;
    }
    if (ms === 'DIRTY') return finish('refused', 'conflicts', { head });
    if (ms === 'UNSTABLE') {
      if (failures.length === 0) return finish('refused', 'unstable-unexplained', { head, detail: 'mergeStateStatus is UNSTABLE but no failing check explains it' });
      // every failure is allowed (bad was empty) -> mergeable
    } else if (ms === 'BLOCKED' || ms === 'UNKNOWN' || ms == null) {
      blockedSince ??= d.now();
      if (d.now() - blockedSince >= o.blockedGraceMs) return finish('refused', ms === 'BLOCKED' ? 'blocked' : 'merge-state-unknown', { head, detail: `mergeStateStatus ${ms} after every check finished (review required, a required check not yet reported, or branch protection)` });
      if (elapsed >= o.timeoutMs) return timedOut();
      await d.sleep(o.pollMs);
      continue;
    } else if (ms !== 'CLEAN' && ms !== 'HAS_HOOKS') {
      return finish('refused', `merge-state-${String(ms).toLowerCase()}`, { head });
    }

    const m = d.gh(['pr', 'merge', ...prArgs(ref, repo), '--squash', '--match-head-commit', head]);
    if (m.error || m.status !== 0) {
      const err = String(m.stderr ?? m.error?.message ?? '').trim();
      return finish('refused', /head|match|expected/i.test(err) ? 'head-moved' : 'merge-rejected', { head, detail: err.split('\n')[0] });
    }
    const after = readView(ref, repo, d);
    const mergeCommit = after.ok ? after.view.mergeCommit?.oid ?? null : null;
    if (after.ok && after.view.state !== 'MERGED') {
      // auto-merge queues are not used here: a merge that did not land is not a merge
      return finish('refused', 'merge-not-confirmed', { head, detail: `state is ${after.view.state} after gh pr merge` });
    }
    finish('merged', 'merged', { head, merged: true, mergeCommit });
    if (o.deployWait) out.deploy = await waitForDeploy(out, v.url ?? out.url, o, d);
    return out;
  }
}

/** After a merge: wait for check run `o.deployWait` on the merge commit. Never changes whether the merge happened. */
export async function waitForDeploy(out, url, o, d) {
  const repo = repoFromUrl(url);
  const sha = out.mergeCommit;
  if (!repo || !sha) return { name: o.deployWait, state: 'unmeasured', reason: 'no repo or merge commit to read check runs from' };
  const started = d.now();
  for (;;) {
    const r = d.gh(['api', `repos/${repo}/commits/${sha}/check-runs`]);
    let run = null;
    if (!r.error && r.status === 0) {
      try { run = (JSON.parse(r.stdout).check_runs ?? []).find((c) => c.name === o.deployWait) ?? null; } catch { /* poll again */ }
    }
    if (run && run.status === 'completed') {
      return { name: o.deployWait, state: PASS.has(String(run.conclusion).toUpperCase()) ? 'pass' : 'fail', conclusion: run.conclusion };
    }
    if (d.now() - started >= o.deployTimeoutMs) {
      return { name: o.deployWait, state: 'timeout', reason: run ? `still ${run.status}` : 'check run never appeared on the merge commit' };
    }
    await d.sleep(o.pollMs);
  }
}

/**
 * Serial queue. Report mode visits every PR (reading is independent). Merge mode stops at the first PR that does not
 * merge, because the next one was about to be rebased onto it: the rest are `not-attempted`, never silently skipped.
 * @param {Array<string|number>} refs
 */
export async function runQueue(refs, options, d) {
  const results = [];
  for (const ref of refs) {
    if (options.merge && results.length && !results[results.length - 1].ok) {
      results.push({ pr: ref, ok: false, merged: false, verdict: 'not-attempted', reason: 'an earlier PR in the queue did not merge' });
      continue;
    }
    results.push(await processPr(ref, options, d));
  }
  return results;
}

/** Exit code for a result set: 1 any failed/refused/not-attempted, else 3 any timeout, else 0. A failed deploy is a 1. */
export function exitCodeFor(results) {
  const bad = (r) => !r.ok && r.verdict !== 'timeout' || r.deploy?.state === 'fail';
  if (results.some(bad)) return 1;
  if (results.some((r) => r.verdict === 'timeout' || r.deploy?.state === 'timeout' || r.deploy?.state === 'unmeasured')) return 3;
  return 0;
}

/** The text a `/cycle` done report or a `/ship` summary pastes: one line per PR, one per check. */
export function renderReport(results) {
  const lines = [];
  for (const r of results) {
    const head = r.head ? ` @ ${String(r.head).slice(0, 8)}` : '';
    lines.push(`PR ${r.number ?? r.pr}${head}: ${String(r.verdict).toUpperCase()}${r.reason && r.reason !== r.verdict ? ` (${r.reason})` : ''}`);
    for (const c of r.checks ?? []) lines.push(`  ${c.state === 'pass' ? 'pass' : c.state === 'fail' ? (c.allowed ? 'FAIL (allowed)' : 'FAIL') : 'PENDING'}  ${c.name}${c.conclusion ? ` [${c.conclusion}]` : ''}`);
    if (r.verdict === 'timeout' && r.pending?.length) lines.push(`  still pending: ${r.pending.join(', ')}`);
    if (r.detail) lines.push(`  ${r.detail}`);
    if (r.headChanges?.length) lines.push(`  head moved ${r.headChanges.length}x (${r.updates ? `${r.updates} by update-branch` : 'not by us'})`);
    if (r.merged) lines.push(`  merged ${r.mergeCommit ? String(r.mergeCommit).slice(0, 8) : ''}`.trimEnd());
    if (r.deploy) lines.push(`  deploy ${r.deploy.name}: ${r.deploy.state}${r.deploy.reason ? ` (${r.deploy.reason})` : ''}`);
  }
  return lines.join('\n');
}
