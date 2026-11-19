import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

test('/audit-code Step 0 and the coordinator playbook both name the continue-the-SID form', () => {
  assert.match(read('skills/audit-code/SKILL.md'), /--round N\+1 --ledger/);
  assert.match(read('skills/fleet/references/coordinator-playbook.md'), /--round <N\+1> --ledger \.audit\/<SID>-ledger\.json/);
  assert.match(read('skills/fleet/references/coordinator-playbook.md'), /Do not start a new SID/);
});
