/**
 * @fileoverview The sync must never install a `playwright` that differs from the consumer's own `@playwright/test`.
 *
 * Field report (sync bundle 4e55b28e): a work consumer pinned `@playwright/test` at 1.63.0; the sync installed the floating
 * `playwright` (1.65.1), leaving two playwright-core copies and broken tests. Tier-3 seam (consumer sync): the pure decision,
 * the proposal the sync actually makes, the exact-save flag, and the summary line all land with this test.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { alignPlaywrightVersion, readPlaywrightEvidence, ensureAuditDeps } from '../scripts/lib/install/deps.mjs';
import { addDevDepsArgs, displayAddDev } from '../scripts/lib/package-manager.mjs';
import { describeCircularHydrate, describeRunSummary } from '../scripts/lib/sync-run-summary.mjs';
import { circularHydrateEntry, CONSUMER_HYDRATE_NPM_SCRIPT } from '../scripts/lib/worktree-preflight.mjs';
import { seedInstalledDeps } from './helpers/consumer-fixture.mjs';

describe('alignPlaywrightVersion (pure)', () => {
  it('pins to the installed @playwright/test version', () => {
    assert.deepEqual(
      alignPlaywrightVersion({ declared: { '@playwright/test': '^1.63.0' }, installed: { '@playwright/test': '1.63.0' } }),
      { action: 'pin', version: '1.63.0', source: 'installed @playwright/test' });
  });
  it('installed outranks declared, and @playwright/test outranks playwright', () => {
    const r = alignPlaywrightVersion({
      declared: { '@playwright/test': '1.60.0' },
      installed: { playwright: '1.62.0', '@playwright/test': '1.63.0' },
    });
    assert.equal(r.version, '1.63.0');
  });
  it('pins an exact declared spec when nothing is installed (also =x and vx forms)', () => {
    for (const spec of ['1.63.0', '=1.63.0', 'v1.63.0']) {
      assert.equal(alignPlaywrightVersion({ declared: { '@playwright/test': spec } }).version, '1.63.0', spec);
    }
    assert.equal(alignPlaywrightVersion({ declared: { playwright: '1.64.1' } }).source, 'declared playwright');
  });
  it('holds, never floats, when only a range is declared and nothing is installed', () => {
    for (const spec of ['^1.63.0', '~1.63.0', 'latest', '>=1.60']) {
      const r = alignPlaywrightVersion({ declared: { '@playwright/test': spec } });
      assert.equal(r.action, 'hold', spec);
      assert.match(r.reason, /unknown/);
    }
  });
  it('a range on @playwright/test holds even when playwright is declared exact (first declared peer decides)', () => {
    const r = alignPlaywrightVersion({ declared: { '@playwright/test': '^1.63.0', playwright: '1.63.0' } });
    assert.equal(r.action, 'hold');
  });
  it('present-but-unreadable evidence holds, never falls through to unconstrained', () => {
    const r = alignPlaywrightVersion({ unreadable: ['node_modules/@playwright/test/package.json'] });
    assert.equal(r.action, 'hold');
    assert.match(r.reason, /could not be read/);
  });
  it('NEGATIVE CONTROL: a consumer with no Playwright at all is unconstrained (today behaviour)', () => {
    assert.deepEqual(alignPlaywrightVersion({ declared: {}, installed: {} }), { action: 'unconstrained' });
    assert.deepEqual(alignPlaywrightVersion(), { action: 'unconstrained' });
    // junk is absence, not a pin
    assert.equal(alignPlaywrightVersion({ installed: { '@playwright/test': 'not-a-version' } }).action, 'unconstrained');
  });
});

describe('addDevDepsArgs exact', () => {
  it('adds the manager exact flag only when asked; default argv is unchanged', () => {
    assert.deepEqual(addDevDepsArgs('npm', ['a']), ['install', '--save-dev', '--legacy-peer-deps', 'a']);
    assert.ok(addDevDepsArgs('npm', ['a'], null, { exact: true }).includes('--save-exact'));
    assert.ok(addDevDepsArgs('pnpm', ['a'], null, { exact: true }).includes('-E'));
    assert.ok(addDevDepsArgs('yarn', ['a'], null, { exact: true }).includes('--exact'));
    assert.ok(addDevDepsArgs('bun', ['a'], null, { exact: true }).includes('--exact'));
  });
});

describe('displayAddDev exact', () => {
  it('names the exact flag only when asked', () => {
    assert.equal(displayAddDev('npm', ['p@1.0.0']), 'npm i -D p@1.0.0');
    assert.equal(displayAddDev('npm', ['p@1.0.0'], null, { exact: true }), 'npm i -D --save-exact p@1.0.0');
    assert.match(displayAddDev('pnpm', ['p'], null, { exact: true }), /-E/);
  });
});

describe('ensureAuditDeps proposes the consumer playwright version (dry run, probed tree)', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-align-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  const run = () => {
    const lines = [];
    const orig = process.stderr.write;
    process.stderr.write = (c) => { lines.push(String(c)); return true; };
    try { ensureAuditDeps(root, { dryRun: true }); } finally { process.stderr.write = orig; }
    return lines.join('');
  };
  const consumer = ({ testVersion = null, spec = null } = {}) => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'c', private: true, devDependencies: spec ? { '@playwright/test': spec } : {},
    }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    seedInstalledDeps(root);
    fs.rmSync(path.join(root, 'node_modules', 'playwright'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); // the dep the sync would add
    if (testVersion) {
      const d = path.join(root, 'node_modules', '@playwright', 'test');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: '@playwright/test', version: testVersion }));
    }
  };

  it('consumer pinned at 1.63.0: proposes playwright@1.63.0 and never 1.65.x', () => {
    consumer({ testVersion: '1.63.0', spec: '1.63.0' });
    assert.deepEqual(readPlaywrightEvidence(root), {
      declared: { '@playwright/test': '1.63.0' }, installed: { '@playwright/test': '1.63.0' }, unreadable: [] });
    const out = run();
    assert.match(out, /would install playwright@1\.63\.0 \(exact/);
    assert.doesNotMatch(out, /1\.65/);
    assert.doesNotMatch(out, /would install optional via \w+ — [^\n]*\bplaywright\b/);
  });

  it('declared range, nothing installed: holds, installs no playwright', () => {
    consumer({ spec: '^1.63.0' });
    const out = run();
    assert.match(out, /would NOT install playwright/);
    assert.doesNotMatch(out, /would install playwright@/);
  });

  it('unreadable installed @playwright/test manifest holds instead of proposing a floating playwright', () => {
    consumer({ testVersion: '1.63.0', spec: '1.63.0' });
    fs.writeFileSync(path.join(root, 'node_modules', '@playwright', 'test', 'package.json'), '{not json');
    const out = run();
    assert.match(out, /would NOT install playwright/);
    assert.doesNotMatch(out, /would install playwright@|would install optional via \w+ — [^\n]*\bplaywright\b/);
  });

  it('a hold is explained even when the package manager is refused (yarn consumer), and the hint omits playwright', () => {
    consumer({ spec: '^1.63.0' });
    fs.rmSync(path.join(root, 'package-lock.json'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.writeFileSync(path.join(root, 'yarn.lock'), '');
    // force a missing OPTIONAL dep so the refusal branch runs
    fs.rmSync(path.join(root, 'node_modules', 'proper-lockfile'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const out = run();
    assert.match(out, /not installing playwright/);
    assert.match(out, /yarn add -D [^\n]*proper-lockfile/);
    assert.doesNotMatch(out, /yarn add -D [^\n]*\bplaywright\b/);
  });

  it('a held playwright that is the ONLY missing dep leaves no empty install command in a refusal hint', () => {
    consumer({ spec: '^1.63.0' });
    fs.rmSync(path.join(root, 'package-lock.json'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.writeFileSync(path.join(root, 'yarn.lock'), '');
    const out = run();
    assert.match(out, /not installing playwright/);
    assert.doesNotMatch(out, /&&[ \t]*(\r?\n|$)/);
    assert.match(out, /nothing else to install/);
  });

  it('a pinned manual hint carries the exact flag (npm save-exact), so it cannot write a caret', () => {
    consumer({ testVersion: '1.63.0', spec: '1.63.0' });
    fs.rmSync(path.join(root, 'package-lock.json'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.writeFileSync(path.join(root, 'yarn.lock'), '');
    const out = run();
    assert.match(out, /yarn add -D --exact playwright@1\.63\.0/);
  });

  it('an installed version with build metadata still pins (build dropped); an unparseable one holds', () => {
    consumer({ testVersion: '1.63.0+custom', spec: '1.63.0' });
    assert.match(run(), /would install playwright@1\.63\.0 \(exact/);
    consumer({ testVersion: 'banana', spec: '1.63.0' });
    assert.match(run(), /would NOT install playwright/);
  });

  it('sees a @playwright/test hoisted into an ANCESTOR node_modules (workspace member)', () => {
    const member = path.join(root, 'packages', 'app');
    fs.mkdirSync(member, { recursive: true });
    const d = path.join(root, 'node_modules', '@playwright', 'test');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: '1.63.0' }));
    assert.deepEqual(readPlaywrightEvidence(member).installed, { '@playwright/test': '1.63.0' });
  });

  it('NEGATIVE CONTROL: no Playwright at all keeps today behaviour (plain optional install, no pin, no hold)', () => {
    consumer();
    const out = run();
    assert.match(out, /would install optional via npm — [^\n]*\bplaywright\b/);
    assert.doesNotMatch(out, /would install playwright@|would NOT install playwright/);
  });
});

describe('sync summary surfaces a circular skills:hydrate', () => {
  const circularPkg = { scripts: { 'skills:hydrate': 'node scripts/.claude-skills/skills-hydrate.mjs' } };
  const entry = circularHydrateEntry('wine', '/x', { readPackageJson: () => circularPkg });
  const base = { dryRun: false, targetCount: 1, totalSkipped: 0, totalErrors: 0, totalNew: 0, totalUpdated: 1, totalUnchanged: 0,
    unmeasured: { verdict: null, lines: [] } };

  it('detects the circular entry via the doctor oracle, and nothing for a self-contained one', () => {
    assert.deepEqual(entry, { name: 'wine', circular: ['skills:hydrate'] });
    const selfContained = { scripts: { 'skills:hydrate': 'node -e "console.log(1)"' } };
    assert.equal(circularHydrateEntry('ok', '/x', { readPackageJson: () => selfContained }), null);
  });

  it('prints consumer names and the probe one-liner, in the real end-of-run summary', () => {
    const text = describeRunSummary({ ...base, circularHydrate: [entry] }).join('\n');
    assert.match(text, /hydration\/remedy-missing/);
    assert.match(text, /wine: "skills:hydrate"/);
    assert.ok(text.includes(CONSUMER_HYDRATE_NPM_SCRIPT), 'the self-contained one-liner is printed verbatim');
  });

  it('NEGATIVE CONTROL: nothing circular prints nothing', () => {
    assert.deepEqual(describeCircularHydrate([]), []);
    assert.doesNotMatch(describeRunSummary(base).join('\n'), /skills:hydrate/);
  });
});
