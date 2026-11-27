/**
 * @fileoverview When a guard-only red tier may be accepted (docs/plans/fleet-train-landing-friction.md section 2.3): the ONE
 * predicate for "every test passed, only a policy guard failed", the fingerprint an `accept-guard` decision is keyed to, and
 * why a binding does not admit a given red. Pure; `overlap.mjs`'s `approvable` and `decisions-cmd.mjs` share it.
 *
 * @module scripts/lib/fleet/tier-acceptance
 */
import crypto from 'node:crypto';

/** A red tier whose runner said every test passed and only a policy guard failed. The ONE predicate (train continues past it; approval may accept it). */
export const guardOnlyRed = (r) => r?.result === 'red' && r.failureKind === 'guard' && r.testsFailed === 0;

/** What an `accept-guard` binding is keyed to: this train, this candidate, this recorded tier result. */
export function tierFingerprint(trainId, candidateOid, r) {
  const key = { trainId, candidateOid, name: r.name, startedAt: r.startedAt ?? null, endedAt: r.endedAt ?? null, failureKind: r.failureKind ?? null,
    testsFailed: r.testsFailed ?? null, guards: (r.guards ?? []).map((g) => `${g.id}:${g.kind}`) };
  return crypto.createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 16);
}

/** Why the binding does NOT admit red tier `r`, or null. */
export function guardAcceptanceRefusal(manifest, r, binds) {
  if (!guardOnlyRed(r)) return `tier "${r.name}" is red (${r.failureKind ?? 'unclassified'}${Number.isInteger(r.testsFailed) && r.testsFailed > 0 ? `, ${r.testsFailed} test(s) failed` : ''}) — accept-guard covers only a guard-only red where every test passed, never a test failure, a timeout, an instrument failure or an unclassified red`;
  if (binds.trainId !== manifest.trainId) return `the accept-guard decision is bound to train ${binds.trainId}, not ${manifest.trainId}`;
  if (binds.candidateOid !== manifest.candidate.oid) return `the accept-guard decision is bound to candidate ${String(binds.candidateOid).slice(0, 12)}, not ${manifest.candidate.oid.slice(0, 12)}`;
  const b = (binds.tiers ?? []).find((x) => x.name === r.name);
  if (!b) return `the accept-guard decision does not cover tier "${r.name}"`;
  if (b.fingerprint !== tierFingerprint(manifest.trainId, manifest.candidate.oid, r)) return `the accept-guard decision was recorded for a different result of tier "${r.name}"`;
  return null;
}
