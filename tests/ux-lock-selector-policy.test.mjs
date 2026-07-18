/**
 * @fileoverview Selector-policy lint tests (plan: docs/plans/ux-lock-selector-policy.md).
 *
 * Covers the plan §3E fixture matrix: allowlist-semantics classification
 * (deny-by-default), marker grammar (mandatory reason, one-line attachment,
 * stale markers), import legality (app source vs npm deps vs aliases, static +
 * dynamic + require), literal masking (no false imports from assertion
 * strings), closure scanning (helper evasion), and testRoot resolution.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  classifySelector, scanSpecSource, scanSpecClosure, resolveTestRoot,
  readAliasMapFromTsconfig, _internals,
} from '../scripts/lib/ux-lock/selector-policy.mjs';

const ROOT = path.resolve('/repo');
const TESTS = path.join(ROOT, 'tests');
const SPEC = path.join(TESTS, 'e2e', 'fix-modal.spec.js');

const scan = (source, extra = {}) =>
  scanSpecSource(source, { filePath: SPEC, testRoot: TESTS, ...extra });

const violationClasses = (r) => r.violations.map(v => v.class);

// ── classifySelector ─────────────────────────────────────────────────────────

describe('classifySelector — allowlist semantics, deny by default', () => {
  const semantic = [
    '[data-testid="cellar-grid"]',
    '[data-engine-claim="stock.count"]',
    '[role="dialog"]',
    '[aria-label="Add bottle"]',
    'button[aria-label="Add bottle"]',
    'div[data-testid="x"][aria-expanded="true"]',
    '[data-testid="a"] [data-testid="b"]', // combinator over semantic operands
  ];
  for (const s of semantic) {
    it(`semantic: ${s}`, () => assert.equal(classifySelector(s), 'semantic'));
  }

  const structural = [
    '#add-btn',
    '.grid-abc',
    'button#add',
    'div.card .title',
    '[class~="active"]',
    ':has(.x)',
    'li:nth-child(2)',
    'button',                    // bare tag — positional/structural
    'input[name="email"]',       // [name] is not on the semantic allowlist
    '[href="/settings"]',
    ':nth-match(button, 2)',
    'div > .cell',
    '',
  ];
  for (const s of structural) {
    it(`structural: ${JSON.stringify(s)}`, () => assert.equal(classifySelector(s), 'structural'));
  }
});

// ── selector call sites ──────────────────────────────────────────────────────

describe('scanSpecSource — selector call sites', () => {
  it('flags unjustified locator(#id)', () => {
    const r = scan(`await expect(page.locator('#x')).toBeVisible();`);
    assert.deepEqual(violationClasses(r), ['structural-selector']);
  });

  it('flags chained row.locator(.cell)', () => {
    const r = scan(`const cell = row.locator('.cell');`);
    assert.deepEqual(violationClasses(r), ['structural-selector']);
  });

  it('flags querySelector inside page.evaluate', () => {
    const r = scan(`await page.evaluate(() => document.querySelector('.hidden').click());`);
    assert.deepEqual(violationClasses(r), ['structural-selector']);
  });

  it('flags page.$ and page.$$ aliases', () => {
    const r = scan(`await page.$('.a');\nawait page.$$('#b');`);
    assert.equal(r.violations.length, 2);
  });

  it('template-literal selector → unresolvable-selector', () => {
    const r = scan('await page.locator(`#row-${id}`).click();');
    assert.deepEqual(violationClasses(r), ['unresolvable-selector']);
  });

  it('non-literal selector argument → unresolvable-selector', () => {
    const r = scan(`await page.locator(sel).click();`);
    assert.deepEqual(violationClasses(r), ['unresolvable-selector']);
  });

  it('getBy* calls and semantic locator() strings are clean', () => {
    const r = scan([
      `await page.getByRole('button', { name: 'Add bottle' }).click();`,
      `await page.getByTestId('cellar-grid').click();`,
      `await page.locator('[data-testid="x"]').click();`,
      `await page.locator('[data-engine-claim="stock.count"]').click();`,
      `await page.locator('button[aria-label="x"]').click();`,
    ].join('\n'));
    assert.deepEqual(r.violations, []);
  });

  it('multi-line call: argument on the next line is classified, marker attaches at call line', () => {
    const r = scan(`await page.locator(\n  '#split'\n).click();`);
    assert.deepEqual(violationClasses(r), ['structural-selector']);
    assert.equal(r.violations[0].line, 1);
  });

  it('locator-looking text inside a comment is NOT a violation', () => {
    const r = scan(`// page.locator('.x') would be wrong here\nawait page.getByRole('list');`);
    assert.deepEqual(r.violations, []);
  });
});

// ── marker grammar ───────────────────────────────────────────────────────────

describe('scanSpecSource — justification marker', () => {
  it('same-line marker justifies', () => {
    const r = scan(`await page.locator('#v').click(); // selector-policy: structural — vendor widget has no roles`);
    assert.deepEqual(r.violations, []);
    assert.equal(r.justifiedCount, 1);
  });

  it('line-above comment-only marker justifies', () => {
    const r = scan(`// selector-policy: structural — vendor widget has no roles\nawait page.locator('#v').click();`);
    assert.deepEqual(r.violations, []);
    assert.equal(r.justifiedCount, 1);
  });

  it('marker WITHOUT a reason justifies nothing (and is reported)', () => {
    const r = scan(`// selector-policy: structural\nawait page.locator('#v').click();`);
    assert.deepEqual(violationClasses(r), ['structural-selector']);
    assert.equal(r.staleMarkers.length, 1);
    assert.match(r.staleMarkers[0].reason, /missing-reason/);
  });

  it('blank line between marker and violation → violation + stale marker', () => {
    const r = scan(`// selector-policy: structural — reason\n\nawait page.locator('#v').click();`);
    assert.deepEqual(violationClasses(r), ['structural-selector']);
    assert.equal(r.staleMarkers.length, 1);
  });

  it('marker with no structural pattern on its target line is stale', () => {
    const r = scan(`// selector-policy: structural — leftover\nawait page.getByRole('list');`);
    assert.deepEqual(r.violations, []);
    assert.equal(r.staleMarkers.length, 1);
  });

  it('one marker covers all structural patterns on its single target line only', () => {
    const r = scan([
      `// selector-policy: structural — both on one line`,
      `await page.locator('#a').or(page.locator('.b')).click();`,
      `await page.locator('#c').click();`,
    ].join('\n'));
    assert.deepEqual(violationClasses(r), ['structural-selector']);
    assert.equal(r.violations[0].line, 3);
    assert.equal(r.justifiedCount, 2);
  });
});

// ── import legality ──────────────────────────────────────────────────────────

describe('scanSpecSource — app-module-import', () => {
  it('static app-source import → violation', () => {
    const r = scan(`import { helper } from '../../src/app.js';`);
    assert.deepEqual(violationClasses(r), ['app-module-import']);
  });

  it('dynamic app-source import → violation', () => {
    const r = scan(`const mod = await import('../../src/app.js');`);
    assert.deepEqual(violationClasses(r), ['app-module-import']);
  });

  it('require of app source → violation', () => {
    const r = scan(`const mod = require('../../src/app.js');`);
    assert.deepEqual(violationClasses(r), ['app-module-import']);
  });

  it('non-literal dynamic specifier → violation', () => {
    const r = scan(`await import(modPath);`);
    assert.deepEqual(violationClasses(r), ['app-module-import']);
  });

  it('URL and absolute imports → violation', () => {
    const r = scan(`import x from 'https://cdn.example.com/x.js';\nimport y from '/opt/app/y.js';`);
    assert.equal(r.violations.filter(v => v.class === 'app-module-import').length, 2);
  });

  it('test-root relatives, playwright, node builtins, axe, bare npm deps → clean', () => {
    const r = scan([
      `import { test, expect } from '@playwright/test';`,
      `import { loginAsTestUser } from './helpers/auth.js';`,
      `import shared from '../helpers/shared.js';`,
      `import path from 'node:path';`,
      `import AxeBuilder from '@axe-core/playwright';`,
      `import { faker } from '@faker-js/faker';`,
      `import _ from 'lodash';`,
      `import 'dotenv/config';`,
    ].join('\n'));
    assert.deepEqual(r.violations, []);
  });

  it('import inside a string literal is NOT detected (literal masking)', () => {
    const r = scan(`expect(msg).toContain("require('./missing')");`);
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.relativeImports, []);
  });

  it('mapped alias into app source → violation; into test root → closure; unmapped → warning', () => {
    const aliasMap = { '@/': path.join(ROOT, 'src'), '#t/': path.join(TESTS, 'shared') };
    const r = scan([
      `import a from '@/components/x.js';`,
      `import b from '#t/fixtures.js';`,
      `import c from '~/anything.js';`,
    ].join('\n'), { aliasMap });
    assert.deepEqual(violationClasses(r), ['app-module-import']);
    assert.equal(r.relativeImports.length, 1);
    assert.equal(r.unresolvedAliases.length, 1);
    assert.equal(r.unresolvedAliases[0].specifier, '~/anything.js');
  });

  it('@scope/pkg is npm, not an alias', () => {
    const r = scan(`import { z } from '@scope/pkg';`);
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.unresolvedAliases, []);
  });
});

// ── closure scanning ─────────────────────────────────────────────────────────

function memFs(files) {
  const store = new Map(Object.entries(files).map(([p, c]) => [path.resolve(p), c]));
  return {
    statSync(p) {
      if (!store.has(path.resolve(p))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { isFile: () => true };
    },
    readFileSync(p) {
      const c = store.get(path.resolve(p));
      if (c == null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return c;
    },
  };
}

describe('scanSpecClosure — helpers are part of the spec process', () => {
  const helperPath = path.join(TESTS, 'e2e', 'helpers', 'shell.js');

  it('app import moved into a helper is still caught (attributed to the helper file)', () => {
    const fsImpl = memFs({
      [SPEC]: `import { boot } from './helpers/shell.js';\nawait page.getByRole('list');`,
      [helperPath]: `import { app } from '../../../src/app.js';\nexport const boot = () => app;`,
    });
    const r = scanSpecClosure(SPEC, { testRoot: TESTS, fsImpl });
    assert.deepEqual(r.failures, []);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].class, 'app-module-import');
    assert.equal(path.resolve(r.violations[0].file), path.resolve(helperPath));
  });

  it('structural locator inside a helper is caught; justified helper usage is clean', () => {
    const fsImpl = memFs({
      [SPEC]: `import { fill } from './helpers/shell.js';`,
      [helperPath]: [
        `export async function fill(page) {`,
        `  await page.locator('.legacy-field').fill('x');`,
        `  // selector-policy: structural — vendor iframe exposes no semantics`,
        `  await page.locator('#vendor-root').click();`,
        `}`,
      ].join('\n'),
    });
    const r = scanSpecClosure(SPEC, { testRoot: TESTS, fsImpl });
    assert.equal(r.violations.length, 1);
    assert.equal(r.justifiedCount, 1);
  });

  it('unresolvable relative import fails closed', () => {
    const fsImpl = memFs({
      [SPEC]: `import { gone } from './helpers/missing.js';`,
    });
    const r = scanSpecClosure(SPEC, { testRoot: TESTS, fsImpl });
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].reason, 'unresolvable-import');
  });

  it('unreadable entry spec fails closed', () => {
    const r = scanSpecClosure(SPEC, { testRoot: TESTS, fsImpl: memFs({}) });
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].reason, 'unreadable-spec');
  });

  it('import cycle between helpers terminates via visited-set', () => {
    const a = path.join(TESTS, 'e2e', 'helpers', 'a.js');
    const b = path.join(TESTS, 'e2e', 'helpers', 'b.js');
    const fsImpl = memFs({
      [SPEC]: `import './helpers/a.js';`,
      [a]: `import './b.js';`,
      [b]: `import './a.js';`,
    });
    const r = scanSpecClosure(SPEC, { testRoot: TESTS, fsImpl });
    assert.deepEqual(r.failures, []);
    assert.equal(r.files.length, 3);
  });
});

// ── testRoot + alias config ──────────────────────────────────────────────────

describe('resolveTestRoot — deterministic ladder, outermost legality boundary', () => {
  it('explicit flag wins', () => {
    assert.equal(
      resolveTestRoot(SPEC, { flag: path.join(ROOT, 'custom') }),
      path.resolve(ROOT, 'custom'),
    );
  });

  it('nested project testDir does not shadow the outer tests/ tree', () => {
    const spec = path.join(TESTS, 'e2e', 'mobile', 'a.spec.js');
    const root = resolveTestRoot(spec, {
      configTestDirs: [path.join(TESTS, 'e2e', 'mobile'), path.join(TESTS, 'e2e', 'desktop')],
    });
    // Outermost candidate = the named tests/ ancestor, so ../helpers stays legal.
    assert.equal(path.resolve(root), path.resolve(TESTS));
  });

  it('multi-project: only the CONTAINING testDir counts', () => {
    const spec = path.resolve('/repo2/suites/desktop/a.spec.js');
    const root = resolveTestRoot(spec, {
      configTestDirs: [path.resolve('/repo2/suites/mobile'), path.resolve('/repo2/suites/desktop')],
    });
    assert.equal(path.resolve(root), path.resolve('/repo2/suites/desktop'));
  });

  it('falls back to the spec directory when nothing matches', () => {
    const spec = path.resolve('/elsewhere/specs/a.spec.js');
    assert.equal(path.resolve(resolveTestRoot(spec, {})), path.resolve('/elsewhere/specs'));
  });
});

describe('readAliasMapFromTsconfig — JSONC tolerant, degrades to null', () => {
  it('parses paths through comments and trailing commas', () => {
    const fsImpl = memFs({
      [path.join(ROOT, 'tsconfig.json')]: `{
        // aliases
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "@/*": ["src/*"], /* app alias */
          },
        },
      }`,
    });
    const map = readAliasMapFromTsconfig(ROOT, fsImpl);
    assert.ok(map);
    assert.equal(path.resolve(map['@/']), path.resolve(ROOT, 'src'));
  });

  it('malformed config degrades to null (never throws)', () => {
    const fsImpl = memFs({ [path.join(ROOT, 'tsconfig.json')]: '{ not json !!!' });
    assert.equal(readAliasMapFromTsconfig(ROOT, fsImpl), null);
  });
});

// ── masking internals ────────────────────────────────────────────────────────

describe('_internals.maskSource', () => {
  it('preserves length and newlines', () => {
    const src = `const a = 'x'; // note\nconst b = \`y\`;`;
    const masked = _internals.maskSource(src);
    assert.equal(masked.length, src.length);
    assert.equal(masked.split('\n').length, src.split('\n').length);
  });

  it('keeps quote delimiters, blanks contents', () => {
    const masked = _internals.maskSource(`page.locator('#x')`);
    assert.match(masked, /page\.locator\('  '\)/);
  });

  it('a regex literal containing quotes does not corrupt the state machine', () => {
    const src = `await expect(t).toHaveText(/it's "fine"/i);\nawait page.locator('#after').click();`;
    const masked = _internals.maskSource(src);
    // The locator call after the regex is still visible in masked source.
    assert.match(masked, /locator\('      '\)/);
  });
});

// ── audit R1 fixes (code-audit round 1) ─────────────────────────────────────

describe('resolveTestRoot — repoRoot anchor (audit R1-H7)', () => {
  it('an ancestor named tests OUTSIDE the repo never becomes the boundary', () => {
    // Repo lives under /home/user/tests/myrepo — the walk must stop at repoRoot.
    const repo = path.resolve('/home/user/tests/myrepo');
    const spec = path.join(repo, 'e2e', 'a.spec.js');
    const root = resolveTestRoot(spec, { repoRoot: repo });
    assert.equal(path.resolve(root), path.join(repo, 'e2e'));
  });

  it('config testDirs outside the repo are ignored under the anchor', () => {
    const repo = path.resolve('/home/user/tests/myrepo');
    const spec = path.join(repo, 'tests', 'a.spec.js');
    const root = resolveTestRoot(spec, {
      repoRoot: repo,
      configTestDirs: [path.resolve('/home/user/tests')], // outside the repo
    });
    assert.equal(path.resolve(root), path.join(repo, 'tests'));
  });
});

describe('scanSpecSource — template-expression visibility (audit R2-H3) + DOM lookups (R2-M7)', () => {
  it('a locator call INSIDE a template ${} expression is still scanned', () => {
    const r = scan('const msg = `row: ${page.locator(\'.hidden-in-template\').count()}`;');
    assert.deepEqual(violationClasses(r), ['structural-selector']);
  });

  it('template string parts still mask (no false positives from text)', () => {
    const r = scan('const msg = `page.locator(\'.only-text\') is not a call`;');
    assert.deepEqual(r.violations, []);
  });

  it('a closing brace inside a ${}-expression string does not end the expression early', () => {
    const r = scan('const s = `x ${fn("}")} ${page.locator(\'.after-brace\')}`;');
    assert.deepEqual(violationClasses(r), ['structural-selector']);
  });

  it('getElementById / getElementsByClassName are structural call sites', () => {
    const r = scan([
      `await page.evaluate(() => document.getElementById('x').click());`,
      `await page.evaluate(() => document.getElementsByClassName('c')[0]);`,
    ].join('\n'));
    assert.equal(r.violations.filter(v => v.class === 'structural-selector').length, 2);
  });

  it('justified getElementById is clean', () => {
    const r = scan(`// selector-policy: structural — vendor DOM has no hooks\nawait page.evaluate(() => document.getElementById('x'));`);
    assert.deepEqual(r.violations, []);
    assert.equal(r.justifiedCount, 1);
  });
});

describe('maskSource — R3 masker fidelity fixes', () => {
  it('identifier ending in n followed by division is NOT a regex (R3-M4)', () => {
    const src = `const half = count_n / 2; await page.locator('#after-division').click();`;
    const r = scan(src);
    assert.deepEqual(violationClasses(r), ['structural-selector']);
  });

  it('return followed by a regex still masks the regex', () => {
    const src = `function f() { return /it's/i; }\nawait page.locator('#after-regex').click();`;
    const r = scan(src);
    assert.deepEqual(violationClasses(r), ['structural-selector']);
  });

  it('nested template inside a ${} expression cannot corrupt depth tracking (R3-M2)', () => {
    const src = 'const s = `x ${fn(`inner } brace`)} tail`;\nawait page.locator(\'#after-nested\').click();';
    const r = scan(src);
    assert.deepEqual(violationClasses(r), ['structural-selector']);
  });
});
