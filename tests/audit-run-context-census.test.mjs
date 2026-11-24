/**
 * Census: every key `runLegacyProductionAuditImpl` destructures from its ctx is either
 * returned by `buildAuditRunContext` or explicitly exempted with the reason.
 *
 * The class this pins (field report 5, item 1; fixed for one key by #488): #317 added
 * `auditIdentity` to the impl's destructure but not to the builder, so the writer read its
 * default (`null`) on every code audit for four weeks, silently. The builder's own comment
 * records an earlier instance of the reverse (`workingTreeDirty`). A per-key seam test only
 * guards the key someone remembered; this one is derived from the source, so a new key is
 * covered the day it is added.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAuditRunContext } from '../scripts/lib/audit/legacy-production-audit.mjs';

/** Keys the impl reads that `buildAuditRunContext` deliberately never sets: key -> who sets it instead. */
const EXEMPT = Object.freeze({
  noCloudRecording: 'observation-only runs set it on a ctx they build themselves (tiered-shadow-compare.mjs, verify-anchor-contract.mjs); the production CLI path must default it to false',
});

/** PURE. The names bound by `let { ... } = ctx;` inside runLegacyProductionAuditImpl. */
function impliedCtxKeys(src) {
  const at = src.indexOf('async function runLegacyProductionAuditImpl(ctx)');
  assert.ok(at > 0, 'runLegacyProductionAuditImpl not found: the census must not pass by finding nothing');
  const m = src.slice(at).match(/let \{([\s\S]*?)\} = ctx;/);
  assert.ok(m, 'the impl no longer destructures ctx with `let { ... } = ctx;`: update the census parser');
  return m[1].replace(/\/\/[^\n]*/g, '').split(',')
    .map((s) => s.trim().split(/\s*=/)[0].trim())
    .filter(Boolean);
}

describe('buildAuditRunContext returns every key the code writer reads', () => {
  const src = fs.readFileSync(new URL('../scripts/lib/audit/legacy-production-audit.mjs', import.meta.url), 'utf8');
  const keys = impliedCtxKeys(src);

  it('the parser finds the real destructure (vacuous-pass guard)', () => {
    assert.ok(keys.length > 20, `only ${keys.length} keys parsed`);
    for (const k of ['planContent', 'auditIdentity', 'workingTreeDirty', 'providers']) assert.ok(keys.includes(k), k);
  });

  it('every destructured key is returned by the builder or exempted with a reason', async () => {
    const ctx = await buildAuditRunContext({ openai: undefined, planContent: '# plan\n', changedFiles: [] });
    const missing = keys.filter((k) => !Object.hasOwn(ctx, k) && !Object.hasOwn(EXEMPT, k));
    assert.deepEqual(missing, [], `read by runLegacyProductionAuditImpl but never set by buildAuditRunContext: ${missing.join(', ')}`);
  });

  it('every exemption is still read by the impl and still absent from the builder (no stale exemptions)', async () => {
    const ctx = await buildAuditRunContext({ openai: undefined, planContent: '# plan\n', changedFiles: [] });
    for (const k of Object.keys(EXEMPT)) {
      assert.ok(keys.includes(k), `${k} is exempted but no longer read`);
      assert.ok(!Object.hasOwn(ctx, k), `${k} is exempted but the builder now returns it: drop the exemption`);
    }
  });

  it('NEGATIVE CONTROL: the pre-#488 shape (impl reads auditIdentity, builder omits it) is caught', () => {
    const builderKeysBefore = new Set(keys.filter((k) => k !== 'auditIdentity'));
    const missing = keys.filter((k) => !builderKeysBefore.has(k) && !Object.hasOwn(EXEMPT, k));
    assert.deepEqual(missing, ['auditIdentity']);
  });
});
