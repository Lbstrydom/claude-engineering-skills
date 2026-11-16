/**
 * Harness retro — memory tripwire promotion + non-destructive retirement (plan §2 c8, c13).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseMemoryIndex, scanTripwires, markEnforced, retireFromIndex, retireFromIndexText, retirementStatus, readFrontmatter,
} from '../scripts/lib/friction/retro/memory-tripwires.mjs';
import { buildIdf, tokenise } from '../scripts/lib/friction/retro/inventory.mjs';

const mem = (name, description, type = 'feedback') => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\nbody of ${name}\n`;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-mem-'));
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), [
    '# Index',
    '- [Hook path](feedback_hook_path.md) — hooks invoked by relative path fail',
    '- [Shared A](feedback_a.md). [Shared B](feedback_b.md) — two on one line',
    '- [Sub](index-consumers.md) — a sub-index, not a tripwire',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'feedback_hook_path.md'), mem('feedback_hook_path', 'hook arch-memory-check.sh relative path no such file directory'));
  fs.writeFileSync(path.join(dir, 'feedback_a.md'), mem('feedback_a', 'postgres numeric arrives as string'));
  fs.writeFileSync(path.join(dir, 'feedback_b.md'), mem('feedback_b', 'other thing entirely'));
  return dir;
}

describe('parseMemoryIndex', () => {
  it('yields each link, several per line, skipping sub-indexes', () => {
    const links = parseMemoryIndex('- [A](a.md). [B](b.md)\n- [I](index-x.md)');
    assert.deepEqual(links.map((l) => l.file), ['a.md', 'b.md']);
    assert.equal(links[1].lineNo, 0);
  });
});

describe('scanTripwires', () => {
  let dir; beforeEach(() => { dir = fixture(); });
  it('a tripwire whose failure fired in ≥2 sessions is a promotion candidate; others no-evidence', () => {
    const fingerprints = {
      '1111111111111111': { label: 'hook_non_blocking_error: bash: .claude/hooks/arch-memory-check.sh: No such file or directory' },
      '2222222222222222': { label: 'something unrelated happened in sed' },
    };
    const idf = buildIdf([...Object.values(fingerprints).map((f) => tokenise(f.label)), tokenise('x y z')]);
    const out = scanTripwires({
      memoryDir: dir, fingerprints, idf,
      sessionsByFingerprint: new Map([['1111111111111111', new Set(['s1', 's2'])]]),
      occurrencesByFingerprint: new Map([['1111111111111111', 5]]),
    });
    const hook = out.find((t) => t.memory === 'feedback_hook_path');
    assert.equal(hook.status, 'promotion-candidate');
    assert.equal(hook.identity, 'tripwire:feedback_hook_path');
    assert.equal(hook.firedSessions, 2);
    assert.equal(out.find((t) => t.memory === 'feedback_a').status, 'no-evidence');
    assert.ok(!out.some((t) => t.memory === 'index-consumers'));
  });
});

describe('retirement', () => {
  let dir; beforeEach(() => { dir = fixture(); });

  it('a sole-link line moves to index-enforced.md; the file is kept and marked', () => {
    const f = path.join(dir, 'feedback_hook_path.md');
    assert.equal(markEnforced(f, { identity: 'tripwire:feedback_hook_path', test: 'tests/x.test.mjs', date: '2026-11-16' }).changed, true);
    const r = retireFromIndex(dir, 'feedback_hook_path.md');
    assert.equal(r.moved, 1);
    const index = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    assert.ok(!index.includes('(feedback_hook_path.md)'));
    assert.ok(index.includes('(index-enforced.md)'));
    assert.ok(fs.readFileSync(path.join(dir, 'index-enforced.md'), 'utf8').includes('(feedback_hook_path.md)'));
    assert.ok(fs.existsSync(f));
    assert.equal(readFrontmatter(f).fm.metadata.enforced_by.identity, 'tripwire:feedback_hook_path');
    assert.deepEqual(retirementStatus(dir), []);
  });

  it('a shared line is NEVER edited — needs-manual-reflow is reported', () => {
    const before = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    markEnforced(path.join(dir, 'feedback_a.md'), { identity: 'tripwire:feedback_a', test: 't', date: 'd' });
    const r = retireFromIndex(dir, 'feedback_a.md');
    assert.equal(r.needsManualReflow, 1);
    const after = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    assert.ok(after.includes('- [Shared A](feedback_a.md). [Shared B](feedback_b.md) — two on one line'));
    assert.equal(after.split('\n').filter((l) => l.includes('feedback_b.md')).length, 1);
    assert.ok(before.length <= after.length);
    assert.deepEqual(retirementStatus(dir).map((p) => p.problem), ['needs-manual-reflow']);
  });

  it('is idempotent — a re-run after an interruption converges to the same state', () => {
    markEnforced(path.join(dir, 'feedback_hook_path.md'), { identity: 'i', test: 't', date: 'd' });
    retireFromIndex(dir, 'feedback_hook_path.md');
    const s1 = [fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), fs.readFileSync(path.join(dir, 'index-enforced.md'), 'utf8')];
    assert.equal(markEnforced(path.join(dir, 'feedback_hook_path.md'), { identity: 'i', test: 't', date: 'd' }).changed, false);
    const r2 = retireFromIndex(dir, 'feedback_hook_path.md');
    assert.equal(r2.alreadyRetired, true);
    assert.deepEqual([fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), fs.readFileSync(path.join(dir, 'index-enforced.md'), 'utf8')], s1);
  });

  it('status flags a frontmatter mark with the index line still present (interrupted after step 2)', () => {
    markEnforced(path.join(dir, 'feedback_hook_path.md'), { identity: 'i', test: 't', date: 'd' });
    fs.writeFileSync(path.join(dir, 'index-enforced.md'), '- [Hook path](feedback_hook_path.md)\n');
    assert.deepEqual(retirementStatus(dir).map((p) => p.problem), ['still-in-index']);
  });

  it('status catches an interruption BEFORE the enforced index was written (other direction)', () => {
    markEnforced(path.join(dir, 'feedback_hook_path.md'), { identity: 'i', test: 't', date: 'd' });
    assert.deepEqual(retirementStatus(dir).map((p) => p.problem).sort(), ['marked-but-not-in-enforced-index', 'still-in-index']);
  });

  it('an unreadable index is an error, never an empty index to overwrite', () => {
    const bad = path.join(dir, 'MEMORY.md');
    fs.rmSync(bad);
    fs.mkdirSync(bad);   // reading a directory as a file → EISDIR, not ENOENT
    assert.throws(() => retireFromIndex(dir, 'feedback_hook_path.md'), /EISDIR|illegal operation/i);
  });

  it('retireFromIndexText is pure and preserves unrelated lines exactly', () => {
    const r = retireFromIndexText({ index: 'a\n- [X](x.md) — hook\nb\n', enforcedIndex: '', file: 'x.md' });
    assert.ok(r.index.startsWith('a\nb\n'));
  });
});
