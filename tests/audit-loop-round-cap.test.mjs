/**
 * audit-loop.mjs startup policy for --max-rounds / --past-cap (docs/plans/audit-round-cap-structural-or-stop.md §2.1).
 * The refusals exit before any child audit is spawned; the accepted cases are killed at the Pre-flight banner,
 * which prints only after the cap check has passed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOP = path.join(ROOT, 'scripts', 'audit-loop.mjs');
const PLAN = 'docs/plans/audit-round-cap-structural-or-stop.md';
const REASON = 'the recurring cluster is removed by this fix, so one more round converges';

function run(args, { until = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LOOP, ...args], { cwd: ROOT, env: { ...process.env, CI: '1' }, windowsHide: true });
    let out = '';
    let killedEarly = false;
    const timer = setTimeout(() => child.kill(), 30_000);
    const onData = (d) => { out += d; if (until && until.test(out) && !killedEarly) { killedEarly = true; child.kill(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, killedEarly }); });
  });
}

describe('audit-loop --max-rounds / --past-cap startup policy', () => {
  it('--max-rounds omitted: no refusal (the default never needs an override)', async () => {
    for (const mode of ['code', 'plan']) {
      const r = await run([mode, PLAN], { until: /Pre-flight/ });
      assert.equal(r.killedEarly, true, `${mode}: ${r.out}`);
    }
  });

  it('an explicit value up to the soft cap is accepted', async () => {
    assert.equal((await run(['plan', PLAN, '--max-rounds', '3'], { until: /Pre-flight/ })).killedEarly, true);
    assert.equal((await run(['code', PLAN, '--max-rounds', '6'], { until: /Pre-flight/ })).killedEarly, true);
  });

  it('above the soft cap without --past-cap is refused at startup (exit 4)', async () => {
    const r = await run(['plan', PLAN, '--max-rounds', '5']);
    assert.equal(r.code, 4, r.out);
    assert.match(r.out, /PAST_CAP_REQUIRED/);
    assert.doesNotMatch(r.out, /Pre-flight/);
  });

  it('above the soft cap with a real reason is accepted', async () => {
    const r = await run(['code', PLAN, '--max-rounds', '8', '--past-cap', REASON], { until: /Pre-flight/ });
    assert.equal(r.killedEarly, true, r.out);
  });

  it('above the absolute cap is refused whatever the reason', async () => {
    const r = await run(['code', PLAN, '--max-rounds', '9', '--past-cap', REASON]);
    assert.equal(r.code, 4);
    assert.match(r.out, /ABSOLUTE_CAP/);
  });

  it('a malformed --max-rounds is refused, not coerced', async () => {
    for (const bad of ['3junk', '1.5', '0', 'x']) {
      const r = await run(['plan', PLAN, '--max-rounds', bad]);
      assert.equal(r.code, 1, `${bad}: ${r.out}`);
      assert.match(r.out, /--max-rounds must be a positive whole number/);
    }
  });

  it('--past-cap with a within-cap --max-rounds is refused as unneeded', async () => {
    const r = await run(['plan', PLAN, '--max-rounds', '2', '--past-cap', REASON]);
    assert.equal(r.code, 1);
    assert.match(r.out, /PAST_CAP_UNNEEDED/);
  });
});

describe('audit-loop stops on a capped child round', () => {
  it('source contract: a child exiting EXIT_CAPPED ends the loop with that code (no retry, no further rounds)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(LOOP, 'utf-8');
    // The loop cannot be driven to a child cap refusal without spending a real round-1 audit, so the wiring is pinned
    // at the source: the catch around the child inspects err.status, and the branch exits through finishAndExit.
    assert.match(src, /err\?\.status === EXIT_CAPPED[\s\S]{0,400}finishAndExit\(EXIT_CAPPED\)/);
  });
});
