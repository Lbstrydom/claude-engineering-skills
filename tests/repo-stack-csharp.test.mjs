/**
 * C# stack detection and the surfaces that read it (docs/plans/file-coverage-contract-and-csharp.md, Phase 7;
 * audit-plan R1-M4).
 *
 * The storyline repo is an Electron/TypeScript monorepo with ONE C# service several directories down: no marker at the
 * repo root, and the C# half was invisible to stack detection, fit-check and the architecture-map banner.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { detectRepoStack, hasCsharpSources } from '../scripts/lib/repo-stack.mjs';
import { detectShape } from '../scripts/lib/fit-check/detect.mjs';
import { applyRules } from '../scripts/lib/fit-check/rules.mjs';
import { normalizeLanguage } from '../scripts/lib/config.mjs';
import { mkdtemp } from './helpers/fixtures.mjs';

const ARCH_MEMORY = 'architectural memory (arch:refresh / arch:render)';

let dir;
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
const write = (rel, body = '') => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};
beforeEach(() => { dir = mkdtemp('repo-stack-cs-'); git('init', '--quiet'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('hasCsharpSources', () => {
  it('a nested project with no marker at the repo root is detected (the monorepo shape)', () => {
    write('package.json', '{"dependencies":{"react":"18"}}');
    write('services/renderer/renderer.csproj', '<Project />');
    write('services/renderer/src/Program.cs', 'class P { }');
    assert.equal(hasCsharpSources(dir), true);
  });

  it('a NEW, uncommitted .cs file counts (tracked-only enumeration would miss it — audit-plan R1-M4)', () => {
    write('README.md', 'x');
    git('add', 'README.md');
    assert.equal(hasCsharpSources(dir), false);
    write('svc/New.cs', 'class N { }');
    assert.equal(hasCsharpSources(dir), true, 'untracked and not ignored');
  });

  it('a gitignored .cs (build output) does NOT count', () => {
    write('.gitignore', 'obj/\n');
    write('obj/Generated.cs', 'class G { }');
    assert.equal(hasCsharpSources(dir), false);
  });

  it('a DELETED tracked file is not counted', () => {
    write('a.csproj', '<Project />');
    git('add', 'a.csproj');
    fs.unlinkSync(path.join(dir, 'a.csproj')); // a single file, not a tree — the deletion (not the cleanup) is the point of the test
    assert.equal(hasCsharpSources(dir), false, 'ls-files --cached still lists it; the deletion must win');
  });

  it('.sln and .slnx alone are enough', () => {
    write('All.sln', 'Microsoft Visual Studio Solution File');
    assert.equal(hasCsharpSources(dir), true);
  });

  it('a non-git directory falls back to the inventory filesystem walk, never a throw', () => {
    const plain = mkdtemp('repo-stack-cs-plain-');
    try {
      assert.equal(hasCsharpSources(plain), false);
      fs.writeFileSync(path.join(plain, 'A.cs'), 'class A { }');
      assert.equal(hasCsharpSources(plain), true);
    } finally { fs.rmSync(plain, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('detectRepoStack + csharp', () => {
  it('exposes csharp in stackKinds beside js-ts, while `stack` stays the coarse enum', () => {
    write('package.json', '{"dependencies":{"react":"18"}}');
    write('services/r/r.csproj', '<Project />');
    const r = detectRepoStack(dir);
    assert.equal(r.stack, 'js-ts');
    assert.deepEqual(r.stackKinds, ['js-ts', 'csharp']);
  });

  it('a C#-only repo is stack `unknown` with stackKinds [csharp] — no longer an empty list', () => {
    write('src/Program.cs', 'class P { }');
    const r = detectRepoStack(dir);
    assert.equal(r.stack, 'unknown');
    assert.deepEqual(r.stackKinds, ['csharp']);
  });

  it('negative control: a repo with no C# has no csharp kind', () => {
    write('package.json', '{"dependencies":{"react":"18"}}');
    assert.equal(detectRepoStack(dir).stackKinds.includes('csharp'), false);
  });
});

describe('fit-check reads csharp', () => {
  it('a js-ts repo carrying a C# service is PARTIAL for architectural memory, naming csharp — not FITS', () => {
    write('package.json', '{"dependencies":{"react":"18"}}');
    write('services/r/r.csproj', '<Project />');
    const profile = detectShape(dir);
    assert.ok(profile.stackKinds.includes('csharp'));
    const v = applyRules(profile).find((x) => x.skill === ARCH_MEMORY);
    assert.equal(v.label, 'PARTIAL');
    assert.match(v.reason, /csharp/);
  });
});

describe('the bandit language bucket', () => {
  it('C# aliases resolve to `cs`, not `other`', () => {
    for (const a of ['c#', 'C#', 'csharp', 'CSharp', 'cs']) assert.equal(normalizeLanguage(a), 'cs', a);
    assert.equal(normalizeLanguage('fortran'), 'other');
  });
});
