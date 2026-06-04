/**
 * @fileoverview Unit tests for reconcile-repo-identity's pure proposal builder
 * (signal-recovery Cluster A, Phase 2). DB-free — the transactional apply path
 * is covered by the gated DB-integration test (repo-identity-store.test.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProposals, repoBaseName } from '../scripts/reconcile-repo-identity.mjs';

test('1:1 exact name match → proposal carrying the canonical id + run count', () => {
  const canonical = [{ id: 'canon-wine', name: 'wine-cellar-app', repo_uuid: 'uuid-wine' }];
  const legacy = [
    { id: 'leg1', name: 'wine-cellar-app', run_count: 9 },
    { id: 'leg2', name: 'wine-cellar-app', run_count: '3' }, // string count (pg numeric)
  ];
  const { proposals, quarantined } = buildProposals(canonical, legacy);
  assert.equal(proposals.length, 2);
  assert.equal(quarantined.length, 0);
  assert.deepEqual(proposals[0], {
    legacyId: 'leg1', legacyName: 'wine-cellar-app', runCount: 9,
    canonicalId: 'canon-wine', canonicalName: 'wine-cellar-app', canonicalRepoUuid: 'uuid-wine',
    matchedBy: 'exact',
  });
  assert.equal(proposals[1].runCount, 3, 'string run_count is coerced to number');
});

test('basename match: legacy bare name → canonical owner/repo name (the real-data case)', () => {
  // The arch path wrote "Lbstrydom/wine-cellar-app"; the old audit path wrote
  // the bare "wine-cellar-app". They are the same repo and must merge.
  const canonical = [{ id: 'canon-wine', name: 'Lbstrydom/wine-cellar-app', repo_uuid: 'u' }];
  const legacy = [{ id: 'leg1', name: 'wine-cellar-app', run_count: 193 }];
  const { proposals, quarantined } = buildProposals(canonical, legacy);
  assert.equal(proposals.length, 1);
  assert.equal(quarantined.length, 0);
  assert.equal(proposals[0].canonicalId, 'canon-wine');
  assert.equal(proposals[0].matchedBy, 'basename');
});

test('pure rename (different basename) → quarantine, not auto-merge', () => {
  // claude-audit-loop was renamed to claude-engineering-skills — basenames
  // differ, so it must NOT auto-merge; the operator adds an explicit alias.
  const canonical = [{ id: 'canon-ces', name: 'Lbstrydom/claude-engineering-skills', repo_uuid: 'u' }];
  const legacy = [{ id: 'leg-old', name: 'claude-audit-loop', run_count: 47 }];
  const { proposals, quarantined } = buildProposals(canonical, legacy);
  assert.equal(proposals.length, 0);
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0].reason, /rename or ephemeral/);
});

test('repoBaseName normalizes owner/repo and bare forms', () => {
  assert.equal(repoBaseName('Lbstrydom/wine-cellar-app'), 'wine-cellar-app');
  assert.equal(repoBaseName('wine-cellar-app'), 'wine-cellar-app');
  assert.equal(repoBaseName('github.com/o/r'), 'r');
  assert.equal(repoBaseName(''), '');
});

test('no canonical row with the name → quarantine (never force-merge)', () => {
  const { proposals, quarantined } = buildProposals(
    [{ id: 'canon-wine', name: 'wine-cellar-app', repo_uuid: 'u' }],
    [{ id: 'orphan', name: 'some-other-repo', run_count: 1 }],
  );
  assert.equal(proposals.length, 0);
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0].reason, /no canonical/);
});

test('ambiguous name (>1 canonical) → quarantine, not a guess', () => {
  const { proposals, quarantined } = buildProposals(
    [
      { id: 'c1', name: 'dup', repo_uuid: 'u1' },
      { id: 'c2', name: 'dup', repo_uuid: 'u2' },
    ],
    [{ id: 'leg', name: 'dup', run_count: 4 }],
  );
  assert.equal(proposals.length, 0);
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0].reason, /2 canonical rows share this name|ambiguous/);
});

test('empty inputs → no proposals, no quarantine', () => {
  const { proposals, quarantined } = buildProposals([], []);
  assert.equal(proposals.length, 0);
  assert.equal(quarantined.length, 0);
});

test('multiple distinct repos each map to their own canonical row', () => {
  const canonical = [
    { id: 'c-wine', name: 'wine-cellar-app', repo_uuid: 'u-wine' },
    { id: 'c-ai', name: 'ai-organiser', repo_uuid: 'u-ai' },
  ];
  const legacy = [
    { id: 'lw1', name: 'wine-cellar-app', run_count: 2 },
    { id: 'la1', name: 'ai-organiser', run_count: 1 },
    { id: 'lw2', name: 'wine-cellar-app', run_count: 1 },
  ];
  const { proposals } = buildProposals(canonical, legacy);
  assert.equal(proposals.length, 3);
  assert.equal(proposals.filter((p) => p.canonicalId === 'c-wine').length, 2);
  assert.equal(proposals.filter((p) => p.canonicalId === 'c-ai').length, 1);
});
