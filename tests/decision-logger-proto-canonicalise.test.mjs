/**
 * @fileoverview Canonicalisation must treat `__proto__` as DATA.
 *
 * Guards the audit finding "Data-integrity bug": `_canonicalise` rebuilt objects
 * with `{}` and assigned untrusted keys via `out[k] = …`. On a plain object,
 * `out['__proto__'] = v` REASSIGNS the prototype instead of creating an own
 * property — so a context parsed from JSON carrying an own `__proto__` key
 * produced a canonical form missing that key entirely, and therefore a
 * `contextHash` identical to the same context without it.
 *
 * Two distinct decisions then collide on one hash. `buildDecisionKey`/dedup key
 * off that hash, so the second decision is silently treated as a repeat of the
 * first. The fix is `Object.create(null)`, which has no prototype to reassign.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internals } from '../scripts/lib/learning/decision-logger.mjs';

const { contextHash, canonicaliseContext } = _internals;

/** JSON.parse is the only way to get an OWN `__proto__` key — a literal sets the prototype. */
const withOwnProto = () => JSON.parse('{"pass":"structure","__proto__":{"polluted":true}}');

describe('decision-logger canonicalisation — __proto__ is a key, not a mutation', () => {
  it('represents an own __proto__ property in the canonical form', () => {
    const canon = canonicaliseContext(withOwnProto());
    assert.match(canon, /__proto__/, 'the key was dropped, so its value never reached the hash');
  });

  it('hashes differently from the same context without the key', () => {
    const withKey = contextHash(withOwnProto());
    const without = contextHash(JSON.parse('{"pass":"structure"}'));
    assert.notEqual(withKey, without,
      'two different contexts collided on one hash — a distinct decision would dedup as a repeat');
  });

  it('does not pollute Object.prototype while canonicalising', () => {
    canonicaliseContext(withOwnProto());
    assert.equal({}.polluted, undefined, 'canonicalisation mutated the global prototype');
    assert.equal(Object.prototype.polluted, undefined);
  });

  // Vacuous-pass guards: the hash must still be a stable, key-order-independent
  // function of ordinary contexts, or the assertions above could pass for a
  // canonicaliser that simply emitted something different every time.
  it('is stable for an ordinary context (negative control)', () => {
    const a = contextHash({ pass: 'structure', round: 2 });
    const b = contextHash({ pass: 'structure', round: 2 });
    assert.equal(a, b);
  });

  it('is independent of key order (negative control)', () => {
    assert.equal(
      contextHash({ pass: 'structure', round: 2 }),
      contextHash({ round: 2, pass: 'structure' }),
    );
  });

  it('still distinguishes genuinely different ordinary contexts', () => {
    assert.notEqual(contextHash({ pass: 'structure' }), contextHash({ pass: 'wiring' }));
  });
});
