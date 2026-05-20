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
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
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
    architecture: { domains: [], deps: {}, mapPath: null },
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
    architecture: { domains: [], deps: {}, mapPath: null },
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
