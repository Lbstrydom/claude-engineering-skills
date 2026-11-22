// efficacy:check is opt-in and a no-op without a config. That is legitimate only if it SAYS so: an unconfigured run
// must write NOT RUN on stderr (never read as a clean pass), and a malformed config must still fail loud.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'efficacy-lints-check.mjs');

function run(config) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'efficacy-cli-'));
  try {
    if (config !== undefined) fs.writeFileSync(path.join(cwd, 'efficacy-lints.config.json'), config);
    return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

describe('efficacy-lints-check CLI', () => {
  it('no config: exit 0 but says NOT RUN on stderr, nothing on stdout', () => {
    const r = run(undefined);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /efficacy-lints: NOT RUN/);
    assert.equal(r.stdout, '');
  });

  it('enabled:false: also NOT RUN', () => {
    const r = run(JSON.stringify({ enabled: false }));
    assert.equal(r.status, 0);
    assert.match(r.stderr, /NOT RUN/);
  });

  it('malformed config fails loud (exit 2), never a silent disable', () => {
    const r = run('{ not json');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /malformed JSON/);
  });

  it('enabled config prints a run summary and no NOT RUN line', () => {
    const r = run(JSON.stringify({ enabled: true }));
    assert.doesNotMatch(r.stderr, /NOT RUN/);
    assert.match(r.stdout, /efficacy-lints:/);
  });
});
