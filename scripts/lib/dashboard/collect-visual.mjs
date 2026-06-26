/**
 * @fileoverview Dashboard collector for the /visual-audit section (plan §3, §7).
 * Two panels: the Contracted-Surface Scorecard + the Visual Findings list. Local-
 * first (reads the gitignored verify-result + observed envelope), mirroring
 * collect-nav.mjs's degradation contract (status: missing-optional | ok |
 * unexpected-error). Assigned to REGISTRY.reference.
 *
 * @module scripts/lib/dashboard/collect-visual
 */
import { computeContractDigest, computeConfigDigest } from '../visual/schema.mjs';
import { readContract } from '../visual/contract.mjs';
import { readObservedEnvelope, readVerifyResult } from '../visual/store.mjs';
import { buildScorecard } from '../visual/render.mjs';

/**
 * @param {string} root
 * @returns {{visualAudit: {scorecard: object[], findings: object[], diagnostics: object[], verifyMeta: object, status: object}}}
 */
export function collectVisual(root) {
  const { contract, present, error } = readContract(root);
  if (error) return wrap({ status: { status: 'unexpected-error', detail: error } });
  if (!present) {
    return wrap({ status: { status: 'missing-optional', detail: 'no visual-contract.json — run `node scripts/visual-audit.mjs --bootstrap`' } });
  }

  const contractDigest = computeContractDigest(contract);
  const env = readObservedEnvelope(root, computeConfigDigest({ contractDigest }));
  const diagnostics = env.envelope?.diagnostics ?? [];

  const verify = readVerifyResult(root, contractDigest);
  if (!verify.result) {
    // Static-only: surface the source-coherence diagnostics; no live findings yet.
    return wrap({
      diagnostics,
      verifyMeta: { live: false, reason: verify.reason },
      status: { status: 'ok', detail: diagnostics.length ? '' : (env.reason || 'no live --verify run yet') },
    });
  }

  const r = verify.result;
  const scorecard = buildScorecard(contract.surfaces, r.findings, r.unverifiableSurfaces);
  return wrap({
    diagnostics,
    findings: r.findings,
    scorecard,
    verifyMeta: { live: true, url: r.url, generatedAt: r.generatedAt, states: r.statesCollected, unverifiableSurfaces: r.unverifiableSurfaces },
    status: { status: 'ok', detail: '' },
  });
}

function wrap({ scorecard = [], findings = [], diagnostics = [], verifyMeta = { live: false }, status }) {
  return { visualAudit: { scorecard, findings, diagnostics, verifyMeta, status } };
}
