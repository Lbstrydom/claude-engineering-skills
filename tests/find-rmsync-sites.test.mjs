/**
 * @fileoverview Direct unit tests for scripts/lib/find-rmsync-sites.mjs's
 * @babel/traverse-based scope resolution. tests/rmsync-retry-guard.test.mjs
 * exercises this module against the real repo (compliance regression guard);
 * this file exercises it against small synthetic fixtures chosen to prove the
 * scope-resolution boundary itself — in particular, that a shadowing local
 * binding is NOT matched, which a name-only check could not tell apart from
 * a genuine fs import.
 *
 * Plan: docs/plans/vcs-parsing-and-rmsync-scope-hardening.md
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findRmSyncCallSites } from '../scripts/lib/find-rmsync-sites.mjs';

describe('findRmSyncCallSites — scope resolution', () => {
  it('shadowed local `fs` parameter is NOT matched (negative)', () => {
    const src = `
      import fs from 'node:fs';
      function foo(fs) {
        fs.rmSync('/tmp/x');
      }
    `;
    assert.deepEqual(findRmSyncCallSites(src), []);
  });

  it('aliased named import shadowed by a local parameter is NOT matched (negative)', () => {
    const src = `
      import { rmSync as remove } from 'node:fs';
      function f(remove) {
        remove('/tmp/x');
      }
    `;
    assert.deepEqual(findRmSyncCallSites(src), []);
  });

  it('a local object literal named fs with its own rmSync method is NOT matched (negative)', () => {
    const src = `
      const fs = { rmSync() {} };
      fs.rmSync('/tmp/x');
    `;
    assert.deepEqual(findRmSyncCallSites(src), []);
  });

  it('genuine import used inside a nested function, no shadowing (positive)', () => {
    const src = `
      import fs from 'node:fs';
      function outer() {
        function inner() {
          fs.rmSync('/tmp/x');
        }
        return inner;
      }
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
  });

  it('computed member access fs["rmSync"] is matched (positive)', () => {
    const src = `
      import fs from 'node:fs';
      fs['rmSync']('/tmp/x');
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
  });

  it('optional call fs.rmSync?.(...) is matched (positive)', () => {
    const src = `
      import fs from 'node:fs';
      fs.rmSync?.('/tmp/x');
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
  });

  it('optional member access fs?.rmSync(...) is matched (positive)', () => {
    const src = `
      import fs from 'node:fs';
      fs?.rmSync('/tmp/x');
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
  });

  it('namespace import * as fs is matched (positive)', () => {
    const src = `
      import * as fs from 'node:fs';
      fs.rmSync('/tmp/x', { recursive: true });
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
    assert.deepEqual(sites[0].properties, { recursive: true });
  });

  it('aliased named import — bare call form (positive)', () => {
    const src = `
      import { rmSync as remove } from 'node:fs';
      remove('/tmp/x');
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
  });

  it('a binding with no declaration path (unresolved/global) is NOT matched (negative)', () => {
    // No import at all — `fs` is a free/global identifier from getBinding's
    // perspective. This is the exact case the Gemini-shadow finding flagged:
    // scope.getBinding() returns undefined here, and the resolver must treat
    // that as "no match" rather than throwing or false-matching.
    const src = `
      fs.rmSync('/tmp/x');
    `;
    assert.deepEqual(findRmSyncCallSites(src), []);
  });

  it('detects the retrySync(() => fs.rmSync(...)) wrapping shape via enclosingCall', () => {
    const src = `
      import fs from 'node:fs';
      import { retrySync } from './retry-transient-fs.mjs';
      retrySync(() => fs.rmSync('/tmp/x'));
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].enclosingCall?.callee.type, 'Identifier');
    assert.equal(sites[0].enclosingCall?.callee.name, 'retrySync');
  });

  it('detects the block-body arrow wrapping shape via enclosingCall', () => {
    const src = `
      import fs from 'node:fs';
      import { retrySync } from './retry-transient-fs.mjs';
      retrySync(() => {
        return fs.rmSync('/tmp/x');
      });
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].enclosingCall?.callee.name, 'retrySync');
  });

  it('unrelated named import (e.g. existsSync) produces no site', () => {
    const src = `
      import { existsSync } from 'node:fs';
      existsSync('/tmp/x');
    `;
    assert.deepEqual(findRmSyncCallSites(src), []);
  });

  it('finds multiple independent call sites in one file', () => {
    const src = `
      import fs from 'node:fs';
      fs.rmSync('/tmp/a');
      fs.rmSync('/tmp/b', { recursive: true, maxRetries: 3, retryDelay: 50 });
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 2);
  });
});

describe('findRmSyncCallSites — options extraction (audit R2 M1, Gemini gate G1)', () => {
  it('a spread in the options object fails properties closed to null', () => {
    const src = `
      import fs from 'node:fs';
      const opts = {};
      fs.rmSync('/tmp/x', { ...opts, recursive: true, maxRetries: 3, retryDelay: 50 });
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].properties, null);
  });

  it('a computed key in the options object fails properties closed to null', () => {
    // Not just skipped: the exploit is that {recursive:true, [overrideVar]:
    // false} would otherwise report properties.recursive===true (from the
    // literal entry) while silently missing that overrideVar's VALUE (e.g.
    // 'recursive') overrides it at runtime — a compliance-check bypass.
    const src = `
      import fs from 'node:fs';
      const overrideVar = 'recursive';
      fs.rmSync('/tmp/x', { recursive: true, [overrideVar]: false });
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].properties, null);
  });

  it('an ObjectMethod (getter) in the options object fails properties closed to null', () => {
    const src = `
      import fs from 'node:fs';
      fs.rmSync('/tmp/x', { recursive: true, get maxRetries() { return 3; } });
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].properties, null);
  });

  it('plain literal options (no spread/computed/method) are parsed normally', () => {
    const src = `
      import fs from 'node:fs';
      fs.rmSync('/tmp/x', { recursive: true, maxRetries: 3, retryDelay: 50 });
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
    assert.deepEqual(sites[0].properties, { recursive: true, maxRetries: 3, retryDelay: 50 });
  });

  it('quoted string-literal keys are parsed identically to identifier keys', () => {
    const src = `
      import fs from 'node:fs';
      fs.rmSync('/tmp/x', { 'recursive': true, 'maxRetries': 3, 'retryDelay': 50 });
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
    assert.deepEqual(sites[0].properties, { recursive: true, maxRetries: 3, retryDelay: 50 });
  });
});

describe('findRmSyncCallSites — import specifier name forms (audit R3 H1, Gemini gate G2)', () => {
  it("import { default as fs } (identifier-form) is detected", () => {
    const src = `
      import { default as fs } from 'node:fs';
      fs.rmSync('/tmp/x');
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
  });

  it('import { "default" as fs } (ES2022 string-literal-form) is detected', () => {
    const src = `
      import { "default" as fs } from 'node:fs';
      fs.rmSync('/tmp/x');
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
  });

  it('import { "rmSync" as remove } (ES2022 string-literal-form) is detected', () => {
    const src = `
      import { "rmSync" as remove } from 'node:fs';
      remove('/tmp/x');
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
  });
});

describe('findRmSyncCallSites — enclosingCall wrapper shape (audit R2 M2)', () => {
  it('an async concise-body wrapper is NOT recognized as enclosingCall', () => {
    const src = `
      import fs from 'node:fs';
      import { retrySync } from './retry-transient-fs.mjs';
      retrySync(async () => fs.rmSync('/tmp/x'));
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].enclosingCall, null);
  });

  it('an async block-body wrapper is NOT recognized as enclosingCall', () => {
    const src = `
      import fs from 'node:fs';
      import { retrySync } from './retry-transient-fs.mjs';
      retrySync(async () => { return fs.rmSync('/tmp/x'); });
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].enclosingCall, null);
  });

  it('a synchronous wrapper is still recognized (no regression)', () => {
    const src = `
      import fs from 'node:fs';
      import { retrySync } from './retry-transient-fs.mjs';
      retrySync(() => fs.rmSync('/tmp/x'));
    `;
    const sites = findRmSyncCallSites(src);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].enclosingCall?.callee.name, 'retrySync');
  });
});
