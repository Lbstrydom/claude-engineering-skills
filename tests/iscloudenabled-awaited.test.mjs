// Guard: isCloudEnabled() is async (a pg pool-presence check — see
// scripts/lib/store/repo.mjs). A BARE call returns a pending Promise, which is
// always truthy — so `if (!isCloudEnabled())` guards never fire and graceful
// local-only degradation silently breaks (the script crashes with "No DB pool"
// instead of skipping when cloud is off). This regression slipped in when the
// function was migrated sync→async in the pg-parity work and ~18 call sites
// were missed. This test fails the build if any bare call reappears.
//
// Allowed forms:
//   await isCloudEnabled()            // direct
//   await <obj>.isCloudEnabled()      // via a store handle (ls/store/...)
//   return isCloudEnabled()           // async wrapper returning the Promise
//   isCloudEnabled                    // a bare reference (no call) — passed as a value
//   typeof x.isCloudEnabled ...       // a reflection check (no call)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts');

function collectMjs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...collectMjs(full));
    } else if (entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

test('isCloudEnabled() is always awaited (a bare call is a truthy Promise)', () => {
  const offenders = [];
  for (const file of collectMjs(SCRIPTS_DIR)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((raw, i) => {
      const code = raw.trim();
      // Skip comments and the function definition itself.
      if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
      if (code.includes('export async function isCloudEnabled')) return;
      // Strip the legitimate forms, then see if any *call* survives.
      const stripped = raw
        // Awaited — direct, or via ANY dotted handle. `(?:[\w$]+\.)?` matched
        // one segment only, so `await ctx.deps.isCloudEnabled()` (two
        // segments, introduced by the cross-skill store port) was flagged as
        // un-awaited despite the line literally starting with `await` — an
        // instrument defect, not a finding.
        .replace(/await\s+(?:[\w$]+\.)*isCloudEnabled\(\)/g, '')
        .replace(/return\s+(?:[\w$]+\.)*isCloudEnabled\(\)/g, '') // wrapper returns the Promise
        // Concise-arrow thunk: `() => deps.isCloudEnabled()` is an implicit
        // RETURN of the promise, handed to a callee that awaits it — the same
        // legitimate form as the explicit `return` above, which the pattern
        // list already exempted. Without this the scanner flagged a correct
        // dependency injection as an un-awaited call.
        .replace(/=>\s*(?:[\w$]+\.)*isCloudEnabled\(\)/g, '');
      if (/\bisCloudEnabled\(\)/.test(stripped)) {
        offenders.push(`${path.relative(SCRIPTS_DIR, file)}:${i + 1}: ${code}`);
      }
    });
  }
  assert.deepEqual(
    offenders, [],
    `Un-awaited isCloudEnabled() call(s) found — isCloudEnabled() is async, ` +
    `prefix with await:\n${offenders.join('\n')}`,
  );
});
