/**
 * @fileoverview Tests for the dashboard CLI section — collector +
 * coverage gate. The render path is covered by existing dashboard.test.mjs;
 * this file isolates the collect-cli logic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectCli, groupByCategory, auditCatalogCoverage,
} from '../scripts/lib/dashboard/collect-cli.mjs';
import { renderDocument } from '../scripts/lib/dashboard/render.mjs';

// ─── temp-dir helpers ─────────────────────────────────────────────────────

function withTmp(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-collect-'));
  try { return fn(tmp); }
  finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

function writePkg(root, scripts) {
  fs.writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name: 'test', version: '0.0.1', scripts }, null, 2));
}

function writeCatalog(root, entries) {
  fs.writeFileSync(path.join(root, 'scripts', '.cli-catalog.json'),
    JSON.stringify({ entries }, null, 2));
}

function mkScriptsDir(root) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
}

// ─── collectCli ───────────────────────────────────────────────────────────

test('collectCli returns missing-optional when package.json is absent', () => {
  withTmp((tmp) => {
    const { entries, status } = collectCli(tmp);
    assert.deepEqual(entries, []);
    assert.equal(status.status, 'missing-optional');
    assert.match(status.detail, /package\.json not found/);
  });
});

test('collectCli returns missing-optional when no scripts are defined', () => {
  withTmp((tmp) => {
    writePkg(tmp, {});
    const { entries, status } = collectCli(tmp);
    assert.deepEqual(entries, []);
    assert.equal(status.status, 'missing-optional');
  });
});

test('collectCli joins package.json scripts against catalog metadata', () => {
  withTmp((tmp) => {
    writePkg(tmp, {
      'audit:code':       'node scripts/audit.mjs code',
      'skills:fit-check': 'node scripts/skills-fit-check.mjs',
    });
    mkScriptsDir(tmp);
    writeCatalog(tmp, {
      'audit:code': { description: 'Run audit', category: 'audit', relatedSkill: 'audit-code' },
      'skills:fit-check': { description: 'Shape gate', category: 'skills', outputs: '.fit-check.json' },
    });
    const { entries, status } = collectCli(tmp);
    assert.equal(status.status, 'ok');
    assert.equal(entries.length, 2);
    const audit = entries.find((e) => e.name === 'audit:code');
    assert.equal(audit.description, 'Run audit');
    assert.equal(audit.category, 'audit');
    assert.equal(audit.relatedSkill, 'audit-code');
    assert.equal(audit.uncatalogued, false);
    assert.equal(audit.command, 'node scripts/audit.mjs code');

    const fit = entries.find((e) => e.name === 'skills:fit-check');
    assert.equal(fit.outputs, '.fit-check.json');
    assert.equal(fit.category, 'skills');
  });
});

test('collectCli marks uncatalogued scripts and reports the count in source.detail', () => {
  withTmp((tmp) => {
    writePkg(tmp, {
      'audit:code': 'node x',
      'mystery':    'node y',
      'wild':       'node z',
    });
    mkScriptsDir(tmp);
    writeCatalog(tmp, {
      'audit:code': { description: 'Cataloged', category: 'audit' },
    });
    const { entries, status } = collectCli(tmp);
    const m = entries.find((e) => e.name === 'mystery');
    assert.equal(m.uncatalogued, true);
    assert.equal(m.description, '');
    assert.equal(m.category, 'other', 'uncatalogued falls back to category=other');
    assert.equal(status.status, 'ok');
    assert.match(status.detail, /2 script\(s\) without a catalog entry/);
  });
});

test('collectCli normalises invalid catalog categories to "other"', () => {
  withTmp((tmp) => {
    writePkg(tmp, { 'weird': 'node x' });
    mkScriptsDir(tmp);
    writeCatalog(tmp, {
      'weird': { description: 'invalid cat', category: 'galactic-overdrive' },
    });
    const { entries } = collectCli(tmp);
    assert.equal(entries[0].category, 'other');
  });
});

test('collectCli returns unexpected-error when catalog JSON is malformed', () => {
  withTmp((tmp) => {
    writePkg(tmp, { 'x': 'node y' });
    mkScriptsDir(tmp);
    fs.writeFileSync(path.join(tmp, 'scripts', '.cli-catalog.json'), 'not valid json {{{');
    const { entries, status } = collectCli(tmp);
    assert.deepEqual(entries, []);
    assert.equal(status.status, 'unexpected-error');
    assert.match(status.detail, /catalog\.json parse error/);
  });
});

test('collectCli works without any catalog (every entry uncatalogued)', () => {
  withTmp((tmp) => {
    writePkg(tmp, { 'a': 'node a', 'b': 'node b' });
    const { entries, status } = collectCli(tmp);
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.uncatalogued === true));
    assert.equal(status.status, 'ok');
    assert.match(status.detail, /2 script\(s\) without a catalog entry/);
  });
});

test('collectCli stable sort: category then name', () => {
  withTmp((tmp) => {
    writePkg(tmp, { 'b': '', 'a': '', 'c': '' });
    mkScriptsDir(tmp);
    writeCatalog(tmp, {
      'a': { description: '', category: 'sync' },
      'b': { description: '', category: 'audit' },
      'c': { description: '', category: 'audit' },
    });
    const { entries } = collectCli(tmp);
    assert.deepEqual(entries.map((e) => e.name), ['b', 'c', 'a'],
      'audit-b, audit-c (alphabetical), then sync-a');
  });
});

// ─── groupByCategory ──────────────────────────────────────────────────────

test('groupByCategory partitions entries cleanly', () => {
  const entries = [
    { name: 'a', category: 'audit' }, { name: 'b', category: 'audit' },
    { name: 'c', category: 'sync' },
  ];
  const g = groupByCategory(entries);
  assert.deepEqual(g.audit.map((e) => e.name), ['a', 'b']);
  assert.deepEqual(g.sync.map((e) => e.name), ['c']);
});

// ─── auditCatalogCoverage ─────────────────────────────────────────────────

test('auditCatalogCoverage reports missing + orphaned scripts', () => {
  withTmp((tmp) => {
    writePkg(tmp, { 'a': '', 'b': '' });
    mkScriptsDir(tmp);
    writeCatalog(tmp, {
      'a': { description: '', category: 'audit' },
      'never-existed': { description: '', category: 'audit' },
    });
    const r = auditCatalogCoverage(tmp);
    assert.deepEqual(r.missing,  ['b']);
    assert.deepEqual(r.orphaned, ['never-existed']);
  });
});

// ─── REAL catalog vs THIS repo's package.json ─────────────────────────────

test('actual repo catalog covers every script in package.json (regression gate)', () => {
  const r = auditCatalogCoverage(path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..'));
  assert.deepEqual(r.missing, [],
    `New npm scripts without a catalog entry: ${r.missing.join(', ')}.\n` +
    'Add entries to scripts/.cli-catalog.json so they appear in the dashboard CLI section.');
  assert.deepEqual(r.orphaned, [],
    `Catalog entries pointing at scripts that no longer exist: ${r.orphaned.join(', ')}.`);
});

// ─── End-to-end render — sectionCli appears, groups in order ──────────────

test('renderDocument: CLI section renders with grouped entries', () => {
  const data = {
    kind: 'reference',
    provenance: { baseSha: 'abc1234', dirty: false, sourceHash: 'deadbeef' },
    sources: {
      skills: { status: 'ok', detail: '' },
      plans: { status: 'ok', detail: '' },
      architecture: { status: 'ok', detail: '' },
      flows: { status: 'ok', detail: '' },
      cli: { status: 'ok', detail: '' },
    },
    skills: [],
    plans: { active: [], completed: [] },
    architecture: {
      domains: [], deps: {}, mergedDeps: {},
      depsSource: {
        observedAvailable: false, observedRejectedReason: 'absent',
        observedRefreshId: null, observedGeneratedAt: null,
        manualKeyCount: 0,
        edgeCounts: { observed: 0, manual: 0, both: 0 },
      },
      mapPath: null,
    },
    flows: { nodes: [{ id: 'plan', skill: 'plan', label: 'Plan' }], edges: [] },
    cli: [
      { name: 'audit:code', command: 'node x', description: 'Run audit', category: 'audit',
        relatedSkill: 'audit-code', outputs: null, uncatalogued: false },
      { name: 'sync', command: 'node y', description: 'Sync', category: 'sync',
        relatedSkill: null, outputs: null, uncatalogued: false },
    ],
  };
  const html = renderDocument(data, 'reference', { css: '', js: '' });
  assert.ok(html.includes('CLI'), 'tab title appears');
  assert.match(html, /<h2 class="cli-group-title">Audit/);
  assert.match(html, /<h2 class="cli-group-title">Sync/);
  assert.match(html, /npm run audit:code/);
  assert.match(html, /\/audit-code/);
  // Audit group must come before Sync (CLI_CATEGORY_ORDER).
  const auditIdx = html.indexOf('cli-group-title">Audit');
  const syncIdx  = html.indexOf('cli-group-title">Sync');
  assert.ok(auditIdx > 0 && auditIdx < syncIdx, 'Audit precedes Sync in display order');
});

test('renderDocument: uncatalogued entries get the warn chip + muted desc', () => {
  const data = {
    kind: 'reference',
    provenance: { baseSha: 'a', dirty: false, sourceHash: 'b' },
    sources: {
      skills: { status: 'ok', detail: '' }, plans: { status: 'ok', detail: '' },
      architecture: { status: 'ok', detail: '' }, flows: { status: 'ok', detail: '' },
      cli: { status: 'ok', detail: '1 script(s) without a catalog entry' },
    },
    skills: [],
    plans: { active: [], completed: [] },
    architecture: {
      domains: [], deps: {}, mergedDeps: {},
      depsSource: {
        observedAvailable: false, observedRejectedReason: 'absent',
        observedRefreshId: null, observedGeneratedAt: null,
        manualKeyCount: 0,
        edgeCounts: { observed: 0, manual: 0, both: 0 },
      },
      mapPath: null,
    },
    flows: { nodes: [{ id: 'plan', skill: 'plan', label: 'Plan' }], edges: [] },
    cli: [
      { name: 'mystery', command: 'node x', description: '', category: 'other',
        relatedSkill: null, outputs: null, uncatalogued: true },
    ],
  };
  const html = renderDocument(data, 'reference', { css: '', js: '' });
  assert.match(html, /uncatalogued/);
  assert.match(html, /No description/);
});

// ─── skill-named entry points with no npm alias (persona-test 2026-10-06) ─────

function writeSkill(root, name, body, refs = {}) {
  const dir = path.join(root, 'skills', name);
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  for (const [f, text] of Object.entries(refs)) fs.writeFileSync(path.join(dir, 'references', f), text);
}

function touchScript(root, rel) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), '// cli\n');
}

test('collectCli lists a CLI a skill names when no npm script runs it', () => {
  withTmp((tmp) => {
    mkScriptsDir(tmp);
    writePkg(tmp, { 'audit:code': 'node scripts/openai-audit.mjs code' });
    touchScript(tmp, 'scripts/openai-audit.mjs');
    touchScript(tmp, 'scripts/fleet.mjs');
    writeSkill(tmp, 'fleet', 'Run `node scripts/fleet.mjs status`.\nThen node scripts/fleet.mjs next.');
    writeSkill(tmp, 'audit-code', 'Run node scripts/openai-audit.mjs code and node scripts/fleet.mjs status.');
    const { entries } = collectCli(tmp);
    const eps = entries.filter((e) => e.kind === 'entry-point');
    assert.deepEqual(eps.map((e) => e.name), ['scripts/fleet.mjs'], 'the npm-aliased script is not repeated');
    const fleet = eps[0];
    assert.equal(fleet.command, 'node scripts/fleet.mjs');
    assert.equal(fleet.relatedSkill, 'fleet', 'grouped under the skill that names it most');
    assert.equal(fleet.uncatalogued, true, 'no entryPoints metadata yet');
    assert.equal(fleet.category, 'skills');
    assert.equal(entries.find((e) => e.name === 'audit:code').kind, 'npm');
  });
});

test('collectCli entry points: a reference file counts, a missing file and opt-out do not', () => {
  withTmp((tmp) => {
    mkScriptsDir(tmp);
    writePkg(tmp, { x: 'node scripts/x.mjs' });
    touchScript(tmp, 'scripts/ship-commit.mjs');
    writeSkill(tmp, 'ship', 'no commands here', {
      'step6.md': 'node scripts/ship-commit.mjs --skill ship\nnode scripts/ghost.mjs',
    });
    const names = collectCli(tmp).entries.filter((e) => e.kind === 'entry-point').map((e) => e.name);
    assert.deepEqual(names, ['scripts/ship-commit.mjs'], 'a named script that does not exist is not listed');
    assert.equal(collectCli(tmp, { entryPoints: false }).entries.some((e) => e.kind === 'entry-point'), false);
  });
});

test('collectCli entry points take description + category from the catalog entryPoints block', () => {
  withTmp((tmp) => {
    mkScriptsDir(tmp);
    writePkg(tmp, { x: 'node scripts/x.mjs' });
    touchScript(tmp, 'scripts/fleet.mjs');
    writeSkill(tmp, 'fleet', 'node scripts/fleet.mjs status');
    fs.writeFileSync(path.join(tmp, 'scripts', '.cli-catalog.json'), JSON.stringify({
      entries: { x: { description: 'x', category: 'other' } },
      entryPoints: { 'scripts/fleet.mjs': { description: 'coordinate sessions', category: 'diagnostic' } },
    }));
    const fleet = collectCli(tmp).entries.find((e) => e.name === 'scripts/fleet.mjs');
    assert.equal(fleet.description, 'coordinate sessions');
    assert.equal(fleet.category, 'diagnostic');
    assert.equal(fleet.uncatalogued, false);
  });
});

test('this repo: every skill-named CLI without an npm alias is catalogued, fleet.mjs included', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const eps = collectCli(root).entries.filter((e) => e.kind === 'entry-point');
  assert.ok(eps.some((e) => e.name === 'scripts/fleet.mjs' && e.relatedSkill === 'fleet'), 'fleet.mjs is on the CLI tab');
  assert.deepEqual(eps.filter((e) => e.uncatalogued).map((e) => e.name), [],
    'add the new entry point to scripts/.cli-catalog.json entryPoints');
});

test('renderDocument titles an entry point by its node command, not `npm run`', () => {
  withTmp((tmp) => {
    mkScriptsDir(tmp);
    writePkg(tmp, { x: 'node scripts/x.mjs' });
    touchScript(tmp, 'scripts/fleet.mjs');
    writeSkill(tmp, 'fleet', 'node scripts/fleet.mjs status');
    const { entries } = collectCli(tmp);
    const html = renderDocument({
      kind: 'reference',
      provenance: { baseSha: 'a', dirty: false, sourceHash: 'b' },
      sources: {
        skills: { status: 'ok', detail: '' }, plans: { status: 'ok', detail: '' },
        architecture: { status: 'ok', detail: '' }, flows: { status: 'ok', detail: '' },
        cli: { status: 'ok', detail: '' },
      },
      skills: [],
      plans: { active: [], completed: [] },
      architecture: {
        domains: [], deps: {}, mergedDeps: {},
        depsSource: {
          observedAvailable: false, observedRejectedReason: 'absent',
          observedRefreshId: null, observedGeneratedAt: null,
          manualKeyCount: 0, edgeCounts: { observed: 0, manual: 0, both: 0 },
        },
        mapPath: null,
      },
      flows: { nodes: [{ id: 'plan', skill: 'plan', label: 'Plan' }], edges: [] },
      cli: entries,
    }, 'reference', { css: '', js: '' });
    assert.match(html, /<code>node scripts\/fleet\.mjs<\/code>/);
    assert.match(html, /no npm alias/);
    assert.doesNotMatch(html, /npm run scripts\/fleet\.mjs/);
  });
});

test('collectCli lists skill-named entry points even when package.json has no scripts', () => {
  withTmp((tmp) => {
    mkScriptsDir(tmp);
    writePkg(tmp, {});
    touchScript(tmp, 'scripts/fleet.mjs');
    writeSkill(tmp, 'fleet', 'node scripts/fleet.mjs status');
    const { entries, status } = collectCli(tmp);
    assert.deepEqual(entries.map((e) => e.name), ['scripts/fleet.mjs']);
    assert.equal(status.status, 'ok');
  });
});
