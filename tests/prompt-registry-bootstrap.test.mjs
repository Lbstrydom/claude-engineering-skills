/**
 * @fileoverview The seed must actually REACH the model.
 *
 * `bootstrapFromConstants` used to promote only when no default alias existed,
 * so the alias pinned the first seed a machine ever saw and every later edit to
 * `prompt-seeds.mjs` was silently inert. `.audit/prompt-revisions/` is
 * gitignored per-machine state, so a fresh clone ran the new seed while an
 * established machine ran an old one — same source, two behaviours, no signal.
 *
 * Found live: every active revision was `source: 'bootstrap'` (nothing had ever
 * been evolved), and the backend PERSISTENCE CONTRACT block (jsonb/RLS) plus the
 * frontend DERIVED-STATE PARITY block (a P0 that escaped both /audit-code and
 * the Gemini gate) had never run on this machine — roughly half of each rubric
 * was dead text.
 *
 * The pre-existing rule tests assert the text is in `PASS_PROMPTS.<pass>` — the
 * SEED — which cannot detect this: the seed was always correct; it just wasn't
 * what ran. These assert the RUNNING prompt instead.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// REVISIONS_DIR is resolved from cwd at module load, so each case runs inside
// its own temp cwd and the module is re-imported per case to re-resolve it.
const ORIGINAL_CWD = process.cwd();
const tmpDirs = [];
function mkCwd(label) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `preg-${label}-`)));
  tmpDirs.push(d);
  process.chdir(d);
  return d;
}
async function freshRegistry() {
  // Cache-bust so REVISIONS_DIR re-resolves against the current cwd.
  return import(`../scripts/lib/prompt-registry.mjs?t=${tmpDirs.length}-${Math.random()}`);
}
after(() => {
  process.chdir(ORIGINAL_CWD);
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

describe('bootstrapFromConstants — an edited seed must reach the model', () => {
  it('promotes a CHANGED seed over the older seed it already bootstrapped', async () => {
    mkCwd('changed');
    const reg = await freshRegistry();

    reg.bootstrapFromConstants({ backend: 'RUBRIC v1' });
    assert.equal(reg.getActivePrompt('backend'), 'RUBRIC v1');

    // The seed gains a rule — exactly the PERSISTENCE CONTRACT scenario.
    reg.bootstrapFromConstants({ backend: 'RUBRIC v1\nPERSISTENCE CONTRACT: flag silent write failures' });

    assert.equal(
      reg.getActivePrompt('backend'),
      'RUBRIC v1\nPERSISTENCE CONTRACT: flag silent write failures',
      'a seed edit must take effect — otherwise the rubric is dead text on every established machine',
    );
  });

  it('is idempotent — re-bootstrapping an unchanged seed changes nothing', async () => {
    mkCwd('idem');
    const reg = await freshRegistry();
    reg.bootstrapFromConstants({ backend: 'RUBRIC v1' });
    const first = reg.getActiveRevisionId('backend');
    reg.bootstrapFromConstants({ backend: 'RUBRIC v1' });
    assert.equal(reg.getActiveRevisionId('backend'), first);
  });

  it('does NOT clobber a deliberately promoted (evolved/operator) revision', async () => {
    // The seed is the default, not an override. A revision promoted by anything
    // other than bootstrap is someone's decision and must survive a seed edit.
    mkCwd('evolved');
    const reg = await freshRegistry();
    reg.bootstrapFromConstants({ backend: 'RUBRIC v1' });

    const evolvedId = reg.revisionId('EVOLVED RUBRIC');
    reg.saveRevision('backend', evolvedId, 'EVOLVED RUBRIC', { source: 'evolve', createdAt: Date.now() });
    reg.promoteRevision('backend', evolvedId);

    reg.bootstrapFromConstants({ backend: 'RUBRIC v2 — a new seed' });

    assert.equal(reg.getActivePrompt('backend'), 'EVOLVED RUBRIC', 'a deliberate promotion outranks the seed');
  });

  it('falls back to the seed when the alias dangles', async () => {
    mkCwd('dangling');
    const reg = await freshRegistry();
    reg.bootstrapFromConstants({ backend: 'RUBRIC v1' });
    // Point the alias at a revision that does not exist.
    fs.writeFileSync(
      path.join(process.cwd(), '.audit', 'prompt-revisions', 'backend', 'default.json'),
      JSON.stringify({ revisionId: 'rev-deadbeef0000' }),
    );

    reg.bootstrapFromConstants({ backend: 'RUBRIC v1' });

    assert.equal(reg.getActivePrompt('backend'), 'RUBRIC v1', 'an unreadable alias must not pin a dead prompt');
  });
});

describe('the RUNNING prompt carries the rules the seed declares', () => {
  it('every pass runs exactly its seed after bootstrap', async () => {
    // The assertion that would have caught the real defect. The existing rule
    // tests check PASS_PROMPTS.<pass> (the seed), which was always correct —
    // it simply was not what getPassPrompt() returned.
    mkCwd('running');
    const reg = await freshRegistry();
    const { PASS_PROMPTS } = await import('../scripts/lib/prompt-seeds.mjs');

    reg.bootstrapFromConstants(PASS_PROMPTS);

    for (const [pass, seed] of Object.entries(PASS_PROMPTS)) {
      assert.equal(reg.getActivePrompt(pass), seed, `${pass}: the running prompt must equal its seed`);
    }
    assert.ok(
      reg.getActivePrompt('backend').includes('PERSISTENCE CONTRACT'),
      'the jsonb/RLS rule must actually run, not merely exist in source',
    );
    assert.ok(
      reg.getActivePrompt('frontend').includes('DERIVED-STATE PARITY'),
      'the escaped-P0 rule must actually run, not merely exist in source',
    );
  });
});
