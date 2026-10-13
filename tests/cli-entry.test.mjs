/**
 * @fileoverview scripts/lib/cli-entry.mjs — "started as the script?" on
 * canonical paths. The through-a-link regression on the real sync CLI is in
 * tests/sync-failure-accounting-e2e.test.mjs (H8).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isInvokedAsScript } from '../scripts/lib/cli-entry.mjs';

describe('isInvokedAsScript', () => {
  let tmp; let script; let other; let link;
  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-entry-')));
    fs.mkdirSync(path.join(tmp, 'real'));
    script = path.join(tmp, 'real', 'cli.mjs');
    other = path.join(tmp, 'real', 'other.mjs');
    fs.writeFileSync(script, '');
    fs.writeFileSync(other, '');
    link = path.join(tmp, 'link');
    fs.symlinkSync(path.join(tmp, 'real'), link, 'junction');
  });
  after(() => {
    fs.rmSync(link, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Node realpaths the main module, so import.meta.url is always the real path.
  const metaUrl = () => pathToFileURL(script).href;

  it('true for the direct path', () => {
    assert.equal(isInvokedAsScript(metaUrl(), script), true);
  });

  it('true when invoked through a symlink/junction (the defect: was false → main() skipped)', () => {
    assert.equal(isInvokedAsScript(metaUrl(), path.join(link, 'cli.mjs')), true);
  });

  it('false for a different script, direct or through the link', () => {
    assert.equal(isInvokedAsScript(metaUrl(), other), false);
    assert.equal(isInvokedAsScript(metaUrl(), path.join(link, 'other.mjs')), false);
  });

  it('false when there is no argv[1] (REPL / -e)', () => {
    assert.equal(isInvokedAsScript(metaUrl(), undefined), false);
    assert.equal(isInvokedAsScript(metaUrl(), ''), false);
  });

  it('falls back to the lexical comparison when canonicalisation fails', () => {
    const realpath = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
    assert.equal(isInvokedAsScript(metaUrl(), script, { realpath }), true);
    assert.equal(isInvokedAsScript(metaUrl(), other, { realpath }), false);
  });

  it('compares case-insensitively on win32 only', () => {
    const realpath = (p) => p;
    const up = script.toUpperCase();
    assert.equal(isInvokedAsScript(metaUrl(), up, { realpath, platform: 'win32' }), true);
    assert.equal(isInvokedAsScript(metaUrl(), up, { realpath, platform: 'linux' }), up === script);
  });
});
