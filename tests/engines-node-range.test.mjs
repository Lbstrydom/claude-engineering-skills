/**
 * @fileoverview The declared Node support range must be one the lockfile can
 * actually be installed and run on.
 *
 * THE FINDING THIS LOCKS (4ce2a627, HIGH, `[Sustainability] [SYSTEMIC] Runtime
 * compatibility contract is unsound`, raised 2026-08-09). The root package
 * advertised `engines.node: ">=22"` while locked dependencies required
 * `^22.18.0` (Babel 8) and `>=22.12.0` (`commander`, `knip`). Every Node in
 * 22.0.0–22.17.x was inside the ADVERTISED range and outside what the tree
 * supports, so the contract named releases on which a clean install or a tool
 * run is unsupported. The fix bumped the declaration to `>=22.18.0`.
 *
 * WHY A TEST AND NOT A PINNED STRING. Asserting `engines.node === '>=22.18.0'`
 * would lock today's answer, not the property — and the property re-breaks on
 * the next dependency bump, which is exactly how it broke the first time. This
 * derives the obligation from `package-lock.json` every run: **the LOWEST Node
 * the root package permits must satisfy every locked dependency's own
 * `engines.node`.**
 *
 * FAIL-CLOSED. `semver` is not a dependency here, so `satisfies` is a small
 * evaluator over the comparator forms the lockfile actually contains. Anything
 * it cannot parse — a root range that is no longer a single `>=` floor, an
 * unrecognised comparator — THROWS rather than passing. A range checker that
 * silently skips what it does not understand reports a clean tree it never
 * read.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8'));
const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf-8'));

/** `'22.18.0'` -> `[22,18,0]`; missing parts are 0. Throws on garbage. */
function parseVersion(v) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v).trim());
  if (!m) throw new Error(`unparseable version: ${v}`);
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

/**
 * Does `version` satisfy `range`? Supports `||` alternatives, whitespace
 * conjunctions, `>= > <= < =`, `^`, `~`, `*`, and a bare `18` / `10.x` major.
 * Throws on any comparator it does not recognise.
 */
export function satisfies(version, range) {
  const v = parseVersion(version);
  // `>= 0.4` — the operator and its operand are sometimes space-separated.
  const norm = String(range).replace(/([<>]=?|=|\^|~)\s+/g, '$1').trim();
  return norm.split('||').some((alt) => {
    const terms = alt.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return false;
    return terms.every((t) => {
      if (t === '*' || t === 'x') return true;
      const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+(?:\.(?:\d+|x|\*))?(?:\.(?:\d+|x|\*))?)$/.exec(t);
      if (!m) throw new Error(`unrecognised comparator "${t}" in range "${range}"`);
      const op = m[1];
      const raw = m[2];
      const wildcard = /\.(x|\*)/.test(raw);
      const base = parseVersion(raw.replace(/\.(x|\*)/g, '.0'));
      switch (op) {
        case '>=': return cmp(v, base) >= 0;
        case '>': return cmp(v, base) > 0;
        case '<=': return cmp(v, base) <= 0;
        case '<': return cmp(v, base) < 0;
        case '^': {
          // ^0.x pins the minor; ^X.y.z (X>=1) pins the major.
          const upper = base[0] === 0 ? [0, base[1] + 1, 0] : [base[0] + 1, 0, 0];
          return cmp(v, base) >= 0 && cmp(v, upper) < 0;
        }
        case '~': return cmp(v, base) >= 0 && cmp(v, [base[0], base[1] + 1, 0]) < 0;
        case '=':
        case undefined: {
          // A bare `18`, `10.x`, or an exact `1.2.3`.
          if (wildcard || !/^\d+\.\d+\.\d+$/.test(raw)) {
            return cmp(v, base) >= 0 && cmp(v, [base[0] + 1, 0, 0]) < 0;
          }
          return cmp(v, base) === 0;
        }
        default: throw new Error(`unhandled operator "${op}"`);
      }
    });
  });
}

/** The lowest Node the ROOT package advertises. Fails closed on any other shape. */
function declaredFloor() {
  const declared = pkg.engines?.node;
  assert.ok(declared, 'package.json must declare engines.node — an undeclared runtime contract cannot be checked');
  const m = /^>=\s*v?(\d+\.\d+\.\d+)$/.exec(String(declared).trim());
  assert.ok(m,
    `engines.node is "${declared}" — this check only knows how to read a single ">=X.Y.Z" floor. `
    + 'If the declaration became a compound range, rewrite the reader; do NOT relax this assertion, '
    + 'because an unreadable range is what let the original contract go unchecked.');
  return m[1];
}

/** Every locked package that states a Node requirement. */
function lockedEngineRanges() {
  const out = [];
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    const range = entry?.engines?.node;
    if (!range) continue;
    if (name === '') continue; // the root's own entry — that IS the claim under test
    out.push({ name, range });
  }
  return out;
}

describe('engines.node — the advertised floor must run the locked tree', () => {
  const floor = declaredFloor();
  const ranges = lockedEngineRanges();

  // Vacuous-pass guard. A lockfile read that yields nothing passes the whole
  // suite while checking nothing — the measured count on 2026-08-30 was 317.
  it('reads a real population of dependency requirements', () => {
    assert.ok(ranges.length >= 100,
      `only ${ranges.length} locked packages declare engines.node — the lockfile read is near-vacuous`);
  });

  it(`the declared floor (${floor}) satisfies every locked dependency`, () => {
    const violations = ranges
      .filter(({ range }) => !satisfies(floor, range))
      .map(({ name, range }) => `${name} requires ${range}`);
    assert.deepEqual(violations, [],
      `package.json advertises Node >=${floor}, but that version cannot run:\n  ${violations.join('\n  ')}\n`
      + 'Raise engines.node to the tightest requirement, or drop the dependency that narrowed it.');
  });

  // Red-then-green: the pre-fix declaration must still be REJECTED by this
  // check, or a green result above proves only that the checker never fires.
  it('rejects the pre-fix declaration ">=22" against this same lockfile (negative control)', () => {
    const violations = ranges.filter(({ range }) => !satisfies('22.0.0', range));
    assert.ok(violations.length > 0,
      'Node 22.0.0 now satisfies every locked dependency — the original defect is no longer reproducible, '
      + 'so this control no longer proves the checker works. Re-anchor it on a version some dependency '
      + 'genuinely excludes, or retire the suite.');
  });
});

describe('satisfies — the evaluator itself', () => {
  it('handles the comparator forms the lockfile contains', () => {
    assert.equal(satisfies('22.18.0', '>=22.12.0'), true);
    assert.equal(satisfies('22.0.0', '>=22.12.0'), false);
    assert.equal(satisfies('22.18.0', '^22.18.0 || >=24.11.0'), true);
    assert.equal(satisfies('22.17.9', '^22.18.0 || >=24.11.0'), false);
    assert.equal(satisfies('22.18.0', '18 || 20 || >=22'), true);
    assert.equal(satisfies('22.18.0', '>= 0.4'), true);
    assert.equal(satisfies('22.18.0', '*'), true);
    assert.equal(satisfies('22.18.0', '^20.19.0 || >=22.12.0'), true);
    assert.equal(satisfies('22.18.0', '>=23.5.0 || ^22.13.0 || ^20.17.0'), true);
    assert.equal(satisfies('22.18.0', '>=0.6.11 <=0.7.0 || >=0.7.3'), true);
    assert.equal(satisfies('0.7.1', '>=0.6.11 <=0.7.0 || >=0.7.3'), false);
    assert.equal(satisfies('22.18.0', '>= 10.x'), true);
    assert.equal(satisfies('22.18.0', '^22.13||^24||>=26'), true);
  });

  it('throws on a comparator it does not understand rather than passing it', () => {
    assert.throws(() => satisfies('22.18.0', '>=22.18.0 - 23'), /unrecognised comparator/);
  });
});
