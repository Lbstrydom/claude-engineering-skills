/**
 * @fileoverview A `node --import` preload that records every filesystem path a process opens, stats or probes UNDER ITS CWD, and writes
 * the sorted, cwd-relative, forward-slash list to `$FS_TRACE_OUT` when the process exits.
 *
 * Used by the audit-snapshot input census (tests/prepush-snapshot-census.test.mjs): the consumer hook runs the audit with its cwd in a
 * snapshot that holds only TRACKED files, so every input the audit reads from cwd must have a declared policy
 * (docs/plans/prepush-gate-consumer-feedback-theme1.md D2). Builtin ESM named exports are re-synced after patching, so
 * `import { readFileSync } from 'node:fs'` is traced as well as `fs.readFileSync`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const OUT = process.env.FS_TRACE_OUT;
const ROOT = path.resolve(process.cwd());
const seen = new Set();
const record = (p) => {
  try {
    if (typeof p !== 'string' && !(p instanceof URL)) return;
    const abs = path.resolve(ROOT, p instanceof URL ? p.pathname.replace(/^\/([A-Za-z]:)/, '$1') : p);
    const rel = path.relative(ROOT, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    seen.add(rel.split(path.sep).join('/'));
  } catch { /* tracing must never change the traced program */ }
};
const SYNC = ['readFileSync', 'existsSync', 'statSync', 'lstatSync', 'openSync', 'readdirSync', 'accessSync', 'realpathSync'];
const ASYNC = ['readFile', 'stat', 'lstat', 'open', 'readdir', 'access', 'realpath'];
// Callback forms too (audit B R1 M9): a path read through fs.readFile(p, cb) is an input like any other.
const CALLBACK = ['readFile', 'stat', 'lstat', 'open', 'readdir', 'access', 'exists', 'realpath', 'createReadStream'];
for (const name of [...SYNC, ...CALLBACK]) {
  const orig = fs[name];
  if (typeof orig === 'function') {
    const traced = function traced(p, ...rest) { record(p); return orig.call(this, p, ...rest); };
    // Keep every own property (util.promisify.custom on fs.exists - audit B R3 M1), and trace .native sub-APIs (realpath - R2 M2).
    for (const key of Reflect.ownKeys(orig)) { if (!(key in traced) || typeof key === 'symbol') { try { traced[key] = orig[key]; } catch { /* read-only */ } } }
    if (typeof orig.native === 'function') traced.native = function tracedNative(p, ...rest) { record(p); return orig.native.call(this, p, ...rest); };
    fs[name] = traced;
  }
}
for (const name of ASYNC) {
  const orig = fs.promises[name];
  if (typeof orig === 'function') fs.promises[name] = function traced(p, ...rest) { record(p); return orig.call(this, p, ...rest); };
}
syncBuiltinESMExports();
if (OUT) {
  process.on('exit', () => {
    try { fs.writeFileSync(OUT, JSON.stringify([...seen].sort(), null, 2)); } catch { /* best effort */ }
  });
}
