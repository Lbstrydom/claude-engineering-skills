/**
 * @fileoverview The retirement predicate for `compose:'legacy'`, as a TEST.
 *
 * WHY A TEST AND NOT A COMMENT. `scripts/lib/audit/legacy-production-audit.mjs`
 * is deliberately pinned to the frozen pre-2026-08-21 composition — it is one
 * half of the tiered-recall shadow comparison, whose window is MET (33 compared
 * runs) and awaiting Phase-14 adjudication. That is a real scope boundary, but
 * a temporary exemption with no enforcement is just a permanent one that nobody
 * has noticed yet. The plan audit said so twice (R2/M3, R3/M3): a guard that
 * only checks a comment sits next to an argument enforces nothing, and a
 * trigger that fires only when a human creates a file is not an expiry.
 *
 * So this file fails in BOTH directions, and does not survive its own predicate:
 *
 *   1. decision absent, pin intact              → pass   (today's steady state)
 *   2. decision absent, pin or comment missing  → FAIL   ("lost its justification")
 *   3. decision present, OR past the backstop   → FAIL   (naming the exact edit)
 *
 * There is deliberately no fourth "retired and passing" state. Retirement is a
 * single commit that adds the decision document AND deletes the pin, the frozen
 * composition, and this file. State 3 turning main red is the forcing function,
 * not an accident.
 *
 * Design: docs/plans/repo-context-budget-honesty.md §2 (telemetry constraint,
 * item 3) and §8 (accepted debt).
 *
 * @module tests/repo-context-legacy-pin
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The artifact whose existence retires the pin. Named exactly, not by glob. */
const DECISION_DOC = 'docs/research/tiered-recall-phase14-decision.md';

/**
 * Calendar backstop. The decision-document trigger only fires when a human
 * creates that file, so on its own it is a wish rather than an expiry. This is
 * deterministic and offline on purpose: a store query for "is the cohort
 * adjudicated?" fails OPEN when the cloud is off, which is the wrong direction
 * for something whose whole job is to stop an exemption persisting.
 */
const BACKSTOP = Date.parse('2026-09-30T00:00:00Z');

/**
 * Quote-agnostic. The first cut matched single quotes only, so
 * `compose: "legacy"` or a backtick form would have slipped past the
 * spread check silently — flagged by the consolidated Gemini gate. A guard
 * whose bypass is "use a different quote character" is not a guard.
 */
const COMPOSE_LEGACY = /compose:\s*['"`]legacy['"`]/;

const PIN_SITE = 'scripts/lib/audit/legacy-production-audit.mjs';
const FROZEN_FN = 'scripts/lib/repo-context.mjs';

const RETIREMENT_EDIT = [
  'Retire the legacy repo-context pin — in ONE commit:',
  `  1. delete the \`compose: 'legacy'\` argument in ${PIN_SITE}`,
  `  2. delete \`composeLegacy()\` + the \`legacyBuild*\` helpers in ${FROZEN_FN}`,
  '  3. delete the compose:"legacy" cases in tests/repo-context.test.mjs',
  '  4. delete tests/repo-context-legacy-pin.test.mjs (this file)',
  '  See docs/plans/repo-context-budget-honesty.md §8.',
].join('\n');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

describe('legacy repo-context pin — retirement predicate', () => {
  it('fires the moment the Phase-14 decision is recorded', () => {
    assert.equal(exists(DECISION_DOC), false,
      `${DECISION_DOC} exists — the retirement trigger has fired.\n${RETIREMENT_EDIT}`);
  });

  it('fires on the calendar backstop even if nobody records a decision', () => {
    // Deliberately NOT a "skip if in the future" — that would make this case
    // pass having checked nothing, which is the failure mode the repo's
    // sandbox-honesty rule exists to prevent. It asserts a real condition that
    // becomes false on a known date.
    assert.ok(Date.now() < BACKSTOP,
      `the 2026-09-30 backstop has passed and the legacy pin is still in place.\n${RETIREMENT_EDIT}`);
  });

  it('the pin still exists and still carries its justification', () => {
    // The other direction: while the exemption is live, it must remain visible
    // and explained. A pin that loses its TEMP comment is an undocumented fork.
    const site = read(PIN_SITE);
    assert.match(site, COMPOSE_LEGACY,
      `${PIN_SITE} no longer passes compose:'legacy'. If that was the retirement, `
      + 'delete this file and composeLegacy() too — see §8.');
    assert.match(site, /TEMP — pending Phase-14 tiered decision/,
      `${PIN_SITE} passes compose:'legacy' without its TEMP justification comment.`);
    assert.match(site, new RegExp(DECISION_DOC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the pin comment must name the exact decision artifact that retires it');
  });

  it('exactly ONE call site is pinned — the exemption must not spread', () => {
    // The cost of the exemption is bounded by its blast radius. A second caller
    // reaching for `compose:'legacy'` is a new decision, not an inherited one.
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); continue; }
        if (!e.name.endsWith('.mjs')) continue;
        if (rel === `./${PIN_SITE}` || rel.endsWith('repo-context.mjs')) continue;
        if (rel.includes('/tests/') || rel.startsWith('./tests')) continue;
        if (COMPOSE_LEGACY.test(read(rel.slice(2)))) offenders.push(rel.slice(2));
      }
    };
    walk('./scripts');
    assert.deepEqual(offenders, [],
      `compose:'legacy' must have exactly one caller (${PIN_SITE}); also found: ${offenders.join(', ')}`);
  });

  it('the frozen composition is still frozen — it has not grown features', () => {
    // "Frozen" is the claim that makes a second code path acceptable. If
    // someone maintains or extends composeLegacy, the justification for keeping
    // it evaporates and it should simply be deleted instead.
    const src = read(FROZEN_FN);
    assert.match(src, /FROZEN LEGACY COMPOSITION — do not maintain, do not extend/,
      'composeLegacy lost its frozen banner');
    assert.match(src, /function composeLegacy\(/, 'composeLegacy is gone but the pin remains');
  });
});
