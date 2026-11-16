/**
 * Harness retro — "check what already exists" inventory hints (plan §2 c7).
 * A hint for the judge, never a suppressor — so both directions are pinned.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHarnessInventory, tokenise, COVERAGE_FLOOR, chunkText, collectHarnessDocs } from '../scripts/lib/friction/retro/inventory.mjs';

describe('inventory', () => {
  const docs = [
    { surface: 'hook', ref: '.claude/hooks/bash-grep-nudge.mjs', text: 'Bash leading command is grep — use the Grep tool instead ripgrep' },
    { surface: 'memory', ref: 'feedback_x.md', text: 'unrelated note about postgres numeric strings' },
  ];
  const inv = buildHarnessInventory(docs);

  it('names the surface that already covers a candidate', () => {
    const hits = inv.coverageFor('PreToolUse:Bash hook error: Bash leading command is `grep` — use the Grep tool instead.');
    assert.equal(hits[0]?.ref, '.claude/hooks/bash-grep-nudge.mjs');
    assert.ok(hits[0].score >= COVERAGE_FLOOR);
  });

  it('returns nothing for an unrelated label (the direction it must NOT fire)', () => {
    assert.deepEqual(inv.coverageFor('sed: cannot read <path>: No such file or directory'), []);
  });

  it('tokenise drops stop words, short tokens and bare numbers', () => {
    assert.deepEqual([...tokenise('the error in 1234 xyz grep-nudge')].sort(), ['grep-nudge']);
  });
});

describe('chunking + error accounting', () => {
  it('splits a long document at headings and keeps the heading as the ref', () => {
    const chunks = chunkText('# A\n\nalpha text\n\n## B\n\nbeta text');
    assert.deepEqual(chunks.map((c) => c.heading), ['A', 'B']);
  });
  it('an unparseable package.json is reported, not silently treated as no gates', async () => {
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-inv-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
    const r = collectHarnessDocs({ repoRoot: dir });
    assert.deepEqual(r.errors, [{ path: 'package.json', code: 'EPARSE' }]);
    const empty = collectHarnessDocs({ repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'retro-inv-')) });
    assert.deepEqual(empty.errors, []);
  });
});
