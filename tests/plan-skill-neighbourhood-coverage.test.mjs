/**
 * @fileoverview /plan's empty-neighbourhood instruction must follow the CLI's own coverage rule (#412): an empty result over
 * unverified coverage is "absence of evidence", never "no near-duplicates, proceed". The SKILL.md is prose a model follows and
 * arch-render.mjs is the code that words the neighbourhood, so this pins the two together (the prose<->code seam rule).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const skill = fs.readFileSync(new URL('../skills/plan/SKILL.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
import { renderNeighbourhoodCallout } from '../scripts/lib/arch-render.mjs';

const empty = (coverage) => renderNeighbourhoodCallout({
  records: [], targetPaths: ['scripts/lib/x.mjs'], totalCandidatesConsidered: 0, cloudStatus: 'ok', coverage,
}).markdown;

test('the renderer says greenfield ONLY for verified coverage, and absence-of-evidence otherwise (subject probe)', () => {
  assert.match(empty({ status: 'verified' }), /No near-duplicates found/);
  for (const c of [undefined, { status: 'unverified', reason: 'x' }, { status: 'unknown' }]) {
    const md = empty(c);
    assert.match(md, /absence of evidence, not evidence of absence/);
    assert.doesNotMatch(md, /No near-duplicates found/);
  }
});

test('/plan only says "No near-duplicates found — proceed" for VERIFIED coverage', () => {
  const lines = skill.split('\n').filter((l) => l.includes('No near-duplicates found'));
  assert.ok(lines.length >= 1, 'the instruction line must exist (vacuous-pass guard)');
  for (const l of lines) assert.match(l, /only if `coverage\.status:"verified"`/, `unconditional greenfield line: ${l}`);
});

test('/plan names the unverified-coverage branch', () => {
  assert.match(skill, /else absence of evidence/);
});
