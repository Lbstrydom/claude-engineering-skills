import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { findStdoutExitSites } from '../scripts/lib/find-stdout-exit-sites.mjs';
// The gate's own identity function. Importing it is safe: the module runs
// `main()` only when `process.argv[1]` is the gate script, which under the test
// runner it is not.
import { siteId } from '../scripts/check-stdout-flush.mjs';

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

  it('treats an AWAITED finishAndExit as a terminator', () => {
    // Defect 4: without this, fixing a site made the SAME write reach every
    // later exit in the function — symbol-index/refresh.mjs went 2 -> 5 sites
    // the moment its 2 were fixed. A detector whose own remedy manufactures
    // findings punishes the fix.
    const imp = `import { finishAndExit } from './scripts/lib/cli-io.mjs';`;
    assert.deepEqual(
      sites(`${imp}
async function main(){
  if (s) { process.stdout.write('x'); await finishAndExit(0); }
  work();
  process.exit(2);
}`),
      [],
    );
  });

  it('does NOT treat a VOIDED finishAndExit as a terminator', () => {
    // Round-1 audit H3. `void` discards the promise and returns immediately, so
    // everything after it still runs and the later exit is genuinely reachable
    // with the write still buffered. AGENTS.md forbids this shape in the very
    // paragraph that introduces the gate ("never fire `void finishAndExit(code)`
    // and fall through") — the detector was excusing the bug its own invariant
    // names, and THIS TEST previously asserted that excuse.
    const imp = `import { finishAndExit } from './scripts/lib/cli-io.mjs';`;
    const found = sites(`${imp}
function main(){
  if (s) { process.stdout.write('x'); void finishAndExit(0); }
  process.exit(2);
}`);
    assert.equal(found.length, 1);
    assert.equal(found[0].line, 4, 'the later exit is reachable past a voided finishAndExit');
  });

  it('a BARE (unawaited) finishAndExit does NOT sever the path', () => {
    // Gemini gate, third pass. `finishAndExit` is async, so a bare call returns
    // a promise and falls through — behaviourally identical to the `void` form.
    // The round-1 H3 fix stripped an `await` when present but never REQUIRED
    // one, so this spelling still counted as a terminator and hid every later
    // exit. Fixing the instance the audit named and stopping is exactly the
    // failure AGENTS.md warns about.
    const imp = `import { finishAndExit } from './scripts/lib/cli-io.mjs';`;
    const src = `${imp}\nasync function main(){\n  if (s) { process.stdout.write('x'); finishAndExit(0); }\n  work();\n  process.exit(2);\n}`;
    const found = sites(src);
    assert.equal(found.length, 1);
    assert.equal(found[0].line, 5, 'the later exit is reachable past an unawaited finishAndExit');
  });

  it('a `break` does NOT sever the path to a later exit', () => {
    // Gemini gate. `break` ends the loop, not the function, and hands control
    // to the code after it — which is where the exit is. Treating it as a
    // terminator made this a silent false negative from the first version.
    const src = `function main(){
  for (const x of xs) { process.stdout.write(x); if (done) break; }
  process.exit(0);
}`;
    assert.equal(sites(src).length, 1);
  });

  it('a `continue` does NOT sever the path either', () => {
    const src = `function main(){
  for (const x of xs) { process.stdout.write(x); continue; }
  process.exit(0);
}`;
    assert.equal(sites(src).length, 1);
  });

  it('a `break` in a switch case does NOT sever the path', () => {
    const src = `function main(){
  switch (k) { case 'a': process.stdout.write('x'); break; }
  process.exit(0);
}`;
    assert.equal(sites(src).length, 1);
  });

  it('honours a terminator inside a switch case', () => {
    const imp = `import { finishAndExit } from './scripts/lib/cli-io.mjs';`;
    const src = `${imp}\nasync function main(){\n  switch (k) { case 'a': process.stdout.write('x'); await finishAndExit(0); }\n  process.exit(2);\n}`;
    assert.deepEqual(sites(src), []);
  });
});

describe('find-stdout-exit-sites — selfcheck exemption is the CONTRACT, not the flag', () => {
  // Round-1 audit H6/M1/M12 — three independent passes raised the same hole.
  // Matching only the guard's TEST exempted everything beneath it, so an
  // arbitrarily large stdout write inside the smoke handler was waved through.
  // The exemption's whole justification is a LITERAL shape pinned by AGENTS.md;
  // an exemption broader than the contract it cites is a hole with a citation.
  const guard = `process.argv.includes('--selfcheck-relocation')`;

  it('exempts the exact documented shape', () => {
    assert.deepEqual(sites(`if (${guard}) { console.log('OK'); process.exit(0); }`), []);
  });

  it('REPORTS a real payload smuggled into the smoke handler', () => {
    const src = `if (${guard}) {\n  process.stdout.write(JSON.stringify(report));\n  process.exit(0);\n}`;
    const found = sites(src);
    assert.equal(found.length, 1);
    assert.equal(found[0].payload, 'envelope');
  });

  it('REPORTS when an extra statement joins the contract body', () => {
    const src = `if (${guard}) {\n  console.log('OK');\n  process.stdout.write(extra);\n  process.exit(0);\n}`;
    assert.equal(sites(src).length, 1);
  });

  it('REPORTS a non-zero or computed exit code under the guard', () => {
    assert.equal(sites(`if (${guard}) { console.log('OK'); process.exit(code); }`).length, 1);
  });

  it('REPORTS a non-literal console.log argument under the guard', () => {
    assert.equal(sites(`if (${guard}) { console.log(bigReport); process.exit(0); }`).length, 1);
  });
});

describe('find-stdout-exit-sites — same-file indirect writers', () => {
  // Round-1 audit H4/M13. Measured when raised: 51 further sites across 16
  // files, a ~28% undercount on a census whose whole claim is to BE one.
  it('reports an exit after a call to a local stdout-writing helper', () => {
    const src = `function emitOutput(){ process.stdout.write(JSON.stringify(x)); }\nfunction main(){\n  emitOutput();\n  process.exit(0);\n}`;
    const found = sites(src);
    assert.equal(found.length, 1);
    assert.equal(found[0].payload, 'envelope', 'the helper\'s payload propagates to the call site');
  });

  it('resolves a helper through the call graph, not just one hop', () => {
    const src = `function inner(){ process.stdout.write('x'); }\nfunction outer(){ inner(); }\nfunction main(){\n  outer();\n  process.exit(0);\n}`;
    assert.equal(sites(src).length, 1);
  });

  it('does NOT count a helper that only writes stderr', () => {
    const src = `function warn(){ process.stderr.write('x'); }\nfunction main(){\n  warn();\n  process.exit(0);\n}`;
    assert.deepEqual(sites(src), []);
  });

  it('does NOT count a same-named IMPORT as a local writer', () => {
    const src = `import { emitOutput } from './elsewhere.mjs';\nfunction main(){\n  emitOutput();\n  process.exit(0);\n}`;
    assert.deepEqual(sites(src), []);
  });

  it('terminates on mutual recursion rather than looping forever', () => {
    const src = `function a(){ process.stdout.write('x'); b(); }\nfunction b(){ a(); }\nfunction main(){\n  a();\n  process.exit(0);\n}`;
    assert.equal(sites(src).length, 1);
  });
});

describe('find-stdout-exit-sites — explicit ESM globals (Gemini gate)', () => {
  // A file doing `import process from 'node:process'` creates a BINDING, and
  // the first cut read any binding as "shadowed" and skipped the file whole.
  // Measured when raised: FOUR files under scripts/ were invisible that way —
  // reported as clean rather than as unscanned, which is the worst shape a
  // detector can have.
  it('still detects through an explicit `import process from "node:process"`', () => {
    const src = `import process from 'node:process';\nfunction main(){ process.stdout.write('x'); process.exit(0); }`;
    assert.equal(sites(src).length, 1);
  });

  it('still detects through the bare "process" specifier', () => {
    const src = `import process from 'process';\nfunction main(){ console.log('x'); process.exit(1); }`;
    assert.equal(sites(src).length, 1);
  });

  it('treats an imported process.exit as a TERMINATOR too', () => {
    // The single-oracle half: fixing the classifier but not the terminator
    // predicate made the `--selfcheck` block stop ending its own path, so its
    // `console.log('OK')` reached every later exit — 16 bogus sites, 9 of them
    // from this alone.
    const src = `import process from 'node:process';
function main(){
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  if (!enabled) process.exit(0);
}`;
    assert.deepEqual(sites(src), []);
  });

  it('does NOT detect through a genuinely shadowed local', () => {
    const src = `import process from 'node:process';\nfunction main(){ const shadow = fake; return shadow; }\nfunction other(process){ process.stdout.write('x'); process.exit(0); }`;
    assert.deepEqual(sites(src), []);
  });
});

describe('find-stdout-exit-sites — only real branch arms are exclusive (Gemini gate)', () => {
  // The mutual-exclusion check said "different children of an if/ternary/logical
  // ⇒ exclusive", which also excluded the CONDITION from the body — and the
  // condition runs FIRST.
  it('reports a write in the if CONDITION reaching an exit in the body', () => {
    const src = `function main(){\n  if (writeAndCheck(process.stdout.write('x'))) { process.exit(0); }\n}`;
    assert.equal(sites(src).length, 1);
  });

  it('reports a write on the LEFT of && reaching an exit on the right', () => {
    const src = `function main(){\n  hasOutput(process.stdout.write('x')) && process.exit(0);\n}`;
    assert.equal(sites(src).length, 1);
  });

  it('reports a write in a ternary TEST reaching an exit in a branch', () => {
    const src = `function main(){\n  check(process.stdout.write('x')) ? process.exit(0) : noop();\n}`;
    assert.equal(sites(src).length, 1);
  });

  it('still does NOT pair a ternary consequent with its alternate', () => {
    const src = `function main(){\n  cond ? process.stdout.write('x') : process.exit(1);\n}`;
    assert.deepEqual(sites(src), []);
  });
});

describe('find-stdout-exit-sites — aliased stdout is ENFORCED, not documented', () => {
  // Round-2 adjudication. This was a "documented limit" justified by 0 instances
  // in the repo. The ruling rejected that and was right: a documented limit is
  // not enforcement, and this gate's claim is that a NEW instance cannot appear
  // unnoticed. A zero measurement says nothing about tomorrow's code.
  it('reports a write through a const alias', () => {
    const src = `function main(){\n  const out = process.stdout;\n  out.write(JSON.stringify(x));\n  process.exit(0);\n}`;
    const found = sites(src);
    assert.equal(found.length, 1);
    assert.equal(found[0].payload, 'envelope');
    assert.match(found[0].writeHow, /stdout alias/);
  });

  it('reports a write through an alias assigned later', () => {
    const src = `function main(){\n  let out;\n  out = process.stdout;\n  out.write('x');\n  process.exit(0);\n}`;
    assert.equal(sites(src).length, 1);
  });

  it('reports a DESTRUCTURED stdout alias', () => {
    // Round-3 H1/M3: the first cut matched only `= process.stdout`, so
    // `const { stdout } = process` slipped past — the same "limit is not
    // enforcement" hole one level down.
    const src = `function main(){\n  const { stdout } = process;\n  stdout.write('x');\n  process.exit(0);\n}`;
    assert.equal(sites(src).length, 1);
  });

  it('reports a RENAMED destructured alias', () => {
    const src = `function main(){\n  const { stdout: out } = process;\n  out.write('x');\n  process.exit(0);\n}`;
    assert.equal(sites(src).length, 1);
  });

  it('follows an alias CHAIN', () => {
    const src = `function main(){\n  const a = process.stdout;\n  const b = a;\n  b.write('x');\n  process.exit(0);\n}`;
    assert.equal(sites(src).length, 1);
  });

  it('does NOT report a destructure of some other property', () => {
    const src = `function main(){\n  const { stderr } = process;\n  stderr.write('x');\n  process.exit(0);\n}`;
    assert.deepEqual(sites(src), []);
  });

  it('does NOT report an alias of stderr', () => {
    // The excluded channel stays excluded through an alias too — otherwise the
    // fix would have widened the gate past its own stated scope.
    const src = `function main(){\n  const err = process.stderr;\n  err.write('x');\n  process.exit(0);\n}`;
    assert.deepEqual(sites(src), []);
  });

  it('does NOT report an unrelated object that happens to have .write', () => {
    const src = `function main(){\n  const f = fs.createWriteStream('x');\n  f.write('x');\n  process.exit(0);\n}`;
    assert.deepEqual(sites(src), []);
  });

  it('does NOT report a parameter named like an alias', () => {
    const src = `function main(out){\n  out.write('x');\n  process.exit(0);\n}`;
    assert.deepEqual(sites(src), []);
  });
});

describe('find-stdout-exit-sites — site identity discriminates a swap', () => {
  // Round-2 audit H1/M1. The gate's baseline is an identity SET, so two sites
  // the detector cannot tell apart are two sites a swap can hide between:
  // delete one, add another of the same shape, and the set never moves.
  // The REAL identity the baseline is keyed on, imported rather than
  // re-implemented — a test that re-derives the thing under test proves only
  // that two copies agree (AGENTS.md, the prose↔code seam rule).
  const idsFor = (src) => {
    const seen = new Map();
    return sites(src).map((s) => siteId({ file: 'probe.mjs', ...s }, seen));
  };

  const TWO_SIBLING_IFS = `function main(){
  if (a) { process.stdout.write('x'); process.exit(2); }
  if (b) { process.stdout.write('y'); process.exit(2); }
}`;

  it('gives every site in one function a distinct identity', () => {
    const ids = idsFor(TWO_SIBLING_IFS);
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, 2, `identities collided: ${JSON.stringify(ids)}`);
  });

  it('separates a try body from its catch STRUCTURALLY, not merely by ordinal', () => {
    // The stronger claim: these differ in the structure segment itself, so
    // deleting one cannot let the other inherit its identity.
    const ids = idsFor(`function main(){
  try { process.stdout.write('x'); process.exit(0); }
  catch { process.stdout.write('y'); process.exit(0); }
}`);
    assert.equal(ids.length, 2);
    assert.ok(ids[0].includes('[try>block]'), ids[0]);
    assert.ok(ids[1].includes('[try>catch]'), ids[1]);
  });

  it('keeps identity stable when unrelated code is inserted above', () => {
    // The whole reason identity is not line-keyed: an edit above a site must
    // not renumber it, or the baseline churns and gets --update'd reflexively.
    const body = `  if (a) { process.stdout.write('x'); process.exit(2); }`;
    const plain = `function main(){\n${body}\n}`;
    const shifted = `function main(){\n  const unrelated = compute();\n  log(unrelated);\n${body}\n}`;
    assert.deepEqual(idsFor(plain), idsFor(shifted), 'an edit above a site must not change its identity');
    assert.notEqual(sites(plain)[0].line, sites(shifted)[0].line, 'the line really did move');
  });

  it('DOCUMENTED RESIDUAL: same-shaped siblings of one branch kind are ordinal-separated', () => {
    // Round-2 H1/M1 asked that replacement, addition, removal and relocation all
    // be distinguishable. Structure closes the common case (different branches);
    // two siblings of the SAME kind still fall back to the ordinal, so deleting
    // the first renumbers the second and a same-shape replacement in that one
    // spot stays invisible. Closing it needs a CONTENT hash, which churns on a
    // reworded message and would train people to `--update` reflexively — the
    // failure the line-independent design exists to prevent.
    //
    // Asserted, so the limit is a checked fact rather than a claim in a comment:
    // if a future change closes it, this test fails and must be retired
    // deliberately.
    const ids = idsFor(TWO_SIBLING_IFS);
    assert.ok(ids[0].endsWith('#1') && ids[1].endsWith('#2'), JSON.stringify(ids));
    assert.equal(
      ids[0].slice(0, -2), ids[1].slice(0, -2),
      'same branch kind ⇒ identical prefix; the ordinal is the only separator',
    );
  });
});

describe('find-stdout-exit-sites — payload and import resolution (Gemini gate)', () => {
  it('classifies a stringify held in a VARIABLE as an envelope', () => {
    // Inspecting only the argument's own AST called this text, understating the
    // half of the census that the paydown prioritises on. 36 `= JSON.stringify`
    // assignments exist under scripts/.
    const src = `function main(){\n  const body = JSON.stringify(x);\n  process.stdout.write(body);\n  process.exit(0);\n}`;
    const [s] = sites(src);
    assert.equal(s.payload, 'envelope');
  });

  it('classifies a stringify reached through a ternary as an envelope', () => {
    const src = `function main(){\n  const body = pretty ? JSON.stringify(x, null, 2) : JSON.stringify(x);\n  process.stdout.write(body);\n  process.exit(0);\n}`;
    assert.equal(sites(src)[0].payload, 'envelope');
  });

  it('still calls a plain string payload text', () => {
    const src = `function main(){\n  const body = renderReport();\n  process.stdout.write(body);\n  process.exit(0);\n}`;
    assert.equal(sites(src)[0].payload, 'text');
  });

  it('resolves an ALIASED emit import', () => {
    // A hardcoded `callee.name === 'emit'` short-circuited before the resolver
    // that exists to see through exactly this. Zero aliases exist today, which
    // is the wrong test for a gate whose claim is about tomorrow's code.
    const src = `import { emit as say } from './scripts/lib/cli-io.mjs';\nfunction main(){ say({ok:true}); process.exit(0); }`;
    const [s] = sites(src);
    assert.equal(s.writeHow, 'emit', 'labelled by the export, so an alias does not churn identity');
    assert.equal(s.payload, 'envelope');
  });

  it('treats an aliased AWAITED finishAndExit as a terminator', () => {
    const src = `import { finishAndExit as done } from './scripts/lib/cli-io.mjs';\nasync function main(){\n  if (s) { process.stdout.write('x'); await done(0); }\n  process.exit(2);\n}`;
    assert.deepEqual(sites(src), []);
  });

  it('does NOT treat an aliased UNAWAITED finishAndExit as a terminator', () => {
    const src = `import { finishAndExit as done } from './scripts/lib/cli-io.mjs';\nasync function main(){\n  if (s) { process.stdout.write('x'); done(0); }\n  process.exit(2);\n}`;
    assert.equal(sites(src).length, 1);
  });

  it('does NOT treat an unrelated import of the same local name as emit', () => {
    const src = `import { emit } from './other.mjs';\nfunction main(){ emit({ok:true}); process.exit(0); }`;
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
