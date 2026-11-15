/**
 * @fileoverview Pins the capture-and-branch shape of `.github/workflows/model-freshness.yml`.
 *
 * The workflow runs the check with `set +e`, writes its exit code to `steps.freshness.outputs.status`, and later steps
 * branch on that value. That is deliberate (drift opens an issue rather than failing the job), but it has one hole: a
 * `status` that no branch handles, an empty one included, fires nothing and the job concludes success. A consumer
 * (storyline) lost five nights of a red check to that shape, with the jobs API reporting every step green. The
 * workflow's last step fails the job on any unhandled status; this test keeps that step and the value sets in step,
 * because a runtime guard can be skipped by a cancelled run and a static test cannot.
 *
 * Two-direction proof: every rule fires on a fixture that breaks it, and is quiet on the real workflow.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'model-freshness.yml');
const GUARD_NAME = 'Fail on an unhandled status';

const sorted = (s) => [...s].sort();

/** Every rule the workflow must satisfy; returns violation strings (empty = holds). */
function checkFreshnessWorkflow(doc) {
  const out = [];
  const steps = doc?.jobs?.freshness?.steps;
  if (!Array.isArray(steps)) return ['no jobs.freshness.steps'];

  for (const s of steps) if (Object.hasOwn(s, 'continue-on-error')) out.push(`continue-on-error on step "${s.name}"`);

  const capture = steps.find((s) => s.id === 'freshness');
  if (!capture) return [...out, 'no step with id "freshness"'];
  const written = new Set([...String(capture.run ?? '').matchAll(/status=([a-z_]+)/g)].map((m) => m[1]));
  if (written.size === 0) out.push('the freshness step writes no status values');

  const handled = new Set();
  for (const s of steps) {
    for (const m of String(s.if ?? '').matchAll(/steps\.freshness\.outputs\.status\s*==\s*'([a-z_]+)'/g)) handled.add(m[1]);
  }
  const unhandled = [...written].filter((v) => !handled.has(v));
  if (unhandled.length) out.push(`status value(s) written but never branched on: ${unhandled.join(', ')}`);

  const guard = steps.find((s) => s.name === GUARD_NAME);
  if (!guard) return [...out, `no "${GUARD_NAME}" step`];
  if (steps.indexOf(guard) !== steps.length - 1) out.push('the guard is not the last step');
  const cond = String(guard.if ?? '');
  if (!/^\s*always\(\)/.test(cond)) out.push('the guard condition does not start with always()');
  if (!cond.includes("steps.keys.outputs.skip != 'true'")) out.push('the guard does not exclude the no-keys skip');
  const listed = cond.match(/fromJSON\('(\[[^\]]*\])'\)/);
  if (!listed) out.push('the guard has no fromJSON membership list');
  else {
    const members = new Set(JSON.parse(listed[1]));
    if (JSON.stringify(sorted(members)) !== JSON.stringify(sorted(written))) {
      out.push(`guard list [${sorted(members)}] differs from written values [${sorted(written)}]`);
    }
  }
  if (!/!contains\(/.test(cond)) out.push('the guard does not negate its membership test');
  if (!/\bexit 1\b/.test(String(guard.run ?? ''))) out.push('the guard does not exit 1');
  return out;
}

const realText = fs.readFileSync(WORKFLOW, 'utf8');
const fresh = () => parse(realText);
const steps = (d) => d.jobs.freshness.steps;
const guardOf = (d) => steps(d).find((s) => s.name === GUARD_NAME);
const captureOf = (d) => steps(d).find((s) => s.id === 'freshness');

describe('model-freshness.yml capture-and-branch shape', () => {
  it('holds on the real workflow', () => {
    assert.deepEqual(checkFreshnessWorkflow(fresh()), []);
  });

  const breaks = {
    'the guard step is removed': (d) => { steps(d).splice(steps(d).indexOf(guardOf(d)), 1); },
    'the guard loses always()': (d) => { guardOf(d).if = guardOf(d).if.replace(/^always\(\) && /, ''); },
    'the guard stops excluding the skip': (d) => { guardOf(d).if = guardOf(d).if.replace("steps.keys.outputs.skip != 'true' && ", ''); },
    'the guard tests non-emptiness instead of membership': (d) => { guardOf(d).if = "always() && steps.keys.outputs.skip != 'true' && steps.freshness.outputs.status == ''"; },
    'the guard no longer exits 1': (d) => { guardOf(d).run = 'echo unhandled'; },
    'the guard is no longer last': (d) => { steps(d).push({ name: 'later', run: 'true' }); },
    'a new status value is written but never handled': (d) => { captureOf(d).run += '\n            9) echo "status=partial" >> "$GITHUB_OUTPUT" ;;'; },
    'a handled value is dropped from the guard list': (d) => { guardOf(d).if = guardOf(d).if.replace(',"error"', ''); },
    'a step gains continue-on-error': (d) => { captureOf(d)['continue-on-error'] = true; },
  };
  for (const [label, mutate] of Object.entries(breaks)) {
    it(`fires when ${label}`, () => {
      const d = fresh();
      mutate(d);
      assert.notDeepEqual(checkFreshnessWorkflow(d), [], `no violation reported when ${label}`);
    });
  }
});
