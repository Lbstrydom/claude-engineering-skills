/**
 * @fileoverview The discovery-eval payload must not leak secrets to a provider.
 *
 * `model-eval-discovery.mjs` sends real repository file bodies to an external
 * model. Its protection is `readFilesAsContext` (audit-scope.mjs), which skips
 * sensitive paths and redacts each body by DEFAULT — an implicit guarantee the
 * call site depends on without restating.
 *
 * That implicitness has already cost two review cycles: /audit-code raised it
 * as a HIGH ("the PLAN is redacted; the CODE bodies are not") and it was
 * propagated into a follow-up task before anyone executed the helper. Both
 * readings were wrong. These tests pin the property so the third reader gets an
 * answer instead of a suspicion.
 *
 * Per AGENTS.md this is a Tier-3 seam — sensitive-path egress is one of the two
 * places where a silent regression ships credentials to a third party, so the
 * guarantee is asserted by EXECUTION, never by reading the source.
 *
 * Plan: docs/plans/debt-burndown-workstreams.md §7 WS-E2 (follow-up).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { readFilesAsContext } from '../scripts/lib/audit-scope.mjs';

const CANARY = 'sk-ant-api03-EGRESSCANARYVALUE1234567890';
let dir;
let rel;

before(() => {
  // Inside the repo: `readFilesAsContext` confines reads to the cwd boundary,
  // so an os.tmpdir() fixture would be rejected for the wrong reason and the
  // test would pass without exercising redaction.
  dir = fs.mkdtempSync(path.join(process.cwd(), '.audit', 'egress-fixture-'));
  rel = path.relative(process.cwd(), dir).split(path.sep).join('/');
  fs.writeFileSync(path.join(dir, 'normal.js'), `const key = "${CANARY}";\nexport default key;\n`);
  fs.writeFileSync(path.join(dir, '.env'), `SECRET=${CANARY}\n`);
  fs.writeFileSync(path.join(dir, 'credentials.json'), `{"token":"${CANARY}"}\n`);
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('discovery-eval payload egress', () => {
  it('redacts a secret inside an ORDINARY (non-sensitive) file body', () => {
    // The case the audit finding was really about: a normal path can still
    // contain a secret. Path filtering alone would not catch it.
    const out = readFilesAsContext([`${rel}/normal.js`], { maxPerFile: 8000, maxTotal: 100000 });
    assert.ok(!out.includes(CANARY), 'a secret in a normal file body must never reach the provider payload');
    assert.match(out, /REDACTED/, 'and the redaction must be visible, not a silent drop');
  });

  it('skips sensitive PATHS entirely', () => {
    const out = readFilesAsContext([`${rel}/.env`, `${rel}/credentials.json`], { maxPerFile: 8000, maxTotal: 100000 });
    assert.ok(!out.includes(CANARY), 'sensitive-path bodies must not be read into the payload at all');
  });

  it('uses the SAME defaults the discovery eval passes (no redact:false)', () => {
    // The eval calls readFilesAsContext(files, {maxPerFile, maxTotal}) — the
    // options it omits are exactly the ones that matter. Assert the default,
    // because a future `redact: false` would be a silent egress regression.
    const out = readFilesAsContext([`${rel}/normal.js`], { maxPerFile: 8000, maxTotal: 100000 });
    assert.ok(!out.includes(CANARY));
    const optedOut = readFilesAsContext([`${rel}/normal.js`], { maxPerFile: 8000, maxTotal: 100000, redact: false });
    assert.ok(optedOut.includes(CANARY),
      'precondition: redact:false DOES leak — proving the previous assertion tested redaction, not an unrelated filter');
  });

  it('redacts BEFORE truncating (a cut must not orphan a secret fragment)', () => {
    // Truncating first would leave an un-matchable prefix of the secret in the
    // retained text — redacted by nothing, and no longer recognisable.
    const long = path.join(dir, 'long.js');
    fs.writeFileSync(long, `${'x'.repeat(200)}const k = "${CANARY}";\n${'y'.repeat(5000)}\n`);
    const out = readFilesAsContext([`${rel}/long.js`], { maxPerFile: 260, maxTotal: 100000 });
    assert.ok(!out.includes(CANARY), 'full secret must not survive');
    assert.ok(!out.includes('EGRESSCANARYVALUE'), 'nor a recognisable fragment of it');
  });

  it('the eval call site does not opt out of redaction', () => {
    // Source-scan as a BACKSTOP to the behavioural tests above, not a
    // substitute: it catches a future edit that adds `redact: false` at the one
    // call site the behavioural tests cannot reach without a paid provider run.
    const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'model-eval-discovery.mjs'), 'utf-8');
    const call = src.match(/readFilesAsContext\([^)]*\)/s);
    assert.ok(call, 'the eval must still build its payload through readFilesAsContext');
    assert.doesNotMatch(call[0], /redact\s*:\s*false/, 'the discovery eval must never opt out of body redaction');
  });
});
