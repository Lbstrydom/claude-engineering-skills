/**
 * The /ship close-out claims check is a named step, and the campaign close-out points at it
 * (docs/plans/test-campaign-controls.md §2.3, §7.4). Honest scope: this guards the step's
 * PRESENCE and wiring in the prose a model follows — not its execution, which no test can see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

test('/ship names Step 1.5 and routes it to its reference, the citation checker and /investigate', () => {
  const ship = read('skills/ship/SKILL.md');
  const step = ship.split(/^## Step 1\.5 — /m)[1]?.split(/^## /m)[0];
  assert.ok(step, '/ship SKILL.md has a "## Step 1.5 — " section');
  for (const needle of ['references/claims-check.md', 'check-doc-citations.mjs', '/investigate', 'measured', 'derived', 'expected']) {
    assert.ok(step.includes(needle), `Step 1.5 mentions ${needle}`);
  }
  assert.ok(ship.indexOf('## Step 1.5') > ship.indexOf('## Step 1 '), 'Step 1.5 follows Step 1');
  assert.ok(ship.indexOf('## Step 1.5') < ship.indexOf('## Step 2 '), 'Step 1.5 precedes Step 2');
});

test('the reference exists, its summary matches the SKILL.md index row, and it names the close-out command', () => {
  const ref = read('skills/ship/references/claims-check.md');
  const summary = ref.match(/^summary:\s*(.+)$/m)?.[1]?.trim();
  assert.ok(summary);
  assert.ok(read('skills/ship/SKILL.md').includes(`| \`references/claims-check.md\` | ${summary} |`));
  assert.ok(ref.includes('campaign-contract-check.mjs') && ref.includes('--closeout'));
});

test('campaign C12 points at the /ship claims check', () => {
  const c12 = read('skills/plan/references/campaign.md').split(/^### C12 — /m)[1];
  assert.ok(c12 && c12.includes('/ship') && c12.includes('Step 1.5'));
});
