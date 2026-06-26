/**
 * @fileoverview Dashboard collector for the /nav-audit section (plan §3, §4a.F).
 * Produces exactly two panels' data: the Per-Persona Reachability Scorecard and
 * the Nav Drift indicator. Mirrors `collect-reference.mjs::collectArchitecture`'s
 * degradation contract: returns `status: missing-optional | ok | unexpected-error`
 * so the renderer shows an empty panel with a logged cause when the contract or
 * observed envelope is absent (cloud-off / not-yet-run).
 *
 * Assigned to REGISTRY.reference (current architectural state), not telemetry
 * (audit Gemini-1-L).
 *
 * @module scripts/lib/dashboard/collect-nav
 */
import fs from 'node:fs';
import path from 'node:path';
import { NavObservedSchema, OBSERVED_FILE, computeContractDigest, computeConfigDigest } from '../nav/schema.mjs';
import { readContract } from '../nav/contract.mjs';
import { buildModel } from '../nav/model.mjs';
import { runTaxonomy, personaScorecard } from '../nav/findings.mjs';
import { partitionFindings, ageDivergences, readDriftLedger } from '../nav/drift.mjs';
import { readVerifyResult } from '../nav/verify-store.mjs';

/**
 * @param {string} root
 * @returns {{navAudit: {scorecard: object[], drift: object[], status: object}}}
 */
export function collectNav(root) {
  const { contract, present, error } = readContract(root);
  if (error) return wrap({ status: { status: 'unexpected-error', detail: error } });
  if (!present) {
    return wrap({ status: { status: 'missing-optional', detail: 'no nav-contract.json — run `node scripts/nav-audit.mjs --bootstrap`' } });
  }

  // Reject a stale envelope (config digest the reader can recompute — plan §4a.D /
  // Gemini-1-M). A contract/tool-version move without regeneration → degrade.
  const expectedDigest = computeConfigDigest({ contractDigest: computeContractDigest(contract) });
  const env = readEnvelope(root, expectedDigest);
  if (!env.envelope) {
    // Live evidence is live-DOM-derived (liveAttribution/liveFindings) — it must
    // NOT be hidden by an absent/stale static observed envelope (debt fix 2).
    // When a fresh verify result exists, surface a LIVE-ONLY view.
    const verify = readVerifyResult(root, computeContractDigest(contract));
    if (verify.result) {
      const r = verify.result;
      // Empty model is intentional: in live mode personaScorecard builds rows from
      // contract.personas intents and its model.destinations.get(...) lookup
      // tolerates undefined (findings.mjs:232 `d ? [...d.anchors] : []`), then
      // mergeScorecard replaces status from liveAttribution. No static graph needed.
      const EMPTY_MODEL = { destinations: new Map() };
      const scorecard = personaScorecard(EMPTY_MODEL, contract, {
        liveAttribution: r.liveAttribution,
        statesRequested: r.statesRequested,
        statesCollected: r.statesCollected,
        unverifiableLayers: r.unverifiableLayers ?? [],   // v1.4
      }).rows;
      return wrap({
        contract, scorecard, drift: [], liveFindings: r.liveFindings ?? [],
        verifyMeta: { live: true, url: r.url, generatedAt: r.generatedAt, states: r.statesCollected, staticStale: true },
        // Surface WHY the static graph is unavailable (absent/stale/malformed) so a
        // corrupt observed envelope isn't masked by the live-only fallback.
        status: { status: 'ok', detail: `live-only — static graph unavailable (${env.reason || 'absent'}); run /nav-audit to refresh drift` },
      });
    }
    return wrap({
      contract,
      status: { status: 'missing-optional', detail: env.reason || `no ${OBSERVED_FILE} — run /nav-audit` },
    });
  }

  // Prefer the authoritative LIVE verdicts from the last `--verify` run (gitignored
  // result, tied to the contract digest so a contract edit invalidates it). Falls
  // back to the static scorecard when no fresh live result exists.
  const model = buildModel(env.envelope.edges, { contract, sources: [], destinations: env.envelope.destinations });
  const verify = readVerifyResult(root, computeContractDigest(contract));
  const live = verify.result;
  const scorecard = personaScorecard(model, contract, live ? {
    liveAttribution: live.liveAttribution,
    statesRequested: live.statesRequested,
    statesCollected: live.statesCollected,
    unverifiableLayers: live.unverifiableLayers ?? [],   // v1.4
  } : {}).rows;
  const verifyMeta = live
    ? { live: true, url: live.url, generatedAt: live.generatedAt, states: live.statesCollected }
    : { live: false, reason: verify.rejectedReason };
  // Live findings (v1.3 #4) — surfaced from the persisted verify result when present
  // (a v2 envelope); a v1 envelope / no live run → []. Additive, degrades empty.
  const liveFindings = live?.liveFindings ?? [];

  // Nav Drift = ADVISORY divergences (orphans, etc.), aged (plan §3, Gemini-1-H).
  // Aging is cloud-sourced; with no history here, new divergences age to 0 (the
  // >14-day governance smell fires once cloud run-history accrues).
  const { advisory } = partitionFindings(runTaxonomy(model, { contract }));
  // Local dashboard reads the gitignored drift-ledger cache for firstSeen; CI/cloud
  // callers source it from run-history (firstSeenFromHistory). Fixes Gemini-2-M
  // (was hardcoded empty → all ages 0).
  const ledger = readDriftLedger(root);
  const aged = ageDivergences(advisory, {
    firstSeenLookup: (key) => ledger[key] || null,
    headCommitDate: env.envelope.generatedAt,
  });
  const drift = aged.map(({ finding, ageDays }) => ({
    class: finding.class, destination: finding.destination, severity: finding.severity, verdict: finding.verdict, ageDays,
  }));

  return wrap({ contract, scorecard, drift, verifyMeta, liveFindings, status: { status: 'ok', detail: '' } });
}

function readEnvelope(root, expectedConfigDigest) {
  const file = path.join(root, OBSERVED_FILE);
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); }
  catch (err) { return { envelope: null, reason: err.code === 'ENOENT' ? null : `envelope unreadable: ${err.message}` }; }
  let parsed;
  try {
    parsed = NavObservedSchema.safeParse(JSON.parse(raw));
  } catch (err) { return { envelope: null, reason: `envelope malformed: ${err.message}` }; }
  if (!parsed.success) return { envelope: null, reason: 'envelope failed schema' };
  if (expectedConfigDigest && parsed.data.configDigest !== expectedConfigDigest) {
    return { envelope: null, reason: 'envelope stale: config digest changed — re-run /nav-audit' };
  }
  return { envelope: parsed.data, reason: null };
}

function wrap({ scorecard = [], drift = [], status, verifyMeta = { live: false }, liveFindings = [] }) {
  return { navAudit: { scorecard, drift, status, verifyMeta, liveFindings } };
}
