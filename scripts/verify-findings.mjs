#!/usr/bin/env node
/**
 * @fileoverview `verify-findings` — settle a CONTESTED audit finding with a quoted line instead of another round.
 *
 * A finding the author disputes (triage `validity: uncertain` or `action: rebut`), the auditor re-raises after a
 * dismissal, or that flips with no file change, gets one deterministic evidence pack and ONE model call. The verdict is
 * evidence for triage and never a ruling: nothing here writes the ledger or dismisses anything.
 *
 *   node scripts/verify-findings.mjs --sid $SID --round N [--triage <file>] [--max 10] [--run-test <path>]… \
 *     --out .audit/$SID-rN-verify.json
 *   node scripts/verify-findings.mjs --sid $SID --round N --check .audit/$SID-rN-verify.json
 *
 * Exit 0: complete. Exit 3: at least one item failed, so the run is INCOMPLETE. Exit 2: bad input, or the tree moved.
 * Exit 1: unsupported verifier model family. Plan: docs/plans/sashiko-audit-improvements.md §4.
 *
 * @module scripts/verify-findings
 */
import './lib/load-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { assertKnownFlags, ArgvError, emit, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { sha256 } from './lib/audit/call-record.mjs';
import { captureTargetIdentity } from './lib/audit/target-identity.mjs';
import { modelFamily } from './lib/model-resolver.mjs';
import { execFileSync } from 'node:child_process';
import {
  VERIFY_SCHEMA_VERSION, VerdictModelSchema, VerifyArtifactSchema, selectContested, buildEvidencePack, runTestItem,
  validateVerdict, verifierPrompt, validateVerifyItem, triageLine,
} from './lib/audit/contested-findings.mjs';

const KNOWN_FLAGS = ['--sid', '--round', '--triage', '--max', '--run-test', '--model', '--out', '--check', '--selfcheck-relocation'];
const MODEL_OK = /^(latest-gpt(-mini)?|gpt-[A-Za-z0-9._-]+)$/;
const MAX_TESTS = 2;

function values(argv, flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1]) out.push(argv[i + 1]);
  return out;
}
const one = (argv, flag) => values(argv, flag)[0] ?? null;

function readJson(p, label) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { throw new ArgvError(`verify-findings: cannot read ${label} ${p}: ${e.message}`); }
}

function failureCategory(err) {
  if (err?.category) return String(err.category);
  if (err?.status === 429) return 'http-429';
  if (/timeout|abort/i.test(err?.message ?? '')) return 'timeout';
  return 'permanent';
}

const sameTree = (a, b) => a.auditedTree && b.auditedTree && a.auditedTree === b.auditedTree;

/**
 * The whole run, with its dependencies injected. Returns `{exit, envelope, lines}` and never exits the process.
 *
 * @param {{sid: string, round: number, max?: number, triagePath?: string|null, tests?: string[], model?: string|null,
 *   out?: string|null, check?: string|null}} args
 * @param {{repoRoot?: string, callModel?: (opts: object) => Promise<{result: object, model?: string}>}} [deps]
 */
export async function verifyMain(args, deps = {}) {
  const repoRoot = deps.repoRoot ?? process.cwd();
  const { sid, round } = args;
  const resultPath = path.join(repoRoot, '.audit', `${sid}-r${round}-result.json`);
  if (!fs.existsSync(resultPath)) return { exit: 2, envelope: { ok: false, error: `no round result at ${resultPath}` }, lines: [] };

  if (args.check) {
    const artifact = readJson(path.resolve(repoRoot, args.check), 'artifact');
    const shape = VerifyArtifactSchema.safeParse(artifact);
    if (!shape.success) return { exit: 2, envelope: { ok: false, error: `artifact fails its schema: ${shape.error.issues[0]?.message} at ${shape.error.issues[0]?.path.join('.')}` }, lines: [] };
    const lines = []; const routed = []; const invalid = [];
    for (const item of artifact.items) {
      const id = item?.source?.findingId;
      const v = validateVerifyItem(artifact, id, { repoRoot, resultPath });
      if (v.ok) { lines.push(triageLine(id, v.item)); if (v.item.state === 'inconclusive') routed.push(id); }
      else if (item?.state === 'over-cap' || item?.state === 'failed') routed.push(id);
      else { process.stderr.write(`  [verify] ${id}: not shown to triage — ${v.reason}\n`); routed.push(id); invalid.push({ findingId: id, reason: v.reason }); }
    }
    for (const id of routed) lines.push(`${id} → rebuttal`);
    const whole = invalid.length === 0 && artifact.complete === true;
    return { exit: whole ? 0 : 3, envelope: { ok: whole, mode: 'check', complete: artifact.complete, shown: lines.length, lines, invalid }, lines: [] };
  }

  if (!args.out) throw new ArgvError('verify-findings: --out <artifact> is required: a verification that is not written is lost.');
  const outAbs = path.resolve(repoRoot, args.out);
  const priors = Array.from({ length: round }, (_, i) => path.join(repoRoot, '.audit', `${sid}-r${i + 1}-result.json`));
  const inputs = [...priors, path.join(repoRoot, '.audit', `${sid}-ledger.json`), args.triagePath && path.resolve(repoRoot, args.triagePath)].filter(Boolean);
  if (inputs.some((p) => path.resolve(p).toLowerCase() === outAbs.toLowerCase())) throw new ArgvError('verify-findings: --out would overwrite one of this run\'s inputs (a round result, the ledger or the triage file).');
  const tests = args.tests ?? [];
  if (tests.length > MAX_TESTS) throw new ArgvError(`verify-findings: at most ${MAX_TESTS} --run-test paths`);
  if (args.model && !MODEL_OK.test(args.model)) {
    return { exit: 1, envelope: { ok: false, error: `unsupported verifier model family "${args.model}": v1 accepts GPT sentinels and ids only (latest-gpt, latest-gpt-mini, gpt-…)` }, lines: [] };
  }

  const raw = fs.readFileSync(resultPath);
  const result = JSON.parse(raw.toString('utf-8'));
  const id0 = captureTargetIdentity(repoRoot);
  if (!id0.auditedTree || !id0.auditedSha) return { exit: 2, envelope: { ok: false, error: 'cannot capture the working-tree identity; nothing was sent' }, lines: [] };
  const stamped = result._auditedTree;
  if (!stamped) {
    return { exit: 2, envelope: { ok: false, error: 'the round result carries no audited-tree stamp (_auditedTree), so the evidence cannot be tied to what the round read; re-run the round with current tooling. Nothing was sent' }, lines: [] };
  }
  if (stamped !== id0.auditedTree) {
    return { exit: 2, envelope: { ok: false, error: 'tree moved: the working tree is not the tree this round audited; nothing was sent' }, lines: [] };
  }

  const results = [];
  for (let r = 1; r <= round; r++) {
    const p = path.join(repoRoot, '.audit', `${sid}-r${r}-result.json`);
    if (r === round) results.push({ round: r, result });
    else if (fs.existsSync(p)) results.push({ round: r, result: readJson(p, `round ${r} result`) });
  }
  const ledgerPath = path.join(repoRoot, '.audit', `${sid}-ledger.json`);
  const ledger = fs.existsSync(ledgerPath) ? readJson(ledgerPath, 'ledger') : { entries: [] };
  const triage = args.triagePath ? readJson(path.resolve(repoRoot, args.triagePath), 'triage') : {};
  // Trees, not commit shas: two rounds on a dirty tree share a HEAD sha but not a tree, and `git diff` takes tree ids.
  const shaByRound = Object.fromEntries(results.filter((r) => r.result._auditedTree).map((r) => [r.round, r.result._auditedTree]));
  const changedFiles = (a, b) => { try { return execFileSync('git', ['diff', '--name-only', a, b], { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean); } catch { return null; } };
  const { selected, overCap, notSelected } = selectContested({ results, ledger, triage, max: args.max ?? 10, shaByRound, changedFiles });

  // Acquisition, tests included, happens BEFORE any model call; the tree must still be the audited one afterwards.
  const ctx = { repoRoot, headSha: id0.auditedSha };
  const testItems = [];
  for (const t of tests) {
    const r = runTestItem(t, ctx);
    if (r.error) throw new ArgvError(`verify-findings: ${r.error}`);
    testItems.push(r.item);
  }
  const prepared = selected.map((c) => {
    try {
      const { pack, packHash } = buildEvidencePack({ finding: c.finding, repoRoot, headSha: id0.auditedSha, testItems });
      return { c, pack, packHash };
    } catch (e) { process.stderr.write(`  [verify] ${c.source.findingId}: acquisition failed: ${e.message}
`); return { c, error: e }; }
  });
  const id1 = captureTargetIdentity(repoRoot);
  if (!sameTree(id0, id1)) {
    return { exit: 2, envelope: { ok: false, error: 'tree moved during verification; nothing was sent' }, lines: [] };
  }

  // The client is built only when there is something to send: no contests, or only failed acquisitions, needs none.
  const callModel = deps.callModel ?? (prepared.some((p) => !p.error) ? await defaultCallModel(args.model) : null);
  const items = [];
  for (const p of prepared) {
    const base = { source: p.c.source, contestKind: p.c.contestKind };
    if (p.error) { items.push({ ...base, state: 'failed', failure: { stage: 'acquire', category: 'acquire' } }); continue; }
    const prompt = verifierPrompt(p.c.finding, p.pack);
    let res;
    try {
      res = await callModel({ ...prompt, schema: VerdictModelSchema, schemaName: 'verify_verdict', reasoning: 'medium', passName: `verify-${p.c.source.findingId}` });
    } catch (e) {
      process.stderr.write(`  [verify] ${p.c.source.findingId}: call failed: ${e.message}
`);
      items.push({ ...base, state: 'failed', failure: { stage: 'call', category: failureCategory(e) }, evidence: { pack: p.pack, packHash: p.packHash } });
      continue;
    }
    const model = res.model ?? 'unknown';
    const family = { verifier: modelFamily(model) ?? 'unknown', finder: modelFamily(p.c.finding._sourceModel) ?? 'unknown', selfFamily: false };
    family.selfFamily = family.verifier !== 'unknown' && family.verifier === family.finder;
    const checked = validateVerdict(res.result, p.pack);
    if (checked.backed) {
      items.push({ ...base, state: 'verified', verdict: checked.verdict, label: 'evidence-backed', evidence: { refs: res.result.evidenceRefs, quote: res.result.quote, pack: p.pack, packHash: p.packHash }, reason: res.result.reason, severityIfConfirmed: res.result.severityIfConfirmed, model, family });
    } else {
      items.push({ ...base, state: 'inconclusive', verdict: 'inconclusive', evidence: { pack: p.pack, packHash: p.packHash }, reason: res.result.reason, model, family, ...(checked.demotedFrom ? { demotedFrom: checked.demotedFrom, demotionRule: checked.demotionRule } : {}) });
    }
  }
  for (const o of overCap) items.push({ source: o.source, contestKind: o.contestKind, state: 'over-cap', rank: o.rank });

  const count = (s) => items.filter((i) => i.state === s).length;
  const counts = { verified: count('verified'), inconclusive: count('inconclusive'), overCap: count('over-cap'), failed: count('failed') };
  const artifact = {
    schemaVersion: VERIFY_SCHEMA_VERSION, sid, round, resultSha256: sha256(raw), auditedTree: id0.auditedTree, evidenceTree: id1.auditedTree,
    headSha: id0.auditedSha, complete: counts.failed === 0, counts, items, notSelected,
  };
  VerifyArtifactSchema.parse(artifact);
  if (args.out) atomicWriteFileSync(path.resolve(repoRoot, args.out), `${JSON.stringify(artifact, null, 2)}\n`);
  const routing = items.filter((i) => i.state !== 'verified').map((i) => ({ findingId: i.source.findingId, state: i.state }));
  return {
    exit: artifact.complete ? 0 : 3,
    envelope: { ok: artifact.complete, complete: artifact.complete, counts, routing, out: args.out ?? null },
    lines: [],
  };
}

async function defaultCallModel(model) {
  const [{ createOpenAIClient }, llm, { resolveModel }] = await Promise.all([
    import('./lib/openai-client.mjs'), import('./lib/audit/llm-helpers.mjs'), import('./lib/model-resolver.mjs'),
  ]);
  if (model) llm.setModel(resolveModel(model));
  const openai = await createOpenAIClient();
  return (opts) => llm.callGPT(openai, opts);
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'verify-findings' });
  const argv = process.argv.slice(2);
  const sid = one(argv, '--sid');
  const round = Number(one(argv, '--round'));
  if (!sid || !Number.isInteger(round) || round < 1) throw new ArgvError('verify-findings: --sid <id> and --round <N> (a positive integer) are required.');
  const max = one(argv, '--max') === null ? 10 : Number(one(argv, '--max'));
  if (!Number.isInteger(max) || max < 0) throw new ArgvError('verify-findings: --max must be a non-negative integer.');
  const { exit, envelope, lines } = await verifyMain({
    sid, round, max, triagePath: one(argv, '--triage'), tests: values(argv, '--run-test'),
    model: one(argv, '--model'), out: one(argv, '--out'), check: one(argv, '--check'),
  });
  if (exit) process.exitCode = exit;
  emit(envelope);
  await finishAndExit(exit);
}

if (isInvokedAsScript(import.meta.url)) {
  main().catch(async (err) => {
    const argv = err instanceof ArgvError || err?.code === 'ARGV_ERROR';
    process.stderr.write(`${err.message}\n`);
    process.exitCode = argv ? 2 : 1;
    emit({ ok: false, error: err.message });
    await finishAndExit(process.exitCode);
  });
}
