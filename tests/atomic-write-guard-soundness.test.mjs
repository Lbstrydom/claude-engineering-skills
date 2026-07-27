import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { analyzeShapeADelegation, analyzeRetryWrapping } from './helpers/atomic-write-guard-analysis.mjs';

// This is the acceptance test for Cluster A (docs/plans/refactor-static-analysis.md
// §4/§6): without it, tests/atomic-write-adoption-guard.test.mjs passes on all 9
// real target files whether or not the binding-resolution port actually worked —
// none of them currently exercise a shadow/async/computed-access shape (§1.2's
// "latent, not live" honesty qualifier). These meta-tests prove the analyzer can
// FAIL, on inline fixtures engineered to reproduce each of the four false-passes
// the old spelling-only guard suffered (AGENTS.md "audit your success paths").
//
// Fixture files live at a virtual path inside scripts/lib/ so a relative
// `./file-io.mjs` / `./retry-transient-fs.mjs` import specifier resolves to the
// REAL modules without needing any file on disk (sourceText is passed directly,
// never read from FIXTURE_ABS_PATH).

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE_ABS_PATH = path.resolve(REPO_ROOT, 'scripts/lib/__atomic_write_guard_soundness_fixture__.mjs');

describe('atomic-write-guard-soundness — analyzeShapeADelegation', () => {
  it('wired: genuine call to the imported helper — sanity positive control', () => {
    const src = `
      import { atomicWriteFileSync } from './file-io.mjs';
      export function applyFixes() { atomicWriteFileSync(a, b); }
    `;
    const { status } = analyzeShapeADelegation(src, FIXTURE_ABS_PATH, { functionName: 'applyFixes' });
    assert.equal(status, 'wired');
  });

  it("wired via 'export const name = () => {}' form (round-2 M1)", () => {
    const src = `
      import { atomicWriteFileSync } from './file-io.mjs';
      export const applyFixes = () => { atomicWriteFileSync(a, b); };
    `;
    const { status } = analyzeShapeADelegation(src, FIXTURE_ABS_PATH, { functionName: 'applyFixes' });
    assert.equal(status, 'wired');
  });

  it('wired when the SAME named export is imported under two local aliases (round-3 M2)', () => {
    // Only a call under the earlier alias exercises the bug: a scalar
    // importLocalName would be overwritten by the second specifier, making
    // the first alias's call invisible to candidate-call discovery.
    const src = `
      import { atomicWriteFileSync, atomicWriteFileSync as write2 } from './file-io.mjs';
      export function applyFixes() { atomicWriteFileSync(a, b); }
    `;
    const { status } = analyzeShapeADelegation(src, FIXTURE_ABS_PATH, { functionName: 'applyFixes' });
    assert.equal(status, 'wired');
  });

  it("shadowed by a PARAMETER (2a): 'shadowed', not 'wired'", () => {
    const src = `
      import { atomicWriteFileSync } from './file-io.mjs';
      export function applyFixes(atomicWriteFileSync) { atomicWriteFileSync(a, b); }
    `;
    const { status } = analyzeShapeADelegation(src, FIXTURE_ABS_PATH, { functionName: 'applyFixes' });
    assert.equal(status, 'shadowed');
  });

  it("shadowed by a LOCAL CONST (2a'): 'shadowed', not 'wired'", () => {
    const src = `
      import { atomicWriteFileSync } from './file-io.mjs';
      export function applyFixes() {
        const atomicWriteFileSync = (p, d) => fs.writeFileSync(p, d);
        atomicWriteFileSync(a, b);
      }
    `;
    const { status } = analyzeShapeADelegation(src, FIXTURE_ABS_PATH, { functionName: 'applyFixes' });
    assert.equal(status, 'shadowed');
  });

  it("genuine call buried in an UNEXECUTED nested closure: 'absent', not 'wired' (round-1 H1/H2)", () => {
    // A byte-range containment check alone cannot tell this apart from a real
    // top-level delegation call — the nested arrow is never invoked here, so
    // the target function does not actually delegate at runtime.
    const src = `
      import { atomicWriteFileSync } from './file-io.mjs';
      export function applyFixes() {
        const neverCalled = () => { atomicWriteFileSync(a, b); };
        doSomethingElse();
      }
    `;
    const { status } = analyzeShapeADelegation(src, FIXTURE_ABS_PATH, { functionName: 'applyFixes' });
    assert.equal(status, 'absent');
  });

  it("imports the helper but never calls it: 'absent', discriminated from 'shadowed'", () => {
    const src = `
      import { atomicWriteFileSync } from './file-io.mjs';
      export function applyFixes() { doSomethingElse(); }
    `;
    const { status } = analyzeShapeADelegation(src, FIXTURE_ABS_PATH, { functionName: 'applyFixes' });
    assert.equal(status, 'absent');
  });

  it("no import at all: 'no-import'", () => {
    const src = `export function applyFixes() { atomicWriteFileSync(a, b); }`;
    const { status } = analyzeShapeADelegation(src, FIXTURE_ABS_PATH, { functionName: 'applyFixes' });
    assert.equal(status, 'no-import');
  });

  it("target function does not exist: 'no-such-function'", () => {
    const src = `
      import { atomicWriteFileSync } from './file-io.mjs';
      export function otherFn() { atomicWriteFileSync(a, b); }
    `;
    const { status } = analyzeShapeADelegation(src, FIXTURE_ABS_PATH, { functionName: 'applyFixes' });
    assert.equal(status, 'no-such-function');
  });
});

describe('atomic-write-guard-soundness — analyzeRetryWrapping status discrimination', () => {
  it('wrapped: genuine retrySync(() => fs.renameSync(...)) — sanity positive control', () => {
    const src = `
      import { retrySync } from './retry-transient-fs.mjs';
      import fs from 'node:fs';
      function apply() { retrySync(() => fs.renameSync(a, b)); }
    `;
    const { sites } = analyzeRetryWrapping(src, FIXTURE_ABS_PATH, { methodNames: ['renameSync'] });
    assert.equal(sites.length, 1);
    assert.equal(sites[0].status, 'wrapped');
  });

  it("no-op LOCAL retrySync wrapping a real site (2b): 'wrong-binding', not 'wrapped'", () => {
    const src = `
      import { retrySync } from './retry-transient-fs.mjs';
      import fs from 'node:fs';
      function apply() {
        const retrySync = (fn) => fn();
        retrySync(() => fs.renameSync(a, b));
      }
    `;
    const { sites } = analyzeRetryWrapping(src, FIXTURE_ABS_PATH, { methodNames: ['renameSync'] });
    assert.equal(sites.length, 1);
    assert.equal(sites[0].status, 'wrong-binding');
  });

  it("retrySync(async () => ...) (2c): 'async-callback', not 'wrapped'", () => {
    const src = `
      import { retrySync } from './retry-transient-fs.mjs';
      import fs from 'node:fs';
      function apply() { retrySync(async () => fs.renameSync(a, b)); }
    `;
    const { sites } = analyzeRetryWrapping(src, FIXTURE_ABS_PATH, { methodNames: ['renameSync'] });
    assert.equal(sites.length, 1);
    assert.equal(sites[0].status, 'async-callback');
  });

  it("site with no wrapper at all: 'no-wrapper', discriminated from 'async-callback'", () => {
    const src = `
      import fs from 'node:fs';
      function apply() { fs.renameSync(a, b); }
    `;
    const { sites } = analyzeRetryWrapping(src, FIXTURE_ABS_PATH, { methodNames: ['renameSync'] });
    assert.equal(sites.length, 1);
    assert.equal(sites[0].status, 'no-wrapper');
  });

  it("wrapper callee is not a plain Identifier: 'unresolvable-binding'", () => {
    const src = `
      import fs from 'node:fs';
      const obj = { retrySync: (fn) => fn() };
      function apply() { obj.retrySync(() => fs.renameSync(a, b)); }
    `;
    const { sites } = analyzeRetryWrapping(src, FIXTURE_ABS_PATH, { methodNames: ['renameSync'] });
    assert.equal(sites.length, 1);
    assert.equal(sites[0].status, 'unresolvable-binding');
  });
});

describe('atomic-write-guard-soundness — fs-call grammar matrix (2d + parity)', () => {
  const GRAMMAR_CASES = [
    {
      name: 'member call, default fs import — discovered',
      src: `import fs from 'node:fs'; function apply() { fs.renameSync(a, b); }`,
      expectedCount: 1,
    },
    {
      name: 'member call, { default as fs } import — discovered',
      src: `import { default as fs } from 'node:fs'; function apply() { fs.renameSync(a, b); }`,
      expectedCount: 1,
    },
    {
      name: 'bare call, named import — discovered',
      src: `import { renameSync } from 'node:fs'; function apply() { renameSync(a, b); }`,
      expectedCount: 1,
    },
    {
      name: 'bare call, aliased named import — discovered',
      src: `import { renameSync as rename } from 'node:fs'; function apply() { rename(a, b); }`,
      expectedCount: 1,
    },
    {
      name: 'bare call, ES2022 string-literal-form import — discovered',
      src: `import { "renameSync" as rename } from 'node:fs'; function apply() { rename(a, b); }`,
      expectedCount: 1,
    },
    {
      name: "member call, computed STRING-LITERAL property (fs['renameSync']) — discovered",
      src: `import fs from 'node:fs'; function apply() { fs['renameSync'](a, b); }`,
      expectedCount: 1,
    },
    {
      name: 'member call, optional object access (fs?.renameSync) — discovered',
      src: `import fs from 'node:fs'; function apply() { fs?.renameSync(a, b); }`,
      expectedCount: 1,
    },
    {
      name: 'member call, optional call (fs.renameSync?.()) — discovered',
      src: `import fs from 'node:fs'; function apply() { fs.renameSync?.(a, b); }`,
      expectedCount: 1,
    },
    {
      name: 'member call, computed NON-literal property (fs[methodVar]) — NOT discovered',
      src: `import fs from 'node:fs'; function apply(methodVar) { fs[methodVar](a, b); }`,
      expectedCount: 0,
    },
    {
      name: 'member call through a shadowing PARAMETER — NOT discovered',
      src: `import fs from 'node:fs'; function apply(fs) { fs.renameSync(a, b); }`,
      expectedCount: 0,
    },
    {
      name: 'member call, WRONG module source (graceful-fs) — NOT discovered',
      src: `import fs from 'graceful-fs'; function apply() { fs.renameSync(a, b); }`,
      expectedCount: 0,
    },
    {
      name: "CommonJS require('fs').renameSync(...) — NOT discovered (out of scope)",
      src: `function apply() { require('fs').renameSync(a, b); }`,
      expectedCount: 0,
    },
  ];

  for (const { name, src, expectedCount } of GRAMMAR_CASES) {
    it(name, () => {
      const { sites } = analyzeRetryWrapping(src, FIXTURE_ABS_PATH, { methodNames: ['renameSync'] });
      assert.equal(sites.length, expectedCount);
    });
  }
});
