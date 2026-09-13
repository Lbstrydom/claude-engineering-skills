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
/**
 * Each writer has TWO spellings a call site can take: the direct store call, and
 * the durable-write seam (`durableWrite('audit.runComplete', …)`) that the
 * orchestrator's cloud block has used since docs/plans/audit-store-write-durability.md.
 * A scan that knows only the first spelling looked at run-persistence.mjs and
 * saw nothing to check — which is not the same as seeing every call awaited.
 */
const FINALISATION_WRITERS = [
  { name: 'recordRunComplete', patterns: ['recordRunComplete(', "durableWrite('audit.runComplete'"] },
  { name: 'recordConvergenceState', patterns: ['recordConvergenceState(', "durableWrite('audit.convergenceState'"] },
];

/**
 * Orchestrators that own the end of a run, each DECLARING which writers it is
 * expected to call. `present` means the scan must find >= 1 call site — zero is
 * a vacuous pass and FAILS; `none` means the file is expected to have moved
 * that write elsewhere, and a call site appearing there also fails, so the
 * declaration cannot drift silently in either direction.
 *
 * Measured 2026-09-13 (docs/plans/backlog-tooling-honesty.md §1 item 4): after
 * the orchestrator decomposition, legacy-production-audit.mjs and
 * openai-audit.mjs had ZERO call sites for either writer, and this suite
 * passed on both — it could not tell "all awaited" from "nothing to check".
 */
const ORCHESTRATORS = [
  {
    file: path.join('scripts', 'lib', 'audit', 'run-persistence.mjs'),
    expect: { recordRunComplete: 'present', recordConvergenceState: 'present' },
  },
  {
    file: path.join('scripts', 'lib', 'audit', 'plan-audit-cloud.mjs'),
    expect: { recordRunComplete: 'present', recordConvergenceState: 'none' },
  },
  {
    // The spine: its cloud block was extracted into run-persistence.mjs
    // (legacy-production-audit-decomposition.md Phase 4c). Kept here as
    // `none` so a direct call cannot creep back in unscanned.
    file: path.join('scripts', 'lib', 'audit', 'legacy-production-audit.mjs'),
    expect: { recordRunComplete: 'none', recordConvergenceState: 'none' },
  },
  {
    // The CLI entry: delegates finalisation to the orchestrator; owns no write.
    file: path.join('scripts', 'openai-audit.mjs'),
    expect: { recordRunComplete: 'none', recordConvergenceState: 'none' },
  },
];

/**
 * Scan one file for one writer. Returns every call site (either spelling) with
 * whether it is awaited, so the assertion can separate "un-awaited" from
 * "nothing found" — the two outcomes this suite used to conflate.
 */
function scanCallSites(src, writer) {
  const sites = [];
  src.split('\n').forEach((line, i) => {
    // Skip comment lines — this file's own prose names these writers,
    // and so does the explanatory comment at the fixed call site.
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
    // An import/re-export names the writer without calling it.
    if (/^\s*(import|export)\b/.test(trimmed)) return;

    for (const pattern of writer.patterns) {
      const callIdx = line.indexOf(pattern);
      if (callIdx === -1) continue;
      const before = line.slice(0, callIdx);
      // `const x = await import(...)` destructuring mentions the name.
      if (/\bconst\s*\{[^}]*$/.test(before)) continue;
      // The call is fine if `await` (or a `return`, which propagates to
      // the caller's await) immediately precedes it on the same line.
      const awaited = /\b(await|return)\s+$/.test(before);
      sites.push({ line: i + 1, text: trimmed, awaited });
    }
  });
  return sites;
}

describe('run-finalisation writes are awaited', () => {
  for (const { file: rel, expect } of ORCHESTRATORS) {
    for (const writer of FINALISATION_WRITERS) {
      const expectation = expect[writer.name];
      it(`${rel} — ${writer.name}: declared ${expectation}, every call awaited`, () => {
        assert.ok(expectation === 'present' || expectation === 'none',
          `${rel} must declare 'present' or 'none' for ${writer.name}`);
        const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        const sites = scanCallSites(src, writer);

        // Vacuous-pass guard — the defect this suite had. A declared-present
        // writer with no call site means the scan is looking at the wrong file
        // (or the wrong spelling), and green here would mean nothing.
        if (expectation === 'present') {
          assert.ok(sites.length > 0,
            `${rel} declares ${writer.name} PRESENT but the scan found no call site in either\n`
            + `spelling (${writer.patterns.join(' | ')}). Either the write moved — update ORCHESTRATORS —\n`
            + `or the spelling changed — update FINALISATION_WRITERS. A pass with nothing scanned is not a pass.`);
        } else {
          assert.deepEqual(sites.map((s) => `${rel}:${s.line}: ${s.text}`), [],
            `${rel} declares ${writer.name} NONE but has call site(s). If the write legitimately\n`
            + `moved here, declare it 'present' so the await check covers it.`);
        }

        const offenders = sites.filter((s) => !s.awaited).map((s) => `${rel}:${s.line}: ${s.text}`);
        assert.deepEqual(
          offenders,
          [],
          `Un-awaited ${writer.name} call(s) — the pool runs allowExitOnIdle, so an\n`
          + `un-awaited store write is a LOST write, not merely a late one.\n`
          + `Add \`await\` (keep any .catch() — it preserves best-effort):\n`
          + offenders.join('\n'),
        );
      });
    }
  }

  it('the scanner itself sees an un-awaited call in BOTH spellings (instrument check)', () => {
    const writer = FINALISATION_WRITERS.find((w) => w.name === 'recordRunComplete');
    const src = [
      "  recordRunComplete(id, stats);",
      "  await recordRunComplete(id, stats);",
      "  durableWrite('audit.runComplete', { runId });",
      "  tallyWriteOutcomes(w, [await durableWrite('audit.runComplete', { runId })]);",
      "  // recordRunComplete( in a comment is not a call",
      "import { recordRunComplete } from './x.mjs';",
    ].join('\n');
    const sites = scanCallSites(src, writer);
    assert.deepEqual(sites.map((s) => [s.line, s.awaited]), [[1, false], [2, true], [3, false], [4, true]]);
  });

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
