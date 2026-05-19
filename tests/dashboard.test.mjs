/**
 * @fileoverview Tests for the local dashboard subsystem.
 * Covers: output encoding (the security boundary), render purity +
 * determinism, schema validation, plan discovery, requirements collection
 * + redaction, the static server (path containment / Host allowlist /
 * no-store), CLI arg validation, and CORE_SCRIPTS sync completeness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { renderDocument, escapeHtml, jsonScriptSafe, __test__ as renderTest } from '../scripts/lib/dashboard/render.mjs';
import { validateDashboardData } from '../scripts/lib/dashboard/schema.mjs';
import { discoverPlans, collectArchitecture } from '../scripts/lib/dashboard/collect-reference.mjs';
import { __test__ as telemetryTest } from '../scripts/lib/dashboard/collect-telemetry.mjs';
import { serve } from '../scripts/lib/dashboard/serve.mjs';
import { parseArgs } from '../scripts/build-dashboard.mjs';

const ASSETS = { css: '/* css */', js: '/* js */' };

function refData(overrides = {}) {
  return {
    kind: 'reference',
    provenance: { baseSha: 'abc1234', dirty: false, sourceHash: 'deadbeef' },
    sources: {
      skills: { status: 'ok', detail: '' },
      plans: { status: 'ok', detail: '' },
      architecture: { status: 'ok', detail: '' },
      flows: { status: 'ok', detail: '' },
    },
    skills: [{
      name: 'plan', oneLiner: 'Plan things.', triggers: ['plan it'],
      usage: ['/plan x'], disableModelInvocation: false, path: 'skills/plan/SKILL.md',
    }],
    plans: { active: [], completed: [] },
    architecture: { domains: [], deps: {}, mapPath: null },
    flows: { nodes: [{ id: 'plan', skill: 'plan', label: 'Plan' }], edges: [] },
    ...overrides,
  };
}

function telData(overrides = {}) {
  return {
    kind: 'telemetry',
    provenance: { generatedAt: '2026-05-19T00:00:00.000Z', baseSha: 'abc', mode: 'local-only' },
    sources: {
      auditRuns: { status: 'missing-optional', detail: '' },
      requirements: { status: 'missing-optional', detail: '' },
      learning: { status: 'missing-optional', detail: '' },
    },
    auditRuns: { cloud: false, runCount: 0, labeledCount: 0, passes: [], local: { total: 0, labeled: 0 } },
    requirements: { present: false, total: 0, active: 0, truncated: false, items: [] },
    learning: { cloud: false, pendingTriageCount: 0, noBrainerCount: 0, staleClusterCount: 0 },
    ...overrides,
  };
}

// ── Output encoding — the security boundary ─────────────────────────────

test('escapeHtml neutralises HTML metacharacters', () => {
  assert.equal(escapeHtml('<img onerror=x>'), '&lt;img onerror=x&gt;');
  assert.equal(escapeHtml('a & "b" \'c\''), 'a &amp; &quot;b&quot; &#39;c&#39;');
});

test('jsonScriptSafe prevents the JSON block being closed early', () => {
  const out = jsonScriptSafe({ x: '</script><script>alert(1)</script>' });
  assert.ok(!out.includes('</script>'), 'must not contain a literal </script>');
  // Still valid JSON (\\u003c is a legal JSON escape) — round-trips exactly.
  assert.equal(JSON.parse(out).x, '</script><script>alert(1)</script>');
});

test('render escapes hostile data — no raw injection reaches markup', () => {
  const data = refData({
    skills: [{
      name: 'evil', oneLiner: '<img src=x onerror=alert(1)>', triggers: ['</script>'],
      usage: [], disableModelInvocation: false, path: 'p',
    }],
  });
  const html = renderDocument(data, 'reference', ASSETS);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'hostile oneLiner escaped');
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'no raw <img> in output');
  // The embedded data block must not be closed early by the trigger string.
  const block = html.split('id="dashboard-data">')[1].split('</script>')[0];
  assert.ok(!block.includes('<'), 'data block has no raw < (jsonScriptSafe applied)');
});

// ── Render purity / determinism ─────────────────────────────────────────

test('render is deterministic — same input, byte-identical output', () => {
  assert.equal(
    renderDocument(refData(), 'reference', ASSETS),
    renderDocument(refData(), 'reference', ASSETS),
  );
});

test('committed reference page carries no ISO timestamp', () => {
  const html = renderDocument(refData(), 'reference', ASSETS);
  assert.ok(!/\d{4}-\d\d-\d\dT\d\d:\d\d/.test(html), 'no ISO-8601 timestamp on the committed page');
  assert.ok(html.includes('data-testid="freshness-banner"'));
  assert.ok(html.includes('abc1234'), 'base SHA present');
});

test('render produces a single <h1> for both kinds', () => {
  for (const [kind, data] of [['reference', refData()], ['telemetry', telData()]]) {
    const html = renderDocument(data, kind, ASSETS);
    assert.equal((html.match(/<h1>/g) || []).length, 1, `${kind}: exactly one h1`);
  }
});

test('reference page carries the a11y + responsive markup fixes', () => {
  const html = renderDocument(refData(), 'reference', ASSETS);
  assert.ok(html.includes('class="skip-link"'), 'skip link present');
  assert.ok(html.includes('id="main"'), 'main landmark id present');
  assert.ok(html.includes('aria-current="page"'), 'current nav item marked aria-current');
  assert.ok(html.includes('<label for="skill-search">'), 'search has a visible label');
  assert.ok(html.includes('data-role="skill-count"'), 'search has a result-count status region');
  // skill cards name themselves from their heading, not a terse override
  assert.ok(html.includes('aria-labelledby="skill-h-plan"'), 'card named via aria-labelledby');
  assert.ok(!/aria-label="plan"/.test(html), 'no terse aria-label override on the card');
});

test('telemetry tables are wrapped for horizontal scroll', () => {
  const data = telData({
    sources: {
      auditRuns: { status: 'ok', detail: '' },
      requirements: { status: 'missing-optional', detail: '' },
      learning: { status: 'missing-optional', detail: '' },
    },
    auditRuns: {
      cloud: true, runCount: 5, labeledCount: 2,
      passes: [{ name: 'structure', runs: 5, raised: 3, accepted: 2, dismissed: 1 }],
      local: { total: 0, labeled: 0 },
    },
  });
  const html = renderDocument(data, 'telemetry', ASSETS);
  assert.ok(html.includes('<div class="table-wrap"><table>'), 'table wrapped in overflow container');
  assert.ok(html.includes('project-wide'), 'audit-runs honestly labelled project-wide');
});

test('telemetry page-level placeholder shows only when all sources non-ok', () => {
  const allOff = renderDocument(telData(), 'telemetry', ASSETS);
  assert.ok(allOff.includes('data-testid="telemetry-empty"'), 'page-level placeholder present');
  // One ok source → no page-level placeholder, tabs render instead.
  const oneOk = telData({
    sources: {
      auditRuns: { status: 'ok', detail: '' },
      requirements: { status: 'missing-optional', detail: '' },
      learning: { status: 'missing-optional', detail: '' },
    },
    auditRuns: { cloud: false, runCount: 0, labeledCount: 0, passes: [], local: { total: 3, labeled: 1 } },
  });
  const html = renderDocument(oneOk, 'telemetry', ASSETS);
  assert.ok(html.includes('role="tablist"'), 'tabs render when a section is ok');
});

// ── Schema validation ───────────────────────────────────────────────────

test('schema rejects a malformed data object', () => {
  assert.throws(() => validateDashboardData('reference', { kind: 'reference' }));
  assert.throws(() => validateDashboardData('telemetry', telData({ kind: 'reference' })));
});

test('schema accepts well-formed objects', () => {
  assert.doesNotThrow(() => validateDashboardData('reference', refData()));
  assert.doesNotThrow(() => validateDashboardData('telemetry', telData()));
});

// ── Plan discovery ──────────────────────────────────────────────────────

test('discoverPlans includes only # Plan: files, excludes audit-summaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-plans-'));
  fs.mkdirSync(path.join(root, 'docs/plans'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs/completed'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/plans/good.md'),
    '# Plan: Good\n- **Date**: 2026-05-19\n- **Status**: Draft\n');
  fs.writeFileSync(path.join(root, 'docs/completed/done.md'),
    '# Plan: Done\n- **Date**: 2026-01-01\n- **Status**: Complete\n');
  fs.writeFileSync(path.join(root, 'docs/completed/x-audit-summary.md'),
    '# Plan: Sneaky\n- **Date**: 2026-02-02\n- **Status**: x\n');
  fs.writeFileSync(path.join(root, 'docs/completed/note.md'), '# Just a note\nnot a plan\n');
  fs.writeFileSync(path.join(root, 'docs/plans/loose.md'), '# Plan: Loose\nno metadata here\n');
  fs.writeFileSync(path.join(root, 'docs/plans/baddate.md'),
    '# Plan: BadDate\n- **Date**: not-a-date\n- **Status**: Draft\n');

  const out = discoverPlans(root);
  assert.deepEqual(out.active.map((p) => p.title).sort(), ['BadDate', 'Good', 'Loose']);
  assert.deepEqual(out.completed.map((p) => p.title), ['Done']);
  assert.ok(!JSON.stringify(out).includes('Sneaky'), 'audit-summary excluded');
  assert.ok(!JSON.stringify(out).includes('Just a note'), 'non-plan excluded');
  assert.equal(out.active.find((p) => p.title === 'Loose').malformed, true,
    'metadata-less plan flagged malformed');
  assert.equal(out.active.find((p) => p.title === 'BadDate').malformed, true,
    'plan with an unparseable Date flagged malformed');
  assert.deepEqual(out.readErrors, [], 'no read errors on a clean fixture');
});

test('sectionAuditRuns keeps local fallback data visible on a cloud error', () => {
  // collector classifies the source unexpected-error, but local data exists —
  // the renderer must still surface it (degraded-mode data-loss guard).
  const data = telData({
    sources: {
      auditRuns: { status: 'unexpected-error', detail: 'cloud down' },
      requirements: { status: 'missing-optional', detail: '' },
      learning: { status: 'missing-optional', detail: '' },
    },
    auditRuns: {
      cloud: false, runCount: 0, labeledCount: 0, passes: [],
      local: { total: 7, labeled: 3 },
    },
  });
  const html = renderDocument(data, 'telemetry', ASSETS);
  assert.ok(html.includes('warn-panel'), 'cloud error shown as a warning');
  assert.ok(html.includes('local-only'), 'local fallback data still rendered, not discarded');
});

// ── Architecture map ────────────────────────────────────────────────────

test('collectArchitecture parses every domain in the ## Contents block', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-arch-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/architecture-map.md'), [
    '# Architecture Map', '',
    '## Contents',
    '- [alpha](#alpha) — 12 symbols',
    '- [beta](#beta) — 7 symbols',
    '- [gamma](#gamma) — 30 symbols',
    '', '---', '',
    '## alpha', '', '> The alpha domain does alpha things.', '',
    '## beta', '', '> The beta domain does beta things.', '',
    '## gamma', '', '> The gamma domain does gamma things.', '',
  ].join('\n'));
  const res = collectArchitecture(root);
  assert.equal(res.status.status, 'ok');
  assert.deepEqual(res.domains.map((d) => d.name), ['alpha', 'beta', 'gamma'],
    'all three domains parsed — not just the first');
  assert.equal(res.domains[0].symbolCount, 12);
  assert.match(res.domains[2].summary, /gamma domain/);
});

test('collectArchitecture: absent map → missing-optional (never invalid)', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-arch-empty-'));
  assert.equal(collectArchitecture(empty).status.status, 'missing-optional');
});

test('architecture renders domains in dependency layers', () => {
  const data = refData({
    architecture: {
      mapPath: 'docs/architecture-map.md',
      domains: [
        { name: 'base', anchor: 'base', symbolCount: 10, summary: 'foundation.' },
        { name: 'mid', anchor: 'mid', symbolCount: 20, summary: 'middle.' },
        { name: 'top', anchor: 'top', symbolCount: 5, summary: 'orchestrator.' },
      ],
      deps: { mid: ['base'], top: ['mid'] },
    },
  });
  const html = renderDocument(data, 'reference', ASSETS);
  // 3 domains → 3 layers; a proportional bar (not box width) carries the
  // symbol count — boxes are uniform width so the box itself never misleads.
  assert.equal((html.match(/class="arch-layer"/g) || []).length, 3, 'one band per layer');
  assert.ok(html.includes('depends on: base'), 'dependency line rendered');
  assert.ok(html.includes('foundation — no domain deps'), 'foundation marked');
  assert.ok(html.includes('class="arch-bar"'), 'proportional symbol-count bar rendered');
  // mid has the most symbols (20) → its bar fills 100%.
  assert.ok(/<span style="width:100%"/.test(html), 'bar width carries the symbol count');
});

// ── Requirements collection ─────────────────────────────────────────────

test('collectRequirements parses the ledger and shows statements verbatim', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-req-'));
  fs.mkdirSync(path.join(root, '.requirements'), { recursive: true });
  fs.writeFileSync(path.join(root, '.requirements/ledger.json'), JSON.stringify({
    requirements: [{
      id: 'REQ-1', kind: 'security', status: 'active',
      assertion: 'Credentials must never be logged in plaintext.',
    }],
  }));
  const res = telemetryTest.collectRequirements(root);
  assert.equal(res.status.status, 'ok');
  assert.equal(res.data.total, 1);
  assert.equal(res.data.active, 1);
  // Requirement prose comes from the committed ledger — it is descriptive
  // text, not a secret-bearing surface, so it is shown verbatim (redaction
  // false-positived on ordinary words like "[REDACTED_TOKEN]").
  assert.equal(res.data.items[0].statement,
    'Credentials must never be logged in plaintext.',
    'statement rendered verbatim, not mangled by redaction');
});

test('collectRequirements: absent ledger → missing-optional, malformed → invalid', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-req-empty-'));
  assert.equal(telemetryTest.collectRequirements(empty).status.status, 'missing-optional');

  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-req-bad-'));
  fs.mkdirSync(path.join(bad, '.requirements'), { recursive: true });
  fs.writeFileSync(path.join(bad, '.requirements/ledger.json'), '{not json');
  assert.equal(telemetryTest.collectRequirements(bad).status.status, 'invalid');
});

// ── Static server ───────────────────────────────────────────────────────

function httpGet(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('serve: containment, Host allowlist, no-store headers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-serve-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>ok</title>');
  const { server, port } = await serve({ dir, port: 0, explicitPort: true, open: false });
  try {
    const okHost = `127.0.0.1:${port}`;

    const good = await httpGet(port, '/index.html', { Host: okHost });
    assert.equal(good.status, 200);
    assert.match(good.headers['cache-control'], /no-store/);

    const badHost = await httpGet(port, '/index.html', { Host: 'evil.example' });
    assert.equal(badHost.status, 403, 'foreign Host header rejected (DNS-rebinding defence)');

    const traverse = await httpGet(port, '/../../../etc/passwd', { Host: okHost });
    assert.ok(traverse.status === 403 || traverse.status === 404, 'path traversal blocked');
  } finally {
    server.close();
  }
});

// ── CLI argument validation ─────────────────────────────────────────────

test('parseArgs rejects bad input', () => {
  assert.throws(() => parseArgs(['bogus']), /Unknown subcommand/);
  assert.throws(() => parseArgs([]), /Missing subcommand/);
  assert.throws(() => parseArgs(['reference', '--port', '8080']), /only valid with/);
  assert.throws(() => parseArgs(['serve', '--port', '80']), /1024/);
  assert.throws(() => parseArgs(['serve', '--bogus']), /Unknown flag/);
});

test('parseArgs accepts valid input', () => {
  assert.equal(parseArgs(['all']).cmd, 'all');
  const s = parseArgs(['serve', '--port', '5000']);
  assert.equal(s.cmd, 'serve');
  assert.equal(s.port, 5000);
  assert.equal(s.explicitPort, true);
});

// ── CORE_SCRIPTS sync completeness (guards plan H6) ─────────────────────

test('every dashboard module is registered in CORE_SCRIPTS', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const syncSrc = fs.readFileSync(path.join(repoRoot, 'scripts/sync-to-repos.mjs'), 'utf-8');

  // Walk the static .mjs import graph from build-dashboard.mjs (scripts/-local).
  const seen = new Set();
  const walk = (relPath) => {
    if (seen.has(relPath)) return;
    seen.add(relPath);
    const abs = path.join(repoRoot, relPath);
    let src;
    try { src = fs.readFileSync(abs, 'utf-8'); } catch { return; }
    const importRe = /from\s+['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(src)) !== null) {
      const dep = path.normalize(path.join(path.dirname(relPath), m[1])).replace(/\\/g, '/');
      if (dep.startsWith('scripts/')) walk(dep);
    }
  };
  walk('scripts/build-dashboard.mjs');

  // Non-import deps read via fs at runtime must also ship.
  const fsDeps = [
    'scripts/lib/dashboard/flows.json',
    'scripts/lib/dashboard/assets/dashboard.css',
    'scripts/lib/dashboard/assets/dashboard.js',
  ];

  for (const dep of [...seen, ...fsDeps]) {
    if (dep === 'scripts/build-dashboard.mjs') {
      assert.ok(syncSrc.includes("'scripts/build-dashboard.mjs'"), 'entry in CORE_SCRIPTS');
      continue;
    }
    assert.ok(syncSrc.includes(`'${dep}'`), `${dep} must be in CORE_SCRIPTS`);
  }
});
