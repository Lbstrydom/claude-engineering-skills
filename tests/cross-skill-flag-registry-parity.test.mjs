/**
 * @fileoverview `cross-skill.mjs`'s dispatcher `KNOWN_FLAGS` allowlist and
 * `lib/cross-skill/registry.mjs`'s per-command `flags` declarations are two
 * hand-maintained inventories describing the same thing from two sides
 * (round-3 audit H3, compromise): a registry command declaring a flag its
 * OWN handler reads is worthless if `assertKnownFlags` rejects that flag
 * before dispatch ever reaches the handler. Unlike
 * `tests/sync-inventory-parity.test.mjs`'s bidirectional set-equality (two
 * mirrors of the SAME list), this is deliberately ONE-DIRECTIONAL: many
 * `KNOWN_FLAGS` entries exist for subcommands that forward `rest` wholesale
 * to another CLI (friction-log, learning-replay, …) and have no registry
 * counterpart at all — that is by design, not drift. The only actual failure
 * mode this guards is a registry flag with NO matching dispatcher entry.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { KNOWN_FLAGS } from '../scripts/cross-skill.mjs';
import { REGISTRY, normalizeFlag } from '../scripts/lib/cross-skill/registry.mjs';

describe('every registry command flag is present in the dispatcher KNOWN_FLAGS allowlist', () => {
  it('registry flags ⊆ KNOWN_FLAGS (one-directional — see fileoverview)', () => {
    const known = new Set(KNOWN_FLAGS);
    const missing = [];
    for (const cmd of REGISTRY) {
      for (const raw of cmd.flags ?? []) {
        const { name } = normalizeFlag(raw);
        const literal = `--${name}`;
        if (!known.has(literal)) missing.push(`${cmd.name}: ${literal}`);
      }
    }
    assert.deepEqual(
      missing, [],
      `registry command(s) declare a flag the dispatcher's KNOWN_FLAGS does not list — `
        + `assertKnownFlags would reject it before the handler ever sees it:\n${missing.join('\n')}\n`
        + 'Add the missing flag(s) to cross-skill.mjs KNOWN_FLAGS.',
    );
  });

  it('the consumer-friction-doctor --disposition flag specifically stays paired (regression lock)', () => {
    const upstream = REGISTRY.find((c) => c.name === 'upstream');
    assert.ok(upstream, 'upstream command must exist in the registry');
    const names = (upstream.flags ?? []).map((f) => normalizeFlag(f).name);
    assert.ok(names.includes('disposition'), 'upstream registry entry must declare --disposition');
    assert.ok(KNOWN_FLAGS.includes('--disposition'), 'KNOWN_FLAGS must declare --disposition');
  });
});
