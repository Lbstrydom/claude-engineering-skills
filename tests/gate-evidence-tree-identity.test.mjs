/**
 * WS-E / E1 — the audited-target identity contract.
 *
 * The hole this closes, in one sentence: `resolveEvidence` used to verify
 * RECENCY only (`evidenceMs > headCommitTs * 1000`), so `AI-Gate: passed` was
 * reachable for a commit whose content was never audited — audit a clean tree,
 * edit files, commit, and freshness still passes. The plan calls that worse than
 * an honest `not-run`, because the marker writer now ships.
 *
 * The centrepiece is `the false-pass attack` below: it drives the REAL
 * validators end-to-end and asserts the sequence is refused. Everything else
 * exists so a future edit cannot quietly weaken one leg of it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { buildGateEvidence, writeGateEvidence } from '../scripts/lib/audit/gate-evidence.mjs';
import { resolveEvidence, evaluateGateVerification, TREE_ID_RE } from '../scripts/lib/commit-trailers.mjs';
import { gitWorktreeTree, gitIndexTree } from '../scripts/lib/vcs.mjs';

const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);
const RUN_ID = '06a485cf-dff3-4c22-a9ad-40f4bf18d208';

/** In-memory fs stub exposing only what resolveEvidence uses. */
const fsWith = (contents) => ({ readFileSync: () => contents });

const freshEvidence = (payload) => resolveEvidence({
  auditRunPath: '/x/last-audit-run.json',
  headCommitTs: 0,                       // any real ts is newer → `fresh`
  fsMod: fsWith(JSON.stringify(payload)),
});

const converged = { roundConvergedAfter: 2 };

// ── The attack the contract exists to stop ─────────────────────────────────

describe('E1 — the false-pass attack is refused', () => {
  it('audit clean tree -> edit -> commit: fresh + converged, but REFUSED on tree mismatch', () => {
    // The audit recorded TREE_A. The operator then edited, so the tree actually
    // being committed is TREE_B. Every legacy signal still says yes:
    const evidence = freshEvidence(buildGateEvidence({ runId: RUN_ID, auditedTree: TREE_A, auditedSha: TREE_A }));
    assert.equal(evidence.state, 'fresh', 'freshness alone still passes — that is the whole problem');
    assert.equal(converged.roundConvergedAfter, 2, 'the store verdict also still says converged');

    const verdict = evaluateGateVerification({
      gate: 'passed', evidence, cloudEnabled: true, convergence: converged, committedTree: TREE_B,
    });
    assert.ok(verdict, 'passed must be REFUSED — the committed content was never audited');
    assert.match(verdict.custom, /is not what run .* audited/);
    assert.match(verdict.custom, /--gate waived/, 'the refusal must name the honest alternative');
  });

  it('the matching case still passes — the check is not simply always-refuse', () => {
    const evidence = freshEvidence(buildGateEvidence({ runId: RUN_ID, auditedTree: TREE_A, auditedSha: TREE_A }));
    const verdict = evaluateGateVerification({
      gate: 'passed', evidence, cloudEnabled: true, convergence: converged, committedTree: TREE_A,
    });
    assert.equal(verdict, null, 'audited tree === committed tree → passed is licensed');
  });
});

// ── Fail-closed directions ─────────────────────────────────────────────────

describe('E1 — unverifiable evidence never reads as a pass', () => {
  it('a legacy (pre-E1) marker with no auditedTree is refused', () => {
    // Exactly the shape the stale 2026-06-04 pointer had.
    const evidence = freshEvidence({ runId: RUN_ID, sid: 'audit-1', round: 1, ts: new Date().toISOString() });
    assert.equal(evidence.state, 'fresh');
    assert.equal(evidence.auditedTree, null);
    const verdict = evaluateGateVerification({
      gate: 'passed', evidence, cloudEnabled: true, convergence: converged, committedTree: TREE_A,
    });
    assert.ok(verdict, 'introducing the field must not retroactively legitimise unbound evidence');
    assert.match(verdict.custom, /no audited-tree identity/);
  });

  it('a malformed auditedTree is treated as absent, not compared as an opaque string', () => {
    const evidence = freshEvidence({ runId: RUN_ID, ts: new Date().toISOString(), auditedTree: 'not-a-sha' });
    assert.equal(evidence.auditedTree, null);
    assert.ok(!TREE_ID_RE.test('not-a-sha'));
  });

  it('an unresolvable committed tree is refused rather than skipped', () => {
    const evidence = freshEvidence(buildGateEvidence({ runId: RUN_ID, auditedTree: TREE_A }));
    const verdict = evaluateGateVerification({
      gate: 'passed', evidence, cloudEnabled: true, convergence: converged, committedTree: null,
    });
    assert.ok(verdict);
    assert.match(verdict.custom, /cannot resolve the tree being committed/);
  });

  it('the tree check runs BEFORE the store lookups, so it refuses even with cloud off', () => {
    const evidence = freshEvidence(buildGateEvidence({ runId: RUN_ID, auditedTree: TREE_A }));
    const verdict = evaluateGateVerification({
      gate: 'passed', evidence, cloudEnabled: false, convergence: null, committedTree: TREE_B,
    });
    assert.match(verdict.custom, /is not what run .* audited/,
      'the identity mismatch is the primary refusal — not masked by the cloud-unavailable message');
  });

  it('gates other than passed are unaffected', () => {
    const evidence = freshEvidence(buildGateEvidence({ runId: RUN_ID, auditedTree: TREE_A }));
    for (const gate of ['waived', 'not-run']) {
      assert.equal(evaluateGateVerification({
        gate, evidence, cloudEnabled: true, convergence: converged, committedTree: TREE_B,
      }), null, `${gate} must not be blocked by the identity check`);
    }
  });
});

// ── The writer refuses to manufacture evidence it cannot support ───────────

describe('E1 — writeGateEvidence is evidence-less without an identity', () => {
  it('writes no marker when the VCS capture failed', () => {
    let wrote = false;
    const res = writeGateEvidence({
      repoRoot: '/repo', runId: RUN_ID, mode: 'code', auditedTree: null,
      log: () => {}, adapters: { atomicWriteFileSync: () => { wrote = true; } },
    });
    assert.equal(res.written, false);
    assert.equal(res.reason, 'no-audited-tree');
    assert.equal(wrote, false, 'a tree-less marker must never reach disk');
  });

  it('writes the identity through when capture succeeded', () => {
    let payload = null;
    const res = writeGateEvidence({
      repoRoot: '/repo', runId: RUN_ID, mode: 'code', auditedTree: TREE_A, auditedSha: TREE_B,
      log: () => {}, adapters: { atomicWriteFileSync: (_p, body) => { payload = JSON.parse(body); } },
    });
    assert.equal(res.written, true);
    assert.equal(payload.auditedTree, TREE_A);
    assert.equal(payload.auditedSha, TREE_B);
    // Round-trips through the REAL reader, so writer and validator cannot drift.
    assert.equal(freshEvidence(payload).auditedTree, TREE_A);
  });
});

// ── The capture primitives, against a real throwaway repo ──────────────────

describe('E1 — gitWorktreeTree hashes the worktree, not the index', () => {
  const mkRepo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e1-repo-'));
    const g = (cmd) => execSync(`git ${cmd}`, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    g('init -q');
    g('config user.email t@t.test');
    g('config user.name Test');
    g('config commit.gpgsign false');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'original\n');
    g('add -A');
    g('commit -q -m initial');
    return { dir, g };
  };

  it('an unstaged edit changes the worktree tree but NOT the index tree', () => {
    const { dir } = mkRepo();
    try {
      const before = gitWorktreeTree(dir);
      assert.equal(before.ok, true);

      // Edit on disk only — do not stage. This is the divergence that makes
      // hashing the index wrong: the audit reads THIS content.
      fs.writeFileSync(path.join(dir, 'a.txt'), 'edited by the author\n');

      const after = gitWorktreeTree(dir);
      const index = gitIndexTree(dir);
      assert.equal(after.ok, true);
      assert.notEqual(after.tree, before.tree, 'worktree hash must track on-disk content');
      assert.equal(index.tree, before.tree, 'index hash must NOT see the unstaged edit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('capturing does not disturb the real index (staged state survives)', () => {
    const { dir, g } = mkRepo();
    try {
      fs.writeFileSync(path.join(dir, 'b.txt'), 'staged\n');
      g('add b.txt');
      const stagedBefore = execSync('git diff --cached --name-only', { cwd: dir }).toString().trim();
      gitWorktreeTree(dir);
      const stagedAfter = execSync('git diff --cached --name-only', { cwd: dir }).toString().trim();
      assert.equal(stagedAfter, stagedBefore, 'the throwaway index must not leak into the repo');
      assert.equal(stagedAfter, 'b.txt');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('untracked files count, ignored files do not', () => {
    const { dir } = mkRepo();
    try {
      const base = gitWorktreeTree(dir).tree;
      fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
      const withIgnoreFile = gitWorktreeTree(dir).tree;
      assert.notEqual(withIgnoreFile, base, '.gitignore is itself tracked content');

      fs.writeFileSync(path.join(dir, 'ignored.txt'), 'noise\n');
      assert.equal(gitWorktreeTree(dir).tree, withIgnoreFile, 'ignored paths must not move the hash');

      fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked but real\n');
      assert.notEqual(gitWorktreeTree(dir).tree, withIgnoreFile, 'untracked source IS audited content');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('returns a structured error rather than throwing outside a repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e1-norepo-'));
    try {
      const res = gitWorktreeTree(dir);
      assert.equal(res.ok, false);
      assert.ok(res.error?.code, 'must carry a VcsErrorCode so the caller can go evidence-less deliberately');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
