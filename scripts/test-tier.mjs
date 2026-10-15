#!/usr/bin/env node
/**
 * @fileoverview The test-tier CLI: the query ship-trains Cluster D asks, the push-time plan the pre-push sandbox
 * consumes, and a report-only refresh of the heavy list. The decision lives in `lib/test-tier.mjs`; this file only
 * moves data (docs/plans/gate-cost-slice-2.md section 2.6 and section 13).
 *
 *   select --head <rev> [--base <rev>] [--as-of <iso>] [--json]
 *       The COUNTERFACTUAL: would the branch tier have skipped a heavy file for this (head, base)? Reads git objects
 *       only; no push-time input (AUDIT_PREPUSH_TIER, the default branch) is an input, so the answer is a function of
 *       committed content. `{measured:false}` (exit 3) when the head predates the tier or the selector at the head
 *       differs from this checkout's: Cluster D then reports "unmeasured", never zero.
 *   plan --head <rev> [--base <rev>] [--tier full|branch] [--pushes-default] --out <file>
 *       The PUSH envelope `prepush-check.mjs` hands `run-tests.mjs --tier-skip`. Runs the checkout's own selector.
 *   refresh-heavy --timing <file>
 *       Report only: which listed timings drifted, which unlisted files are heavy. Writes nothing.
 *   ci-verdict (--pr <n> | --head <rev>) [--json] [--rerun-unrelated-flake]  (the flag needs --pr; see lib/ci-flake-rerun.mjs)
 *       The MERGE verdict for a repo that runs its full suite in CI (docs/plans/ci-full-suite-actions.md): prints the
 *       one-line `test-tier/v1 full <sha> ...` only when the trusted full-suite workflow succeeded on exactly this head,
 *       for this PR, into the default branch. Pending, failed and every kind of absence print no such line.
 *
 * Exit codes: 0 ok / measured / a full CI verdict, 1 error (including a rejected --base), 2 argv, 3 unmeasured /
 * ci-verdict pending or unverified, 4 ci-verdict failed.
 *
 * @module scripts/test-tier
 */
import fs from 'node:fs';
import path from 'node:path';
import { ArgvError, argOption, assertKnownFlags, finishAndExit, hasFlag } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { parseTimingReport } from './lib/test-timing-report.mjs';
import {
  SELECTOR_IDENTITY_FILES, TEST_TIER_VERSION, parseHeavyList, selectBranchTier, selectTier, summaryLine,
} from './lib/test-tier.mjs';
import { blobSha, changedFiles, committerTime, readFileAt, readTreeAt, resolveSelectionBase, selectorIdentity } from './lib/test-tier-git.mjs';
import { spawnSync } from 'node:child_process';
import { sanitizeGitEnv } from './lib/git-env-sanitize.mjs';
import { gitCommonDir } from './lib/suite-run-record.mjs';
import { CI_VERDICT_EXIT, CI_VERDICT_VERSION, ciVerdict, classifyCiVerdict, gatherCiEvidence, parseVerdictTarget, runText } from './lib/ci-verdict.mjs';
import { classifyFlakeRerun, flakeExit, gatherFlakeEvidence, rerunUnrelatedFlake, reservationFile } from './lib/ci-flake-rerun.mjs';

const EXIT = { ok: 0, error: 1, argv: 2, unmeasured: 3 };
/** The checkout this CLI's own code lives in: the selector's identity is judged against THESE files. */
const SELF = path.resolve(import.meta.dirname, '..');
/** The repository being asked about: the one containing the working directory (a test's throwaway repo, the sandbox, a checkout). */
/** Repository discovery is an explicit, sanitized operation: a failure is a refusal naming why, never a quiet fall-back to another repository (audit M10/M16). */
function discoverRepo() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8', env: sanitizeGitEnv(process.cwd()) });
  if (r.error) throw new Error(`could not run git to find the repository (${r.error.message})`);
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`${process.cwd()} is not inside a git repository, so there is no repository to ask about`);
  return path.resolve(r.stdout.trim());
}
let repoCache = null;
const repo = () => { repoCache ??= discoverRepo(); return repoCache; };

const emitJson = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
const fail = (msg) => { process.stderr.write(`test-tier: ${msg}\n`); return EXIT.error; };

/** The git blob id of a file as it is on disk in THIS CLI's own checkout (what the querying code actually is). */
function diskBlob(rel) {
  const r = spawnSync('git', ['hash-object', '--', rel], { cwd: SELF, encoding: 'utf8', env: sanitizeGitEnv(SELF) });
  return !r.error && r.status === 0 ? r.stdout.trim() : null;
}

/** Resolve everything `select` and `plan` share: the base, the tree at head, the list at head, the changed set. */
function gather({ head, base }) {
  const sb = resolveSelectionBase({ cwd: repo(), head, base });
  if (!sb.ok) return { error: sb.error };
  const tr = readTreeAt(repo(), sb.head);
  if (!tr.ok) return { error: tr.error };
  const listText = readFileAt(repo(), sb.head, '.test-tiers.json');
  let changed = [];
  if (sb.base) {
    const ch = changedFiles(repo(), sb.base, sb.head);
    if (!ch.ok) return { error: ch.error };
    changed = ch.files;
  }
  return { sb, tree: tr.tree, listText, changed };
}

function cmdSelect() {
  const head = argOption('head');
  if (!head) throw new ArgvError('test-tier select: --head <rev> is required');
  const g = gather({ head, base: argOption('base') });
  if (g.error) return fail(g.error);
  const unmeasured = (reason) => { emitJson({ version: TEST_TIER_VERSION, kind: 'counterfactual-branch', measured: false, head: g.sb.head, reason }); return EXIT.unmeasured; };
  if (g.listText === null) return unmeasured('the head has no .test-tiers.json: it predates the test tier');
  const list = parseHeavyList(g.listText);
  if (!list.ok) return unmeasured(list.reason);
  // Selector identity: the code that decides, at the head, must be the code that is asking.
  const atHead = selectorIdentity(repo(), g.sb.head);
  const differing = SELECTOR_IDENTITY_FILES.filter((f) => atHead.selector[f] !== diskBlob(f));
  if (differing.length) return unmeasured(`the selector at the head differs from this checkout's (${differing.join(', ')})`);
  const asOfFlag = argOption('as-of');
  let asOf = asOfFlag;
  if (asOf === null) { const t = committerTime(repo(), g.sb.head); if (!t.ok) return fail(t.error); asOf = t.iso; }
  if (!Number.isFinite(Date.parse(asOf))) throw new ArgvError(`test-tier select: --as-of ${JSON.stringify(asOf)} is not a time`);
  const result = selectBranchTier({ tree: g.tree, list: list.list, changed: g.changed, head: g.sb.head, base: g.sb.base, baseSource: g.sb.source, asOf: new Date(asOf).toISOString(), identity: atHead });
  if (hasFlag('json')) emitJson(result);
  else process.stdout.write(`${result.skipped.length} of ${result.heavy.length} heavy file(s) would be skipped for ${g.sb.head.slice(0, 8)}${result.escapes.length ? ` (escapes: ${result.escapes.map((e) => e.id).join(', ')})` : ''}\n`);
  return EXIT.ok;
}

function cmdPlan() {
  const head = argOption('head');
  const out = argOption('out');
  if (!head || !out) throw new ArgvError('test-tier plan: --head <rev> and --out <file> are required');
  const tier = argOption('tier');
  const g = gather({ head, base: argOption('base') });
  if (g.error) return fail(g.error);
  if (g.listText === null) return fail('the head has no .test-tiers.json');
  const list = parseHeavyList(g.listText);
  if (!list.ok) return fail(list.reason);
  const t = committerTime(repo(), g.sb.head);
  if (!t.ok) return fail(t.error);
  const envelope = selectTier({
    tree: g.tree, list: list.list, changed: g.changed, head: g.sb.head, base: g.sb.base, baseSource: g.sb.source,
    // The age of the list is judged at the push's own head, as the query does.
    asOf: t.iso, requested: tier, pushesDefault: hasFlag('pushes-default'), kind: 'push',
    identity: { manifest: blobSha(repo(), g.sb.head, '.test-tiers.json'), selector: selectorIdentity(repo(), g.sb.head).selector },
  });
  fs.writeFileSync(out, `${JSON.stringify(envelope, null, 2)}\n`);
  process.stdout.write(`${summaryLine({ tier: envelope.tier, head: envelope.head, skipped: envelope.skipped.length, base: envelope.base })}\n`);
  return EXIT.ok;
}

function cmdRefresh() {
  const file = argOption('timing');
  if (!file) throw new ArgvError('test-tier refresh-heavy: --timing <file> (a TEST_TIMING_KEEP report) is required');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return fail(`cannot read ${file}: ${e.message}`); }
  const rep = parseTimingReport(text);
  if (!rep.ok) return fail(`the timing report is unusable: ${rep.reason}`);
  if (!rep.report.complete) return fail('the timing report is partial; a refresh from a partial run would mislead');
  // The list of the repository being asked about (the one in the working directory), as `select` and `plan` read it.
  let listText;
  try { listText = fs.readFileSync(path.join(repo(), '.test-tiers.json'), 'utf8'); } catch (e) { return fail(`cannot read .test-tiers.json in ${repo()} (${e.code ?? e.message})`); }
  const list = parseHeavyList(listText);
  if (!list.ok) return fail(list.reason);
  const ms = new Map(rep.report.files.map((f) => [f.file, f.ms]));
  const lines = [`.test-tiers.json vs ${file} (report only; nothing is written)`];
  for (const h of list.list.heavy) {
    const now = ms.get(h.file);
    if (now === undefined) { lines.push(`  ${h.file}: not in the report (removed, or the run was partial)`); continue; }
    const ratio = h.measuredMs > 0 ? now / h.measuredMs : Infinity;
    if (ratio > 1.5 || ratio < 0.5) lines.push(`  ${h.file}: ${Math.round(h.measuredMs / 1000)}s listed, ${Math.round(now / 1000)}s now`);
  }
  const listed = new Set(list.list.heavy.map((h) => h.file));
  const heavyNow = rep.report.files.filter((f) => f.ms >= list.list.heavyThresholdMs && !listed.has(f.file)).sort((a, b) => b.ms - a.ms);
  for (const f of heavyNow.slice(0, 15)) lines.push(`  ${f.file}: ${Math.round(f.ms / 1000)}s, over the ${Math.round(list.list.heavyThresholdMs / 1000)}s threshold and not listed (listing it needs its own reach and a replay)`);
  if (lines.length === 1) lines.push('  no drift');
  process.stdout.write(`${lines.join('\n')}\n`);
  return EXIT.ok;
}

async function cmdCiVerdict() {
  let target;
  try { target = parseVerdictTarget(argOption('pr'), argOption('head')); } catch (e) { throw new ArgvError(`test-tier ci-verdict: ${e.message}`); }
  const { pr, head } = target;
  const rerun = hasFlag('rerun-unrelated-flake');
  if (rerun && pr === null) throw new ArgvError('test-tier ci-verdict: --rerun-unrelated-flake needs --pr <n>');
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: repo(), encoding: 'utf8', env: cmd === 'git' ? sanitizeGitEnv(repo()) : process.env, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  const r = rerun ? await flakeVerdict({ run, pr }) : ciVerdict({ run, pr, head });
  if (hasFlag('json')) emitJson(r);
  else if (r.verdict === 'full') {
    process.stdout.write(`${r.summary}\n`);
    if (r.staleBase) process.stderr.write(`ci-verdict note: tested against ${r.staleBase.tested.slice(0, 8)}, ${r.defaultBranch} is now ${r.staleBase.current.slice(0, 8)}\n`);
  } else process.stdout.write(`${r.version} ${r.verdict}${r.head ? ` ${r.head}` : ''}: ${r.reason}${r.url ? ` (${r.url})` : ''}\n`);
  if (r.rerun && !hasFlag('json')) {
    // Beside a non-failed verdict the re-run lines are a report (stderr), so the one line rule 8 reads stays alone.
    const out = r.verdict === 'failed' ? process.stdout : process.stderr;
    out.write(`rerun: ${r.rerun.rerun} - ${r.rerun.detail}\n`);
    if (r.rerun.proposal) out.write(`proposal: ${r.rerun.proposal}\n`);
  }
  return flakeExit(r.verdict, r.rerun ?? null, { ...CI_VERDICT_EXIT, error: EXIT.error }, r.attempt ?? null);
}

/**
 * `ci-verdict --pr <n> --rerun-unrelated-flake`: the verdict, then (only when it is `failed`) the flake classification
 * and at most one recorded re-run. The bare verdict stays a pure reader; this path is the only one that mutates.
 */
async function flakeVerdict({ run, pr }) {
  const g = gatherCiEvidence({ run, pr });
  if (!g.ok) return { version: CI_VERDICT_VERSION, verdict: 'unverified', reason: g.reason, rerun: { rerun: 'ineligible', detail: 'no verdict could be formed', proposal: null } };
  const ev = g.evidence;
  const verdict = { version: CI_VERDICT_VERSION, head: ev.head, pr, defaultBranch: ev.defaultBranch, ...classifyCiVerdict(ev) };
  const judged = (ev.runs ?? []).find((x) => x?.id === verdict.runId) ?? null;
  // `attempt` is part of every result past this point: the exit decision needs it (null = no judged run).
  if (!judged) return { ...verdict, attempt: null, rerun: { rerun: 'ineligible', detail: 'no judged run', proposal: null } };
  const v = { ...verdict, attempt: judged.run_attempt };
  // The git COMMON DIRECTORY (the reservation lives inside it, shared by every linked worktree), from the one shared-lib reader.
  const commonDir = gitCommonDir(repo());
  if (!commonDir) return { ...v, rerun: { rerun: 'indeterminate', detail: 'the git common dir could not be resolved', proposal: null } };
  const stateDir = path.join(commonDir, 'fleet', 'ci-flake');
  // Only a FAILED verdict is acted on. Past it (the re-run is running, or has passed) the only work left is a record this
  // tool wrote and has not finished (a proposal not yet filed); with no record there is nothing to do and no line to print.
  if (v.verdict !== 'failed' && !fs.existsSync(reservationFile(stateDir, ev.nwo, judged.id))) return v;
  // Attempt 1 is classified; a run already past it can only be taken forward from a record this tool wrote.
  let classification = null;
  if (judged.run_attempt === 1) {
    const fe = gatherFlakeEvidence({
      run, nwo: ev.nwo, judged, pr,
      readTree: (h) => readTreeAt(repo(), h),
      readHeavy: (h) => {
        const text = readFileAt(repo(), h, '.test-tiers.json');
        if (text === null) return { ok: false, why: `no readable .test-tiers.json at ${h.slice(0, 8)}` };
        const l = parseHeavyList(text);
        return l.ok ? { ok: true, heavy: l.list.heavy } : { ok: false, why: l.reason };
      },
    });
    classification = classifyFlakeRerun({ verdict: v, pr, run: judged, prHead: ev.head, ...fe, workflowPath: ev.workflowPath });
    if (!classification.eligible && fe.notes.length) classification = { ...classification, reason: `${classification.reason} (${fe.notes.slice(0, 2).join('; ')})` };
  }
  const fleet = (args) => spawnSync(process.execPath, [path.join(SELF, 'scripts', 'fleet.mjs'), ...args], { cwd: repo(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // Isolated: a reservation that cannot be taken forward (lock timeout, unwritable directory) never costs the verdict its
  // own output; beside a failed verdict it is indeterminate (exit 1), beside a passing one it is only a reported line.
  let outcome;
  try {
    outcome = await rerunUnrelatedFlake({
      stateDir,
      nwo: ev.nwo, runId: judged.id, classification, url: judged.html_url ?? '',
      readAttempt: () => {
        const a = runText(run, 'gh', ['api', `repos/${ev.nwo}/actions/runs/${judged.id}`, '--jq', '.run_attempt']);
        return a.ok && /^\d+$/.test(a.value) ? { ok: true, attempt: Number(a.value) } : { ok: false, why: a.ok ? `unexpected answer ${a.value.slice(0, 20)}` : a.why };
      },
      dispatch: () => {
        let d;
        try { d = run('gh', ['run', 'rerun', String(judged.id), '--failed', '--repo', ev.nwo]); } catch (err) { return { ok: false, rejected: false, why: err.message }; }
        if (d && !d.error && d.status === 0) return { ok: true };
        const why = d?.error?.message ?? String(d?.stderr ?? '').trim().split('\n')[0].slice(0, 200);
        // Only a definitive HTTP 4xx refusal is "rejected"; a timeout or anything else may have been accepted.
        return { ok: false, rejected: !d?.error && /HTTP 4\d\d/.test(String(d?.stderr ?? '')), why };
      },
      findProposal: (key) => {
        const r = fleet(['proposals', '--json', '--all']);
        let j;
        try { j = JSON.parse(r.stdout); } catch { return { ok: false, why: 'fleet proposals did not return JSON' }; }
        if (!j?.proposals?.complete || !Array.isArray(j.proposals.records)) return { ok: false, why: 'the proposals read is incomplete' };
        return { ok: true, id: j.proposals.records.find((p) => String(p.evidence ?? '').includes(key))?.id ?? null };
      },
      propose: ({ what, where, why, evidence }) => {
        const r = fleet(['propose', '--json', '--theme', 'ci-flakes', '--what', what, '--where', where, '--why', why, '--evidence', evidence]);
        let j;
        try { j = JSON.parse(r.stdout); } catch { return { ok: false, why: `fleet propose exited ${r.status} without JSON` }; }
        const id = j?.id ?? j?.proposal?.id;
        return j?.ok && id ? { ok: true, id } : { ok: false, why: j?.text ?? j?.error ?? `fleet propose exited ${r.status}` };
      },
    });
  } catch (err) {
    outcome = { rerun: 'indeterminate', detail: `the reservation could not be processed (${err.message}); nothing further was sent`, proposal: null };
  }
  // A failed attempt 2+ is the re-run's own result: say so beside whatever the reservation reports.
  if (v.verdict === 'failed' && judged.run_attempt !== 1) outcome = { ...outcome, detail: `already re-run once: attempt ${judged.run_attempt} failed too (${outcome.detail})` };
  return { ...v, rerun: outcome };
}

async function main() {
  assertKnownFlags(process.argv, ['--head', '--base', '--as-of', '--json', '--tier', '--pushes-default', '--out', '--timing', '--pr', '--rerun-unrelated-flake', '--selfcheck-relocation'], { cli: 'test-tier' });
  if (hasFlag('selfcheck-relocation')) { console.log('OK'); return EXIT.ok; }
  const sub = process.argv[2];
  if (sub === 'select') return cmdSelect();
  if (sub === 'plan') return cmdPlan();
  if (sub === 'refresh-heavy') return cmdRefresh();
  if (sub === 'ci-verdict') return await cmdCiVerdict();
  throw new ArgvError('usage: test-tier select --head <rev> [--base <rev>] [--json] | plan --head <rev> --out <file> [--tier full|branch] [--pushes-default] | refresh-heavy --timing <file> | ci-verdict (--pr <n> | --head <rev>) [--json] [--rerun-unrelated-flake]');
}

if (isInvokedAsScript(import.meta.url)) {
  main().then((code) => finishAndExit(code), (err) => {
    process.stderr.write(`test-tier: ${err.message}\n`);
    return finishAndExit(err instanceof ArgvError ? EXIT.argv : EXIT.error);
  });
}
