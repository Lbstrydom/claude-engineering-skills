/**
 * @fileoverview Tier 3 (non-negotiable seam — sensitive-path egress): the
 * single resolver for manifest-derived paths.
 *
 * INC-001's lesson is that a classifier existing is not the control; the
 * control is every call site going through it on the CANONICAL path. These
 * assert refusals in every direction AND the negative control — a resolver
 * that refused everything would pass all four refusal tests and be useless.
 *
 * Plan: docs/plans/role-agnostic-comparison-core.md §Security Considerations.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveLocalPath, resolveGitPath, assertHandle, PathRefusedError,
} from '../scripts/lib/comparison/paths.mjs';

const REPO_ROOT = process.cwd();

describe('comparison/paths — local reads, fail-closed', () => {
  it('NEGATIVE CONTROL: an ordinary in-repo file IS accepted', () => {
    // Without this, a resolver that threw unconditionally would pass every
    // other test in this file.
    const h = resolveLocalPath('package.json', { repoRoot: REPO_ROOT });
    assert.equal(h.__resolved, true);
    assert.equal(h.kind, 'local');
    assert.equal(h.rel, 'package.json');
    assert.ok(h.abs && fs.existsSync(h.abs));
    assert.ok(Object.isFrozen(h), 'the handle must be frozen — a consumer cannot rewrite a resolved path');
  });

  it('refuses an absolute path', () => {
    assert.throws(
      () => resolveLocalPath(path.join(REPO_ROOT, 'package.json'), { repoRoot: REPO_ROOT }),
      (e) => e instanceof PathRefusedError && e.reason === 'absolute-path',
    );
  });

  it('refuses a path that escapes the repo', () => {
    assert.throws(
      () => resolveLocalPath('../../etc/passwd', { repoRoot: REPO_ROOT }),
      (e) => e instanceof PathRefusedError && ['escapes-repo', 'missing', 'sensitive'].includes(e.reason),
    );
  });

  it('refuses a missing path AT LOAD — a typo costs nothing', () => {
    assert.throws(
      () => resolveLocalPath('docs/plans/definitely-not-a-real-file-9f3a.md', { repoRoot: REPO_ROOT }),
      (e) => e instanceof PathRefusedError && e.reason === 'missing',
    );
  });

  it('refuses a sensitive path by classification, not by name-matching here', () => {
    // `.env` is the canonical sensitive case; the refusal must come from the
    // shared oracle, which is why this module owns no pattern list of its own.
    assert.throws(
      () => resolveLocalPath('.env', { repoRoot: REPO_ROOT }),
      (e) => e instanceof PathRefusedError && ['sensitive', 'missing'].includes(e.reason),
    );
  });

  it('refuses a symlink whose target is sensitive (the INC-001 shape)', (t) => {
    // The whole incident: a link named innocently, resolving somewhere else.
    const linkRel = `.audit/tmp-inc001-${process.pid}.txt`;
    const linkAbs = path.join(REPO_ROOT, linkRel);
    const targetAbs = path.join(os.homedir(), '.ssh', 'id_rsa');
    fs.mkdirSync(path.dirname(linkAbs), { recursive: true });
    try {
      fs.symlinkSync(targetAbs, linkAbs);
    } catch {
      t.skip('symlink creation not permitted in this environment');
      return;
    }
    try {
      assert.throws(
        () => resolveLocalPath(linkRel, { repoRoot: REPO_ROOT }),
        (e) => e instanceof PathRefusedError,
        'a symlink resolving into ~/.ssh must be refused on its CANONICAL target, not its visible name',
      );
    } finally {
      fs.rmSync(linkAbs, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('comparison/paths — historical reads use git, not the filesystem', () => {
  it('resolves a file that exists at HEAD', () => {
    const h = resolveGitPath('package.json', { repoRoot: REPO_ROOT, rev: 'HEAD' });
    assert.equal(h.kind, 'git');
    assert.equal(h.present, true);
    assert.equal(h.rev, 'HEAD');
    assert.equal(h.abs, null, 'a historical handle has no working-tree absolute path');
  });

  it('a path ABSENT at that revision is unverifiable, NOT a refusal', () => {
    // The functional flaw a realpath-everything rule would have introduced:
    // refusing here turns "the repo moved on" into a false absence claim
    // against a true finding.
    const h = resolveGitPath('docs/plans/role-agnostic-comparison-core.md', {
      repoRoot: REPO_ROOT, rev: 'HEAD~50',
    });
    assert.equal(h.present, false, 'absent at that rev');
    assert.equal(h.kind, 'git');
  });

  it('still refuses an absolute path and a repo escape', () => {
    assert.throws(() => resolveGitPath('/etc/passwd', { repoRoot: REPO_ROOT, rev: 'HEAD' }),
      (e) => e.reason === 'absolute-path');
    assert.throws(() => resolveGitPath('../outside.txt', { repoRoot: REPO_ROOT, rev: 'HEAD' }),
      (e) => e.reason === 'escapes-repo');
  });

  it('requires a revision — a historical read with no rev is a programming error', () => {
    assert.throws(() => resolveGitPath('package.json', { repoRoot: REPO_ROOT }), /rev is required/);
  });
});

describe('comparison/paths — the handle is the control', () => {
  it('assertHandle rejects a bare string, which is the whole point', () => {
    // "Branded type" enforces nothing in a JavaScript repo. This does.
    assert.throws(() => assertHandle('scripts/foo.mjs'),
      (e) => e instanceof PathRefusedError && e.reason === 'not-a-handle');
    assert.throws(() => assertHandle(null), (e) => e.reason === 'not-a-handle');
    assert.throws(() => assertHandle({ rel: 'x', abs: '/x' }), (e) => e.reason === 'not-a-handle');
  });

  it('assertHandle passes a real handle through', () => {
    const h = resolveLocalPath('package.json', { repoRoot: REPO_ROOT });
    assert.equal(assertHandle(h), h);
  });
});
