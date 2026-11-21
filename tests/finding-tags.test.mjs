/**
 * @fileoverview Finding tags (importance / pre_existing / newly_reachable) - docs/plans/verification-lessons.md section 2.3.
 * Reader table, emitted-JSON-Schema contract, persisted leniency, the `countFindings` wiring, and a filesystem census of every
 * site that constructs or projects a finding's `is_quick_fix` flag.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { findingGateClass, gatesForCount, NON_LLM_FINDING_TAGS } from '../scripts/lib/finding-tags.mjs';
import {
  ProducerFindingSchema, ProducerFindingV2Schema, makeProducerFindingV3Schema, PersistedFindingSchema,
} from '../scripts/lib/schemas.mjs';
import { FinalReviewFindingSchema } from '../scripts/lib/final-review/output-schemas.mjs';
import { countFindings } from '../scripts/audit-loop.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAGS = ['importance', 'pre_existing', 'newly_reachable'];

const base = { severity: 'MEDIUM' };
const f = (o) => ({ ...base, ...o });

describe('findingGateClass - the only reader', () => {
  const rows = [
    ['legacy: no tags at all', f({}), true, 'importance-unstated'],
    ['importance null (persisted legacy)', f({ importance: null, pre_existing: false, newly_reachable: false }), true, 'importance-unstated'],
    ['important, pre_existing absent', f({ importance: 'important' }), true, 'pre-existing-unstated'],
    ['nit, pre_existing absent (half-stated never relaxes)', f({ importance: 'nit' }), true, 'pre-existing-unstated'],
    ['nit, newly_reachable absent: a half-stated nit gates (checked BEFORE the nit branch)', f({ importance: 'nit', pre_existing: false }), true, 'newly-reachable-unstated'],
    ['nit, newly_reachable null', f({ importance: 'nit', pre_existing: false, newly_reachable: null }), true, 'newly-reachable-unstated'],
    ['pre-existing, newly_reachable absent: half-stated gates', f({ importance: 'important', pre_existing: true }), true, 'newly-reachable-unstated'],
    ['important, in-diff', f({ importance: 'important', pre_existing: false, newly_reachable: false }), true, 'important'],
    ['nit, fully stated', f({ importance: 'nit', pre_existing: false, newly_reachable: false }), false, 'nit'],
    ['pre-existing, not reachable', f({ importance: 'important', pre_existing: true, newly_reachable: false }), false, 'pre-existing-not-reachable'],
    ['pre-existing AND newly reachable', f({ importance: 'important', pre_existing: true, newly_reachable: true }), true, 'pre-existing-newly-reachable'],
    ['contradiction: newly_reachable with pre_existing false', f({ importance: 'nit', pre_existing: false, newly_reachable: true }), true, 'tag-contradiction'],
    ['contradiction: nit with HIGH', { severity: 'HIGH', importance: 'nit', pre_existing: false, newly_reachable: false }, true, 'tag-contradiction'],
    ['nit + pre-existing + newly reachable: nit never gates', f({ importance: 'nit', pre_existing: true, newly_reachable: true }), false, 'nit'],
  ];
  for (const [name, finding, gates, reason] of rows) {
    it(name, () => assert.deepEqual(findingGateClass(finding), { gates, reason }));
  }
  it('null / undefined finding gates (unknown never relaxes)', () => {
    assert.equal(findingGateClass(null).gates, true);
    assert.equal(findingGateClass(undefined).gates, true);
  });
});

describe('gatesForCount - the mechanical scope outranks the model', () => {
  const full = (o) => ({ severity: 'MEDIUM', importance: 'important', pre_existing: false, newly_reachable: false, ...o });
  it('H18: an in-diff finding the model tagged pre_existing/not-reachable STILL gates, as tag-contradiction', () => {
    assert.deepEqual(gatesForCount(full({ pre_existing: true, newly_reachable: false }), { inDiff: true }), { gates: true, reason: 'tag-contradiction' });
  });
  it('negative control: the same tags WITHOUT the in-diff scope are excused (so the case above is not vacuous)', () => {
    assert.equal(gatesForCount(full({ pre_existing: true, newly_reachable: false }), { inDiff: false }).gates, false);
  });
  it('H18: a mechanically pre-existing finding with newly_reachable true now COUNTS', () => {
    assert.deepEqual(gatesForCount(full({ pre_existing: true, newly_reachable: true }), { inDiff: false }), { gates: true, reason: 'pre-existing-newly-reachable' });
  });
  it('negative control: mechanically pre-existing with newly_reachable false / absent does not count', () => {
    assert.equal(gatesForCount(full({ newly_reachable: false }), { inDiff: false }).gates, false);
    assert.equal(gatesForCount({ severity: 'HIGH' }, { inDiff: false }).gates, false);
  });
  it('in the diff: only a COMPLETE, non-HIGH nit is excused', () => {
    assert.equal(gatesForCount(full({ importance: 'nit' }), { inDiff: true }).gates, false);
    assert.equal(gatesForCount(full({ importance: 'nit', severity: 'HIGH' }), { inDiff: true }).gates, true);
    assert.equal(gatesForCount({ severity: 'LOW', importance: 'nit', pre_existing: false }, { inDiff: true }).gates, true);   // half-stated nit
    // audit R2 H2/M2: an in-diff NIT that claims pre_existing contradicts the mechanical scope - it gates, never excused as a nit
    const nitClaimsOld = gatesForCount(full({ importance: 'nit', pre_existing: true, newly_reachable: false }), { inDiff: true });
    assert.equal(nitClaimsOld.gates, true);
    assert.equal(nitClaimsOld.reason, 'tag-contradiction');
    assert.equal(gatesForCount({ severity: 'LOW' }, { inDiff: true }).gates, true);                                         // legacy
  });
  it('an in-diff important finding gates', () => assert.equal(gatesForCount(full({}), { inDiff: true }).gates, true));
});

describe('emitted JSON Schema - producers REQUIRE the tags', () => {
  const emitted = (schema) => z.toJSONSchema(schema, { io: 'input' });
  const required = (js) => new Set(js.required ?? []);
  const withTags = (js) => {
    for (const t of TAGS) assert.ok(js.properties?.[t], `property ${t} missing`);
    for (const t of TAGS) assert.ok(required(js).has(t), `${t} not required`);
  };
  it('ProducerFindingSchema', () => withTags(emitted(ProducerFindingSchema)));
  it('ProducerFindingV2Schema', () => withTags(emitted(ProducerFindingV2Schema)));
  it('both branches of makeProducerFindingV3Schema', () => {
    const js = emitted(makeProducerFindingV3Schema(['d1']));
    const branches = js.oneOf ?? js.anyOf;
    assert.equal(branches.length, 2);
    for (const b of branches) withTags(b);
  });
  it('FinalReviewFindingSchema (extends the producer)', () => withTags(emitted(FinalReviewFindingSchema)));
  it('the enum values and boolean types are exactly what the reader reads', () => {
    const js = emitted(ProducerFindingSchema);
    assert.deepEqual(js.properties.importance.enum, ['important', 'nit']);
    assert.equal(js.properties.pre_existing.type, 'boolean');
    assert.equal(js.properties.newly_reachable.type, 'boolean');
  });
  it('solo-control cold arm JSON_CONTRACT (prose) names every tag the extended schema requires', () => {
    const sc = fs.readFileSync(path.join(REPO, 'scripts/solo-control-audit.mjs'), 'utf8');
    for (const t of TAGS) assert.ok(sc.includes(`"${t}"`), `solo-control JSON_CONTRACT does not name ${t}`);
  });
});

describe('persisted parse is lenient and null-defaulting', () => {
  const legacy = {
    id: 'H1', severity: 'HIGH', category: 'c', section: 's', detail: 'd', risk: 'r', recommendation: 'x',
    is_quick_fix: false, is_mechanical: false, principle: 'p',
  };
  it('a legacy row parses and reads null, never nit', () => {
    const r = PersistedFindingSchema.parse(legacy);
    assert.equal(r.importance, null);
    assert.equal(r.pre_existing, null);
    assert.equal(r.newly_reachable, null);
    assert.equal(findingGateClass(r).gates, true);
  });
  it('a tagged row round-trips', () => {
    const r = PersistedFindingSchema.parse({ ...legacy, importance: 'nit', pre_existing: true, newly_reachable: false });
    assert.deepEqual([r.importance, r.pre_existing, r.newly_reachable], ['nit', true, false]);
  });
  it('the persisted JSON Schema does NOT require them', () => {
    const js = z.toJSONSchema(PersistedFindingSchema, { io: 'input' });
    for (const t of TAGS) assert.ok(!(js.required ?? []).includes(t), `${t} must not be required on the persisted schema`);
  });
});

describe('countFindings wiring (the mechanical scope outranks the tags)', () => {
  const tags = (o) => ({ importance: 'important', pre_existing: false, newly_reachable: false, ...o });
  it('legacy untagged findings count exactly as before', () => {
    const c = countFindings({ findings: [{ severity: 'HIGH' }, { severity: 'MEDIUM' }] });
    assert.deepEqual([c.high, c.medium, c.total], [1, 1, 2]);
  });
  it('a complete nit does not count', () => {
    assert.equal(countFindings({ findings: [{ severity: 'MEDIUM', ...tags({ importance: 'nit' }) }] }).medium, 0);
  });
  it('an in-diff finding the model calls pre-existing still counts (H18)', () => {
    assert.equal(countFindings({ findings: [{ severity: 'HIGH', ...tags({ pre_existing: true }) }] }).high, 1);
  });
  it('a mechanically pre-existing finding does not count, unless newly_reachable', () => {
    const c = countFindings({ findings: [
      { severity: 'HIGH', scope: 'pre-existing', ...tags({ pre_existing: true }) },
      { severity: 'HIGH', scope: 'pre-existing', ...tags({ pre_existing: true, newly_reachable: true }) },
    ] });
    assert.deepEqual([c.high, c.total], [1, 1]);
  });
  it('a contradiction still counts', () => {
    assert.equal(countFindings({ findings: [{ severity: 'HIGH', ...tags({ importance: 'nit' }) }] }).high, 1);
  });
});

describe('census - every site that builds or projects `is_quick_fix` handles the tags', () => {
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else if (p.endsWith('.mjs')) out.push(p);
    }
    return out;
  };
  const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);
  const siteCounts = () => {
    const out = new Map();
    for (const file of walk(path.join(REPO, 'scripts'))) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      const sites = lines.filter((l) => /\bis_quick_fix\s*:/.test(l) && !isComment(l)).length;
      if (sites > 0) {
        // A fill is a SPREAD of NON_LLM_FINDING_TAGS (never its import), or a literal stating all three tags on the line (audit R2 M4).
        const tagFills = lines.filter((l) => !isComment(l) && !/^\s*import\b/.test(l)
          && (/\.\.\.\s*NON_LLM_FINDING_TAGS\b/.test(l) || (/\bimportance\s*:/.test(l) && /\bpre_existing\s*:/.test(l) && /\bnewly_reachable\s*:/.test(l)))).length;
        out.set(path.relative(REPO, file).replaceAll('\\', '/'), { sites, tagFills });
      }
    }
    return out;
  };

  // fills: builds a whole finding   projection: copies a model finding's fields   exempt: not a finding (reason)
  const REGISTRY = {
    'scripts/lib/audit/adjacency-report.mjs': 'fills',
    'scripts/lib/audit/architecture-pass.mjs': 'fills',
    'scripts/lib/audit/duplication-report.mjs': 'fills',
    'scripts/lib/audit/event-wiring-pass.mjs': 'fills',
    'scripts/lib/audit/orphan-pass.mjs': 'fills',
    'scripts/lib/audit/run-notices.mjs': 'fills',
    'scripts/lib/linter.mjs': 'fills',
    'scripts/gemini-review.mjs': 'fills',
    'scripts/solo-control-audit.mjs': 'projection',
    'scripts/lib/robustness.mjs': 'projection',
    'scripts/lib/schemas.mjs': 'exempt: FindingBase declares is_quick_fix; the tags are deliberately NOT in FindingBase',
    'scripts/openai-audit.mjs': 'exempt: the rebuttal schema, not a finding',
    'scripts/lib/audit/legacy-production-audit.mjs': 'exempt: {...f, is_quick_fix:true} spread keeps every tag',
    // Persistence (store/runs-findings.mjs) writes `base.is_quick_fix = ...` with no tag column: NOT persisted; legacy reads null.
  };

  it('the registry and the filesystem agree in BOTH directions', () => {
    const found = siteCounts();
    const missing = [...found.keys()].filter((k) => !(k in REGISTRY));
    const stale = Object.keys(REGISTRY).filter((k) => !found.has(k));
    assert.deepEqual(missing, [], `unregistered is_quick_fix site(s): register each as fills/projection/exempt(reason)`);
    assert.deepEqual(stale, [], 'registry names a file with no is_quick_fix site');
  });

  it('every constructor and projection carries the tags at least once per site', () => {
    const found = siteCounts();
    for (const [file, kind] of Object.entries(REGISTRY)) {
      if (kind.startsWith('exempt')) continue;
      const { sites, tagFills } = found.get(file);
      assert.ok(tagFills >= sites, `${file}: ${sites} is_quick_fix site(s) but only ${tagFills} tag fill(s) - a constructor drops importance/pre_existing/newly_reachable`);
    }
  });

  it('the shared fill is conservative: important, in-diff, not newly-reachable', () => {
    assert.deepEqual({ ...NON_LLM_FINDING_TAGS }, { importance: 'important', pre_existing: false, newly_reachable: false });
    assert.equal(findingGateClass({ severity: 'LOW', ...NON_LLM_FINDING_TAGS }).gates, true);
  });

  it('a mechanical finding built by a real constructor passes the persisted AND producer-shaped contract', async () => {
    const { buildDetectorFailedFinding } = await import('../scripts/lib/audit/duplication-report.mjs');
    const built = buildDetectorFailedFinding('x');
    for (const t of TAGS) assert.ok(t in built, `${t} missing from the built finding`);
    assert.equal(findingGateClass(built).gates, true);
    assert.doesNotThrow(() => PersistedFindingSchema.parse(built));
  });
});

describe('output contract and capture wiring', () => {
  it('buildClassificationRubric asks for all three tags', async () => {
    const { buildClassificationRubric } = await import('../scripts/lib/prompt-seeds.mjs');
    const text = buildClassificationRubric({ sourceKind: 'MODEL', sourceName: 'm' });
    for (const t of TAGS) assert.ok(text.includes(`**${t}**`), `rubric does not ask for ${t}`);
  });
  it('finding-assembly captures the raw and post-verification stages, and not final-gate', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts/lib/audit/finding-assembly.mjs'), 'utf8');
    assert.match(src, /captureStageFindings\(\{ stage: 'raw'/);
    assert.match(src, /captureStageFindings\(\{ stage: 'post-verification'/);
    assert.doesNotMatch(src, /stage: 'final-gate'/);
  });
});

describe('all three count sites use gatesForCount, never the tags alone', () => {
  const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
  it('finding-assembly (verdict count + quickFix) and audit-loop (countFindings)', () => {
    const fa = read('scripts/lib/audit/finding-assembly.mjs');
    const al = read('scripts/audit-loop.mjs');
    assert.equal((fa.match(/gatesForCount\(f, \{ inDiff: isInDiff\(f\) \}\)/g) ?? []).length, 2);
    assert.equal((al.match(/gatesForCount\(f, \{ inDiff: isInDiff\(f\) \}\)/g) ?? []).length, 1);
    for (const src of [fa, al]) assert.doesNotMatch(src, /findingGateClass\(/);
  });
});
