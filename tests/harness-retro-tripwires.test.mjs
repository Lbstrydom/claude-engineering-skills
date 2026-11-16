/**
 * Harness retro — memory tripwire promotion candidates (plan §2 c8). v1 only LISTS them;
 * retirement from MEMORY.md is a human edit (right-sizing gate, cut 3).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMemoryIndex, scanTripwires } from '../scripts/lib/friction/retro/memory-tripwires.mjs';
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
