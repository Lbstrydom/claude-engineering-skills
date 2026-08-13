/**
 * @fileoverview Guard: no `scripts/lib/<subsystem>/` may reach its domain via a
 * CATCH-ALL rule.
 *
 * ## The incident this exists to prevent, which already happened twice
 *
 * `.audit-loop/domain-map.json` resolves first-match-wins, and its last
 * `scripts/lib/**` rule maps anything unclaimed to `shared-lib`. That is a
 * silent default, and a *new subsystem directory* is exactly the thing it
 * defaults wrongly:
 *
 * - **2026-08-12** — the cross-skill command-registry migration extracted 15
 *   modules (4,408 lines) into `scripts/lib/cross-skill/`. No rule was added, so
 *   the catch-all filed them as `shared-lib` while their own CLI entry point
 *   `scripts/cross-skill.mjs` was `cross-skill-bridge`: one subsystem split
 *   across two domains by a glob. It produced **10 layering violations**, both
 *   HIGHs among them, and was fixed by a one-line rule in `a146bb7b`.
 * - Earlier, the same shape hit `scripts/check-*.mjs -> install`, whose own
 *   `_why` note in the map predicted the recurrence in as many words: *"Other
 *   check-* CLIs are likely miscategorised too."*
 *
 * A layering oracle cannot catch this on its own. Mis-tagging is only *visible*
 * once some edge happens to cross a boundary — a subsystem whose imports all
 * stay inside `shared-lib` sits mis-tagged and silent until the day someone adds
 * an import, at which point the violation looks like it was caused by that
 * import rather than by a rule nobody wrote months earlier.
 *
 * So this asserts the property directly: **a subsystem directory must be
 * CLAIMED by an explicit rule.** Adding `scripts/lib/<thing>/` is then two
 * edits, never one — the same "adding it is two edits" discipline as
 * `npm run db:enrolment:gate`.
 *
 * Plan: [god-module-and-layering-debt.md](../docs/plans/god-module-and-layering-debt.md)
 * (audit finding M9).
 *
 * @module tests/domain-map-subsystem-coverage.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Is `pattern` broad enough to swallow a subsystem WITHOUT naming it?
 *
 * Answered structurally, not from a list. The first version of this guard
 * carried a four-entry literal Set of broad globs — a **denylist**, and
 * therefore only ever as current as the last person who thought of a spelling.
 * A `scripts/lib` wildcard-directory glob swallows every subsystem just as
 * completely and was not in it. AGENTS.md names this exact shape ("never
 * re-express this as 'not $VENDOR'"), and the guard against silent defaults
 * had one of its own.
 *
 * The property that actually matters: **does this rule match a subsystem that
 * does not exist?** If it matches an invented directory name, it cannot be
 * naming a real one — it is a default. Two independent probes so a pattern
 * cannot pass by coincidence.
 *
 * @param {string} pattern
 * @returns {boolean}
 */
function isCatchAll(pattern) {
  const probes = [
    'scripts/lib/zzz-not-a-real-subsystem/index.mjs',
    'scripts/lib/qqq-also-invented/nested/deep.mjs',
  ];
  return probes.every(p => minimatch(p, pattern, { dot: true }));
}

describe('domain-map: every scripts/lib subsystem is explicitly claimed', () => {
  const domainMap = JSON.parse(readFileSync(path.join(REPO, '.audit-loop', 'domain-map.json'), 'utf8'));

  // Every source extension, not just `.mjs`: a subsystem holding only `.js`/
  // `.cjs`/`.ts` would otherwise be invisible to this guard and inherit the
  // catch-all unchecked — the very thing being prevented.
  const SOURCE_EXT = /\.(mjs|cjs|js|mts|cts|ts|tsx|jsx)$/;
  const files = execFileSync('git', ['-C', REPO, 'ls-files', '-z', '--', 'scripts/lib/*/**'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\0').map(s => s.trim()).filter(f => SOURCE_EXT.test(f));

  /**
   * subsystem dir -> ALL its source files.
   *
   * Every file is checked, not a representative. Sampling one file per
   * directory let a subsystem pass because its representative happened to match
   * a narrow rule while its siblings fell through to the catch-all — a
   * sample-based assertion hiding the exact root cause this test exists to
   * catch.
   */
  const subsystems = new Map();
  for (const f of files) {
    const dir = f.split('/').slice(0, 3).join('/'); // scripts/lib/<subsystem>
    if (!subsystems.has(dir)) subsystems.set(dir, []);
    subsystems.get(dir).push(f);
  }

  it('found subsystems to check (vacuous-pass guard)', () => {
    // A glob that matches nothing reports every subsystem as compliant.
    assert.ok(
      subsystems.size >= 5,
      `only ${subsystems.size} scripts/lib subsystem(s) discovered — the inventory glob is broken, `
      + 'and a pass over an empty set proves nothing.',
    );
  });

  it('no subsystem FILE resolves via a catch-all rule', () => {
    const offenders = [];
    for (const [dir, dirFiles] of subsystems) {
      for (const f of dirFiles) {
        const matched = domainMap.rules.find(r => minimatch(f, r.pattern, { dot: true }));
        if (!matched) { offenders.push(`${f} — NO rule matches (untagged: invisible to the layering check)`); continue; }
        if (isCatchAll(matched.pattern)) {
          offenders.push(`${f} (${dir}) — claimed only by catch-all "${matched.pattern}" -> ${matched.domain}`);
        }
      }
    }
    assert.deepEqual(
      offenders, [],
      'These scripts/lib subsystems get their domain from a catch-all rather than an explicit rule:\n'
      + offenders.map(o => `  ${o}`).join('\n')
      + '\n\nAdd a rule to .audit-loop/domain-map.json naming the subsystem and its domain '
      + '(place it ABOVE the scripts/lib/** catch-all — first match wins). '
      + 'This is the defect that split scripts/lib/cross-skill/** from scripts/cross-skill.mjs '
      + 'and produced 10 layering violations on 2026-08-12.',
    );
  });

  it('NEGATIVE CONTROL: isCatchAll flags broad patterns and clears narrow ones', () => {
    // Without this, a detector that returns false for everything looks exactly
    // like a clean repo. Both directions asserted — a detector that returns
    // TRUE for everything would fail the second half.
    for (const broad of ['scripts/lib/**', 'scripts/**', '**', '**/*', 'scripts/lib/*/**']) {
      assert.ok(isCatchAll(broad), `isCatchAll must flag "${broad}" — it claims every subsystem without naming one`);
    }
    for (const narrow of ['scripts/lib/cross-skill/**', 'scripts/lib/store/**', 'scripts/lib/db/errors.mjs']) {
      assert.ok(!isCatchAll(narrow), `isCatchAll must NOT flag "${narrow}" — it names a specific subsystem`);
    }
  });
});
