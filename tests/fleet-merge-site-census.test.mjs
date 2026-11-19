/**
 * @fileoverview The merge-site CENSUS (docs/plans/ci-evidence-oracle.md section 2.3). A DISCOVERY guard, not the proof: the proof is
 * `mergeWithCiPermit`'s own rows in tests/fleet-ci-admission.test.mjs. This pins that `mergeWithCiPermit` holds the ONLY `gh pr merge`
 * argv under `scripts/lib/fleet/**`, so a new merge site fails here until it is routed through the one function. Negative control: a planted
 * second site in a copy of the tree is found.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FLEET = path.join(import.meta.dirname, '..', 'scripts', 'lib', 'fleet');

/**
 * Every `gh pr merge` ARGV in `text`: the string literals 'pr' and 'merge' adjacent, even across a line break. A PRINTED command ('gh', 'pr', ...)
 * is data, not an execution site. Returns the 1-based line of each match.
 */
export function mergeSites(text) {
  const out = [];
  const re = /['"]pr['"]\s*,\s*['"]merge['"]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    if (/\bcommand:\s*\[\s*['"]gh['"]\s*,\s*$/.test(before)) continue; // ONLY the approve plan's printed `command: ['gh', ...]` is data; any other 'gh' literal beside it is an exec argv
    out.push({ line: text.slice(0, m.index).split('\n').length, text: m[0] });
  }
  return out;
}

/** The function name enclosing line `n` (the nearest preceding `function name(`). */
function enclosing(text, n) {
  const lines = text.split('\n');
  for (let i = n - 1; i >= 0; i -= 1) { const m = /^(?:export\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(lines[i]); if (m) return m[1]; }
  return null;
}

/** Every .mjs under the fleet tree, recursively. */
function files(dir = FLEET) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.mjs') ? [path.join(dir, e.name)] : []));
}

describe('the merge-site census', () => {
  it('mergeWithCiPermit holds the ONLY gh pr merge argv under scripts/lib/fleet/**', () => {
    const found = [];
    for (const f of files()) {
      const text = fs.readFileSync(f, 'utf8');
      for (const s of mergeSites(text)) found.push({ file: path.basename(f), fn: enclosing(text, s.line), ...s });
    }
    assert.deepEqual(found.map((x) => [x.file, x.fn]), [['serial.mjs', 'mergeWithCiPermit']], JSON.stringify(found));
  });
  it('that site is preceded, in the same function, by the oracle and the mapper, and pins the EVIDENCE head', () => {
    const text = fs.readFileSync(path.join(FLEET, 'serial.mjs'), 'utf8');
    const start = text.indexOf('export function mergeWithCiPermit');
    const body = text.slice(start, text.indexOf('\n}\n', start));
    const at = (needle) => { const i = body.indexOf(needle); assert.ok(i >= 0, `mergeWithCiPermit no longer contains ${needle}`); return i; };
    assert.ok(at('assessCiFor(') < at("'pr', 'merge'"), 'the oracle is asked before the merge argv is built');
    assert.ok(at('decideCiAdmission(') < at("'pr', 'merge'"), 'the mapper decides before the merge argv is built');
    assert.ok(/--match-head-commit', evidence\.head/.test(body), 'the pin is the evidence head, never a caller-supplied one');
    assert.ok(at("disposition !== 'permit'") < at("'pr', 'merge'") && /return \{ attempted: false/.test(body), 'a non-permit returns before the merge');
  });
  it('NEGATIVE CONTROL: a planted second merge site in a copy of a fleet module is found', () => {
    const planted = `${fs.readFileSync(path.join(FLEET, 'train-approve.mjs'), 'utf8')}\nexport function sneaky(deps) { return deps.gh(['pr', 'merge', '1', '--squash'], '.'); }\n`;
    assert.deepEqual(mergeSites(planted).map((s) => enclosing(planted, s.line)), ['sneaky']);
  });
  it('NEGATIVE CONTROL: an exec of the gh binary by argv (spawnSync env gh pr merge) is NOT excused as printed data', () => {
    assert.equal(mergeSites("spawnSync('env', ['gh', 'pr', 'merge', '1'])").length, 1);
    assert.equal(mergeSites("{ command: ['gh', 'pr', 'merge', '1'] }").length, 0);
  });
  it('NEGATIVE CONTROLS: a site in a SUBDIRECTORY copy and a merge argv split across lines are both found; the walk is recursive', () => {
    const split = "deps.gh([\n  'pr',\n  'merge',\n  '1'])";
    assert.equal(mergeSites(split).length, 1);
    assert.ok(files().length >= 20, 'the walk reaches the fleet modules');
    const tmp = fs.mkdtempSync(path.join(import.meta.dirname, '.census-'));
    try { fs.mkdirSync(path.join(tmp, 'deep')); fs.writeFileSync(path.join(tmp, 'deep', 'x.mjs'), "export const f = (d) => d.gh(['pr', 'merge', '2']);\n"); assert.deepEqual(files(tmp).map((x) => path.basename(x)), ['x.mjs']); } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
  it('the plans and docs naming gh pr merge are not code: only .mjs under the fleet tree is censused, and train-approve only PRINTS the command', () => {
    const text = fs.readFileSync(path.join(FLEET, 'train-approve.mjs'), 'utf8');
    assert.ok(/command: \['gh', 'pr', 'merge'/.test(text), 'approve prints the argv as data');
    assert.equal(mergeSites(text).length, 0, "the printed plan uses 'gh' first, so it is not an execution site");
  });
});
