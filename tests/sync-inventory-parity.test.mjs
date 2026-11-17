/**
 * @fileoverview The bundle inventory has ONE owner (debt 3627c83a).
 *
 * `sync-inventory.mjs` used to hand-maintain a mirror of the lists
 * `sync-to-repos.mjs` also declared, with "keep in lock-step" comments and a
 * parity test as the only thing between two independently editable copies. The
 * two drifted silently before (four maintenance-checks entries missing from the
 * mirror), and a comment is not enforcement.
 *
 * Now `lib/sync-inventory.mjs` owns the inventory and the CLI imports it. These
 * tests pin that structure, so a re-introduced second copy fails here, and pin
 * the one thing a refactor like that must not change: the bytes of the bundle.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPOS } from '../scripts/sync-to-repos.mjs';
import * as inventory from '../scripts/lib/sync-inventory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_SRC = fs.readFileSync(path.join(ROOT, 'scripts/sync-to-repos.mjs'), 'utf8');
const INV_SRC = fs.readFileSync(path.join(ROOT, 'scripts/lib/sync-inventory.mjs'), 'utf8');
const { _internals } = inventory;

describe('the CLI declares no inventory of its own', () => {
  // Each pattern is a DECLARATION (`const X =` / `function x(` at column 0), not a mention in a comment.
  const DECLARATIONS = [
    /^const (CORE_ASSETS|EDITOR_FILES|CLAUDE_CODE_FILES|NON_CODE_FILES|SKILL_FILES|FILE_UNIVERSE|CORE_NON_IMPORTABLE)\s*=/m,
    /^function (syncMigrations|buildSkillFiles|bundleForRepo|resolveBundle|buildFileUniverse|realMissingDeps)\s*\(/m,
    /^(const|let) (CORE_ENTRY|LEARNING_ENTRY|ARCH_ENTRY|DEBT_ENTRY|SYNC_ISOLATION_ENTRY)\s*=/m,
  ];

  it('no declaration of an inventory list or of the resolution functions remains in sync-to-repos.mjs', () => {
    for (const re of DECLARATIONS) assert.doesNotMatch(CLI_SRC, re, `a second copy of the inventory is back: ${re}`);
  });

  it('negative control: the same patterns DO match the owner, so they can fail', () => {
    assert.match(INV_SRC, DECLARATIONS[0]);
    assert.match(INV_SRC, /^(export )?function syncMigrations\s*\(/m);
    assert.match(INV_SRC, /^export function bundleForRepo\s*\(/m);
  });

  it('the CLI imports its bundle from the owner', () => {
    assert.match(CLI_SRC, /import \{[^}]*\bbundleForRepo\b[^}]*\} from '\.\/lib\/sync-inventory\.mjs'/);
  });
});

describe('the owner reads the one shared entry list', () => {
  it('every entry array is the shared array, not a copy', async () => {
    const shared = await import('../scripts/lib/sync-entry-lists.mjs');
    for (const name of ['CORE_ENTRY', 'LEARNING_ENTRY', 'ARCH_ENTRY', 'DEBT_ENTRY', 'SYNC_ISOLATION_ENTRY']) {
      assert.strictEqual(_internals[name], shared[name], `sync-inventory.mjs ${name} is not the shared array`);
    }
  });

  it('never carries a bare relative-form entry (the ./lib/redact.mjs phantom-path class)', () => {
    // A `./`-prefixed entry point normalises (in collectImportClosure) to a repo-ROOT-relative path, so
    // `./lib/redact.mjs` silently resolved to the nonexistent `lib/redact.mjs` and still ended up in every
    // consumer's `files` list. Every entry array is repo-root-relative.
    const all = [
      ..._internals.CORE_ENTRY, ..._internals.LEARNING_ENTRY, ..._internals.ARCH_ENTRY,
      ..._internals.DEBT_ENTRY, ..._internals.SYNC_ISOLATION_ENTRY,
    ];
    assert.ok(all.length > 50, 'vacuous-pass guard: the entry lists must be populated');
    assert.deepEqual(all.filter((f) => f.startsWith('./') || f.startsWith('../')), []);
  });
});

describe('the bundle the sync ships IS the bundle the library reports', () => {
  it('the sync target bundle equals getSyncClosure() exactly, in order', () => {
    const lib = inventory.getSyncClosure();
    assert.ok(REPOS.length > 0 && lib.files.length > 1000, 'vacuous-pass guard: a populated bundle');
    assert.deepEqual(REPOS[0].files, lib.files);
    assert.deepEqual(REPOS[0].unresolved, lib.unresolved);
  });
});

// Both the fail-closed migrations read and its quiet ENOENT case, on the one owner.
describe('lib/sync-inventory.mjs: syncMigrations distinguishes "no migrations" from "could not look"', () => {
  it('an unreadable migrations directory throws instead of reporting none', () => {
    const real = fs.readdirSync;
    try {
      fs.readdirSync = () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; };
      assert.throws(() => _internals.syncMigrations(), /Refusing to report an empty migration set/);
    } finally { fs.readdirSync = real; }
  });

  it('ENOENT still means none — the expected-absence case must stay quiet', () => {
    // Vacuous-pass guard: a version that threw on everything would satisfy the test above while breaking every
    // repo without a migrations directory.
    const real = fs.readdirSync;
    try {
      fs.readdirSync = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
      assert.deepEqual(_internals.syncMigrations(), []);
    } finally { fs.readdirSync = real; }
  });
});
