/**
 * @fileoverview Source-level guards for the serial runner (docs/plans/ship-batch-member-outcomes.md §2.2, §2.3, §9 test 9).
 *
 *  - F1 is closed by STRUCTURE: the member step has no `stop` in scope. This test reads the function bodies and fails if one
 *    names `stop(`; its positive control proves the matcher fires on a body that does.
 *  - `--auto` is never sent: a census of the string literals in the files that build a `gh pr merge` argv. It reads LITERALS only
 *    (a flag assembled at runtime is invisible to it), and says so; the behavioural half is the recorded-argv tests.
 *
 * @module tests/fleet-serial-fault-census
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** The text of a top-level `function name(` block, by brace matching from its opening brace. */
function bodyOf(src, name) {
  const at = src.search(new RegExp(`^function ${name}\\(`, 'm'));
  if (at < 0) return null;
  let i = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(at, j + 1); }
  }
  return null;
}
/** Does a function body hold a call to `stop(` that is not a member of an identifier (so `unstoppable(` and `.stop(` pass)? */
const callsStop = (body) => /(^|[^\w.$])stop\s*\(/.test(body);
/** Every string literal that equals or contains `--auto` as an argument token. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const autoLiterals = (src) => [...stripComments(src).matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]).filter((t) => /(^|\s)--auto(\s|=|$)/.test(t));

const MEMBER_STEP_FUNCTIONS = ['stepMember', 'policyMerge', 'mergedObserved', 'readBackStep', 'treeIdentity'];

describe('the member step cannot stop the run (F1, by structure)', () => {
  const src = read('scripts/lib/fleet/serial.mjs');
  for (const name of MEMBER_STEP_FUNCTIONS) {
    it(`${name} has no stop( in its body`, () => {
      const body = bodyOf(src, name);
      assert.ok(body && body.length > 200, `${name} was not found by the matcher: the census would read nothing`);
      assert.equal(callsStop(body), false);
    });
  }
  it('positive control: the matcher fires on a body that stops, and not on lookalikes', () => {
    assert.equal(callsStop('function f(st) { if (x) return stop(i, "r"); }'), true);
    assert.equal(callsStop('function f(st) { st.stop(1); const unstoppable = 1; restop(); }'), false);
    assert.equal(bodyOf('function a() { return 1; }\nfunction b() { stop(1); }\n', 'b').includes('stop('), true);
  });
  it('the loop is the one place that defines stop', () => {
    const loopBody = bodyOf(src, 'loop');
    assert.match(loopBody, /const stop = /);
    assert.equal((src.match(/const stop = /g) ?? []).length, 1, 'exactly one definition of stop in the module');
  });
});

describe('--auto is never sent (literals census; stated limit: a flag built at runtime is invisible here)', () => {
  const FILES = ['scripts/lib/fleet/serial.mjs', 'scripts/lib/fleet/ship-batch.mjs', 'scripts/lib/fleet/rollup-land.mjs', 'scripts/lib/fleet/land.mjs'];
  for (const rel of FILES) {
    it(`${rel} has no --auto literal`, () => {
      assert.ok(fs.existsSync(path.join(root, rel)), `${rel} must exist for the census to mean anything`);
      assert.deepEqual(autoLiterals(read(rel)), []);
    });
  }
  it('positive control: the census finds --auto in the shapes a merge argv takes', () => {
    assert.equal(autoLiterals("const a = ['pr', 'merge', '--auto', '--squash'];").length, 1);
    assert.equal(autoLiterals('const a = "gh pr merge --auto --squash";').length, 1);
    assert.equal(autoLiterals("const a = ['--automatic', '--squash'];").length, 0);
    assert.equal(autoLiterals("/** never `--auto` */\n// also '--auto' here\nconst a = ['--squash'];").length, 0, 'prose in comments is not an argv');
  });
});
