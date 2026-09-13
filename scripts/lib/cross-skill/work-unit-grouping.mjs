/**
 * @fileoverview Group a backlog page into work units — refactor-sized batches,
 * so a backlog can be worked a THEME at a time instead of a row at a time.
 *
 * ONE grouper for the three backlog readers (`list-unremediated-acceptances`,
 * `list-unlocked-fixes`, `final-review-pending`), moved out of
 * `commands/ship.mjs` on 2026-09-13 (docs/plans/backlog-tooling-honesty.md
 * §7) when the second and third callers arrived: a module-private helper in
 * one command file would have been copied, and two clusterers over one store
 * is how the same rows get grouped two ways.
 *
 * Membership is deterministic (embeddings + a cutoff derived from this repo's
 * own similarity distribution). Nothing here calls a model for MEMBERSHIP: the
 * unit key is what a caller filters and counts on, so it must be reproducible.
 * Labels default to the canonical row's category and are marked `labelSource`
 * so a model-written label can replace them later without changing what the
 * key means.
 *
 * Two honesty properties, both load-bearing:
 *  - `partial` is true when the page is smaller than `total`. Clustering a page
 *    and presenting it as the grouping would understate every unit's size, and
 *    a short page reads exactly like an exhausted one.
 *  - `unclustered` counts rows with NO embedding. They were never compared, so
 *    they are neither merged into a unit nor dropped from the tally.
 *
 * Egress: the member shape handed to the labeller is built HERE and carries
 * `{ id, primaryFile, category, createdAt, severity, embedding }` only — a
 * row's `detail_snapshot` (model prose, possibly quoting source) never reaches
 * `labelWorkUnits`, whichever reader the rows came from. Pinned by
 * tests/backlog-work-unit-grouping.test.mjs.
 *
 * @module scripts/lib/cross-skill/work-unit-grouping
 */

/** The recency column each reader stamps — named by the caller, never guessed. */
export const WORK_UNIT_DATE_KEYS = Object.freeze(['accepted_at', 'fixed_at', 'created_at']);

/**
 * @param {object} ctx - command context; reads `ctx.deps.getFindingEmbeddings`,
 *   `ctx.hasFlag('no-llm-labels')`, and an optional `ctx.deps.workUnitLabeller`
 *   (a test seam — production leaves it undefined and the default labeller runs).
 * @param {Array<object>} rows - one PAGE of backlog rows, each carrying
 *   `audit_finding_id`, `primary_file`, `category`, `severity` and the `dateKey` column.
 * @param {{total:number, wantUnit?:string|null, dateKey:string}} opts
 * @returns {Promise<object>} `{ workUnits, grouping }` (+ `rows`/`shown`/`workUnitFilter`
 *   when `wantUnit` is given)
 */
export async function groupIntoWorkUnits(ctx, rows, { total, wantUnit = null, dateKey }) {
  if (!WORK_UNIT_DATE_KEYS.includes(dateKey)) {
    throw new TypeError(`groupIntoWorkUnits: dateKey must be one of ${WORK_UNIT_DATE_KEYS.join('|')}, got ${JSON.stringify(dateKey)}`);
  }
  const { clusterWorkUnits } = await import('../work-units.mjs');
  const { labelWorkUnits } = await import('../work-unit-labels.mjs');
  const ids = rows.map((r) => r.audit_finding_id).filter(Boolean);
  const vecOf = await ctx.deps.getFindingEmbeddings(ids);

  const findings = rows.map((r) => ({
    id: r.audit_finding_id,
    primaryFile: r.primary_file,
    category: String(r.category || '').replace(/^\[[^\]]*\]\s*/, ''),
    createdAt: r[dateKey],
    severity: r.severity,
    embedding: vecOf.get(r.audit_finding_id),
  }));

  const { units: rawUnits, unclustered, cutoff } = clusterWorkUnits(findings);

  // Labels only — membership above is already fixed. Advisory by construction:
  // `labelWorkUnits` never throws and reports `labelSource` per unit, so an
  // unavailable model degrades to the category fallback instead of failing a
  // backlog listing. `--no-llm-labels` forces it off.
  const labelling = await labelWorkUnits(rawUnits, {
    enabled: !ctx.hasFlag('no-llm-labels'),
    ...(ctx.deps.workUnitLabeller ? { labeller: ctx.deps.workUnitLabeller } : {}),
  });
  const units = labelling.units;

  const shaped = units.map((u) => ({
    key: u.key, label: u.label, labelSource: u.labelSource, size: u.size,
    files: u.files, canonicalId: u.canonicalId,
    severities: u.members.reduce((a, m) => { a[m.severity] = (a[m.severity] || 0) + 1; return a; }, {}),
    memberIds: u.members.map((m) => m.id),
  }));

  const grouping = {
    basis: 'work-unit',
    dateKey,
    cutoff: cutoff.cutoff, cutoffSource: cutoff.source, cutoffSamples: cutoff.samples,
    population: rows.length,
    clustered: rows.length - unclustered.length,
    unclustered: unclustered.length,
    unclusteredIds: unclustered.map((u) => u.id),
    units: shaped.length,
    multiRowUnits: shaped.filter((u) => u.size > 1).length,
    partial: rows.length < total,
    // Label provenance, so a caller can tell a model-written name from the
    // deterministic category fallback rather than assuming every label is good.
    labels: {
      llm: labelling.labelled, cached: labelling.cached,
      fallback: labelling.failed, reason: labelling.reason,
    },
  };

  if (!wantUnit) return { workUnits: shaped, grouping };

  // `--work-unit <key>` pulls one unit's rows for a focused refactor.
  const unit = shaped.find((u) => u.key === wantUnit);
  if (!unit) {
    return { workUnits: shaped, grouping, rows: [], shown: 0, workUnitFilter: { key: wantUnit, found: false } };
  }
  const member = new Set(unit.memberIds);
  const filtered = rows.filter((r) => member.has(r.audit_finding_id));
  return {
    workUnits: [unit], grouping, rows: filtered, shown: filtered.length,
    workUnitFilter: { key: wantUnit, found: true, label: unit.label },
  };
}

/**
 * The flag tail every grouping-capable reader shares: `--group-by work-unit`
 * turns grouping on; `--work-unit <key>` implies it and filters to one unit.
 * Returns `null` when neither flag is present so the caller returns its base
 * envelope unchanged.
 */
export function wantsWorkUnits(ctx) {
  const groupBy = ctx.flag ? ctx.flag('group-by') : null;
  const wantUnit = ctx.flag ? ctx.flag('work-unit') : null;
  if (groupBy !== 'work-unit' && !wantUnit) return null;
  return { wantUnit: wantUnit || null };
}
