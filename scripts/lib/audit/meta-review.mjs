/**
 * @fileoverview The AUTOMATIC META-REVIEW at the audit round cap (docs/plans/meta-step-back-at-cap.md).
 *
 * The step-back reviewer, made automatic for plan AND code audits: a stronger, vendor-independent model
 * (`createMetaReviewProvider`) reads the same egress-gated pack (`buildStepBackPack`) under a charter
 * (`META_REVIEW_SYSTEM_PROMPT`) and answers admit / stop / structural. Its verdict is never obeyed as-is:
 * `guardMetaDecision` (pure) decides whether the effect is HONOURED or DOWNGRADED to today's human path,
 * and never raises a cap. Every decision is persisted to an append-only per-session event log BEFORE it
 * is acted on, and an allowlisted projection goes to the learning store, so the value can be measured.
 *
 * Triggers (`metaTriggerFor`): T1 = a round refused at the cap (`PAST_CAP_REQUIRED`); T2 = code round 4
 * (checkpoint 3) when a round signal fires. The gate (`round-cap-gate.mjs`) is the only caller that acts
 * on a result; this module decides and records.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/meta-review
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFlagValue, META_T2_ROUND } from './round-cap.mjs';
import { topicOf, assessCapProductivity, readLedgerEntries, renderCapProductivity } from './cap-productivity.mjs';
import { readRoundsWithSha, defaultRepoFiles, defaultArchNeighbours } from './step-back-card.mjs';
import { computeRoundSignals, renderRoundSignals, makeGitRunner } from './round-signals.mjs';
import { buildStepBackPack, META_REVIEW_SYSTEM_PROMPT, META_REVIEW_VERSION, parseMetaReviewOutput } from './step-back.mjs';
import { createMetaReviewProvider, estimateCostUsd } from './step-back-provider.mjs';
import { redactSecrets } from '../secret-patterns.mjs';

/** Sent attempts allowed per session id: one per trigger point of a single identity (code T2@4, T1@7, T1@8; plan T1@4, T1@5). */
export const META_REVIEW_SESSION_BUDGET = Object.freeze({ code: 3, plan: 2 });
export { META_T2_ROUND };
export const META_DECISION_TYPE = 'meta_review_decision';
export const META_OVERRIDE_TYPE = 'meta_review_override';
/** Closed enum for the store projection: no free text leaves the machine through the learning row. */
export const GUARD_REASON_CODES = Object.freeze([
  'ok', 'omitted-topic', 'unverified-settled', 'high-not-settled', 'productive', 'unmeasured',
  'evidence-not-in-pack', 'topic-not-open', 'invalid', 'unavailable',
]);
const RAW_KEEP_CHARS = 4000;
const RULED = new Set(['accepted', 'dismissed', 'severity_adjusted']);
const posix = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
const red = (s) => redactSecrets(String(s ?? '')).text;

// ── opt-out, triggers, identity ──────────────────────────────────────────────────────────────────────

/** `--no-meta-review` or `AUDIT_META_REVIEW=off|0|false|no`. Opted out, the gate behaves exactly as before this module. */
export function isMetaReviewOptedOut({ argv = [], env = process.env } = {}) {
  return argv.includes('--no-meta-review') || /^(off|0|false|no)$/i.test(String(env.AUDIT_META_REVIEW ?? '').trim());
}

/**
 * Which trigger (if any) this gate invocation is.
 * @param {{mode: string, round: number, refusalCode?: string|null}} a - `refusalCode` from validateAuditRound, null when the round is admitted
 * @returns {'T1'|'T2'|null}
 */
export function metaTriggerFor({ mode, round, refusalCode = null }) {
  if (mode !== 'plan' && mode !== 'code') return null;
  if (refusalCode === 'PAST_CAP_REQUIRED') return 'T1';
  if (refusalCode == null && mode === 'code' && round === META_T2_ROUND) return 'T2';
  return null;
}

/** The arguments that define WHICH change is audited. Read from argv in the gate; the ledger is deliberately absent. */
export function fingerprintOf({ argv, mode, sid }) {
  const changed = readFlagValue(argv, '--changed').value;
  const list = changed ? changed.split(',').map((s) => posix(s.trim())).filter(Boolean).sort() : null;
  return {
    mode, sid: sid || null,
    planFile: argv[1] ? posix(argv[1]) : null,
    diffBase: readFlagValue(argv, '--diff').value ?? null,
    changedSha256: list ? crypto.createHash('sha256').update(list.join('\n')).digest('hex') : null,
  };
}

/** First 8 hex of the sha256 of the sorted-key fingerprint JSON. */
export function fingerprintDigest(fp) {
  const canon = JSON.stringify(Object.fromEntries(Object.keys(fp).sort().map((k) => [k, fp[k]])));
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 8);
}

/**
 * The EVIDENCE the decision was made on: plan content, the audited HEAD and the diff content. It changes every round by
 * design (fixes land between rounds), so it keys REUSE of one round's decision, never the admission across rounds,
 * which keys on the identity fingerprint alone.
 */
export function evidenceOf({ argv, cwd = process.cwd(), readFile = (p) => fs.readFileSync(p), gitHead = defaultGitHead }) {
  const sha = (p) => { if (!p) return null; try { return crypto.createHash('sha256').update(readFile(path.resolve(cwd, p))).digest('hex'); } catch { return 'unreadable'; } };
  const diff = readFlagValue(argv, '--diff').value;
  return { planSha256: sha(argv[1] || null), head: gitHead(cwd), diffSha256: sha(diff) };
}

function defaultGitHead(cwd) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

/** Stable per (session, round, trigger, identity, evidence): a re-run reuses the decision; changed identity or evidence decides afresh. */
export function attemptIdFor({ sid, round, trigger, fingerprint, evidence = null }) {
  const ev = evidence ? `-${fingerprintDigest(evidence)}` : '';
  return `${sid || 'session'}-r${round}-${trigger}-${fingerprintDigest(fingerprint)}${ev}`;
}

// ── the append-only event log ────────────────────────────────────────────────────────────────────────

export function metaLogPath(auditDir, sid) {
  return path.join(auditDir, `${sid || 'session'}-meta-review.jsonl`);
}

/**
 * Read the log. A missing file is empty; a non-newline-terminated tail is a torn write (skipped, counted);
 * any other non-JSON line makes the log MALFORMED (callers fail closed to the human path).
 * @returns {{events: object[], malformed: string|null, tornTail: number}}
 */
export function readMetaLog(file, { fsImpl = fs } = {}) {
  let raw;
  try { raw = fsImpl.readFileSync(file, 'utf8'); } catch (err) {
    return err?.code === 'ENOENT' ? { events: [], malformed: null, tornTail: 0 } : { events: [], malformed: `unreadable (${err?.code || err?.message})`, tornTail: 0 };
  }
  const lines = raw.split('\n');
  const tail = lines.pop();
  const tornTail = tail ? Buffer.byteLength(tail) : 0;
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { events.push(JSON.parse(lines[i])); } catch { return { events: [], malformed: `line ${i + 1} is not JSON`, tornTail }; }
  }
  return { events, malformed: null, tornTail };
}

/**
 * Crash-safe append: truncate a torn tail, append one whole line, re-read and verify it. Synchronous, no await
 * between repair and append. Only `{ok: true}` counts as persisted.
 * @returns {{ok: true, event: object, repairedTornTail: number}|{ok: false, reason: string}}
 */
export function appendMetaEvent(file, event, { fsImpl = fs } = {}) {
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    let raw = '';
    try { raw = fsImpl.readFileSync(file, 'utf8'); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
    let repaired = 0;
    if (raw && !raw.endsWith('\n')) {
      const keep = raw.slice(0, raw.lastIndexOf('\n') + 1);
      repaired = Buffer.byteLength(raw) - Buffer.byteLength(keep);
      fsImpl.truncateSync(file, Buffer.byteLength(keep));
    }
    const ev = { ...event, eventId: event.eventId || crypto.randomUUID(), ...(repaired ? { repairedTornTail: repaired } : {}) };
    fsImpl.appendFileSync(file, `${JSON.stringify(ev)}\n`);
    const back = readMetaLog(file, { fsImpl });
    const last = back.events[back.events.length - 1];
    if (back.malformed || back.tornTail || last?.eventId !== ev.eventId) return { ok: false, reason: `append not verified${back.malformed ? ` (${back.malformed})` : ''}` };
    return { ok: true, event: ev, repairedTornTail: repaired };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err).slice(0, 200) };
  }
}

/**
 * Fold the log into state. The FIRST decision per attempt id wins (a concurrent duplicate is counted, never a second
 * admission). Each `reserve` charges the budget (`sentCount`) and opens the attempt; the next decision for that attempt
 * closes it, and a decision recorded `sent: false` (a confirmed pre-send failure) also RELEASES the charge. A reserve
 * with no decision after it stays open (`reserved`): in flight, or a crash mid-call, counted conservatively.
 */
export function foldMetaLog(events) {
  const decisions = new Map();
  const overridden = new Map();
  const open = new Map();
  let sentCount = 0; let duplicates = 0; let captures = 0;
  for (const e of events || []) {
    if (e?.event === 'reserve') { sentCount++; open.set(e.attemptId, (open.get(e.attemptId) || 0) + 1); }
    else if (e?.event === 'decision') {
      if ((open.get(e.attemptId) || 0) > 0) { open.set(e.attemptId, open.get(e.attemptId) - 1); if (e.sent === false) sentCount--; }
      const prev = decisions.get(e.attemptId);
      // A decision made before anything was sent (no route, budget, plan excluded) is RETRYABLE: a later one replaces it.
      if (!prev || isRetryable(prev)) decisions.set(e.attemptId, e); else duplicates++;
    } else if (e?.event === 'override' || e?.event === 'revoke') {
      if (!overridden.has(e.attemptId)) overridden.set(e.attemptId, []);
      overridden.get(e.attemptId).push(e);
    } else if (e?.event === 'debt-capture') captures++;
  }
  const reserved = new Set([...open].filter(([, n]) => n > 0).map(([a]) => a));
  return { decisions, overridden, reserved, sentCount, duplicates, captures };
}

/** An `unavailable` decision for which no request was sent: nothing was decided, so it is not reused. */
export const isRetryable = (d) => d?.state === 'unavailable' && !d.sent;

/** The honoured, un-revoked T1 admission covering `round` for this identity, or null. */
export function admissionFor({ fold, digest, round }) {
  for (const d of fold.decisions.values()) {
    if (d.trigger !== 'T1' || d.guard?.effect !== 'admit' || !d.guard?.honoured) continue;
    if (d.fingerprintDigest !== digest || fold.overridden.has(d.attemptId)) continue;
    if (Number.isInteger(d.admittedThrough) && round >= d.round && round <= d.admittedThrough) return d;
  }
  return null;
}

/** An honoured, loop-ending (stop/structural) decision for this attempt that no override reversed, or null. */
export function honouredLoopEnd({ fold, attemptId }) {
  const d = fold.decisions.get(attemptId);
  if (!d || !d.guard?.honoured || !['stop', 'structural'].includes(d.guard.effect)) return null;
  return fold.overridden.has(attemptId) ? null : d;
}

// ── the open-topic inventory and the guard ───────────────────────────────────────────────────────────

const SEV_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/** Topics of the last completed round's findings (the derivation write-ledger-entries uses), highest severity per topic. */
export function openInventory(findings) {
  const by = new Map();
  for (const f of findings || []) {
    const topicId = topicOf(f);
    const severity = String(f?.severity || '').toUpperCase();
    const prev = by.get(topicId);
    const priorRuled = !!f?._priorRuling?.topicId || !!prev?.priorRuled;
    if (!prev || (SEV_RANK[severity] || 0) > (SEV_RANK[prev.severity] || 0)) by.set(topicId, { topicId, findingId: f?.id ?? null, severity, priorRuled });
    else if (priorRuled) prev.priorRuled = true;
  }
  return [...by.values()].sort((a, b) => a.topicId.localeCompare(b.topicId));
}

/**
 * Was this topic RULED before the last round? Only two signals are trustworthy, and neither is a first-seen round (the
 * ledger keeps no ruling history, so a topic seen early but ruled late must not pass): (a) its ledger entry carries a
 * ruling made in an earlier round (`resolvedRound < lastRound`), or (b) the auditor's own suppression stamped the
 * last-round finding `_priorRuling` at audit time — it was matched to a concern already in the ledger before that round
 * ran. Anything else fails closed.
 */
export function ruledBefore(ledgerEntries, topicId, lastRound, inventory = []) {
  if ((inventory || []).some((i) => i.topicId === topicId && i.priorRuled)) return true;
  return (ledgerEntries || []).some((e) => e?.topicId === topicId && RULED.has(e.adjudicationOutcome) && Number.isInteger(e.resolvedRound) && e.resolvedRound < lastRound);
}

/**
 * Map a VALID verdict to an effect. Pure. Effects: `admit` (L1), `stop` / `structural` (loop ends), `round-runs`
 * (today's behaviour inside the cap), `human-card` (today's exit-4 card). Never raises a cap.
 * @returns {{effect: string, honoured: boolean, reasonCode: string, reason: string, admittedThrough?: number}}
 */
export function guardMetaDecision({ trigger, output, inventory, ledgerEntries, lastRound, productivity, packFiles = [], round, caps }) {
  const human = trigger === 'T1' ? 'human-card' : 'round-runs';
  const down = (reasonCode, reason) => ({ effect: human, honoured: false, reasonCode, reason });
  const inv = new Map((inventory || []).map((i) => [i.topicId, i]));
  const highs = (inventory || []).filter((i) => i.severity === 'HIGH');
  const productiveBlock = () => {
    if (trigger !== 'T2') return null;
    if (productivity?.stillProductive === true) return down('productive', `last round still productive (${Math.round((productivity.acceptanceRate ?? 0) * 100)}% accepted): no early stop`);
    if (productivity?.stillProductive !== false) return down('unmeasured', `last-round productivity unmeasured (${productivity?.unmeasured ?? 'no data'}): no early stop`);
    return null;
  };

  if (output.action === 'admit') {
    if (trigger === 'T2') return { effect: 'round-runs', honoured: true, reasonCode: 'ok', reason: 'admit inside the soft cap: the round runs as before' };
    const closed = output.topics.filter((t) => !inv.has(t));
    if (closed.length) return down('topic-not-open', `admit names topic(s) not open in the last round: ${closed.slice(0, 5).join(', ')}`);
    const admittedThrough = Math.min(round - 1 + output.rounds, caps.absolute);
    return { effect: 'admit', honoured: true, reasonCode: 'ok', reason: `admits round(s) ${round}-${admittedThrough} (absolute cap ${caps.absolute})`, admittedThrough };
  }
  if (output.action === 'stop') {
    const named = new Map(output.items.map((i) => [i.topicId, i]));
    const omitted = (inventory || []).filter((i) => !named.has(i.topicId)).map((i) => i.topicId);
    if (omitted.length) return down('omitted-topic', `stop omits open topic(s): ${omitted.slice(0, 5).join(', ')}`);
    const highNotSettled = highs.filter((h) => named.get(h.topicId)?.kind !== 'settled').map((h) => h.topicId);
    if (highNotSettled.length) return down('high-not-settled', `HIGH topic(s) judged without a verifiable ruling: ${highNotSettled.slice(0, 5).join(', ')}`);
    const unverified = output.items.filter((i) => i.kind === 'settled' && !ruledBefore(ledgerEntries, i.topicId, lastRound, inventory)).map((i) => i.topicId);
    if (unverified.length) return down('unverified-settled', `"settled" not ruled in the ledger before round ${lastRound}: ${unverified.slice(0, 5).join(', ')}`);
    const pb = productiveBlock(); if (pb) return pb;
    return { effect: 'stop', honoured: true, reasonCode: 'ok', reason: `stop covers all ${inventory.length} open topic(s); every HIGH settled` };
  }
  // structural
  const shown = new Set(packFiles.map(posix));
  const missing = output.evidence.map((e) => posix(e.file)).filter((f) => !shown.has(f));
  if (missing.length) return down('evidence-not-in-pack', `evidence file(s) the pack did not show: ${missing.slice(0, 5).join(', ')}`);
  const openHigh = highs.filter((h) => !ruledBefore(ledgerEntries, h.topicId, lastRound, inventory)).map((h) => h.topicId);
  if (openHigh.length) return down('high-not-settled', `open HIGH topic(s) never ruled: ${openHigh.slice(0, 5).join(', ')}`);
  const pb = productiveBlock(); if (pb) return pb;
  return { effect: 'structural', honoured: true, reasonCode: 'ok', reason: 'structural cause named; every open HIGH already ruled' };
}

// ── spend, records, projection ───────────────────────────────────────────────────────────────────────

/** `usage` when the provider counted; `estimate` when a sent request has no usage; `none` when nothing was sent. */
export function spendOf({ sent, usage, modelId, requestChars, outputCeiling }) {
  if (!sent) return { costUsd: 0, spendSource: 'none', inputTokens: null, outputTokens: null };
  if (usage && !usage.usageMissing) {
    return { costUsd: estimateCostUsd({ modelId, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }), spendSource: 'usage', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
  }
  const inputTokens = Math.ceil(requestChars / 2);
  return { costUsd: estimateCostUsd({ modelId, inputTokens, outputTokens: outputCeiling }), spendSource: 'estimate', inputTokens: null, outputTokens: null };
}

/** The allowlisted learning-store projection: ids, counts, enums and numbers only. No path, finding text or prose. */
export function projectMetaDecisionForStore(d) {
  const counts = { count: 0, high: 0, medium: 0, low: 0 };
  for (const i of d.inventory || []) { counts.count++; const k = String(i.severity).toLowerCase(); if (k in counts) counts[k]++; }
  return {
    attemptId: d.attemptId, version: d.version, trigger: d.trigger, mode: d.mode, round: d.round,
    softCap: d.caps?.soft ?? null, absoluteCap: d.caps?.absolute ?? null,
    signalsFired: d.signals?.fired ?? [], acceptanceRate: d.productivity?.acceptanceRate ?? null, stillProductive: d.productivity?.stillProductive ?? null,
    inventory: counts, packChars: d.pack?.chars ?? null, packFileCount: d.pack?.fileCount ?? null, excludedCount: d.pack?.excludedCount ?? null,
    arm: d.arm ?? null, sentinel: d.sentinel ?? null, model: d.model ?? null, reviewerFamily: d.reviewerFamily ?? null, auditorFamily: d.auditorFamily ?? null,
    inputTokens: d.inputTokens ?? null, outputTokens: d.outputTokens ?? null, costUsd: d.costUsd ?? null, spendSource: d.spendSource, sent: !!d.sent,
    state: d.state, action: d.verdict?.action ?? null, stopKinds: d.verdict?.action === 'stop' ? [...new Set(d.verdict.items.map((i) => i.kind))].sort() : [],
    admitRounds: d.verdict?.action === 'admit' ? d.verdict.rounds : null, admittedThrough: d.admittedThrough ?? null,
    guardEffect: d.guard?.effect ?? null, guardHonoured: !!d.guard?.honoured, guardReasonCode: GUARD_REASON_CODES.includes(d.guard?.reasonCode) ? d.guard.reasonCode : null,
  };
}

/** Best-effort learning row (the recordCapStop path); never throws, reports what it did. */
export async function recordMetaLearning({ decisionType, externalId, context, choice }, deps = {}) {
  try {
    if (typeof externalId !== 'string' || !externalId.trim() || externalId.includes(':')) return { recorded: false, reason: 'no usable key' };
    const record = deps.record ?? (await import('../learning/decision-logger.mjs')).recordDecision;
    const key = record({ decisionType, externalId, context, choice, outcome: null });
    if (!key) return { recorded: false, reason: 'not admitted (LEARNING_DISABLE=1 or back-pressure)' };
    const flush = deps.flush ?? (async () => {
      const [{ flush: f }, store] = await Promise.all([import('../learning/decision-logger.mjs'), import('../../learning-store.mjs')]);
      return f({ store });
    });
    await flush();
    return { recorded: true, reason: null };
  } catch (err) { return { recorded: false, reason: String(err?.message || err).slice(0, 200) }; }
}

export const META_EVALUATION_TYPE = 'meta_review_evaluation';

/**
 * Record a T2 evaluation that did NOT fire: an `evaluation` event in the meta log (foldMetaLog ignores it, so it never
 * affects a decision) plus a best-effort learning row. Never throws. A signal's own reason is kept so "unmeasured" and
 * "quiet" stay distinguishable in the record.
 */
export async function recordT2Evaluation({ file, attemptId, sid, round, lastRound, signals, perSignal, now }, deps = {}) {
  try {
    const ev = { event: 'evaluation', trigger: 'T2', attemptId, sid: sid ?? null, round, checkpoint: lastRound, at: now, anyFires: false, failed: !!signals?.failed, fired: signals?.fired ?? [], unmeasured: (signals?.unmeasured ?? []).map((u) => red(String(u)).slice(0, 200)), signals: perSignal };
    const out = (deps.append || appendMetaEvent)(file, ev);
    if (!out.ok) return { logged: false, reason: out.reason };
    const rec = await recordMetaLearning({ decisionType: META_EVALUATION_TYPE, externalId: `${attemptId}-eval`, context: { trigger: 'T2', checkpoint: lastRound, anyFires: false, failed: !!signals?.failed, signals: perSignal.map((s) => ({ name: s.name, measured: s.measured, fires: s.fires })) }, choice: { chose: 'not-run' } }, deps);
    return { logged: true, learningRecorded: rec.recorded, reason: rec.reason };
  } catch (err) { return { logged: false, reason: String(err?.message || err).slice(0, 200) }; }
}

/** Append an override/revoke event (and its learning row) against one attempt. */
export async function appendMetaOverride({ auditDir, sid, attemptId, kind, by, reason, source }, deps = {}) {
  const file = metaLogPath(auditDir, sid);
  const n = (foldMetaLog(readMetaLog(file).events).overridden.get(attemptId) || []).length + 1;
  const ev = { event: kind, attemptId, at: new Date().toISOString(), by: by || process.env.AUDIT_OPERATOR || 'unknown', reason: red(reason).slice(0, 500), source };
  const out = (deps.append || appendMetaEvent)(file, ev);
  if (!out.ok) return { ok: false, reason: out.reason };
  const rec = await recordMetaLearning({ decisionType: META_OVERRIDE_TYPE, externalId: `${attemptId}-override-${n}`, context: { attemptId, kind, by: ev.by }, choice: { chose: kind } }, deps);
  return { ok: true, recorded: rec.recorded, recordReason: rec.reason };
}

/**
 * THE one resolver for "is this attempt already decided?". Every read uses it (the first read, the read under the
 * session lock, the winner check after the append), so an override can never be skipped by one path and honoured by
 * another. Returns null when nothing actionable exists (no decision, or only a retryable unsent one).
 */
export function resolveExisting({ fold, attemptId, human }) {
  const d = fold.decisions.get(attemptId);
  if (!d || isRetryable(d)) return null;
  if (fold.overridden.has(attemptId)) return { ran: true, reused: true, persisted: true, overridden: true, decision: d, effect: human, honoured: false, lines: [`  [meta-review] decision ${attemptId} was overridden by a human: the human path applies`] };
  return { ran: true, reused: true, persisted: true, decision: d, effect: d.guard.effect, honoured: !!d.guard.honoured, lines: [`  [meta-review] reusing decision ${attemptId}: ${d.guard.effect}${d.guard.honoured ? '' : ' (downgraded)'}`] };
}

/** sha256 of what the guard reads: each round's finding ids/topics/severities and each ledger ruling. Order-insensitive. */
export function decisionInputsDigest({ rounds, ledgerEntries }) {
  const r = (rounds || []).map((x) => `${x.round}:${(x.findings || []).map((f) => JSON.stringify([f.id, topicOf(f), f.severity, f._priorRuling?.topicId ?? '', f.category ?? '', f.section ?? '', f.detail ?? '', [...(f.affectedFiles || [])].sort()])).sort().join(',')}`).sort();
  const l = (ledgerEntries || []).map((e) => `${e.topicId}|${e.adjudicationOutcome}|${e.resolvedRound}`).sort();
  return crypto.createHash('sha256').update(JSON.stringify([r, l])).digest('hex');
}

/**
 * The ONE critical section. Under a session-scoped exclusive lock, re-read the log and (1) reuse a decision another
 * invocation persisted, (2) refuse an attempt another invocation reserved and has not decided (in flight, or crashed
 * mid-call: fail closed, the human path applies), (3) refuse past the budget, else (4) append the `reserve` event,
 * which is both the budget charge and the attempt's claim. Synchronous: no await between the check and the append.
 * A held lock is retried briefly (the section is one read and one append), then fails closed. A lock a crashed process
 * left behind is never stolen (that race cannot be closed with a lock file); the message names it for a human.
 * @returns {{ok: true, sentCount: number}|{ok: false, reuse?: object, inFlight?: boolean, budget?: boolean, sentCount?: number, reason?: string}}
 */
export function reserveUnderSessionLock({ auditDir, sid, file, budget, attemptId, human = 'human-card', event, append = appendMetaEvent, tries = 50 }) {
  const lock = path.join(auditDir, `${sid || 'session'}.meta-review.lock`);
  try { fs.mkdirSync(auditDir, { recursive: true }); } catch (err) { return { ok: false, reason: `audit dir (${err?.code || err?.message})` }; }
  let fd = null;
  for (let i = 0; i < tries && fd == null; i++) {
    try { fd = fs.openSync(lock, 'wx'); } catch (err) {
      if (err?.code !== 'EEXIST') return { ok: false, reason: `session lock (${err?.code || err?.message})` };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  if (fd == null) return { ok: false, reason: `session lock ${path.basename(lock)} is held (if no audit of this session is running, a crashed one left it: delete it)` };
  try {
    const log = readMetaLog(file);
    if (log.malformed) return { ok: false, reason: `log malformed (${log.malformed})` };
    const fold = foldMetaLog(log.events);
    const reuse = resolveExisting({ fold, attemptId, human });
    if (reuse) return { ok: false, reuse };
    if (fold.reserved.has(attemptId)) return { ok: false, inFlight: true, reason: `attempt ${attemptId} is reserved by another invocation with no decision yet (running, or crashed mid-call)` };
    if (fold.sentCount >= budget) return { ok: false, budget: true, sentCount: fold.sentCount };
    let out;
    try { out = append(file, event); } catch (err) { out = { ok: false, reason: String(err?.message || err).slice(0, 200) }; }
    return out.ok ? { ok: true, sentCount: fold.sentCount + 1 } : { ok: false, reason: out.reason };
  } finally {
    try { fs.closeSync(fd); } catch { /* removed below either way */ }
    try { fs.rmSync(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* a leftover lock fails closed next time, by design */ }
  }
}

// ── the runner ───────────────────────────────────────────────────────────────────────────────────────

function packHeader({ mode, trigger, round, caps, signalsLine, productivityLine, inventory }) {
  const inv = (inventory || []).map((i) => `- ${i.topicId} (${i.severity || 'n/a'})`).join('\n') || '- (none)';
  return red([
    `<meta-review mode="${mode}" trigger="${trigger}" requestedRound="${round}" softCap="${caps.soft}" absoluteCap="${caps.absolute}">`,
    trigger === 'T1' ? `The audit has reached its soft cap; round ${round} was refused pending this decision.` : `Code round ${round - 1} checkpoint: a round signal fired.`,
    signalsLine ? `Signals: ${signalsLine}` : 'Signals: not measured for this audit mode.',
    productivityLine ? `Productivity: ${productivityLine}` : 'Productivity: unmeasured.',
    'Open-topic inventory (every topic a stop must cover):', inv, '</meta-review>',
  ].join('\n'));
}

const asOf = (checkpoint) => (e) => !['round', 'firstSeenRound', 'lastSeenRound', 'resolvedRound'].some((k) => Number.isInteger(e?.[k]) && e[k] > checkpoint);

/**
 * Decide and record ONE trigger. Never throws for an expected failure: every non-decision is a result with
 * `ran: false` (nothing recorded, the gate behaves as before) or an `unavailable`/`invalid` decision (recorded,
 * human path). The gate acts ONLY on `persisted: true`.
 *
 * @param {object} a
 * @param {'T1'|'T2'} a.trigger
 * @param {string|null} a.sid
 * @param {'plan'|'code'} a.mode
 * @param {number} a.round - the requested round
 * @param {{soft: number, absolute: number}} a.caps
 * @param {string[]} a.argv
 * @param {string} a.auditDir
 * @param {string} [a.cwd]
 * @param {NodeJS.ProcessEnv} [a.env]
 * @param {string|null} [a.auditorModel]
 * @param {object} [deps] - seams: readRounds, readLedger, git, buildPack, repoFiles, archNeighbours, selectProvider, append, record, flush, now
 * @returns {Promise<{ran: boolean, reason?: string, reused?: boolean, persisted?: boolean, decision?: object, effect: string, honoured: boolean, lines: string[]}>}
 */
export async function runMetaReview({ trigger, sid, mode, round, caps, argv, auditDir, cwd = process.cwd(), env = process.env, auditorModel = null }, deps = {}) {
  const human = trigger === 'T1' ? 'human-card' : 'round-runs';
  const notRun = (reason) => ({ ran: false, reason, effect: human, honoured: false, lines: [`  [meta-review] not run: ${reason}`] });
  const lastRound = round - 1;
  const { rounds, unmeasured } = (deps.readRounds || readRoundsWithSha)({ sid, auditDir, upTo: lastRound });
  if (!rounds || !rounds.some((r) => r.round === lastRound)) return notRun(rounds ? `no result for round ${lastRound} (nothing to review)` : (unmeasured || 'no prior rounds'));

  const ledgerAll = (deps.readLedger || readLedgerEntries)({ sid, auditDir });
  const ledgerEntries = (ledgerAll.entries || []).filter(asOf(lastRound));
  const fingerprint = fingerprintOf({ argv, mode, sid });
  const digest = fingerprintDigest(fingerprint);
  // Everything the GUARD reads is evidence too: the round results and the ledger rulings, not only plan / HEAD / diff.
  const evidence = { ...(deps.evidence || evidenceOf)({ argv, cwd }), decisionInputsSha256: decisionInputsDigest({ rounds, ledgerEntries }) };
  const attemptId = attemptIdFor({ sid, round, trigger, fingerprint, evidence });
  const file = metaLogPath(auditDir, sid);
  const log = readMetaLog(file);
  if (log.malformed) return notRun(`decision log ${path.basename(file)} is malformed (${log.malformed}); the human path applies`);
  const fold = foldMetaLog(log.events);
  const reused = resolveExisting({ fold, attemptId, human });
  if (reused) return reused;

  // Signals (code audits only) at the checkpoint the trigger reads.
  let signals = null; let signalsLine = null; let perSignal = [];
  if (mode === 'code') {
    try {
      const s = (deps.computeSignals || computeRoundSignals)({ round: lastRound, rounds, ledgerEntries, git: deps.git || makeGitRunner(cwd) });
      signals = { fired: Object.entries(s.signals || {}).filter(([, v]) => v?.fires).map(([k]) => k).sort(), unmeasured: s.unmeasured || [], anyFires: !!s.anyFires };
      perSignal = Object.entries(s.signals || {}).map(([name, v]) => ({ name, measured: !!v?.measured, fires: !!v?.fires, value: typeof v?.value === 'number' ? v.value : null, reason: red(String(v?.reason ?? '')).slice(0, 200) }));
      signalsLine = renderRoundSignals(s).replace(/\s+/g, ' ').slice(0, 400);
    } catch (err) { signals = { fired: [], unmeasured: [`signals failed (${red(String(err?.message || err)).slice(0, 80)})`], anyFires: false, failed: true }; }
  }
  if (trigger === 'T2' && !signals?.anyFires) {
    // Observability: a T2 evaluation that does not fire used to leave NO trace. Record it (best-effort) with each signal's state.
    const evalRec = await recordT2Evaluation({ file, attemptId, sid, round, lastRound, signals, perSignal, now: (deps.now || (() => new Date().toISOString()))() }, deps);
    const res = notRun(signals?.failed ? `round ${lastRound} signals could not be computed` : `round ${lastRound} signals did not fire`);
    const states = signals?.failed ? `COMPUTATION FAILED ${signals.unmeasured[0]}` : perSignal.map((s) => `${s.name}=${s.measured ? (s.fires ? 'fires' : 'quiet') : 'unmeasured'}`).join(' ');
    res.lines.push(`  [meta-review] T2 evaluation ${evalRec.logged ? 'logged' : `not logged (${evalRec.reason})`}: ${states}`);
    return res;
  }

  const productivity = assessCapProductivity({ rounds, ledgerEntries: ledgerAll.entries ? ledgerEntries : null, ledgerUnmeasured: ledgerAll.unmeasured });
  const last = rounds.find((r) => r.round === lastRound);
  const inventory = openInventory(last.findings);
  const base = {
    event: 'decision', version: META_REVIEW_VERSION, attemptId, at: (deps.now || (() => new Date().toISOString()))(), trigger, mode, round, caps,
    fingerprint, fingerprintDigest: digest, evidence, signals, productivity: { acceptanceRate: productivity.acceptanceRate, stillProductive: productivity.stillProductive, unmeasured: productivity.unmeasured, highByRound: productivity.highByRound },
    inventory, sent: false, costUsd: 0, spendSource: 'none',
  };
  const finish = async (fields) => {
    const decision = { ...base, ...fields };
    const out = (deps.append || appendMetaEvent)(file, decision);
    // Act on the PERSISTED state through the one resolver: a rival's earlier decision, or an override, stands.
    if (out.ok) {
      const now = resolveExisting({ fold: foldMetaLog(readMetaLog(file).events), attemptId, human });
      if (now && (now.overridden || now.decision.eventId !== out.event.eventId)) return now;
    }
    const lines = [`  [meta-review] ${trigger} ${attemptId}: ${decision.state}${decision.verdict ? ` → ${decision.verdict.action}` : ''} · ${decision.guard.effect}${decision.guard.honoured ? ' (honoured)' : ` (${decision.guard.reasonCode})`} — ${decision.guard.reason}`];
    if (decision.model) lines.push(`  [meta-review] reviewer ${decision.arm} (${decision.model}) · cost $${(decision.costUsd ?? 0).toFixed(4)} (${decision.spendSource})`);
    if (!out.ok) {
      lines.push(`  [meta-review] decision NOT persisted (${out.reason}): not acted on, the human path applies`);
      return { ran: true, persisted: false, decision, effect: human, honoured: false, lines };
    }
    if (out.repairedTornTail) lines.push(`  [meta-review] repaired a torn log tail (${out.repairedTornTail} bytes)`);
    const rec = await recordMetaLearning({ decisionType: META_DECISION_TYPE, externalId: attemptId, context: projectMetaDecisionForStore(decision), choice: { chose: decision.guard.effect, honoured: !!decision.guard.honoured } }, deps);
    lines.push(rec.recorded ? `  [meta-review] recorded (${META_DECISION_TYPE})` : `  [meta-review] learning row not recorded (${rec.reason})`);
    return { ran: true, persisted: true, decision, effect: decision.guard.effect, honoured: !!decision.guard.honoured, lines };
  };
  const unavailable = (reason, extra = {}) => finish({ state: 'unavailable', reason: red(reason).slice(0, 300), guard: { effect: human, honoured: false, reasonCode: 'unavailable', reason: red(reason).slice(0, 300) }, ...extra });

  // Nothing open to judge: a valid stop or admit must name >= 1 topic, so a reviewer call here can never yield a usable decision (measured on the
  // Pilot 1 rehearsal: two calls, $0.27-$1.01, both "invalid"). No call, no spend; the human path applies exactly as it did after an invalid reply.
  if (inventory.length === 0) return unavailable('no open topics in the last round: a stop or admit must name at least one, so no reviewer call was made');

  const budget = META_REVIEW_SESSION_BUDGET[mode];
  if (fold.sentCount >= budget) return unavailable(`session-budget: ${fold.sentCount} of ${budget} reviewer calls already made for this session`);

  const planFile = argv[1] || null;
  const pack = await (deps.buildPack || buildStepBackPack)({
    repoRoot: cwd, planFile, ledgerEntries, rounds,
    repoFiles: (deps.repoFiles || defaultRepoFiles)(cwd),
    archNeighbours: deps.archNeighbours !== undefined ? deps.archNeighbours : (env.AUDIT_CARD_NO_ARCH === '1' ? null : defaultArchNeighbours(cwd)),
  });
  base.pack = { sha256: crypto.createHash('sha256').update(pack.text).digest('hex'), chars: pack.text.length, fileCount: pack.files.length, excludedCount: (pack.excluded?.sensitive ?? 0) + (pack.excluded?.unreadable ?? 0), truncationCount: (pack.truncations || []).length };
  if (mode === 'plan') {
    const excluded = (pack.notes || []).some((n) => n.startsWith('plan file was excluded'));
    const cut = (pack.truncations || []).some((t) => t.section === 'plan');
    if (!planFile || excluded || cut) return unavailable(`plan-required-evidence: the plan is ${!planFile ? 'not given' : excluded ? 'excluded or unreadable' : 'truncated'} in the pack`);
  }

  const sel = (deps.selectProvider || createMetaReviewProvider)({ auditorModel });
  if (!sel.ok) return unavailable(`${sel.reason}${sel.skipped?.length ? ` (${sel.skipped.map((s) => `${s.arm}: ${s.reason}`).join('; ')})` : ''}`, { auditorFamily: sel.auditorFamily ?? null });
  const who = { arm: sel.arm, sentinel: sel.provider.sentinel, model: sel.provider.model, reviewerFamily: sel.family, auditorFamily: sel.auditorFamily };
  // Reserve under the session lock BEFORE the request is sent: the reserve event is the budget charge and the claim,
  // so a crash after send still counts, and a concurrent invocation can neither send this attempt nor take the last slot.
  const reservation = reserveUnderSessionLock({ auditDir, sid, file, budget, attemptId, human, event: { event: 'reserve', attemptId, at: base.at, arm: sel.arm }, append: deps.append || appendMetaEvent });
  if (!reservation.ok) {
    if (reservation.reuse) return reservation.reuse;
    if (reservation.budget) return unavailable(`session-budget: ${reservation.sentCount} of ${budget} reviewer calls already made for this session`);
    return notRun(`could not reserve the reviewer call (${reservation.reason}); nothing was sent`);
  }
  process.stderr.write(`  [meta-review] calling ${sel.arm} (${sel.provider.model}): attempt ${reservation.sentCount} of budget ${budget}\n`);

  const header = packHeader({ mode, trigger, round, caps, signalsLine, productivityLine: renderCapProductivity(productivity, { round, caps }), inventory });
  const user = `${header}\n\n${pack.text}`;
  const requestChars = META_REVIEW_SYSTEM_PROMPT.length + user.length;
  const spend = (sent, usage) => spendOf({ sent, usage, modelId: sel.provider.model, requestChars, outputCeiling: sel.provider.outputCeilingTokens });
  let res;
  try { res = await sel.provider.call({ system: META_REVIEW_SYSTEM_PROMPT, user, model: sel.provider.model }); } catch (err) {
    const sent = err?.sent !== false;
    return unavailable(`provider error: ${String(err?.message || err).slice(0, 200)}`, { ...who, sent, ...spend(sent, null) });
  }
  const sent = res?.sent !== false;
  if (res?.failure) return unavailable(`provider failure: ${res.failure}`, { ...who, sent, ...spend(sent, res.usage) });
  if (res?.truncated) return unavailable('reply truncated at the output cap (instrument failure, not a model answer)', { ...who, sent, ...spend(sent, res.usage) });

  const parsed = parseMetaReviewOutput(res?.text ?? '', { knownTopics: pack.topics });
  if (!parsed.ok) {
    const error = red(parsed.error).slice(0, 300);
    return finish({ ...who, sent, ...spend(sent, res.usage), state: 'invalid', error, raw: red(res?.text ?? '').slice(0, RAW_KEEP_CHARS), guard: { effect: human, honoured: false, reasonCode: 'invalid', reason: `invalid reply: ${error}` } });
  }
  // Evidence is only what the pack SHOWED: file parts, plus the plan when it reached the pack whole.
  const packFiles = [...pack.files.map((f) => f.path), ...(pack.plan?.included ? [pack.plan.path] : [])];
  const guard = guardMetaDecision({ trigger, output: parsed.output, inventory, ledgerEntries, lastRound, productivity, packFiles, round, caps });
  const verdict = JSON.parse(red(JSON.stringify(parsed.output)));
  return finish({ ...who, sent, ...spend(sent, res.usage), state: 'valid', verdict, guard: { effect: guard.effect, honoured: guard.honoured, reasonCode: guard.reasonCode, reason: red(guard.reason) }, admittedThrough: guard.admittedThrough ?? null });
}

/** One block for the card / stderr: the folded log for a session (what was decided, what was overridden). */
export function renderMetaLog({ auditDir, sid }) {
  const log = readMetaLog(metaLogPath(auditDir, sid));
  if (log.malformed) return [`Meta-review log: MALFORMED (${log.malformed}) — no automatic decision is read from it.`];
  const fold = foldMetaLog(log.events);
  if (!fold.decisions.size) return [];
  const lines = [`Meta-review decisions (${fold.decisions.size}; ${fold.sentCount} reviewer call(s)):`];
  for (const d of fold.decisions.values()) {
    const ov = fold.overridden.get(d.attemptId);
    lines.push(`  ${d.attemptId}: ${d.state}${d.verdict ? ` ${d.verdict.action}` : ''} → ${d.guard.effect}${d.guard.honoured ? '' : ` (${d.guard.reasonCode})`}${d.admittedThrough ? ` through round ${d.admittedThrough}` : ''}${ov ? ` · ${ov.map((o) => `${o.event} by ${o.by}`).join(', ')}` : ''}`);
  }
  return lines;
}

// ── debt capture of an honoured loop-ending decision (debt-auto-capture --meta-decision) ─────────────

/** The one command the gate prints after an honoured stop/structural (docs/plans/meta-step-back-at-cap.md §2.7). */
export function metaDebtCommand({ auditDir, sid, attemptId }) {
  const log = path.relative(process.cwd(), metaLogPath(auditDir, sid)) || metaLogPath(auditDir, sid);
  return `node scripts/debt-auto-capture.mjs --meta-decision ${shellQuote(log)} --decision ${shellQuote(attemptId)} --run ${shellQuote(sid)}`;
}

/** POSIX single-quote every argument: no expansion of any kind survives inside single quotes. */
export function shellQuote(s) {
  return `'${String(s ?? '').replace(/'/g, "'\\''")}'`;
}

/**
 * Project an HONOURED, un-overridden stop/structural decision onto the adjudication-ledger entry shape, so the single
 * debt writer persists it. Candidates are the decision's recorded inventory (a structural route captures only the
 * non-HIGH topics; its HIGHs were already ruled); each finding object is RE-READ from that round's own result file,
 * matched by id and re-checked by topic. A missing result or an unmatched finding is a skipped candidate, never silent.
 * @returns {{ok: true, entries: object[], skipped: Array<{id: string, reason: string}>, decision: object}|{ok: false, error: string}}
 */
export function metaDecisionToLedgerEntries({ logFile, attemptId, sid = null, readResult = (p) => JSON.parse(fs.readFileSync(p, 'utf8')) }) {
  if (!attemptId) return { ok: false, error: '--decision <attemptId> is required (a log may hold several decisions; none is guessed)' };
  const log = readMetaLog(logFile);
  if (log.malformed) return { ok: false, error: `decision log is malformed (${log.malformed})` };
  const fold = foldMetaLog(log.events);
  const d = honouredLoopEnd({ fold, attemptId });
  if (!d) return { ok: false, error: `${attemptId} is not an honoured stop/structural decision in this log, or a human overrode it` };
  const dSid = d.fingerprint?.sid ?? null;
  if (sid && dSid && sid !== dSid) return { ok: false, error: `--run ${sid} does not match the decision's session ${dSid}` };
  const lastRound = d.round - 1;
  const resultPath = path.join(path.dirname(logFile), `${dSid || 'session'}-r${lastRound}-result.json`);
  let findings = null; let readError = null;
  try { findings = readResult(resultPath)?.findings; } catch (err) { readError = err?.code || err?.message; }
  if (findings != null && !Array.isArray(findings)) { readError = 'result has no findings array'; findings = null; }
  const candidates = d.verdict?.action === 'stop' ? d.inventory : (d.inventory || []).filter((i) => i.severity !== 'HIGH');
  const premiseOf = new Map(d.verdict?.action === 'stop' ? d.verdict.items.map((i) => [i.topicId, `${i.kind}: ${i.premise}`]) : []);
  const why = (topicId) => (d.verdict?.action === 'stop' ? `meta-review stop (${premiseOf.get(topicId) ?? 'no premise'})` : `meta-review structural: ${d.verdict?.cause ?? ''}`);
  const entries = []; const skipped = [];
  for (const c of candidates || []) {
    const f = Array.isArray(findings) ? findings.find((x) => x?.id === c.findingId && topicOf(x) === c.topicId) : null;
    if (!f) { skipped.push({ id: c.topicId, reason: findings ? `finding ${c.findingId} not found in ${path.basename(resultPath)}` : `round result unreadable (${readError ?? 'no findings'})` }); continue; }
    entries.push({
      topicId: c.topicId, semanticHash: f._hash ?? c.topicId, ruling: 'defer', severity: f.severity, category: f.category, section: f.section,
      detailSnapshot: f.detail ?? '', affectedFiles: Array.isArray(f.affectedFiles) && f.affectedFiles.length ? f.affectedFiles : (f._primaryFile ? [f._primaryFile] : []),
      affectedPrinciples: f.principle ? [f.principle] : [], pass: f._pass || 'meta-review',
      rulingRationale: `${why(c.topicId)}. Decision ${attemptId} by ${d.model ?? 'the meta-reviewer'}, honoured by the deterministic guard (${d.guard?.reason ?? 'ok'}); the audit loop stopped at round ${d.round} with this topic open in round ${lastRound}. Revisit in the next change that touches these files, or override: the decision log records who and why.`.slice(0, 3900),
    });
  }
  return { ok: true, entries, skipped, decision: d };
}
