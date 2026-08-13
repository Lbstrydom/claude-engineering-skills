/**
 * Tier-1 test: a plan citing a path SUFFIX must resolve to the real repo file,
 * not be classified missing.
 *
 * **The defect this pins** (measured 2026-08-13, one consumer plan): a plan
 * that writes `zone/zoneChat.js` for `src/services/zone/zoneChat.js` produced
 * three compounding failures, because `extractPlanPaths` tested only
 * `fs.existsSync(path.resolve(p))`:
 *   1. the path was reported `missing` (18 of 25 such paths were resolvable),
 *   2. it was therefore excluded from `found` — so 8 existing, plan-referenced
 *      files were NEVER READ by the audit, silently, and
 *   3. it was announced to the model as `**Missing:** …`, which the structure
 *      pass faithfully reported as a HIGH "planned file absent" finding.
 * `finding-verification.mjs` already refuted (3) at the output layer using a
 * unique-suffix match; nothing fixed (1) or (2). Both sides now call the one
 * oracle, `resolveUniqueSuffix`.
 *
 * The negative controls are the point of this file: ambiguity and true absence
 * must STILL be missing. A fix that resolves everything would trade a false
 * "missing" for a false "found", which is the worse direction — it manufactures
 * coverage that never happened.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractPlanPaths } from '../scripts/lib/plan-paths.mjs';

/** Inventory fixture — none of these exist under the test runner's cwd, so
 *  every citation below necessarily goes down the suffix-resolution path. */
const INVENTORY = [
  'src/services/zone/zoneChat.js',
  'src/services/zone/zoneMetadata.js',
  'src/config/grapeColourMap.js',
  'src/routes/cellarZoneLayout.js',
  'src/routes/index.js',
  'public/js/api/index.js',
];

const opts = (extra = {}) => ({ repoFiles: INVENTORY, ...extra });

describe('extractPlanPaths — suffix resolution against the repo inventory', () => {
  it('resolves a uniquely-suffixed cited path to its real repo path', () => {
    const plan = 'Update `zone/zoneChat.js` to add the handler.';
    const { found, missing } = extractPlanPaths(plan, opts());

    assert.deepEqual(missing, [], 'a resolvable path must not be reported missing');
    assert.ok(
      found.includes('src/services/zone/zoneChat.js'),
      `found must carry the REAL path (so the audit reads it); got ${JSON.stringify(found)}`,
    );
  });

  it('reports what it remapped, so the normalisation is not silent', () => {
    const plan = 'Update `zone/zoneChat.js` and `config/grapeColourMap.js`.';
    const { suffixResolved } = extractPlanPaths(plan, opts());

    assert.equal(suffixResolved.length, 2);
    assert.deepEqual(
      suffixResolved.find((r) => r.cited === 'zone/zoneChat.js'),
      { cited: 'zone/zoneChat.js', resolved: 'src/services/zone/zoneChat.js' },
    );
  });

  it('NEGATIVE CONTROL: an ambiguous suffix stays missing — never guessed', () => {
    const plan = 'Update `api/index.js`.';
    const { found, missing } = extractPlanPaths(plan, opts({
      repoFiles: [...INVENTORY, 'src/routes/api/index.js'], // now two `/api/index.js`
    }));

    assert.deepEqual(missing, ['api/index.js'], 'two candidates prove nothing about which was meant');
    assert.equal(found.length, 0);
  });

  it('NEGATIVE CONTROL: a genuinely absent path stays missing', () => {
    const plan = 'Create `zone/rowAllocationSolver.js` and `config/cellarZones.js`.';
    const { found, missing } = extractPlanPaths(plan, opts());

    assert.deepEqual(missing.sort(), ['config/cellarZones.js', 'zone/rowAllocationSolver.js']);
    assert.equal(found.length, 0, 'a fix that finds these would manufacture coverage');
  });

  it('NEGATIVE CONTROL: matching is segment-boundary — `oneChat.js` is not `zoneChat.js`', () => {
    const plan = 'Update `oneChat.js` please.';
    const { found } = extractPlanPaths(plan, opts());

    assert.equal(found.length, 0, 'a bare substring match would resolve the wrong file');
  });

  it('a resolved path still obeys the infra-file exclusion (no scope widening)', () => {
    // `lib/schemas.mjs` resolves by suffix to this tool's OWN control-plane
    // file. The infra guard exists so a consumer audit never treats the audit
    // tool as its subject; resolution must not become a way around it.
    const plan = 'Touch `lib/schemas.mjs` for the new field.';
    const inv = ['scripts/lib/schemas.mjs'];

    const off = extractPlanPaths(plan, { repoFiles: inv });
    assert.equal(off.found.length, 0, 'infra file must not be admitted by suffix resolution');

    const on = extractPlanPaths(plan, { repoFiles: inv, allowInfraFiles: true });
    assert.ok(on.found.includes('scripts/lib/schemas.mjs'), 'opt-in still admits it');
  });

  it('a suffix-resolvable path counts as resolvable for the fuzzy-discovery threshold', () => {
    // regexFoundCount gates Phase-2 fuzzy keyword discovery, which measurably
    // pulls in unrelated files. Phantom-missing paths used to depress that
    // count and trigger fuzzy discovery spuriously.
    const plan = 'Update `zone/zoneChat.js`, `zone/zoneMetadata.js`, '
      + '`config/grapeColourMap.js`, `routes/cellarZoneLayout.js`, `routes/index.js`.';
    const { regexFoundCount, fuzzyAdded } = extractPlanPaths(plan, opts());

    assert.equal(regexFoundCount, 5, 'all five resolve by suffix');
    assert.equal(fuzzyAdded, 0, 'threshold met — fuzzy discovery must not fire');
  });
});
