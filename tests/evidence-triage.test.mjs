/**
 * Tier-1 tests for Stage 0 deterministic evidence triage (tiered-recall
 * pipeline, Cluster B / Phase 3). Plan: docs/plans/tiered-recall-audit-pipeline.md.
 * Covers: verifyAnchor content-verification, tagPreExisting's two-check gate,
 * runStage0EvidenceTriage's evidenceType branch + envelope-aware fallback
 * (Gemini gate round-2 finding #G1), and the AuditCandidateEnvelope merge
 * contract (round-2 finding #6).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyAnchor, tagPreExisting, runStage0EvidenceTriage,
  resolveAnchorLocation, mapHeadLineToBase, mapHeadRangeToBase,
  resolveScopeBucketForFinding, ANCHOR_FAILURE_STATUSES,
  findQuoteLineRangesInHunk, selectAnchoredMatch, unquoteGitPath, resolveHeaderPaths,
  parseAllDiffSections, formatLocToken, parseLocToken,
} from '../scripts/lib/audit/evidence-triage.mjs';
import { createEnvelope } from '../scripts/lib/audit/candidate-envelope.mjs';

const DIFF = `diff --git a/src/foo.js b/src/foo.js
index abc..def 100644
--- a/src/foo.js
+++ b/src/foo.js
@@ -10,3 +10,4 @@ function foo() {
   const a = 1;
-  return a;
+  await db.insert(a);
+  return a;
 }
diff --git a/src/new.js b/src/new.js
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new.js
@@ -0,0 +1,2 @@
+export function bar() {}
+
diff --git a/src/two-hunks.js b/src/two-hunks.js
index abc..def 100644
--- a/src/two-hunks.js
+++ b/src/two-hunks.js
@@ -5,2 +5,2 @@ function alpha() {
-  return old1;
+  return newAlpha;
@@ -40,2 +40,2 @@ function beta() {
-  return old2;
+  return newBeta;
diff --git a/src/gone.js b/src/gone.js
deleted file mode 100644
index 2222222..0000000
--- a/src/gone.js
+++ /dev/null
@@ -1,2 +0,0 @@
-export function baz() {}
-
diff --git a/src/old-name.js b/src/new-name.js
similarity index 95%
rename from src/old-name.js
rename to src/new-name.js
index 3333333..4444444 100644
--- a/src/old-name.js
+++ b/src/new-name.js
@@ -1,2 +1,3 @@
 export function renamed() {
+  return true;
 }
diff --git a/src/blank-line.js b/src/blank-line.js
index 5555555..6666666 100644
--- a/src/blank-line.js
+++ b/src/blank-line.js
@@ -1,3 +1,3 @@
 function alpha() {
` + ' ' + `
 function beta() {
`;

// The REAL shape git emits for a space-containing path — UNQUOTED. Measured
// (docs/plans/refactor-evidence-integrity.md §1): a space alone does NOT
// force git to quote a header path (`cq_must_quote` fires on `"`, `\`,
// control bytes, and non-ASCII only under `core.quotePath`). The prior
// QUOTED_PATH_DIFF fixture pinned a shape git never actually emits.
const UNQUOTED_SPACE_DIFF = `diff --git a/path with spaces.js b/path with spaces.js
index 7777777..8888888 100644
--- a/path with spaces.js
+++ b/path with spaces.js
@@ -1,1 +1,1 @@
-old content
+new content
`;

// A path git DOES quote — an embedded `"`, one of the actual must-quote
// triggers. Both header tokens are quoted, each with an escaped inner quote.
const QUOTED_PATH_DIFF = `diff --git "a/quo\\"te.js" "b/quo\\"te.js"
index 7777777..8888888 100644
--- "a/quo\\"te.js"
+++ "b/quo\\"te.js"
@@ -1,1 +1,1 @@
-old content
+new content
`;

const HEAD_ANCHOR = {
  diffPathId: 'src/foo.js', oldFile: 'src/foo.js', newFile: 'src/foo.js',
  fileStatus: 'modified', side: 'head', startLine: 12, endLine: 12,
  quote: 'await db.insert(a);', headSha: 'abc123',
};

describe('verifyAnchor', () => {
  it('verifies a real added (head-side) line', () => {
    assert.equal(verifyAnchor(HEAD_ANCHOR, DIFF), 'verified');
  });
  it('verifies a real removed (base-side) line', () => {
    const anchor = { ...HEAD_ANCHOR, side: 'base', quote: 'return a;', startLine: 11, endLine: 11 };
    assert.equal(verifyAnchor(anchor, DIFF), 'verified');
  });
  it('verifies unchanged context content on either side', () => {
    const anchor = { ...HEAD_ANCHOR, side: 'base', quote: 'const a = 1;' };
    assert.equal(verifyAnchor(anchor, DIFF), 'verified');
  });
  it('returns fabricated when the quote does not appear in the file section', () => {
    const anchor = { ...HEAD_ANCHOR, quote: 'this text does not exist anywhere' };
    assert.equal(verifyAnchor(anchor, DIFF), 'fabricated');
  });
  it('returns unverifiable when the file is not in the diff at all', () => {
    const anchor = { ...HEAD_ANCHOR, diffPathId: 'src/missing.js', oldFile: 'src/missing.js', newFile: 'src/missing.js' };
    assert.equal(verifyAnchor(anchor, DIFF), 'unverifiable');
  });
  it('returns unverifiable when diffText is empty/absent', () => {
    assert.equal(verifyAnchor(HEAD_ANCHOR, ''), 'unverifiable');
  });
  it('returns fabricated for a schema-invalid anchor (e.g. bad line ordering)', () => {
    assert.equal(verifyAnchor({ ...HEAD_ANCHOR, startLine: 99, endLine: 1 }, DIFF), 'fabricated');
  });
  it('verifies content on an added file (head side only)', () => {
    const anchor = { ...HEAD_ANCHOR, diffPathId: 'src/new.js', oldFile: null, newFile: 'src/new.js', fileStatus: 'added', side: 'head', quote: 'export function bar() {}' };
    assert.equal(verifyAnchor(anchor, DIFF), 'verified');
  });
  it('verifies content on a deleted file (base side only)', () => {
    const anchor = { ...HEAD_ANCHOR, diffPathId: 'src/gone.js', oldFile: 'src/gone.js', newFile: null, fileStatus: 'deleted', side: 'base', quote: 'export function baz() {}' };
    assert.equal(verifyAnchor(anchor, DIFF), 'verified');
  });
  it('verifies a renamed anchor whose oldFile AND newFile both match the diff section', () => {
    const anchor = { ...HEAD_ANCHOR, diffPathId: 'src/new-name.js', oldFile: 'src/old-name.js', newFile: 'src/new-name.js', fileStatus: 'renamed', side: 'head', quote: 'return true;' };
    assert.equal(verifyAnchor(anchor, DIFF), 'verified');
  });
  it('rejects a renamed anchor with a fabricated oldFile — the field NOT used to locate the section (audit fix H3 round 2)', () => {
    // side:'head' locates the section via newFile ('src/new-name.js'), which is real —
    // but oldFile is fabricated. Before the round-2 fix, oldFile was never cross-checked
    // against the located section's actual rename-from path.
    const anchor = { ...HEAD_ANCHOR, diffPathId: 'src/new-name.js', oldFile: 'src/totally-fabricated.js', newFile: 'src/new-name.js', fileStatus: 'renamed', side: 'head', quote: 'return true;' };
    assert.equal(verifyAnchor(anchor, DIFF), 'fabricated');
  });
  it('rejects a renamed anchor with a fabricated newFile — the field NOT used to locate the section', () => {
    // side:'base' locates the section via oldFile ('src/old-name.js'), which is real —
    // but newFile is fabricated.
    const anchor = { ...HEAD_ANCHOR, diffPathId: 'src/old-name.js', oldFile: 'src/old-name.js', newFile: 'src/totally-fabricated.js', fileStatus: 'renamed', side: 'base', quote: 'export function renamed() {' };
    assert.equal(verifyAnchor(anchor, DIFF), 'fabricated');
  });
  it('verifies content in a CRLF (\\r\\n) diff — consolidated Gemini gate fix G1', () => {
    const crlfDiff = DIFF.replace(/\n/g, '\r\n');
    assert.equal(verifyAnchor(HEAD_ANCHOR, crlfDiff), 'verified');
  });
  it('a CRLF diff still correctly reports unverifiable (not a false-verified) for a genuinely missing file', () => {
    const crlfDiff = DIFF.replace(/\n/g, '\r\n');
    const anchor = { ...HEAD_ANCHOR, diffPathId: 'src/missing.js', oldFile: 'src/missing.js', newFile: 'src/missing.js' };
    assert.equal(verifyAnchor(anchor, crlfDiff), 'unverifiable');
  });
  it('verifies a quote spanning a blank context line — never falsely fabricated (consolidated Gemini gate fix G1, round 3)', () => {
    // A blank context line normalizes to '', and contentLines.join(' ') would
    // otherwise produce a double space at that join point ('alpha()  beta()')
    // that a single-spaced normalized quote could never match.
    const anchor = { ...HEAD_ANCHOR, diffPathId: 'src/blank-line.js', oldFile: 'src/blank-line.js', newFile: 'src/blank-line.js', side: 'base', quote: 'function alpha() { function beta() {' };
    assert.equal(verifyAnchor(anchor, DIFF), 'verified');
  });
  it('verifies content in a diff with a real UNQUOTED space-containing header (consolidated Gemini gate fix G3, corrected in refactor-evidence-integrity.md)', () => {
    const anchor = { diffPathId: 'path with spaces.js', oldFile: 'path with spaces.js', newFile: 'path with spaces.js', fileStatus: 'modified', side: 'head', startLine: 1, endLine: 1, quote: 'new content', headSha: 'abc123' };
    assert.equal(verifyAnchor(anchor, UNQUOTED_SPACE_DIFF), 'verified');
  });
  it('verifies content in a diff with a genuinely-quoted header (embedded `"`, a real must-quote trigger)', () => {
    const anchor = { diffPathId: 'quo"te.js', oldFile: 'quo"te.js', newFile: 'quo"te.js', fileStatus: 'modified', side: 'head', startLine: 1, endLine: 1, quote: 'new content', headSha: 'abc123' };
    assert.equal(verifyAnchor(anchor, QUOTED_PATH_DIFF), 'verified');
  });
});

// ── unquoteGitPath — pure C-style git path decoder (refactor-evidence-integrity.md §4.1) ──
describe('unquoteGitPath', () => {
  it('returns an unquoted token verbatim (no decoding attempted)', () => {
    assert.equal(unquoteGitPath('a/plain/path.js'), 'a/plain/path.js');
  });

  it('decodes simple backslash escapes: \\t \\n \\\\ \\"', () => {
    assert.equal(unquoteGitPath('"a\\tb"'), 'a\tb');
    assert.equal(unquoteGitPath('"a\\nb"'), 'a\nb');
    assert.equal(unquoteGitPath('"a\\\\b"'), 'a\\b');
    assert.equal(unquoteGitPath('"a\\"b"'), 'a"b');
  });

  it('decodes an octal escape as BYTES, not per-character (the mojibake trap)', () => {
    // \303\251 is the two-byte UTF-8 sequence for 'é'. A char-wise
    // String.fromCharCode(parseInt(o,8)) decode would yield 'Ã©' — measured
    // wrong output this plan explicitly guards against.
    assert.equal(unquoteGitPath('"src/caf\\303\\251.js"'), 'src/café.js');
  });

  it('decodes a mix of literal characters and octal escapes in one token', () => {
    assert.equal(unquoteGitPath('"caf\\303\\251-bar.js"'), 'café-bar.js');
  });

  it('a trailing lone backslash (right before the closing quote) is malformed → null', () => {
    // Runtime value: `"ab\"` — five characters: quote, a, b, backslash, quote.
    // The backslash has nothing to escape within the token content.
    assert.equal(unquoteGitPath('"ab\\"'), null);
  });

  it('an unknown escape letter (\\8) is malformed → null', () => {
    assert.equal(unquoteGitPath('"a\\8b"'), null);
  });

  it('an invalid UTF-8 byte sequence (lone \\377) → null', () => {
    assert.equal(unquoteGitPath('"\\377"'), null);
  });

  it('rejects an embedded NUL byte (\\000) → null', () => {
    assert.equal(unquoteGitPath('"a\\000b"'), null);
  });

  it('a BOM (\\357\\273\\277) is RETAINED, not stripped — the ignoreBOM regression case', () => {
    // Reachable specifically via a rename/copy token, which carries no a/b
    // prefix, so the BOM can sit at byte 0. Without ignoreBOM:true, WHATWG
    // TextDecoder silently strips a leading BOM.
    const decoded = unquoteGitPath('"\\357\\273\\277rest.js"');
    assert.equal(decoded, '﻿rest.js');
    assert.equal(decoded.codePointAt(0), 0xfeff);
  });

  it('a decoded U+FFFD (\\357\\277\\275) is ACCEPTED — the guard is on raw provenance, not the character', () => {
    const decoded = unquoteGitPath('"\\357\\277\\275name.js"');
    assert.equal(decoded, '�name.js');
  });

  it('an unterminated quoted token (no closing quote at all) fails closed → null, never a mis-sliced guess (round-1 code-audit M5)', () => {
    // Rule 2 (rename/copy) hands unquoteGitPath a raw line slice with no
    // prior termination check, unlike Rule 1's readQuotedHeaderToken-
    // validated tokens — this function must not assume its precondition.
    assert.equal(unquoteGitPath('"abc'), null);
  });

  it('trailing content AFTER the real closing quote fails closed → null', () => {
    assert.equal(unquoteGitPath('"abc"def'), null);
  });
});

// ── resolveHeaderPaths — the four-rule header grammar (§2 decision 5) ───────
describe('resolveHeaderPaths', () => {
  it('rule 1: both sides quoted, octal-escaped UTF-8', () => {
    const part = 'diff --git "a/src/caf\\303\\251.js" "b/src/caf\\303\\251.js"\nindex a..b 100644\n';
    assert.deepEqual(resolveHeaderPaths(part), { oldPath: 'src/café.js', newPath: 'src/café.js' });
  });

  it('rule 1: one-side-quoted (old quoted, new unquoted)', () => {
    const part = 'diff --git "a/quo\\"te.js" b/quote.js\nindex a..b 100644\n';
    assert.deepEqual(resolveHeaderPaths(part), { oldPath: 'quo"te.js', newPath: 'quote.js' });
  });

  it('rule 1: one-side-quoted (old unquoted, new quoted)', () => {
    const part = 'diff --git a/quote.js "b/quo\\"te.js"\nindex a..b 100644\n';
    assert.deepEqual(resolveHeaderPaths(part), { oldPath: 'quote.js', newPath: 'quo"te.js' });
  });

  it('the real unquoted-space header git actually emits (not the old, disproven quoted-space fixture)', () => {
    const part = 'diff --git a/path with spaces.js b/path with spaces.js\nindex a..b 100644\n';
    assert.deepEqual(resolveHeaderPaths(part), { oldPath: 'path with spaces.js', newPath: 'path with spaces.js' });
  });

  it('defect #3 regression pin: an unquoted header containing the literal substring " b/" resolves correctly on BOTH sides, never mis-split at the first occurrence', () => {
    const part = 'diff --git a/x b/y.js b/x b/y.js\nindex a..b 100644\n';
    assert.deepEqual(resolveHeaderPaths(part), { oldPath: 'x b/y.js', newPath: 'x b/y.js' });
  });

  it('rule 2: a rename block reads paths from rename from/rename to, not the ambiguous header line', () => {
    const part = 'diff --git a/old-name.js b/new-name.js\nsimilarity index 95%\nrename from old-name.js\nrename to new-name.js\nindex a..b 100644\n--- a/old-name.js\n+++ b/new-name.js\n';
    assert.deepEqual(resolveHeaderPaths(part), { oldPath: 'old-name.js', newPath: 'new-name.js' });
  });

  it('rule 2: a copy block reads paths from copy from/copy to', () => {
    const part = 'diff --git a/orig.js b/copy.js\nsimilarity index 100%\ncopy from orig.js\ncopy to copy.js\nindex a..b 100644\n--- a/orig.js\n+++ b/copy.js\n';
    assert.deepEqual(resolveHeaderPaths(part), { oldPath: 'orig.js', newPath: 'copy.js' });
  });

  it('rule 2: a rename block whose endpoints are themselves quoted decodes correctly (no a/b transport prefix on these tokens)', () => {
    const part = 'diff --git "a/caf\\303\\251-old.js" "b/caf\\303\\251-new.js"\nsimilarity index 90%\nrename from "caf\\303\\251-old.js"\nrename to "caf\\303\\251-new.js"\nindex a..b 100644\n';
    assert.deepEqual(resolveHeaderPaths(part), { oldPath: 'café-old.js', newPath: 'café-new.js' });
  });

  it('rule 2 prelude bound: a HUNK BODY line reading "rename from …" must NOT be treated as metadata', () => {
    const part = 'diff --git a/x.js b/x.js b/x.js\nindex a..b 100644\n--- a/x.js\n+++ b/x.js\n@@ -1,1 +1,1 @@\n-rename from fake.js\n+rename to fake2.js\n';
    // Not a real rename (no rename from/to in the prelude) and not symmetric
    // (old !== new per the header) — must fail closed, never bind from the
    // hunk body text.
    assert.equal(resolveHeaderPaths(part), null);
  });

  it('rule 2: an incomplete pair (rename from with no rename to) falls through, never binds a path', () => {
    // old !== new, so rule 3 (symmetric) cannot rescue this — an incomplete
    // rename pair must genuinely fail closed, not fall back to a guess.
    const part = 'diff --git a/old.js b/new.js\nrename from old.js\nindex a..b 100644\n';
    assert.equal(resolveHeaderPaths(part), null);
  });

  it('rule 2: a duplicated rename from falls through', () => {
    const part = 'diff --git a/old.js b/new.js\nrename from old.js\nrename from also-old.js\nrename to new.js\nindex a..b 100644\n';
    assert.equal(resolveHeaderPaths(part), null);
  });

  it('rule 2: mixed rename from + copy to falls through, never binds a path', () => {
    const part = 'diff --git a/old.js b/new.js\nrename from old.js\ncopy to new.js\nindex a..b 100644\n';
    assert.equal(resolveHeaderPaths(part), null);
  });

  it('rule 3: CRLF (\\r\\n) throughout does not break resolution (the G1 regression must not return)', () => {
    const part = 'diff --git a/foo.js b/foo.js\r\nindex a..b 100644\r\n--- a/foo.js\r\n+++ b/foo.js\r\n';
    assert.deepEqual(resolveHeaderPaths(part), { oldPath: 'foo.js', newPath: 'foo.js' });
  });

  it('a header no rule resolves (genuinely asymmetric, unquoted, no rename/copy metadata) → null', () => {
    const part = 'diff --git a/left.js b/right.js\nindex a..b 100644\n';
    assert.equal(resolveHeaderPaths(part), null);
  });

  it('a literal U+FFFD in an unquoted raw header token fails closed → null (§4.1a ingress-corruption guard)', () => {
    const part = 'diff --git a/�name.js b/�name.js\nindex a..b 100644\n';
    assert.equal(resolveHeaderPaths(part), null);
  });
});

// ── parseAllDiffSections — pathDecodeFailed sections (§4.2) ─────────────────
describe('parseAllDiffSections — pathDecodeFailed sections', () => {
  it('a header no rule resolves yields a pathDecodeFailed section with null paths, not silent omission', () => {
    const diffText = 'diff --git a/left.js b/right.js\nindex a..b 100644\n--- a/left.js\n+++ b/right.js\n';
    const sections = parseAllDiffSections(diffText);
    assert.equal(sections.length, 1, 'the section is still emitted, not dropped');
    assert.equal(sections[0].pathDecodeFailed, true);
    assert.equal(sections[0].oldPath, null);
    assert.equal(sections[0].newPath, null);
    assert.equal(sections[0].fileStatus, 'modified');
  });

  it('a resolvable header yields a normal (non-pathDecodeFailed) section', () => {
    const sections = parseAllDiffSections(DIFF);
    assert.ok(sections.length > 0);
    for (const s of sections) assert.equal(s.pathDecodeFailed, undefined);
  });

  it('leading preamble text before the first "diff --git" line is skipped, not mistaken for a section', () => {
    const diffText = 'some preamble text\n' + DIFF;
    const sections = parseAllDiffSections(diffText);
    assert.deepEqual(sections.map((s) => s.newPath), parseAllDiffSections(DIFF).map((s) => s.newPath));
  });
});

describe('tagPreExisting — two-check gate (round-1 finding #3)', () => {
  const citation = { file: 'src/old.js', startLine: 5, endLine: 5 };
  it('returns pre_existing_independent only when BOTH checks pass', () => {
    const tag = tagPreExisting(citation, { blameAdapter: () => true, impactAdapter: () => true });
    assert.equal(tag, 'pre_existing_independent');
  });
  it('returns unknown when blame passes but impact-independence fails (load-bearing)', () => {
    const tag = tagPreExisting(citation, { blameAdapter: () => true, impactAdapter: () => false });
    assert.equal(tag, 'unknown');
  });
  it('returns unknown when blame fails, regardless of impact result', () => {
    const tag = tagPreExisting(citation, { blameAdapter: () => false, impactAdapter: () => true });
    assert.equal(tag, 'unknown');
  });
  it('returns unknown when blame is null (blame failure — shallow clone/rename/merge)', () => {
    const tag = tagPreExisting(citation, { blameAdapter: () => null, impactAdapter: () => true });
    assert.equal(tag, 'unknown');
  });
  it('returns unknown when adapters are absent entirely', () => {
    assert.equal(tagPreExisting(citation, {}), 'unknown');
  });
});

// AuditCandidateEnvelope merge contract (mergeIntoEnvelopes/promoteAlternative)
// moved to tests/candidate-envelope-provenance.test.mjs (arch-audit-pipeline-
// observability-hardening.md item 13) — that module (candidate-envelope.mjs)
// is a separate production concern from this file's Stage-0 evidence triage.

// ── Stage-0 result matrix (evidence-anchor-path-contract §7a, 2026-07-17) ────
// The bug this pins: `resolveAnchorLocation` returned one word — `fabricated`,
// i.e. "the model hallucinated this" — for FIVE causes, two of which are our
// own contract failing to parse a claim it never evaluated. Measured on a real
// Sonnet run: 4/4 candidates rejected `fabricated`, 4/4 malformed by OUR
// schema, 0/4 genuine fabrications. A metric that cannot tell "we broke the
// contract" from "the model lied" cannot detect its own bugs — and didn't, for
// weeks (stage0Verified > 0 in 1 of 62 completed shadow runs).
describe('resolveAnchorLocation — the three failure classes are distinct (§7a matrix)', () => {
  it('malformed: a schema-invalid anchor is OUR contract bug, never `unsupported`/`contradicted`', () => {
    // The exact live shape: fileStatus 'modified' with oldFile omitted. The
    // quote below is REAL and verbatim from DIFF — proving the verdict is
    // about our schema, not about the evidence.
    const { oldFile, ...noOldFile } = HEAD_ANCHOR;
    const r = resolveAnchorLocation(noOldFile, DIFF, null);
    assert.equal(r.status, 'malformed');
    assert.match(r.reasonDetail, /oldFile/, 'must name the field so a recurrence is diagnosable from telemetry alone');
  });

  it('contradicted: well-formed, but the diff disproves the claimed fileStatus', () => {
    const anchor = { ...HEAD_ANCHOR, fileStatus: 'added' }; // DIFF shows it modified
    const r = resolveAnchorLocation(anchor, DIFF, null);
    assert.equal(r.status, 'contradicted');
    assert.match(r.reasonDetail, /fileStatus/);
  });

  it('unsupported: well-formed and consistent, but the quote is not in the diff — a GENUINE fabrication', () => {
    const r = resolveAnchorLocation({ ...HEAD_ANCHOR, quote: 'never appears anywhere' }, DIFF, null);
    assert.equal(r.status, 'unsupported');
  });

  it('unverifiable is unchanged — file absent from the diff still gets the benefit of the doubt', () => {
    const anchor = { ...HEAD_ANCHOR, diffPathId: 'src/nope.js', oldFile: 'src/nope.js', newFile: 'src/nope.js' };
    assert.equal(resolveAnchorLocation(anchor, DIFF, null).status, 'unverifiable');
  });

  it('in_hunk is unchanged for a real verbatim quote', () => {
    assert.equal(resolveAnchorLocation(HEAD_ANCHOR, DIFF, null).status, 'in_hunk');
  });

  it('ANCHOR_FAILURE_STATUSES is the single source of truth for "no usable location"', () => {
    assert.deepEqual([...ANCHOR_FAILURE_STATUSES].sort(), ['contradicted', 'malformed', 'unsupported']);
    // A success status must never be in the failure set — the bug shape where a
    // consumer's hardcoded list silently diverges from the resolver.
    for (const ok of ['in_hunk', 'outside_hunk_in_head', 'unverifiable']) {
      assert.ok(!ANCHOR_FAILURE_STATUSES.includes(ok), `${ok} must not be a failure status`);
    }
  });
});

describe('runStage0EvidenceTriage — malformed is a distinct bucket (§7a, D4)', () => {
  function mkEnv(finding, sourceModel = 'gpt') {
    return createEnvelope({ ...finding, _fingerprint: 'fp' }, { sourceModel, pass: 'backend' });
  }

  it('a malformed candidate lands in `malformed`, NOT `rejected` — attribution, not routing', () => {
    const { oldFile, ...noOldFile } = HEAD_ANCHOR;
    const env = mkEnv({ evidenceType: 'commission', anchor: noOldFile });
    const { verified, rejected, malformed } = runStage0EvidenceTriage([env], { diffText: DIFF }, {});
    assert.equal(malformed.length, 1, 'our contract bug is its own bucket');
    assert.equal(rejected.length, 0, 'must NOT be blamed on the model');
    // D4 / INC-001: still not permissive — its quote was never content-verified.
    assert.equal(verified.length, 0, 'malformed must never reach the Stage-1 eligible pool');
    assert.equal(malformed[0].stageDecisions[0].outcome, 'malformed');
    assert.equal(malformed[0].stageDecisions[0].reasonCode, 'commission_anchor_malformed_anchor');
  });

  it('a genuinely fabricated quote still lands in `rejected` — the model IS to blame there', () => {
    const env = mkEnv({ evidenceType: 'commission', anchor: { ...HEAD_ANCHOR, quote: 'never appears' } });
    const { rejected, malformed } = runStage0EvidenceTriage([env], { diffText: DIFF }, {});
    assert.equal(rejected.length, 1);
    assert.equal(malformed.length, 0);
    assert.equal(rejected[0].stageDecisions[0].reasonCode, 'commission_anchor_quote_not_found');
  });

  it('every candidate lands in exactly one bucket — none silently vanishes', () => {
    const { oldFile, ...noOldFile } = HEAD_ANCHOR;
    const envs = [
      mkEnv({ evidenceType: 'commission', anchor: HEAD_ANCHOR }),                                  // in_hunk
      mkEnv({ evidenceType: 'commission', anchor: { ...HEAD_ANCHOR, quote: 'never appears' } }),   // unsupported
      mkEnv({ evidenceType: 'commission', anchor: noOldFile }),                                    // malformed
    ];
    const r = runStage0EvidenceTriage(envs, { diffText: DIFF }, {});
    const total = r.verified.length + r.rejected.length + r.malformed.length + r.preExistingIndependent.length;
    assert.equal(total, envs.length, 'envelope-unit partition must balance');
  });
});

describe('runStage0EvidenceTriage — evidenceType branch (Gemini gate round-1 finding #G4)', () => {
  function makeEnvelope(finding, sourceModel = 'gpt') {
    return createEnvelope({ ...finding, _fingerprint: 'fp' }, { sourceModel, pass: 'backend' });
  }

  it('omission claims verify their triggerAnchor (audit fix H3 — the trigger IS a commission-type fact)', () => {
    const envelope = makeEnvelope({ evidenceType: 'omission', triggerAnchor: HEAD_ANCHOR, causalChain: 'x -> y -> z -> absent' });
    const { verified, rejected } = runStage0EvidenceTriage([envelope], { diffText: DIFF }, {});
    assert.equal(verified.length, 1);
    assert.equal(rejected.length, 0);
    assert.equal(verified[0].stageDecisions[0].reasonCode, 'omission_trigger_content_verified');
  });

  it('omission claims with a fabricated triggerAnchor and no valid alternative are rejected', () => {
    const envelope = makeEnvelope({ evidenceType: 'omission', triggerAnchor: { ...HEAD_ANCHOR, quote: 'never appears' }, causalChain: 'x -> y -> z -> absent' });
    const { verified, rejected } = runStage0EvidenceTriage([envelope], { diffText: DIFF }, {});
    assert.equal(verified.length, 0);
    assert.equal(rejected.length, 1);
  });

  it('omission claims with an unverifiable triggerAnchor (file not in diff) still escalate, never rejected', () => {
    const envelope = makeEnvelope({
      evidenceType: 'omission',
      triggerAnchor: { ...HEAD_ANCHOR, diffPathId: 'src/nope.js', oldFile: 'src/nope.js', newFile: 'src/nope.js' },
      causalChain: 'x -> y -> z -> absent',
    });
    const { verified, rejected } = runStage0EvidenceTriage([envelope], { diffText: DIFF }, {});
    assert.equal(rejected.length, 0);
    assert.equal(verified.length, 1);
    assert.equal(verified[0].stageDecisions[0].outcome, 'unverifiable');
  });

  it('commission with a verified anchor becomes verified', () => {
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor: HEAD_ANCHOR });
    const { verified, rejected } = runStage0EvidenceTriage([envelope], { diffText: DIFF }, {});
    assert.equal(verified.length, 1);
    assert.equal(rejected.length, 0);
    assert.equal(verified[0].stageDecisions[0].outcome, 'verified');
  });

  it('commission with a fabricated anchor and NO valid alternative is rejected (local telemetry only)', () => {
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor: { ...HEAD_ANCHOR, quote: 'never appears' } });
    const { verified, rejected } = runStage0EvidenceTriage([envelope], { diffText: DIFF }, {});
    assert.equal(verified.length, 0);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].stageDecisions[0].outcome, 'rejected');
    // §7a: the reasonCode now names the CLASS. This case is a real fabrication
    // (well-formed anchor, quote absent), so it is `quote_not_found` — the old
    // `_fabricated_all_alternatives_failed` could not distinguish this from our
    // own schema failing to parse the claim.
    assert.equal(rejected[0].stageDecisions[0].reasonCode, 'commission_anchor_quote_not_found');
  });

  it('rejects an anchor whose claimed fileStatus mismatches the diff (audit fix H3 — metadata cross-check)', () => {
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor: { ...HEAD_ANCHOR, fileStatus: 'added', side: 'head' } });
    // HEAD_ANCHOR's file (src/foo.js) is 'modified' in DIFF, not 'added' — the
    // anchor's OWN claim disagrees with what the diff actually shows.
    const { verified, rejected } = runStage0EvidenceTriage([envelope], { diffText: DIFF }, {});
    assert.equal(verified.length, 0);
    assert.equal(rejected.length, 1);
  });

  it('verifies a multi-line quote spanning more than one diff line WITHIN one hunk (audit fix H3/M11)', () => {
    const multiLineAnchor = { ...HEAD_ANCHOR, quote: 'await db.insert(a); return a;' };
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor: multiLineAnchor });
    const { verified, rejected } = runStage0EvidenceTriage([envelope], { diffText: DIFF }, {});
    assert.equal(rejected.length, 0);
    assert.equal(verified.length, 1);
    assert.equal(verified[0].stageDecisions[0].outcome, 'verified');
  });

  it('REJECTS a quote whose words only appear split across TWO SEPARATE hunks (audit fix H4 round 2 — a real bug in the round-1 fix)', () => {
    // "newAlpha" is in hunk 1, "newBeta" is in hunk 2, of the SAME file. They
    // never appear adjacent in any real version of the file. A quote
    // stitching them together must be treated as fabricated, not verified.
    const crossHunkAnchor = {
      diffPathId: 'src/two-hunks.js', oldFile: 'src/two-hunks.js', newFile: 'src/two-hunks.js',
      fileStatus: 'modified', side: 'head', startLine: 6, endLine: 41,
      quote: 'return newAlpha; return newBeta;', headSha: 'abc123',
    };
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor: crossHunkAnchor });
    const { verified, rejected } = runStage0EvidenceTriage([envelope], { diffText: DIFF }, {});
    assert.equal(verified.length, 0);
    assert.equal(rejected.length, 1);
  });

  it('verifies a quote that IS genuinely contiguous within a single later hunk', () => {
    const anchor = {
      diffPathId: 'src/two-hunks.js', oldFile: 'src/two-hunks.js', newFile: 'src/two-hunks.js',
      fileStatus: 'modified', side: 'head', startLine: 41, endLine: 41,
      quote: 'return newBeta;', headSha: 'abc123',
    };
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor });
    const { verified, rejected } = runStage0EvidenceTriage([envelope], { diffText: DIFF }, {});
    assert.equal(rejected.length, 0);
    assert.equal(verified.length, 1);
  });

  it('envelope-aware fallback: a fabricated canonical anchor is rescued by a verified alternative (Gemini gate round-2 #G1)', () => {
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor: { ...HEAD_ANCHOR, quote: 'never appears' } });
    envelope.evidenceAlternatives.push({
      sourceModel: 'gemini', evidenceType: 'commission', anchor: HEAD_ANCHOR, triggerAnchor: null, causalChain: null, rawDetail: 'gemini saw it correctly',
    });
    const { verified, rejected } = runStage0EvidenceTriage([envelope], { diffText: DIFF }, {});
    assert.equal(rejected.length, 0);
    assert.equal(verified.length, 1);
    assert.equal(verified[0].canonicalFinding.anchor.quote, HEAD_ANCHOR.quote);
    // the original (failed) claim is demoted, never discarded
    assert.ok(verified[0].evidenceAlternatives.some((a) => a.verificationFailed));
  });

  it('a finding with no anchor at all (unverifiable) is NOT rejected — escalates instead (never silently dropped)', () => {
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor: { ...HEAD_ANCHOR, diffPathId: 'src/nope.js', oldFile: 'src/nope.js', newFile: 'src/nope.js' } });
    const { verified, rejected } = runStage0EvidenceTriage([envelope], { diffText: DIFF }, {});
    assert.equal(rejected.length, 0);
    assert.equal(verified.length, 1);
    assert.equal(verified[0].stageDecisions[0].outcome, 'unverifiable');
  });
});

// ── runStage0EvidenceTriage sets a VERIFIED _primaryLine (2026-07-26) ───────
// The end-to-end proof: `_primaryLine` reaching `envelope.canonicalFinding` is
// what makes it survive `flattenEnvelopeToFinding`'s later `{...canonicalFinding}`
// spread (candidate-envelope.mjs) into the finding tiered-shadow-compare.mjs's
// `findingLine()` actually reads — and that reader needs ZERO changes, because
// it already checks `_primaryLine` first (its own doc comment always has).
// Before this fix: a census of this repo's OWN real tiered_shadow_observations
// found `tieredUnlocalizedCount === tieredFindingCount` on every one of 10
// historical rows — 100% unlocalized, always. These tests are the "after".
describe('runStage0EvidenceTriage — sets a VERIFIED _primaryLine, not the model\'s claim (2026-07-26)', () => {
  function makeEnvelope(finding, sourceModel = 'gpt') {
    return createEnvelope({ ...finding, _fingerprint: 'fp' }, { sourceModel, pass: 'backend' });
  }

  it('in_hunk: the envelope carries the REAL line (11), not HEAD_ANCHOR\'s own wrong self-report (12)', () => {
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor: HEAD_ANCHOR });
    const { verified } = runStage0EvidenceTriage([envelope], { diffText: DIFF }, {});
    assert.equal(verified.length, 1);
    assert.equal(verified[0].canonicalFinding._primaryLine, 11);
  });

  it('outside_hunk_in_head: the envelope carries the real HEAD-file line via Gate B', () => {
    const anchor = { ...HEAD_ANCHOR, quote: 'return 42;', startLine: 999, endLine: 999 };
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor });
    const { verified, preExistingIndependent } = runStage0EvidenceTriage(
      [envelope], { diffText: DIFF },
      { headContentAdapter: () => FOO_HEAD_CONTENT },
    );
    const result = [...verified, ...preExistingIndependent][0];
    assert.ok(result, 'precondition: the candidate reached one of the two success buckets');
    assert.equal(result.canonicalFinding._primaryLine, 2, '"return 42;" is the 2nd line of FOO_HEAD_CONTENT');
  });

  it('unverifiable candidates never get a fabricated _primaryLine', () => {
    const envelope = makeEnvelope({
      evidenceType: 'commission',
      anchor: { ...HEAD_ANCHOR, diffPathId: 'src/nope.js', oldFile: 'src/nope.js', newFile: 'src/nope.js' },
    });
    const { verified } = runStage0EvidenceTriage([envelope], { diffText: DIFF }, {});
    assert.equal(verified.length, 1);
    assert.equal(verified[0].stageDecisions[0].outcome, 'unverifiable');
    assert.equal(verified[0].canonicalFinding._primaryLine, undefined, 'no verified evidence exists — never guess a line');
  });

  it('a promoted alternative still gets its own real line, not the original failed anchor\'s', () => {
    // The CANONICAL anchor is fabricated; the alternative (a different quote,
    // same file) is real and verified. promoteAlternative swaps canonicalFinding
    // to a NEW object — this proves _primaryLine-setting still reaches it
    // (mutating through the fresh reference resolveWithFallback returns).
    const failedAnchor = { ...HEAD_ANCHOR, quote: 'this text never appears' };
    const goodAlternative = { ...HEAD_ANCHOR, quote: 'const a = 1;' }; // real HEAD line 10
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor: failedAnchor });
    envelope.evidenceAlternatives = [{
      sourceModel: 'gpt2', evidenceType: 'commission', anchor: goodAlternative,
      triggerAnchor: null, causalChain: null, rawDetail: 'the alt', verificationFailed: false,
    }];
    const { verified, rejected } = runStage0EvidenceTriage([envelope], { diffText: DIFF }, {});
    assert.equal(rejected.length, 0, 'precondition: the alternative rescues this candidate');
    assert.equal(verified.length, 1);
    assert.equal(verified[0].canonicalFinding._primaryLine, 10);
  });
});

// Full current content of src/foo.js — note "return 42;" inside unrelated()
// is genuinely pre-existing content, outside any diff hunk entirely, unlike
// anything DIFF's hunk for src/foo.js shows.
const FOO_HEAD_CONTENT = `function unrelated() {
  return 42;
}

function foo() {
  const a = 1;
  await db.insert(a);
  return a;
}
`;

describe('resolveAnchorLocation — Gate A (docs/plans/stage0-evidence-relevance-split.md)', () => {
  it('returns in_hunk when the quote is found within a diff hunk', () => {
    const r = resolveAnchorLocation(HEAD_ANCHOR, DIFF, FOO_HEAD_CONTENT);
    assert.equal(r.status, 'in_hunk');
  });

  it('returns outside_hunk_in_head with a matched line range when the quote is real but not in any hunk', () => {
    const anchor = { ...HEAD_ANCHOR, quote: 'return 42;', startLine: 2, endLine: 2 };
    const r = resolveAnchorLocation(anchor, DIFF, FOO_HEAD_CONTENT);
    assert.equal(r.status, 'outside_hunk_in_head');
    assert.deepEqual(r.headLineRange, { startLine: 2, endLine: 2 });
    assert.ok(Array.isArray(r.hunks));
  });

  it('returns a correct multi-line headLineRange for a quote spanning several lines', () => {
    const multiLine = 'function unrelated() {\n  return 42;\n}';
    const anchor = { ...HEAD_ANCHOR, quote: multiLine, startLine: 1, endLine: 3 };
    const r = resolveAnchorLocation(anchor, DIFF, FOO_HEAD_CONTENT);
    assert.equal(r.status, 'outside_hunk_in_head');
    assert.deepEqual(r.headLineRange, { startLine: 1, endLine: 3 });
  });

  it('returns unverifiable when the file is not in the diff at all', () => {
    const anchor = { ...HEAD_ANCHOR, diffPathId: 'src/missing.js', oldFile: 'src/missing.js', newFile: 'src/missing.js' };
    const r = resolveAnchorLocation(anchor, DIFF, FOO_HEAD_CONTENT);
    assert.equal(r.status, 'unverifiable');
  });

  it('returns unsupported when the quote is nowhere — not in a hunk, not in headContent', () => {
    // §7a rename: `fabricated` -> `unsupported`. Same behaviour, honest name —
    // the anchor parsed fine and its metadata matched; only the evidence is
    // missing, which IS a model fabrication and is now the bucket's ONLY meaning.
    const anchor = { ...HEAD_ANCHOR, quote: 'this text does not exist anywhere' };
    const r = resolveAnchorLocation(anchor, DIFF, FOO_HEAD_CONTENT);
    assert.equal(r.status, 'unsupported');
  });

  it('does not attempt the HEAD-fallback for a base-side anchor (discovery never saw base content)', () => {
    const anchor = { ...HEAD_ANCHOR, side: 'base', quote: 'return 42;', startLine: 2, endLine: 2 };
    // 'return 42;' is real HEAD content but this is a base-side anchor — it
    // has no hunk match either (the hunk's base side is "return a;"), so it
    // must be unsupported, never outside_hunk_in_head.
    const r = resolveAnchorLocation(anchor, DIFF, FOO_HEAD_CONTENT);
    assert.equal(r.status, 'unsupported');
  });

  it('never fires the HEAD-fallback when headContent is absent (matches pre-restructure behavior exactly)', () => {
    const anchor = { ...HEAD_ANCHOR, quote: 'return 42;', startLine: 2, endLine: 2 };
    const r = resolveAnchorLocation(anchor, DIFF, null);
    assert.equal(r.status, 'unsupported');
  });

  it('a quote matching TWO distinct locations outside the hunk is ambiguous, never a silent first-match pick (item 11) — now unverifiable per §2 decision 3, not unsupported', () => {
    // "return 42;" appears twice in this content — once inside unrelated()
    // (the case the earlier tests already cover) and again inside a second,
    // near-identical function. Neither is in a diff hunk. Before item 11,
    // findLineRangeInContent returned the FIRST match unconditionally.
    // Superseded by refactor-evidence-integrity.md §2 decision 3 (the
    // attribution fix): the quote WAS found, so this is no longer the
    // model's fault (`unsupported`) — it is `unverifiable`, the same
    // "can't confirm or refute" status already used for a genuinely-missing
    // diff section. See the dedicated test below for the full assertion.
    // Declared range (999) intersects NEITHER real occurrence, so the
    // declaration cannot disambiguate — genuinely ambiguous (a declared
    // range of 2, matching the first occurrence, would legitimately
    // disambiguate under §2 decision 1 and is a different, non-ambiguous case).
    const duplicatedContent = FOO_HEAD_CONTENT + '\n\nfunction alsoUnrelated() {\n  return 42;\n}\n';
    const anchor = { ...HEAD_ANCHOR, quote: 'return 42;', startLine: 999, endLine: 999 };
    const r = resolveAnchorLocation(anchor, DIFF, duplicatedContent);
    assert.equal(r.status, 'unverifiable');
  });

  it('a quote matching exactly ONE location outside the hunk still resolves normally (no false ambiguity)', () => {
    // Sanity check that the ambiguity fix didn't regress the single-match path.
    const anchor = { ...HEAD_ANCHOR, quote: 'return 42;', startLine: 2, endLine: 2 };
    const r = resolveAnchorLocation(anchor, DIFF, FOO_HEAD_CONTENT);
    assert.equal(r.status, 'outside_hunk_in_head');
  });
});

// ── findQuoteLineRangesInHunk — EVERY real, diff-derived range (2026-07-26; ──
// widened to all-matches by docs/plans/refactor-evidence-integrity.md §4.3,
// superseding the removed findQuoteLineInHunk, which broke on the first
// match and could only ever keep the first hunk's location).
// docs/plans/tiered-recall-audit-pipeline.md "Addendum 2026-07-26 (continued)":
// resolveAnchorLocation's 'in_hunk' status has only ever confirmed the quote's
// TEXT is present in the hunk — it never checked the model's claimed line, and
// nothing surfaced ANY location for this, the most common success path, onto
// the final finding. A census of this repo's own real audit findings found
// `_primaryLine` unset on effectively every one. This closes that gap for the
// tiered side, where a VERIFIED line is actually derivable.
describe('findQuoteLineRangesInHunk — every real line, never the model\'s self-reported claim', () => {
  // Matches DIFF's first hunk exactly: `@@ -10,3 +10,4 @@`, head side.
  //   head 10: ' const a = 1;'
  //   head 11: '+  await db.insert(a);'
  //   head 12: '+  return a;'
  //   head 13: ' }'
  const FOO_HUNK = {
    header: { baseStart: 10, baseCount: 3, headStart: 10, headCount: 4 },
    lines: [' const a = 1;', '-  return a;', '+  await db.insert(a);', '+  return a;', ' }'],
  };

  it('finds the REAL head-side line — proves the fix, not just the mechanism: HEAD_ANCHOR self-reports 12, reality is 11', () => {
    // HEAD_ANCHOR (this file's own shared fixture) claims startLine/endLine: 12
    // for this exact quote. That claim was NEVER checked before this fix — the
    // model's self-report is simply wrong, and nothing would have caught it.
    assert.equal(HEAD_ANCHOR.startLine, 12, 'precondition: the fixture\'s own self-reported claim is 12');
    const r = findQuoteLineRangesInHunk(FOO_HUNK, 'await db.insert(a);', 'head');
    assert.deepEqual(r, [{ startLine: 11, endLine: 11 }], 'the VERIFIED line is 11, not the model\'s claimed 12');
  });

  it('finds the real base-side line for a removed line, using baseStart (not headStart)', () => {
    // 'return a;' is REMOVED (base side only) — must resolve via baseStart (10),
    // landing on base line 11, an entirely different counter than the head side.
    const r = findQuoteLineRangesInHunk(FOO_HUNK, 'return a;', 'base');
    assert.deepEqual(r, [{ startLine: 11, endLine: 11 }]);
  });

  it('resolves a multi-line quote to its full real range, not just its start', () => {
    const r = findQuoteLineRangesInHunk(FOO_HUNK, 'await db.insert(a);\n  return a;', 'head');
    assert.deepEqual(r, [{ startLine: 11, endLine: 12 }]);
  });

  it('returns [] when the quote is not on the requested side (base has no "await db.insert")', () => {
    const r = findQuoteLineRangesInHunk(FOO_HUNK, 'await db.insert(a);', 'base');
    assert.deepEqual(r, []);
  });

  it('returns [] when the hunk header failed to parse — never guesses a line from an unparseable anchor', () => {
    const r = findQuoteLineRangesInHunk({ header: null, lines: [' const a = 1;'] }, 'const a = 1;', 'head');
    assert.deepEqual(r, []);
  });

  it('returns [] for a quote genuinely absent from the hunk', () => {
    const r = findQuoteLineRangesInHunk(FOO_HUNK, 'this text is nowhere in the hunk', 'head');
    assert.deepEqual(r, []);
  });

  it('a context line ( ) counts on BOTH sides, at each side\'s own independent counter', () => {
    const headMatch = findQuoteLineRangesInHunk(FOO_HUNK, 'const a = 1;', 'head');
    const baseMatch = findQuoteLineRangesInHunk(FOO_HUNK, 'const a = 1;', 'base');
    assert.deepEqual(headMatch, [{ startLine: 10, endLine: 10 }]);
    assert.deepEqual(baseMatch, [{ startLine: 10, endLine: 10 }], 'same text, same line number on both sides — it is unchanged context');
  });

  it('a blank context line does not corrupt the join (mirrors quoteAppearsOnSide\'s own G1 fix)', () => {
    const hunkWithBlank = {
      header: { baseStart: 1, baseCount: 3, headStart: 1, headCount: 3 },
      lines: [' function alpha() {', ' ', ' function beta() {'],
    };
    // 'alpha() {' + blank + 'function beta' must still match as one span —
    // a double-space from the blank line's naive join must not break it.
    const r = findQuoteLineRangesInHunk(hunkWithBlank, 'alpha() {\n\nfunction beta', 'head');
    assert.deepEqual(r, [{ startLine: 1, endLine: 3 }], 'a quote spanning a blank context line must still resolve');
  });

  it('the SAME quote appearing TWICE in one hunk returns BOTH ranges (the case the old shape could not express)', () => {
    const hunk = {
      header: { baseStart: 1, baseCount: 4, headStart: 1, headCount: 4 },
      lines: ['+dup();', ' unrelated();', '+dup();', ' end();'],
    };
    const r = findQuoteLineRangesInHunk(hunk, 'dup();', 'head');
    assert.deepEqual(r, [{ startLine: 1, endLine: 1 }, { startLine: 3, endLine: 3 }]);
  });
});

describe('selectAnchoredMatch — the single disambiguation seam (§2 decision 1)', () => {
  it('0 matches -> none', () => {
    assert.deepEqual(selectAnchoredMatch([], null), { kind: 'none' });
    assert.deepEqual(selectAnchoredMatch([], { startLine: 5, endLine: 5 }), { kind: 'none' });
  });

  it('1 match -> unique, EVEN with a deliberately WRONG declared range (the declaration is irrelevant here)', () => {
    const only = { startLine: 11, endLine: 11 };
    const r = selectAnchoredMatch([only], { startLine: 999, endLine: 999 });
    assert.deepEqual(r, { kind: 'unique', match: only });
  });

  it('2 matches, declared range intersects EXACTLY ONE -> unique (the declaration did real work)', () => {
    const a = { startLine: 5, endLine: 5 };
    const b = { startLine: 40, endLine: 40 };
    const r = selectAnchoredMatch([a, b], { startLine: 39, endLine: 41 });
    assert.deepEqual(r, { kind: 'unique', match: b });
  });

  it('2 matches, declared range intersects NEITHER -> ambiguous', () => {
    const a = { startLine: 5, endLine: 5 };
    const b = { startLine: 40, endLine: 40 };
    const r = selectAnchoredMatch([a, b], { startLine: 999, endLine: 999 });
    assert.deepEqual(r, { kind: 'ambiguous', count: 2 });
  });

  it('2 matches, declared range intersects BOTH -> ambiguous (a range spanning both is not a disambiguation)', () => {
    const a = { startLine: 5, endLine: 5 };
    const b = { startLine: 6, endLine: 6 };
    const r = selectAnchoredMatch([a, b], { startLine: 1, endLine: 100 });
    assert.deepEqual(r, { kind: 'ambiguous', count: 2 });
  });

  it('2+ matches with declaredRange: null (inadmissible coordinate space) -> ambiguous, never guessed', () => {
    const a = { startLine: 5, endLine: 5 };
    const b = { startLine: 40, endLine: 40 };
    assert.deepEqual(selectAnchoredMatch([a, b], null), { kind: 'ambiguous', count: 2 });
  });
});

describe('formatLocToken / parseLocToken — the §4.4 telemetry token round-trips', () => {
  it('single_match: the declaration is recorded but was not needed', () => {
    const match = { startLine: 11, endLine: 11 };
    const token = formatLocToken({
      side: 'head', declaredRange: { startLine: 12, endLine: 12 },
      matchCount: 1, selection: { kind: 'unique', match },
    });
    assert.equal(token, 'loc/v1 side=head declared=12-12 selected=11-11 outcome=single_match candidates=1');
    assert.deepEqual(parseLocToken(token), { side: 'head', declared: '12-12', selected: '11-11', outcome: 'single_match', candidates: 1 });
  });

  it('range_disambiguated: the declared range picked exactly one of several', () => {
    const match = { startLine: 40, endLine: 40 };
    const token = formatLocToken({
      side: 'head', declaredRange: { startLine: 39, endLine: 41 },
      matchCount: 2, selection: { kind: 'unique', match },
    });
    assert.match(token, /outcome=range_disambiguated candidates=2$/);
    assert.equal(parseLocToken(token).outcome, 'range_disambiguated');
  });

  it('ambiguous, with declared=none for an INADMISSIBLE (side:base) range — inadmissibility is observable, not assumed', () => {
    const token = formatLocToken({
      side: 'base', declaredRange: null, matchCount: 2, selection: { kind: 'ambiguous', count: 2 },
    });
    assert.equal(token, 'loc/v1 side=base declared=none selected=none outcome=ambiguous candidates=2');
    assert.deepEqual(parseLocToken(token), { side: 'base', declared: 'none', selected: 'none', outcome: 'ambiguous', candidates: 2 });
  });

  it('unlocatable: zero candidates', () => {
    const token = formatLocToken({ side: 'head', declaredRange: { startLine: 1, endLine: 1 }, matchCount: 0, selection: { kind: 'none' } });
    assert.equal(token, 'loc/v1 side=head declared=1-1 selected=none outcome=unlocatable candidates=0');
  });

  it('parseLocToken rejects a malformed/foreign string, never throws', () => {
    assert.equal(parseLocToken('not a token'), null);
    assert.equal(parseLocToken(''), null);
    assert.equal(parseLocToken(null), null);
    assert.equal(parseLocToken(undefined), null);
  });
});

describe('resolveAnchorLocation — surfaces the REAL line via verifiedLine (2026-07-26)', () => {
  it('an in_hunk verification now carries the REAL line, correcting the fixture\'s own wrong self-report', () => {
    const r = resolveAnchorLocation(HEAD_ANCHOR, DIFF, FOO_HEAD_CONTENT);
    assert.equal(r.status, 'in_hunk');
    assert.deepEqual(r.verifiedLine, { startLine: 11, endLine: 11 });
  });

  it('a multi-hunk file resolves against the SAME hunk quoteAppearsOnSide verified, never a different one', () => {
    // two-hunks.js has hunk1 @@ -5,2 +5,2 @@ and hunk2 @@ -40,2 +40,2 @@; a quote
    // unique to hunk2 must resolve to hunk2's line numbers, not hunk1's.
    const anchor = {
      diffPathId: 'src/two-hunks.js', oldFile: 'src/two-hunks.js', newFile: 'src/two-hunks.js',
      fileStatus: 'modified', side: 'head', startLine: 999, endLine: 999,
      quote: 'return newBeta;', headSha: 'abc123',
    };
    const r = resolveAnchorLocation(anchor, DIFF, null);
    assert.equal(r.status, 'in_hunk');
    assert.deepEqual(r.verifiedLine, { startLine: 40, endLine: 40 }, 'hunk2 starts at head line 40; its one head-side line is the changed line');
  });

  // ── §9 R2/M2 — the two end-to-end binding cases selector unit tests cannot ──
  // cover, because both failures live in what resolveAnchorLocation PASSES to
  // the selector, not in the selector itself.
  const SAME_QUOTE_TWO_HUNKS = `diff --git a/src/repeat.js b/src/repeat.js
index abc..def 100644
--- a/src/repeat.js
+++ b/src/repeat.js
@@ -5,1 +5,1 @@ function alpha() {
+shared();
@@ -40,1 +40,1 @@ function beta() {
+shared();
`;

  it('cross-hunk collection: the same head-side quote in TWO hunks, declared range intersecting only the LATER one, selects the LATER range (would fail under a first-hunk-wins break)', () => {
    const anchor = {
      diffPathId: 'src/repeat.js', oldFile: 'src/repeat.js', newFile: 'src/repeat.js',
      fileStatus: 'modified', side: 'head', startLine: 40, endLine: 40,
      quote: 'shared();', headSha: 'abc123',
    };
    const r = resolveAnchorLocation(anchor, SAME_QUOTE_TWO_HUNKS, null);
    assert.equal(r.status, 'in_hunk');
    assert.deepEqual(r.verifiedLine, { startLine: 40, endLine: 40 }, 'the declared range (40) must select hunk 2\'s line, not hunk 1\'s (5)');
  });

  const TWO_BASE_OCCURRENCES = `diff --git a/src/dual.js b/src/dual.js
index abc..def 100644
--- a/src/dual.js
+++ b/src/dual.js
@@ -5,1 +5,0 @@ function alpha() {
-shared();
@@ -40,1 +40,0 @@ function beta() {
-shared();
`;

  it('base-side inadmissibility: 2 distinct base-side occurrences with a declared range intersecting exactly one still resolve to in_hunk with verifiedLine: null (proves declaredRange:null was passed, not the HEAD-coordinate declaration)', () => {
    // The declared range (40) is in HEAD-file coordinates (discovery only ever
    // shows HEAD content) but BOTH occurrences here are on the BASE side —
    // an implementation that forwarded the HEAD-coordinate declared range
    // would "successfully" disambiguate to line 40 and FAIL this test.
    const anchor = {
      diffPathId: 'src/dual.js', oldFile: 'src/dual.js', newFile: 'src/dual.js',
      fileStatus: 'modified', side: 'base', startLine: 40, endLine: 40,
      quote: 'shared();', headSha: 'abc123',
    };
    const r = resolveAnchorLocation(anchor, TWO_BASE_OCCURRENCES, null);
    assert.equal(r.status, 'in_hunk', 'verification (quoteAppearsOnSide) still succeeds — the quote IS in the diff');
    assert.equal(r.verifiedLine, null, 'ambiguous with an inadmissible declared range — never a false disambiguation');
  });

  it('HEAD-fallback ambiguity (§2 decision 3): 2 distinct HEAD-only occurrences now resolve to unverifiable, not unsupported', () => {
    const duplicatedContent = FOO_HEAD_CONTENT + '\n\nfunction alsoUnrelated() {\n  return 42;\n}\n';
    // Declared range intersects NEITHER real occurrence — genuinely ambiguous.
    const anchor = { ...HEAD_ANCHOR, quote: 'return 42;', startLine: 999, endLine: 999 };
    const r = resolveAnchorLocation(anchor, DIFF, duplicatedContent);
    assert.equal(r.status, 'unverifiable', 'the quote WAS found — blaming the model for our inability to localise is the misattribution §7a exists to eliminate');
    assert.match(r.reasonDetail, /^loc\/v1 /);
    assert.match(r.reasonDetail, /outcome=ambiguous candidates=2$/);
  });
});

describe('mapHeadLineToBase / mapHeadRangeToBase — diff-derived line mapping (round-2 plan-audit H1)', () => {
  // Two hunks on one file: hunk 1 grows head by 1 line (base 5-6 -> head 5-7),
  // hunk 2 shrinks head by 1 line (base 20-22 -> head 21-22).
  const HUNKS = [
    { header: { baseStart: 5, baseCount: 2, headStart: 5, headCount: 3 }, lines: [] },
    { header: { baseStart: 20, baseCount: 3, headStart: 21, headCount: 2 }, lines: [] },
  ];

  it('maps a line BEFORE the first hunk with zero offset', () => {
    assert.equal(mapHeadLineToBase(3, HUNKS), 3);
  });

  it('returns null for a line WITHIN a hunk (not this function\'s case — that\'s in_hunk)', () => {
    assert.equal(mapHeadLineToBase(6, HUNKS), null);
    assert.equal(mapHeadLineToBase(21, HUNKS), null);
  });

  it('maps a line BETWEEN two hunks using the cumulative offset from the hunk(s) already passed', () => {
    // After hunk 1 (head grew by 1: headCount 3 - baseCount 2 = +1), a head
    // line of 10 maps back to base line 9.
    assert.equal(mapHeadLineToBase(10, HUNKS), 9);
  });

  it('maps a line AFTER all hunks using the total cumulative offset', () => {
    // Net offset across both hunks: (3-2) + (2-3) = 0.
    assert.equal(mapHeadLineToBase(25, HUNKS), 25);
  });

  it('returns null when any hunk header failed to parse — never trusts a partial offset chain', () => {
    const brokenHunks = [{ header: null, lines: [] }, ...HUNKS];
    assert.equal(mapHeadLineToBase(3, brokenHunks), null);
  });

  it('mapHeadRangeToBase requires BOTH endpoints to map and the length to be preserved', () => {
    // [10,25] straddles hunk 2 (offset changes mid-range) — inconsistent
    // mapped length is a real ambiguity, not a guessable answer.
    assert.equal(mapHeadRangeToBase({ startLine: 10, endLine: 25 }, HUNKS), null);
  });

  it('mapHeadRangeToBase returns a consistent range when both endpoints share the same offset', () => {
    // [8,10] is entirely between hunk 1 and hunk 2 — one consistent offset (+1).
    assert.deepEqual(mapHeadRangeToBase({ startLine: 8, endLine: 10 }, HUNKS), { startLine: 7, endLine: 9 });
  });
});

describe('runStage0EvidenceTriage — Gate B relevance classification (docs/plans/stage0-evidence-relevance-split.md)', () => {
  function makeEnvelope(finding, sourceModel = 'gpt') {
    return createEnvelope({ ...finding, _fingerprint: 'fp' }, { sourceModel, pass: 'backend' });
  }
  const OUTSIDE_HUNK_ANCHOR = { ...HEAD_ANCHOR, quote: 'return 42;', startLine: 2, endLine: 2 };
  const adapters = (blameAdapter, impactAdapter) => ({
    headContentAdapter: (filePath) => (filePath === 'src/foo.js' ? FOO_HEAD_CONTENT : null),
    blameAdapter, impactAdapter,
  });

  it('a genuinely pre-existing, independent candidate reaches pre_existing_independent — the exact reachability Gemini final-review round-2 G1 found broken', () => {
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor: OUTSIDE_HUNK_ANCHOR });
    const { verified, preExistingIndependent, rejected } = runStage0EvidenceTriage(
      [envelope], { diffText: DIFF },
      adapters(() => true, () => true),
    );
    assert.equal(rejected.length, 0);
    assert.equal(verified.length, 0);
    assert.equal(preExistingIndependent.length, 1);
    assert.equal(preExistingIndependent[0].scopeBucket, 'pre_existing_independent');
  });

  it('predates the commit but a changed file depends on it -> pre_existing_impactful, stays Stage-1-eligible', () => {
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor: OUTSIDE_HUNK_ANCHOR });
    const { verified, preExistingIndependent } = runStage0EvidenceTriage(
      [envelope], { diffText: DIFF },
      adapters(() => true, () => false),
    );
    assert.equal(preExistingIndependent.length, 0);
    assert.equal(verified.length, 1);
    assert.equal(verified[0].scopeBucket, 'pre_existing_impactful');
  });

  it('blame says NOT pre-existing -> change_related, Gate B never even reaches impactAdapter\'s answer mattering', () => {
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor: OUTSIDE_HUNK_ANCHOR });
    const { verified } = runStage0EvidenceTriage(
      [envelope], { diffText: DIFF },
      adapters(() => false, () => true),
    );
    assert.equal(verified.length, 1);
    assert.equal(verified[0].scopeBucket, 'change_related');
  });

  it('blame or impact unknown (null) -> safe default change_related, never independent', () => {
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor: OUTSIDE_HUNK_ANCHOR });
    const { verified, preExistingIndependent } = runStage0EvidenceTriage(
      [envelope], { diffText: DIFF },
      adapters(() => true, () => null),
    );
    assert.equal(preExistingIndependent.length, 0);
    assert.equal(verified.length, 1);
    assert.equal(verified[0].scopeBucket, 'change_related');
  });

  it('in_hunk candidates get scopeBucket change_related WITHOUT Gate B ever running (blameAdapter never called)', () => {
    let blameCalls = 0;
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor: HEAD_ANCHOR });
    const { verified } = runStage0EvidenceTriage(
      [envelope], { diffText: DIFF },
      adapters(() => { blameCalls++; return true; }, () => true),
    );
    assert.equal(verified[0].scopeBucket, 'change_related');
    assert.equal(blameCalls, 0);
  });

  it('runStage0EvidenceTriage calls headContentAdapter — the explicit injection Gemini final-review round-1 G2 required', () => {
    let adapterCalls = 0;
    const envelope = makeEnvelope({ evidenceType: 'commission', anchor: OUTSIDE_HUNK_ANCHOR });
    runStage0EvidenceTriage([envelope], { diffText: DIFF }, {
      headContentAdapter: (filePath) => { adapterCalls++; return filePath === 'src/foo.js' ? FOO_HEAD_CONTENT : null; },
      blameAdapter: () => true, impactAdapter: () => true,
    });
    assert.ok(adapterCalls >= 1);
  });
});

describe('runStage0EvidenceTriage — backward compatibility with the degraded (all-null-adapter) shape', () => {
  // Cluster A (this change) and Cluster B (wiring real adapters into
  // tiered-pipeline.mjs) were declared as SEPARATE, independently
  // fix-gated clusters in docs/plans/stage0-evidence-relevance-split.md —
  // deliberately, so Cluster A's pure logic was independently testable
  // before Cluster B existed. Cluster B has since landed (tiered-pipeline.mjs
  // now wires real `makeBlameAdapter`/`makeImpactAdapter`/
  // `makeHeadContentAdapter` closures — see tests/tiered-pipeline-wiring.test.mjs's
  // static pins), so this is no longer "the current production call site" —
  // but the all-null shape stays a REAL, reachable degraded state (cloud
  // disabled, dirty working tree, or an unreadable file all resolve their
  // respective adapter to a `null`-returning lookup) that must still degrade
  // safely, exactly like the pre-restructure implementation did.
  const CURRENT_PRODUCTION_ADAPTERS = { blameAdapter: () => null, impactAdapter: () => null };

  it('never crashes and never fires the HEAD-fallback when headContentAdapter is absent — degrades to the exact pre-restructure behavior', () => {
    const envelope = createEnvelope(
      { evidenceType: 'commission', anchor: { ...HEAD_ANCHOR, quote: 'return 42;', startLine: 2, endLine: 2 }, _fingerprint: 'fp' },
      { sourceModel: 'gpt', pass: 'backend' },
    );
    const { verified, preExistingIndependent, rejected } = runStage0EvidenceTriage(
      [envelope], { diffText: DIFF }, CURRENT_PRODUCTION_ADAPTERS,
    );
    // 'return 42;' is real content but only reachable via the HEAD-fallback
    // (it's outside every hunk) — with no headContentAdapter, that fallback
    // can never fire, so this is fabricated/rejected, exactly as it was
    // before this restructure existed.
    assert.equal(preExistingIndependent.length, 0);
    assert.equal(verified.length, 0);
    assert.equal(rejected.length, 1);
  });

  it('in-hunk verification is completely unaffected by the missing headContentAdapter', () => {
    const envelope = createEnvelope(
      { evidenceType: 'commission', anchor: HEAD_ANCHOR, _fingerprint: 'fp' },
      { sourceModel: 'gpt', pass: 'backend' },
    );
    const { verified, rejected } = runStage0EvidenceTriage([envelope], { diffText: DIFF }, CURRENT_PRODUCTION_ADAPTERS);
    assert.equal(rejected.length, 0);
    assert.equal(verified.length, 1);
    assert.equal(verified[0].scopeBucket, 'change_related');
  });
});

describe('resolveScopeBucketForFinding — decision #8 (docs/plans/stage0-evidence-relevance-split.md)', () => {
  it('resolves a single origin directly from the manifest', () => {
    const manifest = new Map([['fp1', 'pre_existing_impactful']]);
    assert.equal(resolveScopeBucketForFinding(['fp1'], manifest), 'pre_existing_impactful');
  });

  it('takes the LEAST-restrictive bucket among multiple origins — change_related wins if ANY origin is change_related', () => {
    const manifest = new Map([
      ['fp1', 'pre_existing_independent'],
      ['fp2', 'change_related'],
    ]);
    assert.equal(resolveScopeBucketForFinding(['fp1', 'fp2'], manifest), 'change_related');
  });

  it('pre_existing_impactful beats pre_existing_independent when neither origin is change_related', () => {
    const manifest = new Map([
      ['fp1', 'pre_existing_independent'],
      ['fp2', 'pre_existing_impactful'],
    ]);
    assert.equal(resolveScopeBucketForFinding(['fp1', 'fp2'], manifest), 'pre_existing_impactful');
  });

  it('an empty originCandidateIds array (e.g. a Stage-2 missed_candidate with no Stage 0 origin) defaults to change_related', () => {
    assert.equal(resolveScopeBucketForFinding([], new Map([['fp1', 'pre_existing_independent']])), 'change_related');
  });

  it('an origin id absent from the manifest is skipped, not treated as an error', () => {
    const manifest = new Map([['fp1', 'pre_existing_independent']]);
    assert.equal(resolveScopeBucketForFinding(['unknown-fp'], manifest), 'change_related');
  });

  it('a null/undefined originCandidateIds degrades to the safe default, never throws', () => {
    assert.equal(resolveScopeBucketForFinding(null, new Map()), 'change_related');
    assert.equal(resolveScopeBucketForFinding(undefined, new Map()), 'change_related');
  });
});
