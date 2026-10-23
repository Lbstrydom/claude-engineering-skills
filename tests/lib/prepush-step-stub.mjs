/**
 * @fileoverview Kept OUT of hook-test-helpers.mjs on purpose: that module is imported by tests that have nothing to do with the step
 * runner (prepush-archive-lane-hook), and a path named there puts scripts/prepush-step.mjs (and so cli-entry.mjs) in their reach,
 * which the test-tier replay manifest then reads as those tests being reached by a cli-entry change.
 */
import fs from 'node:fs';
import path from 'node:path';
/**
 * The consumer hook (v11) runs every node step through `<source>/scripts/prepush-step.mjs` and REFUSES when it is absent, so a
 * stub source repo needs one. This stub delegates to the real runner rather than copying it (the real one imports ./lib/**).
 */
export function writeStepRunnerStub(scriptsDir) {
  const real = new URL('../../scripts/prepush-step.mjs', import.meta.url).href;
  fs.writeFileSync(path.join(scriptsDir, 'prepush-step.mjs'), [
    "import { spawnSync } from 'node:child_process';",
    "import { fileURLToPath } from 'node:url';",
    `const r = spawnSync(process.execPath, [fileURLToPath(${JSON.stringify(real)}), ...process.argv.slice(2)], { stdio: 'inherit' });`,
    'process.exit(r.status ?? 1);',
    '',
  ].join('\n'));
}
