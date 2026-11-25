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
import { getSyncClosure } from '../scripts/lib/sync-inventory.mjs';
import { renderOutbound } from '../scripts/lib/sync-outbound.mjs';

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

// The COMPUTED bundle (lib/sync-inventory.mjs is its one owner), not source text: a hook named only in a comment or an
// unused declaration must not count as shipped.
const SHIPPED = new Set(getSyncClosure().files.map((f) => f.replaceAll('\\', '/')));

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

  it('every registered hook is in the sync inventory, else it ships to no consumer', () => {
    assert.ok(SHIPPED.size > 1000, 'vacuous-pass guard: the computed bundle is populated');
    const missing = [];
    for (const h of registeredHooks()) {
      const entry = `.claude/hooks/${h}`;
      if (!SHIPPED.has(entry)) missing.push(h);
    }
    assert.deepEqual(missing, [], `registered but not shipped: ${missing.join(', ')}`);
  });

  it('negative control: a hook path that exists only as text is not in the bundle', () => {
    assert.equal(SHIPPED.has('.claude/hooks/a-hook-nobody-ships.mjs'), false);
    assert.equal(SHIPPED.has('.claude/hooks/arch-memory-check.sh'), true, 'and a real one is');
  });
});

describe('the grep nudge matcher covers both shell tools, here and in a consumer', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf-8');
  /** Claude Code reads a matcher made of names and `|` as a list of exact tool names. */
  const nudgedTools = (settings) => settings.hooks.PreToolUse
    .filter((g) => g.hooks.some((h) => h.command.includes('bash-grep-nudge.mjs')))
    .flatMap((g) => g.matcher.split('|'))
    .sort();

  it('registers the nudge for Bash AND PowerShell', () => {
    assert.deepEqual(nudgedTools(JSON.parse(source)), ['Bash', 'PowerShell']);
  });

  it('a consumer still on the Bash-only matcher receives the new one from the sync merge', () => {
    const old = JSON.parse(source);
    for (const g of old.hooks.PreToolUse) g.matcher = 'Bash';
    old.consumerKey = true;
    const { content } = renderOutbound({
      srcRel: '.claude/settings.json', dstRel: '.claude/settings.json', srcContent: source,
      existingContent: JSON.stringify(old), rewriteConfig: { ownedSourceTails: new Set() },
    });
    const out = JSON.parse(content);
    assert.deepEqual(nudgedTools(out), ['Bash', 'PowerShell']);
    assert.equal(out.consumerKey, true, 'control: it was a merge with the consumer file, not a replace');
  });
});
