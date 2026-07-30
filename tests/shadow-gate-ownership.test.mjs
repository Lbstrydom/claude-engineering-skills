/**
 * The shadowing gate is OWNERSHIP-scoped, across three enforcement points.
 *
 * `.claude/skills/` is not the only root an agent reads: VS Code Copilot also
 * discovers `.github/skills/` and `.agents/skills/`, and precedence between roots
 * is **not documented**. So a name present in two roots does not mean "the newer
 * one wins" — it means *which file gets read is undefined*. That is why it blocks.
 *
 * The property every one of the three enforcement points must share, and the
 * reason this file exists:
 *
 *   FAIL when a name WE deploy is shadowed. NEVER fail on a name we do not.
 *
 * Consumers legitimately keep their own skills in `.agents/skills/` — one carries
 * `supabase-postgres-best-practices` and `use-railway` from unrelated plugins, and
 * both of those also exist in its `.claude/skills/`. A gate that failed on those
 * would be blocking a repo over content nobody here can act on, which is exactly
 * how a gate earns a permanent `--no-verify` and then protects nothing. Measured
 * before shipping: a naive "any name in two roots" predicate blocked that
 * consumer's sync immediately.
 *
 * Plan: docs/reference/skill-surface-ownership.md §3.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  SHADOWING_SURFACES, STALE_SURFACE, AGENTS_SURFACE, LIVE_SURFACE,
  compareSkillSurfaces,
} from '../scripts/check-stale-skill-surface.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKSTOP = path.join(REPO_ROOT, 'scripts', 'check-stale-skill-surface.mjs');
const VERIFIER = path.join(REPO_ROOT, 'scripts', 'lib', 'sync-isolation-verify.mjs');

let tmp;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-gate-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

function skill(root, surface, name, body = 'x\n') {
  const dir = path.join(root, ...surface.split('/'), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

// `stdio: 'pipe'` on BOTH streams: these CLIs write their human report to
// STDERR, so an earlier version of this helper returned only stdout on exit 0 and
// every success-path assertion matched against an empty string — a test that
// could not fail.
function run(cli, args) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: REPO_ROOT, encoding: 'utf-8' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

describe('SHADOWING_SURFACES declares every discovered root that can shadow', () => {
  it('covers .github/skills AND .agents/skills', () => {
    assert.deepEqual([...SHADOWING_SURFACES].sort(), [AGENTS_SURFACE, STALE_SURFACE].sort());
  });

  it('does not include the live surface itself', () => {
    assert.ok(!SHADOWING_SURFACES.includes(LIVE_SURFACE));
  });
});

describe('compareSkillSurfaces — ownership is the predicate', () => {
  it('a name we deploy is `shadowed` (fatal)', () => {
    const r = compareSkillSurfaces({ staleNames: ['ship'], liveNames: ['ship', 'plan'], contentOf: () => null });
    assert.deepEqual(r.shadowed.map(s => s.name), ['ship']);
    assert.deepEqual(r.orphans, []);
  });

  it('a name we do NOT deploy is an `orphan` (advisory), never shadowed', () => {
    const r = compareSkillSurfaces({
      staleNames: ['use-railway', 'supabase-postgres-best-practices'],
      liveNames: ['ship', 'plan'],
      contentOf: () => null,
    });
    assert.deepEqual(r.shadowed, []);
    assert.deepEqual(r.orphans.sort(), ['supabase-postgres-best-practices', 'use-railway']);
  });
});

describe('check-stale-skill-surface --gate (source-repo enforcement)', () => {
  it('blocks when one of OUR skills is shadowed in .agents/skills', () => {
    skill(tmp, LIVE_SURFACE, 'ship', 'a\nb\nc\n');
    skill(tmp, AGENTS_SURFACE, 'ship', 'a\n');
    const r = run(BACKSTOP, ['--gate', '--repo', tmp]);
    assert.equal(r.code, 1);
    assert.match(r.out, /ship/);
    // The remedy must name the right directory — with two shadowing roots, a
    // hardcoded `.github/skills` message would be wrong half the time.
    assert.match(r.out, /\.agents[\\/]skills[\\/]ship/);
  });

  it('blocks when one of OUR skills is shadowed in .github/skills', () => {
    skill(tmp, LIVE_SURFACE, 'plan');
    skill(tmp, STALE_SURFACE, 'plan');
    const r = run(BACKSTOP, ['--gate', '--repo', tmp]);
    assert.equal(r.code, 1);
    assert.match(r.out, /\.github[\\/]skills[\\/]plan/);
  });

  // THE regression this file exists for.
  it('does NOT block on a consumer\'s own skills in .agents/skills', () => {
    skill(tmp, LIVE_SURFACE, 'ship');
    skill(tmp, LIVE_SURFACE, 'use-railway');          // consumer's own, in both roots
    skill(tmp, AGENTS_SURFACE, 'use-railway');
    const r = run(BACKSTOP, ['--gate', '--repo', tmp]);
    assert.equal(r.code, 0, `must not gate a consumer's own content: ${r.out}`);
    assert.match(r.out, /does not deploy/, 'but it must still SAY so rather than pass silently');
  });

  // A symlink means ONE directory reachable by two names — not a collision.
  // Verified live in a consumer 2026-07-30: its plugin skills sit in
  // `.agents/skills/<n>` and are exposed as `.claude/skills/<n>` via a junction,
  // with byte-identical `realpath`. Whichever root the agent reads, it gets the
  // same file. Flagging that would fail a repo for correct plugin wiring.
  it('treats a symlinked alias as aliased, not shadowed', () => {
    // Use one of OUR names, so ownership is not what makes this pass.
    skill(tmp, AGENTS_SURFACE, 'ship', 'shared\n');
    fs.mkdirSync(path.join(tmp, ...LIVE_SURFACE.split('/')), { recursive: true });
    try {
      fs.symlinkSync(
        path.join(tmp, ...AGENTS_SURFACE.split('/'), 'ship'),
        path.join(tmp, ...LIVE_SURFACE.split('/'), 'ship'), 'junction',
      );
    } catch {
      return;   // platform forbids links — the alias case cannot arise either
    }
    const r = run(BACKSTOP, ['--gate', '--repo', tmp, '--format', 'json']);
    assert.equal(r.code, 0, `an alias is not a shadow: ${r.out}`);
    const agents = JSON.parse(r.out).surfaces.find((x) => x.surface === AGENTS_SURFACE);
    assert.deepEqual(agents.aliased, ['ship']);
    assert.deepEqual(agents.shadowed, []);
  });

  // The companion: same name, DIFFERENT directories, one of ours → must block.
  // Without this, the alias rule above could silently swallow real shadows.
  it('still blocks when the two copies are genuinely different directories', () => {
    skill(tmp, LIVE_SURFACE, 'ship', 'live\n');
    skill(tmp, AGENTS_SURFACE, 'ship', 'other\n');
    const r = run(BACKSTOP, ['--gate', '--repo', tmp, '--format', 'json']);
    assert.equal(r.code, 1);
    const agents = JSON.parse(r.out).surfaces.find((x) => x.surface === AGENTS_SURFACE);
    assert.deepEqual(agents.shadowed.map((s) => s.name), ['ship']);
    assert.deepEqual(agents.aliased, []);
  });

  it('reports the staleness delta, per surface', () => {
    skill(tmp, LIVE_SURFACE, 'ship', 'a\nb\nc\nd\ne\n');
    skill(tmp, AGENTS_SURFACE, 'ship', 'a\nb\n');
    const r = run(BACKSTOP, ['--gate', '--repo', tmp]);
    // Regression: compareSkillSurfaces requests content with the literal
    // STALE_SURFACE constant, so a naive passthrough read `.github/skills/...`
    // while comparing `.agents/skills` and reported every shadow as "0 lines".
    assert.match(r.out, /3 lines vs live 6/);
    assert.match(r.out, /3 lines behind/);
  });

  it('a clean repo passes and names both roots it checked', () => {
    skill(tmp, LIVE_SURFACE, 'ship');
    const r = run(BACKSTOP, ['--gate', '--repo', tmp]);
    assert.equal(r.code, 0);
    assert.match(r.out, /\.github\/skills/);
    assert.match(r.out, /\.agents\/skills/);
  });
});

describe('sync-isolation-verify gate 8 (consumer-side, continuous enforcement)', () => {
  /** A minimal but schema-valid consumer manifest declaring the skills we deploy. */
  function seedConsumer(root, ourSkills) {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    const files = {};
    for (const n of ourSkills) files[`.claude/skills/${n}/SKILL.md`] = 'sha256:' + 'a'.repeat(64);
    // Shape per SyncManifestSchema: generatedAt/repo/branch/commitSha/files/layout.
    fs.writeFileSync(path.join(root, 'scripts', '.sync-manifest.json'), JSON.stringify({
      generatedAt: new Date(0).toISOString(),
      repo: 'Lbstrydom/claude-engineering-skills',
      branch: 'main',
      commitSha: 'a'.repeat(40),
      layout: 'isolated',
      files,
    }, null, 2));
    for (const n of ourSkills) skill(root, LIVE_SURFACE, n);
  }

  it('fails when a manifest-declared skill is shadowed', () => {
    seedConsumer(tmp, ['ship', 'plan']);
    skill(tmp, AGENTS_SURFACE, 'ship');
    const r = run(VERIFIER, ['--consumer-root', tmp, '--gates', '8']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /\.agents\/skills\/ship/);
    assert.match(r.out, /precedence between discovered roots is undefined/);
  });

  it('passes when only a NON-declared name is present in another root', () => {
    seedConsumer(tmp, ['ship', 'plan']);
    skill(tmp, AGENTS_SURFACE, 'use-railway');
    const r = run(VERIFIER, ['--consumer-root', tmp, '--gates', '8']);
    assert.equal(r.code, 0, r.out);
  });

  it('passes when no other root exists at all', () => {
    seedConsumer(tmp, ['ship']);
    const r = run(VERIFIER, ['--consumer-root', tmp, '--gates', '8']);
    assert.equal(r.code, 0, r.out);
  });

  // Success-path honesty: "gate 8 OK" must not be reachable by checking nothing.
  it('says so explicitly when the manifest declares no skills', () => {
    seedConsumer(tmp, []);
    const r = run(VERIFIER, ['--consumer-root', tmp, '--gates', '8', '--format', 'json']);
    assert.equal(r.code, 0);
    assert.match(r.out, /manifest declares no \.claude\/skills entries/);
  });

  it('derives ownership from the manifest, not a hardcoded list', () => {
    // A skill name that is NOT in this bundle, but IS declared by the manifest,
    // must still be protected — the manifest is the authority.
    seedConsumer(tmp, ['totally-made-up-skill']);
    skill(tmp, AGENTS_SURFACE, 'totally-made-up-skill');
    const r = run(VERIFIER, ['--consumer-root', tmp, '--gates', '8']);
    assert.notEqual(r.code, 0, 'manifest-declared names are what we own');
  });
});
