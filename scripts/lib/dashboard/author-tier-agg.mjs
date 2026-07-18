/**
 * @fileoverview Pure aggregator for the author-tier observation panel.
 *
 * Shapes raw grouped `learning_decisions` rows (decision_type='author_tier',
 * see docs/plans/model-tier-observation.md) into the dashboard view: suggested
 * tier × converged, the declared ladder partition keys, and the cross-model-bias
 * DIVERSITY gate (≥3 distinct provider ladders) the deferred routing phase waits
 * on. No I/O — unit-testable in isolation.
 *
 * @module scripts/lib/dashboard/author-tier-agg
 */

const TIERS = ['economy', 'standard', 'frontier', 'unknown'];

/** A truthy/string/boolean `converged` value → boolean. */
function isConverged(v) {
  return v === true || v === 'true' || v === 't';
}

/**
 * @param {Array<{declared_source?,provider?,family?,model?,suggested_tier?,declared_tier?,converged?,n}>} rows
 * @returns {{ total:number,
 *             bySuggestedTier:Array<{tier:string,total:number,converged:number,convergedPct:number}>,
 *             ladders:Array<{provider:string,family:string,model:string,count:number}>,
 *             distinctProviderLadders:number, diversityGateMet:boolean,
 *             agreement:{agree:number,disagree:number,declaredUnknown:number} }}
 */
export function aggregateAuthorTier(rows = []) {
  let total = 0;
  let agree = 0;
  let disagree = 0;
  let declaredUnknown = 0;
  const bySuggested = new Map();   // tier → { total, converged }
  const ladderMap = new Map();     // "provider|family|model" → count
  const providers = new Set();

  for (const r of Array.isArray(rows) ? rows : []) {
    const n = Number(r.n) || 0;
    if (n <= 0) continue;
    total += n;

    const sug = TIERS.includes(r.suggested_tier) ? r.suggested_tier : 'unknown';
    const e = bySuggested.get(sug) || { total: 0, converged: 0 };
    e.total += n;
    if (isConverged(r.converged)) e.converged += n;
    bySuggested.set(sug, e);

    // Ladder partition key — only rows with a declared (concrete) author model
    // populate it; a bare logical-tier hint or absent hint leaves it null.
    const provider = r.provider || null;
    const family = r.family || null;
    const model = r.model || null;
    if (provider) providers.add(provider);
    if (provider || model) {
      const key = `${provider || '?'}|${family || '?'}|${model || '?'}`;
      ladderMap.set(key, (ladderMap.get(key) || 0) + n);
    }

    const decl = r.declared_tier;
    if (!decl || decl === 'unknown') declaredUnknown += n;
    else if (decl === sug) agree += n;
    else disagree += n;
  }

  const bySuggestedTier = TIERS
    .filter((t) => bySuggested.has(t))
    .map((t) => {
      const e = bySuggested.get(t);
      return { tier: t, total: e.total, converged: e.converged, convergedPct: e.total ? Math.round((100 * e.converged) / e.total) : 0 };
    });

  const ladders = [...ladderMap.entries()]
    .map(([k, count]) => {
      const [provider, family, model] = k.split('|');
      return { provider, family, model, count };
    })
    .sort((a, b) => b.count - a.count);

  return {
    total,
    bySuggestedTier,
    ladders,
    distinctProviderLadders: providers.size,
    // The deferred routing phase gates a SHARED artifact on ladder diversity
    // (≥3 provider ladders), NOT sample count — the cross-model-bias defence.
    diversityGateMet: providers.size >= 3,
    agreement: { agree, disagree, declaredUnknown },
  };
}
