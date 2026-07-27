/**
 * @fileoverview Stage 0 — deterministic evidence triage for the tiered-recall
 * audit pipeline. Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 3;
 * restructured into a fact/relevance split by
 * docs/plans/stage0-evidence-relevance-split.md — the discovery generator
 * (`tiered-pipeline.mjs`) is prompted with FULL current file content, not
 * diff-scoped content, so a real finding about pre-existing (unchanged) code
 * legitimately lives outside any diff hunk. The original single-gate design
 * (`verifyAnchor`, hunk-only) treated "outside a hunk" as "fabricated" —
 * this file now splits that into two sequential gates:
 *
 *   Gate A (`resolveAnchorLocation`) — is this quote REAL? Tries the hunk
 *   first (delegates to the unchanged `quoteAppearsOnSide`/`verifyAnchor`),
 *   then falls back to a line-indexed search of the current working-tree
 *   file content (`headContent`, supplied by the caller's
 *   `headContentAdapter` — this file stays I/O-free).
 *
 *   Gate B (`tagPreExisting`, reused unmodified) — for a quote found outside
 *   a hunk, does the shipped change depend on it? Diff-derived line mapping
 *   (`mapHeadLineToBase`) locates the quote's corresponding BASE-revision
 *   position (never by raw line-number equality across revisions — an
 *   earlier hunk shifts every later line number); `blameAdapter`/
 *   `impactAdapter` (both caller-injected) answer pre-existence + impact-
 *   independence against that exact, occurrence-specific location.
 *
 * `resolveAnchorLocation`, `mapHeadLineToBase`, and `tagPreExisting` are
 * PURE — no I/O, no VCS access — so they're directly unit-testable
 * (Tier 1). `runStage0EvidenceTriage` is the orchestration entry point that
 * supplies real diff text / file content / git-derived adapters, per the
 * plan's design.
 *
 * @module scripts/lib/audit/evidence-triage
 */

import { EvidenceAnchorSchema } from '../schemas.mjs';
import { promoteAlternative } from './candidate-envelope.mjs';
import { nowIso } from './time-utils.mjs';
import { normalizeWhitespace } from '../text-normalize.mjs';

/**
 * Extract the per-file section of a unified diff (from its `diff --git`
 * header to the next one, or end of string). Returns `null` if the file
 * isn't mentioned in the diff at all.
 *
 * PRE-EXISTING function (predates the Stage 0 relevance-split restructure —
 * `verifyAnchor` has always used it); `resolveAnchorLocation` (Gate A) also
 * calls it, a genuine load-bearing dependency. Path resolution is delegated
 * to `parseAllDiffSections` → `resolveHeaderPaths`, which parses Git's full
 * C-style quoted-path grammar (docs/plans/refactor-evidence-integrity.md) —
 * the narrower unquoted/quoted-space-only regex this docblock used to
 * describe as accepted debt is gone. A header whose paths cannot be
 * unambiguously resolved becomes a `pathDecodeFailed` section (`oldPath`/
 * `newPath: null`), which this function still safely treats as "not this
 * file" (never a false match) — see `parseAllDiffSections` for the loud,
 * named failure that produces.
 *
 * @param {string} diffText
 * @param {string} filePath - either the old or new path
 * @returns {{section: string, fileStatus: 'modified'|'added'|'deleted'|'renamed'|'copied'} | null}
 */
function extractFileDiffSection(diffText, filePath) {
  if (!diffText || !filePath) return null;
  // Thin filter over the shared parser (evidence-anchor-path-contract §7i).
  // Contract, return shape, and failure direction are BYTE-IDENTICAL to the
  // pre-refactor implementation — this file's existing tests are the pin.
  for (const s of parseAllDiffSections(diffText)) {
    if (s.oldPath !== filePath && s.newPath !== filePath) continue;
    return { section: s.section, fileStatus: s.fileStatus, oldPath: s.oldPath, newPath: s.newPath };
  }
  return null;
}

/**
 * Decode a single Git diff-header path token: `token` is either an unquoted
 * literal path (git never escapes anything outside quotes) or a
 * self-delimited C-style-quoted token (the caller has already located the
 * closing UNESCAPED `"` — this function only strips and decodes).
 *
 * Bytes, then ONE UTF-8 decode (docs/plans/refactor-evidence-integrity.md
 * §4.1) — `\303\251` is a two-byte UTF-8 sequence for `é`; decoding octal
 * escapes one JS character at a time (`String.fromCharCode(parseInt(o,8))`)
 * produces mojibake (`Ã©`), not the real path. So every escape — literal
 * character or octal — is accumulated into a raw byte buffer, and the WHOLE
 * buffer is UTF-8-decoded once at the end.
 *
 * Fail-closed (`null`), never a half-decoded string (INC-001's lesson: never
 * "I couldn't classify it so I'll allow it"): a malformed escape, an
 * embedded NUL, an invalid UTF-8 sequence, or ANY loss between the decoded
 * string and its own re-encoding (the identity check) all return `null`.
 * `ignoreBOM: true` is load-bearing, not defensive filler: WHATWG
 * `TextDecoder` strips a leading BOM by default, which would silently change
 * a path legitimately beginning with U+FEFF — reachable specifically via a
 * `rename from`/`rename to` token, which (unlike a `diff --git` header
 * token) carries no `a/`/`b/` prefix, so the BOM really can sit at byte 0.
 *
 * @param {string} token
 * @returns {string | null}
 */
const GIT_QUOTE_SIMPLE_ESCAPES = Object.freeze({
  a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b, '\\': 0x5c, '"': 0x22,
});

export function unquoteGitPath(token) {
  if (typeof token !== 'string' || !token.startsWith('"')) return token;
  // Verify the token is genuinely well-formed BEFORE trusting `slice(1, -1)`
  // (round-1 code-audit M5): the docblock's precondition ("caller has
  // already located the closing unescaped quote") holds for Rule 1's
  // `readQuotedHeaderToken`-validated tokens, but Rule 2's rename/copy path
  // hands over a raw line slice with no such pre-check — an unterminated or
  // malformed token there would otherwise be silently mis-sliced instead of
  // failing closed. Scan for the first UNESCAPED closing quote and require
  // it to be the token's LAST character; anything else is malformed.
  let closeIdx = -1;
  for (let j = 1; j < token.length; j++) {
    if (token[j] === '\\') { j++; continue; }
    if (token[j] === '"') { closeIdx = j; break; }
  }
  if (closeIdx !== token.length - 1) return null; // unterminated, or trailing content after the close
  const inner = token.slice(1, -1);
  const bytes = [];
  const encoder = new TextEncoder();
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '\\') {
      const next = inner[i + 1];
      if (next !== undefined && Object.hasOwn(GIT_QUOTE_SIMPLE_ESCAPES, next)) {
        bytes.push(GIT_QUOTE_SIMPLE_ESCAPES[next]);
        i += 2;
        continue;
      }
      if (next !== undefined && next >= '0' && next <= '7') {
        let digits = next;
        let j = i + 2;
        while (digits.length < 3 && inner[j] >= '0' && inner[j] <= '7') {
          digits += inner[j];
          j++;
        }
        const value = Number.parseInt(digits, 8);
        if (value > 0o377) return null; // not a representable byte
        bytes.push(value);
        i = j;
        continue;
      }
      return null; // malformed escape — neither a known letter nor an octal digit
    }
    const codePoint = inner.codePointAt(i);
    const charLen = codePoint > 0xffff ? 2 : 1; // surrogate-pair aware
    for (const b of encoder.encode(inner.slice(i, i + charLen))) bytes.push(b);
    i += charLen;
  }
  if (bytes.some((b) => b === 0x00)) return null; // NUL cannot occur in a POSIX pathname
  const buf = Uint8Array.from(bytes);
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return null; // invalid UTF-8 sequence
  }
  const reencoded = new TextEncoder().encode(decoded);
  if (reencoded.length !== buf.length || !reencoded.every((b, idx) => b === buf[idx])) {
    return null; // decoding was lossy on the accumulated bytes — never ship a half-faithful path
  }
  return decoded;
}

/**
 * Reject a raw (pre-decode) header token that contains a LITERAL U+FFFD
 * (docs/plans/refactor-evidence-integrity.md §4.1a, corrected at R2/M1).
 *
 * The guard is on PROVENANCE, not the character: U+FFFD is a perfectly legal
 * POSIX filename character, and under git's default `core.quotePath=true` a
 * path containing it arrives octal-escaped (`\357\277\275`) — which
 * `unquoteGitPath` decodes correctly and this guard must NOT reject (it only
 * ever inspects the RAW pre-decode text, and a decoded octet sequence is not
 * literally the character `�` in that raw text). A LITERAL `�` in
 * the raw header text can only mean `fs.readFileSync(..., 'utf-8')`
 * replaced an invalid byte before this module ever saw it — an ingress
 * corruption this module cannot recover, so it fails closed rather than
 * mint a silently wrong path.
 *
 * @param {string} rawToken
 * @returns {boolean}
 */
function hasLiteralReplacementChar(rawToken) {
  return typeof rawToken === 'string' && rawToken.includes('�');
}

/**
 * Read one self-delimiting quoted token starting at `s[start]` (`s[start]`
 * MUST be `"`). Returns the token INCLUDING its surrounding quotes (the
 * shape `unquoteGitPath` expects) and the index just past the closing quote,
 * or `null` if the quote is never closed.
 *
 * @param {string} s
 * @param {number} start
 * @returns {{raw: string, end: number} | null}
 */
function readQuotedHeaderToken(s, start) {
  let j = start + 1;
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === '"') return { raw: s.slice(start, j + 1), end: j + 1 };
    j++;
  }
  return null; // unterminated quote
}

/**
 * Rule 1 (docs/plans/refactor-evidence-integrity.md §2 decision 5): a token
 * starting with `"` is self-delimiting — ends at the first UNESCAPED `"`, no
 * ambiguity possible. Handles both-quoted and the one-quoted-one-not case
 * (git quotes each side independently): an unquoted OLD token structurally
 * cannot contain a literal `"` (git's own quoting rule would have quoted it),
 * so the first `"` anywhere in `rest` unambiguously starts a quoted token —
 * either OLD (at position 0) or NEW (mid-string, immediately after OLD's
 * single trailing space).
 *
 * @param {string} rest - the header line's text after `diff --git `
 * @returns {{oldPath: string, newPath: string} | null}
 */
function resolveQuotedHeaderRule(rest) {
  const firstQuote = rest.indexOf('"');
  if (firstQuote === -1) return null; // no quoting at all — this rule does not apply

  let oldRaw, afterOld;
  if (firstQuote === 0) {
    const oldTok = readQuotedHeaderToken(rest, 0);
    if (!oldTok) return null;
    oldRaw = oldTok.raw;
    afterOld = oldTok.end;
  } else {
    if (rest[firstQuote - 1] !== ' ') return null; // quote mid-token — not a legal boundary
    oldRaw = rest.slice(0, firstQuote - 1);
    afterOld = firstQuote - 1;
    // Structurally unreachable — oldRaw is everything BEFORE the FIRST quote
    // in `rest`, so it cannot itself contain one — but asserted explicitly
    // (round-3 code-audit H1) rather than left asymmetric with the unquoted-
    // NEW branch's explicit check below, so the invariant survives a future
    // edit to how `firstQuote` is computed.
    if (oldRaw.includes('"')) return null;
  }
  if (rest[afterOld] !== ' ') return null;
  const newStart = afterOld + 1;

  let newRaw;
  if (rest[newStart] === '"') {
    const newTok = readQuotedHeaderToken(rest, newStart);
    if (!newTok || newTok.end !== rest.length) return null; // must consume to end of line
    newRaw = newTok.raw;
  } else {
    newRaw = rest.slice(newStart);
    if (newRaw.includes('"')) return null; // an unquoted token cannot legally contain a raw quote
  }

  if (hasLiteralReplacementChar(oldRaw) || hasLiteralReplacementChar(newRaw)) return null;
  const oldDecoded = unquoteGitPath(oldRaw);
  const newDecoded = unquoteGitPath(newRaw);
  if (oldDecoded === null || newDecoded === null) return null;
  if (!oldDecoded.startsWith('a/') || !newDecoded.startsWith('b/')) return null;
  return { oldPath: oldDecoded.slice(2), newPath: newDecoded.slice(2) };
}

/**
 * Rule 2 (§2 decision 5): a `rename from`/`rename to` (or `copy from`/
 * `copy to`) pair, read ONLY from the extended-header PRELUDE — strictly
 * after the `diff --git` line and strictly before the first `---`, `+++`,
 * `@@`, or `Binary files ` line (round-3 code-audit H1: the whole-section
 * `fileStatus` scan at `:121-124` is pre-existing and unchanged, but this
 * rule makes the SAME kind of scan load-bearing for path *identity*, so it
 * must be bounded here — impact, not authorship). Exactly one complete,
 * same-kind pair; incomplete, duplicated, or mixed-kind metadata falls
 * through to rule 3. These tokens carry no `a/`/`b/` transport prefix.
 *
 * @param {string} part - the file's full diff section
 * @returns {{oldPath: string, newPath: string} | null}
 */
function resolveRenameCopyHeaderRule(part) {
  const lines = part.split(/\r?\n/);
  const prelude = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^---( |$)/.test(l) || /^\+\+\+( |$)/.test(l) || /^@@/.test(l) || l.startsWith('Binary files ')) break;
    prelude.push(l);
  }
  const renameFrom = prelude.filter((l) => l.startsWith('rename from '));
  const renameTo = prelude.filter((l) => l.startsWith('rename to '));
  const copyFrom = prelude.filter((l) => l.startsWith('copy from '));
  const copyTo = prelude.filter((l) => l.startsWith('copy to '));

  let fromLine, toLine, fromPrefixLen, toPrefixLen;
  if (renameFrom.length === 1 && renameTo.length === 1 && copyFrom.length === 0 && copyTo.length === 0) {
    fromLine = renameFrom[0]; toLine = renameTo[0];
    fromPrefixLen = 'rename from '.length; toPrefixLen = 'rename to '.length;
  } else if (copyFrom.length === 1 && copyTo.length === 1 && renameFrom.length === 0 && renameTo.length === 0) {
    fromLine = copyFrom[0]; toLine = copyTo[0];
    fromPrefixLen = 'copy from '.length; toPrefixLen = 'copy to '.length;
  } else {
    return null; // incomplete, duplicated, or mixed-kind — this rule does not apply
  }

  const oldRaw = fromLine.slice(fromPrefixLen);
  const newRaw = toLine.slice(toPrefixLen);
  if (hasLiteralReplacementChar(oldRaw) || hasLiteralReplacementChar(newRaw)) return null;
  const oldDecoded = unquoteGitPath(oldRaw);
  const newDecoded = unquoteGitPath(newRaw);
  if (oldDecoded === null || newDecoded === null) return null;
  return { oldPath: oldDecoded, newPath: newDecoded };
}

/**
 * Rule 3 (§2 decision 5): the only remaining shape a rename-detecting `git
 * diff` emits is `oldPath === newPath` — the header line must be EXACTLY
 * `a/P + ' b/' + P`. A derivation, not a heuristic: `P`'s length is fixed by
 * the total length (`afterA.length === 2*|P| + 3`), so there is exactly one
 * candidate split, and it is accepted only if reconstructing the header from
 * it is byte-identical to the original — never a guess.
 *
 * @param {string} rest - the header line's text after `diff --git `
 * @returns {{oldPath: string, newPath: string} | null}
 */
function resolveSymmetricHeaderRule(rest) {
  if (!rest.startsWith('a/')) return null;
  const afterA = rest.slice(2);
  if ((afterA.length - 3) % 2 !== 0) return null;
  const pLen = (afterA.length - 3) / 2;
  if (pLen <= 0) return null;
  const candidateP = afterA.slice(0, pLen);
  if (candidateP + ' b/' + candidateP !== afterA) return null; // reconstruction check
  if (hasLiteralReplacementChar(candidateP)) return null;
  return { oldPath: candidateP, newPath: candidateP };
}

/**
 * Resolve a `diff --git` header's old/new paths unambiguously
 * (docs/plans/refactor-evidence-integrity.md §2 decision 5 — replaces the
 * lazy-regex split that let an unquoted header containing the literal
 * substring `" b/"` mis-split at the FIRST occurrence, e.g.
 * `diff --git a/x b/y.js b/x b/y.js` captured `oldPath: 'x'`,
 * `newPath: 'y.js b/x b/y.js'` — a CONFIDENTLY WRONG pair, not the safe
 * `null` the pre-existing accepted-debt note promised). Four rules, tried in
 * order, each either succeeds verifiably or falls through; `null` means none
 * applied (`pathDecodeFailed` at the call site — fail closed and loud, never
 * a fourth heuristic rule guessing at patch-marker grammar no call site in
 * this repo actually feeds into this parser).
 *
 * @param {string} part - the file's full diff section, starting with the
 *   `diff --git ` line
 * @returns {{oldPath: string, newPath: string} | null}
 */
export function resolveHeaderPaths(part) {
  const headerMatch = part.match(/^diff --git (.+)\r?\n/);
  if (!headerMatch) return null;
  const rest = headerMatch[1];
  return resolveQuotedHeaderRule(rest)
    ?? resolveRenameCopyHeaderRule(part)
    ?? resolveSymmetricHeaderRule(rest)
    ?? null;
}

/**
 * Parse EVERY file section out of a unified diff. The shared core extracted
 * from `extractFileDiffSection` (evidence-anchor-path-contract §7i, Gemini
 * gate G2): that function takes a KNOWN `filePath` and returns only that
 * file's section, so `buildDiffPathMap` — which must DISCOVER all files —
 * could not reuse it without already knowing the answer. Rather than
 * re-implement the parser (and silently lose the fixes below), the loop is
 * lifted here and both callers filter over it.
 *
 * The header fixes are REGRESSION-LOCKED behaviour, not incidental:
 *
 * - Consolidated Gemini gate fix G1: `.` never matches a line terminator in
 *   JS regex (not just `\n` — `\r` is excluded too), so the original
 *   `a\/(.+?) b\/(.+?)\n` could never match a CRLF diff header at all — a
 *   Windows-generated diff (or one round-tripped through a CRLF-preserving
 *   tool) would silently fail EVERY file lookup, degrading Stage 0 to
 *   unverifiable-escalate-everything with no signal anything was wrong.
 * - Consolidated Gemini gate fix G3, round 3 / refactor-evidence-integrity.md:
 *   git quotes each path in the header whenever it contains a char
 *   `core.quotePath` treats as special — NOT "whenever it contains a
 *   space" (measured: a space alone does not force quoting). The header is
 *   now resolved by `resolveHeaderPaths`'s four-rule grammar (§2 decision 5)
 *   rather than a regex that only handled a narrow quoted-space case.
 *
 * A part that matches the `diff --git` shape but whose paths cannot be
 * resolved is no longer silently dropped — it is pushed with
 * `oldPath: null, newPath: null, pathDecodeFailed: true`, so a downstream
 * consumer sees a NAMED, loud failure instead of the file silently vanishing
 * from the diff (docs/plans/refactor-evidence-integrity.md §4.2).
 *
 * @param {string} diffText
 * @returns {Array<{section: string, fileStatus: 'modified'|'added'|'deleted'|'renamed'|'copied',
 *   oldPath: string|null, newPath: string|null, pathDecodeFailed?: true}>}
 *   in diff-header order; `[]` when nothing parses.
 */
export function parseAllDiffSections(diffText) {
  if (!diffText) return [];
  const out = [];
  for (const part of String(diffText).split(/(?=^diff --git )/m)) {
    if (!part.startsWith('diff --git ')) continue;
    let fileStatus = 'modified';
    if (/^new file mode/m.test(part)) fileStatus = 'added';
    else if (/^deleted file mode/m.test(part)) fileStatus = 'deleted';
    else if (/^rename from /m.test(part)) fileStatus = 'renamed';
    else if (/^copy from /m.test(part)) fileStatus = 'copied';

    const paths = resolveHeaderPaths(part);
    if (!paths) {
      out.push({ section: part, fileStatus, oldPath: null, newPath: null, pathDecodeFailed: true });
      continue;
    }
    out.push({ section: part, fileStatus, oldPath: paths.oldPath, newPath: paths.newPath });
  }
  return out;
}

/**
 * Parse a `@@ -a,b +c,d @@` hunk header into line-number/count fields.
 * The count is 1 when the `,count` group is omitted (unified-diff
 * convention) — distinct from an EXPLICIT `,0` (a pure add/delete hunk on
 * that side), so the two are never conflated.
 *
 * @param {string} line
 * @returns {{baseStart:number, baseCount:number, headStart:number, headCount:number} | null}
 */
export function parseHunkHeader(line) {
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) return null;
  return {
    baseStart: Number(m[1]),
    baseCount: m[2] !== undefined ? Number(m[2]) : 1,
    headStart: Number(m[3]),
    headCount: m[4] !== undefined ? Number(m[4]) : 1,
  };
}

/**
 * Split a file's diff section into individual hunks. Each hunk carries its
 * parsed `header` (line-number/count fields, `null` if the `@@` line failed
 * to parse) alongside its `lines` (the body content, unchanged shape from
 * before this module's Stage 0 restructure — every existing consumer of
 * "a hunk's lines" keeps working).
 *
 * @returns {Array<{header: object|null, lines: string[]}>}
 */
function splitIntoHunks(section) {
  const hunks = [];
  let current = null;
  for (const rawLine of section.split('\n')) {
    if (rawLine.startsWith('@@')) {
      if (current) hunks.push(current);
      current = { header: parseHunkHeader(rawLine), lines: [] };
      continue;
    }
    if (current === null) continue; // before the first hunk (file header lines)
    current.lines.push(rawLine);
  }
  if (current) hunks.push(current);
  return hunks;
}

/**
 * Does `quote` appear as CONTIGUOUS content, within a SINGLE hunk, on the
 * given `side`? `head` side = added (`+`) or unchanged context lines; `base`
 * side = removed (`-`) or unchanged context lines.
 *
 * Cluster B audit fix H4 (round 2 — a real bug in the round-1 fix): joining
 * matching-side lines across the ENTIRE FILE (spanning unrelated, non-
 * adjacent hunks) let a quote whose words merely appear in order ACROSS TWO
 * SEPARATE HUNKS pass as "verified" — a fabricated or stale multi-hunk quote
 * could defeat a load-bearing evidence gate. Matching is now scoped to one
 * hunk's contiguous same-side lines at a time; a quote must be genuinely
 * contiguous within a single hunk, never stitched across a hunk boundary.
 */
function quoteAppearsOnSide(section, quote, side) {
  const normQuote = normalizeWhitespace(quote);
  if (!normQuote) return false;
  const wantedPrefixes = side === 'head' ? ['+', ' '] : ['-', ' '];
  for (const hunk of splitIntoHunks(section)) {
    const contentLines = [];
    for (const rawLine of hunk.lines) {
      const prefix = rawLine[0];
      if (!wantedPrefixes.includes(prefix)) continue;
      contentLines.push(normalizeWhitespace(rawLine.slice(1)));
    }
    // Consolidated Gemini gate fix G1, round 3: each line is normalized
    // individually, but an EMPTY context line (blank line in the diff)
    // normalizes to `''` — `contentLines.join(' ')` then inserts a
    // separator on both sides of that empty entry, producing a DOUBLE
    // space at the join point (e.g. ['foo()','','bar()'].join(' ') ===
    // 'foo()  bar()'). Since `normQuote` has collapsed to single spaces,
    // `.includes(normQuote)` would then miss a perfectly valid quote that
    // spans a blank context line, silently marking it 'fabricated'.
    // Re-normalizing the JOINED string collapses that double space too.
    if (normalizeWhitespace(contentLines.join(' ')).includes(normQuote)) return true;
  }
  return false;
}

/**
 * Every REAL, diff-derived line range where `quote` appears within a SINGLE
 * hunk's wanted-side content — never the model's self-reported
 * `startLine`/`endLine` (2026-07-26; docs/plans/tiered-recall-audit-pipeline.md
 * "Addendum 2026-07-26 (continued)"). `resolveAnchorLocation`'s `in_hunk`
 * status has only ever confirmed the quote's TEXT is present somewhere in the
 * hunk — it never checked the model's claimed line, and the caller
 * (`runStage0EvidenceTriage`) never surfaced ANY location for this, the most
 * common success path, onto the final finding. A census of this repo's own
 * real audit findings found `_primaryLine` unset on effectively every one
 * (both legacy AND tiered) — this closes that gap for the tiered side, where
 * a VERIFIED line is actually derivable, rather than trusting a number a
 * model could hallucinate.
 *
 * Same fixed-window/normalize/join technique as `findAllLineRangesInContent`
 * below (the quote's own line count as window size — a whole-blob normalize
 * would make the matched character offset impossible to map back to a line
 * number), scoped to one hunk's WANTED-SIDE lines with their REAL file line
 * numbers attached via the hunk's own parsed header (`baseStart`/`headStart`
 * — never a naive index into `hunk.lines`, which mixes both sides and context
 * lines and would misnumber the moment either side's line count differs).
 *
 * Deliberately NOT a drop-in replacement for `quoteAppearsOnSide` (whose
 * looser whole-hunk-join substring match is unchanged, still used by
 * `verifyAnchor` and as this function's own fallback below) — a fixed-size
 * window is a STRICTER match than an arbitrary-length join, so a real quote
 * this function can't precisely window-match must still be reported as
 * verified-but-unlocatable, never silently un-verified.
 *
 * Returns EVERY window match, not just the first (docs/plans/refactor-
 * evidence-integrity.md §4.3 — supersedes the removed `findQuoteLineInHunk`,
 * which `break`d on the first match and is why a cross-hunk collection could
 * only ever keep the first hunk's location, never disambiguate against a
 * declared range in a later hunk). `selectAnchoredMatch` is the single place
 * that turns this array into a decision.
 *
 * @param {{header: object|null, lines: string[]}} hunk
 * @param {string} quote
 * @param {'head'|'base'} side
 * @returns {Array<{startLine:number, endLine:number}>} 1-indexed, inclusive.
 *   `[]` when `hunk.header` failed to parse, the quote is empty, or no window
 *   matches.
 */
export function findQuoteLineRangesInHunk(hunk, quote, side) {
  if (!hunk.header) return [];
  const wantedPrefixes = side === 'head' ? ['+', ' '] : ['-', ' '];
  let lineNum = side === 'head' ? hunk.header.headStart : hunk.header.baseStart;
  const entries = [];
  for (const rawLine of hunk.lines) {
    const prefix = rawLine[0];
    if (!wantedPrefixes.includes(prefix)) continue;
    entries.push({ lineNum, text: normalizeWhitespace(rawLine.slice(1)) });
    lineNum++;
  }
  const normQuote = normalizeWhitespace(quote);
  if (!normQuote) return [];
  const quoteLineCount = String(quote).split('\n').length;
  const matches = [];
  for (let start = 0; start + quoteLineCount <= entries.length; start++) {
    const windowLines = entries.slice(start, start + quoteLineCount).map((e) => e.text);
    if (normalizeWhitespace(windowLines.join(' ')).includes(normQuote)) {
      matches.push({ startLine: entries[start].lineNum, endLine: entries[start + quoteLineCount - 1].lineNum });
    }
  }
  return matches;
}

/**
 * The single disambiguation seam used by BOTH the in-hunk and HEAD-fallback
 * localisation paths (docs/plans/refactor-evidence-integrity.md §2 decision
 * 1 — this is the fix for the divergence §1 identified between
 * `findQuoteLineInHunk`'s first-match and `findAllLineRangesInContent`'s
 * all-matches behaviour).
 *
 * The declared range EARNS its authority rather than gating by default:
 * exactly one match wins outright (the declaration is irrelevant); two or
 * more matches are disambiguated ONLY if the declared range intersects
 * EXACTLY one of them; anything else — zero matches, or a declared range
 * intersecting zero or multiple matches — is `ambiguous`. Never a nearest-
 * match guess: intersection is a verifiable predicate that either holds or
 * does not.
 *
 * `declaredRange` must be `null` whenever the coordinate space cannot be
 * established (docs/plans/refactor-evidence-integrity.md §2 decision 1a — a
 * `side: 'base'` anchor's declared range is in HEAD-file coordinates while
 * the derived range is in base-diff coordinates; comparing them is a
 * category error). Passing `null` here always degrades a multi-match case to
 * `ambiguous`, which is the correct, honest answer when disambiguation is
 * inadmissible.
 *
 * @param {Array<{startLine:number, endLine:number}>} matches
 * @param {{startLine:number, endLine:number} | null} declaredRange
 * @returns {{kind:'none'} | {kind:'unique', match:{startLine:number, endLine:number}} | {kind:'ambiguous', count:number}}
 */
export function selectAnchoredMatch(matches, declaredRange) {
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'unique', match: matches[0] };
  if (declaredRange) {
    const intersecting = matches.filter(
      (m) => m.startLine <= declaredRange.endLine && declaredRange.startLine <= m.endLine,
    );
    if (intersecting.length === 1) return { kind: 'unique', match: intersecting[0] };
  }
  return { kind: 'ambiguous', count: matches.length };
}

/**
 * Line-indexed sliding-window search for `quote` within `content` — never
 * normalizes the WHOLE blob first (a whole-blob normalize-then-search makes
 * the matched character offset impossible to map back to a line number
 * without a separate token-to-line index; Gemini final-review round-1 G3).
 * The window size is the quote's OWN raw line count, so a verbatim
 * multi-line quote is matched at its exact original span — a quote that was
 * reformatted to a different line count since being cited will miss (a
 * known, documented trade-off: `contentExistsAtMappedRange`'s own docblock
 * and the plan's Risk Register both cover this).
 *
 * @param {string} content
 * @param {string} quote
 * @returns {{startLine:number, endLine:number} | null} 1-indexed, inclusive
 */
/**
 * Find every line-window in `content` whose normalized text matches `quote`
 * (item 11 — arch-audit-pipeline-observability-hardening.md). Previously
 * returned the FIRST match only, with no occurrence identity: an identical
 * snippet appearing more than once in the file (a common pattern — repeated
 * boilerplate, near-duplicate branches) meant the caller could silently
 * assert a location the model never actually referenced. Returning every
 * match lets the caller distinguish "exactly one place this could be" from
 * "genuinely ambiguous" instead of guessing.
 *
 * @returns {Array<{startLine:number, endLine:number}>}
 */
function findAllLineRangesInContent(content, quote) {
  const normQuote = normalizeWhitespace(quote);
  if (!normQuote) return [];
  const lines = String(content || '').split('\n');
  const quoteLineCount = String(quote).split('\n').length;
  const matches = [];
  for (let start = 0; start + quoteLineCount <= lines.length; start++) {
    const windowLines = lines.slice(start, start + quoteLineCount).map(normalizeWhitespace);
    if (normalizeWhitespace(windowLines.join(' ')).includes(normQuote)) {
      matches.push({ startLine: start + 1, endLine: start + quoteLineCount });
    }
  }
  return matches;
}

/**
 * Map a single HEAD-side line number to its corresponding BASE-side line
 * number, for a line that falls OUTSIDE every hunk in `hunks` (a line
 * WITHIN a hunk has no single stable base correspondence — that's the
 * `in_hunk` case, handled separately). Cumulative-offset diff-line mapping:
 * walks hunks in order, accumulating each hunk's net line-count delta
 * (`headCount - baseCount`) until it finds the gap `headLine` falls in.
 *
 * Never based on raw line-number equality across revisions (round-2
 * plan-audit H1 — an EARLIER hunk shifts every LATER line number in HEAD,
 * so comparing "line 40 in base" against "line 40 in HEAD" compares
 * unrelated content when any earlier edit changed the line count).
 *
 * @param {number} headLine - 1-indexed
 * @param {Array<{header: object|null, lines: string[]}>} hunks
 * @returns {number | null} the base line number, or `null` if `headLine`
 *   falls within a hunk, a hunk header failed to parse, or the computed
 *   result is out of bounds (< 1) — all ambiguous, never guessed.
 */
export function mapHeadLineToBase(headLine, hunks) {
  let delta = 0;
  for (const hunk of hunks) {
    const h = hunk.header;
    if (!h) return null; // an unparseable header anywhere makes every later offset unreliable
    if (headLine < h.headStart) {
      const baseLine = headLine - delta;
      return baseLine >= 1 ? baseLine : null;
    }
    const headEnd = h.headStart + h.headCount - 1;
    if (headLine <= headEnd) return null; // within this hunk — not this function's case
    delta += (h.headCount - h.baseCount);
  }
  const baseLine = headLine - delta;
  return baseLine >= 1 ? baseLine : null;
}

/**
 * Map a HEAD-side line RANGE to its corresponding BASE-side range. Requires
 * BOTH endpoints to map successfully AND the mapped range to preserve the
 * original range's length — a hunk boundary crossing partway through the
 * cited range makes the whole range ambiguous (some of it maps cleanly,
 * some doesn't), so that case returns `null` rather than a partial answer.
 *
 * @param {{startLine:number, endLine:number}} headRange
 * @param {Array<{header: object|null, lines: string[]}>} hunks
 * @returns {{startLine:number, endLine:number} | null}
 */
export function mapHeadRangeToBase(headRange, hunks) {
  const mappedStart = mapHeadLineToBase(headRange.startLine, hunks);
  const mappedEnd = mapHeadLineToBase(headRange.endLine, hunks);
  if (mappedStart === null || mappedEnd === null) return null;
  const expectedLength = headRange.endLine - headRange.startLine;
  if (mappedEnd - mappedStart !== expectedLength) return null;
  return { startLine: mappedStart, endLine: mappedEnd };
}

/**
 * §4.4 telemetry: one versioned, machine-readable token per localisation
 * attempt, so the design's own assumption ("declared lines are unreliable,
 * so do not gate on them" — §2 decision 1) is falsifiable from real data
 * instead of argued from a sample size of one fixture. Deliberately NOT a
 * free-form prose suffix (round-3 M1): a prose string loses `endLine`,
 * loses whether the declaration was used or merely ignored, loses the
 * coordinate space, and invites a consumer to scrape a human-oriented
 * field. `outcome` is a closed set so "did the declaration do work?" is
 * answerable directly:
 *
 * - `single_match` — exactly one candidate; the declaration was irrelevant.
 * - `range_disambiguated` — ≥2 candidates, and the declared range picked
 *   exactly one — the declaration did real work.
 * - `ambiguous` — ≥2 candidates and the declared range intersects zero or
 *   more than one (or was inadmissible — see `declared=none` below).
 * - `unlocatable` — zero candidates.
 *
 * `declared=none` means the declared range was INADMISSIBLE as a
 * disambiguator (§2 decision 1a's `side:'base'` case), not merely absent —
 * so inadmissibility is observable rather than assumed.
 */
const LOC_TOKEN_VERSION = 'loc/v1';
const LOC_TOKEN_RE = /^loc\/v1 side=(head|base) declared=(none|\d+-\d+) selected=(none|\d+-\d+) outcome=(single_match|range_disambiguated|ambiguous|unlocatable) candidates=(\d+)$/;

function rangeToToken(range) {
  return range ? `${range.startLine}-${range.endLine}` : 'none';
}

function locOutcomeFor(matchCount, selection) {
  if (selection.kind === 'none') return 'unlocatable';
  if (selection.kind === 'ambiguous') return 'ambiguous';
  return matchCount === 1 ? 'single_match' : 'range_disambiguated';
}

/**
 * Format the §4.4 telemetry token. Exported (with its parser) so the
 * producer/consumer pair is round-trip tested rather than assumed.
 * @param {{side: 'head'|'base', declaredRange: {startLine:number,endLine:number}|null,
 *   matchCount: number, selection: {kind:'none'}|{kind:'unique',match:object}|{kind:'ambiguous',count:number}}} args
 * @returns {string}
 */
export function formatLocToken({ side, declaredRange, matchCount, selection }) {
  const outcome = locOutcomeFor(matchCount, selection);
  const selected = selection.kind === 'unique' ? selection.match : null;
  return `${LOC_TOKEN_VERSION} side=${side} declared=${rangeToToken(declaredRange)} selected=${rangeToToken(selected)} outcome=${outcome} candidates=${matchCount}`;
}

/**
 * Parse a `formatLocToken` token back into its fields, or `null` if `token`
 * is not a well-formed `loc/v1` string.
 * @param {string} token
 * @returns {{side:string, declared:string, selected:string, outcome:string, candidates:number} | null}
 */
export function parseLocToken(token) {
  const m = typeof token === 'string' ? LOC_TOKEN_RE.exec(token) : null;
  if (!m) return null;
  return { side: m[1], declared: m[2], selected: m[3], outcome: m[4], candidates: Number(m[5]) };
}

/**
 * resolveAnchorLocation — Gate A. Confirms an anchor's `quote` is real,
 * content-verified against the actual diff OR (on a hunk miss, head-side
 * anchors only) the current working-tree file content, AND that the
 * anchor's claimed `fileStatus`/paths match what the diff itself shows —
 * an anchor claiming `added` against a file the diff shows as merely
 * `modified` is fabricated metadata even if the quote text happens to
 * match (same cross-checks `verifyAnchor` already performs).
 *
 * Stays PURE — `headContent` is a plain parameter, supplied by the caller
 * (`runStage0EvidenceTriage`, via `adapters.headContentAdapter`); this
 * function never reads a file itself.
 *
 * **Three failure classes, never one word** (evidence-anchor-path-contract
 * plan §7a, 2026-07-17). This function previously returned `'fabricated'` —
 * "the model hallucinated this" — for FIVE distinct causes, two of which are
 * not about the model at all. That conflation is why a schema bug read as
 * mass hallucination for weeks: measured on a real Sonnet run, 4/4 candidates
 * were rejected `fabricated` and 4/4 were malformed by OUR schema, with 0/4
 * genuine fabrications. The classes are now distinct because they have
 * different owners and different fixes:
 *
 * | status | means | whose bug |
 * |---|---|---|
 * | `malformed` | the claim could not be PARSED — says nothing about the finding | **ours** (contract) |
 * | `contradicted` | well-formed, but the diff DISPROVES its metadata | the model's |
 * | `unsupported` | well-formed, but the quote is not in the diff or HEAD | the model's |
 *
 * `malformed` is deliberately NOT more permissive than the old behaviour — it
 * still never reaches Stage 1 (its quote was never content-verified, and
 * routing unverified evidence to a human is the failure INC-001 warns about).
 * The change is attribution and visibility, not permissiveness.
 *
 * @param {object} anchor - EvidenceAnchorSchema shape
 * @param {string} diffText - the full unified diff for this commit
 * @param {string|null} [headContent] - the file's current working-tree
 *   content, for the HEAD-fallback search on a hunk miss
 * @returns {{status: 'in_hunk'|'outside_hunk_in_head'|'unverifiable'|'unsupported'|'contradicted'|'malformed',
 *   reasonDetail?: string,
 *   verifiedLine?: {startLine:number, endLine:number} | null,
 *   headLineRange?: {startLine:number, endLine:number},
 *   hunks?: Array<{header: object|null, lines: string[]}>}}
 */
export function resolveAnchorLocation(anchor, diffText, headContent) {
  const parsed = EvidenceAnchorSchema.safeParse(anchor);
  if (!parsed.success) {
    // OUR contract rejected the claim before any evidence was examined. Carry
    // the first issue so a recurrence is diagnosable from telemetry alone
    // rather than needing a live repro (the 2026-07-17 root-cause hunt).
    const issue = parsed.error.issues[0];
    return { status: 'malformed', reasonDetail: `${issue.path.join('.') || '(root)'}: ${issue.message}` };
  }
  const filePath = anchor.side === 'base' ? anchor.oldFile : anchor.newFile;
  if (!filePath) return { status: 'malformed', reasonDetail: `no path for side='${anchor.side}'` };
  if (!diffText) return { status: 'unverifiable' };
  const section = extractFileDiffSection(diffText, filePath);
  if (!section) return { status: 'unverifiable' };
  // Metadata the diff can positively DISPROVE — a model claim, checked and refuted.
  if (section.fileStatus !== anchor.fileStatus) {
    return { status: 'contradicted', reasonDetail: `claimed fileStatus='${anchor.fileStatus}', diff shows '${section.fileStatus}'` };
  }
  if (anchor.oldFile && anchor.oldFile !== section.oldPath) {
    return { status: 'contradicted', reasonDetail: 'oldFile does not match the diff section' };
  }
  if (anchor.newFile && anchor.newFile !== section.newPath) {
    return { status: 'contradicted', reasonDetail: 'newFile does not match the diff section' };
  }

  if (quoteAppearsOnSide(section.section, anchor.quote, anchor.side)) {
    // Collect matches across ALL hunks of the section — never break on the
    // first hunk that happens to verify (docs/plans/refactor-evidence-
    // integrity.md §9 R2/M2: a quote unique to a LATER hunk must resolve to
    // that hunk's lines, not an earlier hunk's). `selectAnchoredMatch` is
    // the single seam that turns the collected matches into a decision.
    const matches = [];
    for (const hunk of splitIntoHunks(section.section)) {
      matches.push(...findQuoteLineRangesInHunk(hunk, anchor.quote, anchor.side));
    }
    // §2 decision 1a: the declared range is admissible ONLY for side:'head'.
    // Discovery is prompted with the full CURRENT (HEAD) file content, never
    // base content, so a model's startLine/endLine is always a HEAD-file
    // line number regardless of the side it declares. For side:'base' the
    // derived range is in BASE-diff coordinates — comparing HEAD-coordinate
    // and base-diff-coordinate numbers is a category error, so the declared
    // range is withheld (`null`) and a multi-match case degrades straight to
    // ambiguous, never a false disambiguation.
    const declaredRange = anchor.side === 'head' ? { startLine: anchor.startLine, endLine: anchor.endLine } : null;
    const selection = selectAnchoredMatch(matches, declaredRange);
    // A verified-but-unlocatable quote (none/ambiguous) still returns
    // 'in_hunk': this step only ADDS information, it must never revoke a
    // verification that already succeeded via the looser quoteAppearsOnSide.
    const verifiedLine = selection.kind === 'unique' ? selection.match : null;
    return {
      status: 'in_hunk',
      verifiedLine,
      reasonDetail: formatLocToken({ side: anchor.side, declaredRange, matchCount: matches.length, selection }),
    };
  }

  // HEAD-fallback only makes sense for head-side anchors — discovery only
  // ever reads current (head) file content, so a base-side quote missing
  // from the hunk has no head-content equivalent to search.
  if (anchor.side === 'head' && headContent) {
    const ranges = findAllLineRangesInContent(headContent, anchor.quote);
    // Admissible by construction — this branch only ever runs for side:'head'.
    const declaredRange = { startLine: anchor.startLine, endLine: anchor.endLine };
    const selection = selectAnchoredMatch(ranges, declaredRange);
    const locToken = formatLocToken({ side: anchor.side, declaredRange, matchCount: ranges.length, selection });
    if (selection.kind === 'unique') {
      return { status: 'outside_hunk_in_head', headLineRange: selection.match, hunks: splitIntoHunks(section.section), reasonDetail: locToken };
    }
    if (selection.kind === 'ambiguous') {
      // §2 decision 3: the quote WAS found — more than once. Blaming the
      // model for OUR inability to localise it is exactly the misattribution
      // §7a exists to eliminate. `unverifiable` already means "can't confirm
      // or refute — benefit of the doubt": it escalates to Stage 1, takes
      // the safe change_related bucket, and never asserts a _primaryLine.
      // No new status, no new bucket — only a distinct reasonCode
      // (runStage0EvidenceTriage) so the existing generic message doesn't
      // become a lie about WHY this is unverifiable.
      return { status: 'unverifiable', reasonDetail: locToken };
    }
    // kind === 'none' — the fallback ran and genuinely found nothing.
    return { status: 'unsupported', reasonDetail: locToken };
  }

  return { status: 'unsupported', reasonDetail: 'quote not found in the diff section or HEAD content' };
}

/**
 * The terminal-failure statuses `resolveAnchorLocation` can return — i.e. this
 * anchor yielded no usable location. Exported as the single source of truth so
 * a future class cannot be added to the resolver while a consumer's hardcoded
 * status list silently keeps treating it as a success (the contract-drift
 * shape this whole plan exists to close).
 */
export const ANCHOR_FAILURE_STATUSES = Object.freeze(['malformed', 'contradicted', 'unsupported']);

/**
 * verifyAnchor — UNCHANGED (round-1/round-2 plan-audit M2 — a new
 * discriminator value does not preserve a closed 3-state contract for any
 * consumer that branches exhaustively on `verified | unverifiable |
 * fabricated`; `resolveAnchorLocation` above is the Stage-0-only detailed
 * resolver, used nowhere else). Every existing caller keeps working with
 * zero modification.
 *
 * @param {object} anchor - EvidenceAnchorSchema shape
 * @param {string} diffText - the full unified diff for this commit
 * @returns {'verified'|'unverifiable'|'fabricated'}
 */
export function verifyAnchor(anchor, diffText) {
  if (!EvidenceAnchorSchema.safeParse(anchor).success) return 'fabricated';
  const filePath = anchor.side === 'base' ? anchor.oldFile : anchor.newFile;
  if (!filePath) return 'fabricated'; // anchor claims a side with no path for it — schema should already catch this, belt-and-suspenders
  if (!diffText) return 'unverifiable';
  const section = extractFileDiffSection(diffText, filePath);
  if (!section) return 'unverifiable'; // file not found in diff at all — can't confirm OR refute
  if (section.fileStatus !== anchor.fileStatus) return 'fabricated'; // metadata mismatch — the diff disagrees with the anchor's own claim
  if (anchor.oldFile && anchor.oldFile !== section.oldPath) return 'fabricated'; // the OTHER path field, cross-checked against the same located section
  if (anchor.newFile && anchor.newFile !== section.newPath) return 'fabricated';
  return quoteAppearsOnSide(section.section, anchor.quote, anchor.side) ? 'verified' : 'fabricated';
}

/**
 * tagPreExisting — two-check requirement (round-1 finding #3): blame alone is
 * NEVER sufficient. Both line-ancestry (via `blameAdapter`) AND
 * impact-independence (via `impactAdapter`) must hold before a candidate may
 * be tagged `pre_existing_independent` — matching this repo's own documented
 * "scope by impact, not authorship" invariant. Either adapter returning
 * `null` (blame failed, or reachability unknown) yields `'unknown'` — NEVER
 * silently treated as pre-existing.
 *
 * @param {{file: string, startLine: number, endLine: number}} citation
 * @param {object} adapters
 * @param {(file: string, startLine: number, endLine: number) => boolean|null} adapters.blameAdapter
 *   Returns true if the cited lines predate the commit under audit, false if
 *   they were introduced by it, null if blame could not be determined
 *   (shallow clone, rename, merge commit).
 * @param {(file: string) => boolean|null} adapters.impactAdapter
 *   Returns true if no changed file in this diff depends on/references
 *   `file`, false if at least one does, null if reachability is unknown
 *   (analysis unavailable for this run).
 * @returns {'pre_existing_independent'|'unknown'}
 */
export function tagPreExisting({ file, startLine, endLine }, { blameAdapter, impactAdapter }) {
  const predatesCommit = typeof blameAdapter === 'function' ? blameAdapter(file, startLine, endLine) : null;
  if (predatesCommit !== true) return 'unknown';
  const isIndependent = typeof impactAdapter === 'function' ? impactAdapter(file) : null;
  if (isIndependent !== true) return 'unknown';
  return 'pre_existing_independent';
}

/**
 * Resolve a finding's `scopeBucket` from its origin candidate(s) against the
 * Stage 0 routing manifest (decision #8 — round-3 plan-audit H6/H4). A
 * finding merged from multiple origin candidates takes the LEAST-restrictive
 * bucket among them (`change_related` if ANY origin is change-related —
 * safe-toward-inclusion, mirroring decision #2's default). An origin id with
 * no manifest entry (e.g. a Stage-2 clean-region `missed_candidate` finding,
 * which has no Stage 0 origin at all) is simply skipped, never treated as an
 * error — `originCandidateIds: []` correctly falls through to the same safe
 * default as an unresolvable id.
 *
 * Pure — no I/O. Co-located here (not tiered-pipeline.mjs) because it reads
 * the same routing-manifest shape `runStage0EvidenceTriage` produces
 * (`Map<fingerprint, scopeBucket>`, built by the caller from `verified` +
 * `preExistingIndependent`'s own `.scopeBucket` fields).
 *
 * @param {string[]} originCandidateIds
 * @param {Map<string, 'change_related'|'pre_existing_impactful'|'pre_existing_independent'>} routingManifest
 * @returns {'change_related'|'pre_existing_impactful'|'pre_existing_independent'}
 */
const SCOPE_BUCKET_RESTRICTIVENESS = {
  change_related: 0,
  pre_existing_impactful: 1,
  pre_existing_independent: 2,
};

export function resolveScopeBucketForFinding(originCandidateIds, routingManifest) {
  let best = null;
  for (const id of originCandidateIds || []) {
    const bucket = routingManifest?.get?.(id);
    if (!bucket) continue;
    if (best === null || SCOPE_BUCKET_RESTRICTIVENESS[bucket] < SCOPE_BUCKET_RESTRICTIVENESS[best]) {
      best = bucket;
    }
  }
  return best ?? 'change_related';
}

/**
 * Resolve one anchor field (`'anchor'` for commission, `'triggerAnchor'` for
 * omission) via `resolveAnchorLocation`, with the envelope-aware fallback
 * (Gemini gate round-2 finding #G1, ported from the pre-restructure
 * `verifyWithFallback`): if the canonical claim's anchor is fabricated, try
 * every OTHER contributing source's anchor before giving up on the whole
 * envelope. Shared between commission and omission handling (Cluster B
 * audit fix H3 — omission's `triggerAnchor` is itself a commission-type
 * fact and must be resolved the same way, not skipped).
 *
 * On total failure the TERMINAL CLASS is preserved rather than flattened to a
 * single `'rejected'` (plan §7a): which class the last-tried anchor failed
 * with decides whether this candidate is attributed to the model or to our own
 * contract, and a flattened word would put the whole distinction back where it
 * was. The fallback is still driven by "did we get a usable location", so
 * every failure class is equally eligible to try alternatives — a malformed
 * canonical anchor with a well-formed alternative still recovers.
 *
 * @returns {{envelope: object, status: 'in_hunk'|'outside_hunk_in_head'|'unverifiable'|'malformed'|'contradicted'|'unsupported',
 *   reasonDetail?: string, headLineRange?: object, hunks?: Array}}
 */
function resolveWithFallback(envelope, anchorField, diffText, headContentAdapter) {
  const originalAnchor = envelope.canonicalFinding[anchorField];
  const originalFilePath = originalAnchor?.side === 'base' ? originalAnchor?.oldFile : originalAnchor?.newFile;
  const originalHeadContent = typeof headContentAdapter === 'function' && originalFilePath
    ? headContentAdapter(originalFilePath) : null;
  const result = resolveAnchorLocation(originalAnchor, diffText, originalHeadContent);
  if (!ANCHOR_FAILURE_STATUSES.includes(result.status)) return { envelope, ...result };

  for (let i = 0; i < envelope.evidenceAlternatives.length; i++) {
    const alt = envelope.evidenceAlternatives[i];
    if (alt[anchorField] === originalAnchor) continue; // that's the one that just failed
    if (!alt[anchorField]) continue;
    const altFilePath = alt[anchorField].side === 'base' ? alt[anchorField].oldFile : alt[anchorField].newFile;
    const altHeadContent = typeof headContentAdapter === 'function' && altFilePath
      ? headContentAdapter(altFilePath) : null;
    const altResult = resolveAnchorLocation(alt[anchorField], diffText, altHeadContent);
    if (!ANCHOR_FAILURE_STATUSES.includes(altResult.status)) {
      return { envelope: promoteAlternative(envelope, i), ...altResult };
    }
  }
  // Every source failed. Keep the CANONICAL anchor's class as the envelope's
  // verdict — it is the claim under adjudication; an alternative's class would
  // attribute the candidate on evidence the finding didn't actually assert.
  return { envelope, ...result };
}

/**
 * runStage0EvidenceTriage — the Stage 0 orchestration entry point.
 *
 * First branch is ALWAYS `evidenceType` (Gemini gate round-1 finding #G4):
 * `commission` claims verify `anchor`; `omission` claims verify
 * `triggerAnchor` (Cluster B audit fix H3 — the TRIGGER is itself a
 * commission-type fact and must be deterministically checked; only the
 * obligation's *absence* is semantic and deferred to Stage 1/2 judgment).
 * Both paths share the same envelope-aware fallback-then-reject logic.
 *
 * Per-candidate result model (docs/plans/stage0-evidence-relevance-split.md):
 *   `in_hunk` → `scopeBucket: 'change_related'`, Gate B skipped (already
 *     directly touched — no relevance question to ask).
 *   `outside_hunk_in_head` → Gate B runs; `scopeBucket` is one of
 *     `change_related` (unmappable range, or blame/impact `unknown` —
 *     decision #2's safe default) / `pre_existing_impactful` (predates the
 *     commit, and a changed file depends on it) / `pre_existing_independent`
 *     (predates the commit, confirmed independent — routed OUT of `verified`
 *     into `preExistingIndependent`, never reaching Stage 1 directly).
 *   `unverifiable` (file not in diff at all) → unchanged from before this
 *     restructure — still Stage-1-eligible, `scopeBucket: 'change_related'`
 *     (decision #8's safe default; no Gate B ever ran).
 *   `fabricated` → unchanged — local telemetry only, never Stage-1-eligible.
 *
 * `rejected` envelopes are returned separately and MUST be treated by the
 * caller as local diagnostic telemetry ONLY — never written to the
 * adjudication ledger (per the state machine in the tiered-recall plan's
 * §1.5). `preExistingIndependent` envelopes are the caller's responsibility
 * to route through debt capture (`tiered-pipeline.mjs`) — restoring a
 * candidate to `verified` on a debt-write failure is the CALLER's job, not
 * this pure function's.
 *
 * @param {Array<import('./candidate-envelope.mjs').AuditCandidateEnvelope>} envelopes
 * @param {object} ctx
 * @param {string} ctx.diffText
 * @param {object} adapters
 * @param {(file: string, startLine: number, endLine: number, quote: string) => boolean|null} [adapters.blameAdapter]
 *   Given the MAPPED BASE-revision line range and the anchor's own quote
 *   text (threaded through by this function — `tagPreExisting`'s own
 *   3-arg contract is unchanged; this 4th arg is this module's own
 *   addition when constructing the per-candidate closure it hands to
 *   `tagPreExisting`), returns whether that exact content predates the
 *   commit.
 * @param {(file: string) => boolean|null} [adapters.impactAdapter]
 * @param {(filePath: string) => string|null} [adapters.headContentAdapter]
 *   The file's current working-tree content, for Gate A's HEAD-fallback
 *   search — explicit injected dependency (Gemini final-review round-1
 *   G2), matching `blameAdapter`/`impactAdapter`'s existing injection
 *   pattern rather than implicit threading.
 * @param {() => string} [adapters.clock] - injectable for deterministic tests; defaults to the real clock in production
 * @returns {{verified: Array<object>, preExistingIndependent: Array<object>,
 *   rejected: Array<object>, malformed: Array<object>}}
 *
 * `malformed` is a FOURTH bucket, split out of `rejected` (plan §7a): a
 * candidate our own contract could not parse is not evidence about the model,
 * and blending it into `rejected` is what made a 100%-schema-rejection run
 * read as 100% model hallucination. Both remain local telemetry only and
 * neither reaches Stage 1 — the split is attribution, not routing (D4).
 */
export function runStage0EvidenceTriage(envelopes, ctx, adapters = {}) {
  const verified = [];
  const preExistingIndependent = [];
  const rejected = [];
  const malformed = [];

  for (const rawEnvelope of envelopes) {
    const evidenceType = rawEnvelope.canonicalFinding.evidenceType;
    const anchorField = evidenceType === 'omission' ? 'triggerAnchor' : 'anchor';
    const reasonPrefix = evidenceType === 'omission' ? 'omission_trigger' : 'commission_anchor';

    const { envelope, status, reasonDetail, headLineRange, hunks, verifiedLine } = resolveWithFallback(
      rawEnvelope, anchorField, ctx.diffText, adapters.headContentAdapter,
    );

    if (ANCHOR_FAILURE_STATUSES.includes(status)) {
      // One reasonCode per class — never the old single
      // `_fabricated_all_alternatives_failed`, which could not distinguish
      // "we broke the contract" from "the model lied".
      const REASON_BY_STATUS = {
        malformed: 'malformed_anchor',
        contradicted: 'metadata_mismatch',
        unsupported: 'quote_not_found',
      };
      envelope.stageDecisions.push({
        stage: 'stage0a',
        outcome: status === 'malformed' ? 'malformed' : 'rejected',
        reasonCode: `${reasonPrefix}_${REASON_BY_STATUS[status]}`,
        reasonDetail: reasonDetail ?? null,
        evidenceRef: envelope.fingerprint,
        createdAt: nowIso(adapters.clock),
      });
      // LOCAL TELEMETRY ONLY — the caller must never write either to the ledger.
      (status === 'malformed' ? malformed : rejected).push(envelope);
      continue;
    }

    // Gate A decision — exactly one `stage0a` entry per candidate, always.
    const anchorVerified = status === 'in_hunk' || status === 'outside_hunk_in_head';
    // §2 decision 3 / §4.3: an `unverifiable` result that carries a
    // `reasonDetail` is the NEW ambiguous-HEAD-fallback case (the quote WAS
    // found, more than once) — distinct from the original "file not in the
    // diff at all" unverifiable, which carries no reasonDetail. One
    // conditional; no new bucket, no new status, no partition change.
    const reasonCode = anchorVerified
      ? `${reasonPrefix}_content_verified`
      : (status === 'unverifiable' && reasonDetail ? `${reasonPrefix}_location_ambiguous` : `${reasonPrefix}_diff_section_unavailable`);
    envelope.stageDecisions.push({
      stage: 'stage0a',
      outcome: anchorVerified ? 'verified' : 'unverifiable',
      reasonCode,
      reasonDetail: reasonDetail ?? null,
      evidenceRef: envelope.fingerprint,
      createdAt: nowIso(adapters.clock),
    });

    if (status !== 'outside_hunk_in_head') {
      // in_hunk (implicit change_related) and unverifiable (safe default) —
      // neither runs Gate B, per the result-model table above.
      envelope.scopeBucket = 'change_related';
      // A VERIFIED line (2026-07-26) — only when status is genuinely 'in_hunk'
      // AND findQuoteLineInHunk could precisely window-match it; `unverifiable`
      // never reaches here with a verifiedLine (resolveAnchorLocation only sets
      // it on the 'in_hunk' return), and a verified-but-unlocatable in_hunk
      // candidate correctly leaves `_primaryLine` unset rather than guessing.
      // Sets the SAME field name `findingLine()` (tiered-shadow-compare.mjs)
      // already checks first — no reader-side change needed for this to reach
      // the final comparison; see that function's own doc comment.
      if (verifiedLine) envelope.canonicalFinding._primaryLine = verifiedLine.startLine;
      verified.push(envelope);
      continue;
    }

    // Gate B — only for outside_hunk_in_head candidates.
    const anchorObj = envelope.canonicalFinding[anchorField];
    const filePath = anchorObj.side === 'base' ? anchorObj.oldFile : anchorObj.newFile;
    // A VERIFIED line (2026-07-26), unconditional here — `outside_hunk_in_head`
    // always carries a real `headLineRange` (resolveAnchorLocation only returns
    // this status when the HEAD-fallback search found EXACTLY one match), so
    // every candidate reaching Gate B has one regardless of which scopeBucket
    // it's classified into below. Deliberately `headLineRange`, NOT the
    // base-mapped range Gate B computes next: this side ONLY ever fires for
    // head-side anchors (see resolveAnchorLocation's own comment), and the
    // location worth reporting is where the quote lives in the file a reader
    // has open NOW — the base-mapped range is an internal blame/impact detail.
    envelope.canonicalFinding._primaryLine = headLineRange.startLine;
    const mappedBaseRange = mapHeadRangeToBase(headLineRange, hunks);

    if (mappedBaseRange === null) {
      // Unmappable range short-circuits straight to the safe default
      // WITHOUT calling blameAdapter at all (decision #4).
      envelope.scopeBucket = 'change_related';
      envelope.stageDecisions.push({
        stage: 'stage0b', outcome: 'unknown', reasonCode: `${reasonPrefix}_unmappable_base_range`,
        evidenceRef: envelope.fingerprint, createdAt: nowIso(adapters.clock),
      });
      verified.push(envelope);
      continue;
    }

    const blameAdapterForCandidate = typeof adapters.blameAdapter === 'function'
      ? (file, s, e) => adapters.blameAdapter(file, s, e, anchorObj.quote)
      : undefined;

    const relevance = tagPreExisting(
      { file: filePath, startLine: mappedBaseRange.startLine, endLine: mappedBaseRange.endLine },
      { blameAdapter: blameAdapterForCandidate, impactAdapter: adapters.impactAdapter },
    );

    let scopeBucket;
    if (relevance === 'pre_existing_independent') {
      scopeBucket = 'pre_existing_independent';
    } else {
      // tagPreExisting's binary output conflates "not confirmed pre-
      // existing" with "pre-existing but impactful" — re-derive the finer
      // 3-way split decision #8 needs. blameAdapter/impactAdapter results
      // are memoized per (file, range)/(file) by the caller's
      // Stage0RelevanceContext, so this is a cache hit, not a second live
      // query.
      const predatesCommit = blameAdapterForCandidate
        ? blameAdapterForCandidate(filePath, mappedBaseRange.startLine, mappedBaseRange.endLine)
        : null;
      if (predatesCommit === true) {
        const isIndependent = typeof adapters.impactAdapter === 'function' ? adapters.impactAdapter(filePath) : null;
        scopeBucket = isIndependent === false ? 'pre_existing_impactful' : 'change_related';
      } else {
        scopeBucket = 'change_related';
      }
    }

    envelope.scopeBucket = scopeBucket;
    envelope.stageDecisions.push({
      stage: 'stage0b', outcome: scopeBucket, reasonCode: `${reasonPrefix}_relevance_${scopeBucket}`,
      evidenceRef: envelope.fingerprint, createdAt: nowIso(adapters.clock),
    });

    if (scopeBucket === 'pre_existing_independent') {
      preExistingIndependent.push(envelope);
    } else {
      verified.push(envelope);
    }
  }

  return { verified, preExistingIndependent, rejected, malformed };
}
