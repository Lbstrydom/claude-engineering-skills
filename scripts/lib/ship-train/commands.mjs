/**
 * @fileoverview Ship-train verbs — plan, message, verify — over an injected
 * context (git, gh, fleet status and manifest, closure, store, clock).
 *
 * Stateless (plan §2.8): no verb reads or writes a ship-train record. Each
 * recomputes from owned state — fleet's manifest, GitHub, git, the store.
 *
 * The CLI (scripts/ship-train.mjs) wires the real context; tests wire fakes.
 * Lives under lib/ so tests import it without an edge into the CLI's domain.
 * Plan: docs/plans/ship-trains.md §2.1, §7 Phase 3.
 *
 * @module scripts/lib/ship-train/commands
 */

import { ArgvError } from '../cli-io.mjs';
import { classifyPrImpact, isTrainDue, parseNameStatusZ } from './impact.mjs';
import { bindAuditRun, decideTrainGate, modelsFromRun, composeSquashMessage } from './provenance.mjs';
import { verifyTrain, publicationClearance, judgeSourceIdentity, readAiTrailers, MAX_UPDATE_LINKS } from './verify.mjs';

export class TrainRefusal extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TrainRefusal';
    this.details = details;
  }
}

// ── argv ────────────────────────────────────────────────────────────────────

/** argv up to (not including) a POSIX `--` terminator — options after it are positional. */
const optionsOnly = (argv) => {
  const end = argv.indexOf('--');
  return end < 0 ? argv : argv.slice(0, end);
};

/** `--pr 202,203 --pr 204` → [202, 203, 204]. */
export function parsePrList(argv, flag) {
  const out = [];
  const opts = optionsOnly(argv);
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i];
    let raw = null;
    if (a === flag) raw = opts[i + 1];
    else if (a.startsWith(`${flag}=`)) raw = a.slice(flag.length + 1);
    if (raw === null) continue;
    if (raw === undefined || raw.startsWith('--')) throw new ArgvError(`${flag} needs a value: a PR number or a comma-separated list`);
    for (const part of raw.split(',')) {
      if (!/^[1-9]\d*$/.test(part.trim())) throw new ArgvError(`${flag}: "${part}" is not a PR number`);
      out.push(Number(part.trim()));
    }
  }
  return [...new Set(out)];
}

/** `--flag value` or `--flag=value`, given at most once; null when absent. */
export function flagValue(argv, flag) {
  const opts = optionsOnly(argv);
  const values = [];
  opts.forEach((a, i) => {
    if (a === flag) {
      const v = opts[i + 1];
      if (v === undefined || v.startsWith('--')) throw new ArgvError(`${flag} needs a value`);
      values.push(v);
    } else if (a.startsWith(`${flag}=`)) {
      values.push(a.slice(flag.length + 1));
    }
  });
  if (values.length > 1) throw new ArgvError(`${flag} was given ${values.length} times; it takes one value`);
  return values[0] ?? null;
}

// ── facts ───────────────────────────────────────────────────────────────────

const lines = (s) => String(s).split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * Read whether the destination REFUSES a merge whose head is not up to date —
 * the server-side pin that alone makes `passed` provable on a squash (§2.3).
 *
 * A strict setting counts only when NO actor can bypass it (round-1 code M6):
 *   - a ruleset rule counts when its ruleset is `active` and lists no bypass
 *     actors (read from the ruleset itself — the branch-rules endpoint does not
 *     carry them);
 *   - classic protection counts only with `enforce_admins` on.
 * Anything unreadable, or a bypass the read cannot rule out, fails closed to
 * `none`: `passed` is then simply not offered, never wrongly claimed.
 */
export function readBasePinning(ctx, repo, branch) {
  const evidence = [];
  let strict = false;
  const json = (args) => JSON.parse(ctx.gh(args));
  const failed = (label, err) => {
    const msg = String(err?.stderr || err?.message || err);
    evidence.push(/HTTP 404/.test(msg) ? `${label}: none (404)` : `${label}: unreadable (${msg.split('\n')[0].slice(0, 120)}) — fail-closed`);
  };

  try {
    const rules = json(['api', `repos/${repo}/rules/branches/${branch}`]);
    const strictRules = (Array.isArray(rules) ? rules : [])
      .filter((r) => r?.type === 'required_status_checks' && r?.parameters?.strict_required_status_checks_policy === true);
    if (strictRules.length === 0) evidence.push('rulesets: not strict');
    for (const r of strictRules) {
      try {
        const rs = json(['api', `repos/${repo}/rulesets/${r.ruleset_id}`]);
        const enforced = rs?.enforcement === 'active' && Array.isArray(rs?.bypass_actors) && rs.bypass_actors.length === 0;
        evidence.push(`ruleset ${r.ruleset_id}: strict, enforcement ${rs?.enforcement}, ${Array.isArray(rs?.bypass_actors) ? `${rs.bypass_actors.length} bypass actor(s)` : 'bypass actors unreadable'}`);
        if (enforced) strict = true;
      } catch (err) {
        failed(`ruleset ${r.ruleset_id}`, err);
      }
    }
  } catch (err) {
    failed('rulesets', err);
  }

  try {
    const p = json(['api', `repos/${repo}/branches/${branch}/protection`]);
    const isStrict = p?.required_status_checks?.strict === true;
    const admins = p?.enforce_admins?.enabled === true;
    evidence.push(`protection: ${isStrict ? 'strict' : 'not strict'}${isStrict ? `, enforce_admins ${admins ? 'on' : 'off'}` : ''}`);
    if (isStrict && admins) strict = true;
  } catch (err) {
    failed('protection', err);
  }
  return { verdict: strict ? 'strict' : 'none', evidence: evidence.join(' ; ') };
}

/** The destination's remote tip, fetched into a private ref (never a stale origin/*). */
export function fetchDestination(ctx, branch) {
  const ref = `refs/ship-train/base/${branch}`;
  ctx.git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${branch}:${ref}`]);
  return ctx.git(['rev-parse', ref]).trim();
}

/** Everything the decision needs about one PR, read from gh + git. */
export function gatherPrFacts(ctx, repo, pr, baseOid) {
  const view = JSON.parse(ctx.gh(['pr', 'view', String(pr), '-R', repo, '--json',
    'number,title,state,isDraft,headRefOid,headRefName,baseRefName']));
  const ref = `refs/ship-train/pr/${pr}`;
  ctx.git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/pull/${pr}/head:${ref}`]);
  const headOid = ctx.git(['rev-parse', ref]).trim();
  const mergeBaseOid = ctx.git(['merge-base', baseOid, headOid]).trim();
  const commits = lines(ctx.git(['log', '--reverse', '--format=%H %T', `${mergeBaseOid}..${headOid}`]))
    .map((l) => { const [oid, tree] = l.split(' '); return { oid, tree }; });
  const subjects = String(ctx.git(['log', '--reverse', '--format=%s', `${mergeBaseOid}..${headOid}`])).split('\n').filter((s) => s !== '');
  const changes = parseNameStatusZ(ctx.git(['diff', '--name-status', '-z', '-M', mergeBaseOid, headOid]));
  const headTree = ctx.git(['rev-parse', `${headOid}^{tree}`]).trim();
  return { pr, view, headOid, mergeBaseOid, commits, subjects, changes, headTree };
}

/**
 * Fleet's own view: which sessions are ready (by branch) and which base branch
 * fleet lands onto. The destination is fleet's resolved base, never a constant
 * here — `fleet land` and the train must agree on where they are landing.
 */
export function readFleet(ctx) {
  const env = JSON.parse(ctx.fleetStatus());
  const byBranch = new Map();
  for (const item of env?.status?.items ?? []) {
    if (item?.branch) byBranch.set(item.branch, { state: item.state, readyOid: item.ready?.oid ?? null, pr: item.pr?.number ?? null });
  }
  const baseBranch = env?.status?.base?.name ?? null;
  if (typeof baseBranch !== 'string' || !/^[\w./-]+$/.test(baseBranch)) {
    throw new TrainRefusal(`fleet status reports no usable base branch (${JSON.stringify(baseBranch)}) — cannot tell where the train would land`);
  }
  return { byBranch, baseBranch };
}

/**
 * A schema fault is a broken query, not an absent store: it never degrades into
 * "store unavailable", which would still let ride-alongs land as not-run
 * (round-6 code H2). Stop loudly instead.
 */
function failFatal(r) {
  if (r?.fatal) throw new TrainRefusal(`the audit store rejected the provenance query (${r.reason}) — fix the store schema before running a train (node scripts/setup-postgres.mjs --check-drift)`);
}

// ── decision ────────────────────────────────────────────────────────────────

/** Tier, binding and gate for one PR (pure over gathered facts). */
export function decidePr({ facts, closure, basePinning, candidates, overrides, composer }) {
  const impact = classifyPrImpact({ changes: facts.changes, closure });
  const binding = candidates.ok
    ? bindAuditRun({ commits: facts.commits, candidates: candidates.rows })
    : { kind: 'store-unavailable', reason: candidates.reason };
  const d = decideTrainGate({
    binding,
    headTree: facts.headTree,
    basePinning: basePinning.verdict,
    tier: impact.tier,
    waive: overrides.waive.includes(facts.pr),
    allowUnaudited: overrides.allowUnaudited.includes(facts.pr),
  });
  const run = binding.kind === 'tree' || binding.kind === 'ancestry' ? binding.run : null;
  const { models, attributionMissing } = modelsFromRun(run, composer);
  return {
    pr: facts.pr,
    title: facts.view.title,
    headOid: facts.headOid,
    mergeBaseOid: facts.mergeBaseOid,
    tier: impact.tier,
    reasons: impact.reasons,
    binding: {
      kind: binding.kind,
      runId: run?.id ?? null,
      boundCommit: binding.kind === 'tree' ? binding.boundCommit : null,
      postAuditCommits: binding.kind === 'tree' ? binding.postAuditCommits : [],
      reason: binding.reason ?? null,
    },
    decision: d.refusal ? null : {
      gate: d.gate, runId: d.runId, auditedTree: d.auditedTree, models, attributionMissing, identityProvable: d.identityProvable,
    },
    refusal: d.refusal,
  };
}

/** The plan for a set of PRs: gathered, decided, and checked for executability. */
export async function computePlan(ctx, { prs, overrides, composer }) {
  const repo = ctx.repo();
  const { byBranch: fleet, baseBranch: branch } = readFleet(ctx);
  const selected = prs.length ? prs : [...fleet.values()].filter((s) => s.state === 'ready' && s.pr).map((s) => s.pr);
  if (selected.length === 0) {
    throw new TrainRefusal('no ship-ready PRs: none named with --pr and fleet reports no ready session with an open PR');
  }
  const expectedOid = fetchDestination(ctx, branch);
  const basePinning = readBasePinning(ctx, repo, branch);
  const closure = ctx.closure();
  const repoRow = await ctx.store.resolveRepoRowIdForRead(ctx.cwd);
  failFatal(repoRow);

  const rows = [];
  for (const pr of selected.sort((a, b) => a - b)) {
    const facts = gatherPrFacts(ctx, repo, pr, expectedOid);
    const candidates = repoRow.ok
      ? await ctx.store.findCodeRunCandidates({ repoRowId: repoRow.repoRowId, trees: facts.commits.map((c) => c.tree), oids: facts.commits.map((c) => c.oid) })
      : { ok: false, reason: repoRow.reason };
    failFatal(candidates);
    const row = decidePr({ facts, closure, basePinning, candidates, overrides, composer });
    const session = fleet.get(facts.view.headRefName);
    const blockers = [];
    if (facts.view.state !== 'OPEN') blockers.push(`PR is ${facts.view.state}`);
    if (facts.view.isDraft) blockers.push('PR is a draft');
    if (facts.view.baseRefName !== branch) blockers.push(`PR targets ${facts.view.baseRefName}, not ${branch}`);
    if (facts.view.headRefOid !== facts.headOid) blockers.push('PR head moved while it was being read');
    if (!session || session.state !== 'ready') blockers.push('not fleet-ready (fleet land needs a ready session)');
    else if (session.pr !== facts.pr) blockers.push(`fleet's ready session for ${facts.view.headRefName} is registered for PR #${session.pr}, not #${facts.pr}`);
    else if (session.readyOid !== facts.headOid) blockers.push(`fleet ready oid ${String(session.readyOid).slice(0, 12)} is not the PR head ${facts.headOid.slice(0, 12)}`);
    rows.push({ ...row, fleetReady: blockers.length === 0, blockers, commitSubjects: facts.subjects });
  }
  const due = isTrainDue({ prs: rows, endOfDay: overrides.endOfDay });
  const refusals = rows.filter((r) => r.refusal).map((r) => ({ pr: r.pr, ...r.refusal }));
  const blocked = rows.filter((r) => r.blockers.length).map((r) => ({ pr: r.pr, blockers: r.blockers }));
  return {
    repo,
    destination: { ref: `refs/heads/${branch}`, expectedOid },
    basePinning,
    storeState: repoRow.ok ? 'ok' : repoRow.reason,
    prs: rows,
    due,
    refusals,
    blocked,
    trainReady: due.due && refusals.length === 0 && blocked.length === 0,
  };
}

// ── verbs ───────────────────────────────────────────────────────────────────

export async function runPlan(ctx, opts) {
  return { ok: true, verb: 'plan', ...(await computePlan(ctx, opts)) };
}

export async function runMessage(ctx, opts) {
  if (opts.prs.length !== 1) throw new ArgvError('message needs exactly one --pr <n>');
  const plan = await computePlan(ctx, opts);
  const row = plan.prs[0];
  if (!row.decision) return { ok: true, verb: 'message', pr: row.pr, refusal: row.refusal };
  const { subject, body } = composeSquashMessage({ number: row.pr, title: row.title, commitSubjects: row.commitSubjects, decision: row.decision, models: row.decision.models });
  return { ok: true, verb: 'message', pr: row.pr, basePinning: plan.basePinning.verdict, decision: row.decision, subject, body };
}

/**
 * Everything `verify` judges, read fresh from OWNED state: fleet's train
 * manifest (pinned heads, base, destination, landing order), GitHub (what
 * merged, at which head), git (commits, trees, main's first-parent chain) and
 * the audit store (each claimed run, repo-scoped and code-mode). Nothing is
 * read from, or written to, a ship-train record — there is none (plan §2.8).
 */
export async function gatherTrainFacts(ctx, trainId) {
  const t = ctx.readTrain(trainId);
  if (!t.ok) throw new TrainRefusal(`fleet train ${trainId}: ${t.reason}`);
  const train = t.train;
  if (train.mergeMethod !== 'pr') throw new TrainRefusal(`train ${trainId} lands by ${train.mergeMethod}; ship trains verify pr-mode trains only (plan D2)`);
  const branch = train.destination.ref.replace(/^refs\/heads\//, '');
  const repo = train.sources.find((s) => s.repo)?.repo ?? ctx.repo();
  const tip = fetchDestination(ctx, branch);
  const repoRow = await ctx.store.resolveRepoRowIdForRead(ctx.cwd);
  failFatal(repoRow);
  const closure = ctx.closure();

  const sources = [];
  for (const s of train.sources) {
    if (!s.prNumber) throw new TrainRefusal(`train ${trainId} source ${s.id} has no PR`);
    const pr = s.prNumber;
    const v = JSON.parse(ctx.gh(['pr', 'view', String(pr), '-R', repo, '--json', 'state,mergeCommit,headRefOid']));
    if (v.state !== 'MERGED' || !v.mergeCommit?.oid) {
      sources.push({ pr, tier: null, merged: null, identity: null, prCommits: [], run: null });
      continue;
    }
    ctx.git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/pull/${pr}/head:refs/ship-train/pr/${pr}`]);
    const head = v.headRefOid;

    // Source identity: walk first parents from the merged head back to the
    // pinned oid, each step judged by fleet's own classifyUpdatedHead.
    const links = [];
    let h = head;
    for (let i = 0; i < MAX_UPDATE_LINKS && h !== s.oid; i++) {
      let priorHead = null;
      try { priorHead = ctx.git(['rev-parse', `${h}^1`]).trim(); } catch { /* root or unreadable: judged below */ }
      if (!priorHead) { links.push({ oid: h, verdict: 'unverifiable', reason: 'no first parent' }); break; }
      const c = ctx.classifyUpdate({ trainId, remote: train.destination.remote, base: branch, pr, h, priorHead });
      links.push({ oid: h, verdict: c.verdict, reason: c.reason });
      if (c.verdict !== 'own') break;
      h = priorHead;
    }
    const identity = judgeSourceIdentity({ pinnedOid: s.oid, links, reachedOid: h });

    const mergeBase = ctx.git(['merge-base', train.baseOid, head]).trim();
    const prCommits = lines(ctx.git(['log', '--reverse', '--format=%H %T', `${mergeBase}..${head}`]))
      .map((l) => { const [oid, tree] = l.split(' '); return { oid, tree }; });
    const changes = parseNameStatusZ(ctx.git(['diff', '--name-status', '-z', '-M', mergeBase, head]));
    const message = ctx.git(['log', '-1', '--format=%B', v.mergeCommit.oid]);
    const tree = ctx.git(['rev-parse', `${v.mergeCommit.oid}^{tree}`]).trim();

    const runId = readAiTrailers(message).trailers['AI-Run-ID'];
    let run = null;
    if (runId && repoRow.ok) {
      const r = await ctx.store.findCodeRunForRepo({ repoRowId: repoRow.repoRowId, runId });
      failFatal(r);
      run = r.ok ? r.run : null;
    }
    sources.push({
      pr,
      tier: classifyPrImpact({ changes, closure }).tier,
      merged: { mergeOid: v.mergeCommit.oid, message, tree },
      identity,
      prCommits,
      run,
    });
  }
  const chain = lines(ctx.git(['log', '--first-parent', '--reverse', '--format=%H%x09%s', `${train.baseOid}..${tip}`]))
    .map((l) => { const i = l.indexOf('\t'); return { oid: l.slice(0, i), subject: l.slice(i + 1) }; });
  return { trainId, repo, branch, tip, storeState: repoRow.ok ? 'ok' : repoRow.reason, sources, chain };
}

/**
 * Judge a landed train afresh. Read-only apart from the optional pending-note
 * (`--write-note`), which carries the ACTUAL gates and every deviation into the
 * next status entry. Re-runnable any number of times; nothing goes stale.
 */
export async function runVerify(ctx, { train, writeNote = false, acks = {} }) {
  if (!train) throw new ArgvError('verify needs --train <trainId>');
  const facts = await gatherTrainFacts(ctx, train);
  const v = verifyTrain({ sources: facts.sources, chain: facts.chain });
  const clearance = publicationClearance(v, acks);
  const tierOf = Object.fromEntries(facts.sources.map((s) => [String(s.pr), s.tier]));
  const deviations = [
    ...v.unmerged.map((pr) => `#${pr}: not merged`),
    ...v.identityFailures.map((pr) => `#${pr}: ${v.perPr[String(pr)].identity}`),
    ...v.offChain.map((pr) => `#${pr}: merge commit is not on ${facts.branch}'s first-parent chain`),
    ...v.falseClaims.map((pr) => `#${pr}: ${v.perPr[String(pr)].claim.problems.join('; ')}`),
    ...Object.entries(v.actualGates)
      .filter(([pr, gate]) => gate === 'not-run' && tierOf[pr] && tierOf[pr] !== 'ride-along')
      .map(([pr]) => `#${pr}: not-run on a ${tierOf[pr]} PR — landed only under --allow-unaudited`),
    ...(v.interleaved.length ? [`${v.interleaved.length} foreign commit(s) before ${v.finalMergeOid.slice(0, 12)}: ${v.interleaved.map((c) => c.oid.slice(0, 12)).join(', ')}`] : []),
  ];
  const notes = Object.entries(v.perPr).flatMap(([pr, p]) => (p.claim?.notes ?? []).map((n) => `#${pr}: ${n}`));
  let pendingNote = null;
  if (writeNote) {
    pendingNote = ctx.writePendingNote(v.finalMergeOid ?? facts.tip, [
      `Ship train ${train} — verified ${new Date(ctx.now()).toISOString()} (final merge ${v.finalMergeOid ?? 'none'})`,
      `Actual gates: ${Object.entries(v.actualGates).map(([pr, g]) => `#${pr} ${g}`).join(', ') || 'none'}`,
      ...deviations.map((d) => `- ${d}`),
      ...notes.map((n) => `- note: ${n}`),
    ].join('\n'));
  }
  return {
    ok: true, verb: 'verify', trainId: train, storeState: facts.storeState,
    finalMergeOid: v.finalMergeOid, actualGates: v.actualGates, deviations, notes, clearance, pendingNote,
  };
}
