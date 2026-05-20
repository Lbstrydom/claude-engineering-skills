/**
 * @fileoverview Fixture-driven tests for the skills fit-check diagnostic.
 *
 * Five fixture repos under tests/fixtures/fit-check/ exercise the
 * detect → rules → render pipeline. Each fixture asserts the labels
 * the rules table is supposed to emit for that shape. When the rules
 * table evolves, this file is the place to lock in behavioural changes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { detectShape } from '../scripts/lib/fit-check/detect.mjs';
import { applyRules, groupByLabel, SKILLS } from '../scripts/lib/fit-check/rules.mjs';
import { parseArgs, runFitCheck, renderCard } from '../scripts/skills-fit-check.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'fit-check');

function fixture(name) { return path.join(FIXTURES, name); }
function verdictFor(verdicts, skill) {
  return verdicts.find((v) => v.skill === skill);
}

// ─── detectShape ───────────────────────────────────────────────────────────

describe('detectShape — Next.js with Playwright', () => {
  const p = detectShape(fixture('nextjs-with-playwright'));
  it('stack=js-ts, framework=nextjs', () => {
    assert.equal(p.stack, 'js-ts');
    assert.equal(p.framework, 'nextjs');
  });
  it('has UI routes + HTTP boundary', () => {
    assert.equal(p.hasUiRoutes, true);
    assert.equal(p.hasHttpBoundary, true);
  });
  it('Playwright detected via devDependency', () => {
    assert.equal(p.hasPlaywright, true);
  });
  it('vitest detected as test runner', () => {
    assert.equal(p.testRunner, 'vitest');
  });
  it('data-engine-claim annotation grep hits app/page.tsx', () => {
    assert.equal(p.hasEngineClaimAnnotations, true);
  });
  it('no .persona-test/surfaces.json yet', () => {
    assert.equal(p.hasPersonaTestManifest, false);
  });
  it('isPlugin=false', () => {
    assert.equal(p.isPlugin, false);
  });
});

describe('detectShape — Vite SPA, no Playwright', () => {
  const p = detectShape(fixture('vite-react-no-playwright'));
  it('framework=vite-spa', () => {
    assert.equal(p.framework, 'vite-spa');
  });
  it('UI routes yes, HTTP boundary yes (SPA serves)', () => {
    assert.equal(p.hasUiRoutes, true);
    assert.equal(p.hasHttpBoundary, true);
  });
  it('Playwright NOT detected', () => {
    assert.equal(p.hasPlaywright, false);
  });
  it('no data-engine-claim annotations', () => {
    assert.equal(p.hasEngineClaimAnnotations, false);
  });
});

describe('detectShape — Python FastAPI', () => {
  const p = detectShape(fixture('python-fastapi'));
  it('stack=python, framework=fastapi', () => {
    assert.equal(p.stack, 'python');
    assert.equal(p.framework, 'fastapi');
  });
  it('HTTP boundary yes (FastAPI), UI routes no', () => {
    assert.equal(p.hasHttpBoundary, true);
    assert.equal(p.hasUiRoutes, false);
  });
  it('pytest detected as test runner', () => {
    assert.equal(p.testRunner, 'pytest');
  });
});

describe('detectShape — Obsidian plugin', () => {
  const p = detectShape(fixture('obsidian-plugin'));
  it('framework=obsidian-plugin (manifest.json with minAppVersion wins over generic node)', () => {
    assert.equal(p.framework, 'obsidian-plugin');
  });
  it('isPlugin=true', () => {
    assert.equal(p.isPlugin, true);
  });
  it('UI routes no, HTTP boundary no (plugin runtime)', () => {
    assert.equal(p.hasUiRoutes, false);
    assert.equal(p.hasHttpBoundary, false);
  });
});

describe('detectShape — Node CLI tool', () => {
  const p = detectShape(fixture('node-cli-tool'));
  it('stack=js-ts, framework=generic-node (no UI framework signature)', () => {
    assert.equal(p.stack, 'js-ts');
    assert.equal(p.framework, 'generic-node');
  });
  it('hasCliBin=true via package.json bin field', () => {
    assert.equal(p.hasCliBin, true);
  });
  it('no UI routes, no HTTP boundary', () => {
    assert.equal(p.hasUiRoutes, false);
    assert.equal(p.hasHttpBoundary, false);
  });
});

describe('detectShape — unknown shape (empty repo)', () => {
  const p = detectShape(fixture('unknown-shape'));
  it('stack=unknown, framework=unknown', () => {
    assert.equal(p.stack, 'unknown');
    assert.equal(p.framework, 'unknown');
  });
  it('no UI surface, no HTTP, no Playwright', () => {
    assert.equal(p.hasUiRoutes, false);
    assert.equal(p.hasHttpBoundary, false);
    assert.equal(p.hasPlaywright, false);
  });
});

// ─── applyRules — per-fixture skill verdicts ───────────────────────────────

describe('applyRules — Next.js + Playwright fixture', () => {
  const profile = detectShape(fixture('nextjs-with-playwright'));
  const verdicts = applyRules(profile);

  it('/plan, /audit-plan, /audit-code, /ship → FITS', () => {
    for (const skill of ['/plan', '/audit-plan', '/audit-code', '/ship']) {
      assert.equal(verdictFor(verdicts, skill).label, 'FITS', skill);
    }
  });
  it('/ux-lock (lock mode) → FITS (UI + Playwright)', () => {
    assert.equal(verdictFor(verdicts, '/ux-lock (lock mode)').label, 'FITS');
  });
  it('/ux-lock verify → PARTIAL (no docs/plans/ yet)', () => {
    const v = verdictFor(verdicts, '/ux-lock verify');
    assert.equal(v.label, 'PARTIAL');
    assert.match(v.setup, /\/plan first/);
  });
  it('/persona-test consistency → PARTIAL (annotations present but no manifest)', () => {
    const v = verdictFor(verdicts, '/persona-test (consistency mode)');
    assert.equal(v.label, 'PARTIAL');
    assert.match(v.setup, /surfaces\.json/);
  });
});

describe('applyRules — Vite SPA, no Playwright', () => {
  const profile = detectShape(fixture('vite-react-no-playwright'));
  const verdicts = applyRules(profile);

  it('/ux-lock → PARTIAL (UI yes, Playwright no)', () => {
    const v = verdictFor(verdicts, '/ux-lock (lock mode)');
    assert.equal(v.label, 'PARTIAL');
    assert.match(v.setup, /@playwright\/test/);
  });
  it('/persona-test exploratory → PARTIAL (web surface but app URL needed)', () => {
    const v = verdictFor(verdicts, '/persona-test (exploratory)');
    assert.equal(v.label, 'PARTIAL');
    assert.match(v.setup, /PERSONA_TEST_APP_URL/);
  });
});

describe('applyRules — Python FastAPI (backend-only API)', () => {
  const profile = detectShape(fixture('python-fastapi'));
  const verdicts = applyRules(profile);

  it('/audit-code → FITS', () => {
    assert.equal(verdictFor(verdicts, '/audit-code').label, 'FITS');
  });
  it('/ux-lock (lock mode) → MISMATCH (no UI routes)', () => {
    const v = verdictFor(verdicts, '/ux-lock (lock mode)');
    assert.equal(v.label, 'MISMATCH');
    assert.match(v.reason, /No UI routes/);
  });
  it('/persona-test consistency → PARTIAL (HTTP boundary present, annotations missing)', () => {
    const v = verdictFor(verdicts, '/persona-test (consistency mode)');
    assert.equal(v.label, 'PARTIAL');
  });
});

describe('applyRules — Obsidian plugin (ai-organiser shape)', () => {
  const profile = detectShape(fixture('obsidian-plugin'));
  const verdicts = applyRules(profile);

  it('/plan, /audit-plan, /audit-code → FITS (universal)', () => {
    for (const skill of ['/plan', '/audit-plan', '/audit-code']) {
      assert.equal(verdictFor(verdicts, skill).label, 'FITS', skill);
    }
  });
  it('/ux-lock (lock mode) → MISMATCH (URL-addressable required)', () => {
    const v = verdictFor(verdicts, '/ux-lock (lock mode)');
    assert.equal(v.label, 'MISMATCH');
    assert.match(v.reason, /URL-addressable/);
  });
  it('/ux-lock verify → MISMATCH', () => {
    assert.equal(verdictFor(verdicts, '/ux-lock verify').label, 'MISMATCH');
  });
  it('/persona-test exploratory → PARTIAL (CDP attach hint)', () => {
    const v = verdictFor(verdicts, '/persona-test (exploratory)');
    assert.equal(v.label, 'PARTIAL');
    assert.match(v.setup, /CDP/);
  });
  it('/persona-test consistency → MISMATCH (no HTTP boundary)', () => {
    const v = verdictFor(verdicts, '/persona-test (consistency mode)');
    assert.equal(v.label, 'MISMATCH');
    assert.match(v.reason, /HTTP boundary/);
  });
  it('/ship Step 5.6 → MISMATCH (depends on consistency adoption)', () => {
    assert.equal(verdictFor(verdicts, '/ship Step 5.6 (consistency promotion)').label, 'MISMATCH');
  });
});

describe('applyRules — Node CLI tool', () => {
  const profile = detectShape(fixture('node-cli-tool'));
  const verdicts = applyRules(profile);

  it('/audit-code → FITS', () => {
    assert.equal(verdictFor(verdicts, '/audit-code').label, 'FITS');
  });
  it('/ux-lock + /persona-test consistency → MISMATCH (no UI/HTTP)', () => {
    assert.equal(verdictFor(verdicts, '/ux-lock (lock mode)').label, 'MISMATCH');
    assert.equal(verdictFor(verdicts, '/persona-test (consistency mode)').label, 'MISMATCH');
  });
});

describe('applyRules — unknown shape (empty repo)', () => {
  const profile = detectShape(fixture('unknown-shape'));
  const verdicts = applyRules(profile);

  it('/audit-code → PARTIAL (unknown stack, but graceful)', () => {
    const v = verdictFor(verdicts, '/audit-code');
    assert.equal(v.label, 'PARTIAL');
    assert.match(v.reason, /No recognised stack/);
  });
  it('/plan still FITS even with unknown stack (planner is universal)', () => {
    assert.equal(verdictFor(verdicts, '/plan').label, 'FITS');
  });
});

// ─── groupByLabel + verdict surface area ───────────────────────────────────

describe('rule coverage', () => {
  it('every skill in SKILLS has exactly one verdict from applyRules', () => {
    const profile = detectShape(fixture('nextjs-with-playwright'));
    const verdicts = applyRules(profile);
    assert.equal(verdicts.length, SKILLS.length);
    for (const v of verdicts) {
      assert.ok(['FITS', 'PARTIAL', 'MISMATCH'].includes(v.label),
        `unexpected label ${v.label} for ${v.skill}`);
      assert.ok(v.reason && typeof v.reason === 'string', `${v.skill} missing reason`);
    }
  });
  it('groupByLabel partitions cleanly (no missing, no duplicates)', () => {
    const profile = detectShape(fixture('nextjs-with-playwright'));
    const verdicts = applyRules(profile);
    const g = groupByLabel(verdicts);
    assert.equal(g.fits.length + g.partial.length + g.mismatch.length, verdicts.length);
  });
});

// ─── CLI integration ───────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('parses --repo-root, --json, --quiet, --help', () => {
    const a = parseArgs(['--repo-root', '/tmp/x', '--json', '--quiet']);
    assert.equal(a.repoRoot, '/tmp/x');
    assert.equal(a.json, true);
    assert.equal(a.quiet, true);
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs(['-h']).help, true);
  });
  it('defaults repoRoot to cwd', () => {
    assert.equal(parseArgs([]).repoRoot, process.cwd());
  });
});

describe('runFitCheck — end-to-end', () => {
  it('writes .skills-fit-check.json to the repo root', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-check-'));
    try {
      // Copy minimal nextjs fixture into the temp dir.
      const src = fixture('nextjs-with-playwright');
      copyDir(src, tmp);
      const { exitCode, report } = runFitCheck({ repoRoot: tmp });
      assert.equal(exitCode, 0);
      assert.equal(report.profile.framework, 'nextjs');
      const written = JSON.parse(fs.readFileSync(path.join(tmp, '.skills-fit-check.json'), 'utf-8'));
      assert.equal(written.profile.framework, 'nextjs');
      assert.equal(written.summary.fits + written.summary.partial + written.summary.mismatch,
                   written.verdicts.length);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('renderCard includes FITS/PARTIAL/MISMATCH sections appropriately', () => {
    const profile = detectShape(fixture('obsidian-plugin'));
    const verdicts = applyRules(profile);
    const report = { profile, verdicts, generatedAt: '', repoRoot: '', version: 1 };
    const card = renderCard(report);
    assert.match(card, /Skills fit-check/);
    assert.match(card, /FITS/);
    assert.match(card, /MISMATCH/);
    assert.match(card, /obsidian-plugin/);
  });

  it('exitCode=1 when repo-root does not exist', () => {
    const { exitCode, error } = runFitCheck({ repoRoot: '/this/path/does/not/exist/xyz' });
    assert.equal(exitCode, 1);
    assert.match(error, /not found/);
  });
});

// ─── helpers ───────────────────────────────────────────────────────────────

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
