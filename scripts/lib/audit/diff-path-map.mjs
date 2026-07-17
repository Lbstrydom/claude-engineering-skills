/**
 * @fileoverview The diff-path map — the contract this pipeline's schema has
 * described since day one but never had.
 *
 * `EvidenceAnchorSchema.diffPathId` is documented as "Stable identity for this
 * diff file-pair (from the diff-path map)". **That map was specified
 * (docs/plans/tiered-recall-audit-pipeline.md:154, round-2 finding #8) and
 * never built.** Models were asked to cite an id from a map they were never
 * given, so they invented one — and by convention that invention was the file
 * path. This module is the missing half.
 *
 * WHY IT MATTERS (evidence-anchor-path-contract, measured 2026-07-17): the
 * anchor's path rules lived in `superRefine`, which `z.toJSONSchema()` cannot
 * express, so the provider never enforced them. Models rationally filled the
 * REQUIRED `diffPathId` (4/4 correct) and omitted the OPTIONAL `oldFile`/
 * `newFile` (4/4), and Stage 0 destroyed every finding as `fabricated`. The fix
 * is not to ask harder — it is to stop asking for facts we already own:
 *
 *   | constraint                    | JSON Schema | provider enforces |
 *   |-------------------------------|-------------|-------------------|
 *   | required / type / **enum**     | yes         | **yes**           |
 *   | cross-field (`superRefine`)    | no          | **no** (ignored)  |
 *
 * So the model cites an `id` from an enum of the files actually in this diff,
 * and we derive `oldFile`/`newFile`/`fileStatus` from our own map. The path
 * contract moves from row 2 to row 1.
 *
 * **The enum is a funnel, never a trust boundary** (plan D6). Provider
 * enforcement is precisely what this bug proved cannot be relied on;
 * `prepareCandidates` `safeParse`s every response regardless.
 *
 * Pure: no filesystem, no network, no clock. The caller supplies the
 * already-filtered, already-redacted diff text.
 */
import { parseAllDiffSections } from './evidence-triage.mjs';

/**
 * Budgets (plan §8/§8a). The enum, prompt table, and request grow with the
 * diff, and the enum is the mechanism the correctness rides on — so an
 * over-budget diff FAILS LOUD rather than silently truncating (which would
 * make valid changed files unauditable while reporting success — the exact
 * anti-green class this plan exists to kill) and rather than partitioning
 * (deferred: no current requirement, and it changes recall — see §8a).
 *
 * Values are v1 bootstrap ceilings, deliberately conservative, to be
 * recalibrated against the lowest supported provider — same convention and
 * same honesty as `oss-call-policy.json`'s own `calibrationNote`.
 */
export const DIFF_PATH_MAP_BUDGETS = Object.freeze({
  maxMapEntries: 200,
  maxPromptTableBytes: 32_000,
  calibrationNote: 'v1 bootstrap. Recalibrate against the lowest supported provider once a real diff trips discovery_map_exceeds_budget.',
});

/** Zero-padded ordinal id. Opaque BY DESIGN (plan D7). */
const mintId = (i) => `f${String(i + 1).padStart(4, '0')}`;

/**
 * Build the per-run diff-path map.
 *
 * Ids are **opaque ordinals** (`f0001`, `f0002`, …) assigned in diff-header
 * order — never paths (plan D7). Path-as-id would preserve the very convention
 * that hid this bug, and it cannot represent a rename/copy at all, where
 * `oldPath !== newPath` and one path is not an identity. The returned
 * `entries` array is the SOLE source for both the prompt table and the enum,
 * so the two cannot drift.
 *
 * Three-way result (plan §7j, Gemini R2/H5) — semantic absence and invalid
 * input are DIFFERENT states and must never share a status. Collapsing them
 * would let a broken input read as an ordinary empty scope, recreating the
 * anti-green class under a new name:
 *
 *   - `ready`   — ≥1 eligible file.
 *   - `empty`   — well-formed input that legitimately contains no eligible
 *                 files (empty diff, or all filtered out upstream). NOTE:
 *                 `z.enum([])` is not constructible, so the caller MUST handle
 *                 this before building any schema.
 *   - `invalid` — input that is not a parseable unified diff. Non-empty input
 *                 yielding zero sections is `invalid`, NOT `empty`: a parser
 *                 that finds no `diff --git` header in non-whitespace input has
 *                 FAILED, not found nothing.
 *
 * @param {string} diffText - already sensitive-path-filtered AND redacted by the caller.
 * @param {{maxMapEntries?: number}} [budgets]
 * @returns {{kind:'ready', entries: Array<{id:string, oldPath:string, newPath:string, fileStatus:string}>}
 *   | {kind:'empty', reason:'no_eligible_diff_files'}
 *   | {kind:'invalid', reason:'malformed_diff_header'|'parser_threw'|'discovery_map_exceeds_budget', detail?:string}}
 */
export function buildDiffPathMap(diffText, budgets = DIFF_PATH_MAP_BUDGETS) {
  const raw = diffText == null ? '' : String(diffText);
  // Genuinely empty (or whitespace-only) input is a legitimate no-op.
  if (raw.trim() === '') return { kind: 'empty', reason: 'no_eligible_diff_files' };

  let sections;
  try {
    sections = parseAllDiffSections(raw);
  } catch (err) {
    // The parser is total today, but a throw must degrade to a NAMED invalid
    // rather than escape and read as a generator crash.
    return { kind: 'invalid', reason: 'parser_threw', detail: err?.message ?? 'unknown' };
  }

  // Non-empty input that parses to nothing = a failed parse, not an empty scope.
  if (sections.length === 0) {
    return { kind: 'invalid', reason: 'malformed_diff_header', detail: 'no `diff --git` header found in non-empty input' };
  }

  const max = budgets?.maxMapEntries ?? DIFF_PATH_MAP_BUDGETS.maxMapEntries;
  if (sections.length > max) {
    // Loud, named, and NOT truncated (§8a). The caller treats this as a
    // required-generator failure and falls back to legacy — an over-budget
    // diff is simply not audited by the tiered path, and says so.
    return {
      kind: 'invalid',
      reason: 'discovery_map_exceeds_budget',
      detail: `${sections.length} eligible files exceeds maxMapEntries=${max}; not truncated (truncation would make changed files silently unauditable)`,
    };
  }

  return {
    kind: 'ready',
    entries: sections.map((s, i) => ({
      id: mintId(i), oldPath: s.oldPath, newPath: s.newPath, fileStatus: s.fileStatus,
    })),
  };
}

/**
 * Render the map as the prompt table the generator sees. Built from the SAME
 * `entries` array the enum is built from (D7) so they cannot disagree.
 * @param {Array<object>} entries
 * @returns {string}
 */
export function renderDiffPathTable(entries) {
  const rows = entries.map((e) => (e.oldPath === e.newPath
    ? `${e.id}\t${e.fileStatus}\t${e.newPath}`
    : `${e.id}\t${e.fileStatus}\t${e.oldPath} -> ${e.newPath}`));
  return ['id\tstatus\tpath', ...rows].join('\n');
}

/**
 * `side` legality per DERIVED `fileStatus` (plan D2a, Gemini R2/G1).
 *
 * Deriving `fileStatus` does NOT make every shape failure unreachable: `side`
 * stays a model claim, and `EvidenceAnchorSchema`'s side↔fileStatus rules still
 * bite. A model citing `side:'base'` on a file the map says is `added` would,
 * if blindly merged, build an internally contradictory anchor that fails Gate A
 * as `malformed` — misattributing a model claim the diff DISPROVES as OUR
 * contract bug, the exact error this whole plan exists to fix.
 *
 * `side` is VALIDATED, not derived, because for the common case it is a real
 * choice (which side the quote is on). Only added/deleted determine it — and
 * there a conflict is definitive.
 */
const LEGAL_SIDES = Object.freeze({
  added: ['head'],   // an added file has no base-side content to cite
  deleted: ['base'], // a deleted file has none on the head side
  modified: ['base', 'head'],
  renamed: ['base', 'head'],
  copied: ['base', 'head'],
});

/**
 * Hydrate ONE producer anchor against the map. Pure; never throws.
 * @returns {{ok:true, anchor:object} | {ok:false, status:'malformed'|'contradicted', reasonDetail:string}}
 */
function hydrateAnchor(producerAnchor, byId, headSha) {
  if (!producerAnchor || typeof producerAnchor !== 'object') {
    return { ok: false, status: 'malformed', reasonDetail: 'anchor is not an object' };
  }
  const entry = byId.get(producerAnchor.diffPathId);
  if (!entry) {
    // The enum should have prevented this — but the enum is a funnel, not a
    // trust boundary (D6). An unknown id is OUR contract not holding, not the
    // model disproving itself: `malformed`.
    return { ok: false, status: 'malformed', reasonDetail: `unknown diffPathId '${producerAnchor.diffPathId}'` };
  }
  const legal = LEGAL_SIDES[entry.fileStatus] ?? ['base', 'head'];
  if (!legal.includes(producerAnchor.side)) {
    return {
      ok: false, status: 'contradicted',
      reasonDetail: `side='${producerAnchor.side}' is impossible for a '${entry.fileStatus}' file (diff says so)`,
    };
  }
  return {
    ok: true,
    anchor: {
      diffPathId: entry.id,
      // DERIVED from our own map — never model-supplied (D1).
      oldFile: entry.fileStatus === 'added' ? null : entry.oldPath,
      newFile: entry.fileStatus === 'deleted' ? null : entry.newPath,
      fileStatus: entry.fileStatus,
      // Model-supplied, validated above.
      side: producerAnchor.side,
      startLine: producerAnchor.startLine,
      endLine: producerAnchor.endLine,
      quote: producerAnchor.quote,
      symbolName: producerAnchor.symbolName ?? null,
      headSha,
    },
  };
}

/**
 * The single seam between an untrusted provider response and Stage 0
 * (plan §7g, R2/H6).
 *
 * Takes `unknown`, `safeParse`s the producer DTO BEFORE touching any field,
 * and returns a discriminated result PER FINDING. One malformed candidate
 * degrades ITSELF, never the batch — a throw here would lose every finding in
 * the response, which is how a contract bug becomes a total outage.
 *
 * `rawIndex` is the identity tying a malformed result back to its raw provider
 * finding (never a fingerprint — a malformed finding may not be fingerprintable),
 * so the plan's raw-level accounting invariant is checkable and telemetry can
 * name WHICH candidate failed.
 *
 * **THREE kinds, not two** (§7a; caught in Phase 6 review): a side conflict is
 * `contradicted` — a model claim the diff DISPROVES — and must NEVER be folded
 * into `malformed`, which means OUR contract could not parse the claim. They
 * have opposite owners. Returning one kind with a differing `reasonCode` let
 * the pipeline's raw counter bill a disproved model claim as our own contract
 * bug: the exact misattribution this entire plan exists to fix, inverted. The
 * kind IS the attribution; a reasonCode is not a substitute for it.
 *
 * @param {unknown} rawFindings
 * @param {{kind:string, entries?: Array<object>}} map - a `ready` map
 * @param {{producerSchema: import('zod').ZodType, headSha?: string}} opts
 * @returns {Array<{kind:'ready', rawIndex:number, finding:object}
 *   | {kind:'malformed', rawIndex:number, reasonCode:string, reasonDetail:string}
 *   | {kind:'contradicted', rawIndex:number, reasonCode:string, reasonDetail:string}>}
 */
export function prepareCandidates(rawFindings, map, opts) {
  if (map?.kind !== 'ready') {
    throw new Error(`prepareCandidates: map must be {kind:'ready'} — got '${map?.kind}'. The caller must handle empty/invalid BEFORE generation (§7j).`);
  }
  if (!Array.isArray(rawFindings)) return [];
  const byId = new Map(map.entries.map((e) => [e.id, e]));
  const headSha = opts?.headSha ?? 'WORKTREE';

  return rawFindings.map((raw, rawIndex) => {
    const parsed = opts.producerSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        kind: 'malformed', rawIndex, reasonCode: 'producer_dto_invalid',
        reasonDetail: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      };
    }
    const f = parsed.data;
    const field = f.evidenceType === 'omission' ? 'triggerAnchor' : 'anchor';
    const h = hydrateAnchor(f[field], byId, headSha);
    if (!h.ok) {
      // The KIND carries the attribution, never just the reasonCode:
      //   contradicted -> the diff disproves the model's `side` claim  (model's fault)
      //   malformed    -> our contract couldn't parse/resolve the claim (ours)
      return h.status === 'contradicted'
        ? { kind: 'contradicted', rawIndex, reasonCode: 'producer_side_contradicted', reasonDetail: h.reasonDetail }
        : { kind: 'malformed', rawIndex, reasonCode: 'producer_anchor_malformed', reasonDetail: h.reasonDetail };
    }
    return { kind: 'ready', rawIndex, finding: { ...f, [field]: h.anchor } };
  });
}
