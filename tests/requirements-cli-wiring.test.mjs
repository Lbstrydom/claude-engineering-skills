/**
 * Source-pinned checks for `scripts/requirements.mjs`'s CLI wiring — the
 * prose↔code seam a unit test on the pure logic cannot reach, since
 * `cmdReassessGaps` does real network I/O and file locking (Tier 2: never
 * mock the whole provider). Same technique other CLI-wiring tests in this
 * repo use.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'scripts', 'requirements.mjs'), 'utf-8');

describe('reassess-gaps preserves ambiguity-driven needs-review status', () => {
  it('recomputes status through inferAmbiguousFromStatus, not a hardcoded false', () => {
    // The regression: `ambiguous` is never persisted, so a naive recompute
    // that hardcodes `false` silently demotes every ambiguity-driven
    // needs-review entry the moment its (unrelated) degraded gap gets
    // reassessed. Found live 2026-08-12: 7 of 14 real needs-review entries had
    // exactly this shape.
    const block = SRC.slice(SRC.indexOf('async function cmdReassessGaps'), SRC.indexOf('function cmdIndex'));
    assert.match(block, /const wasAmbiguous = inferAmbiguousFromStatus\(req\);/,
      'the ambiguity flag must be RECOMPUTED from prior state, not assumed false');
    assert.ok(!/ambiguous:\s*false/.test(block),
      'a literal ambiguous:false anywhere in this command is the exact regression this pins');
  });

  it('the ambiguity inference runs on the OLD gap, before req.gap is overwritten', () => {
    const block = SRC.slice(SRC.indexOf('async function cmdReassessGaps'), SRC.indexOf('function cmdIndex'));
    const inferIdx = block.indexOf('inferAmbiguousFromStatus(req)');
    const overwriteIdx = block.indexOf('req.gap = { ...a, requirementId: req.id };');
    assert.ok(inferIdx > 0 && overwriteIdx > 0, 'both statements must exist');
    assert.ok(inferIdx < overwriteIdx,
      'inferring ambiguity AFTER overwriting req.gap would read the NEW gap, defeating the whole inference');
  });
});
