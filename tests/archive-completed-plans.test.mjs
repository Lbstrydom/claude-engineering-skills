import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  parseStatus,
  isComplete,
  findAuditSummariesFor,
  runArchive,
} from '../scripts/archive-completed-plans.mjs';

// ── parseStatus ───────────────────────────────────────────────────────────

describe('archive-completed-plans / parseStatus', () => {
  it('extracts the Status line from a metadata block', () => {
    const md = `# Plan: Foo

- **Date**: 2026-05-09
- **Status**: Complete (v1)
- **Author**: Claude

body
`;
    assert.equal(parseStatus(md), 'Complete (v1)');
  });

  it('returns null when no Status line', () => {
    assert.equal(parseStatus('# Plan: Foo\n\nbody'), null);
    assert.equal(parseStatus(null), null);
    assert.equal(parseStatus(123), null);
  });

  it('handles multi-word statuses', () => {
    const md = '- **Status**: Complete — shipped as commit abc123';
    assert.equal(parseStatus(md), 'Complete — shipped as commit abc123');
  });
});

// ── isComplete ────────────────────────────────────────────────────────────

describe('archive-completed-plans / isComplete', () => {
  it('matches "Complete" prefix', () => {
    assert.equal(isComplete('Complete'), true);
    assert.equal(isComplete('Complete (v1)'), true);
    assert.equal(isComplete('Complete — shipped as commit abc'), true);
  });

  it('rejects non-Complete statuses', () => {
    assert.equal(isComplete('Draft'), false);
    assert.equal(isComplete('Approved-with-known-debt'), false);
    assert.equal(isComplete('In Progress'), false);
    assert.equal(isComplete(null), false);
    assert.equal(isComplete(''), false);
  });

  it('is case-insensitive', () => {
    assert.equal(isComplete('complete'), true);
    assert.equal(isComplete('COMPLETE'), true);
  });
});

// ── findAuditSummariesFor ────────────────────────────────────────────────

describe('archive-completed-plans / findAuditSummariesFor', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('finds bare audit-summary file', () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.md'), 'plan');
    fs.writeFileSync(path.join(tmpDir, 'foo-audit-summary.md'), 'summary');
    fs.writeFileSync(path.join(tmpDir, 'bar.md'), 'unrelated');
    const out = findAuditSummariesFor('foo.md', tmpDir);
    assert.deepEqual(out, ['foo-audit-summary.md']);
  });

  it('finds round-numbered audit summaries', () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.md'), 'plan');
    fs.writeFileSync(path.join(tmpDir, 'foo-r3-audit-summary.md'), 'summary');
    const out = findAuditSummariesFor('foo.md', tmpDir);
    assert.deepEqual(out, ['foo-r3-audit-summary.md']);
  });

  it('returns empty when no siblings', () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.md'), 'plan');
    assert.deepEqual(findAuditSummariesFor('foo.md', tmpDir), []);
  });

  it('does not match unrelated plans', () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.md'), 'plan');
    fs.writeFileSync(path.join(tmpDir, 'foobar-audit-summary.md'), 'unrelated');
    assert.deepEqual(findAuditSummariesFor('foo.md', tmpDir), []);
  });
});

// ── runArchive (integration) ──────────────────────────────────────────────

describe('archive-completed-plans / runArchive', () => {
  let tmpDir;
  let plansDir;
  let completedDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-int-'));
    plansDir = path.join(tmpDir, 'plans');
    completedDir = path.join(tmpDir, 'completed');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.mkdirSync(completedDir, { recursive: true });
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('moves completed plans + audit summaries; leaves drafts in place', () => {
    fs.writeFileSync(path.join(plansDir, 'done.md'),
      '# Plan\n\n- **Status**: Complete (v1)\n');
    fs.writeFileSync(path.join(plansDir, 'done-audit-summary.md'), 'summary');
    fs.writeFileSync(path.join(plansDir, 'wip.md'),
      '# Plan\n\n- **Status**: Draft\n');

    const r = runArchive({ plansDir, completedDir });

    assert.equal(r.errors.length, 0);
    assert.equal(r.moved.length, 2, `moved: ${JSON.stringify(r.moved)}`);
    assert.equal(fs.existsSync(path.join(completedDir, 'done.md')), true);
    assert.equal(fs.existsSync(path.join(completedDir, 'done-audit-summary.md')), true);
    assert.equal(fs.existsSync(path.join(plansDir, 'wip.md')), true, 'draft must stay');
    assert.equal(fs.existsSync(path.join(plansDir, 'done.md')), false, 'completed must be moved out');
  });

  it('is idempotent — second run is a no-op', () => {
    fs.writeFileSync(path.join(plansDir, 'a.md'), '- **Status**: Complete\n');
    runArchive({ plansDir, completedDir });
    const r2 = runArchive({ plansDir, completedDir });
    assert.equal(r2.moved.length, 0);
    assert.equal(r2.errors.length, 0);
  });

  it('refuses to overwrite existing destination without --force', () => {
    fs.writeFileSync(path.join(plansDir, 'a.md'), '- **Status**: Complete\n');
    fs.writeFileSync(path.join(completedDir, 'a.md'), 'existing different content');
    const r = runArchive({ plansDir, completedDir });
    assert.equal(r.moved.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /destination exists/);
    // Source still in plans/, untouched.
    assert.equal(fs.existsSync(path.join(plansDir, 'a.md')), true);
  });

  it('overwrites destination with --force', () => {
    fs.writeFileSync(path.join(plansDir, 'a.md'), '- **Status**: Complete\nnew');
    fs.writeFileSync(path.join(completedDir, 'a.md'), 'old');
    const r = runArchive({ plansDir, completedDir, force: true });
    assert.equal(r.moved.length, 1);
    assert.equal(fs.readFileSync(path.join(completedDir, 'a.md'), 'utf-8').includes('new'), true);
  });

  it('--dry-run does not move files', () => {
    fs.writeFileSync(path.join(plansDir, 'a.md'), '- **Status**: Complete\n');
    const r = runArchive({ plansDir, completedDir, dryRun: true });
    assert.equal(r.moved.length, 1);
    assert.equal(r.moved[0].dryRun, true);
    assert.equal(fs.existsSync(path.join(plansDir, 'a.md')), true, 'file must NOT have been moved');
    assert.equal(fs.existsSync(path.join(completedDir, 'a.md')), false);
  });

  it('skips plans with no Status line', () => {
    fs.writeFileSync(path.join(plansDir, 'a.md'), '# Plan\n\nNo metadata\n');
    const r = runArchive({ plansDir, completedDir });
    assert.equal(r.moved.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /no Status line/);
  });

  it('returns empty summary when plansDir does not exist', () => {
    const r = runArchive({ plansDir: '/totally/made/up/path', completedDir });
    assert.deepEqual(r, { moved: [], skipped: [], errors: [] });
  });
});
