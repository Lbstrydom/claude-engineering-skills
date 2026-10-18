/**
 * @fileoverview The proof-discipline rules live in prose a model follows, so nothing
 * type-checks them. Pin that each rule is still present where its reader looks.
 * Fleet proposals d597 (proof plan), 9df4 (pivot rule), 1326 (evidence status words).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('proof-discipline prose contracts', () => {
  it('chip preamble requires a PROOF PLAN before code, and evidence-backed status words', () => {
    const t = read('skills/fleet/references/chip-preamble.md');
    assert.match(t, /^PROOF PLAN\. Before any code, write ONE line/m);
    for (const kind of ['red test', 'source', 'repeatable calculation']) assert.ok(t.includes(kind), kind);
    assert.match(t, /^FINAL REPORT\..*against\s+your PROOF PLAN/ms);
    assert.match(t, /^STATUS WORDS\..*every mid-task note/ms);
    for (const artifact of ['commit sha', 'CI run id', 'test count']) assert.ok(t.includes(artifact), artifact);
  });

  it('coordination rule 17 makes a relay carry the artifact', () => {
    const t = read('skills/fleet/references/coordination.md');
    const rule = t.match(/^17\. \*\*Status words carry their artifact\.\*\*.*$/m);
    assert.ok(rule, 'rule 17 present');
    assert.match(rule[0], /unverified/);
    assert.match(read('skills/fleet/references/coordination-rationale.md'), /^## Rule 17 /m);
  });

  it('/plan asks for a proof oracle outside the frontend criteria', () => {
    const t = read('skills/plan/SKILL.md');
    assert.match(t, /\*\*Proof plan\*\* \(every scope\)/);
    assert.ok(t.includes('references/proof-oracle.md'));
    assert.ok(fs.existsSync(path.join(ROOT, 'skills/plan/references/proof-oracle.md')));
  });

  it('/audit-code pivots after 3 recurring rounds without moving the cap or stability test', () => {
    const t = read('skills/audit-code/SKILL.md');
    assert.match(t, /recurs 3 rounds running \| \*\*Pivot\*\*/);
    assert.ok(t.includes('references/pivot-rule.md'));
    assert.ok(t.includes('**Max 6 rounds for code audits.**'), 'cap unchanged');
    assert.match(t, /Threshold met, 0 new, 2\/2 stable \| \*\*CONVERGED\*\*/, 'convergence unchanged');
    const ref = read('skills/audit-code/references/pivot-rule.md');
    for (const must of ['2026-10-18', 'B3c', 'baseline-permissions']) assert.ok(ref.includes(must), must);
  });
});
