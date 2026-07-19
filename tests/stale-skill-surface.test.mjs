/**
 * @fileoverview Stale-skill-surface detector (`.github/skills` shadowing).
 *
 * WHY: Copilot Agent Skills reads both `.github/skills/` and `.claude/skills/`,
 * with `.github/skills/` winning on a name collision. `.github/skills/` is
 * deprecated here, so any surviving copy is older than the live one by
 * definition — and silently takes precedence.
 *
 * Found in the field 2026-07-19: a consumer carried an untracked 9-skill
 * `.github/skills/` tree shadowing 6 live skills, `persona-test` by 472 lines
 * and `ship` by 366. The `ship` shadow predated the cross-skill data loop, so
 * ship telemetry silently never recorded — reported as helper-path drift, which
 * was the wrong diagnosis entirely (the path rewriter works).
 *
 * The distinction these tests pin: a SHADOW blocks (a live skill is
 * unreachable), an ORPHAN is advisory (deprecated leftover intercepting
 * nothing). Collapsing the two would either cry wolf or go blind.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareSkillSurfaces,
  decideStaleSurfaceExit,
  STALE_SURFACE,
  LIVE_SURFACE,
} from '../scripts/check-stale-skill-surface.mjs';

/** Build a contentOf() over a {surface: {name: body}} fixture. */
const contentFrom = (map) => (surface, name) => map[surface]?.[name] ?? null;

describe('compareSkillSurfaces', () => {
  it('flags a skill present in BOTH surfaces as shadowed', () => {
    const r = compareSkillSurfaces({
      staleNames: ['ship'],
      liveNames: ['ship', 'plan'],
      contentOf: contentFrom({
        [STALE_SURFACE]: { ship: 'old\n'.repeat(10) },
        [LIVE_SURFACE]: { ship: 'new\n'.repeat(50) },
      }),
    });
    assert.equal(r.shadowed.length, 1);
    assert.equal(r.shadowed[0].name, 'ship');
    assert.equal(r.orphans.length, 0);
  });

  it('reports how far behind the shadowing copy is', () => {
    const r = compareSkillSurfaces({
      staleNames: ['persona-test'],
      liveNames: ['persona-test'],
      contentOf: contentFrom({
        [STALE_SURFACE]: { 'persona-test': 'x\n'.repeat(364) },
        [LIVE_SURFACE]: { 'persona-test': 'x\n'.repeat(836) },
      }),
    });
    const s = r.shadowed[0];
    assert.equal(s.staleLines, 365);
    assert.equal(s.liveLines, 837);
    assert.equal(s.lineDelta, 472, 'the drift magnitude is the operator-facing signal');
    assert.equal(s.identical, false);
  });

  it('classifies a stale-only skill as an orphan, not a shadow', () => {
    // plan-backend/plan-frontend were merged into `plan` upstream, so their
    // stale copies shadow nothing — real case from the field incident.
    const r = compareSkillSurfaces({
      staleNames: ['plan-backend', 'plan-frontend'],
      liveNames: ['plan'],
      contentOf: contentFrom({ [STALE_SURFACE]: { 'plan-backend': 'a', 'plan-frontend': 'b' } }),
    });
    assert.equal(r.shadowed.length, 0);
    assert.deepEqual(r.orphans, ['plan-backend', 'plan-frontend']);
  });

  it('still flags a byte-identical collision as shadowed', () => {
    // Identical today is not safe tomorrow: the live copy gets regenerated and
    // the stale one does not, so the collision is the hazard, not the drift.
    const body = 'same\n';
    const r = compareSkillSurfaces({
      staleNames: ['audit'],
      liveNames: ['audit'],
      contentOf: contentFrom({ [STALE_SURFACE]: { audit: body }, [LIVE_SURFACE]: { audit: body } }),
    });
    assert.equal(r.shadowed.length, 1);
    assert.equal(r.shadowed[0].identical, true);
  });

  it('reports nothing when the stale surface is absent', () => {
    const r = compareSkillSurfaces({ staleNames: [], liveNames: ['ship'], contentOf: () => null });
    assert.deepEqual(r, { shadowed: [], orphans: [], total: 0 });
  });

  it('handles a missing SKILL.md without throwing', () => {
    const r = compareSkillSurfaces({
      staleNames: ['broken'],
      liveNames: ['broken'],
      contentOf: () => null,
    });
    assert.equal(r.shadowed[0].staleLines, 0);
    assert.equal(r.shadowed[0].identical, false, 'two unreadable files are not "identical"');
  });
});

describe('decideStaleSurfaceExit', () => {
  it('blocks in gate mode when anything is shadowed', () => {
    assert.equal(decideStaleSurfaceExit({ gate: true, shadowedCount: 1 }), 1);
    assert.equal(decideStaleSurfaceExit({ gate: true, shadowedCount: 6 }), 1);
  });

  it('does not block in gate mode on orphans alone', () => {
    assert.equal(decideStaleSurfaceExit({ gate: true, shadowedCount: 0 }), 0);
  });

  it('never blocks outside gate mode — report-only stays report-only', () => {
    assert.equal(decideStaleSurfaceExit({ gate: false, shadowedCount: 9 }), 0);
  });
});
