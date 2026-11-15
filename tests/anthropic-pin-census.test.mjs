/**
 * The pin census: no seam call site may pass a param the `cli` backend cannot
 * honour without a literal `{backend:'sdk'}` pin.
 *
 * **Why this suite and not the runtime throw.** The seam throws at run time,
 * but CI runs the committed default (`sdk`), so the throw can never fire there:
 * a new unpinned `system`-passing site ships green and breaks only on the
 * machines that set `CLAUDE_BACKEND=cli` — which is where this repo is used. A
 * refusal no CI run can reach is not a guard. This is the guard.
 *
 * **The positive control is the point.** `classifyPinningInSource` is pure, so
 * a planted source string can be fed to it; a scanner that silently matched
 * nothing would otherwise print "clean" over a repo full of violations, which
 * is the vacuous-pass case (verification-discipline §3) that four audit rounds
 * of this very change kept finding. Every assertion about the real repo being
 * clean is therefore paired with a planted source that must come back dirty.
 *
 * @module tests/anthropic-pin-census
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyPinningInSource,
  unserviceableParamsInSource,
  indirectPinHolds,
  auditPinCensus,
} from '../scripts/lib/anthropic-pin-census.mjs';
import { trackedScriptFiles } from '../scripts/check-anthropic-pins.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.anthropic-pin-census.json'), 'utf8'));
const SEAM_MODULE = 'scripts/lib/anthropic-client.mjs';

/** The gate's own corpus, built the same way the CLI builds it. */
function repoSources() {
  const sources = new Map();
  for (const rel of trackedScriptFiles(REPO_ROOT)) {
    if (rel === SEAM_MODULE) continue;
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    if (!text.includes('createAnthropicClient')) continue;
    sources.set(rel, text);
  }
  return sources;
}

describe('classifyPinningInSource: planted sources (the positive control)', () => {
  it('RED: an unpinned construction plus `system` is a Rule A violation', () => {
    const planted = `
      import { createAnthropicClient } from './lib/anthropic-client.mjs';
      const client = await createAnthropicClient();
      await client.messages.create({
        model: 'm', max_tokens: 10,
        system: 'be brief',
        messages: [{ role: 'user', content: 'x' }],
      });
    `;
    const c = classifyPinningInSource(planted);
    assert.equal(c.unpinned, 1);
    assert.deepEqual(c.unserviceable, ['system']);
    assert.equal(c.ruleAViolation, true, 'a scanner that misses this is inert');
  });

  it('RED: `tools` and `tool_choice` are caught the same way', () => {
    const planted = `
      const c = await createAnthropicClient({ redactor: null });
      await c.messages.create({ tools: [], tool_choice: { type: 'auto' } });
    `;
    const c = classifyPinningInSource(planted);
    assert.equal(c.ruleAViolation, true);
    assert.deepEqual(c.unserviceable, ['tools', 'tool_choice']);
  });

  it('GREEN: the same call with a literal pin is clean', () => {
    const planted = `
      const client = await createAnthropicClient({ backend: 'sdk' });
      await client.messages.create({ system: 'be brief' });
    `;
    const c = classifyPinningInSource(planted);
    assert.equal(c.unpinned, 0);
    assert.equal(c.ruleAViolation, false);
  });

  it('GREEN: an unpinned construction that passes no unserviceable param is clean', () => {
    const planted = `
      const client = await createAnthropicClient();
      await client.messages.create({ model: 'm', max_tokens: 10, messages: [] });
    `;
    const c = classifyPinningInSource(planted);
    assert.equal(c.unpinned, 1);
    assert.equal(c.ruleAViolation, false, 'cli serves this faithfully — flagging it would move spend for nothing');
  });

  it('a FORWARDED backend reads as unpinned — the gate cannot check a variable', () => {
    const planted = `
      const backend = someCondition ? 'sdk' : undefined;
      const client = await createAnthropicClient(backend ? { backend } : {});
      await client.messages.create({ system: 'be brief' });
    `;
    const c = classifyPinningInSource(planted);
    assert.equal(c.unpinned, 1, 'accepting `{ backend }` would be accepting a claim about a value');
    assert.equal(c.ruleAViolation, true);
  });

  it('`bedrock` counts as a pin — it is a declared transport, not the ambient one', () => {
    const c = classifyPinningInSource("await createAnthropicClient({ backend: 'bedrock' });");
    assert.equal(c.unpinned, 0);
  });

  it('a param named only in a COMMENT or JSDoc does not count', () => {
    const planted = `
      /** @param {string} system - the system prompt, which cli ignores */
      // system: 'be brief'  <- documented, not sent
      const client = await createAnthropicClient();
      await client.messages.create({ model: 'm', messages: [] });
    `;
    const c = classifyPinningInSource(planted);
    assert.deepEqual(c.unserviceable, [], 'prose about a param is not a param');
    assert.equal(c.ruleAViolation, false);
  });

  it('unserviceableParamsInSource keys on a property position, not a bare word', () => {
    assert.deepEqual(unserviceableParamsInSource('const system = 1; use(system);'), []);
    assert.deepEqual(unserviceableParamsInSource('x({ system: y })'), ['system']);
    assert.deepEqual(unserviceableParamsInSource('x({ tool_choice: y })'), ['tool_choice']);
  });
});

describe('indirectPinHolds: the one escape, and it is verified', () => {
  it('holds when the named function contains the literal pin', () => {
    const src = "function clientOptions() { return { backend: 'sdk', azureRoute: r }; }";
    assert.deepEqual(indirectPinHolds(src, 'clientOptions'), { found: true, pinned: true });
  });

  it('RED: a named function with no pin does NOT hold', () => {
    const src = 'function clientOptions() { return { azureRoute: r }; }';
    assert.deepEqual(indirectPinHolds(src, 'clientOptions'), { found: true, pinned: false });
  });

  it('RED: a `via` naming a function the file does not define does NOT hold', () => {
    assert.deepEqual(indirectPinHolds('const x = 1;', 'clientOptions'), { found: false, pinned: false });
  });

  // The claim is scoped: a pin in a LATER function cannot satisfy it. Without
  // brace matching the escape would be "somewhere in this file there is a pin",
  // which is not what the entry claims.
  it('a pin in a DIFFERENT function does not satisfy the claim', () => {
    const src = `
      function clientOptions() { return { azureRoute: r }; }
      function other() { return { backend: 'sdk' }; }
    `;
    assert.equal(indirectPinHolds(src, 'clientOptions').pinned, false);
  });

  it('an arrow-function form is recognised', () => {
    const src = "const clientOptions = () => ({ backend: 'sdk' });";
    assert.equal(indirectPinHolds(src, 'clientOptions').found, true);
  });
});

describe('auditPinCensus: the drift rules', () => {
  const ok = { unpinnedConstructions: {}, indirectPins: {} };

  it('an undeclared unpinned construction fails', () => {
    const v = auditPinCensus(new Map([['a.mjs', 'await createAnthropicClient();']]), ok);
    assert.equal(v.ok, false);
    assert.deepEqual(v.undeclared, ['a.mjs']);
  });

  it('a declared one passes', () => {
    const v = auditPinCensus(
      new Map([['a.mjs', 'await createAnthropicClient();']]),
      { unpinnedConstructions: { 'a.mjs': { reason: 'serviceable: no system/tools sent' } } },
    );
    assert.equal(v.ok, true);
  });

  it('a declaration with an empty reason fails — the reason IS the record', () => {
    const v = auditPinCensus(
      new Map([['a.mjs', 'await createAnthropicClient();']]),
      { unpinnedConstructions: { 'a.mjs': { reason: '  ' } } },
    );
    assert.equal(v.ok, false);
    assert.deepEqual(v.declaredWithoutReason, ['a.mjs']);
  });

  // A SHRINK FAILS TOO, the same way size:ratchet:gate's does: an entry for a
  // file that no longer constructs an unpinned client is a claim about nothing,
  // and leaving it makes the list look like coverage it no longer provides.
  it('a stale declaration fails and asks for a re-baseline', () => {
    const v = auditPinCensus(
      new Map([['a.mjs', "await createAnthropicClient({ backend: 'sdk' });"]]),
      { unpinnedConstructions: { 'a.mjs': { reason: 'r' } } },
    );
    assert.equal(v.ok, false);
    assert.deepEqual(v.stale, ['a.mjs']);
  });

  it('NO ENTRY EXCUSES RULE A: declaring an unpinned+system file still fails', () => {
    const v = auditPinCensus(
      new Map([['a.mjs', "await createAnthropicClient();\nx({ system: 'be brief' });"]]),
      { unpinnedConstructions: { 'a.mjs': { reason: 'I promise it is fine' } } },
    );
    assert.equal(v.ok, false);
    assert.equal(v.ruleA.length, 1, 'Rule A is not declarable away');
  });

  it('a broken indirect claim fails', () => {
    const v = auditPinCensus(
      new Map([['a.mjs', "function opts() { return {}; }\nawait createAnthropicClient(opts());\nx({ system: 's' });"]]),
      { indirectPins: { 'a.mjs': { via: 'opts', reason: 'r' } } },
    );
    assert.equal(v.ok, false);
    assert.equal(v.brokenIndirect.length, 1);
    assert.match(v.brokenIndirect[0].why, /no literal backend pin/);
  });

  it('a holding indirect claim passes even with `system` present', () => {
    const v = auditPinCensus(
      new Map([['a.mjs', "function opts() { return { backend: 'sdk' }; }\nawait createAnthropicClient(opts());\nx({ system: 's' });"]]),
      { indirectPins: { 'a.mjs': { via: 'opts', reason: 'r' } } },
    );
    assert.equal(v.ok, true);
  });

  it('a stale indirect claim fails too', () => {
    const v = auditPinCensus(
      new Map([['a.mjs', "await createAnthropicClient({ backend: 'sdk' });"]]),
      { indirectPins: { 'a.mjs': { via: 'opts', reason: 'r' } } },
    );
    assert.equal(v.ok, false);
    assert.deepEqual(v.staleIndirect, ['a.mjs']);
  });
});

describe('the REPO is clean against its committed baseline', () => {
  it('the corpus is non-empty — an empty one is a broken enumeration, not a pass', () => {
    const sources = repoSources();
    assert.ok(sources.size > 10, `expected many seam users, got ${sources.size}`);
  });

  it('no file both constructs an unpinned client and passes an unserviceable param', () => {
    const v = auditPinCensus(repoSources(), BASELINE);
    assert.deepEqual(v.ruleA, [], 'Rule A violations: pin those call sites');
  });

  it('every unpinned construction is declared, and every declaration still applies', () => {
    const v = auditPinCensus(repoSources(), BASELINE);
    assert.deepEqual(v.undeclared, []);
    assert.deepEqual(v.stale, []);
    assert.deepEqual(v.declaredWithoutReason, []);
    assert.deepEqual(v.brokenIndirect, []);
    assert.deepEqual(v.staleIndirect, []);
    assert.equal(v.ok, true);
  });

  // The four sites the rework pinned, asserted BY NAME. The census above would
  // stay green if one of them lost its pin AND its `system` in the same edit;
  // these say the pin is there, on the site the measurement was about.
  it('the four system-passing sites named in the audit are pinned', () => {
    const named = [
      'scripts/lib/arm-eval/judge.mjs',
      'scripts/lib/work-unit-labels.mjs',
      'scripts/refine-prompts.mjs',
      'scripts/lib/context.mjs',
    ];
    for (const rel of named) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      const c = classifyPinningInSource(text);
      assert.ok(c.unserviceable.includes('system'), `${rel} should still pass \`system\``);
      assert.equal(c.unpinned, 0, `${rel} must pin every construction`);
    }
  });

  // The two the census FOUND that the brief's list did not, both via a handoff
  // or a forwarded variable — the shapes a file-local read misses.
  it('the two sites the census added are pinned too', () => {
    for (const rel of ['scripts/evolve-prompts.mjs', 'scripts/solo-control-audit.mjs']) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      assert.equal(classifyPinningInSource(text).unpinned, 0, `${rel} must pin every construction`);
    }
  });

  it('no file reads the removed CLAUDE_CLI_STRICT_MAX_TOKENS', () => {
    const offenders = [];
    for (const rel of trackedScriptFiles(REPO_ROOT)) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      if (/process\.env\.CLAUDE_CLI_STRICT_MAX_TOKENS/.test(text)) offenders.push(rel);
    }
    assert.deepEqual(offenders, [], 'the strict path was removed; a live read of it is a leftover dial');
  });
});
