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

  it('uncertain when band is review (no resolution signal defined)', async () => {
    const a = await computeArchMemoryBandOutcome(
      { context: { filePath: 'a.js', symbol: 'foo' }, choice: { band: 'review' }, created_at: '' },
      { execGit: () => '' }
    );
    assert.equal(a.action, 'uncertain');
    assert.match(a.evidence, /band=review/);
  });

  // ── justify-divergence resolves via the @duplicate-justification pragma ──
  //
  // Regression guard for the vacuity fixed 2026-07-20: this band used to
  // short-circuit to a blanket `uncertain`, and since `reuse`/`extend` sit
  // above the pipeline's similarity ceiling, that made 100% of resolved
  // arch_memory_band rows unresolvable BY CONSTRUCTION. The assertions below
  // are what make `divergence-justified` reachable at all — if this band ever
  // returns a bare `uncertain` again for a well-formed row, the loop is vacuous.
  describe('justify-divergence / pragma resolution', () => {
    const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // past grace
    const NEW = new Date(Date.now() - 60 * 1000).toISOString();                 // inside grace
    const jd = (created_at) => ({
      context: { filePath: 'scripts/lib/file-io.mjs', symbol: 'atomicWriteFileSync' },
      choice: { band: 'justify-divergence' },
      created_at,
    });

    it('divergence-justified when a pragma targets the cited candidate', async () => {
      const r = await computeArchMemoryBandOutcome(jd(OLD), {
        getRepoPragmas: () => ([{
          pragmaFile: 'scripts/memory-health.mjs', pragmaLine: 291,
          targetFile: 'scripts/lib/file-io.mjs', targetSymbol: 'atomicWriteFileSync',
          reason: 'deliberate',
        }]),
      });
      assert.equal(r.action, 'divergence-justified');
      assert.match(r.evidence, /pragma@scripts\/memory-health\.mjs:291/);
    });

    it('normalises path spelling — author-typed backslashes still match', async () => {
      const r = await computeArchMemoryBandOutcome(jd(OLD), {
        getRepoPragmas: () => ([{
          pragmaFile: 'scripts\\memory-health.mjs', pragmaLine: 291,
          targetFile: '.\\scripts\\lib\\file-io.mjs', targetSymbol: 'atomicWriteFileSync',
          reason: 'deliberate',
        }]),
      });
      assert.equal(r.action, 'divergence-justified');
    });

    it('does not match a pragma targeting a DIFFERENT symbol in the same file', async () => {
      const r = await computeArchMemoryBandOutcome(jd(OLD), {
        getRepoPragmas: () => ([{
          pragmaFile: 'x.mjs', pragmaLine: 1,
          targetFile: 'scripts/lib/file-io.mjs', targetSymbol: 'readFileOrDie',
          reason: 'other',
        }]),
      });
      assert.equal(r.action, 'divergence-unjustified');
    });

    it('stays PENDING (null) inside the grace window — a pragma may still land', async () => {
      const r = await computeArchMemoryBandOutcome(jd(NEW), { getRepoPragmas: () => ([]) });
      assert.equal(r, null, 'must not close the row before the pragma has had time to appear');
    });

    it('divergence-unjustified once the grace window has passed with no pragma', async () => {
      const r = await computeArchMemoryBandOutcome(jd(OLD), { getRepoPragmas: () => ([]) });
      assert.equal(r.action, 'divergence-unjustified');
      assert.match(r.evidence, /no-pragma-targeting-candidate/);
    });

    it('a FAILED sweep never mints divergence-unjustified', async () => {
      // "git grep blew up" and "there are zero pragmas" are not interchangeable:
      // conflating them would mark every row in the batch as unjustified.
      const r = await computeArchMemoryBandOutcome(jd(OLD), {
        getRepoPragmas: () => { throw new Error('git grep exploded'); },
      });
      assert.equal(r.action, 'uncertain');
      assert.match(r.evidence, /pragma-sweep-failed/);
    });

    it('uncertain when the candidate has no filePath/symbol to match on', async () => {
      const r = await computeArchMemoryBandOutcome(
        { context: { symbol: 'foo' }, choice: { band: 'justify-divergence' }, created_at: OLD },
        { getRepoPragmas: () => ([]) },
      );
      assert.equal(r.action, 'uncertain');
      assert.match(r.evidence, /missing-file-or-symbol/);
    });
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
