/**
 * @fileoverview `toShellExitCode` — forwarding a child's status must never turn a
 * failure into a zero low byte.
 *
 * A Windows exit code is 32 bits; MSYS bash's `$?` and Git for Windows' hook
 * reader keep only the low byte. Measured 2026-10-12 (Git 2.56.0.windows.2, bash
 * 5.3.15): `node -e "process.exit(256)"; echo $?` prints 0. A runner that
 * forwards a child's raw 256 therefore reads as a PASS one hop up
 * (docs/runbooks/prepush-sandbox.md §8).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { toShellExitCode } from '../scripts/lib/cli-io.mjs';
import { resolveGitBash } from './helpers/git-bash.mjs';

describe('toShellExitCode', () => {
  const cases = [
    [0, 0], [1, 1], [3, 3], [130, 130], [255, 255],
    // A zero low byte is the whole defect: each of these reads as success to bash/git.
    [256, 1], [512, 1], [2304, 1], [3840, 1],
    [257, 1], [259, 3],
    // spawnSync reports null for a signal death; nothing missing may read as a pass.
    [null, 1], [undefined, 1], [Number.NaN, 1], [1.5, 1], ['0', 1],
    [-1, 255],
  ];
  for (const [input, want] of cases) {
    it(`${String(input)} → ${want}`, () => assert.equal(toShellExitCode(input), want));
  }

  it('never returns 0 for anything but an exact 0', () => {
    for (let s = 1; s <= 70000; s += 1) assert.notEqual(toShellExitCode(s), 0, `status ${s}`);
  });
});

/**
 * Through the bash git runs hooks with — resolved beside `git --exec-path`, never a
 * bare `bash` (which can be WSL's), and with THIS node by absolute path (audit R1-M5).
 */
const BASH = resolveGitBash();
const NODE = process.execPath.replace(/\\/g, '/');
const skipShell = process.platform !== 'win32'
  ? 'the low-byte truncation is a Windows/MSYS property'
  : (!BASH && 'Git for Windows bash not found next to `git --exec-path`');

describe('through the real shell (Windows: the seam this exists for)', { skip: skipShell }, () => {
  /** Runs node with exit(code) under bash and returns bash's `$?` — or fails loudly. */
  function dollarQuestion(code) {
    const r = spawnSync(BASH, ['-c', `"${NODE}" -e "process.exit(${code})"; echo "rc=$?"`], { encoding: 'utf8' });
    assert.equal(r.error, undefined, `bash did not start: ${r.error?.message}`);
    assert.equal(r.status, 0, `the probe shell itself failed: status=${r.status} stderr=${r.stderr}`);
    const m = /^rc=(\d+)$/m.exec(r.stdout);
    assert.ok(m, `the probe printed no rc line — it did not run node: ${JSON.stringify(r.stdout)} ${r.stderr}`);
    return Number(m[1]);
  }

  it('the normalised failure of a raw 256 reads as exactly 1 in $? (audit R1-M6)', () => {
    assert.equal(dollarQuestion(toShellExitCode(256)), 1);
  });

  it('vacuous-pass guard: the probe can see a non-zero code at all', () => {
    assert.equal(dollarQuestion(3), 3);
  });

  it('characterises the raw truncation on this runtime (diagnostic, never a contract)', (t) => {
    const seen = dollarQuestion(256);
    t.diagnostic(`raw exit 256 reads as $?=${seen} under ${BASH} — ${seen === 0 ? 'TRUNCATING runtime (the defect is live here)' : 'non-truncating runtime'}`);
  });
});
