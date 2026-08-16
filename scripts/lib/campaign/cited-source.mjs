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
 * The 1-indexed line an anchor first occurs on, or null.
 * Anchors are matched as LITERAL text, never compiled into a regex — a finding's
 * prose is model-authored and reaches this function unvalidated.
 */
export function anchorLine(content, anchors) {
  const lines = String(content ?? '').split('\n');
  for (const anchor of anchors || []) {
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(anchor)) return { line: i + 1, anchor };
    }
  }
  return null;
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
 * @returns {{sources: Array<object>, resolvedAny: boolean}}
 */
export function resolveCitedSources({
  section, detail = '', auditedSha, repoRoot = process.cwd(),
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
  for (const p of paths) {
    // Admission is delegated to `comparison/paths.mjs::resolveGitPath` — the
    // SINGLE resolver for comparison paths (2026-08-14). The two checks that
    // used to sit inline here (a lexical `classifyPath` and an
    // absolute/`..` test) were a second implementation of exactly that policy,
    // and a second implementation is how one of them later misses a case the
    // other learned. The reasoning that was in this block is preserved in that
    // module: a historical read must NOT be realpath'd, because realpath
    // resolves against the CURRENT filesystem and would refuse a legitimate
    // read whenever a cited file moved after its snapshot.
    //
    // The structured-result contract is unchanged — refusals still arrive as
    // `{resolved:false, reason}` rather than throwing, because one bad cited
    // path must not abort the other citations in the same finding.
    // The ADMISSION half only — no git call. This function owns the read via
    // its injectable `show`, and folding a real `git show` into the check would
    // bypass that injection (it did, and seven tests caught it).
    try {
      assertGitPathAdmissible(p, { repoRoot });
    } catch (err) {
      const reason = err?.reason === 'sensitive' ? 'sensitive-path' : 'path-escapes-repo';
      sources.push({ path: p, resolved: false, reason });
      continue;
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
      sources.push({
        path: p, resolved: false, reason: 'oversized',
        bytes: size.bytes, maxBytes: CITED_SOURCE_MAX_BYTES,
      });
      continue;
    }
    const res = show(repoRoot, auditedSha, p);
    if (!res.ok) {
      sources.push({ path: p, resolved: false, reason: res.error?.code ?? 'unreadable' });
      continue;
    }
    const cited = lineFor(p);
    const found = cited == null ? anchorLine(res.content, anchors) : null;
    const line = cited ?? found?.line ?? null;
    const win = centredWindow(res.content, line);
    resolvedAny = true;
    sources.push({
      path: p, sha: auditedSha, resolved: true,
      startLine: win.startLine, endLine: win.endLine, truncated: win.truncated,
      anchorKind: cited != null ? 'cited-line' : (found ? 'detail-anchor' : 'head'),
      anchor: found?.anchor ?? null,
      content: win.text,
    });
  }
  return { sources, resolvedAny };
}
