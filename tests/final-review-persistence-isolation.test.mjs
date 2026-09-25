/**
 * @fileoverview Guards two persistence defects found live on 2026-07-26, when
 * the shadow final-review A/B produced its first real observation.
 *
 * WHAT HAPPENED. The Opus shadow returned a finding with a null `category`.
 * `audit_findings.category` is NOT NULL with no default, so the bulk INSERT
 * threw. Three things then compounded:
 *
 *   1. `recordFindings` swallowed the error and logged — correct for its
 *      best-effort pool callers, wrong inside a caller transaction.
 *   2. The failed statement had already put Postgres in an ABORTED tx state, so
 *      the enclosing `withTx`'s COMMIT silently degraded to a ROLLBACK. No error
 *      reached `recordFinalReviewFindings`, which believed it had persisted.
 *   3. Primary and shadow shared that one transaction, so the rollback also
 *      discarded the DELETE and the PRIMARY reviewer's findings. The run kept
 *      STALE findings from an earlier review and nothing said so.
 *
 * Net effect: `shadowOnlyQueue` was empty, the primary's findings were lost, and
 * the only trace was a single swallowed log line. This is the
 * unverified-write-success class AGENTS.md treats as HIGH.
 *
 * These are unit tests over the pure guard behaviour — no DB, no live API.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync('scripts/lib/store/runs-findings.mjs', 'utf8');

// Read the marker from source rather than importing it: the module is re-exported
// by `scripts/learning-store.mjs` via `export *`, and that barrel's surface is
// pinned to callable functions only (tests/learning-store-exports.test.mjs).
// Keeping the constant private respects that contract instead of widening a
// pinned public API so a test can import a string.
const MISSING_CATEGORY_MARKER = (() => {
  const m = SRC.match(/const MISSING_CATEGORY_MARKER = '([^']+)'/);
  assert.ok(m, 'precondition: MISSING_CATEGORY_MARKER is declared in the module');
  return m[1];
})();

/** Slice a named function's body out of the source for static assertions. */
function fnBody(name) {
  const start = SRC.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `precondition: ${name} exists`);
  const rest = SRC.slice(start);
  const end = rest.indexOf('\n}\n');
  return rest.slice(0, end === -1 ? rest.length : end);
}

describe('recordFindings — NOT NULL write-boundary guard', () => {
  it('exports a self-describing marker, not a neutral "unknown"', () => {
    // The value surfaces in dashboards and adjudication worksheets, so it must
    // read as a producer defect rather than a legitimate category.
    assert.match(MISSING_CATEGORY_MARKER, /missing/i);
    assert.ok(MISSING_CATEGORY_MARKER.length <= 80, 'must fit the schema category cap');
  });

  it('coerces a missing category rather than losing the row (detail stays gradeable)', () => {
    const body = fnBody('recordFindings');
    assert.match(
      body, /row\.category\s*=\s*MISSING_CATEGORY_MARKER/,
      'a null category must be coerced — dropping the row would discard a gradeable detail_snapshot',
    );
    assert.match(body, /coercedCategories/, 'and the coercion must be counted for the loud log');
  });

  it('DROPS a finding with no severity rather than fabricating one', () => {
    const body = fnBody('recordFindings');
    // Asymmetric on purpose: severity is the metric the A/B stopping rule counts
    // (accepted shadow-only HIGH/MEDIUM per run). Inventing one would corrupt the
    // number the row exists to feed, which is worse than losing the row.
    assert.match(body, /if \(!row\.severity \|\| !VALID_SEVERITIES\.has\(row\.severity\)\)/,
      'severity-less AND out-of-domain rows must be filtered (round-1 audit H18 widened this from a bare falsy check)');
    assert.match(body, /droppedFingerprints/, 'and named in the log — never a silent cap');
    assert.doesNotMatch(
      body, /severity:\s*row\.severity\s*\|\|\s*['"]/,
      'severity must never be defaulted to a literal',
    );
  });

  it('rethrows inside a caller transaction so COMMIT cannot silently become ROLLBACK', () => {
    const body = fnBody('recordFindings');
    assert.match(
      body, /if \(opts\.client\) throw err/,
      'swallowing inside a caller tx is what made the rollback invisible — the caller owns commit/rollback '
      + 'and must be told. The pool path keeps swallowing (best-effort telemetry).',
    );
  });
});

describe('recordFinalReviewFindings — the shadow cannot damage the primary', () => {
  const body = fnBody('recordFinalReviewFindings');

  it('uses TWO transactions, not one shared tx', () => {
    const txCount = (body.match(/await withTx\(/g) || []).length;
    assert.equal(
      txCount, 2,
      'primary and shadow must not share a transaction — a malformed shadow finding aborted the shared tx '
      + 'and rolled back the primary\'s findings on 2026-07-26',
    );
  });

  it('writes the primary FIRST, keeping the atomic upsert+prune replace contract', () => {
    // Retargeted 2026-09-14 (docs/plans/final-review-credit-projection.md
    // Seam 3): the replace mechanism changed from DELETE-then-INSERT to
    // UPSERT-then-prune-unruled-absentees, so a re-run no longer erases a
    // human/agent's ruling on a row that drops out of the new snapshot. The
    // invariant this test guards is unchanged — primary persists in its own
    // tx BEFORE the shadow's tx even starts, so a shadow failure cannot touch
    // it — only the literal statement this checks for moved.
    const pruneAt = body.indexOf('pruneUnrecordedUnruled(client, { runId, passName: \'final-review\'');
    const primaryAt = body.indexOf("'final-review', 0");
    const shadowPruneAt = body.indexOf('pruneUnrecordedUnruled(client, { runId, passName: \'final-review-shadow\'');
    const shadowAt = body.indexOf("'final-review-shadow', 0");
    assert.ok(pruneAt !== -1 && primaryAt !== -1 && shadowPruneAt !== -1 && shadowAt !== -1, 'precondition: all four statements present');
    assert.ok(primaryAt < pruneAt, 'the primary UPSERT must be followed by ITS OWN prune, in the same tx (atomic replace)');
    assert.ok(pruneAt < shadowAt, 'the shadow write must come after the primary transaction (upsert + prune) has fully committed');
    assert.ok(shadowAt < shadowPruneAt, 'the shadow UPSERT must be followed by ITS OWN prune, in the same (second) tx');
  });

  it('treats a shadow persistence failure as non-fatal and says so', () => {
    assert.match(
      body, /shadow, non-fatal/,
      'a shadow failure must be logged as explicitly non-fatal — it is observation-only',
    );
  });

  it('does NOT write shadow rows when the primary write failed', () => {
    // Shadow-only rows with no primary baseline read as "the primary found
    // nothing", which is a false comparison rather than a missing one.
    const primaryCatch = body.indexOf('failed (primary)');
    const shadowWrite = body.indexOf("'final-review-shadow', 0");
    assert.ok(primaryCatch !== -1, 'precondition: the primary failure is handled distinctly');
    assert.ok(primaryCatch < shadowWrite, 'the primary catch precedes the shadow write');
    assert.match(
      body.slice(primaryCatch, shadowWrite), /\breturn\b/,
      'the primary catch must return, so a half-written run cannot masquerade as a real comparison',
    );
  });
});
