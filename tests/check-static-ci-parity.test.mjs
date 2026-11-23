/**
 * @fileoverview Keeps the CI static-gates job honest: every gate in `check:static` is either run by `check:static:ci`
 * or declared, with a reason, in `.ci-static-local-only.json`. Without this a new gate added to `check:static` would
 * silently not run in CI (a green that checked nothing), and a stale local-only entry would hide a gate that was removed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts;
const localOnly = JSON.parse(fs.readFileSync(path.join(REPO, '.ci-static-local-only.json'), 'utf8')).localOnly;

/** Gate names of a plain `npm run a && npm run b` chain; throws on any other shape. */
function gatesOf(chain) {
  return chain.split('&&').map((s) => {
    const m = /^\s*npm run ([^\s]+)\s*$/.exec(s);
    assert.ok(m, `not a plain "npm run <name>" step: ${s}`);
    return m[1];
  });
}

describe('check:static:ci parity', () => {
  const all = gatesOf(scripts['check:static']);
  const ci = gatesOf(scripts['check:static:ci']);
  const local = Object.keys(localOnly);

  it('every check:static gate is run by CI or declared local-only, never both, never neither', () => {
    for (const g of all) assert.ok(ci.includes(g) !== local.includes(g), `${g}: must be in exactly one of check:static:ci / .ci-static-local-only.json`);
  });
  it('CI runs nothing that check:static does not, and local-only has no stale entries', () => {
    for (const g of ci) assert.ok(all.includes(g), `${g} is in check:static:ci but not check:static`);
    for (const g of local) assert.ok(all.includes(g), `${g} is local-only but not in check:static (stale entry)`);
  });
  it('every local-only entry carries a reason, an owner and the run point it protects', () => {
    for (const g of local) for (const k of ['reason', 'owner', 'runPoint']) {
      assert.ok(typeof localOnly[g]?.[k] === 'string' && localOnly[g][k].trim().length > 10, `${g} needs a non-empty ${k}`);
    }
  });
  it('the workflow runs both this parity test and check:static:ci', () => {
    const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'static-gates.yml'), 'utf8');
    assert.match(wf, /^\s*npm run check:static:ci\s*$/m, 'static-gates.yml must run `npm run check:static:ci`');
    assert.match(wf, /node --test tests\/check-static-ci-parity\.test\.mjs/, 'static-gates.yml must run the parity test');
  });
  it('push runs never share a concurrency group (a group keeps one pending run, so a push range would go unchecked)', () => {
    const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'static-gates.yml'), 'utf8');
    assert.match(wf, /group: static-gates-\$\{\{ github\.event_name == 'pull_request' && github\.ref \|\| github\.run_id \}\}/);
    assert.match(wf, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  });
  it('the job has the stable name static-gates and no path filter (a required check skipped on some PRs disappears silently)', () => {
    const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'static-gates.yml'), 'utf8');
    assert.match(wf, /^ {2}static-gates:\s*\r?\n {4}name: static-gates\s*$/m);
    assert.doesNotMatch(wf, /^\s*paths(-ignore)?:/m);
    assert.doesNotMatch(wf, /^\s*branches-ignore:/m);
  });
});
