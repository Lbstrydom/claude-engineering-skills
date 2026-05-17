/**
 * @fileoverview Requirements ledger — load / reconcile / write / derive-index.
 * Plan: docs/plans/requirements-layer.md — Plan-Phase A.
 *
 * `reconcile` is a PURE function (inputs → ledger object) so it is fully
 * unit-testable; the CLI wraps load→reconcile→write in a repo-scoped lock.
 * The ledger is the SINGLE persisted artefact — the index is derived
 * in-memory, never a separate file (audit R2-H3).
 *
 * @module scripts/lib/requirements/ledger
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';
import { jaccardSimilarity } from '../ledger.mjs';
import { RequirementsLedgerSchema } from './schema.mjs';

export const LEDGER_PATH = '.requirements/ledger.json';
const ALIAS_SIM_THRESHOLD = 0.6;
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

const norm = (a) => String(a).toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '').trim();

/** Load the ledger, or an empty one when absent/unreadable. Never throws. */
export function loadLedger({ baseDir = process.cwd() } = {}) {
  const empty = {
    generatedAt: new Date(0).toISOString(), commitSha: null, extractionSourceSha: null,
    coveredFiles: [], requirements: [], identityAliases: {},
  };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(baseDir, LEDGER_PATH), 'utf-8'));
    const parsed = RequirementsLedgerSchema.safeParse(raw);
    return parsed.success ? parsed.data : empty;
  } catch {
    return empty;
  }
}

/** Atomic write — validates against the schema at the boundary first. */
export function writeLedger(ledger, { baseDir = process.cwd() } = {}) {
  const parsed = RequirementsLedgerSchema.safeParse(ledger);
  if (!parsed.success) {
    const e = new Error('writeLedger: ledger failed schema validation');
    e.issues = parsed.error.issues;
    throw e;
  }
  const dir = path.join(baseDir, '.requirements');
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(path.join(baseDir, LEDGER_PATH), JSON.stringify(parsed.data, null, 2) + '\n');
  return path.join(baseDir, LEDGER_PATH);
}

/** Derived in-memory index — the always-loaded tier. Pure projection. */
export function deriveIndex(ledger) {
  return (ledger.requirements || []).map((r) => ({
    id: r.id, assertion: r.assertion, kind: r.kind, status: r.status,
  }));
}

function statusFor({ req, gap, override, ambiguous }) {
  if (override?.decision === 'accept') return 'active';
  if (ambiguous) return 'needs-review';            // split/merge/ambiguous identity (audit R2-M3)
  if (gap && (gap.gap === 'contradictory' || gap.gap === 'observed-but-unintended')) {
    return 'needs-review';                          // a suspected bug never becomes an enforced invariant (audit G1)
  }
  if ((req.seenInRuns || 1) < 2) return 'inferred-only';
  return 'active';
}

/**
 * Reconcile a fresh extraction into the active ledger. PURE.
 *
 * Scoped partial merge (audit G1): prior requirements OUTSIDE the new
 * `coveredFiles` are retained untouched; only in-scope ones are replaced.
 * Identity is frozen (audit H1/R2-M1): a candidate matches a prior
 * requirement by exact id → alias → unambiguous 1:1 reword, reusing the
 * prior's frozen id. `seenInRuns`/`confidence` merge as high-water marks
 * (audit G2). Status per `statusFor`.
 *
 * @param {object} args
 * @returns {object} a `RequirementsLedger`
 */
export function reconcile({
  candidates = [], coveredFiles = [], gapAssessments = [], overrides = {},
  priorLedger = null, commitSha = null, extractionSourceSha = null,
}) {
  const prior = priorLedger || { requirements: [], coveredFiles: [], identityAliases: {} };
  const gapById = new Map(gapAssessments.map((g) => [g.requirementId, g]));
  const newCovered = new Set(coveredFiles);
  const inNewScope = (req) => (req.provenance || []).some((p) => newCovered.has(p.file));

  // (1) Prior requirements outside the new extraction scope — retained as-is.
  const retained = prior.requirements.filter((r) => !inNewScope(r));
  const priorInScope = prior.requirements.filter((r) => inNewScope(r));
  const priorById = new Map(priorInScope.map((r) => [r.id, r]));
  const aliases = { ...(prior.identityAliases || {}) };

  // (2) Match each candidate to a prior in-scope requirement.
  const matchedPriorIds = new Set();
  const exactMatched = [];     // { cand, priorId }
  const unmatched = [];        // candidates with no exact/alias match
  for (const cand of candidates) {
    const aliasTarget = aliases[cand.id];
    if (priorById.has(cand.id)) {
      exactMatched.push({ cand, priorId: cand.id }); matchedPriorIds.add(cand.id);
    } else if (aliasTarget && priorById.has(aliasTarget)) {
      exactMatched.push({ cand, priorId: aliasTarget }); matchedPriorIds.add(aliasTarget);
    } else {
      unmatched.push(cand);
    }
  }

  // (3) Unambiguous 1:1 reword aliasing for the leftovers.
  const vanished = priorInScope.filter((r) => !matchedPriorIds.has(r.id));
  const aliasResolved = []; // { cand, priorId }
  const ambiguousIds = new Set();
  for (const cand of unmatched) {
    const sims = vanished
      .map((v) => ({ v, s: jaccardSimilarity(norm(cand.assertion), norm(v.assertion)) }))
      .filter((x) => x.s >= ALIAS_SIM_THRESHOLD && x.v.kind === cand.kind)
      .sort((a, b) => b.s - a.s);
    if (sims.length === 1) {
      const v = sims[0].v;
      // mutual-best check: is `cand` also v's best among unmatched candidates?
      const vBest = unmatched
        .map((c) => ({ c, s: jaccardSimilarity(norm(v.assertion), norm(c.assertion)) }))
        .filter((x) => x.s >= ALIAS_SIM_THRESHOLD).sort((a, b) => b.s - a.s);
      if (vBest.length === 1 && vBest[0].c === cand) {
        aliasResolved.push({ cand, priorId: v.id });
        matchedPriorIds.add(v.id);
        if (cand.id !== v.id) aliases[cand.id] = v.id;
        continue;
      }
    }
    if (sims.length >= 1) ambiguousIds.add(cand.id); // split/merge/ambiguous → needs-review
  }

  // (4) Build the reconciled in-scope set.
  const reconciledInScope = [];
  for (const cand of candidates) {
    const override = overrides[cand.id];
    if (override?.decision === 'reject') continue;          // dropped from the ledger
    const match = [...exactMatched, ...aliasResolved].find((m) => m.cand === cand);
    const priorReq = match ? priorById.get(match.priorId) : null;
    const frozenId = priorReq ? priorReq.id : cand.id;       // frozen-at-birth identity

    // High-water-mark merge of seenInRuns / confidence (audit G2).
    const seenInRuns = Math.max(cand.seenInRuns || 1, priorReq?.seenInRuns || 0);
    const confidence = (CONFIDENCE_RANK[cand.confidence] >= CONFIDENCE_RANK[priorReq?.confidence ?? 'low'])
      ? cand.confidence : priorReq.confidence;

    const gap = gapById.get(cand.id) || null;
    const req = {
      ...cand,
      id: frozenId,
      seenInRuns,
      confidence,
      assertion: (override?.assertion || cand.assertion).slice(0, 200),
      gap: gap ? { ...gap, requirementId: frozenId } : null,
    };
    req.status = statusFor({ req, gap, override, ambiguous: ambiguousIds.has(cand.id) });
    reconciledInScope.push(req);
  }

  const requirements = [...retained, ...reconciledInScope]
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    generatedAt: new Date().toISOString(),
    commitSha,
    extractionSourceSha,
    coveredFiles: [...new Set([...(prior.coveredFiles || []), ...coveredFiles])].sort(),
    requirements,
    identityAliases: aliases,
  };
}
