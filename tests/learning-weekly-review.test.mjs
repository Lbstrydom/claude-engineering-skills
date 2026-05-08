import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderMarkdown,
  applyTotalCap,
  severityRank,
  buildTriageSection,
  buildNoBrainerSection,
  buildStaleSection,
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
