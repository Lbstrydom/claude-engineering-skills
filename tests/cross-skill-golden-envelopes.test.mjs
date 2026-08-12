/**
 * @fileoverview Golden-envelope behaviour preservation for the command-registry
 * migration (docs/plans/cross-skill-command-registry.md D6/§9).
 *
 * Replays the invocation table in
 * `scripts/dev/capture-cross-skill-envelopes.mjs` (the SAME runner that
 * captured the fixtures from the live LEGACY CLI — capture and replay cannot
 * drift apart) and compares {status, envelope} against
 * `tests/fixtures/cross-skill-envelopes.json`.
 *
 * Coverage model, stated honestly (audit R1-M1): this proves the
 * flag/payload/exit surface and the cloud-off envelope shape. It CANNOT
 * prove cloud-path behaviour — write handlers no-op before their store call
 * when cloud is off. That half lives in
 * tests/cross-skill-store-calls.test.mjs (recording stub store).
 *
 * ADDITIVE_FIELDS is the only escape hatch: a NEW field may appear in a
 * migrated command's envelope only if enumerated here — an unlisted new
 * field fails the test, so drift is deliberate or absent. Removals and
 * value changes are never allowed.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CASES, runCase, FIXTURE_PATH } from '../scripts/dev/capture-cross-skill-envelopes.mjs';

/** field-path → why it was added. Empty = byte-identical everywhere. */
const ADDITIVE_FIELDS = new Map([
  // (none yet — the trio migrated byte-identically)
]);

const fixtures = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

function stripAdditive(envelope, caseId, volatileFields = []) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const out = structuredClone(envelope);
  for (const fieldPath of ADDITIVE_FIELDS.keys()) {
    const [caseGlob, field] = fieldPath.split(':');
    if (caseGlob === '*' || caseGlob === caseId) delete out[field];
  }
  // Environment-derived fields (see `volatile` in the capture table): compared
  // for PRESENCE and TYPE, never for value. Dropping them entirely would let a
  // field silently disappear, which is the drift this suite exists to catch.
  // Dotted paths are supported because the volatile value is sometimes NESTED
  // — an ENOENT message carries the absolute temp path inside `error.message`.
  for (const field of volatileFields) {
    const parts = field.split('.');
    let node = out;
    for (let i = 0; i < parts.length - 1 && node; i += 1) node = node[parts[i]];
    const leaf = parts[parts.length - 1];
    if (node && typeof node === 'object' && leaf in node) {
      node[leaf] = `<volatile:${typeof node[leaf]}>`;
    }
  }
  return out;
}

describe('cross-skill golden envelopes — migrated commands match the legacy capture', () => {
  let tmpRoot;
  before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xskill-golden-')); });
  after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('every capture case has a fixture and vice versa (no silent shrinkage)', () => {
    const caseIds = CASES.map((c) => c.id).sort();
    const fixtureIds = Object.keys(fixtures.cases).sort();
    assert.deepEqual(caseIds, fixtureIds,
      'the invocation table and the fixture file must cover the same cases — '
      + 're-run scripts/dev/capture-cross-skill-envelopes.mjs after adding a case (BEFORE migrating its command)');
  });

  it('the ARGS are pinned too — a changed invocation cannot masquerade under an old envelope (audit CA-r6)', () => {
    // The fixture stores each case's args at capture time. Without this
    // assertion, editing CASES' args replays a DIFFERENT invocation against
    // the old expected envelope — and if it happens to produce the same
    // shape, the contract shifted silently.
    for (const c of CASES) {
      assert.deepEqual(c.args, fixtures.cases[c.id].args,
        `${c.id}: the invocation drifted from what the fixture was captured with — `
        + 'a changed invocation is a NEW case (new id), never an edit');
    }
  });

  for (const c of CASES) {
    it(`${c.id} — status + envelope match the legacy capture`, () => {
      const expected = fixtures.cases[c.id];
      const actual = runCase(c, { tmpRoot });
      assert.equal(actual.status, expected.status,
        `exit code drifted (stderr tail: ${actual.stderrSample})`);
      assert.deepEqual(
        stripAdditive(actual.envelope, c.id, c.volatile),
        stripAdditive(expected.envelope, c.id, c.volatile),
        'envelope drifted from the legacy capture',
      );
    });
  }
});
