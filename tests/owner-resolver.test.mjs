/**
 * @fileoverview Phase D.5 — CODEOWNERS resolver tests.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  findCodeownersFile,
  loadCodeownersEntries,
  resolveOwner,
  resolveOwners,
  _resetCache,
} from '../scripts/lib/owner-resolver.mjs';

let tmpRoot;

function seed(codeownersContent, location = '.github/CODEOWNERS') {
  const dir = path.join(tmpRoot, path.dirname(location));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, location), codeownersContent);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-resolver-test-'));
  _resetCache();
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  _resetCache();
});

// ── findCodeownersFile ──────────────────────────────────────────────────────

describe('findCodeownersFile', () => {
  test('returns null when no CODEOWNERS exists', () => {
    assert.equal(findCodeownersFile(tmpRoot), null);
  });

  test('finds .github/CODEOWNERS', () => {
    seed('* @team', '.github/CODEOWNERS');
    const found = findCodeownersFile(tmpRoot);
    assert.ok(found);
    assert.ok(found.endsWith('CODEOWNERS'));
  });

  test('finds CODEOWNERS at root', () => {
    seed('* @team', 'CODEOWNERS');
    const found = findCodeownersFile(tmpRoot);
    assert.ok(found);
  });

  test('finds docs/CODEOWNERS', () => {
    seed('* @team', 'docs/CODEOWNERS');
    const found = findCodeownersFile(tmpRoot);
    assert.ok(found);
  });

  test('prefers .github/CODEOWNERS when multiple present', () => {
    seed('* @github', '.github/CODEOWNERS');
    seed('* @root', 'CODEOWNERS');
    const found = findCodeownersFile(tmpRoot);
    assert.match(found.replace(/\\/g, '/'), /\.github\/CODEOWNERS$/);
  });
});

// ── loadCodeownersEntries ───────────────────────────────────────────────────

describe('loadCodeownersEntries', () => {
  test('returns null when no CODEOWNERS', () => {
    assert.equal(loadCodeownersEntries(tmpRoot), null);
  });

  test('parses entries', () => {
    seed('* @team\n/scripts/**/*.mjs @scripts-team');
    const entries = loadCodeownersEntries(tmpRoot);
    assert.equal(Array.isArray(entries), true);
    assert.ok(entries.length >= 2);
  });

  test('caches result across calls', () => {
    seed('* @team');
    const first = loadCodeownersEntries(tmpRoot);
    const second = loadCodeownersEntries(tmpRoot);
    assert.equal(first, second);  // same reference = cache hit
  });
});

// ── resolveOwner ────────────────────────────────────────────────────────────

describe('resolveOwner', () => {
  test('explicitOwner wins without touching CODEOWNERS', () => {
    // No CODEOWNERS file → would normally return undefined
    assert.equal(
      resolveOwner('any/file.js', { explicitOwner: '@me', rootDir: tmpRoot }),
      '@me'
    );
  });

  test('returns undefined when filePath empty', () => {
    assert.equal(resolveOwner('', { rootDir: tmpRoot }), undefined);
    assert.equal(resolveOwner(null, { rootDir: tmpRoot }), undefined);
  });

  test('returns undefined when no CODEOWNERS and no explicit owner', () => {
    assert.equal(resolveOwner('scripts/x.js', { rootDir: tmpRoot }), undefined);
  });

  test('resolves to default owner via catch-all *', () => {
    seed('* @default-team');
    assert.equal(
      resolveOwner('anywhere/file.js', { rootDir: tmpRoot }),
      '@default-team'
    );
  });

  test('resolves to specific pattern (last match wins, GitHub semantics)', () => {
    seed('* @default\n/scripts/**/*.mjs @scripts-team');
    assert.equal(
      resolveOwner('scripts/lib/x.mjs', { rootDir: tmpRoot }),
      '@scripts-team'
    );
    assert.equal(
      resolveOwner('other/file.js', { rootDir: tmpRoot }),
      '@default'
    );
  });

  test('returns first owner when rule has multiple owners', () => {
    seed('* @alice @bob @charlie');
    assert.equal(
      resolveOwner('anywhere.js', { rootDir: tmpRoot }),
      '@alice'
    );
  });

  test('normalizes backslash paths', () => {
    seed('/scripts/**/*.mjs @scripts-team');
    assert.equal(
      resolveOwner('scripts\\lib\\x.mjs', { rootDir: tmpRoot }),
      '@scripts-team'
    );
  });

  test('strips leading ./', () => {
    seed('/scripts/**/*.mjs @scripts-team');
    assert.equal(
      resolveOwner('./scripts/lib/x.mjs', { rootDir: tmpRoot }),
      '@scripts-team'
    );
  });
});

// ── resolveOwners (batch) ───────────────────────────────────────────────────

describe('resolveOwners', () => {
  test('resolves a batch of paths', () => {
    seed('* @default\n/scripts/**/*.mjs @scripts-team\n/docs/ @docs-team');
    const m = resolveOwners(
      ['scripts/lib/x.mjs', 'docs/guide.md', 'random/file.js'],
      { rootDir: tmpRoot }
    );
    assert.equal(m.get('scripts/lib/x.mjs'), '@scripts-team');
    assert.equal(m.get('docs/guide.md'), '@docs-team');
    assert.equal(m.get('random/file.js'), '@default');
  });

  test('returns Map even with empty input', () => {
    const m = resolveOwners([], { rootDir: tmpRoot });
    assert.equal(m.size, 0);
  });
});
