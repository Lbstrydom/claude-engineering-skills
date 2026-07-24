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

const QUOTED_PATH_DIFF = `diff --git "a/path with spaces.js" "b/path with spaces.js"
index 7777777..8888888 100644
--- "a/path with spaces.js"
+++ "b/path with spaces.js"
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
  it('verifies content in a diff with quoted (space-containing) file paths (consolidated Gemini gate fix G3, round 3)', () => {
    const anchor = { diffPathId: 'path with spaces.js', oldFile: 'path with spaces.js', newFile: 'path with spaces.js', fileStatus: 'modified', side: 'head', startLine: 1, endLine: 1, quote: 'new content', headSha: 'abc123' };
    assert.equal(verifyAnchor(anchor, QUOTED_PATH_DIFF), 'verified');
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

  it('a quote matching TWO distinct locations outside the hunk is unsupported (ambiguous), never a silent first-match pick (item 11)', () => {
    // "return 42;" appears twice in this content — once inside unrelated()
    // (the case the earlier tests already cover) and again inside a second,
    // near-identical function. Neither is in a diff hunk. Before item 11,
    // findLineRangeInContent returned the FIRST match unconditionally.
    const duplicatedContent = FOO_HEAD_CONTENT + '\n\nfunction alsoUnrelated() {\n  return 42;\n}\n';
    const anchor = { ...HEAD_ANCHOR, quote: 'return 42;', startLine: 2, endLine: 2 };
    const r = resolveAnchorLocation(anchor, DIFF, duplicatedContent);
    assert.equal(r.status, 'unsupported');
    assert.match(r.reasonDetail, /2 distinct locations/);
  });

  it('a quote matching exactly ONE location outside the hunk still resolves normally (no false ambiguity)', () => {
    // Sanity check that the ambiguity fix didn't regress the single-match path.
    const anchor = { ...HEAD_ANCHOR, quote: 'return 42;', startLine: 2, endLine: 2 };
    const r = resolveAnchorLocation(anchor, DIFF, FOO_HEAD_CONTENT);
    assert.equal(r.status, 'outside_hunk_in_head');
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
