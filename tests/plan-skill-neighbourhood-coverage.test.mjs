/**
 * @fileoverview /plan's empty-neighbourhood instruction must follow the CLI's own coverage rule (#412): an empty result over
 * unverified coverage is "absence of evidence", never "no near-duplicates, proceed". The SKILL.md is prose a model follows and
 * arch-render.mjs is the code that words the neighbourhood, so this pins the two together (the prose<->code seam rule).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const skill = fs.readFileSync(new URL('../skills/plan/SKILL.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const render = fs.readFileSync(new URL('../scripts/lib/arch-render.mjs', import.meta.url), 'utf8');

test('the code still treats non-verified coverage as absence of evidence (subject probe)', () => {
  assert.match(render, /coverage\?\.status !== 'verified'/);
  assert.match(render, /absence of evidence, not evidence of absence/);
});

test('/plan only says "No near-duplicates found — proceed" for VERIFIED coverage', () => {
  const lines = skill.split('\n').filter((l) => l.includes('No near-duplicates found'));
  assert.ok(lines.length >= 1, 'the instruction line must exist (vacuous-pass guard)');
  for (const l of lines) assert.match(l, /only if `coverage\.status:"verified"`/, `unconditional greenfield line: ${l}`);
});

test('/plan names the unverified-coverage branch', () => {
  assert.match(skill, /else absence of evidence/);
});
