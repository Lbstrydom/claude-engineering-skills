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
} from '../scripts/lib/skill-surface-identity.mjs';

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

  // Gate 8 used to carry its OWN copy of the reader, the symlink filter and the
  // alias rule, because the oracle lived in a source-repo CLI this synced module
  // cannot import. The copies agreed, but nothing was maintaining that: they had
  // already drifted in vocabulary, and either could have been fixed alone.
  it('classifies an aliased OWNED skill as aliased, exactly as the oracle does', () => {
    seedConsumer(tmp, ['ship']);
    // Replace the seeded live dir with a junction to the .agents copy.
    fs.rmSync(path.join(tmp, ...LIVE_SURFACE.split('/'), 'ship'), {
      recursive: true, force: true, maxRetries: 3, retryDelay: 50,
    });
    skill(tmp, AGENTS_SURFACE, 'ship');
    try {
      fs.symlinkSync(
        path.join(tmp, ...AGENTS_SURFACE.split('/'), 'ship'),
        path.join(tmp, ...LIVE_SURFACE.split('/'), 'ship'), 'junction',
      );
    } catch {
      return;
    }
    const r = run(VERIFIER, ['--consumer-root', tmp, '--gates', '8', '--format', 'json']);
    assert.equal(r.code, 0, `an alias is not a shadow: ${r.out}`);
    const g8 = JSON.parse(r.out).results.find((x) => x.gate === '8');
    assert.deepEqual(g8.details.aliased, ['.agents/skills/ship'], 'and it is recorded as an alias, not merely tolerated');
  });

  // The delegation's visible consequence: a name we do NOT deploy that is
  // aliased is now `aliased`, where the inline copy called it `foreign` — it
  // tested ownership first and so could never reach its own alias rule for a
  // foreign name. Same ordering bug the oracle had, in the second copy.
  it('classifies an aliased FOREIGN name as aliased, not merely foreign', () => {
    seedConsumer(tmp, ['ship']);
    skill(tmp, AGENTS_SURFACE, 'use-railway');
    try {
      fs.symlinkSync(
        path.join(tmp, ...AGENTS_SURFACE.split('/'), 'use-railway'),
        path.join(tmp, ...LIVE_SURFACE.split('/'), 'use-railway'), 'junction',
      );
    } catch {
      return;
    }
    const r = run(VERIFIER, ['--consumer-root', tmp, '--gates', '8', '--format', 'json']);
    assert.equal(r.code, 0, r.out);
    const g8 = JSON.parse(r.out).results.find((x) => x.gate === '8');
    assert.deepEqual(g8.details.aliased, ['.agents/skills/use-railway']);
    assert.deepEqual(g8.details.foreign, [], 'one directory under two names is not a foreign copy');
  });

  // Delegation is the point, not a detail: a second reader here is a second
  // place for the rule to be wrong. The oracle owns reading a surface.
  it('does not carry its own surface reader', () => {
    const src = fs.readFileSync(VERIFIER, 'utf-8');
    const g8 = src.slice(src.indexOf('function gate8'), src.indexOf('function gate1'));
    assert.ok(g8.includes('compareSkillSurfaces'), 'gate 8 must classify through the shared oracle');
    assert.ok(
      !g8.includes('readdirSync'),
      'gate 8 must read surfaces via listSurfaceNames, not a second readdir with its own symlink filter',
    );
  });
});

// ── IDENTITY CLASSIFIES; OWNERSHIP ONLY SETS SEVERITY ───────────────────────
//
// The 2026-07-30 alias rule ("two names for one directory is not a collision")
// was correct and, on the branch that matters, unreachable. `liveNames` carries
// OWNERSHIP — what this bundle deploys — and the classifier asked that question
// FIRST, returning `orphan` before it ever resolved a path. A plugin's aliased
// skill is by construction a name we do not own, so the alias rule could never
// fire for the exact case it was written for. Found 2026-08-10 in the consumer
// the original comment cites: both its aliased plugin skills were reported as
// an unresolved ambiguity on every sync, with the operator told that "precedence
// is undefined and that is yours to resolve" about ONE directory.
//
// Ordering is the whole fix. Identity is a fact about the filesystem; ownership
// is a fact about the bundle. Asking the bundle question first makes the
// filesystem fact unreachable.
function aliasResolver(sameDir) {
  // Both sides of a real alias resolve to one path; a genuine foreign skill has
  // no live counterpart at all, so the live side resolves to null.
  return (which) => (which === 'live' ? (sameDir ? '/real/dir' : null) : '/real/dir');
}

describe('an alias is recognised even when the bundle does not own the name', () => {
  it('an aliased name we do NOT deploy is `aliased`, never `orphan`', () => {
    const r = compareSkillSurfaces({
      staleNames: ['use-railway'],
      liveNames: ['ship', 'plan'],          // the bundle does not deploy it
      contentOf: () => null,
      realPathOf: aliasResolver(true),
    });
    assert.deepEqual(r.aliased, ['use-railway'], 'one directory, two names');
    assert.deepEqual(r.orphans, [], 'an alias is not an unresolved ambiguity');
    assert.deepEqual(r.shadowed, []);
  });

  // The companion, so the fix above cannot swallow the real case: a foreign name
  // with no live counterpart is still an orphan.
  it('a foreign name that is NOT aliased stays an `orphan`', () => {
    const r = compareSkillSurfaces({
      staleNames: ['use-railway'],
      liveNames: ['ship', 'plan'],
      contentOf: () => null,
      realPathOf: aliasResolver(false),
    });
    assert.deepEqual(r.orphans, ['use-railway']);
    assert.deepEqual(r.aliased, []);
  });

  // And ownership still decides SEVERITY once identity says "two directories".
  it('a name we DO deploy, genuinely duplicated, is still `shadowed`', () => {
    const r = compareSkillSurfaces({
      staleNames: ['ship'],
      liveNames: ['ship'],
      contentOf: () => null,
      realPathOf: (which) => (which === 'live' ? '/live/ship' : '/agents/ship'),
    });
    assert.deepEqual(r.shadowed.map((s) => s.name), ['ship']);
    assert.deepEqual(r.aliased, []);
  });

  // End-to-end reproduction of the consumer case, through the real CLI and a
  // real junction — the unit tests above stub `realPathOf`, so without this the
  // suite could pass while the on-disk resolver was wrong.
  it('the CLI reports a junctioned NON-bundle skill as aliased, not an orphan', () => {
    skill(tmp, AGENTS_SURFACE, 'use-railway', 'plugin skill\n');
    fs.mkdirSync(path.join(tmp, ...LIVE_SURFACE.split('/')), { recursive: true });
    try {
      fs.symlinkSync(
        path.join(tmp, ...AGENTS_SURFACE.split('/'), 'use-railway'),
        path.join(tmp, ...LIVE_SURFACE.split('/'), 'use-railway'), 'junction',
      );
    } catch {
      return;   // platform forbids links — the alias case cannot arise either
    }
    const r = run(BACKSTOP, ['--repo', tmp, '--format', 'json']);
    const agents = JSON.parse(r.out).surfaces.find((x) => x.surface === AGENTS_SURFACE);
    assert.deepEqual(agents.aliased, ['use-railway']);
    assert.deepEqual(agents.orphans, [], 'the operator must not be asked to resolve one directory');
  });
});

describe('every enforcement point resolves identity — no blind call site', () => {
  // `realPathOf` is injectable so the pure unit tests above can drive it. That
  // makes forgetting it silent: a caller that omits it cannot tell an alias from
  // a shadow and reports the alias as the collision. `sync-to-repos.mjs` omitted
  // it from the day the parameter was added.
  //
  // Discovered, never hardcoded — a NEW call site is covered the moment it is
  // written. Same reason the disowned-file predicate asks about the candidates
  // rather than a fixed list.
  const CALL = /compareSkillSurfaces\(\{/g;

  /** Slice the argument object out of a `compareSkillSurfaces({ … })` call. */
  function argObject(src, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(openIdx, i + 1); }
    }
    return null;
  }

  function productionCallSites() {
    const sites = [];
    const roots = [path.join(REPO_ROOT, 'scripts'), path.join(REPO_ROOT, 'scripts', 'lib')];
    for (const dir of roots) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.mjs')) continue;
        const file = path.join(dir, f);
        const src = fs.readFileSync(file, 'utf-8');
        for (const m of src.matchAll(CALL)) {
          sites.push({ file: path.relative(REPO_ROOT, file), args: argObject(src, m.index + 'compareSkillSurfaces('.length) });
        }
      }
    }
    return sites;
  }

  it('finds the call sites at all (guards against a vacuous pass)', () => {
    assert.ok(productionCallSites().length >= 2, 'expected the sync and the backstop to both call the oracle');
  });

  it('every production call site passes realPathOf', () => {
    const blind = productionCallSites().filter((s) => !s.args || !s.args.includes('realPathOf'));
    assert.deepEqual(
      blind.map((s) => s.file), [],
      'a call site without realPathOf cannot distinguish an alias from a shadow',
    );
  });
});
