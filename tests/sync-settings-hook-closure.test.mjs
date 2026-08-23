/**
 * Gate: every hook the SYNCED `.claude/settings.json` registers must itself be
 * in the sync closure.
 *
 * `.claude/settings.json` stays at its canonical path and is deep-merged into
 * every consumer, so registering a hook there ships the REGISTRATION to all of
 * them. Shipping the FILE is a separate list (sync-to-repos.mjs CORE_ENTRY +
 * sync-inventory.mjs, kept in lock-step). Nothing tied the two together, so a
 * hook could be -- and twice was -- registered everywhere and shipped nowhere.
 *
 * Measured 2026-08-20 in both live consumers: `legacy-surface-advisory.mjs` and
 * `bash-grep-nudge.mjs` were registered in settings.json with no file on disk.
 * Node exits 1 with Cannot-find-module, which Claude Code surfaces as a
 * non-blocking hook error on EVERY Bash call and EVERY prompt. Neither
 * introducing commit mentions sync -- the omission was an oversight, and there
 * was no gate that could notice.
 *
 * This iterates the REGISTRATIONS -- the side that can name a file nobody ships.
 * The reverse (a shipped hook nobody registers) is deliberately NOT flagged: a
 * hook may be invoked directly or reserved for a future wiring.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_REF = /[.]claude[\\\/]+hooks[\\\/]+([A-Za-z0-9._-]+[.](?:mjs|sh))/g;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Hook basenames referenced by any command string in settings.json. */
function registeredHooks() {
  const raw = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf-8');
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { for (const m of v.matchAll(HOOK_REF)) found.add(m[1]); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(JSON.parse(raw).hooks ?? {});
  return found;
}

function syncListText() {
  return [
    fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), 'utf-8'),
    fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'lib', 'sync-inventory.mjs'), 'utf-8'),
  ];
}

describe('synced settings.json hook closure', () => {
  it('parses the hook registrations at all (guards against a vacuous pass)', () => {
    assert.ok(registeredHooks().size >= 3, 'expected several registered hooks');
  });

  it('every registered hook file exists in this repo', () => {
    for (const h of registeredHooks()) {
      const p = path.join(REPO_ROOT, '.claude', 'hooks', h);
      assert.ok(fs.existsSync(p), `settings.json registers ${h} but .claude/hooks/${h} is absent`);
    }
  });

  it('every registered hook is in BOTH sync lists, else it ships to no consumer', () => {
    const [toRepos, inventory] = syncListText();
    const missing = [];
    for (const h of registeredHooks()) {
      const entry = `.claude/hooks/${h}`;
      const inA = toRepos.includes(entry);
      const inB = inventory.includes(entry);
      if (!inA || !inB) missing.push(`${h} [sync-to-repos:${inA}, sync-inventory:${inB}]`);
    }
    assert.deepEqual(missing, [], `registered but not shipped: ${missing.join(', ')}`);
  });
});
