import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PROVENANCE_PATH = path.resolve('.audit', 'vendoring-provenance.json');
const SKILLS_DIR = path.resolve('skills');
const ALL_SKILLS = ['audit-loop', 'plan-backend', 'plan-frontend', 'ship', 'audit'];

describe('vendoring provenance', () => {
  it('provenance file exists', () => {
    assert.ok(fs.existsSync(PROVENANCE_PATH), `${PROVENANCE_PATH} must exist`);
  });

  it('provenance has entries for all 5 skills', () => {
    const provenance = JSON.parse(fs.readFileSync(PROVENANCE_PATH, 'utf-8'));
    for (const skill of ALL_SKILLS) {
      assert.ok(provenance[skill], `provenance must have entry for ${skill}`);
      assert.ok(provenance[skill].sha, `${skill} must have sha`);
      assert.ok(provenance[skill].vendoredAt, `${skill} must have vendoredAt`);
      assert.ok(provenance[skill].sourcePath, `${skill} must have sourcePath`);
    }
  });

  it('provenance SHAs are valid hex and audit-loop SHA matches current file', () => {
    const provenance = JSON.parse(fs.readFileSync(PROVENANCE_PATH, 'utf-8'));
    for (const skill of ALL_SKILLS) {
      const sha = provenance[skill].sha;
      assert.match(sha, /^[0-9a-f]{64}$/, `${skill} SHA must be 64-char hex`);

      // audit-loop was not edited post-vendoring, so its SHA must still match
      if (skill === 'audit-loop') {
        const content = fs.readFileSync(path.join(SKILLS_DIR, skill, 'SKILL.md'));
        const actual = crypto.createHash('sha256').update(content).digest('hex');
        assert.equal(actual, sha, 'audit-loop SHA must match (unedited since vendoring)');
      }
      // Other skills had Python profiles added — SHAs will differ from provenance.
      // Provenance records the ORIGINAL vendored SHA before edits.
    }
  });
});
