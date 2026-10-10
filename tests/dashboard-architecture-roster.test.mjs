/**
 * @fileoverview Architecture tab: the domain roster comes from the committed
 * `.audit-loop/domain-map.json`; the gitignored architecture-map.md snapshot
 * only supplies symbol counts + summaries, and its age is shown.
 *
 * Persona-test 2026-10-06 (P1): the tab showed 33 domains while the map
 * declared 37 (`fleet` among the missing), because it read only the snapshot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectArchitecture, readDomainRoster } from '../scripts/lib/dashboard/collect-reference.mjs';
import sectionArchitecture, { __test__ } from '../scripts/lib/dashboard/sections/architecture.mjs';
import { buildUi } from '../scripts/lib/dashboard/helpers.mjs';

function withTmp(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-roster-'));
  try { return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

function writeMap(root, { rules, codelessDomains }) {
  fs.mkdirSync(path.join(root, '.audit-loop'), { recursive: true });
  fs.writeFileSync(path.join(root, '.audit-loop', 'domain-map.json'), JSON.stringify({ rules, codelessDomains }));
}

function writeSnapshot(root, domains, { generated = '2026-09-20T12:25:04.753Z', commit = '31463e694026' } = {}) {
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'architecture-map.md'), [
    '# Architecture Map', '',
    `- Generated: ${generated}   commit: ${commit}   refresh_id: x`, '',
    '## Contents',
    ...domains.map(([n, c]) => `- [${n}](#${n}) — ${c} symbols`),
    '', '---', '',
    ...domains.flatMap(([n]) => [`## ${n}`, '', `> ${n} summary.`, '']),
  ].join('\n'));
}

const rules = [
  { pattern: 'scripts/lib/a/**', domain: 'alpha' },
  { pattern: 'scripts/lib/f/**', domain: 'fleet' },
  { pattern: 'docs/**', domain: 'docs' },
];

test('roster = rule targets ∪ codelessDomains, sorted and de-duplicated', () => {
  withTmp((root) => {
    writeMap(root, { rules: [...rules, { pattern: 'x/**', domain: 'alpha' }], codelessDomains: ['docs', 'supabase'] });
    const r = readDomainRoster(root);
    assert.deepEqual(r.names, ['alpha', 'docs', 'fleet', 'supabase']);
    assert.ok(r.codeless.has('supabase'));
  });
});

test('a declared domain the snapshot lacks is drawn with an UNKNOWN count, never 0', () => {
  withTmp((root) => {
    writeMap(root, { rules, codelessDomains: ['docs'] });
    writeSnapshot(root, [['alpha', 12], ['retiredone', 3]]);
    const res = collectArchitecture(root);
    assert.equal(res.status.status, 'ok');
    assert.deepEqual(res.domains.map((d) => d.name), ['alpha', 'docs', 'fleet']);
    const fleet = res.domains.find((d) => d.name === 'fleet');
    assert.equal(fleet.rendered, false);
    assert.equal(fleet.symbolCount, null);
    assert.equal(res.domains.find((d) => d.name === 'alpha').symbolCount, 12);
    assert.equal(res.domains.find((d) => d.name === 'docs').codeless, true);
    assert.deepEqual(res.snapshot.missing, ['fleet'], 'a code-less domain is not "missing"');
    assert.deepEqual(res.snapshot.retired, ['retiredone']);
    assert.equal(res.snapshot.generatedAt, '2026-09-20T12:25:04.753Z');
    assert.equal(res.snapshot.commit, '31463e694026');
  });
});

test('no snapshot at all: the roster still draws, status ok with the snapshot detail kept', () => {
  withTmp((root) => {
    writeMap(root, { rules });
    const res = collectArchitecture(root);
    assert.equal(res.status.status, 'ok');
    assert.match(res.status.detail, /not found/);
    assert.equal(res.domains.length, 3);
    assert.equal(res.snapshot.domainCount, 0);
    assert.ok(res.domains.every((d) => d.symbolCount === null));
  });
});

test('no domain map: the snapshot alone, exactly as before', () => {
  withTmp((root) => {
    writeSnapshot(root, [['alpha', 12]]);
    const res = collectArchitecture(root);
    assert.deepEqual(res.domains.map((d) => [d.name, d.symbolCount, d.rendered]), [['alpha', 12, true]]);
    assert.equal(res.snapshot.rosterSource, null);
  });
});

test('render: unknown count reads "?", the missing domain is named, the snapshot date is shown', () => {
  withTmp((root) => {
    writeMap(root, { rules, codelessDomains: ['docs'] });
    writeSnapshot(root, [['alpha', 12]]);
    const arch = collectArchitecture(root);
    const html = sectionArchitecture({
      src: { status: 'ok', detail: '' },
      architecture: { ...arch, deps: {}, mergedDeps: {}, depsSource: null },
    }, buildUi());
    assert.match(html, /<span class="arch-name">fleet<\/span>\s*<span class="arch-sym">\?<\/span>/);
    assert.match(html, /arch-bar-unknown/);
    assert.match(html, /1 declared domain\(s\) not in the snapshot \(<code>fleet<\/code>\)/);
    assert.match(html, /generated 2026-09-20/);
    assert.match(html, /<span class="arch-name">docs<\/span>\s*<span class="arch-sym">—<\/span>/);
    assert.match(html, /^<p class="section-note">3 domains/);
  });
});

test('formatSnapshotLine: no snapshot warns that every count is unknown; no roster prints nothing', () => {
  const ui = buildUi();
  const none = __test__.formatSnapshotLine({ rosterSource: '.audit-loop/domain-map.json', domainCount: 0, missing: ['a'], retired: [] }, ui);
  assert.match(none, /No rendered architecture snapshot/);
  assert.equal(__test__.formatSnapshotLine({ rosterSource: null, domainCount: 3, missing: [], retired: [] }, ui), '');
  assert.equal(__test__.formatSnapshotLine(null, ui), '');
});

test('formatDepsSourceLine: a stale observed graph says how old it is', () => {
  const line = __test__.formatDepsSourceLine({
    observedAvailable: false, observedRejectedReason: 'stale-rules', observedGeneratedAt: '2026-09-20T12:25:04.753Z',
    edgeCounts: { observed: 0, manual: 4, both: 0 },
  }, buildUi());
  assert.match(line, /rejected as stale · observed graph generated 2026-09-20/);
});
