/**
 * @fileoverview The ONE record-state oracle for the ship record catch-up
 * (docs/plans/ship-record-catchup.md §2.1).
 *
 * Fleet coordinators land PRs without `/ship`, so its record half (status entry,
 * Backlog line, ship_event) never happens. The catch-up records each merged PR
 * once. Whether a PR is "recorded" is decided HERE and nowhere else — the CLI,
 * the writer and fleet's nudge all read this function's answer.
 *
 * **The entries are the ledger.** There is no watermark file: a PR is recorded
 * iff a log entry on the BASE tree names it — a catch-up marker carrying its
 * number and merge sha — or its own merge commit ADDED a log entry (`/ship`
 * Step 2's footprint). The only stored watermark is one floor entry.
 *
 * Pure: no I/O, no clock. Facts arrive as plain data (lib/ship-record/facts.mjs).
 * **Unmeasured is never zero**: every state but `measured`/`partial` carries
 * `unrecorded: null`.
 *
 * @module scripts/lib/ship-record/state
 */

/** Days before the floor's cutoff that every listing re-checks (late search results, plan §2.1a). */
export const RECHECK_DAYS = 7;

const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export const SHA_RE = /^[0-9a-f]{40}$/;

/** Strict ISO-8601 UTC: shape AND a calendar round trip (Date.parse accepts 2026-02-30 and normalises it). */
export function isStrictIsoZ(s) {
  if (typeof s !== 'string' || !ISO_Z_RE.test(s)) return false;
  const t = Date.parse(s);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 19) === s.slice(0, 19);
}

/** The floor marker grammar — the ONE grammar the renderer and the parser share (plan §2.1, audit R3-H1). */
export const FLOOR_MARKER_RE = /<!-- ship-record-floor v1 merged-through=(\S+) covered=(\S+) -->/g;
/** The per-PR catch-up marker. */
export const PR_MARKER_RE = /<!-- ship-record v1 pr=(\d+) merge=([0-9a-f]{40}) -->/g;

/** Entry file names: `<YYYY-MM-DD>-<HHMMSS>-<kebab-slug>.md` (docs/status/entries/README.md). */
export const ENTRY_NAME_RE = /^(\d{4}-\d{2}-\d{2})-(\d{6})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const PR_ENTRY_RE = /^\d{4}-\d{2}-\d{2}-\d{6}-pr-([1-9]\d*)\.md$/;
const FLOOR_ENTRY_RE = /^\d{4}-\d{2}-\d{2}-\d{6}-record-floor\.md$/;
/** A run entry: `…-record-catchup-<4 hex>.md` (the suffix keeps two same-second runs apart). */
export const RUN_ENTRY_RE = /^\d{4}-\d{2}-\d{2}-\d{6}-record-catchup(?:-[0-9a-f]{4,8})?\.md$/;

export const RECORD_STATES = Object.freeze(['measured', 'partial', 'unmeasured', 'no-floor', 'ambiguous-floor', 'no-marker']);

/** Render the floor marker. Throws on input the parser would reject — the two cannot drift. */
export function renderFloorMarker({ mergedThrough, covered }) {
  const list = [...covered].sort((a, b) => a - b);
  const marker = `<!-- ship-record-floor v1 merged-through=${mergedThrough} covered=${list.length ? list.join(',') : 'none'} -->`;
  const parsed = parseFloorMarker(marker);
  if (!parsed.ok) throw new Error(`renderFloorMarker: ${parsed.reason}`);
  return marker;
}

/**
 * Parse the floor marker out of an entry's text.
 * @returns {{ok: true, mergedThrough: string, covered: number[]} | {ok: false, reason: string}}
 */
export function parseFloorMarker(text) {
  const all = [...String(text ?? '').matchAll(FLOOR_MARKER_RE)];
  if (all.length === 0) return { ok: false, reason: 'no floor marker' };
  if (all.length > 1) return { ok: false, reason: 'more than one floor marker' };
  const [, through, coveredText] = all[0];
  if (!isStrictIsoZ(through)) return { ok: false, reason: `merged-through ${JSON.stringify(through)} is not an ISO-8601 UTC timestamp` };
  if (coveredText === 'none') return { ok: true, mergedThrough: through, covered: [] };
  if (!/^[1-9]\d*(,[1-9]\d*)*$/.test(coveredText)) return { ok: false, reason: 'covered must be "none" or a comma-separated list of positive integers' };
  const covered = coveredText.split(',').map(Number);
  for (let i = 1; i < covered.length; i++) {
    if (covered[i] <= covered[i - 1]) return { ok: false, reason: 'covered must be strictly ascending (no duplicates)' };
  }
  if (!covered.every(Number.isSafeInteger)) return { ok: false, reason: 'covered holds an unsafe integer' };
  return { ok: true, mergedThrough: through, covered };
}

/** PR markers in an entry's text → [{pr, merge}]. */
export function parsePrMarkers(text) {
  return [...String(text ?? '').matchAll(PR_MARKER_RE)].map((m) => ({ pr: Number(m[1]), merge: m[2] }));
}

/** `2026-11-16-091244-pr-372.md` → 372; anything else → null. */
export function prNumberFromEntryName(name) {
  const m = PR_ENTRY_RE.exec(String(name ?? ''));
  return m ? Number(m[1]) : null;
}

export const isFloorEntryName = (name) => FLOOR_ENTRY_RE.test(String(name ?? ''));

/** The first instant every listing must cover: RECHECK_DAYS before the floor's cutoff. */
export function listingStart(floor) {
  return new Date(Date.parse(floor.mergedThrough) - RECHECK_DAYS * 86_400_000).toISOString();
}

/**
 * Classify every merged PR. Pure.
 *
 * @param {object} f
 * @param {boolean} f.markerPresent docs/status/entries/README.md exists on the base tree
 * @param {Array<{file: string, ok: boolean, mergedThrough?: string, covered?: number[], reason?: string}>} f.floors parsed floors on the base tree
 * @param {{ok: boolean, complete?: boolean, prs?: Array<{number:number, mergedAt:string, mergeCommit:string|null}>, reason?: string, partialReason?: string}} f.merged the listing
 * @param {Array<{pr:number, merge:string}>} f.baseMarkers catch-up markers on the base tree
 * @param {Map<string, 'in-band'|'record-pr'|false|null>} f.inBand merge sha → what its own merge added (null = not determinable)
 * @param {Map<string, boolean>} [f.inBase] merge sha → is it an ancestor of the pinned base? false ⇒ merged after the fetched
 *   base, so the base tree cannot show its record yet: unknown, never unrecorded (A-R3-H1)
 */
export function classifyRecordState(f) {
  const nulls = (state, reason, extra = {}) => ({
    state, reason, floor: null, prs: [], counts: { merged: null, recorded: null, unrecorded: null, unknown: null }, ...extra,
  });
  if (!f.markerPresent) return nulls('no-marker', 'docs/status/entries/README.md is absent on the base tree (per-entry status files are not adopted)');
  const floors = f.floors ?? [];
  const bad = floors.find((x) => !x.ok);
  if (bad) return nulls('unmeasured', `invalid floor ${bad.file} (${bad.reason})`);
  if (floors.length === 0) return nulls('no-floor', 'no record floor exists yet');
  if (floors.length > 1) return nulls('ambiguous-floor', `${floors.length} floors on the base tree (${floors.map((x) => x.file).join(', ')}): a human removes one in a reviewed PR`);
  const floor = floors[0];
  if (!f.merged?.ok) return nulls('unmeasured', f.merged?.reason ?? 'the merged-PR listing did not answer', { floor });
  // A listing that claims success must SAY so completely: no rows array, or no explicit completeness, is not an empty list.
  if (!Array.isArray(f.merged.prs) || typeof f.merged.complete !== 'boolean') return nulls('unmeasured', 'the merged-PR listing was malformed (no rows array or no completeness flag)', { floor });

  const covered = new Set(floor.covered);
  // Every marker sha per PR: a stale marker for the same number must not shadow the matching one (either order).
  const markerFor = new Map();
  for (const m of f.baseMarkers ?? []) markerFor.set(m.pr, (markerFor.get(m.pr) ?? new Set()).add(m.merge));
  const cutoffMs = Date.parse(floor.mergedThrough);
  const startMs = cutoffMs - RECHECK_DAYS * 86_400_000;

  const prs = [];
  let malformed = 0;
  for (const pr of f.merged.prs) {
    const t = Date.parse(pr?.mergedAt);
    if (!Number.isSafeInteger(pr?.number) || !Number.isFinite(t)) { malformed++; continue; }
    if (t < startMs) continue;
    if (covered.has(pr.number)) continue; // the floor summarised it (overlap-safe: by number, never by timestamp alone)
    // A PR merged before the recheck window would have been in the floor listing; between the window start and the
    // cutoff it is a late search result the floor never saw — recorded like any other.
    const sha = pr.mergeCommit;
    let status;
    let by = null;
    if (sha && markerFor.get(pr.number)?.has(sha)) { status = 'recorded'; by = 'marker'; }
    else if (!sha || !SHA_RE.test(sha)) status = 'unknown';
    else if (f.inBase?.get(sha) === false) status = 'unknown';
    else {
      const ib = f.inBand?.get(sha);
      // 'in-band': the merge added a /ship-style entry. 'record-pr': the merge added ONLY catch-up records — it IS a record,
      // and writing an entry for it would make every record PR spawn another (never-ending). Anything else is not evidence.
      if (ib === 'in-band' || ib === 'record-pr') { status = 'recorded'; by = ib; }
      else if (ib === false) status = 'unrecorded';
      else status = 'unknown';
    }
    prs.push({ ...pr, status, by });
  }
  prs.sort((a, b) => (Date.parse(a.mergedAt) - Date.parse(b.mergedAt)) || (a.number - b.number));
  const count = (s) => prs.filter((p) => p.status === s).length;
  const counts = { merged: prs.length, recorded: count('recorded'), unrecorded: count('unrecorded'), unknown: count('unknown') };
  const incomplete = f.merged.complete === false || malformed > 0;
  const state = incomplete || counts.unknown > 0 ? 'partial' : 'measured';
  const reasons = [];
  if (f.merged.complete === false) reasons.push(f.merged.partialReason ?? 'the listing was not complete');
  if (malformed > 0) reasons.push(`${malformed} listed PR(s) had no valid number or merge time`);
  if (counts.unknown > 0) reasons.push(`${counts.unknown} merge commit(s) are not in the local object store or are newer than the fetched base — git fetch origin`);
  return { state, reason: reasons.length ? reasons.join('; ') : null, floor, prs, counts };
}
