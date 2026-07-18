/**
 * @fileoverview The pre-push audit hook selects the in-flight plan via the
 * Status-aware CLI, not `ls -t | head -1` — so a Complete plan is never
 * re-audited (the live bug reference-integrity-gate Cluster C fixes). Plus the
 * versioned managed-block upgrade path (R2-H3/R16).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _internals } from '../scripts/install-prepush-hook.mjs';
const { HOOK_BODY, HOOK_VERSION_MARKER, isManagedHook, installInRepo } = _internals;

describe('prepush hook — Status-aware selection', () => {
  it('selects via check-plan-status --select, NOT `ls -t | head -1`', () => {
    assert.match(HOOK_BODY, /check-plan-status\.mjs"/);        // the STATUS_CLI target
    assert.match(HOOK_BODY, /"\$STATUS_CLI" --select "\$PLANS_DIR"/);
    // The actual old selection COMMAND is gone (a comment may still name it).
    assert.doesNotMatch(HOOK_BODY, /PLAN_FILE=\$\(ls -t/);
  });

  it('discovers AUDIT_LOOP_DIR before selecting (the CLI lives in the source repo)', () => {
    const discoverAt = HOOK_BODY.indexOf('AUDIT_LOOP_DIR="$CLAUDE_AUDIT_LOOP_DIR"');
    const selectAt = HOOK_BODY.indexOf('--select "$PLANS_DIR"');
    assert.ok(discoverAt > 0 && selectAt > 0);
    assert.ok(discoverAt < selectAt, 'discovery must precede selection');
  });

  it('never lets selection abort the push (|| true + empty-check)', () => {
    assert.match(HOOK_BODY, /--select "\$PLANS_DIR" 2>\/dev\/null \|\| true/);
    assert.match(HOOK_BODY, /\[ -z "\$PLAN_FILE" \] && exit 0/);
  });

  it('carries the version marker', () => {
    assert.match(HOOK_BODY, new RegExp(HOOK_VERSION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

describe('prepush hook — install / upgrade path', () => {
  let dir, hookPath, repo;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    hookPath = path.join(dir, '.git', 'hooks', 'pre-push');
    repo = { alias: 't', path: dir };
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('upgrades a LEGACY managed body — the old `ls -t` selection is replaced', () => {
    const legacy = '#!/bin/sh\n# managed-by: claude-audit-loop install-prepush-hook.mjs\nPLAN_FILE=$(ls -t "$PLANS_DIR"/*.md | head -1)\n';
    assert.ok(isManagedHook(legacy), 'the legacy marker must be recognised as managed');
    fs.writeFileSync(hookPath, legacy);
    const r = installInRepo(repo);
    assert.equal(r.action, 'updated');
    const now = fs.readFileSync(hookPath, 'utf8');
    assert.doesNotMatch(now, /ls -t "\$PLANS_DIR"/, 'ls -t selection must be gone');
    assert.match(now, /"\$STATUS_CLI" --select "\$PLANS_DIR"/);
    assert.match(now, new RegExp(HOOK_VERSION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('REFUSES an unmanaged hook — never clobbers operator-authored content', () => {
    fs.writeFileSync(hookPath, '#!/bin/sh\n# my own hook\necho hi\n');
    const r = installInRepo(repo);
    assert.equal(r.action, 'skip');
    assert.match(r.error, /not managed/i);
    assert.match(fs.readFileSync(hookPath, 'utf8'), /my own hook/, 'the operator hook is preserved');
  });

  it('is idempotent — a current body is a noop', () => {
    fs.writeFileSync(hookPath, HOOK_BODY);
    assert.equal(installInRepo(repo).action, 'noop');
  });
});
