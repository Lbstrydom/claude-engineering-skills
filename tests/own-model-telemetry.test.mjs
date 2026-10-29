/**
 * @fileoverview Own-model telemetry slice 1 — the pure halves
 * (docs/plans/own-model-telemetry-slice-1.md). The DB halves live in
 * own-model-telemetry-db.test.mjs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  ADJUDICATOR_KINDS, EVENT_ORIGINS, DISMISS_REASON_CLASSES, DIFF_CAPTURE_STATUSES, fixOrderFlag,
} from '../scripts/lib/adjudication-vocab.mjs';
import { buildFindingAdjudicationPatch, adjudicationEventRefusal } from '../scripts/lib/store/runs-findings.mjs';
import { prepareDiffArtifact } from '../scripts/lib/audit/diff-capture.mjs';
import { assertTrainingEligible } from '../scripts/lib/store/training-eligibility.mjs';
import { buildStage1PredictionEntries } from '../scripts/lib/audit/stage1-prediction-log.mjs';
import { resolveRevisionSha } from '../scripts/lib/audit/target-identity.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
// Later migrations may re-add a constraint (the adjudicator-kind CHECK was widened by 20261029120000): the LAST definition is live.
const MIGRATIONS = ['20261026120000_own_model_telemetry_slice1.sql', '20261029120000_audit_capture_v1.sql']
  .map((f) => fs.readFileSync(path.join(ROOT, 'supabase/migrations', f), 'utf8'));

/** The quoted values of the `IN (...)` list of a named CHECK constraint in the migration. */
function checkValues(constraint) {
  const re = new RegExp(`ADD\\s+CONSTRAINT\\s+${constraint}\\s+CHECK\\s*\\(([\\s\\S]*?)\\);`);
  const m = [...MIGRATIONS].reverse().map((sql) => sql.match(re)).find(Boolean);
  assert.ok(m, `constraint ${constraint} must exist in the migration`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('vocabularies agree with the migration CHECKs (both directions)', () => {
  for (const [name, constraint, list] of [
    ['ADJUDICATOR_KINDS', 'fae_adjudicator_kind_chk', ADJUDICATOR_KINDS],
    ['EVENT_ORIGINS', 'fae_event_origin_chk', EVENT_ORIGINS],
    ['DISMISS_REASON_CLASSES', 'afd_dismiss_class_chk', DISMISS_REASON_CLASSES],
    ['DIFF_CAPTURE_STATUSES', 'audit_runs_diff_capture_status_chk', DIFF_CAPTURE_STATUSES],
  ]) {
    it(`${name} === ${constraint}`, () => {
      assert.deepEqual([...checkValues(constraint)].sort(), [...list].sort());
    });
  }
});

describe('fixOrderFlag', () => {
  const t = (s) => `2026-10-26T00:00:${s}Z`;
  it('true when the fix is at or before the first decision', () => {
    assert.equal(fixOrderFlag({ fixRecordedAt: t('01'), firstDecidedAt: t('02') }), true);
    assert.equal(fixOrderFlag({ fixRecordedAt: t('02'), firstDecidedAt: t('02') }), true);
  });
  it('false when the fix came strictly after', () => {
    assert.equal(fixOrderFlag({ fixRecordedAt: t('03'), firstDecidedAt: t('02') }), false);
  });
  it('null (unknown, never coerced) while either side is unknown or unparseable', () => {
    assert.equal(fixOrderFlag({ fixRecordedAt: null, firstDecidedAt: t('02') }), null);
    assert.equal(fixOrderFlag({ fixRecordedAt: t('01'), firstDecidedAt: undefined }), null);
    assert.equal(fixOrderFlag({ fixRecordedAt: 'nope', firstDecidedAt: t('02') }), null);
    assert.equal(fixOrderFlag(), null);
  });
});

describe('buildFindingAdjudicationPatch', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  const created = '2026-10-26T11:59:58Z';
  const fresh = { decided_at: null, first_decided_at: null, remediation_state: null, fix_recorded_at: null, fixed_before_adjudication: null, created_at: created };

  it('without pre-state it is exactly the legacy patch (unmigrated store)', () => {
    assert.deepEqual(buildFindingAdjudicationPatch({ adjudicationOutcome: 'accepted' }, now),
      { adjudication_outcome: 'accepted', decided_at: now });
  });
  it('first decision stamps first_decided_at and time_to_resolution_ms', () => {
    const p = buildFindingAdjudicationPatch({ adjudicationOutcome: 'accepted' }, now, fresh);
    assert.equal(p.first_decided_at, now);
    assert.equal(p.time_to_resolution_ms, 2000);
    assert.equal('fixed_before_adjudication' in p, false, 'no fix known: the flag stays unwritten');
  });
  it('a decision that carries a terminal fix is "fixed before adjudication" (equal stamps)', () => {
    const p = buildFindingAdjudicationPatch({ adjudicationOutcome: 'accepted', remediationState: 'fixed' }, now, fresh);
    assert.equal(p.fix_recorded_at, now);
    assert.equal(p.fixed_before_adjudication, true);
  });
  it('a LEGACY row (already decided) never gets a first stamp or a flag', () => {
    const legacy = { ...fresh, decided_at: '2026-10-01T00:00:00Z', remediation_state: 'fixed' };
    const p = buildFindingAdjudicationPatch({ adjudicationOutcome: 'accepted', remediationState: 'fixed' }, now, legacy);
    assert.equal('first_decided_at' in p, false);
    assert.equal('fix_recorded_at' in p, false, 'the fix was already terminal: its time is unprovable');
    assert.equal('fixed_before_adjudication' in p, false);
  });
  it('a REGRESSED row (an earlier fix is implied) never gets a first-fix stamp', () => {
    const regressed = { ...fresh, remediation_state: 'regressed' };
    const p = buildFindingAdjudicationPatch({ adjudicationOutcome: 'accepted', remediationState: 'fixed' }, now, regressed);
    assert.equal('fix_recorded_at' in p, false);
    assert.equal('fixed_before_adjudication' in p, false);
  });
  it('an existing flag is immutable', () => {
    const decidedThenFixed = { ...fresh, decided_at: '2026-10-26T11:00:00Z', first_decided_at: '2026-10-26T11:00:00Z',
      remediation_state: 'fixed', fix_recorded_at: '2026-10-26T11:30:00Z', fixed_before_adjudication: false };
    const p = buildFindingAdjudicationPatch({ adjudicationOutcome: 'accepted', remediationState: 'fixed' }, now, decidedThenFixed);
    assert.equal('fixed_before_adjudication' in p, false);
  });
  it('only a dismissal carries the reason class', () => {
    assert.equal(buildFindingAdjudicationPatch({ adjudicationOutcome: 'accepted', dismissReasonClass: 'duplicate' }, now, fresh).dismiss_reason_class, undefined);
    assert.equal(buildFindingAdjudicationPatch({ adjudicationOutcome: 'dismissed', dismissReasonClass: 'duplicate' }, now, fresh).dismiss_reason_class, 'duplicate');
  });
  it('a negative interval (clock skew) is never written as a duration', () => {
    const p = buildFindingAdjudicationPatch({ adjudicationOutcome: 'accepted' }, now, { ...fresh, created_at: '2026-10-26T13:00:00Z' });
    assert.equal('time_to_resolution_ms' in p, false);
  });
});

describe('adjudicationEventRefusal', () => {
  it('requires a known adjudicator kind', () => {
    assert.match(adjudicationEventRefusal({ adjudicationOutcome: 'accepted' }), /adjudicatorKind/);
    assert.match(adjudicationEventRefusal({ adjudicatorKind: 'robot', adjudicationOutcome: 'accepted' }), /adjudicatorKind/);
    assert.equal(adjudicationEventRefusal({ adjudicatorKind: 'pipeline', adjudicationOutcome: 'accepted' }), null);
  });
  it('requires a vocabulary-valid class on a dismissal, and nowhere else', () => {
    assert.match(adjudicationEventRefusal({ adjudicatorKind: 'rule', adjudicationOutcome: 'dismissed' }), /dismissReasonClass/);
    assert.match(adjudicationEventRefusal({ adjudicatorKind: 'rule', adjudicationOutcome: 'dismissed', dismissReasonClass: 'meh' }), /dismissReasonClass/);
    assert.equal(adjudicationEventRefusal({ adjudicatorKind: 'rule', adjudicationOutcome: 'dismissed', dismissReasonClass: 'unclassified' }), null);
  });
});

describe('prepareDiffArtifact', () => {
  const sec = (file, body = '+x') => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n${body}\n`;

  it('not-applicable for no diff', () => {
    assert.equal(prepareDiffArtifact(null).status, 'not-applicable');
    assert.equal(prepareDiffArtifact('  ').status, 'not-applicable');
    assert.equal(prepareDiffArtifact('no headers here').status, 'not-applicable');
  });
  it('captures, content-addresses and is stable', () => {
    const a = prepareDiffArtifact(sec('src/a.js'));
    const b = prepareDiffArtifact(sec('src/a.js'));
    assert.equal(a.status, 'captured');
    assert.match(a.ref, /^[0-9a-f]{64}$/);
    assert.equal(a.ref, b.ref);
    assert.equal(a.bytes, Buffer.byteLength(a.text, 'utf8'));
    assert.equal(a.truncated, false);
  });
  it('drops sections for sensitive paths and keeps the rest', () => {
    const a = prepareDiffArtifact(sec('.env', '+API=1') + sec('src/ok.js'));
    assert.equal(a.status, 'captured');
    assert.ok(!a.text.includes('.env') && a.text.includes('src/ok.js'));
  });
  it('empty-after-filter when nothing survives the path filter', () => {
    assert.equal(prepareDiffArtifact(sec('.env', '+API=1')).status, 'empty-after-filter');
  });
  it('redacts a secret-shaped value and counts it', () => {
    const a = prepareDiffArtifact(sec('src/c.js', '+const token = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";'));
    if (a.status === 'captured') {
      assert.ok(!a.text.includes('sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD'), 'the raw secret must not be stored');
      assert.ok(a.redactions >= 1);
    } else {
      assert.equal(a.status, 'refused-secret', 'the only other fail-closed outcome');
    }
  });
  it('bounds at a section boundary; truncated is reported', () => {
    const big = sec('src/a.js', `+${'y'.repeat(400)}`) + sec('src/b.js', `+${'z'.repeat(400)}`);
    const a = prepareDiffArtifact(big, { maxBytes: 600 });
    assert.equal(a.status, 'captured');
    assert.equal(a.truncated, true);
    assert.ok(a.text.includes('src/a.js') && !a.text.includes('src/b.js'));
    assert.ok(a.bytes <= 600);
  });
  it('a first section over the cap is oversize-section, never a partial hunk', () => {
    assert.equal(prepareDiffArtifact(sec('src/a.js', `+${'y'.repeat(2000)}`), { maxBytes: 600 }).status, 'oversize-section');
  });
  it('accounts bytes in UTF-8, not characters', () => {
    const a = prepareDiffArtifact(sec('src/u.js', `+${'é'.repeat(300)}`), { maxBytes: 10_000 });
    assert.equal(a.bytes, Buffer.byteLength(a.text, 'utf8'));
    assert.ok(a.bytes > a.text.length);
  });
});

describe('assertTrainingEligible (default-deny)', () => {
  const rows = [
    { id: 'a', name: 'ces', training_eligible: true },
    { id: 'b', name: 'wine', training_eligible: null },
    { id: 'c', name: 'sto', training_eligible: false },
  ];
  it('passes only when every named repo is explicitly true', () => {
    assert.equal(assertTrainingEligible(['a'], rows).ok, true);
  });
  it('NULL (undecided) is refused, false is refused, an unknown id is refused', () => {
    const r = assertTrainingEligible(['a', 'b', 'c', 'zzz'], rows);
    assert.equal(r.ok, false);
    assert.deepEqual(r.refused.map((x) => [x.repoId, x.reason]), [['b', 'undecided'], ['c', 'ineligible'], ['zzz', 'unknown-repo']]);
  });
  it('a blank or null id beside valid ones fails the whole collection (no partial pass)', () => {
    for (const bad of [['a', ''], ['a', null], [undefined, 'a']]) {
      assert.equal(assertTrainingEligible(bad, rows).ok, false, JSON.stringify(bad));
    }
  });
  it('an export naming no repo has proven nothing and is refused', () => {
    assert.equal(assertTrainingEligible([], rows).ok, false);
    assert.equal(assertTrainingEligible([null, undefined], rows).ok, false);
  });
});

describe('buildStage1PredictionEntries', () => {
  const env = (i, outcome) => ({
    candidateId: `c${i}`, fingerprint: `fp${i}`,
    canonicalFinding: { severity: 'HIGH', category: 'x', _primaryFile: 'a.js' },
    stageDecisions: [{ stage: 'stage0' }, { stage: 'stage1', outcome, reasonCode: 'r' }],
  });
  it('one entry per envelope with a stage1 decision, sequence = input index', () => {
    const out = buildStage1PredictionEntries([env(0, 'escalated'), { candidateId: 'no-decision', stageDecisions: [] }, env(2, 'mechanical_dismissed')],
      { auditRunId: 'run1', round: 2, model: 'm' });
    assert.deepEqual(out.map((e) => e.sequence), [0, 2]);
    assert.equal(out[0].decisionType, 'stage1_prediction');
    assert.deepEqual(out[0].choice, { outcome: 'escalated', reasonCode: 'r', model: 'm' });
    assert.equal(out[0].context.fingerprint, 'fp0');
    assert.equal(out[0].auditRunId, 'run1');
  });
});

describe('resolveRevisionSha', () => {
  it('refuses an unsafe or absent revision without calling git with it', () => {
    assert.equal(resolveRevisionSha(ROOT, null), null);
    assert.equal(resolveRevisionSha(ROOT, '--upload-pack=evil'), null);
  });
  it('resolves HEAD to a full sha', () => {
    assert.match(resolveRevisionSha(ROOT, 'HEAD'), /^[0-9a-f]{40,64}$/);
  });
});

describe('static guards (a future writer or reader cannot slip past)', () => {
  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.claude-skills') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.mjs')) out.push(p);
    }
    return out;
  }
  const files = walk(path.join(ROOT, 'scripts'));
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

  it('every insert into finding_adjudication_events names its event_origin', () => {
    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      let i = 0;
      while ((i = src.indexOf("insertReturning('finding_adjudication_events'", i)) !== -1) {
        // The object literal is the next ~900 chars; the stamp may be spread in.
        const window = src.slice(i, i + 900);
        if (!/event_origin|CAMPAIGN_EVENT_DEFAULTS/.test(window)) offenders.push(`${rel(f)}@${i}`);
        i += 10;
      }
    }
    assert.deepEqual(offenders, [], 'a NULL-origin event is indistinguishable from legacy provenance');
  });

  it('only the writer and the eligibility module touch audit_run_diffs in SQL', () => {
    const allowed = new Set([
      'scripts/lib/store/run-diffs.mjs',
      'scripts/lib/store/training-eligibility.mjs',
    ]);
    const sql = /\b(?:FROM|JOIN|INTO|UPDATE)\s+audit_run_diffs\b/i;
    const readers = files.map(rel).filter((r) => sql.test(fs.readFileSync(path.join(ROOT, r), 'utf8')));
    assert.ok(readers.includes('scripts/lib/store/run-diffs.mjs'), 'the scan must see the writer, or it is vacuous');
    assert.deepEqual(readers.filter((r) => !allowed.has(r)), [],
      'a new reader of stored diff content must go through scripts/lib/store/training-eligibility.mjs');
  });
});

describe('closeFindingById requires a vocabulary class for a non-fix disposition', () => {
  it('refuses before any store access, for every missing or non-chosen value', async () => {
    const { closeFindingById } = await import('../scripts/lib/store/finding-disposition.mjs');
    for (const reasonClass of [null, undefined, '', 'made-up', 'unclassified']) {
      for (const disposition of ['dismissed', 'accepted-permanent']) {
        assert.deepEqual(
          await closeFindingById({ repoId: 'r', findingId: 'f', disposition, reason: 'because', reasonClass }),
          { ok: false, reason: 'reason-class-required' }, `${disposition} / ${JSON.stringify(reasonClass)}`);
      }
    }
  });
});

describe('scripts/training-eligibility.mjs argv (no store needed)', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/training-eligibility.mjs'), ...args],
    { encoding: 'utf8', env: { ...process.env, AUDIT_DB_URL: '', LEARNING_DISABLE: '1' } });

  it('accepts the documented flags: a bad VALUE is refused for its value, never as an unknown flag', () => {
    const r = run('set', '--repo', 'o/r', '--eligible', 'maybe', '--reason', 'x');
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--eligible must be true or false/);
    assert.doesNotMatch(r.stderr, /unknown flag/);
  });
  it('still refuses a genuinely unknown flag (negative control)', () => {
    const r = run('set', '--repo', 'o/r', '--bogus', '1');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag "--bogus"/);
  });
  it('an unknown subcommand is a usage error', () => {
    assert.equal(run('frobnicate').status, 2);
  });
});
