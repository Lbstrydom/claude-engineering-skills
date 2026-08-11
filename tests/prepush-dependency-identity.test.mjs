/**
 * @fileoverview The pre-push sandbox's link-vs-install decision.
 *
 * The sandbox links the main checkout's `node_modules` when the pushed commit
 * describes the same dependency tree, and runs a full `npm ci` when it does not.
 * Two ways to get that wrong, and they are not symmetric:
 *
 *   - **Install when you needn't** — costs ~40s per push. Measured 2026-08-11:
 *     the decision compared the WHOLE `package.json`, so commit e7e182ea's
 *     one-line `scripts` addition, with no lockfile change, paid a full
 *     410-package `npm ci`. In a worktree the sandbox's file is compared against
 *     the MAIN checkout's — routinely a different commit — so this fired on
 *     nearly every push and the fast path was effectively dead code.
 *   - **Link when you should have installed** — runs the entire `check` chain
 *     against dependencies the commit does not describe, and reports GREEN.
 *
 * So these tests pin BOTH directions: the narrowing must be narrow enough to
 * restore the fast path, and every ambiguous input must still take the
 * expensive branch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEPENDENCY_FIELDS, dependencyFingerprint, dependencySetChanged,
} from '../scripts/lib/dependency-identity.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const REAL_PKG = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8');

/** Edit the real package.json the way a commit would, and re-serialize it. */
function edited(mutate) {
  const doc = JSON.parse(REAL_PKG);
  mutate(doc);
  return `${JSON.stringify(doc, null, 2)}\n`;
}

describe('the link-vs-install decision, on this repo\'s real package.json', () => {
  it('a scripts-only edit LINKS — the defect that made the fast path unreachable', () => {
    // Exactly the shape of e7e182ea: one new npm script, no lockfile change.
    const withNewGate = edited((d) => { d.scripts['db:enrolment:gate'] = 'node scripts/db-enrolment-gate.mjs'; });
    assert.notEqual(withNewGate, REAL_PKG, 'precondition: the file really did change');

    const { changed, reason } = dependencySetChanged(REAL_PKG, withNewGate);
    assert.equal(changed, false, `a scripts-only edit must not trigger npm ci — got: ${reason}`);
  });

  it('a devDependencies edit INSTALLS — the concern the comparison exists for', () => {
    const withNewDep = edited((d) => { d.devDependencies = { ...d.devDependencies, 'left-pad': '^1.3.0' }; });
    assert.equal(dependencySetChanged(REAL_PKG, withNewDep).changed, true);
  });

  it('a VERSION BUMP of an existing dependency installs', () => {
    const name = Object.keys(JSON.parse(REAL_PKG).dependencies ?? {})[0];
    assert.ok(name, 'precondition: this repo has runtime dependencies');
    const bumped = edited((d) => { d.dependencies[name] = '0.0.0-not-a-real-version'; });
    assert.equal(dependencySetChanged(REAL_PKG, bumped).changed, true);
  });

  it('a REMOVED dependency installs — absence must be as visible as addition', () => {
    const name = Object.keys(JSON.parse(REAL_PKG).devDependencies ?? {})[0];
    assert.ok(name, 'precondition: this repo has devDependencies');
    const dropped = edited((d) => { delete d.devDependencies[name]; });
    assert.equal(dependencySetChanged(REAL_PKG, dropped).changed, true);
  });

  it('every non-dependency top-level field can be edited freely without installing', () => {
    // The complement of the field list, asserted rather than assumed: if a field
    // is added to DEPENDENCY_FIELDS later, this test stops covering it (correctly)
    // rather than silently contradicting the new behaviour.
    const doc = JSON.parse(REAL_PKG);
    const inert = Object.keys(doc).filter((k) => !DEPENDENCY_FIELDS.includes(k));
    assert.ok(inert.length > 3, 'precondition: there are non-dependency fields to vary');
    for (const field of inert) {
      const changedField = edited((d) => {
        d[field] = typeof d[field] === 'string' ? `${d[field]}-x` : { mutated: true };
      });
      assert.equal(
        dependencySetChanged(REAL_PKG, changedField).changed, false,
        `editing "${field}" must not force an install — it cannot change the installed tree`,
      );
    }
  });
});

describe('every dependency-relevant field is actually watched', () => {
  for (const field of DEPENDENCY_FIELDS) {
    it(`a change to "${field}" installs`, () => {
      const base = JSON.stringify({ name: 'x', version: '1.0.0' });
      const arrayShaped = field === 'bundledDependencies' || field === 'bundleDependencies';
      const withField = JSON.stringify({
        name: 'x', version: '1.0.0', [field]: arrayShaped ? ['a'] : { a: '^1.0.0' },
      });
      assert.equal(dependencySetChanged(base, withField).changed, true);
    });
  }

  it('covers npm\'s bundleDependencies ALIAS, not only the canonical spelling', () => {
    // npm honours both spellings. Reading only one leaves a real hole in a check
    // whose failure mode is a silent green.
    assert.ok(DEPENDENCY_FIELDS.includes('bundledDependencies'));
    assert.ok(DEPENDENCY_FIELDS.includes('bundleDependencies'));
  });
});

describe('it fails CLOSED — an input we cannot read installs, never links', () => {
  const cases = [
    ['an unreadable file (null)', null, /could not be read/],
    ['a non-string input', undefined, /could not be read/],
    ['unparseable JSON', '{ not json', /not valid JSON/],
    ['a JSON array root', '[]', /root is an array/],
    ['a JSON scalar root', '42', /root is number/],
  ];
  for (const [label, text, reasonRe] of cases) {
    it(`${label} → changed`, () => {
      assert.equal(dependencySetChanged(REAL_PKG, text).changed, true, label);
      assert.equal(dependencySetChanged(text, REAL_PKG).changed, true, `${label} (other side)`);
      const r = dependencyFingerprint(text);
      assert.equal(r.ok, false);
      assert.match(r.reason, reasonRe);
    });
  }

  it('a dependency field of an UNEXPECTED SHAPE installs rather than being read as empty', () => {
    // The fail-open version of this reads `"dependencies": "oops"` as "no
    // dependencies" and links. Refusing to interpret it is the whole point.
    for (const bad of ['"oops"', '42', 'true', '["a"]']) {
      const r = dependencyFingerprint(`{"dependencies": ${bad}}`);
      assert.equal(r.ok, false, `dependencies: ${bad}`);
      assert.match(r.reason, /unexpected shape/);
    }
    // …but the array spelling that npm really does accept is NOT rejected.
    assert.equal(dependencyFingerprint('{"bundledDependencies": ["a"]}').ok, true);
  });
});

describe('comparison is by parsed VALUE, so formatting churn is not a dependency change', () => {
  it('CRLF vs LF does not install', () => {
    const lf = '{\n  "dependencies": {\n    "a": "^1.0.0"\n  }\n}\n';
    assert.equal(dependencySetChanged(lf, lf.replace(/\n/g, '\r\n')).changed, false);
  });

  it('key ORDER within a dependency map does not install', () => {
    // Two lockfile-identical trees written by different tools must not diverge
    // here — the same "git says clean, the tool says changed" trap AGENTS.md
    // records for the generated-artifact checks.
    const a = '{"dependencies":{"a":"1","b":"2"}}';
    const b = '{"dependencies":{"b":"2","a":"1"}}';
    assert.equal(dependencySetChanged(a, b).changed, false);
  });

  it('whitespace and indentation do not install', () => {
    assert.equal(dependencySetChanged('{"dependencies":{"a":"1"}}',
      '{\n  "dependencies": {\n    "a": "1"\n  }\n}\n').changed, false);
  });

  it('but a nested VALUE difference under the same keys still installs', () => {
    // The reordering tolerance must not become blindness to content.
    const a = '{"peerDependenciesMeta":{"x":{"optional":true}}}';
    const b = '{"peerDependenciesMeta":{"x":{"optional":false}}}';
    assert.equal(dependencySetChanged(a, b).changed, true);
  });
});

describe('the sandbox actually consumes this decision', () => {
  const runnerSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'prepush-check.mjs'), 'utf-8');

  it('provisionNodeModules gates the link on dependencySetChanged', () => {
    assert.match(runnerSrc, /import \{ dependencySetChanged \} from '\.\/lib\/dependency-identity\.mjs'/);
    assert.match(runnerSrc, /const deps = dependencySetChanged\(/);
    assert.match(runnerSrc, /const lockChanged = filePairChanged\(lockMain, lockSandbox\) \|\| deps\.changed;/);
  });

  it('still compares the LOCKFILE whole-file — every byte of it is dependency-relevant', () => {
    // Narrowing the package.json comparison must not narrow this one: the
    // lockfile is a resolved-tree artifact with no inert sections.
    assert.match(runnerSrc, /filePairChanged\(lockMain, lockSandbox\)/);
  });

  it('no longer compares package.json whole-file', () => {
    assert.doesNotMatch(
      runnerSrc, /filePairChanged\(pkgMain, pkgSandbox\)/,
      'the whole-file package.json compare is the defect; it must not come back',
    );
  });
});
