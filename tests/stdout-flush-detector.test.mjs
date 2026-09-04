import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { findStdoutExitSites } from '../scripts/lib/find-stdout-exit-sites.mjs';

// Contract tests for the detector behind `npm run stdout:flush:gate`.
//
// Every case below is a control that was RUN before the gate was trusted, and
// four of them caught a real defect in the detector on the first pass — the
// discipline AGENTS.md §verification-discipline states as "a check is not
// trustworthy until seen to fail; when one fails, suspect the instrument
// first". They are kept as regressions because each failure mode is silent:
// a detector for a silent-truncation class that under-reports looks exactly
// like a clean repo.
//
// The four instrument defects, all fixed:
//   1. `enclosingFunctionNode` built a fresh `{type:'Program'}` sentinel per
//      call, so two TOP-LEVEL statements never compared equal and a top-level
//      write+exit was invisible.       → 'reports a top-level site'
//   2. `emit()` never resolved, because the caller passed forward-slash paths
//      on Windows and `import-binding` compares resolved paths with `===`.
//                                       → 'reports an emit() site'
//   3. "same function, lexically earlier" with no reachability filter reported
//      401 sites, most of them a `--help` branch that had already exited.
//                                       → 'does not report across a branch that exits first'
//   4. `finishAndExit` was not recognised as a terminator, so FIXING a site
//      manufactured new findings from the same write.
//                                       → 'treats finishAndExit as a terminator'

// These unit controls are the non-process half of the executable gate
// `stdout-flush-gate-detects-a-new-undrained-exit` (scripts/gate-contracts/
// stdout-flush-gate.json). The poison pill proves the RATCHET can fail;
// everything here proves the DETECTOR behind it reports the right set.

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const OPTS = {
  fromFileAbsPath: path.join(REPO_ROOT, 'probe.mjs'),
  cliIoAbsPath: path.join(REPO_ROOT, 'scripts', 'lib', 'cli-io.mjs'),
};

const NL = String.raw`\n`;

function sites(src) {
  return findStdoutExitSites(src, OPTS);
}

describe('find-stdout-exit-sites — positive controls (must REPORT)', () => {
  it('reports process.stdout.write then process.exit', () => {
    assert.equal(sites(`async function main(){ process.stdout.write('x'); process.exit(0); }`).length, 1);
  });

  it('reports console.log then process.exit', () => {
    const [s] = sites(`function main(){ console.log('x'); process.exit(1); }`);
    assert.equal(s.writeHow, 'console.log');
    assert.equal(s.exitCode, 1);
  });

  it('reports an emit() site, and classifies it as an envelope', () => {
    // Defect 2: this returned [] until the caller's paths were `path.resolve`d.
    const [s] = sites(`import { emit } from './scripts/lib/cli-io.mjs';\nfunction main(){ emit({ok:true}); process.exit(0); }`);
    assert.equal(s.writeHow, 'emit');
    assert.equal(s.payload, 'envelope');
  });

  it('reports a top-level site (module scope, no enclosing function)', () => {
    // Defect 1: the Program-node sentinel identity bug made this invisible.
    assert.equal(sites(`process.stdout.write('x'); process.exit(0);`).length, 1);
  });

  it('reports a write in an earlier `if` that falls THROUGH to the exit', () => {
    assert.equal(sites(`function main(){\n  if (x) { console.log(a); }\n  process.exit(1);\n}`).length, 1);
  });

  it('reports a write inside a loop body before the exit', () => {
    assert.equal(sites(`function main(){\n  for (const r of rows) process.stdout.write(r);\n  process.exit(0);\n}`).length, 1);
  });

  it('does not let a LOCAL finishAndExit silence a real site', () => {
    // Binding resolution, not spelling: a local helper of that name must not
    // suppress the finding. Silence is the dangerous direction here.
    const src = `function finishAndExit(){}\nasync function main(){\n  if (s) { process.stdout.write('x'); await finishAndExit(0); }\n  process.exit(2);\n}`;
    assert.equal(sites(src).length, 1);
  });

  it('does not exempt an exit merely because the flag string appears in the if BODY', () => {
    const src = `if (other) { console.log('--selfcheck-relocation'); process.exit(0); }`;
    assert.equal(sites(src).length, 1);
  });

  it('classifies a JSON.stringify payload as an envelope and plain text as text', () => {
    const [env] = sites(`function main(){ process.stdout.write(JSON.stringify({ok:true})); process.exit(0); }`);
    assert.equal(env.payload, 'envelope');
    const [txt] = sites(`function main(){ process.stdout.write('done'); process.exit(0); }`);
    assert.equal(txt.payload, 'text');
  });
});

describe('find-stdout-exit-sites — negative controls (must NOT report)', () => {
  it('ignores a stderr write before an exit', () => {
    // The explicitly excluded case: stderr is synchronous enough for the skip
    // messages, and every symbol-index CLI has one.
    assert.deepEqual(sites(`function main(){ process.stderr.write('x'); process.exit(0); }`), []);
  });

  it('ignores console.error before an exit', () => {
    assert.deepEqual(sites(`function main(){ console.error('x'); process.exit(1); }`), []);
  });

  it('exempts the documented --selfcheck-relocation smoke contract', () => {
    const src = `if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }`;
    assert.deepEqual(sites(src), []);
  });

  it('ignores a write in a NESTED function that never runs', () => {
    assert.deepEqual(sites(`function main(){ const f = () => { process.stdout.write('x'); }; process.exit(0); }`), []);
  });

  it('ignores a SHADOWED process', () => {
    assert.deepEqual(sites(`function main(process){ process.stdout.write('x'); process.exit(0); }`), []);
  });

  it('ignores an emit() that is not the cli-io one', () => {
    assert.deepEqual(sites(`import { emit } from './other.mjs';\nfunction main(){ emit({ok:true}); process.exit(0); }`), []);
  });

  it('ignores a write that comes AFTER the exit', () => {
    assert.deepEqual(sites(`function main(){ process.exit(0); process.stdout.write('x'); }`), []);
  });

  it('accepts finishAndExit as the fix', () => {
    assert.deepEqual(sites(`function main(){ process.stdout.write('x'); return finishAndExit(0); }`), []);
  });

  it('does not report across a branch that exits first', () => {
    // Defect 3, the one that took the census from 401 to 190. The `--help`
    // print cannot have buffered anything when the LATER exit fires, because
    // its own branch already exited. Only the in-branch exit is a site.
    const src = `function main(){\n  if (help) { console.log(usage); process.exit(0); }\n  work();\n  process.exit(2);\n}`;
    const found = sites(src);
    assert.equal(found.length, 1);
    assert.equal(found[0].line, 2, 'only the in-branch exit is a site');
  });

  it('does not report across a branch that returns or throws first', () => {
    assert.deepEqual(sites(`function main(){\n  if (x) { console.log(a); return; }\n  process.exit(1);\n}`), []);
    assert.deepEqual(sites(`function main(){\n  if (x) { console.log(a); throw new Error('y'); }\n  process.exit(1);\n}`), []);
  });

  it('does not pair the two mutually-exclusive arms of one if', () => {
    assert.deepEqual(sites(`function main(){\n  if (x) { console.log(a); } else { process.exit(1); }\n}`), []);
  });

  it('treats finishAndExit as a terminator, awaited or voided', () => {
    // Defect 4: without this, fixing a site made the SAME write reach every
    // later exit in the function — symbol-index/refresh.mjs went 2 → 5 sites
    // the moment its 2 were fixed. A detector whose own remedy manufactures
    // findings punishes the fix.
    const imp = `import { finishAndExit } from './scripts/lib/cli-io.mjs';`;
    assert.deepEqual(
      sites(`${imp}\nasync function main(){\n  if (s) { process.stdout.write('x'); await finishAndExit(0); }\n  work();\n  process.exit(2);\n}`),
      [],
    );
    assert.deepEqual(
      sites(`${imp}\nfunction main(){\n  if (s) { process.stdout.write('x'); void finishAndExit(0); }\n  process.exit(2);\n}`),
      [],
    );
  });

  it('honours a terminator inside a switch case', () => {
    const imp = `import { finishAndExit } from './scripts/lib/cli-io.mjs';`;
    const src = `${imp}\nasync function main(){\n  switch (k) { case 'a': process.stdout.write('x'); await finishAndExit(0); }\n  process.exit(2);\n}`;
    assert.deepEqual(sites(src), []);
  });
});

describe('find-stdout-exit-sites — soundness', () => {
  it('REFUSES a recovered (partial) parse rather than reporting fewer sites', () => {
    // parseSource's own docstring warns that a consumer needing sound
    // structural coverage reads a truncated tree as clean. A detector for a
    // silent-truncation class must not itself go green by truncation.
    assert.throws(() => findStdoutExitSites('function ( { broken', OPTS), /parse|Unexpected/i);
  });

  it('reports the WORST payload reaching an exit, not the last one written', () => {
    const src = `function main(){\n  process.stdout.write(JSON.stringify({ok:true}));\n  process.stdout.write('trailing note');\n  process.exit(0);\n}`;
    const [s] = sites(src);
    assert.equal(s.payload, 'envelope');
    assert.equal(s.writeCount, 2);
  });

  it('records a template-literal write with an escaped newline as one site', () => {
    // Guards the shape every symbol-index CLI actually uses.
    const src = `function main(){ process.stdout.write(JSON.stringify({ok:true}) + '${NL}'); process.exit(0); }`;
    assert.equal(sites(src).length, 1);
  });
});
