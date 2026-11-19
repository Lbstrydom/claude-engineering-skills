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

/** Every line of `text` that builds a `gh pr merge` argv for gh (the args after `gh`: 'pr', 'merge' adjacent); a PRINTED command ('gh', 'pr', ...) is data. */
export function mergeSites(text) {
  const out = [];
  text.split('\n').forEach((line, i) => { if (/['"]pr['"]\s*,\s*['"]merge['"]/.test(line) && !/['"]gh['"]\s*,\s*['"]pr['"]/.test(line)) out.push({ line: i + 1, text: line.trim() }); });
  return out;
}

/** The function name enclosing line `n` (the nearest preceding `function name(`). */
function enclosing(text, n) {
  const lines = text.split('\n');
  for (let i = n - 1; i >= 0; i -= 1) { const m = /^(?:export\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(lines[i]); if (m) return m[1]; }
  return null;
}

const files = () => fs.readdirSync(FLEET).filter((f) => f.endsWith('.mjs')).map((f) => path.join(FLEET, f));

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
    assert.ok(body.indexOf('assessCiFor(') < body.indexOf("'pr', 'merge'"), 'the oracle is asked before the merge argv is built');
    assert.ok(body.indexOf('decideCiAdmission(') < body.indexOf("'pr', 'merge'"), 'the mapper decides before the merge argv is built');
    assert.ok(/--match-head-commit', evidence\.head/.test(body), 'the pin is the evidence head, never a caller-supplied one');
    assert.ok(body.indexOf("disposition !== 'permit'") < body.indexOf("'pr', 'merge'") && /return \{ attempted: false/.test(body), 'a non-permit returns before the merge');
  });
  it('NEGATIVE CONTROL: a planted second merge site in a copy of a fleet module is found', () => {
    const planted = `${fs.readFileSync(path.join(FLEET, 'train-approve.mjs'), 'utf8')}\nexport function sneaky(deps) { return deps.gh(['pr', 'merge', '1', '--squash'], '.'); }\n`;
    assert.deepEqual(mergeSites(planted).map((s) => enclosing(planted, s.line)), ['sneaky']);
  });
  it('the plans and docs naming gh pr merge are not code: only .mjs under the fleet tree is censused, and train-approve only PRINTS the command', () => {
    const text = fs.readFileSync(path.join(FLEET, 'train-approve.mjs'), 'utf8');
    assert.ok(/command: \['gh', 'pr', 'merge'/.test(text), 'approve prints the argv as data');
    assert.equal(mergeSites(text).length, 0, "the printed plan uses 'gh' first, so it is not an execution site");
  });
});
