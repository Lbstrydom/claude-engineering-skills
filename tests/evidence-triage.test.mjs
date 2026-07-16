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
  resolveScopeBucketForFinding,
} from '../scripts/lib/audit/evidence-triage.mjs';
import { createEnvelope, mergeIntoEnvelopes, promoteAlternative } from '../scripts/lib/audit/candidate-envelope.mjs';

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

describe('AuditCandidateEnvelope — merge contract (round-2 finding #6)', () => {
  const finding = (overrides) => ({
    id: 'H1', severity: 'MEDIUM', category: 'x', section: 'a.js', detail: 'd', risk: 'r',
    recommendation: 'x', is_quick_fix: false, is_mechanical: false, principle: 'p',
    _fingerprint: 'fp1', _pass: 'backend', ...overrides,
  });

  it('groups findings sharing a fingerprint into ONE envelope', () => {
    const envelopes = mergeIntoEnvelopes([finding({ _sourceModel: 'glm' }), finding({ _sourceModel: 'sonnet' })]);
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].evidenceAlternatives.length, 2);
  });
  it('does NOT group findings with different fingerprints', () => {
    const envelopes = mergeIntoEnvelopes([finding({ _fingerprint: 'fp1' }), finding({ _fingerprint: 'fp2' })]);
    assert.equal(envelopes.length, 2);
  });
  it('envelope severity is the MAXIMUM of contributing severities', () => {
    const envelopes = mergeIntoEnvelopes([
      finding({ severity: 'MEDIUM', _sourceModel: 'a' }),
      finding({ severity: 'HIGH', _sourceModel: 'b' }),
    ]);
    assert.equal(envelopes[0].canonicalFinding.severity, 'HIGH');
  });
  it('preserves ALL contributing evidence, including from the non-canonical (lower-severity) source', () => {
    const envelopes = mergeIntoEnvelopes([
      finding({ severity: 'MEDIUM', _sourceModel: 'a', detail: 'first take' }),
      finding({ severity: 'HIGH', _sourceModel: 'b', detail: 'second take' }),
    ]);
    const details = envelopes[0].evidenceAlternatives.map((e) => e.rawDetail).sort();
    assert.deepEqual(details, ['first take', 'second take']);
  });
  it('keeps evidenceAlternatives[0] pointing at the canonical claim after a severity promotion (consolidated Gemini gate fix G2, round 2)', () => {
    // The module's own JSDoc documents evidenceAlternatives as "Includes the
    // canonical claim too (index 0)" — a later, higher-severity contributor
    // must swap into index 0 when it's promoted, not just get appended.
    const envelopes = mergeIntoEnvelopes([
      finding({ severity: 'MEDIUM', _sourceModel: 'a', detail: 'first take' }),
      finding({ severity: 'HIGH', _sourceModel: 'b', detail: 'second take' }),
    ]);
    assert.equal(envelopes[0].canonicalFinding.severity, 'HIGH');
    assert.equal(envelopes[0].evidenceAlternatives[0].rawDetail, 'second take');
    assert.equal(envelopes[0].evidenceAlternatives[0].sourceModel, 'b');
    // Nothing lost — the demoted lower-severity claim is still present, just not at index 0.
    assert.equal(envelopes[0].evidenceAlternatives[1].rawDetail, 'first take');
  });
  it('keeps index 0 correct across THREE contributors with an intermediate then final promotion', () => {
    const envelopes = mergeIntoEnvelopes([
      finding({ severity: 'LOW', _sourceModel: 'a', detail: 'low take' }),
      finding({ severity: 'MEDIUM', _sourceModel: 'b', detail: 'medium take' }),
      finding({ severity: 'HIGH', _sourceModel: 'c', detail: 'high take' }),
    ]);
    assert.equal(envelopes[0].canonicalFinding.severity, 'HIGH');
    assert.equal(envelopes[0].evidenceAlternatives[0].rawDetail, 'high take');
    const allDetails = envelopes[0].evidenceAlternatives.map((e) => e.rawDetail).sort();
    assert.deepEqual(allDetails, ['high take', 'low take', 'medium take']); // nothing lost across 2 promotions
  });
  it('throws with the offending index rather than silently dropping un-fingerprinted findings (audit fix H4)', () => {
    assert.throws(
      () => mergeIntoEnvelopes([finding(), { ...finding(), _fingerprint: undefined }]),
      /indexes: 1/,
    );
  });
});

describe('promoteAlternative', () => {
  it('promotes an alternative to canonical, demoting the original (never discarding it)', () => {
    const envelope = createEnvelope(
      { detail: 'canonical', evidenceType: 'commission', anchor: { quote: 'bad' }, _fingerprint: 'fp' },
      { sourceModel: 'gpt', pass: 'backend' },
    );
    envelope.evidenceAlternatives.push({ sourceModel: 'gemini', evidenceType: 'commission', anchor: { quote: 'good' }, rawDetail: 'alt' });
    const promoted = promoteAlternative(envelope, 1);
    assert.equal(promoted.canonicalFinding.anchor.quote, 'good');
    assert.equal(promoted.evidenceAlternatives[0].detail, undefined); // original entry shape unchanged (index 0 was never touched)
    assert.equal(promoted.evidenceAlternatives.length, 2); // nothing discarded
  });
  it('is a no-op (returns the same envelope) for an out-of-range index', () => {
    const envelope = createEnvelope({ detail: 'x', _fingerprint: 'fp' }, { sourceModel: 'gpt', pass: 'backend' });
    assert.equal(promoteAlternative(envelope, 99), envelope);
  });
  it('remaps the promoted alt\'s rawDetail onto canonicalFinding.detail — never pairs the FAILED claim\'s prose with the promoted claim\'s anchor (consolidated Gemini gate fix G2)', () => {
    const envelope = createEnvelope(
      { detail: 'the failed model said X is broken', evidenceType: 'commission', anchor: { quote: 'bad' }, _fingerprint: 'fp' },
      { sourceModel: 'gpt', pass: 'backend' },
    );
    envelope.evidenceAlternatives.push({ sourceModel: 'gemini', evidenceType: 'commission', anchor: { quote: 'good' }, rawDetail: 'the successful model says Y is broken' });
    const promoted = promoteAlternative(envelope, 1);
    assert.equal(promoted.canonicalFinding.detail, 'the successful model says Y is broken');
    assert.equal(promoted.canonicalFinding.anchor.quote, 'good');
  });
  it('demotes the ORIGINAL (failed) claim\'s data into the promoted slot — never the successful alt\'s own data (consolidated Gemini gate fix G2)', () => {
    const envelope = createEnvelope(
      { detail: 'the failed model said X is broken', evidenceType: 'commission', anchor: { quote: 'bad-anchor' }, _fingerprint: 'fp' },
      { sourceModel: 'gpt', pass: 'backend' },
    );
    envelope.evidenceAlternatives.push({ sourceModel: 'gemini', evidenceType: 'commission', anchor: { quote: 'good-anchor' }, rawDetail: 'alt detail' });
    const promoted = promoteAlternative(envelope, 1);
    // The promoted alt's OWN slot (index 1, the altIndex) is overwritten with a
    // record representing the OLD (failed) canonical — never the successful
    // alt's own anchor/detail, which is the exact mix-up G2 flagged.
    const demotedEntry = promoted.evidenceAlternatives[1];
    assert.equal(demotedEntry.anchor.quote, 'bad-anchor'); // the FAILED claim's own anchor, not the successful one's
    assert.equal(demotedEntry.rawDetail, 'the failed model said X is broken'); // the FAILED claim's own prose
    assert.equal(demotedEntry.verificationFailed, true);
    // index 0 (the original canonical's own untouched evidenceAlternatives entry,
    // pushed by createEnvelope before promotion) is preserved unchanged — nothing discarded.
    assert.equal(promoted.evidenceAlternatives[0].anchor.quote, 'bad-anchor');
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
    assert.equal(rejected[0].stageDecisions[0].reasonCode, 'commission_anchor_fabricated_all_alternatives_failed');
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

  it('returns fabricated when the quote is nowhere — not in a hunk, not in headContent', () => {
    const anchor = { ...HEAD_ANCHOR, quote: 'this text does not exist anywhere' };
    const r = resolveAnchorLocation(anchor, DIFF, FOO_HEAD_CONTENT);
    assert.equal(r.status, 'fabricated');
  });

  it('does not attempt the HEAD-fallback for a base-side anchor (discovery never saw base content)', () => {
    const anchor = { ...HEAD_ANCHOR, side: 'base', quote: 'return 42;', startLine: 2, endLine: 2 };
    // 'return 42;' is real HEAD content but this is a base-side anchor — it
    // has no hunk match either (the hunk's base side is "return a;"), so it
    // must be fabricated, never outside_hunk_in_head.
    const r = resolveAnchorLocation(anchor, DIFF, FOO_HEAD_CONTENT);
    assert.equal(r.status, 'fabricated');
  });

  it('never fires the HEAD-fallback when headContent is absent (matches pre-restructure behavior exactly)', () => {
    const anchor = { ...HEAD_ANCHOR, quote: 'return 42;', startLine: 2, endLine: 2 };
    const r = resolveAnchorLocation(anchor, DIFF, null);
    assert.equal(r.status, 'fabricated');
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
