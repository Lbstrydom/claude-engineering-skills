/**
 * @fileoverview Ship-train verbs — plan, prepare, message, verify, abandon —
 * over an injected context (git, gh, fleet status, closure, store, clock).
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
import { createReceipt, readReceipt, updateReceipt, newOpId, canonicalJson } from './receipt.mjs';
import { verifyLanded, publicationClearance } from './verify.mjs';

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

/** A flag that names exactly ONE PR — a list is refused, never truncated to its first entry. */
export function singlePr(argv, flag) {
  const raw = flagValue(argv, flag);
  if (raw === null) return null;
  if (!/^[1-9]\d*$/.test(raw.trim())) throw new ArgvError(`${flag} takes exactly one PR number, got "${raw}"`);
  return Number(raw.trim());
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
  // A schema fault is a broken query, not an absent store: it never degrades
  // into "store unavailable", which would still let ride-alongs land as
  // not-run (round-6 code H2). Stop loudly instead.
  const failFatal = (r) => {
    if (r?.fatal) throw new TrainRefusal(`the audit store rejected the provenance query (${r.reason}) — fix the store schema before planning a train (node scripts/setup-postgres.mjs --check-drift)`);
  };
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

export async function runPrepare(ctx, opts) {
  if (opts.op) return recordLogPr(ctx, opts);
  const plan = await computePlan(ctx, opts);
  if (!plan.trainReady) {
    throw new TrainRefusal('the train is not ready to prepare', { due: plan.due, refusals: plan.refusals, blocked: plan.blocked });
  }
  const now = ctx.now();
  const receipt = createReceipt(ctx.gitCommonDir(), {
    schemaVersion: 1,
    opId: newOpId(now),
    createdAt: now.toISOString(),
    repo: plan.repo,
    destination: plan.destination,
    basePinning: plan.basePinning,
    selected: plan.prs.map(({ pr, title, headOid, mergeBaseOid, tier, reasons, binding, decision }) => ({ pr, title, headOid, mergeBaseOid, tier, reasons, binding, decision })),
    overrides: { waive: opts.overrides.waive, allowUnaudited: opts.overrides.allowUnaudited, endOfDay: opts.overrides.endOfDay },
  }, { now });
  return { ok: true, verb: 'prepare', opId: receipt.opId, phase: receipt.phase, fingerprint: receipt.fingerprint, due: plan.due, prs: plan.prs };
}

function recordLogPr(ctx, { op, logPr }) {
  if (!logPr) throw new ArgvError('prepare --op <id> needs --log-pr <n>');
  const receipt = readReceipt(ctx.gitCommonDir(), op);
  const view = JSON.parse(ctx.gh(['pr', 'view', String(logPr), '-R', receipt.repo, '--json', 'state,headRefOid,baseRefName']));
  if (view.state !== 'OPEN') throw new TrainRefusal(`log PR #${logPr} is ${view.state}, not OPEN`);
  if (`refs/heads/${view.baseRefName}` !== receipt.destination.ref) throw new TrainRefusal(`log PR #${logPr} targets ${view.baseRefName}`);
  if (receipt.selected.some((s) => s.pr === logPr)) throw new TrainRefusal(`#${logPr} is already a train source, not a log PR`);
  const updated = updateReceipt(ctx.gitCommonDir(), op, (d) => {
    d.logPr = { number: logPr, headOid: view.headRefOid };
    d.phase = 'log-opened';
  }, { now: ctx.now(), note: `log PR #${logPr}` });
  return { ok: true, verb: 'prepare', opId: op, phase: updated.phase, logPr: updated.logPr };
}

export async function runMessage(ctx, opts) {
  if (opts.prs.length !== 1) throw new ArgvError('message needs exactly one --pr <n>');
  const plan = await computePlan(ctx, opts);
  const row = plan.prs[0];
  if (!row.decision) return { ok: true, verb: 'message', pr: row.pr, refusal: row.refusal };
  const { subject, body } = composeSquashMessage({ number: row.pr, title: row.title, commitSubjects: row.commitSubjects, decision: row.decision, models: row.decision.models });
  return { ok: true, verb: 'message', pr: row.pr, basePinning: plan.basePinning.verdict, decision: row.decision, subject, body };
}

/** Facts for a landed train: each merge commit, and main's first-parent chain. */
export function gatherLandedFacts(ctx, receipt) {
  const branch = receipt.destination.ref.replace(/^refs\/heads\//, '');
  const tip = fetchDestination(ctx, branch);
  const prs = [...receipt.selected.map((s) => s.pr), ...(receipt.logPr ? [receipt.logPr.number] : [])];
  const merged = {};
  for (const pr of prs) {
    const v = JSON.parse(ctx.gh(['pr', 'view', String(pr), '-R', receipt.repo, '--json', 'state,mergeCommit']));
    if (v.state !== 'MERGED' || !v.mergeCommit?.oid) continue;
    const oid = v.mergeCommit.oid;
    merged[String(pr)] = {
      mergeOid: oid,
      message: ctx.git(['log', '-1', '--format=%B', oid]),
      tree: ctx.git(['rev-parse', `${oid}^{tree}`]).trim(),
    };
  }
  const chain = lines(ctx.git(['log', '--first-parent', '--reverse', '--format=%H%x09%s', `${receipt.destination.expectedOid}..${tip}`]))
    .map((l) => { const i = l.indexOf('\t'); return { oid: l.slice(0, i), subject: l.slice(i + 1) }; });
  return { merged, chain };
}

export async function runVerify(ctx, { op }) {
  if (!op) throw new ArgvError('verify needs --op <id>');
  const dir = ctx.gitCommonDir();
  const receipt = readReceipt(dir, op);
  if (!['landed', 'verified', 'verified-interleaved'].includes(receipt.phase)) {
    throw new TrainRefusal(`op ${op} is ${receipt.phase}; verify runs after the train has landed`);
  }
  const { merged, chain } = gatherLandedFacts(ctx, receipt);
  const v = verifyLanded({ receipt, merged, chain, at: ctx.now().toISOString() });
  // A re-verify REFRESHES the record, and clearance is always computed from the
  // record just written — never from a stale one (round-3 code H2). The phase a
  // fresh verification implies must equal the one already held: a train that
  // was clean and now shows interleaving (or the reverse) has changed under the
  // record, and that is refused for a human to read, not silently rewritten.
  const freshPhase = v.interleaved.length ? 'verified-interleaved' : 'verified';
  // Compare-and-swap (round-5 code H2): v was computed from `receipt` OUTSIDE
  // the lock, so it may be written only if the receipt is still exactly that.
  // A concurrent writer in between means the facts were judged against a
  // record that no longer exists — refuse, never clobber.
  const unchanged = (d) => {
    if (canonicalJson(d) !== canonicalJson(receipt)) {
      throw new TrainRefusal(`op ${op} changed while it was being verified — run verify again`);
    }
  };
  if (receipt.phase !== 'landed' && receipt.phase !== freshPhase) {
    // Refusing must not leave the OLD clearance standing (round-4 code H1/H2),
    // and must not overwrite the old record into a shape its phase forbids
    // (round-5 code H1/H3). The fresh evidence goes into `revocation`, beside
    // the original; publicationClearance refuses while a revocation exists.
    const reason = `the landed train changed under its record: recorded ${receipt.phase}, now verifies as ${freshPhase}`;
    updateReceipt(dir, op, (d) => {
      unchanged(d);
      d.revocation = { at: ctx.now().toISOString(), reason, freshPhase, verify: v };
    }, { now: ctx.now(), note: 're-verify refused' });
    throw new TrainRefusal(`op ${op}: ${reason}; publication is now blocked — read both before acting`, { verify: v });
  }
  const current = updateReceipt(dir, op, (d) => {
    unchanged(d);
    d.verify = v;
    d.phase = freshPhase;
  }, { now: ctx.now(), note: receipt.phase === 'landed' ? 'verify' : 're-verify' });
  const written = receipt.phase === 'landed';
  const deviations = [
    ...Object.entries(v.perPr).filter(([, p]) => !p.ok).map(([pr, p]) => `#${pr}: ${p.problems.join('; ')}`),
    ...v.plannedVsActual.map((d) => `#${d.pr}: planned ${d.planned}, landed ${d.actual}`),
    ...(v.interleaved.length ? [`${v.interleaved.length} foreign commit(s) interleaved before ${String(v.finalMergeOid).slice(0, 12)}: ${v.interleaved.map((c) => c.oid.slice(0, 12)).join(', ')}`] : []),
    ...(v.orderOk ? [] : [`observed landing order ${v.observedOrder.join(',')} differs from the manifest's`]),
    ...(v.publicationBlocked ? [`PUBLICATION BLOCKED: ${v.blockedReason}`] : []),
  ];
  let note = null;
  if (written && deviations.length && v.finalMergeOid) {
    note = ctx.writePendingNote(v.finalMergeOid, [
      `Ship train ${op} — verify deviations (final merge ${v.finalMergeOid})`,
      ...deviations.map((d) => `- ${d}`),
    ].join('\n'));
  }
  return { ok: true, verb: 'verify', opId: op, phase: current.phase, firstVerify: written, verify: v, deviations, pendingNote: note, clearance: publicationClearance(current) };
}

export async function runAbandon(ctx, { op }) {
  if (!op) throw new ArgvError('abandon needs --op <id>');
  const updated = updateReceipt(ctx.gitCommonDir(), op, (d) => { d.phase = 'abandoned'; }, { now: ctx.now(), note: 'abandon' });
  return {
    ok: true,
    verb: 'abandon',
    opId: op,
    phase: updated.phase,
    followUp: updated.logPr ? `the log PR is still open — close it with: gh pr close ${updated.logPr.number} -R ${updated.repo}` : null,
  };
}
