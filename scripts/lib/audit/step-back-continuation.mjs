/**
 * @fileoverview Pilot 1's continuation runner (docs/plans/seeded-defect-benchmark.md §2.1): from ONE frozen decision point,
 * run the NEXT audit round twice-toggled — META (the production gate, meta-review on) and CONTINUE (`--no-meta-review`, then
 * the production human-override `--past-cap` at T1) — so the arms differ only by the meta-review.
 *
 * RESTORING A POINT. The production gate finds a session by the `<sid>` of `--out <sid>-r<N>-result.json` under the cwd's
 * `.audit/`. So a run: (1) materialises a case tree of the repo at the point's tree sha; (2) writes the sealed snapshot's
 * round results r1..rN and the ledger as of the checkpoint under a FRESH sid `sb-<pointId>-<arm>-<rep>`, digest-checked
 * after the write; (3) re-issues the audit invocation with `--round N+1`; (4) validates, BEFORE any provider call, that the
 * gate's computed trigger equals the point's frozen trigger (and, for T2, that the checkpoint-3 round signal fires), else the
 * point is `unrecoverable`, never run; (5) removes the tree after the result, meta log and stderr are copied out.
 *
 * The audit itself is a CHILD process (`openai-audit.mjs`, the production entry) in the case tree with
 * `AUDIT_ALLOW_FOREIGN_CWD=1`; its provider calls inherit `AUDIT_BUDGET_LEDGER`, so the hard `--max-usd` is enforced at the
 * provider-call seams (§2.6), not here. A META stop never runs its debt command: it is recorded, never executed.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/step-back-continuation
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { withCaseTree } from '../model-eval/case-tree.mjs';
import { validateAuditRound, META_T2_ROUND } from './round-cap.mjs';
import { metaTriggerFor, readMetaLog, metaLogPath, foldMetaLog } from './meta-review.mjs';
import { topicOf } from './cap-productivity.mjs';
import { computeRoundSignals, makeGitRunner } from './round-signals.mjs';
import { decideMetaPilot, scoreMetaRuns, SEEDED_BENCH_EPOCH } from './meta-pilot-decision.mjs';

export { decideMetaPilot, scoreMetaRuns, SEEDED_BENCH_EPOCH };

export const CONTINUATION_PAST_CAP_REASON = 'seeded-bench continuation control';
export const EXIT_BUDGET_STOP = 5;
const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '-');

/** The fresh session id a run uses. */
export const sidFor = ({ pointId, arm, rep }) => `sb-${safe(pointId)}-${arm.toLowerCase()}-${rep}`;

export const unrecoverable = (reason) => ({ ok: false, status: 'unrecoverable', reason });

/**
 * The invocation(s) of one arm. Pure. META is ONE invocation (the gate decides); CONTINUE at T1 is two: the refused
 * first one writes the structural card (no inference call), the second adds the production override.
 * @returns {{base: string[], invocations: string[][]}}
 */
export function buildArmInvocations({ point, arm, base: scopeBase = null, sid }) {
  const rel = (f) => `.audit/${f}`;
  const common = [point.mode, point.planFile, '--round', String(point.round), '--ledger', rel(`${sid}-ledger.json`), '--out', rel(`${sid}-r${point.round}-result.json`)];
  if (point.mode === 'code') common.push('--scope', 'diff', '--base', scopeBase ?? 'HEAD~1');
  if (arm === 'META') return { base: common, invocations: [[...common]] };
  if (arm !== 'CONTINUE') throw new Error(`unknown arm "${arm}"`);
  const off = [...common, '--no-meta-review'];
  return { base: common, invocations: point.trigger === 'T1' ? [off, [...off, '--past-cap', CONTINUATION_PAST_CAP_REASON]] : [off] };
}

/** The two arms' argv with every meta-review flag removed: must be identical (the arms differ only by the toggle). */
export function stripMetaFlags(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-meta-review') continue;
    if (argv[i] === '--past-cap') { i++; continue; }
    out.push(argv[i]);
  }
  return out;
}

/** The child environment: identical for both arms. Store writes, version checks and the arch embedding call are off. */
export function childEnv({ base = process.env, ledgerFile }) {
  return {
    ...base,
    AUDIT_CANARY: '1', AUDIT_ALLOW_FOREIGN_CWD: '1', AUDIT_BUDGET_LEDGER: ledgerFile,
    AUDIT_DB_URL: '', // the air-gap signal: a pilot round must not write the real audit store
    LEARNING_DISABLE: '1', AUDIT_TOOL_VERSION_CHECK: 'skip', AUDIT_CARD_NO_ARCH: '1', AUDIT_META_REVIEW: '',
  };
}

/** Findings exactly as the matcher and the human worksheet read them. */
export function findingView(f, runKey, i) {
  const section = String(f.section ?? '');
  const m = /:(\d+)(?:-(\d+))?/.exec(section);
  return {
    key: `${runKey}:${f._pass ?? ''}:${f.id ?? i}`, id: String(f.id ?? i), severity: String(f.severity ?? '').toUpperCase(),
    file: f._primaryFile ?? f.file ?? (f.affectedFiles?.[0] ?? null), affectedFiles: f.affectedFiles ?? [],
    lines: m ? [Number(m[1]), Number(m[2] ?? m[1])] : null,
    text: [f.category, f.section, f.detail, f.risk, f.recommendation].filter(Boolean).join('\n'),
    priorRuling: Boolean(f._priorRuling), pass: f._pass ?? null,
  };
}

/** The ledger entries of a sealed snapshot as matcher targets X: the original finding's text where the snapshot holds it. */
export function ledgerTargets(snapshot, { upToRound = Infinity } = {}) {
  const byId = new Map(); const byTopic = new Map();
  // Text is resolved ONLY from rounds a reader at `upToRound` could have seen (no later re-raise overrides an earlier concern's text).
  for (const r of snapshot.rounds) if (r.round <= upToRound) for (const f of r.findings) { if (!byId.has(f.id)) byId.set(f.id, f); const t = f.topicId ?? f._hash; if (!byTopic.has(t)) byTopic.set(t, f); } // FIRST raise wins: the concern's original text, not a later re-raise
  return snapshot.ledgerEntries.map((e, i) => {
    const f = byId.get(e.findingId) ?? byTopic.get(e.topicId) ?? null;
    return {
      id: String(e.topicId ?? e.findingId ?? i), file: e.affectedFiles?.[0] ?? f?._primaryFile ?? null, files: e.affectedFiles?.length ? e.affectedFiles : undefined, lines: null,
      severity: String(e.severity ?? f?.severity ?? '').toUpperCase(),
      // A ruling is later state unless it was made by `upToRound`: never let it leak into an earlier frame.
      text: [e.category, f?.section, f?.detail, (e.round ?? 0) <= upToRound ? e.ruling : null].filter(Boolean).join('\n'),
    };
  });
}

/**
 * A restored finding as a LIVE finding is: the store's own `topicId` (an 8-hex fingerprint) is dropped. A live finding carries none, so the
 * reviewer pack, its reply validator and the guard's inventory all derive the topic the same way (`topicOf`); leaving the store id on the
 * finding made the pack and the validator speak 8-hex while the guard spoke 12-hex (measured on the Pilot 1 rehearsal: 0 of 5 decisions honoured).
 */
export function toLiveFinding(f) { const { topicId: _store, ...rest } = f ?? {}; return rest; }

/**
 * The store-reconstructed ledger entries in the shape the audit's own ledger readers expect (`pass`, `section`, `detail`,
 * `semanticHash`, `ruling` ...). The ledger entry's topic is what the live ledger writer would have derived from its finding
 * (`topicOf`), so it matches the reviewer pack, the validator and the guard's inventory; an entry whose finding is not in the
 * snapshot keeps the store fingerprint (it matches nothing live, as before). The derived id approximates the original live id:
 * a stated limit of the reconstruction, identical for both arms.
 */
export function toAuditLedgerEntries(snapshot) {
  const byId = new Map();
  for (const r of snapshot.rounds) for (const f of r.findings) byId.set(f.id, f);
  const sev = (x) => (['HIGH', 'MEDIUM', 'LOW'].includes(String(x).toUpperCase()) ? String(x).toUpperCase() : 'MEDIUM');
  return snapshot.ledgerEntries.map((e) => {
    const live = byId.get(e.findingId);
    const f = live ?? {};
    const category = String(e.category ?? f.category ?? '');
    const topicId = live ? topicOf(toLiveFinding(live)) : String(e.topicId);
    return {
      topicId, latestFindingId: e.findingId ?? undefined, semanticHash: topicId, severity: sev(e.severity), originalSeverity: sev(e.severity),
      category, section: String(f.section ?? e.affectedFiles?.[0] ?? ''), detail: String(f.detail ?? ''), pass: /^\[([^\]]+)\]/.exec(category)?.[1]?.toLowerCase() ?? 'backend',
      affectedFiles: e.affectedFiles ?? [], adjudicationOutcome: e.adjudicationOutcome, remediationState: e.remediationState ?? 'pending',
      ruling: e.ruling ?? 'sustain', rulingRationale: '', resolvedRound: Number.isInteger(e.round) ? e.round : e.firstSeenRound, round: e.firstSeenRound, source: 'session',
    };
  });
}

/** Write the sealed snapshot into `<dir>/.audit` under the fresh sid and verify every byte by reading it back. */
export function restorePointFiles({ dir, point, snapshot, sid, fsImpl = fs }) {
  const auditDir = path.join(dir, '.audit');
  // A historical tree may carry a committed symlink at `.audit` (or at a result path): refuse before writing through it.
  const isLink = (p) => { try { return fsImpl.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  if (isLink(auditDir)) throw new Error('the tree has a symlink at .audit; refusing to write through it');
  fsImpl.mkdirSync(auditDir, { recursive: true });
  const written = [];
  const put = (name, obj) => { const p = path.join(auditDir, name); if (isLink(p)) throw new Error(`${name} is a symlink in the tree; refusing to write through it`); const text = `${JSON.stringify(obj, null, 2)}\n`; fsImpl.writeFileSync(p, text); if (sha256Hex(fsImpl.readFileSync(p)) !== sha256Hex(text)) throw new Error(`restore verification failed for ${name}`); written.push(name); };
  for (const r of snapshot.rounds) put(`${sid}-r${r.round}-result.json`, { round: r.round, verdict: r.verdict, findings: r.findings.map(toLiveFinding), _auditedSha: r.auditedSha, _sid: sid });
  const digest = sha256Hex(JSON.stringify({ rounds: snapshot.rounds, ledgerEntries: snapshot.ledgerEntries }));
  if (digest !== point.snapshotDigest) throw new Error('snapshot digest does not match the frozen point');
  put(`${sid}-ledger.json`, { version: 1, meta: { round: point.checkpoint, auditedSha: point.checkpointSha, reconstructedFrom: 'store-events' }, entries: toAuditLedgerEntries(snapshot) });
  // Meta-review history up to the checkpoint: the sealed store era predates the meta-review, so none was recorded. A log that
  // appears here is refused, never merged (an unrecoverable point, §2.1 step 2).
  if (fsImpl.existsSync(metaLogPath(auditDir, sid))) throw new Error('a meta-review log already exists for a fresh sid');
  return { auditDir, written };
}

const gitOut = (cwd, args) => { try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

/** The `--base` of a code round: the fork point from the default branch; else the parent of the session's first audited sha. */
export function resolveScopeBase({ repoRoot, treeSha, firstSha, git = gitOut }) {
  for (const main of ['origin/main', 'main', 'origin/master', 'master']) {
    const mb = git(repoRoot, ['merge-base', main, treeSha]);
    if (mb && mb !== git(repoRoot, ['rev-parse', treeSha])) return { ok: true, base: mb, via: `merge-base ${main}` };
  }
  const parent = firstSha ? git(repoRoot, ['rev-parse', `${firstSha}~1`]) : null;
  return parent ? { ok: true, base: parent, via: 'parent of the first audited sha' } : { ok: false, reason: 'no fork point found for the diff scope' };
}

/**
 * Before any provider call: the gate's own computed trigger must equal the frozen one, and a T2 point's checkpoint-3 round
 * signal must fire (an unmeasured signal never fires). A mismatch makes the point unrecoverable, never run.
 */
export function validateTrigger({ point, snapshot, dir, signals = computeRoundSignals, git = makeGitRunner }) {
  const v = validateAuditRound({ mode: point.mode, round: point.round, pastCapReason: null });
  const computed = metaTriggerFor({ mode: point.mode, round: point.round, refusalCode: v.ok ? null : v.code });
  if (computed !== point.trigger) return unrecoverable(`the gate computes trigger ${computed ?? 'none'} for ${point.mode} round ${point.round}; the point froze ${point.trigger}`);
  if (point.trigger === 'T2') {
    const s = signals({ round: point.checkpoint, rounds: snapshot.rounds, ledgerEntries: snapshot.ledgerEntries, git: git(dir) });
    if (!s.anyFires) return unrecoverable(`T2 round signals did not fire at checkpoint ${point.checkpoint} (${s.unmeasured?.length ? `unmeasured: ${s.unmeasured.join(', ')}` : 'quiet'}): no decision point`);
  }
  return { ok: true };
}

const stderrCode = (stderr) => /Error \[([A-Z_]+)\]/.exec(stderr || '')?.[1] ?? null;

/**
 * Classify one arm's invocations. Pure. `inv` = [{status, stderr}]; `result` = parsed `--out` file or null.
 * @returns {{valid: boolean, invalidReason: string|null, roundRan: boolean, stopRun: boolean, stopKind: string|null}}
 */
export function classifyOutcome({ arm, point, inv, result }) {
  const last = inv[inv.length - 1];
  const code = stderrCode(last?.stderr);
  const budget = inv.some((i) => i.status === EXIT_BUDGET_STOP || /budget-stop|BudgetStop/i.test(i.stderr || ''));
  if (budget) return { valid: false, invalidReason: 'budget-stop', roundRan: false, stopRun: false, stopKind: null };
  if (arm === 'META' && last.status === 4) {
    if (code === 'META_STOP' || code === 'META_STRUCTURAL') return { valid: true, invalidReason: null, roundRan: false, stopRun: true, stopKind: code === 'META_STOP' ? 'meta-stop' : 'meta-structural' };
    // The meta call fell to the production default (downgraded / unavailable): a T1 refusal, exactly as production behaves.
    if (code === 'PAST_CAP_REQUIRED' || code === 'CARD_REQUIRED') return { valid: true, invalidReason: null, roundRan: false, stopRun: false, stopKind: 'default-refusal' };
  }
  if (arm === 'CONTINUE' && point.trigger === 'T1' && inv.length === 2 && inv[0].status !== 4) return { valid: false, invalidReason: `provider-error: the card step exited ${inv[0].status}`, roundRan: false, stopRun: false, stopKind: null };
  if (last.status === 3) return { valid: false, invalidReason: 'pass-lost: the round exited 3 (INCOMPLETE)', roundRan: true, stopRun: false, stopKind: null };
  if (last.status !== 0) return { valid: false, invalidReason: `provider-error: exit ${last.status}${code ? ` [${code}]` : ''}`, roundRan: false, stopRun: false, stopKind: null };
  if (!result || !Array.isArray(result.findings)) return { valid: false, invalidReason: 'provider-error: no result file', roundRan: true, stopRun: false, stopKind: null };
  if (result.verdict === 'INCOMPLETE') return { valid: false, invalidReason: 'pass-lost: verdict INCOMPLETE', roundRan: true, stopRun: false, stopKind: null };
  // The canary is a code-audit control (plan audits have none): a miss makes the run INCOMPLETE and excludes the pair.
  if (point.mode === 'code' && result._canary?.status !== 'detected') return { valid: false, invalidReason: `canary-missed: ${result._canary?.status ?? 'absent'}`, roundRan: true, stopRun: false, stopKind: null };
  return { valid: true, invalidReason: null, roundRan: true, stopRun: false, stopKind: null };
}

/**
 * Run one (point, arm, replicate). Never throws for an expected failure: an unrecoverable or failed run is a row.
 * @param {object} a
 * @param {object} a.point - frozen point
 * @param {object} a.snapshot - its sealed snapshot
 * @param {'META'|'CONTINUE'} a.arm
 * @param {number} a.rep
 * @param {string} a.repoRoot - local clone of the point's repo
 * @param {string} a.auditScript - absolute path of the pinned `openai-audit.mjs`
 * @param {string} a.ledgerFile - the shared budget ledger (env AUDIT_BUDGET_LEDGER)
 * @param {object} [a.deps] - withTree, spawn, spentUsd, signals, resolveBase, now, env
 */
export async function runContinuation({ point, snapshot, arm, rep, repoRoot, auditScript, ledgerFile, runId = null, deps = {} }) {
  const sid = sidFor({ pointId: point.pointId, arm, rep });
  const stamp = { type: 'run', epoch: SEEDED_BENCH_EPOCH, runId: runId ?? sid, pointId: point.pointId, set: point.set, sid, arm, rep, mode: point.mode, trigger: point.trigger, round: point.round, snapshotDigest: point.snapshotDigest };
  const withTree = deps.withTree || withCaseTree;
  const spawn = deps.spawn || ((argv, { cwd, env }) => { const r = spawnSync(process.execPath, [auditScript, ...argv], { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' }; });
  const spent = deps.spentUsd || (() => 0);
  const started = (deps.now || Date.now)();
  const before = spent();
  try {
    return await withTree({ repoRoot, sha: point.treeSha }, async (dir) => {
      if (point.planFile && !fs.existsSync(path.join(dir, point.planFile))) return { ...stamp, valid: false, invalidReason: 'unrecoverable: the plan file is absent from the tree', unrecoverable: true, costUsd: 0 };
      const trig = validateTrigger({ point, snapshot, dir, ...(deps.signals ? { signals: deps.signals } : {}), ...(deps.makeGit ? { git: deps.makeGit } : {}) });
      if (!trig.ok) return { ...stamp, valid: false, invalidReason: `unrecoverable: ${trig.reason}`, unrecoverable: true, costUsd: 0 };
      let base = null;
      if (point.mode === 'code') {
        const b = (deps.resolveBase || resolveScopeBase)({ repoRoot, treeSha: point.treeSha, firstSha: point.firstSha });
        if (!b.ok) return { ...stamp, valid: false, invalidReason: `unrecoverable: ${b.reason}`, unrecoverable: true, costUsd: 0 };
        base = b.base;
      }
      restorePointFiles({ dir, point, snapshot, sid });
      const { invocations } = buildArmInvocations({ point, arm, base, sid });
      const env = childEnv({ base: deps.env || process.env, ledgerFile });
      const inv = [];
      for (let i = 0; i < invocations.length; i++) {
        const r = spawn(invocations[i], { cwd: dir, env });
        inv.push({ argv: invocations[i], status: r.status, stderr: String(r.stderr || '').slice(-20000) });
        if (i === 0 && invocations.length === 2 && r.status !== 4) break; // the card step must refuse; anything else is not the override path
      }
      const outFile = path.join(dir, '.audit', `${sid}-r${point.round}-result.json`);
      let result = null; try { result = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* no result: classified below */ }
      const cls = classifyOutcome({ arm, point, inv, result });
      const metaLog = readMetaLog(metaLogPath(path.join(dir, '.audit'), sid));
      const metaDecisions = [...foldMetaLog(metaLog.events).decisions.values()].map((d) => ({ attemptId: d.attemptId, trigger: d.trigger, state: d.state, model: d.model ?? null, effect: d.guard?.effect ?? null, honoured: d.guard?.honoured ?? null, reasonCode: d.guard?.reasonCode ?? null, costUsd: d.costUsd ?? null, verdict: d.verdict ? { action: d.verdict.action, reason: d.verdict.reason } : null }));
      const runKey = `${point.pointId}/${arm}/${rep}`;
      return {
        ...stamp, ...cls, costUsd: Math.max(0, spent() - before), spendSource: 'ledger',
        findings: cls.roundRan && result ? result.findings.map((f, i) => findingView(f, runKey, i)) : [],
        canary: result?._canary ?? null, verdict: result?.verdict ?? null, meta: metaDecisions, metaLogMalformed: metaLog.malformed,
        exitCodes: inv.map((i) => i.status), stderrTail: inv.map((i) => i.stderr.slice(-1500)), scopeBase: base,
        wallMs: (deps.now || Date.now)() - started,
        // A stop's debt command is recorded, never run: a pilot cannot write debt.
        debtCommandRecorded: cls.stopRun ? (/Capture the open topics as debt:\s*\n\s*(.+)/.exec(inv[0]?.stderr || '')?.[1]?.trim() ?? null) : null,
      };
    });
  } catch (err) {
    return { ...stamp, valid: false, invalidReason: `provider-error: ${String(err?.message || err).slice(0, 300)}`, costUsd: Math.max(0, spent() - before), findings: [] };
  }
}

export { META_T2_ROUND };
