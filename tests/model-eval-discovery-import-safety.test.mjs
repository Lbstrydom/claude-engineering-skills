/**
 * @fileoverview Import-safety regression lock for model-eval-discovery.mjs.
 *
 * The 2026-07-17 incident: this module executed its whole body at top level
 * (arg parsing, payload build, and the LIVE multi-arm eval loop), so a bare
 * `import()` — done to "check the module loads" after a telemetry edit —
 * launched a REAL paid eval run against OpenRouter. Killed within seconds.
 * Same class as the 2026-07-13 tiered-shadow-report incident ("importing the
 * module for its exported helpers ALSO ran the full CLI"), same fix: the
 * standard `pathToFileURL(process.argv[1])` entry-point guard.
 *
 * Both tests are hermetic subprocesses. The import probe ALSO forces
 * `OPENROUTER_API_KEY` empty and blocks the shared-env load, so even if the
 * guard regresses the worst case is a loud exit-1 ("OPENROUTER_API_KEY is not
 * set"), never a silent paid run — the tripwire fails the test either way.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_URL = new URL('../scripts/model-eval-discovery.mjs', import.meta.url).href;
const HERMETIC_ENV = {
  ...process.env,
  AUDIT_LOOP_DISABLE_SHARED: '1', // block ~/.audit-loop.env (it carries the real key)
  OPENROUTER_API_KEY: '',         // guard-regression tripwire: main() would exit 1 loudly, never spend
};

describe('model-eval-discovery.mjs — import must never execute the eval (2026-07-17 incident)', () => {
  test('a bare import runs NOTHING: no arg handling, no payload build, no provider calls', () => {
    const script = `
      await import(${JSON.stringify(MODULE_URL)});
      console.log('IMPORT_SAFE');
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO, encoding: 'utf8', timeout: 60000, env: HERMETIC_ENV,
    });
    // Exactly the sentinel: if main() ran, the subprocess exits 1 on the
    // missing key (execFileSync throws) or emits its own output first.
    assert.equal(out.trim(), 'IMPORT_SAFE');
  });

  test('import stays safe even with --selfcheck-relocation in the IMPORTER\'s argv', () => {
    // The handler used to sit at module top level reading process.argv — an
    // importer invoked with the flag would have had its process killed by the
    // imported module's process.exit(0). Now it lives inside main(), behind
    // the guard.
    const script = `
      await import(${JSON.stringify(MODULE_URL)});
      console.log('STILL_ALIVE');
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script, '--', '--selfcheck-relocation'], {
      cwd: REPO, encoding: 'utf8', timeout: 60000, env: HERMETIC_ENV,
    });
    assert.equal(out.trim(), 'STILL_ALIVE');
  });

  test('direct CLI invocation still enters main(): --selfcheck-relocation prints OK', () => {
    const out = execFileSync(process.execPath, ['scripts/model-eval-discovery.mjs', '--selfcheck-relocation'], {
      cwd: REPO, encoding: 'utf8', timeout: 60000, env: HERMETIC_ENV,
    });
    assert.equal(out.trim(), 'OK');
  });
});
