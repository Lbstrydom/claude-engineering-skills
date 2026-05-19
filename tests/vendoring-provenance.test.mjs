import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PROVENANCE_PATH = path.resolve('.audit', 'vendoring-provenance.json');
// audit-loop / plan-backend / plan-frontend deprecation shims were removed
// on 2026-05-19; `ship` is the remaining vendored skill with provenance.
const ALL_SKILLS = ['ship'];

// Provenance is a local, author-private artefact — gitignored since
// 2026-04-19. Skip the whole suite when the file is absent (fresh clone or
// CI without local author state). When present (authoring environment),
// enforce the invariants below.
const PROVENANCE_AVAILABLE = fs.existsSync(PROVENANCE_PATH);

describe('vendoring provenance', { skip: !PROVENANCE_AVAILABLE }, () => {
  it('provenance file exists', () => {
    assert.ok(fs.existsSync(PROVENANCE_PATH), `${PROVENANCE_PATH} must exist`);
  });

  it('provenance has an entry for each vendored skill', () => {
    const provenance = JSON.parse(fs.readFileSync(PROVENANCE_PATH, 'utf-8'));
    for (const skill of ALL_SKILLS) {
      assert.ok(provenance[skill], `provenance must have entry for ${skill}`);
      assert.ok(provenance[skill].sha, `${skill} must have sha`);
      assert.ok(provenance[skill].vendoredAt, `${skill} must have vendoredAt`);
      assert.ok(provenance[skill].sourcePath, `${skill} must have sourcePath`);
    }
  });

  it('provenance SHAs are valid 64-char hex', () => {
    const provenance = JSON.parse(fs.readFileSync(PROVENANCE_PATH, 'utf-8'));
    for (const skill of ALL_SKILLS) {
      assert.match(provenance[skill].sha, /^[0-9a-f]{64}$/, `${skill} SHA must be 64-char hex`);
      // Skills had Python profiles added post-vendoring — current SHAs differ
      // from provenance, which records the ORIGINAL vendored SHA.
    }
  });
});
