/**
 * @fileoverview Turn fleet telemetry measurements (store/fleet-events.mjs
 * `readFleetTelemetry`) into named WEAKNESS findings — the part a human reads.
 * Pure: thresholds in, findings out, so each rule is unit-tested and the same
 * verdicts render in the CLI and anywhere else.
 *
 * Each rule needs a minimum sample (`minN`), so a quiet week reads "not enough
 * data", never a clean bill of health. Thresholds are starting points, stated
 * here once; change them here, not at a call site.
 *
 * @module scripts/lib/fleet/telemetry-insights
 */

export const THRESHOLDS = Object.freeze({
  minN: 10,                    // events of a verb before its rates are judged
  minSessions: 5,              // sessions before flow rates are judged
  errorRate: 0.05,             // error+argv share of a verb's invocations
  slowP95Ms: { status: 10_000, next: 5_000, claim: 10_000, touch: 5_000, ready: 10_000, default: 30_000 },
  abandonRate: 0.2,            // abandoned / started sessions
  refusalsPerSession: 1,       // refusals INSIDE a claim→release lifecycle (ready/land gates)
  claimRefusalRate: 0.25,      // refused claims / claim attempts: sessions colliding
  pendingShare: 0.3,           // WAIT outcomes of land
  regressionFactor: 1.5,       // newest tool's status p95 vs the one before
  spoolStaleHours: 24,         // oldest undrained event
});

const pct = (x) => `${Math.round(x * 100)}%`;

/**
 * @param {object|null} m readFleetTelemetry result (null = not measured)
 * @param {{pending:number, oldestPendingAt:string|null, dropped:number, rejected:number}|null} spool
 * @param {{nowMs?: number, t?: typeof THRESHOLDS}} [opts]
 * @returns {{measured: boolean, state: 'measured'|'insufficient'|'unavailable', insufficient: string[], findings: Array<{severity:'high'|'medium'|'low', signal:string, message:string}>}}
 *   `measured` is true only when at least one rule had enough data to be judged;
 *   `insufficient` names what was skipped for want of data.
 */
export function deriveWeaknesses(m, spool, { nowMs = Date.now(), t = THRESHOLDS } = {}) {
  const findings = [];
  const add = (severity, signal, message) => findings.push({ severity, signal, message });

  if (spool?.error) add('high', 'capture', `the local spool is unreadable (${spool.error}) — events are not reaching the store`);
  if (spool && !spool.error) {
    if (spool.oldestPendingAt && (nowMs - Date.parse(spool.oldestPendingAt)) / 3_600_000 > t.spoolStaleHours) {
      add('high', 'capture', `${spool.pending} event(s) undrained since ${spool.oldestPendingAt} — the drain is not reaching the store (check the store config, then run cross-skill.mjs fleet-telemetry flush --spool <git-common-dir>/fleet-telemetry)`);
    }
    if (spool.dropped > 0) add('medium', 'capture', `${spool.dropped} event(s) dropped because the spool was full`);
    if (spool.rejected > 0) add('low', 'capture', `${spool.rejected} spooled event(s) failed the schema check and were set aside`);
  }
  if (!m || m.error) return { measured: false, state: 'unavailable', insufficient: [], findings: sorted(findings) };
  const insufficient = [];
  let judged = 0;

  for (const v of m.goldenSignals ?? []) {
    const label = v.mode ? `${v.verb} ${v.mode}` : v.verb;
    if (v.n < t.minN) { insufficient.push(label); continue; }
    judged += 1;
    if (v.errorRate != null && v.errorRate > t.errorRate) {
      add('high', 'errors', `${label}: ${pct(v.errorRate)} of ${v.n} runs errored or were mis-invoked`);
    }
    const slow = t.slowP95Ms[v.verb] ?? t.slowP95Ms.default;
    if (v.p95Ms != null && v.p95Ms > slow) add('medium', 'latency', `${label}: p95 ${Math.round(v.p95Ms)} ms (budget ${slow} ms)`);
    if (v.verb === 'land' && v.pending / v.n > t.pendingShare) {
      add('medium', 'flow', `${label}: ${pct(v.pending / v.n)} of runs ended in WAIT — checks or approvals are the bottleneck`);
    }
    if (v.verb === 'claim' && v.refused / v.n > t.claimRefusalRate) {
      add('medium', 'collisions', `${pct(v.refused / v.n)} of ${v.n} claims were refused — sessions are colliding on the same files`);
    }
    if (v.argv > 0) add('low', 'usability', `${label}: ${v.argv} mis-invocation(s) — see top reasons for the flag; a docs or CLI-shape gap`);
  }

  const f = m.sessionFlow ?? {};
  if ((f.started ?? 0) < t.minSessions) insufficient.push('session flow');
  else {
    judged += 1;
    if (f.abandoned / f.started > t.abandonRate) add('medium', 'flow', `${pct(f.abandoned / f.started)} of ${f.started} sessions were released as abandoned`);
    if (f.refusalsPerSession != null && f.refusalsPerSession > t.refusalsPerSession) {
      add('medium', 'flow', `${f.refusalsPerSession.toFixed(1)} refusals per session after claiming — ready/land gates block often`);
    }
  }
  for (const k of m.errorKinds ?? []) {
    if (k.kind === 'Error' || k.kind === 'TypeError' || k.kind === 'RangeError') add('high', 'errors', `${k.n} unexpected ${k.kind}(s) — a crash path, not a refusal`);
  }
  if ((m.saturation?.registryInvalidSeen ?? 0) > 0) add('medium', 'integrity', `status saw an invalid registry record ${m.saturation.registryInvalidSeen} time(s)`);

  // The ACTUAL newest two versions; if either lacks data the pair is not judged
  // (never silently substituting an older, better-sampled pair).
  const [newest, prior] = m.versions ?? [];
  // The sample that matters is STATUS runs (the p95 is over status only), not all invocations.
  const statusN = (v) => v.statusN ?? 0;
  const pairJudgeable = newest && prior && newest.statusP95Ms != null && prior.statusP95Ms != null
    && statusN(newest) >= t.minN && statusN(prior) >= t.minN;
  if (newest && prior && !pairJudgeable) insufficient.push('version comparison');
  if (pairJudgeable) judged += 1;
  if (pairJudgeable && newest.statusP95Ms > prior.statusP95Ms * t.regressionFactor) {
    add('high', 'regression', `status p95 rose from ${Math.round(prior.statusP95Ms)} ms (${prior.tool.slice(0, 8)}) to ${Math.round(newest.statusP95Ms)} ms (${newest.tool.slice(0, 8)})`);
  }
  const measured = judged > 0;
  return { measured, state: measured ? 'measured' : 'insufficient', insufficient, findings: sorted(findings) };
}

const ORDER = { high: 0, medium: 1, low: 2 };
function sorted(findings) {
  return [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}
