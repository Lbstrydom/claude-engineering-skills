/**
 * @fileoverview The pre-push hook's success label (docs/plans/gate-cost-slice-2.md D8 and the audit's M1), run on the
 * SHIPPED bytes: the marked `tier-label` block is extracted from `.githooks/pre-push` and executed in bash against
 * crafted summary files. The label is what the checks REPORTED for the pushed head; anything missing, truncated,
 * malformed, duplicated or naming another commit is "tier NOT reported" and is never read as full or branch, so
 * nothing in the output can pass for a full verdict the merge recipe would trust.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveGitBash } from './helpers/git-bash.mjs';

const HOOK = fs.readFileSync(path.join(import.meta.dirname, '..', '.githooks', 'pre-push'), 'utf8').replace(/\r\n/g, '\n');
const BASH = resolveGitBash();
const skip = BASH ? false : 'Git for Windows bash not found next to `git --exec-path`';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const blocks = HOOK.match(/^# >>> tier-label\b[^\n]*\n[\s\S]*?^# <<< tier-label <<<$/gm) ?? [];

/** Run the shipped block with `summary` as the file's bytes (null: no file), and return TIER_LABEL. */
function label({ summary, sandbox = '1', pushHead = HEAD }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-label-'));
  dirs.push(dir);
  const file = path.join(dir, 'summary');
  if (summary !== null) fs.writeFileSync(file, summary);
  const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  const script = `${blocks[0]}\nprintf '%s' "$TIER_LABEL"\n`;
  const r = spawnSync(BASH, ['-c', script], {
    encoding: 'utf8', env: { ...process.env, TIER_SUMMARY_FILE: summary === null ? '' : posix(file), PUSH_HEAD: pushHead, AUDIT_PREPUSH_SANDBOX: sandbox },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const line = (tier, over = '') => `test-tier/v1 ${tier} ${HEAD} skipped=${tier === 'branch' ? 3 : 0} base=${BASE}${over}\n`;

describe('the shipped hook\'s tier label', { skip }, () => {
  it('the block exists exactly once in the shipped hook', () => assert.equal(blocks.length, 1));
  it('a valid full summary for the pushed head is labelled full', () => assert.equal(label({ summary: line('full') }), ' (full)'));
  it('a valid branch summary is labelled branch, with the count and plain NOT-the-full-suite wording', () => {
    assert.equal(label({ summary: line('branch') }), ' (branch tier: 3 heavy files skipped - NOT the full suite)');
  });
  it('a reason token and CRLF line endings are accepted', () => {
    assert.equal(label({ summary: line('full', ' reason=default').replace('\n', '\r\n') }), ' (full)');
  });
  it('the in-tree path (sandbox disabled) is labelled in-tree, never branch', () => assert.equal(label({ summary: null, sandbox: '0' }), ' (full, in-tree)'));

  describe('every defective summary is "tier NOT reported", never full or branch', () => {
    const cases = {
      'no summary file': [null, /no summary file/],
      'an empty file': ['', /no summary file/],
      'a blank line': ['\n', /no summary file|has 0 lines|malformed/],
      'a truncated line': [line('full').slice(0, 40), /malformed/],
      'a malformed line': [`${line('full').trim()} trailing junk\n`, /malformed/],
      'a bogus tier': [line('full').replace('full', 'both'), /malformed/],
      'two lines': [line('full') + line('branch'), /has 2 lines/],
      'another commit': [`test-tier/v1 full ${'c'.repeat(40)} skipped=0 base=${BASE}\n`, /another commit/],
      'a non-numeric count': [line('full').replace('skipped=0', 'skipped=x'), /malformed/],
    };
    for (const [name, [summary, why]] of Object.entries(cases)) {
      it(name, () => {
        const out = label({ summary });
        assert.match(out, /^ \(tier NOT reported: /, out);
        assert.match(out, why, out);
        assert.doesNotMatch(out, /\(full\)|branch tier/);
      });
    }
  });
});
