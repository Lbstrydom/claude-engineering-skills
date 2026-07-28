/**
 * @fileoverview Stale-skill-surface detector (`.github/skills` shadowing).
 *
 * WHY: Copilot Agent Skills reads both `.github/skills/` and `.claude/skills/`,
 * with `.github/skills/` winning on a name collision. `.github/skills/` is
 * deprecated here, so any surviving copy is older than the live one by
 * definition — and silently takes precedence.
 *
 * Found in the field 2026-07-19: a consumer carried an untracked 9-skill
 * `.github/skills/` tree shadowing 6 live skills, `persona-test` by 472 lines
 * and `ship` by 366. The `ship` shadow predated the cross-skill data loop, so
 * ship telemetry silently never recorded — reported as helper-path drift, which
 * was the wrong diagnosis entirely (the path rewriter works).
 *
 * The distinction these tests pin: a SHADOW blocks (a live skill is
 * unreachable), an ORPHAN is advisory (deprecated leftover intercepting
 * nothing). Collapsing the two would either cry wolf or go blind.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  compareSkillSurfaces,
  decideStaleSurfaceExit,
  listSurfaceNames,
  STALE_SURFACE,
  LIVE_SURFACE,
} from '../scripts/check-stale-skill-surface.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'check-stale-skill-surface.mjs');

/** Build a contentOf() over a {surface: {name: body}} fixture. */
const contentFrom = (map) => (surface, name) => map[surface]?.[name] ?? null;

describe('compareSkillSurfaces', () => {
  it('flags a skill present in BOTH surfaces as shadowed', () => {
    const r = compareSkillSurfaces({
      staleNames: ['ship'],
      liveNames: ['ship', 'plan'],
      contentOf: contentFrom({
        [STALE_SURFACE]: { ship: 'old\n'.repeat(10) },
        [LIVE_SURFACE]: { ship: 'new\n'.repeat(50) },
      }),
    });
    assert.equal(r.shadowed.length, 1);
    assert.equal(r.shadowed[0].name, 'ship');
    assert.equal(r.orphans.length, 0);
  });

  it('reports how far behind the shadowing copy is', () => {
    const r = compareSkillSurfaces({
      staleNames: ['persona-test'],
      liveNames: ['persona-test'],
      contentOf: contentFrom({
        [STALE_SURFACE]: { 'persona-test': 'x\n'.repeat(364) },
        [LIVE_SURFACE]: { 'persona-test': 'x\n'.repeat(836) },
      }),
    });
    const s = r.shadowed[0];
    assert.equal(s.staleLines, 365);
    assert.equal(s.liveLines, 837);
    assert.equal(s.lineDelta, 472, 'the drift magnitude is the operator-facing signal');
    assert.equal(s.identical, false);
  });

  it('classifies a stale-only skill as an orphan, not a shadow', () => {
    // plan-backend/plan-frontend were merged into `plan` upstream, so their
    // stale copies shadow nothing — real case from the field incident.
    const r = compareSkillSurfaces({
      staleNames: ['plan-backend', 'plan-frontend'],
      liveNames: ['plan'],
      contentOf: contentFrom({ [STALE_SURFACE]: { 'plan-backend': 'a', 'plan-frontend': 'b' } }),
    });
    assert.equal(r.shadowed.length, 0);
    assert.deepEqual(r.orphans, ['plan-backend', 'plan-frontend']);
  });

  it('still flags a byte-identical collision as shadowed', () => {
    // Identical today is not safe tomorrow: the live copy gets regenerated and
    // the stale one does not, so the collision is the hazard, not the drift.
    const body = 'same\n';
    const r = compareSkillSurfaces({
      staleNames: ['audit'],
      liveNames: ['audit'],
      contentOf: contentFrom({ [STALE_SURFACE]: { audit: body }, [LIVE_SURFACE]: { audit: body } }),
    });
    assert.equal(r.shadowed.length, 1);
    assert.equal(r.shadowed[0].identical, true);
  });

  it('reports nothing when the stale surface is absent', () => {
    const r = compareSkillSurfaces({ staleNames: [], liveNames: ['ship'], contentOf: () => null });
    assert.deepEqual(r, { shadowed: [], orphans: [], total: 0 });
  });

  it('handles a missing SKILL.md without throwing', () => {
    const r = compareSkillSurfaces({
      staleNames: ['broken'],
      liveNames: ['broken'],
      contentOf: () => null,
    });
    assert.equal(r.shadowed[0].staleLines, 0);
    assert.equal(r.shadowed[0].identical, false, 'two unreadable files are not "identical"');
  });
});

// docs/plans/refactor-skill-governance.md round-2 audit M1 — listSurfaceNames
// is the extracted, exported reader both main() and sync-to-repos.mjs share.
describe('listSurfaceNames', () => {
  let tmp;
  const mk = () => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-surface-')); return tmp; };
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); tmp = undefined; });

  it('an absent surface is clean, not an error', () => {
    const root = mk();
    const r = listSurfaceNames(root, STALE_SURFACE);
    assert.deepEqual(r, { names: [], readable: true });
  });

  it('a readable surface returns sorted directory names, files excluded', () => {
    const root = mk();
    const base = path.join(root, ...STALE_SURFACE.split('/'));
    fs.mkdirSync(path.join(base, 'zeta'), { recursive: true });
    fs.mkdirSync(path.join(base, 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(base, 'not-a-skill.txt'), 'x');
    const r = listSurfaceNames(root, STALE_SURFACE);
    assert.deepEqual(r, { names: ['alpha', 'zeta'], readable: true });
  });

  it('round-3 shadow finding #3 — a stray FILE at the surface path is ENOTDIR, not silently clean', () => {
    const root = mk();
    const base = path.join(root, ...STALE_SURFACE.split('/'));
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(base, 'not actually a directory');

    const r = listSurfaceNames(root, STALE_SURFACE);

    assert.equal(r.readable, false);
    assert.equal(r.names, null);
    assert.equal(r.error.code, 'ENOTDIR');
    assert.equal(r.error.path, base);
    assert.match(r.error.message, /ENOTDIR/);
  });

  it('audit-code round-3 M1 — a non-existent repository root is a real error, not "surface absent, clean"', () => {
    const root = path.join(mk(), 'this-does-not-exist-at-all');
    // Deliberately never mkdirSync(root) — the whole point is that root
    // itself is missing, not just the .github/skills/ subfolder under it.

    const r = listSurfaceNames(root, STALE_SURFACE);

    assert.equal(r.readable, false, 'a missing repo root must not read as a clean absent-surface');
    assert.equal(r.names, null);
    assert.equal(r.error.path, root, 'the error must point at the root, not the unreachable surface subpath');
    assert.match(r.error.message, /repository root does not exist/);
  });

  it('a genuinely-absent surface under a REAL root is still clean (the fix does not over-correct)', () => {
    const root = mk(); // mkdtempSync — root genuinely exists, .github/skills/ does not
    const r = listSurfaceNames(root, STALE_SURFACE);
    assert.deepEqual(r, { names: [], readable: true });
  });
});

describe('decideStaleSurfaceExit', () => {
  it('blocks in gate mode when anything is shadowed', () => {
    assert.equal(decideStaleSurfaceExit({ gate: true, shadowedCount: 1 }), 1);
    assert.equal(decideStaleSurfaceExit({ gate: true, shadowedCount: 6 }), 1);
  });

  it('does not block in gate mode on orphans alone', () => {
    assert.equal(decideStaleSurfaceExit({ gate: true, shadowedCount: 0 }), 0);
  });

  it('never blocks outside gate mode — report-only stays report-only', () => {
    assert.equal(decideStaleSurfaceExit({ gate: false, shadowedCount: 9 }), 0);
  });
});

// docs/plans/refactor-skill-governance.md round-2 audit M1 — main()'s exit
// path on an unreadable surface must be unconditional, not gated by --gate.
describe('check-stale-skill-surface.mjs CLI — unreadable surface hard-fails regardless of --gate', () => {
  it('exits 1 with no --gate flag when the live surface is unreadable', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-surface-cli-'));
    try {
      const base = path.join(tmp, ...LIVE_SURFACE.split('/'));
      fs.mkdirSync(path.dirname(base), { recursive: true });
      fs.writeFileSync(base, 'not a directory');

      await assert.rejects(
        execFileAsync(process.execPath, [CLI, '--repo', tmp], { cwd: REPO_ROOT }),
        (err) => {
          assert.equal(err.code, 1, 'must exit 1 even though --gate was never passed');
          assert.match(err.stderr, /cannot inspect/);
          return true;
        },
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('--format json emits a valid envelope on the unreadable branch, not plaintext (Gemini gate G1)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-surface-cli-'));
    try {
      const base = path.join(tmp, ...STALE_SURFACE.split('/'));
      fs.mkdirSync(path.dirname(base), { recursive: true });
      fs.writeFileSync(base, 'not a directory');

      let stdout;
      try {
        await execFileAsync(process.execPath, [CLI, '--repo', tmp, '--format', 'json'], { cwd: REPO_ROOT });
        assert.fail('expected a non-zero exit');
      } catch (err) {
        assert.equal(err.code, 1);
        stdout = err.stdout;
      }
      const parsed = JSON.parse(stdout); // throws if this were plaintext, failing the test
      assert.equal(parsed.status, 'error');
      assert.equal(parsed.exitCode, 1);
      assert.match(parsed.inspectionError, /ENOTDIR/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

// Gemini gate wrongly_dismissed M3 (real bug — Claude's round-1 dismissal was
// wrong, correctly challenged): a malformed --repo must not silently fall
// back to checking process.cwd() instead of erroring.
describe('check-stale-skill-surface.mjs CLI — malformed --repo is rejected, not silently defaulted to cwd', () => {
  it('--repo with no following value exits 2', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [CLI, '--repo'], { cwd: REPO_ROOT }),
      (err) => {
        assert.equal(err.code, 2);
        assert.match(err.stderr, /--repo requires a directory path/);
        return true;
      },
    );
  });

  it('--repo immediately followed by another flag exits 2 (the flag is not swallowed as the path)', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [CLI, '--repo', '--gate'], { cwd: REPO_ROOT }),
      (err) => {
        assert.equal(err.code, 2);
        assert.match(err.stderr, /--repo requires a directory path/);
        return true;
      },
    );
  });
});
