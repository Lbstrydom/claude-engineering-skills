/**
 * Tests for scripts/lib/requirements/render.mjs — the ledger → markdown map.
 * Plan: docs/plans/requirements-layer.md.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../scripts/lib/requirements/ledger.mjs';
import { renderRequirementsMap } from '../scripts/lib/requirements/render.mjs';

function cand(over = {}) {
  return {
    id: 'REQ-correctness-aaaaaaaa', assertion: 'The value is validated before use.',
    kind: 'correctness', checkable: true,
    provenance: [{ file: 'src/a.mjs', anchor: 'fn' }],
    appliesTo: [], evidence: { code: [], tests: [] }, seenInRuns: 2, confidence: 'high', ...over,
  };
}
const gap = (id, g = 'none', cw = []) => ({ requirementId: id, gap: g, conflictsWith: cw, rationale: 't' });

/** A ledger with one active, one needs-review, one inferred-only requirement. */
function sampleLedger() {
  return reconcile({
    candidates: [
      cand({ id: 'REQ-security-11111111', kind: 'security', assertion: 'Secrets are never logged in plaintext.' }),
      cand({ id: 'REQ-correctness-22222222', kind: 'correctness', assertion: 'A contradictory invariant here.', provenance: [{ file: 'src/b.mjs', anchor: 'x' }] }),
      cand({ id: 'REQ-safety-33333333', kind: 'safety', assertion: 'A low-confidence single-run invariant.', seenInRuns: 1, confidence: 'low' }),
    ],
    coveredFiles: ['src/a.mjs', 'src/b.mjs'],
    gapAssessments: [
      gap('REQ-security-11111111'),
      gap('REQ-correctness-22222222', 'contradictory', ['REQ-security-11111111']),
      gap('REQ-safety-33333333'),
    ],
  });
}

describe('renderRequirementsMap', () => {
  it('renders the title with the repo name', () => {
    const md = renderRequirementsMap(sampleLedger(), { repoName: 'test-repo' });
    assert.match(md, /^# Requirements Map — test-repo/);
  });

  it('emits a Mermaid pie of active invariants by kind', () => {
    const md = renderRequirementsMap(sampleLedger(), { repoName: 'r' });
    assert.match(md, /```mermaid\npie title Active invariants by kind/);
    assert.match(md, /"security" : 1/);
  });

  it('renders the status table with the exact labels', () => {
    const md = renderRequirementsMap(sampleLedger(), { repoName: 'r' });
    assert.match(md, /\| 🟢 active — enforced by \/audit-code \| 1 \|/);
    assert.match(md, /\| 🟡 needs-review — awaiting your call \| 1 \|/);
    assert.match(md, /\| ⚪ inferred-only — refine backlog \| 1 \|/);
  });

  it('lists needs-review items with their gap class', () => {
    const md = renderRequirementsMap(sampleLedger(), { repoName: 'r' });
    assert.match(md, /## 🟡 Needs review \(1\)/);
    assert.match(md, /contradictory/);
  });

  it('groups active invariants by kind with their id and governing files', () => {
    const md = renderRequirementsMap(sampleLedger(), { repoName: 'r' });
    assert.match(md, /### security \(1\)/);
    assert.match(md, /`REQ-security-11111111`/);
  });

  it('renders a per-file index covering every coveredFile', () => {
    const md = renderRequirementsMap(sampleLedger(), { repoName: 'r' });
    assert.match(md, /## By file/);
    assert.match(md, /`src\/a\.mjs`/);
    assert.match(md, /`src\/b\.mjs`/);
  });

  it('escapes pipe characters in assertions so the table stays valid', () => {
    const l = reconcile({
      candidates: [cand({ id: 'REQ-safety-44444444', kind: 'safety', assertion: 'Either a | or b must hold.' })],
      coveredFiles: ['src/a.mjs'],
      gapAssessments: [gap('REQ-safety-44444444')],
    });
    const md = renderRequirementsMap(l, { repoName: 'r' });
    assert.match(md, /Either a \\\| or b must hold/);
  });

  it('falls back to a note (no pie) when there are no active requirements', () => {
    const l = reconcile({
      candidates: [cand({ id: 'REQ-safety-55555555', kind: 'safety', assertion: 'A single-run invariant only.', seenInRuns: 1, confidence: 'low' })],
      coveredFiles: ['src/a.mjs'],
      gapAssessments: [gap('REQ-safety-55555555')],
    });
    const md = renderRequirementsMap(l, { repoName: 'r' });
    assert.doesNotMatch(md, /```mermaid/);
    assert.match(md, /No `active` invariants yet/);
  });

  it('handles an empty ledger without throwing', () => {
    const md = renderRequirementsMap({ requirements: [], coveredFiles: [] }, { repoName: 'empty' });
    assert.match(md, /# Requirements Map — empty/);
    assert.match(md, /0 requirement\(s\)/);
  });
});
