/**
 * @fileoverview The GATHERING half of `ship-commit.mjs --check-shipped-head`: the coordinator's merge-time re-check of an
 * already-shipped member (docs/plans/coordinator-aggregate-ship.md section 2.3). The decision is the pure
 * `evaluateShippedHead` (lib/ship-preauth.mjs); this module only gathers its facts, in the MEMBER'S OWN worktree, where the
 * two local markers it binds to (the gate evidence and the final-review marker) can honestly be read.
 *
 * **The child contract, v1.** Argv `--check-shipped-head --head <oid> [--json]`, cwd = the member worktree. Stdout is exactly one
 * JSON object `{schema:'shipped-head/v1', ok, head, runId, gate, conditions:[{id, ok, reason}], refusals}`. Exit 0 = ship-ok,
 * 2 = refused (or an argument the caller can correct), 1 = the checker itself errored. A caller treats exit 1, a timeout,
 * unparsable stdout, another schema, or a different `head` as REFUSED, never as a pass.
 *
 * **Read-only.** Nothing here writes the tree, the index, `.audit/` or the store; a coordinator running it can leave nothing
 * behind. It also never RAISES a gate: it reports the one the commit's own trailers carry.
 *
 * @module scripts/lib/ship-shipped-head
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveEvidence, isContentVerifiable } from './commit-trailers.mjs';
import { readFinalReviewMarker } from './final-review-marker.mjs';
import {
  evaluateShippedHead, renderShippedHeadConditions, gatherChangedPaths, defaultBaseRef,
} from './ship-preauth.mjs';
import { isShipStepDelta } from './ship-record/authority.mjs';
import { assertKnownFlags, finishAndExit } from './cli-io.mjs';

export const SHIPPED_HEAD_SCHEMA = 'shipped-head/v1';
const KNOWN_FLAGS = Object.freeze(['--check-shipped-head', '--head', '--json']);

const SHA_RE = /^[0-9a-f]{7,64}$/i;
const SHIP_TEXT_PATH_RE = /^(?:docs\/plans\/[^/]+\.md|status\.md)$/;

/** `git interpret-trailers --parse` output → `[{key, value}]` (split at the first colon). Pure. */
export function parseTrailerLines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '').map((l) => {
    const i = l.indexOf(':');
    return i < 0 ? { key: l.trim(), value: '' } : { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
  });
}

/** `git diff --name-status --no-renames -z` output → `[{status, rel}]`. Pure. A malformed tail (odd token count) is dropped loudly: null. */
export function parseNameStatusZ(out) {
  const tok = String(out ?? '').split('\0');
  if (tok.length && tok[tok.length - 1] === '') tok.pop();
  if (tok.length % 2 !== 0) return null;
  const rows = [];
  for (let i = 0; i < tok.length; i += 2) rows.push({ status: tok[i].charAt(0), rel: tok[i + 1] });
  return rows;
}

/**
 * The git runner for one worktree: `(args, {input}) => {status, stdout, stderr}`. Arguments are an argv array (no shell), so a
 * path with metacharacters or a newline is just an argument. Large outputs are allowed: a name list can be long.
 */
export function makeRunner(cwd) {
  return (args, { input } = {}) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true, input, maxBuffer: 256 * 1024 * 1024 });
    return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  };
}

/**
 * The post-audit delta (C4): what differs between the AUDITED tree and the shipped head, over every path either the head or the
 * audited state changed against its own fork point, must be only what /ship writes. Measured on trees, never on the base, so a
 * plan the branch changed before its audit is judged like any other path, a change reverted to base after the audit is still
 * inspected, and an upstream-only change a rebase brought in (a path in neither set) is correctly ignored. No pathspecs are
 * used at all: the full name list is filtered in code, so a name with glob or magic characters can never be misread.
 *
 * @param {(args: string[], o?: object) => {status: number|null, stdout: string}} run
 * @param {{auditedTree?: string|null, auditedSha?: string|null}|null} evidence
 * @param {string[]|null} headChanged the paths the head changes against its fork point (null = unmeasured)
 * @returns {{ok: boolean, reason: string}}
 */
export function computePostAuditDelta(run, evidence, headChanged) {
  const no = (reason) => ({ ok: false, reason });
  const out = (args) => { const r = run(args); return r.status === 0 ? String(r.stdout).trim() : null; };
  if (!evidence) return no('no gate-evidence marker, so the audited tree is unknown');
  const A = evidence.auditedTree;
  if (!A) return no('audited-tree-missing: the evidence marker records no audited tree');
  if (out(['cat-file', '-t', `${A}^{tree}`]) !== 'tree') return no(`audited-tree-missing: tree ${String(A).slice(0, 12)} is not in this repository (collected, or never created here)`);
  const sha = evidence.auditedSha;
  if (!sha || out(['cat-file', '-t', `${sha}^{commit}`]) !== 'commit') return no('audited-sha-missing: the audited commit is unknown or not in this repository, so the audit\'s own fork point cannot be found');
  if (!Array.isArray(headChanged)) return no('the head\'s change set could not be resolved, so nothing was checked');
  const base = defaultBaseRef((a) => run(a));
  const fork = out(['merge-base', sha, base]);
  if (!fork) return no(`the audited commit's fork point against ${base} could not be resolved`);
  const pa = run(['diff', '--name-only', '--no-renames', '-z', fork, A]);
  if (pa.status !== 0) return no('the audited tree could not be diffed against its fork point');
  const candidate = new Set([...headChanged, ...String(pa.stdout).split('\0').filter(Boolean)]);
  const headTree = out(['rev-parse', 'HEAD^{tree}']);
  if (!headTree) return no('the head tree could not be resolved');
  const d = run(['diff', '--name-status', '--no-renames', '-z', A, headTree]);
  if (d.status !== 0) return no('the audited tree could not be diffed against the head');
  const rows = parseNameStatusZ(d.stdout);
  if (rows === null) return no('the name-status output was malformed, so nothing was checked');
  const refused = [];
  let judged = 0;
  for (const { status, rel } of rows) {
    if (!candidate.has(rel)) continue; // an upstream-only path (a rebase): not this member's change
    judged++;
    let oldText = null;
    let newText = null;
    if (SHIP_TEXT_PATH_RE.test(rel) && status === 'M') {
      const o = run(['show', `${A}:${rel}`]);
      const n = run(['show', `${headTree}:${rel}`]);
      oldText = o.status === 0 ? o.stdout : null;
      newText = n.status === 0 ? n.stdout : null;
    }
    const why = isShipStepDelta({ status, rel, oldText, newText });
    if (why) refused.push(`${rel}: ${why}`);
  }
  if (refused.length) return no(`${refused.length} path(s) changed since the audit that /ship does not write: ${refused.slice(0, 3).join('; ')}${refused.length > 3 ? `; +${refused.length - 3} more` : ''}`);
  return { ok: true, reason: judged === 0 ? 'the head tree equals the audited tree on every path the branch touches' : `${judged} path(s) differ from the audited tree, each a ship-step edit` };
}

/**
 * The default store adapter, loaded lazily so a checkout with the store off still runs the whole check and refuses with a reason.
 * @returns {{runFacts: (runId: string) => Promise<object>, repoId: (cwd: string) => Promise<object>}}
 */
export function createStoreAdapter() {
  return {
    async runFacts(runId) {
      try { const m = await import('./store/ship-run-facts.mjs'); return await m.getShipRunFacts(runId); } catch (e) { return { row: null, why: `the store modules could not be loaded (${e?.code || e?.message || 'error'})` }; }
    },
    async repoId(cwd) {
      try { const m = await import('./store/ship-run-facts.mjs'); return await m.getShipRepoId(cwd); } catch (e) { return { repoId: null, why: `the store modules could not be loaded (${e?.code || e?.message || 'error'})` }; }
    },
  };
}

/**
 * Gather every fact and evaluate. Never throws: any failure to read a fact becomes that fact's refusal.
 *
 * @param {{repoRoot: string, head: string, run?: Function, store?: ReturnType<typeof createStoreAdapter>}} o
 * @returns {Promise<{schema: string, ok: boolean, head: string, runId: string|null, gate: string|null, conditions: object[], refusals: string[]}>}
 */
export async function checkShippedHead({ repoRoot, head, run = makeRunner(repoRoot), store = createStoreAdapter() }) {
  const envelope = (v, headOid) => ({ schema: SHIPPED_HEAD_SCHEMA, ok: v.ok, head: headOid, runId: v.runId ?? null, gate: v.gate ?? null, conditions: v.conditions, refusals: v.refusals });
  const pre = (id, reason) => ({ ok: false, runId: null, gate: null, conditions: [{ id, ok: false, reason }], refusals: [`${id}: ${reason}`] });

  const resolved = run(['rev-parse', '--verify', '--quiet', `${head}^{commit}`]);
  const headOid = resolved.status === 0 ? String(resolved.stdout).trim() : null;
  if (!headOid) return envelope(pre('head', `${head} is not a commit in this repository`), head);
  const checkedOut = run(['rev-parse', '--verify', 'HEAD']);
  if (checkedOut.status !== 0 || String(checkedOut.stdout).trim() !== headOid) {
    return envelope(pre('head', `the member worktree has ${String(checkedOut.stdout).trim().slice(0, 12) || 'no HEAD'} checked out, not ${headOid.slice(0, 12)}: the local evidence markers belong to the checked-out head`), headOid);
  }

  const msg = run(['log', '-1', '--format=%B', headOid]);
  let trailers = null;
  if (msg.status === 0) {
    const t = run(['interpret-trailers', '--parse'], { input: msg.stdout });
    if (t.status === 0) trailers = parseTrailerLines(t.stdout);
  }

  const ts = run(['log', '-1', '--format=%ct', headOid]);
  const evidence = resolveEvidence({
    auditRunPath: path.join(repoRoot, '.audit', 'last-audit-run.json'),
    headCommitTs: ts.status === 0 ? Number(String(ts.stdout).trim()) || 0 : 0,
    noRunId: false,
  });
  const verifiable = isContentVerifiable(evidence);
  const branchRes = run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const currentBranch = branchRes.status === 0 ? String(branchRes.stdout).trim() : null;

  const runRes = verifiable ? await store.runFacts(evidence.runId) : { row: null, why: `there is no usable gate-evidence marker (state: ${evidence.state})` };
  const repoRes = await store.repoId(repoRoot);
  const changedPaths = gatherChangedPaths((a) => run(a), 'HEAD');
  const usable = verifiable ? evidence : null;

  const verdict = evaluateShippedHead({
    trailers,
    evidence: usable,
    evidenceWhy: verifiable ? undefined : `state: ${evidence.state}`,
    currentBranch,
    runRow: runRes.row,
    runRowWhy: runRes.why ?? undefined,
    repoId: repoRes.repoId,
    finalReview: readFinalReviewMarker(repoRoot),
    delta: computePostAuditDelta(run, usable, changedPaths),
    changedPaths,
  });
  return envelope(verdict, headOid);
}

/**
 * The CLI half: parse argv, run the check in the cwd's worktree, print, exit. `argv` is `process.argv.slice(2)`.
 * Exits 0 (ship-ok), 2 (refused / a correctable argument) or 1 (the checker errored); stdout is drained before exiting.
 */
export async function runShippedHeadCli(argv, { cwd = process.cwd(), store } = {}) {
  const json = argv.includes('--json');
  const i = argv.indexOf('--head');
  const head = i >= 0 ? argv[i + 1] : undefined;
  const others = argv.filter((a, k) => a !== '--check-shipped-head' && a !== '--json' && a !== '--head' && k !== i + 1);
  const bad = (reason) => {
    if (json) process.stdout.write(`${JSON.stringify({ schema: SHIPPED_HEAD_SCHEMA, ok: false, head: head ?? null, runId: null, gate: null, conditions: [{ id: 'args', ok: false, reason }], refusals: [`args: ${reason}`] })}\n`);
    process.stderr.write(`AGENT FIX: --check-shipped-head: ${reason}. Usage: --check-shipped-head --head <oid> [--json], alone, from the member's worktree.\n`);
    return finishAndExit(2);
  };
  // An unknown flag is refused by NAME before anything runs: a read-only check must never silently ignore what was asked of it.
  try { assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'ship-commit --check-shipped-head', from: 0 }); } catch (e) { return bad(`${e.message.split('. ')[0]}; a standalone read-only check cannot be combined with other flags`); }
  if (head === undefined || head.startsWith('--') || !SHA_RE.test(head)) return bad('--head needs a commit oid');
  if (others.length > 0) return bad(`a standalone read-only check cannot be combined with ${others.join(' ')}`);
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8', windowsHide: true });
  if (top.error || top.status !== 0) { process.stderr.write(`ship-commit: --check-shipped-head: not a git worktree (${(top.stderr || '').trim() || 'git failed'})\n`); return finishAndExit(1); }
  const repoRoot = String(top.stdout).trim();
  let env;
  try { env = await checkShippedHead({ repoRoot, head, store }); } catch (e) {
    process.stderr.write(`ship-commit: --check-shipped-head errored: ${e?.message ?? e}\n`);
    return finishAndExit(1);
  }
  if (json) process.stdout.write(`${JSON.stringify(env)}\n`);
  else process.stdout.write(`${[...renderShippedHeadConditions(env), `ship-commit: shipped head ${env.head.slice(0, 12)} ${env.ok ? 'SHIP-OK' : 'NEEDS-USER'}`].join('\n')}\n`);
  return finishAndExit(env.ok ? 0 : 2);
}
