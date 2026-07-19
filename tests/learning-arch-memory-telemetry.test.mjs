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

  const TS = '2026-07-19T10:00:00.000Z';
  const row = (band) => ({
    context: { filePath: 'src/foo.js', symbol: 'foo' }, choice: { band }, created_at: TS,
  });

  // ── the window itself ───────────────────────────────────────────────────
  // These assert the git ARGV, not just the resulting branch. The prior tests
  // stubbed execGit without inspecting its arguments, so an inverted window
  // (`--since=30.minutes.ago --until=<created_at>`, i.e. since > until for
  // every row old enough to be selected) returned empty for every row ever
  // resolved — and was invisible to the suite.

  it('probes a window that runs FORWARD from the decision timestamp', async () => {
    let seen = null;
    await computeArchMemoryBandOutcome(row('reuse'), { execGit: (args) => { seen = args; return ''; } });
    assert.ok(seen, 'execGit must be invoked');
    const since = seen.find(a => a.startsWith('--since=')).slice('--since='.length);
    const until = seen.find(a => a.startsWith('--until=')).slice('--until='.length);
    assert.equal(since, TS, '--since must be the decision timestamp');
    assert.ok(Date.parse(until) > Date.parse(since), '--until must be AFTER --since');
    assert.equal(Date.parse(until) - Date.parse(since), 30 * 60 * 1000, '30-minute forward window');
  });

  it('uncertain on an unparseable decision timestamp (no blind probe)', async () => {
    const r = await computeArchMemoryBandOutcome(
      { context: { filePath: 'src/foo.js', symbol: 'foo' }, choice: { band: 'reuse' }, created_at: '' },
      { execGit: () => { throw new Error('must not be called'); } }
    );
    assert.equal(r.action, 'uncertain');
    assert.match(r.evidence, /unparseable-decision-timestamp/);
  });

  // ── branch behaviour ────────────────────────────────────────────────────

  it('reuse-correct: band=reuse + no commits in dir within 30min', async () => {
    const r = await computeArchMemoryBandOutcome(row('reuse'), { execGit: () => '' });
    assert.equal(r.action, 'reuse-correct');
  });

  it('wrong-fork: band=reuse but commits touched the dir', async () => {
    const r = await computeArchMemoryBandOutcome(row('reuse'), { execGit: () => 'abc123\ndef456\n' });
    assert.equal(r.action, 'wrong-fork');
    assert.match(r.evidence, /2-commits/);
  });

  it('extend-correct: band=extend + commits did touch the dir', async () => {
    const r = await computeArchMemoryBandOutcome(row('extend'), { execGit: () => 'abc123\n' });
    assert.equal(r.action, 'extend-correct');
  });

  it('uncertain: band=extend but no follow-up edits', async () => {
    const r = await computeArchMemoryBandOutcome(row('extend'), { execGit: () => '' });
    assert.equal(r.action, 'uncertain');
    assert.match(r.evidence, /no-followup-edits/);
  });

  it('git failure degrades to uncertain — never a fabricated reuse-correct', async () => {
    const r = await computeArchMemoryBandOutcome(
      row('reuse'),
      { execGit: () => { throw new Error('not a git repo'); } }
    );
    // A failed probe observed NOTHING. Falling through to the commitsTouched=0
    // branch would launder an error into a positive label.
    assert.equal(r.action, 'uncertain');
    assert.match(r.evidence, /git-probe-failed/);
  });
});
