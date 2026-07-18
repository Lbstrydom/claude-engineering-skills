/**
 * @fileoverview Guards the run-finalisation seam against fire-and-forget
 * cloud writes.
 *
 * **The bug this exists to prevent (found 2026-07-18, in live data).**
 * `runLegacyProductionAudit` called `recordRunComplete(...)` WITHOUT awaiting
 * it — `.catch()`-only, in the name of "best-effort telemetry". The pg pool
 * runs with `allowExitOnIdle: true` (`scripts/lib/db/client.mjs`), so as soon
 * as the audit's last awaited query finished and the connections went idle,
 * Node exited and took the in-flight UPDATE with it.
 *
 * The failure was invisible in exactly the way that matters: findings ARE
 * written on an awaited path, so every `mode='code'` run in the store had its
 * findings attached while the run row itself sat at its `recordRunStart`
 * INSERT values — `rounds: 0`, `total_findings: 0`, `total_duration_ms: NULL`.
 * 25 of 25 live code runs were in that state. Everything keyed on those
 * columns (cache telemetry, `round_converged_after`'s neighbours, any
 * aggregate over run size) silently read zero. Plan mode was unaffected for
 * one reason only: `plan-audit-cloud.mjs` awaits its call.
 *
 * `.catch()` is NOT a substitute for `await` here. It preserves the
 * best-effort contract (a store failure must never fail an audit); it does
 * nothing to guarantee the write is given the chance to complete. Both are
 * required, and this test pins the half that is easy to drop.
 *
 * Static assertion by design: the behavioural harnesses for this path
 * (`run-multi-pass-code-audit-harness.test.mjs`) air-gap the store with
 * `LEARNING_DISABLE=1`, so they cannot observe the race. Asserting on the
 * source is what actually catches a reintroduction.
 *
 * @see AGENTS.md — "Testing doctrine", Tier 3 (silent-regression-prone seams)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Store writers that finalise or stamp an `audit_runs` row. Each lands data
 * no other write reproduces, and each is called from a path that can be the
 * last thing a process does — so an un-awaited call is a lost write, not a
 * slow one.
 */
const FINALISATION_WRITERS = [
  'recordRunComplete',
  'recordConvergenceState',
];

/**
 * Orchestrators that own the end of a run. Restricted to real call sites:
 * the store module defines these functions and `learning-store.mjs`
 * re-exports them, neither of which is a call.
 */
const ORCHESTRATORS = [
  path.join('scripts', 'lib', 'audit', 'legacy-production-audit.mjs'),
  path.join('scripts', 'lib', 'audit', 'plan-audit-cloud.mjs'),
  path.join('scripts', 'openai-audit.mjs'),
];

describe('run-finalisation writes are awaited', () => {
  for (const rel of ORCHESTRATORS) {
    for (const writer of FINALISATION_WRITERS) {
      it(`${rel} awaits every ${writer}() call`, () => {
        const full = path.join(REPO_ROOT, rel);
        const src = fs.readFileSync(full, 'utf8');
        const lines = src.split('\n');

        const offenders = [];
        lines.forEach((line, i) => {
          // Skip comment lines — this file's own prose names these writers,
          // and so does the explanatory comment at the fixed call site.
          const trimmed = line.trim();
          if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
          // An import/re-export names the writer without calling it.
          if (/^\s*(import|export)\b/.test(trimmed)) return;

          const callIdx = line.indexOf(`${writer}(`);
          if (callIdx === -1) return;

          // The call is fine if `await` (or a `return`, which propagates to
          // the caller's await) immediately precedes it on the same line.
          const before = line.slice(0, callIdx);
          if (/\b(await|return)\s+$/.test(before)) return;
          // `const x = await import(...)` destructuring mentions the name.
          if (/\bconst\s*\{[^}]*$/.test(before)) return;

          offenders.push(`${rel}:${i + 1}: ${trimmed}`);
        });

        assert.deepEqual(
          offenders,
          [],
          `Un-awaited ${writer}() call(s) — the pool runs allowExitOnIdle, so an\n`
          + `un-awaited store write is a LOST write, not merely a late one.\n`
          + `Add \`await\` (keep any .catch() — it preserves best-effort):\n`
          + offenders.join('\n'),
        );
      });
    }
  }

  it('the pool still exits on idle (the premise of this guard)', () => {
    // If this ever flips to false, the race disappears and these assertions
    // become merely stylistic — worth knowing rather than silently over-
    // constraining future code.
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'lib', 'db', 'client.mjs'), 'utf8');
    assert.match(
      src,
      /allowExitOnIdle:\s*true/,
      'db/client.mjs no longer sets allowExitOnIdle: true — re-evaluate whether '
      + 'the un-awaited-write race this suite guards still exists.',
    );
  });
});
