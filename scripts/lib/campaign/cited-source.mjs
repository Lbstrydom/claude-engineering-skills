/**
 * @fileoverview Cited-source windowing — `centredWindow`, `citedLineOf`,
 * `resolveCitedSources` (D2).
 *
 * Moved verbatim from `scripts/campaign.mjs` (plan: comparison-tooling-
 * consolidation.md, Phase 3). Per D2a: may import `lib/comparison/paths.mjs`
 * (plus the general shared-lib primitives it already used — `finding-match`,
 * `vcs`); must NOT import any `scripts/*.mjs` entry point.
 *
 * @module scripts/lib/campaign/cited-source
 */
import { affectedFilesOf } from '../finding-match.mjs';
import { gitShowFileAtRevision, gitBlobSizeAtRevision } from '../vcs.mjs';
import { assertGitPathAdmissible } from '../comparison/paths.mjs';

/** Lines of a cited file handed to the adjudicator, CENTRED on the cited range. */
export const CITED_SOURCE_WINDOW_LINES = 240;
/** Cited files per row. Beyond this the prompt stops being evidence and becomes noise. */
export const CITED_SOURCE_MAX_FILES = 4;
/**
 * Character ceiling per cited file. A LINE budget is not a byte budget: 240
 * lines of a minified or generated file is megabytes, and the whole excerpt is
 * paid for on a spend-bearing call. Both bounds apply, and whichever binds
 * first sets `truncated`.
 */
export const CITED_SOURCE_MAX_CHARS = 24000;
/**
 * Largest blob worth READING to produce a `CITED_SOURCE_MAX_CHARS` excerpt.
 * Two orders of magnitude of headroom over the excerpt itself: a source file
 * this large is a generated artifact, and citing it tells an adjudicator
 * nothing that the excerpt budget would have preserved anyway.
 */
export const CITED_SOURCE_MAX_BYTES = 1024 * 1024;
/**
 * Non-contiguous spans of ONE file handed to the adjudicator. See
 * `planWindows` for the measurement behind the number — and note that the
 * per-file line and character budgets are DIVIDED across them, so this raises
 * coverage without raising spend.
 */
export const CITED_SOURCE_MAX_WINDOWS = 3;
/** Occurrences of a single anchor term that may become window centres. */
export const ANCHOR_OCCURRENCES_PER_TERM = 2;

/**
 * A window of `content` centred on `line`, or the head when there is no anchor.
 *
 * **Centred, not head-truncated, and this is load-bearing.** If an arm
 * correctly finds a defect at line 800 of a file truncated at line 500, the
 * adjudicator sees a resolved file WITHOUT the defect and reports it absent —
 * penalising the arm for being right. Centring normally keeps the relevant span
 * present; the `truncated` flag is the second half of the mitigation, and the
 * prompt turns it into a hard rule (a defect not visible in the shown span is
 * `unverifiable`, never `verified` with outcome `dismissed`).
 *
 * @param {string} content
 * @param {number|null} line - 1-indexed
 * @param {number} [windowLines]
 * @param {number} [maxChars]
 */
export function centredWindow(content, line, windowLines = CITED_SOURCE_WINDOW_LINES, maxChars = CITED_SOURCE_MAX_CHARS) {
  // An exported function documenting a HARD ceiling has to survive the numbers
  // it is handed. `NaN`, `Infinity`, 0 and negatives all defeat the comparisons
  // below silently — `text.length <= NaN` is false, `slice(0, NaN)` is empty —
  // so a caller could disable the bound by passing a value that merely looks
  // numeric. Coerced to a sane positive integer rather than thrown on: this sits
  // on a spend-bearing path, and a bounded excerpt is always the safe answer.
  const safeInt = (v, fallback) => (Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback);
  windowLines = safeInt(windowLines, CITED_SOURCE_WINDOW_LINES);
  maxChars = safeInt(maxChars, CITED_SOURCE_MAX_CHARS);
  const lines = String(content ?? '').split('\n');
  const clampChars = (text, startLine, endLine, alreadyTruncated) => {
    if (text.length <= maxChars) return { text, startLine, endLine, truncated: alreadyTruncated };
    // Trim whole lines from the tail so the excerpt stays syntactically
    // readable and `endLine` keeps meaning what it says.
    const kept = [];
    let used = 0;
    for (const l of text.split('\n')) {
      if (used + l.length + 1 > maxChars) break;
      kept.push(l);
      used += l.length + 1;
    }
    if (kept.length === 0) {
      // A SINGLE line longer than the whole budget. An earlier version kept it
      // whole (`&& kept.length > 0` on the break), so one minified or generated
      // line bypassed the ceiling entirely and the "hard limit" was not a limit
      // at all — measured at 500,000 characters through a 24,000 budget. Whole
      // lines are the preference, not the guarantee: when even one does not
      // fit, the character bound wins and the line is cut.
      //
      // The marker is paid for out of the budget, not added on top of it. The
      // first version appended it AFTER slicing to `maxChars`, so the returned
      // excerpt was `maxChars + marker.length` — a ceiling its own enforcement
      // path exceeded, which is the same "a limit with an exception is not a
      // limit" defect one layer in.
      // Sliced UNCONDITIONALLY at the end, not merely given room. Reserving
      // `maxChars - marker.length` still overflows when the marker is itself
      // longer than the whole budget: `room` clamps to 0 and the marker is
      // appended anyway, so the result is `marker.length` characters against a
      // smaller ceiling. Two rounds of this bound were "almost" hard. A final
      // slice makes the guarantee unconditional for every `maxChars`, including
      // the degenerate ones an exported function must survive being handed.
      const marker = `\n[…truncated: single line exceeds the ${maxChars}-character budget]`;
      const room = Math.max(0, maxChars - marker.length);
      const body = `${text.slice(0, room)}${marker}`.slice(0, maxChars);
      return { text: body, startLine, endLine: startLine, truncated: true };
    }
    return { text: kept.join('\n'), startLine, endLine: startLine + kept.length - 1, truncated: true };
  };

  if (lines.length <= windowLines) {
    return clampChars(lines.join('\n'), 1, lines.length, false);
  }
  const half = Math.floor(windowLines / 2);
  const centre = Number.isInteger(line) && line > 0 ? line : half + 1;
  let start = Math.max(1, centre - half);
  let end = Math.min(lines.length, start + windowLines - 1);
  start = Math.max(1, end - windowLines + 1);
  return clampChars(lines.slice(start - 1, end).join('\n'), start, end, true);
}

/** First 1-indexed line number a `path:line` reference carries, or null. */
export function citedLineOf(section) {
  const m = /:(\d+)/.exec(String(section ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Identifier-shaped anchors a finding's prose names, most specific first.
 *
 * **This exists because the cited line is, in practice, always absent.**
 * Measured against the live store 2026-08-10: `audit_findings.primary_file`
 * carries a `:line` suffix in **0 of 3993** rows, because `recordFindings`
 * stores `f._primaryFile || f.section` and the resolved bare path wins whenever
 * it is set. So `citedLineOf` returns null on every real row, `centredWindow`
 * degrades to a HEAD window, and the centring mitigation above — which the
 * plan calls load-bearing — was inert on every production path while passing a
 * test that supplied a synthetic `section` carrying a line.
 *
 * A mitigation whose precondition never holds is worse than none: it reads as
 * covered. Rather than document the hole, the anchor is recovered from the one
 * place the information survives — the finding's own prose, which names the
 * symbol it is about. Backticked spans first (a deliberate citation), then
 * dotted/qualified identifiers, then bare camel/snake identifiers long enough
 * not to match ordinary words.
 *
 * Bounded and side-effect-free: at most `limit` candidates, each matched
 * literally against the file. When none matches, the window is honestly a head
 * window with `truncated: true`, and the prompt's rule turns that into
 * `unverifiable` rather than a false dismissal.
 */
export function detailAnchors(detail, limit = 8) {
  const text = String(detail ?? '');
  const out = [];
  const seen = new Set();
  const add = (t) => {
    const v = String(t ?? '').trim();
    if (v.length < 4 || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  for (const m of text.matchAll(/`([^`\n]{4,80})`/g)) add(m[1]);
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\b/g)) add(m[1]);
  for (const m of text.matchAll(/\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) add(m[1]);
  return out.slice(0, limit);
}

/**
 * Anchors recovered from a `§`-section citation, for the plan-document fallback.
 *
 * A plan-mode finding's `primary_file` is not a path — it is a section
 * reference like `"§2 Envelope budget (deterministic truncation order) vs. §2
 * KD-3"`. Two shapes, most specific first: a backticked span (a deliberate
 * quotation), then the title phrase that follows the `§` marker.
 *
 * **The bare `§N` marker is deliberately NOT an anchor**, and it was dead code
 * for a while pretending to be one — `§2` is two characters and the 3-character
 * floor below silently dropped it, so every measurement here was taken without
 * it. Enabling it is worse than removing it: a plan document cross-references
 * its own sections constantly, so `§2` matches in 80 of the 89 rows but almost
 * always on a *reference* to the section rather than the section itself, and
 * because it is tried before the title phrase it would PREEMPT the anchor that
 * lands on the real heading. It rescues 6 rows that nothing else anchors, and
 * all 6 cite the audit transcript, where a head window is the honest answer.
 *
 * Measured over cohort `e52eec728688fcab` (2026-08-19), on the 107 rows that
 * resolved nothing: prose anchors land 78, these add **12 more**, and the
 * remaining 17 cite the audit TRANSCRIPT rather than the plan — genuinely
 * unanchorable in the document, and correctly left as a head window whose
 * `truncated: true` the prompt turns into `unverifiable`.
 *
 * **Single-quoted spans were tried and REJECTED.** The live sections do use
 * them (`"§2 Envelope budget ('full is explicitly exempt…')"`), but adding
 * `'…'` to the extractor moved exactly ONE row of 201 out of the head bucket,
 * while an apostrophe in ordinary prose ("the plan's rule, and the reviewer's")
 * yields a 4–80 character span that anchors the window on an unrelated line.
 * A confidently WRONG anchor is worse than a head window: the prompt's
 * `truncated` rule catches the head case and cannot catch the other. Don't
 * re-propose it without a measurement that beats 1/201.
 */
export function sectionAnchors(section, limit = 8) {
  const text = String(section ?? '');
  const out = [];
  const seen = new Set();
  const add = (t) => {
    const v = String(t ?? '').trim();
    if (v.length < 3 || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  for (const m of text.matchAll(/`([^`\n]{4,80})`/g)) add(m[1]);
  for (const m of text.matchAll(/§\s*[\w.]+\s+([A-Za-z][^;(—]{3,50})/g)) add(m[1]);
  return out.slice(0, limit);
}

/**
 * Spellings of a plan document to try, in order.
 *
 * `audit_runs.plan_file` is whatever the operator passed to the audit, and it
 * is not normalised on the way in: this cohort holds both
 * `docs/plans/comparison-tooling-consolidation.md` and the bare
 * `event-wiring-symmetry.md` (11 rows). A bare basename is resolved under
 * `docs/plans/` — the repo's one plan directory — and never guessed more
 * widely than that.
 */
export function planDocumentCandidates(planFile) {
  const raw = String(planFile ?? '').trim().replace(/\\/g, '/');
  if (!raw || !raw.endsWith('.md')) return [];
  return raw.includes('/') ? [raw] : [raw, `docs/plans/${raw}`];
}

/**
 * The 1-indexed line an anchor first occurs on, or null.
 * Anchors are matched as LITERAL text, never compiled into a regex — a finding's
 * prose is model-authored and reaches this function unvalidated.
 */
export function anchorLine(content, anchors) {
  return anchorHits(content, anchors, 1)[0] ?? null;
}

/**
 * EVERY line an anchor occurs on, in anchor-priority order, bounded.
 *
 * `anchorLine` answers "where is the one best span", which is the wrong
 * question for two shapes of finding that both showed up in the field:
 *
 * - a claim comparing TWO sections of one document ("§1 D1b vs §8 promotion
 *   matrix"), and
 * - a claim about a REPEATED span — the case that exposed this: a finding
 *   about a duplicated `#### D7e` heading, whose two occurrences sit at lines
 *   1755 and 1875 of the plan. The single window centred on the first spanned
 *   1635–1874 and missed the second **by one line**, and the adjudicator said
 *   so: *"Only ONE '#### D7e' heading is visible in the cited span."*
 *
 * `perTerm` is the bound that keeps this from exploding: a common identifier
 * occurs dozens of times in a large file, and every occurrence is a candidate
 * window centre. Two per term is enough to express "this appears more than
 * once" without turning one finding into a document dump.
 */
export function anchorHits(content, anchors, perTerm = ANCHOR_OCCURRENCES_PER_TERM) {
  const lines = String(content ?? '').split('\n');
  const out = [];
  const seenLines = new Set();
  for (const anchor of anchors || []) {
    let found = 0;
    for (let i = 0; i < lines.length && found < perTerm; i += 1) {
      if (!lines[i].includes(anchor)) continue;
      found += 1;
      // One line is one candidate centre however many anchors name it —
      // otherwise two anchors on the same line would claim two windows and
      // halve the budget for a span already covered once.
      if (seenLines.has(i + 1)) continue;
      seenLines.add(i + 1);
      out.push({ line: i + 1, anchor });
    }
  }
  return out;
}

/**
 * Group hits that can SHARE one window, most-important cluster first.
 *
 * This is the half that costs nothing: two occurrences 120 lines apart do not
 * need two windows, they need one window centred BETWEEN them. On the D7e case
 * that is the whole fix — 1755 and 1875 become a single span 1695–1934, at the
 * same spend as the window that missed one of them.
 *
 * Ranked by the priority of the best hit in each cluster (anchor order, so a
 * backticked quotation outranks a section title), never by position: when the
 * window cap bites, the cluster that gets dropped must be the least deliberate
 * citation, not the one furthest down the file.
 */
export function clusterAnchorHits(hits, windowLines) {
  const priority = new Map();
  const anchorAt = new Map();
  (hits || []).forEach((h, i) => {
    if (priority.has(h.line)) return;
    priority.set(h.line, i);
    anchorAt.set(h.line, h.anchor);
  });
  const clusters = [];
  for (const h of [...(hits || [])].sort((a, b) => a.line - b.line)) {
    const last = clusters[clusters.length - 1];
    // `< windowLines`, measured from the cluster's FIRST line: a cluster must
    // fit inside one window, so it is bounded by its span, not by the gap
    // between neighbours (which would let a chain of close hits grow without
    // limit and produce a window that contains neither end).
    if (last && h.line - last.min < windowLines) { last.max = h.line; last.lines.push(h.line); }
    else clusters.push({ min: h.line, max: h.line, lines: [h.line] });
  }
  return clusters
    .map((c) => {
      // The cluster REPORTS its best anchor, not its topmost one. A window
      // covering both a section heading and the quoted symbol below it is
      // there because of the quotation; naming the heading (which merely
      // happens to sit at a lower line number) would make `anchorKind` say
      // "section-anchor" for a window a prose anchor earned.
      const best = c.lines.reduce((a, b) => (priority.get(a) <= priority.get(b) ? a : b));
      return { ...c, anchor: anchorAt.get(best), rank: priority.get(best) };
    })
    .sort((a, b) => a.rank - b.rank);
}

/**
 * Decide the window centres for one file, and the budget each window gets.
 *
 * **The per-file budget is DIVIDED, never multiplied.** N windows each get
 * `1/N` of the line and character ceilings, so a file's whole excerpt costs the
 * same whether it is shown as one span or three. That is what makes this safe
 * to turn on for a spend-bearing call over hundreds of rows: measured across
 * cohort `e52eec728688fcab`, average excerpt bytes per row moved 12,281 →
 * 12,459 (+1.4%) while anchor-hit coverage went **73.6% → 89.0%**.
 *
 * Two passes, deliberately. Clustering depends on the window size and the
 * window size depends on the cluster count, so the first pass clusters at the
 * FULL size to learn how many distinct regions the finding names, and the
 * second re-clusters at the size those regions will actually get. Without the
 * second pass a 3-window row clusters at 240 lines and renders at 80, which can
 * centre a window between its own anchors and show neither.
 *
 * The cap is 3. Measured coverage by cap: 1 → 73.6%, 2 → 84.9%, 3 → 89.0%,
 * 4 → 90.1%. The fourth window buys 1.1 points and takes every window down to
 * 60 lines, which is too thin to read a plan section in.
 */
export function planWindows(content, anchors, {
  maxWindows = CITED_SOURCE_MAX_WINDOWS,
  windowLines = CITED_SOURCE_WINDOW_LINES,
  maxChars = CITED_SOURCE_MAX_CHARS,
  perTerm = ANCHOR_OCCURRENCES_PER_TERM,
} = {}) {
  const hits = anchorHits(content, anchors, perTerm);
  if (hits.length === 0) {
    return { count: 1, windowLines, maxChars, centres: [{ line: null, anchor: null }] };
  }
  const coarse = clusterAnchorHits(hits, windowLines);
  const count = Math.min(Math.max(1, coarse.length), Math.max(1, maxWindows));
  const perWindowLines = Math.max(1, Math.floor(windowLines / count));
  const perWindowChars = Math.max(1, Math.floor(maxChars / count));
  const fine = clusterAnchorHits(hits, perWindowLines).slice(0, count);
  return {
    count: fine.length,
    windowLines: perWindowLines,
    maxChars: perWindowChars,
    // Centred on the cluster's MIDPOINT, which is what puts a repeated span's
    // first and last occurrence inside one window.
    centres: fine.map((c) => ({ line: Math.round((c.min + c.max) / 2), anchor: c.anchor })),
  };
}

/**
 * Resolve the files a finding cites, at the snapshot's OWN revision.
 *
 * Paths come from `affectedFilesOf()` — the same union the matcher uses — so a
 * finding naming its file only in prose still resolves. Sensitive paths are
 * refused and MARKED, never read: this is an egress seam like any other, and a
 * path naming a credential store must fail closed rather than be quoted into a
 * provider prompt.
 *
 * **The classification is LEXICAL, deliberately, and this is not the weaker
 * check it looks like.** `resolveAndClassify` answers a question about the
 * WORKING TREE — it realpaths, and reports `resolutionFailed` for anything not
 * on disk right now. But `git show sha:path` reads the object store, not the
 * filesystem: a file deleted since `auditedSha` still resolves (and would have
 * been wrongly forced into the human queue by a working-tree check), while a
 * symlink planted in the working tree cannot redirect the read at all, because
 * there is no filesystem traversal to redirect. So the hazards that make
 * realpath resolution necessary elsewhere do not exist on this seam, and the
 * two that DO — a lexically sensitive name and a path escaping the repo — are
 * exactly what is checked.
 *
 * **Each path gets its OWN anchor.** An earlier draft read one `:line` from the
 * section and applied it to every path the finding named, so a finding citing
 * three files retrieved the right span for at most one of them and confidently
 * wrong spans for the rest. The line is now used only for the path it was
 * attached to; every other path resolves its own anchor from the prose.
 * `anchorKind` records which of the three applied, so a reader is never left
 * guessing whether a head window means "small file" or "found nothing".
 *
 * **`planFile` is the fallback for a finding that cites no path at all** — see
 * the block at the end. Pass the run's `audit_runs.plan_file`; it is used only
 * when nothing else resolved.
 *
 * @param {{section: string, detail?: string, auditedSha: string, planFile?: string|null,
 *          repoRoot?: string, show?: Function, blobSize?: Function}} args
 * @returns {{sources: Array<object>, resolvedAny: boolean}}
 */
export function resolveCitedSources({
  section, detail = '', auditedSha, planFile = null, repoRoot = process.cwd(),
  show = gitShowFileAtRevision, blobSize = gitBlobSizeAtRevision,
}) {
  const paths = affectedFilesOf({ section }).slice(0, CITED_SOURCE_MAX_FILES);
  // A `path:line` reference belongs to THAT path, not to every path named.
  const sectionText = String(section ?? '');
  const lineFor = (p) => {
    const m = new RegExp(`${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(sectionText);
    return m ? Number(m[1]) : null;
  };
  const anchors = detailAnchors(detail);
  const sources = [];
  let resolvedAny = false;

  /**
   * Admit -> bound -> read -> window ONE path. Extracted so the plan-document
   * fallback below cannot become a second read path with its own (drifting)
   * idea of what is admissible or how big is too big.
   *
   * Admission is delegated to `comparison/paths.mjs::resolveGitPath` — the
   * SINGLE resolver for comparison paths (2026-08-14). The two checks that
   * used to sit inline here (a lexical `classifyPath` and an absolute/`..`
   * test) were a second implementation of exactly that policy, and a second
   * implementation is how one of them later misses a case the other learned.
   * The reasoning it preserves: a historical read must NOT be realpath'd,
   * because realpath resolves against the CURRENT filesystem and would refuse a
   * legitimate read whenever a cited file moved after its snapshot.
   *
   * The structured-result contract is unchanged — refusals arrive as
   * `{resolved:false, reason}` rather than throwing, because one bad cited path
   * must not abort the other citations in the same finding. The ADMISSION half
   * only — no git call: this function owns the read via its injectable `show`,
   * and folding a real `git show` into the check would bypass that injection
   * (it did, and seven tests caught it).
   */
  const resolveOne = (p, anchorList, citedLine) => {
    try {
      assertGitPathAdmissible(p, { repoRoot });
    } catch (err) {
      const reason = err?.reason === 'sensitive' ? 'sensitive-path' : 'path-escapes-repo';
      return [{ path: p, resolved: false, reason }];
    }
    // Bound the INPUT, not just the output. The excerpt is capped in lines and
    // characters and the file COUNT is capped, but `show` materialises the whole
    // blob first — so a cited lockfile or bundle was read in full to produce a
    // 24,000-character window. The only ceiling was `spawnSync`'s 20MB
    // `maxBuffer`, an accident of the transport that surfaces as an opaque
    // ENOBUFS rather than a reason an adjudicator can read. `cat-file -s` reads
    // the object header only, so this costs nothing on the paths that pass.
    const size = blobSize(repoRoot, auditedSha, p);
    if (size.ok && size.bytes > CITED_SOURCE_MAX_BYTES) {
      return [{ path: p, resolved: false, reason: 'oversized', bytes: size.bytes, maxBytes: CITED_SOURCE_MAX_BYTES }];
    }
    const res = show(repoRoot, auditedSha, p);
    if (!res.ok) return [{ path: p, resolved: false, reason: res.error?.code ?? 'unreadable' }];

    // A `path:line` citation is an explicit instruction about WHERE to look, so
    // it stays one window and the anchor search is not run at all. Everything
    // else is planned: one window when the finding names one region, up to
    // `CITED_SOURCE_MAX_WINDOWS` when it names more, always inside one file's
    // budget.
    const planned = citedLine == null
      ? planWindows(res.content, anchorList)
      : { count: 1, windowLines: CITED_SOURCE_WINDOW_LINES, maxChars: CITED_SOURCE_MAX_CHARS, centres: [{ line: citedLine, anchor: null }] };

    return planned.centres.map((c, i) => {
      const win = centredWindow(res.content, c.line, planned.windowLines, planned.maxChars);
      return {
        path: p, sha: auditedSha, resolved: true,
        startLine: win.startLine, endLine: win.endLine, truncated: win.truncated,
        anchorKind: citedLine != null ? 'cited-line' : (c.anchor ? 'detail-anchor' : 'head'),
        anchor: c.anchor ?? null,
        // Stated, not inferred: two entries with the same path are excerpts of
        // ONE file, and an adjudicator that read them as separate files (or as
        // a contradiction) would answer the wrong question.
        windowIndex: i + 1, windowCount: planned.centres.length,
        content: win.text,
      };
    });
  };

  for (const p of paths) {
    for (const src of resolveOne(p, anchors, lineFor(p))) {
      if (src.resolved) resolvedAny = true;
      sources.push(src);
    }
  }

  // ── The plan-document fallback ────────────────────────────────────────────
  //
  // A plan-mode finding cites a `§`-section, not a path, so the loop above
  // resolved nothing and the row was handed to a human having never reached the
  // adjudicator: 89 of 201 findings in cohort `e52eec728688fcab`, 60% of
  // everything in that campaign's human queue. The document IS retrievable —
  // `audit_runs.plan_file` at the snapshot's own sha, readable for 89/89 —
  // it simply was not being asked for.
  //
  // A FALLBACK, not an addition: a finding that already resolved its own
  // sources does not also drag in a 1668-line plan document, which would be
  // spend and noise. Nothing that resolves today changes.
  //
  // It goes through the same admission → size → read → window pipeline as any
  // other citation (`resolveOne`), so the sensitive-path refusal, the byte
  // ceiling and the injectable `show` all apply unchanged — a second read path
  // here is exactly how one of them would later miss a case the other learned.
  //
  // Not redacted, like every other cited source: the document at that sha is a
  // property of the SNAPSHOT, identical whichever arm cited it, so it carries
  // no signal about which arm raised the finding. (That is the same test the
  // `section` field failed — there the prose was model-authored per finding.
  // This is a committed repo artifact.)
  if (!resolvedAny && planFile) {
    // Detail anchors FIRST, section anchors second — that is the measured
    // order: over the 89 rows, prose anchors land 65 and the section reference
    // adds 18. `anchorLine` tries them in order, so the more specific quotation
    // wins whenever the finding made one.
    const fromSection = sectionAnchors(section);
    const planAnchors = [...anchors, ...fromSection];
    const candidates = planDocumentCandidates(planFile);
    let lastRefusal = null;
    for (const cand of candidates) {
      const windows = resolveOne(cand, planAnchors, null);
      if (windows.some((w) => w.resolved)) {
        resolvedAny = true;
        lastRefusal = null;
        for (const src of windows) {
          // `anchorKind` claims WHICH anchor applied, so a section hit must not
          // report itself as a prose hit — the field would stop being an answer
          // and become a guess. Detail anchors win ties: they are tried first.
          const kindOfAnchor = src.anchor == null ? src.anchorKind
            : (anchors.includes(src.anchor) ? 'detail-anchor' : 'section-anchor');
          sources.push({ ...src, anchorKind: kindOfAnchor, kind: 'plan-document' });
        }
        break;
      }
      lastRefusal = windows[0];
    }
    // Only the LAST candidate's refusal is reported: an intermediate miss is how
    // the bare-basename spelling gets discovered, not a fault worth surfacing.
    if (lastRefusal) sources.push({ ...lastRefusal, kind: 'plan-document' });
  }
  return { sources, resolvedAny };
}
