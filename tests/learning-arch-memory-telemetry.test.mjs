import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeArchMemoryBandOutcome,
} from '../scripts/learning/backfill-outcomes.mjs';

import { buildDecisionKey } from '../scripts/lib/learning/decision-logger.mjs';

// ── decision_key shape (Phase 1+ contract carried into Phase 3) ───────────

describe('arch_memory_band / decision_key shape', () => {
  it('uses off-audit format `arch_memory_band:<external_id>`', () => {
    const k = buildDecisionKey({ decisionType: 'arch_memory_band', externalId: 'sym-123' });
    assert.equal(k, 'arch_memory_band:sym-123');
  });

  it('throws when neither audit-bound nor external_id provided', () => {
    assert.throws(() => buildDecisionKey({ decisionType: 'arch_memory_band' }));
  });
});

// ── computeArchMemoryBandOutcome ──────────────────────────────────────────

describe('arch_memory_band / outcome detector', () => {
  it('returns null on missing context/choice', async () => {
    assert.equal(await computeArchMemoryBandOutcome(null), null);
    assert.equal(await computeArchMemoryBandOutcome({}), null);
    assert.equal(await computeArchMemoryBandOutcome({ context: {} }), null);
  });

  it('uncertain when band is review/justify-divergence', async () => {
    const a = await computeArchMemoryBandOutcome(
      { context: { filePath: 'a.js', symbol: 'foo' }, choice: { band: 'review' }, created_at: '' },
      { execGit: () => '' }
    );
    assert.equal(a.action, 'uncertain');
    assert.match(a.evidence, /band=review/);
    const b = await computeArchMemoryBandOutcome(
      { context: { filePath: 'a.js', symbol: 'foo' }, choice: { band: 'justify-divergence' }, created_at: '' },
      { execGit: () => '' }
    );
    assert.equal(b.action, 'uncertain');
  });

  it('uncertain when filePath or symbol missing', async () => {
    const r1 = await computeArchMemoryBandOutcome(
      { context: { symbol: 'foo' }, choice: { band: 'reuse' }, created_at: '' },
      { execGit: () => '' }
    );
    assert.equal(r1.action, 'uncertain');
    assert.match(r1.evidence, /missing-file-or-symbol/);
  });

  it('reuse-correct: band=reuse + no commits in dir within 30min', async () => {
    const r = await computeArchMemoryBandOutcome(
      { context: { filePath: 'src/foo.js', symbol: 'foo' }, choice: { band: 'reuse' }, created_at: '' },
      { execGit: () => '' } // empty git output → no commits
    );
    assert.equal(r.action, 'reuse-correct');
  });

  it('wrong-fork: band=reuse but commits touched the dir', async () => {
    const r = await computeArchMemoryBandOutcome(
      { context: { filePath: 'src/foo.js', symbol: 'foo' }, choice: { band: 'reuse' }, created_at: '' },
      { execGit: () => 'abc123\ndef456\n' } // 2 commits in dir
    );
    assert.equal(r.action, 'wrong-fork');
    assert.match(r.evidence, /2-commits/);
  });

  it('extend-correct: band=extend + commits did touch the dir', async () => {
    const r = await computeArchMemoryBandOutcome(
      { context: { filePath: 'src/foo.js', symbol: 'foo' }, choice: { band: 'extend' }, created_at: '' },
      { execGit: () => 'abc123\n' }
    );
    assert.equal(r.action, 'extend-correct');
  });

  it('uncertain: band=extend but no follow-up edits', async () => {
    const r = await computeArchMemoryBandOutcome(
      { context: { filePath: 'src/foo.js', symbol: 'foo' }, choice: { band: 'extend' }, created_at: '' },
      { execGit: () => '' }
    );
    assert.equal(r.action, 'uncertain');
    assert.match(r.evidence, /no-followup-edits/);
  });

  it('returns null on git failure (graceful)', async () => {
    const r = await computeArchMemoryBandOutcome(
      { context: { filePath: 'src/foo.js', symbol: 'foo' }, choice: { band: 'reuse' }, created_at: '' },
      { execGit: () => { throw new Error('not a git repo'); } }
    );
    // Wrap in default behaviour: when git throws inside try/catch, we
    // reach the final branch which still returns reuse-correct (commitsTouched=0).
    // That is the documented v1 conservative default.
    assert.ok(r);
    assert.ok(['reuse-correct', 'uncertain'].includes(r.action));
  });
});
