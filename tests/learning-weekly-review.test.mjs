import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderMarkdown,
  applyTotalCap,
  severityRank,
  buildTriageSection,
  buildNoBrainerSection,
  buildStaleSection,
  buildFrictionSection,
  humanizeAgo,
} from '../scripts/learning/weekly-review.mjs';

// ── severityRank ──────────────────────────────────────────────────────────

describe('weekly-review / severityRank', () => {
  it('orders HIGH < MEDIUM < LOW (lower rank = higher priority)', () => {
    assert.equal(severityRank('HIGH'), 0);
    assert.equal(severityRank('MEDIUM'), 1);
    assert.equal(severityRank('LOW'), 2);
  });

  it('audit-fix M6: unknown severities sort ABOVE HIGH (fail-safe)', () => {
    // Prior implementation buried unknown severities at the bottom (rank 2),
    // so a typo or future CRITICAL would silently disappear from the digest.
    // New behaviour: unknowns get rank -1 → top of the sort, demanding human review.
    assert.equal(severityRank(undefined), -1);
    assert.equal(severityRank(''), -1);
    assert.equal(severityRank('CRITICAL'), -1);
    assert.equal(severityRank('high'), -1); // case mismatch — also surfaces
  });
});

// ── Section builders ──────────────────────────────────────────────────────

describe('weekly-review / buildTriageSection', () => {
  it('orders HIGH first, then by created_at desc', () => {
    const rows = [
      { id: 1, severity: 'MEDIUM', created_at: '2026-05-01T00:00:00Z' },
      { id: 2, severity: 'HIGH',   created_at: '2026-05-02T00:00:00Z' },
      { id: 3, severity: 'HIGH',   created_at: '2026-05-03T00:00:00Z' },
    ];
    const out = buildTriageSection(rows, 5);
    assert.equal(out.items[0].id, 3);
    assert.equal(out.items[1].id, 2);
    assert.equal(out.items[2].id, 1);
    assert.equal(out.overflow, 0);
  });

  it('respects cap and reports overflow', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      id: i, severity: 'HIGH', created_at: `2026-05-0${(i % 9) + 1}T00:00:00Z`,
    }));
    const out = buildTriageSection(rows, 3);
    assert.equal(out.items.length, 3);
    assert.equal(out.overflow, 4);
  });
});

describe('weekly-review / buildNoBrainerSection', () => {
  it('orders by occurrence_count desc', () => {
    const rows = [
      { cluster_hash: 'a', occurrence_count: 3, last_seen: '2026-05-01T00:00:00Z' },
      { cluster_hash: 'b', occurrence_count: 7, last_seen: '2026-05-01T00:00:00Z' },
      { cluster_hash: 'c', occurrence_count: 5, last_seen: '2026-05-01T00:00:00Z' },
    ];
    const out = buildNoBrainerSection(rows, 5);
    assert.equal(out.items[0].cluster_hash, 'b');
    assert.equal(out.items[1].cluster_hash, 'c');
    assert.equal(out.items[2].cluster_hash, 'a');
  });
});

// ── applyTotalCap ─────────────────────────────────────────────────────────

describe('weekly-review / applyTotalCap', () => {
  it('total cap of 7 enforced — 3 + 3 + 1', () => {
    const sections = {
      triage:    { items: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}` })), overflow: 0, total: 5 },
      noBrainer: { items: Array.from({ length: 5 }, (_, i) => ({ id: `n${i}` })), overflow: 0, total: 5 },
      stale:     { items: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}` })), overflow: 0, total: 5 },
    };
    const out = applyTotalCap(sections);
    assert.equal(out.triage.items.length,    3);
    assert.equal(out.noBrainer.items.length, 3);
    assert.equal(out.stale.items.length,     1);
    // overflow = original overflow + items that didn't fit
    assert.equal(out.triage.overflow,    2);
    assert.equal(out.noBrainer.overflow, 2);
    assert.equal(out.stale.overflow,     4);
    // total items capped at 7
    const total = out.triage.items.length + out.noBrainer.items.length + out.stale.items.length;
    assert.equal(total, 7);
  });

  it('handles empty sections', () => {
    const sections = {
      triage:    { items: [], overflow: 0, total: 0 },
      noBrainer: { items: [], overflow: 0, total: 0 },
      stale:     { items: [], overflow: 0, total: 0 },
    };
    const out = applyTotalCap(sections);
    assert.equal(out.triage.items.length,    0);
    assert.equal(out.noBrainer.items.length, 0);
    assert.equal(out.stale.items.length,     0);
  });

  it('partial fill — section with fewer items than cap is not over-allocated', () => {
    const sections = {
      triage:    { items: [{ id: 't0' }], overflow: 0, total: 1 },
      noBrainer: { items: Array.from({ length: 5 }, (_, i) => ({ id: `n${i}` })), overflow: 0, total: 5 },
      stale:     { items: Array.from({ length: 2 }, (_, i) => ({ id: `s${i}` })), overflow: 0, total: 2 },
    };
    const out = applyTotalCap(sections);
    // triage: 1 (only had 1)
    // noBrainer: 3 (cap)
    // stale: 1 (cap)
    // total: 5 — under TOTAL_CAP
    assert.equal(out.triage.items.length,    1);
    assert.equal(out.noBrainer.items.length, 3);
    assert.equal(out.stale.items.length,     1);
  });
});

// ── renderMarkdown ────────────────────────────────────────────────────────

describe('weekly-review / renderMarkdown', () => {
  it('all-quiet message when all sections empty', () => {
    const md = renderMarkdown({
      repoName: 'test-repo',
      sections: {
        triage:    { items: [], overflow: 0, total: 0 },
        noBrainer: { items: [], overflow: 0, total: 0 },
        stale:     { items: [], overflow: 0, total: 0 },
      },
      generatedAt: '2026-05-08T12:00:00Z',
    });
    assert.match(md, /audit-loop:learning-weekly-review/);
    assert.match(md, /All quiet this week/);
    assert.match(md, /test-repo/);
  });

  it('renders 3-section digest with overflow notes', () => {
    const md = renderMarkdown({
      repoName: 'wine-cellar-app',
      sections: {
        triage: {
          items: [{ severity: 'HIGH', primary_file: 'src/foo.js', title: 'Title 1', dismiss_reason: null }],
          overflow: 2, total: 3,
        },
        noBrainer: {
          items: [{ cluster_hash: 'abcdef0123456789', occurrence_count: 5, severity_history: ['HIGH', 'HIGH'], files_affected: ['a.js', 'b.js'] }],
          overflow: 0, total: 1,
        },
        stale: { items: [], overflow: 0, total: 0 },
      },
      generatedAt: '2026-05-08T12:00:00Z',
    });
    assert.match(md, /1\. Awaiting triage/);
    assert.match(md, /2\. No-brainer fix-now/);
    assert.match(md, /3\. Stale deferrals/);
    assert.match(md, /\(\.\.\.and 2 more/, 'overflow note rendered');
    assert.match(md, /HIGH/);
    assert.match(md, /5 occurrences/);
  });

  it('contains the sticky marker for issue-update lookups', () => {
    const md = renderMarkdown({
      repoName: 'r',
      sections: {
        triage: { items: [], overflow: 0, total: 0 },
        noBrainer: { items: [], overflow: 0, total: 0 },
        stale: { items: [], overflow: 0, total: 0 },
      },
      generatedAt: 'T',
    });
    assert.ok(md.startsWith('<!-- audit-loop:learning-weekly-review -->'));
  });
});

// ── Friction notes (plan: friction-log-and-digest-v1.md) ─────────────────

describe('weekly-review / buildFrictionSection', () => {
  it('orders blocker > annoyance > note, then by created_at desc', () => {
    const rows = [
      { id: 1, severity: 'note',      created_at: '2026-05-09T10:00:00Z', message: 'note' },
      { id: 2, severity: 'blocker',   created_at: '2026-05-08T10:00:00Z', message: 'block' },
      { id: 3, severity: 'annoyance', created_at: '2026-05-09T11:00:00Z', message: 'meh' },
    ];
    const out = buildFrictionSection(rows, 5);
    assert.equal(out.items[0].id, 2, 'blocker first');
    assert.equal(out.items[1].id, 3, 'annoyance second');
    assert.equal(out.items[2].id, 1, 'note last');
  });

  it('respects cap and reports overflow', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: i, severity: 'note', created_at: '2026-05-09T00:00:00Z', message: `m${i}`,
    }));
    const out = buildFrictionSection(rows, 2);
    assert.equal(out.items.length, 2);
    assert.equal(out.overflow, 3);
  });

  it('handles empty input', () => {
    const out = buildFrictionSection([], 3);
    assert.deepEqual(out, { items: [], overflow: 0, total: 0 });
  });
});

describe('weekly-review / humanizeAgo', () => {
  it('"just now" for sub-minute', () => {
    const now = Date.now();
    assert.equal(humanizeAgo(new Date(now - 30 * 1000).toISOString(), now), 'just now');
  });

  it('"Xm ago" for minutes', () => {
    const now = Date.now();
    assert.equal(humanizeAgo(new Date(now - 5 * 60 * 1000).toISOString(), now), '5m ago');
  });

  it('"Xh ago" for hours', () => {
    const now = Date.now();
    assert.equal(humanizeAgo(new Date(now - 3 * 60 * 60 * 1000).toISOString(), now), '3h ago');
  });

  it('"Xd ago" for days', () => {
    const now = Date.now();
    assert.equal(humanizeAgo(new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(), now), '2d ago');
  });

  it('returns "unknown" on null', () => {
    assert.equal(humanizeAgo(null), 'unknown');
  });
});

describe('weekly-review / cap reallocation when friction notes present', () => {
  it('friction-present split: 3 friction + 2 triage + 2 no-brainer + 0 stale', () => {
    const sections = {
      friction:  { items: Array.from({ length: 5 }, (_, i) => ({ id: `f${i}` })), overflow: 0, total: 5 },
      triage:    { items: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}` })), overflow: 0, total: 5 },
      noBrainer: { items: Array.from({ length: 5 }, (_, i) => ({ id: `n${i}` })), overflow: 0, total: 5 },
      stale:     { items: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}` })), overflow: 0, total: 5 },
    };
    const out = applyTotalCap(sections);
    assert.equal(out.friction.items.length, 3);
    assert.equal(out.triage.items.length, 2);
    assert.equal(out.noBrainer.items.length, 2);
    assert.equal(out.stale.items.length, 0);
    const total = out.friction.items.length + out.triage.items.length + out.noBrainer.items.length + out.stale.items.length;
    assert.equal(total, 7, 'total capped at 7');
  });

  it('friction-absent falls back to original 3+3+1', () => {
    const sections = {
      friction:  { items: [], overflow: 0, total: 0 },
      triage:    { items: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}` })), overflow: 0, total: 5 },
      noBrainer: { items: Array.from({ length: 5 }, (_, i) => ({ id: `n${i}` })), overflow: 0, total: 5 },
      stale:     { items: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}` })), overflow: 0, total: 5 },
    };
    const out = applyTotalCap(sections);
    assert.equal(out.friction.items.length, 0);
    assert.equal(out.triage.items.length, 3);
    assert.equal(out.noBrainer.items.length, 3);
    assert.equal(out.stale.items.length, 1);
  });
});

describe('weekly-review / renderMarkdown with friction notes', () => {
  it('omits the all-quiet message when friction present', () => {
    const md = renderMarkdown({
      repoName: 'test-repo',
      sections: {
        friction:  { items: [{ severity: 'blocker', created_at: new Date().toISOString(), message: 'urgent' }], overflow: 0, total: 1 },
        triage:    { items: [], overflow: 0, total: 0 },
        noBrainer: { items: [], overflow: 0, total: 0 },
        stale:     { items: [], overflow: 0, total: 0 },
      },
      generatedAt: 'T',
    });
    assert.match(md, /Friction notes/);
    assert.match(md, /\[blocker\]/);
    assert.match(md, /urgent/);
    assert.doesNotMatch(md, /All quiet/);
  });

  it('renumbers sections when friction is present (1=friction, 2=triage, ...)', () => {
    const md = renderMarkdown({
      repoName: 'r',
      sections: {
        friction:  { items: [{ severity: 'note', created_at: new Date().toISOString(), message: 'x' }], overflow: 0, total: 1 },
        triage:    { items: [{ severity: 'HIGH', primary_file: 'a.js', title: 'T' }], overflow: 0, total: 1 },
        noBrainer: { items: [], overflow: 0, total: 0 },
        stale:     { items: [], overflow: 0, total: 0 },
      },
      generatedAt: 'T',
    });
    assert.match(md, /### 1\. Friction notes/);
    assert.match(md, /### 2\. Awaiting triage/);
  });

  it('keeps original numbering when no friction', () => {
    const md = renderMarkdown({
      repoName: 'r',
      sections: {
        triage:    { items: [{ severity: 'HIGH', primary_file: 'a.js', title: 'T' }], overflow: 0, total: 1 },
        noBrainer: { items: [], overflow: 0, total: 0 },
        stale:     { items: [], overflow: 0, total: 0 },
      },
      generatedAt: 'T',
    });
    assert.match(md, /### 1\. Awaiting triage/);
  });
});
