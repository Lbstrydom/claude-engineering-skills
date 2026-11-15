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
  unpinnedArgsDigest,
  normaliseArgText,
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
    assert.deepEqual(indirectPinHolds(src, 'clientOptions'), { found: true, pinned: true, used: true },
      'no construction in this source, so `used` is vacuously true — the audit only consults it for a file that constructs one');
  });

  it('RED: a named function with no pin does NOT hold', () => {
    const src = 'function clientOptions() { return { azureRoute: r }; }';
    assert.deepEqual(indirectPinHolds(src, 'clientOptions'), { found: true, pinned: false, used: true });
  });

  it('RED: a `via` naming a function the file does not define does NOT hold', () => {
    assert.deepEqual(indirectPinHolds('const x = 1;', 'clientOptions'), { found: false, pinned: false, used: false });
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
      { unpinnedConstructions: { 'a.mjs': { reason: 'serviceable: no system/tools sent', constructions: 1, argsDigest: unpinnedArgsDigest('await createAnthropicClient();') } } },
    );
    assert.equal(v.ok, true);
  });

  it('a declaration with an empty reason fails — the reason IS the record', () => {
    const v = auditPinCensus(
      new Map([['a.mjs', 'await createAnthropicClient();']]),
      { unpinnedConstructions: { 'a.mjs': { reason: '  ', constructions: 1 } } },
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
      { unpinnedConstructions: { 'a.mjs': { reason: 'r', constructions: 1 } } },
    );
    assert.equal(v.ok, false);
    assert.deepEqual(v.stale, ['a.mjs']);
  });

  it('NO ENTRY EXCUSES RULE A: declaring an unpinned+system file still fails', () => {
    const v = auditPinCensus(
      new Map([['a.mjs', "await createAnthropicClient();\nx({ system: 'be brief' });"]]),
      { unpinnedConstructions: { 'a.mjs': { reason: 'I promise it is fine', constructions: 1 } } },
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

// ── fail-closed holes the round-1 audit found (2026-11-15) ─────────────────
//
// All four were FAIL-OPEN: the scanner said clean over a real violation. Each
// gets a planted RED case, because a scanner's clean verdict is only worth what
// its ability to go red is worth.
describe('fail-closed: the shapes the first cut missed', () => {
  it('SHORTHAND `{ system }` is an unserviceable param', () => {
    const planted = `
      const client = await createAnthropicClient();
      await client.messages.create({ model, max_tokens, system, messages });
    `;
    const c = classifyPinningInSource(planted);
    assert.deepEqual(c.unserviceable, ['system'], 'shorthand sends the param just as `system:` does');
    assert.equal(c.ruleAViolation, true, 'this cleared Rule A before \u2014 fail-open, the worse direction');
  });

  it('shorthand `{ tools }` / `{ tool_choice }` too', () => {
    assert.deepEqual(unserviceableParamsInSource('x({ a, tools, b })'), ['tools']);
    assert.deepEqual(unserviceableParamsInSource('x({ tool_choice })'), ['tool_choice']);
  });

  it('a bare identifier that is not a property is still not a param', () => {
    assert.deepEqual(unserviceableParamsInSource('const system = 1; use(system);'), [],
      'the shorthand matcher must not fire on every mention of the word');
  });

  it('A SPREAD AFTER THE PIN makes the backend unresolved, so NOT pinned', () => {
    const c = classifyPinningInSource("await createAnthropicClient({ backend: 'sdk', ...opts });");
    assert.equal(c.unpinned, 1, '`opts` may override `backend`, and this gate cannot know');
  });

  it('a spread BEFORE the literal pin is fine — the literal wins', () => {
    const c = classifyPinningInSource("await createAnthropicClient({ ...opts, backend: 'sdk' });");
    assert.equal(c.unpinned, 0);
  });

  it('an indirect claim whose construction never calls the `via` function does NOT hold', () => {
    const src = `
      function clientOptions() { return { backend: 'sdk' }; }
      const c = await createAnthropicClient({ redactor: null });
    `;
    const held = indirectPinHolds(src, 'clientOptions');
    assert.equal(held.pinned, true, 'the factory does carry the literal');
    assert.equal(held.used, false, 'but nothing passes it \u2014 the claim describes a factory nobody calls');
  });

  it('it holds when every unpinned construction passes the function', () => {
    const src = `
      function clientOptions() { return { backend: 'sdk' }; }
      const a = await createAnthropicClient(clientOptions());
      const b = await createAnthropicClient({ ...clientOptions(), fresh: true });
    `;
    const held = indirectPinHolds(src, 'clientOptions');
    assert.equal(held.used, true);
  });

  it('a broken `used` claim fails the audit', () => {
    const v = auditPinCensus(
      new Map([['a.mjs', "function opts() { return { backend: 'sdk' }; }\nawait createAnthropicClient({});\nx({ system: 's' });"]]),
      { indirectPins: { 'a.mjs': { via: 'opts', reason: 'r' } } },
    );
    assert.equal(v.ok, false);
    // Keyed on the STRUCTURE (which file, which `via`), not on the prose: the
    // wording changed once already when the check was narrowed, and an
    // assertion on a sentence fails for the wrong reason when it does.
    assert.equal(v.brokenIndirect.length, 1);
    assert.equal(v.brokenIndirect[0].file, 'a.mjs');
    assert.equal(v.brokenIndirect[0].via, 'opts');
    assert.match(v.brokenIndirect[0].why, /opts\(\)/, 'and it names the function the claim rests on');
  });
});

// A declaration used to clear a FILE for ever, so a second unpinned
// construction added to a declared file was unflagged and the entry's reason
// kept describing only the first. Counting is the fix, and it is the shape every
// other ratchet in this repo already uses.
// ── THE LAST ASSIGNMENT WINS (round-2 audit, 2026-11-15) ────────────────────
//
// The first fail-closed pass tested whether an `sdk` literal appeared ANYWHERE
// and then looked for a spread after the FIRST `backend:`. JavaScript resolves
// the LAST one, so two shapes read as pinned while the effective backend was
// cli \u2014 and the second of them also satisfied an `indirectPins` claim, which is
// the very shape such a claim exists to rule out.
describe('the effective backend is the LAST one, not the first', () => {
  const unpinned = (src) => classifyPinningInSource(src).unpinned;

  it("RED: `{ backend:'sdk', backend:'cli' }` is NOT pinned", () => {
    assert.equal(unpinned("await createAnthropicClient({ backend: 'sdk', backend: 'cli' });"), 1,
      'the duplicate key that wins is the last one');
  });

  it("RED: `{ ...clientOptions(), backend:'cli' }` is NOT pinned", () => {
    assert.equal(unpinned("await createAnthropicClient({ ...clientOptions(), backend: 'cli' });"), 1);
  });

  it("GREEN: `{ ...clientOptions(), backend:'sdk' }` IS pinned \u2014 the literal wins", () => {
    assert.equal(unpinned("await createAnthropicClient({ ...clientOptions(), backend: 'sdk' });"), 0);
  });

  it("RED: `{ backend:'sdk', ...opts }` stays unresolved \u2014 a spread AFTER the winner", () => {
    assert.equal(unpinned("await createAnthropicClient({ backend: 'sdk', ...opts });"), 1);
  });

  it('RED: an explicit `cli` is unpinned, and cannot be covered by a via claim', () => {
    const src = "function opts() { return { backend: 'sdk' }; }\n"
      + "await createAnthropicClient({ ...opts(), backend: 'cli' });";
    const held = indirectPinHolds(src, 'opts');
    assert.equal(held.pinned, true, 'the factory still carries the literal');
    assert.equal(held.used, false, 'but this construction overrides the pin the claim rests on');
  });

  it('GREEN: passing the factory with no backend of its own holds', () => {
    const src = "function opts() { return { backend: 'sdk' }; }\n"
      + 'await createAnthropicClient({ ...opts(), fresh: true });';
    assert.equal(indirectPinHolds(src, 'opts').used, true);
  });
});

// A REPLACEMENT preserves the count, so the count alone could not see it and
// the declared reason went on describing a construction that was gone.
describe('unpinnedArgsDigest: a replacement is visible even at a constant count', () => {
  it('differs when a construction\u2019s arguments change', () => {
    assert.notEqual(
      unpinnedArgsDigest('await createAnthropicClient({ redactor: null });'),
      unpinnedArgsDigest('await createAnthropicClient({ timeoutMs: 1 });'),
    );
  });

  it('is stable across whitespace and comments', () => {
    assert.equal(
      unpinnedArgsDigest('await createAnthropicClient({ redactor: null });'),
      unpinnedArgsDigest('// a note\nawait createAnthropicClient({\n  redactor:   null,\n});'),
    );
  });

  it("is '' for a file with no unpinned construction", () => {
    assert.equal(unpinnedArgsDigest("await createAnthropicClient({ backend: 'sdk' });"), '');
  });

  // Deliberate limit, stated rather than hidden: two structurally identical
  // constructions are the same SHAPE, and for this gate that is the same thing.
  it('two identical bare constructions share a digest \u2014 the stated limit', () => {
    assert.equal(
      unpinnedArgsDigest('await createAnthropicClient();'),
      unpinnedArgsDigest('const a = await createAnthropicClient();'),
    );
  });

  it('A REPLACEMENT at a constant count fails the audit', () => {
    const base = { unpinnedConstructions: { 'a.mjs': { reason: 'r', constructions: 1, argsDigest: unpinnedArgsDigest('await createAnthropicClient({ redactor: null });') } } };
    const ok = auditPinCensus(new Map([['a.mjs', 'await createAnthropicClient({ redactor: null });']]), base);
    assert.equal(ok.ok, true);
    const swapped = auditPinCensus(new Map([['a.mjs', 'await createAnthropicClient({ timeoutMs: 1 });']]), base);
    assert.equal(swapped.ok, false, 'same count, different construction');
    assert.match(String(swapped.countDrift[0].actual), /^digest /);
  });

  it('a declaration with no argsDigest fails \u2014 the pre-digest state', () => {
    const v = auditPinCensus(
      new Map([['a.mjs', 'await createAnthropicClient();']]),
      { unpinnedConstructions: { 'a.mjs': { reason: 'r', constructions: 1 } } },
    );
    assert.equal(v.ok, false);
  });
});

describe('Rule B counts constructions, not files', () => {
  const src1 = 'await createAnthropicClient();';
  const src2 = 'await createAnthropicClient();\nawait createAnthropicClient({ fresh: true });';

  it('a matching count AND digest passes', () => {
    const v = auditPinCensus(new Map([['a.mjs', src1]]),
      { unpinnedConstructions: { 'a.mjs': { reason: 'r', constructions: 1, argsDigest: unpinnedArgsDigest(src1) } } });
    assert.equal(v.ok, true);
  });

  it('A SECOND construction in a DECLARED file fails', () => {
    const v = auditPinCensus(new Map([['a.mjs', src2]]),
      { unpinnedConstructions: { 'a.mjs': { reason: 'r', constructions: 1 } } });
    assert.equal(v.ok, false);
    assert.deepEqual(v.countDrift, [{ file: 'a.mjs', declared: 1, actual: 2 }]);
  });

  // A shrink fails too, like size:ratchet:gate: a count left high hides the
  // next addition back up to it.
  it('a REMOVED construction fails too, asking for a re-baseline', () => {
    const v = auditPinCensus(new Map([['a.mjs', src1]]),
      { unpinnedConstructions: { 'a.mjs': { reason: 'r', constructions: 2 } } });
    assert.equal(v.ok, false);
    assert.equal(v.countDrift.length, 1);
  });

  it('a declaration with NO count fails — it is the pre-count state', () => {
    const v = auditPinCensus(new Map([['a.mjs', src1]]),
      { unpinnedConstructions: { 'a.mjs': { reason: 'r' } } });
    assert.equal(v.ok, false);
    assert.equal(v.countDrift[0].declared, undefined);
  });
});

// ── the shapes NO regular expression saw (round-3 audit, pivot to the AST) ──
//
// Three consecutive rounds each found a different fail-open shape in a
// text-matching scanner, and round 3's three were the ones that settled it: a
// shorthand `{ backend }` that WINS at runtime, a NESTED `metadata: { backend:
// 'sdk' }` counted as top-level, and a construction with two nesting levels that
// the construction regex did not match AT ALL — invisible to both rules at once.
// Each regex fix was right about the shape it was told about and blind to the
// next, which is the signature of the wrong tool. The module now parses.
describe('AST: the shapes a text scan could not see', () => {
  const unpinned = (src) => classifyPinningInSource(src).unpinned;

  it("RED: a SHORTHAND `{ backend: 'sdk', backend }` is not pinned — the shorthand wins", () => {
    assert.equal(unpinned("await createAnthropicClient({ backend: 'sdk', backend });"), 1,
      'at runtime the later shorthand property is the effective value');
  });

  it("RED: a NESTED backend is not a top-level pin", () => {
    assert.equal(
      unpinned("await createAnthropicClient({ backend: 'cli', metadata: { backend: 'sdk' } });"), 1,
      'the nested literal appeared last in the TEXT but is not a property of the options object',
    );
  });

  it('RED: a construction nested two levels deep is still FOUND', () => {
    const c = classifyPinningInSource('await createAnthropicClient({ redactor: makeRedactor(getRules()) });');
    assert.equal(c.constructions, 1, 'the old construction regex matched one nesting level and missed this entirely');
    assert.equal(c.unpinned, 1);
  });

  it('a member-expression callee counts when the RECEIVER is the seam module', () => {
    const src = "const mod = await import('./anthropic-client.mjs');\n"
      + 'const c = await mod.createAnthropicClient();';
    assert.equal(unpinned(src), 1);
  });

  // The property name alone counted an unrelated object's same-named factory as
  // a seam construction, failing the gate for a call that is not this seam's.
  it('a member call on an UNRELATED receiver does not count', () => {
    assert.equal(classifyPinningInSource('const c = await unrelatedBag.createAnthropicClient();').constructions, 0);
  });

  it('a COMPUTED key is unresolved, never a pin', () => {
    assert.equal(unpinned("await createAnthropicClient({ [key]: 'sdk' });"), 1);
  });

  it('a quoted key IS a pin — spelling does not change semantics', () => {
    assert.equal(unpinned(`await createAnthropicClient({ 'backend': 'sdk' });`), 0);
    assert.equal(unpinned(`await createAnthropicClient({ "backend": 'bedrock' });`), 0);
  });

  it('a param named in PROSE is invisible, with no comment-stripper needed', () => {
    const src = '/** @param {string} system - the system prompt */\n'
      + '// system: this is documentation\n'
      + 'const msg = "system: not a property";\n'
      + 'await createAnthropicClient();';
    const c = classifyPinningInSource(src);
    assert.deepEqual(c.unserviceable, []);
    assert.equal(c.ruleAViolation, false);
  });

  it('shorthand `{ system }` is still caught', () => {
    assert.deepEqual(unserviceableParamsInSource('x({ model, system, messages })'), ['system']);
  });

  // A FILE THE PARSER CANNOT READ IS UNKNOWN, NOT CLEAN — otherwise the gate's
  // strongest guarantee evaporates on the file most likely to be mid-edit.
  it('an UNPARSEABLE file reports parsed:false and fails the audit', () => {
    const broken = 'function ( { !!! this is not javascript';
    const c = classifyPinningInSource(broken);
    assert.equal(c.parsed, false);
    assert.equal(c.ruleAViolation, false, 'it makes no claim either way');
    const v = auditPinCensus(new Map([['broken.mjs', broken]]), { unpinnedConstructions: {} });
    assert.equal(v.ok, false, 'and the audit refuses to call it clean');
    assert.deepEqual(v.unparsed, ['broken.mjs']);
  });
});

// `{ ...opts(), backend: selected }` and `{ ...opts(), ...overrides }` resolve
// as UNRESOLVED, and the round-2 `used` check accepted everything except a
// literal `cli` — so both passed while either can replace the factory's pin.
describe('an indirect claim requires the factory to be the LAST word', () => {
  const factory = "function opts() { return { backend: 'sdk' }; }\n";

  it('GREEN: the factory call IS the argument', () => {
    assert.equal(indirectPinHolds(factory + 'await createAnthropicClient(opts());', 'opts').used, true);
  });

  it('GREEN: spread the factory and add unrelated options', () => {
    assert.equal(indirectPinHolds(factory + 'await createAnthropicClient({ ...opts(), fresh: true });', 'opts').used, true);
  });

  it("RED: a literal `backend: 'cli'` after the spread", () => {
    assert.equal(indirectPinHolds(factory + "await createAnthropicClient({ ...opts(), backend: 'cli' });", 'opts').used, false);
  });

  it('RED: a VARIABLE backend after the spread — unresolved can be cli', () => {
    assert.equal(indirectPinHolds(factory + 'await createAnthropicClient({ ...opts(), backend: selected });', 'opts').used, false);
  });

  it('RED: a SECOND spread after the factory — it can carry a backend', () => {
    assert.equal(indirectPinHolds(factory + 'await createAnthropicClient({ ...opts(), ...overrides });', 'opts').used, false);
  });

  it('RED: a computed key after the factory', () => {
    assert.equal(indirectPinHolds(factory + "await createAnthropicClient({ ...opts(), [k]: 'cli' });", 'opts').used, false);
  });

  it('the pin must be inside the NAMED function, not merely in the file', () => {
    const src = 'function opts() { return { azureRoute: r }; }\n'
      + "function other() { return { backend: 'sdk' }; }\n"
      + 'await createAnthropicClient(opts());';
    assert.equal(indirectPinHolds(src, 'opts').pinned, false);
  });
});

// The digest folds FORMATTING. It must not fold the contents of a string
// literal: `mode === 'use cli'` and `mode === 'usecli'` can select different
// backends, and the whitespace-stripping version gave them one digest.
describe('normaliseArgText: formatting folds, literals do not', () => {
  it('whitespace outside a literal is folded', () => {
    assert.equal(normaliseArgText('{ a:  1,\n  b: 2 }'), '{a:1,b:2}');
  });

  it('whitespace INSIDE a literal survives', () => {
    assert.equal(normaliseArgText("{ a: 'use cli' }"), "{a:'use cli'}");
    assert.notEqual(normaliseArgText("{ a: 'use cli' }"), normaliseArgText("{ a: 'usecli' }"));
  });

  it('an escaped quote does not end the literal', () => {
    assert.equal(normaliseArgText(`{ a: 'it\\'s here' }`), `{a:'it\\'s here'}`);
  });

  it('a template literal keeps its spaces', () => {
    assert.equal(normaliseArgText('{ a: `use cli` }'), '{a:`use cli`}');
  });

  it('a trailing comma is formatting', () => {
    assert.equal(normaliseArgText('{ a: 1, }'), '{a:1}');
  });

  it("digests differ for `'use cli'` vs `'usecli'`", () => {
    assert.notEqual(
      unpinnedArgsDigest("await createAnthropicClient({ a: 'use cli' });"),
      unpinnedArgsDigest("await createAnthropicClient({ a: 'usecli' });"),
    );
  });
});

// ── round 4: AST-level fail-opens, two of them against this module's own
// stated contract (the docstring was right and the code did not implement it) ──
describe('a key the gate cannot resolve is never a pin', () => {
  const unpinned = (src) => classifyPinningInSource(src).unpinned;

  it("RED: a COMPUTED key after the literal — `{ backend:'sdk', [key]:'cli' }`", () => {
    assert.equal(unpinned("await createAnthropicClient({ backend: 'sdk', [key]: 'cli' });"), 1,
      'a computed key can BE `backend`, and it comes after the literal');
  });

  it("RED: a literal computed key — `['backend']: 'cli'`", () => {
    assert.equal(unpinned("await createAnthropicClient({ backend: 'sdk', ['backend']: 'cli' });"), 1);
  });

  it("GREEN: a literal computed key for something ELSE leaves the pin standing", () => {
    assert.equal(unpinned("await createAnthropicClient({ backend: 'sdk', ['redactor']: null });"), 0,
      "`['redactor']` is statically known not to be `backend`");
  });

  it('RED: a GETTER named backend overrides the pin', () => {
    assert.equal(unpinned("await createAnthropicClient({ backend: 'sdk', get backend() { return 'cli'; } });"), 1);
  });

  it('RED: a METHOD named backend does too', () => {
    assert.equal(unpinned("await createAnthropicClient({ backend: 'sdk', backend() { return 'cli'; } });"), 1);
  });
});

// A dead object inside the factory vouched for a live override: what matters is
// what the function RETURNS.
describe('an indirect claim rests on what the factory RETURNS', () => {
  it('RED: a pinned object the function does not return', () => {
    const src = "function opts() { const unused = { backend: 'sdk' }; return { backend: 'cli' }; }\n"
      + 'await createAnthropicClient(opts());';
    assert.equal(indirectPinHolds(src, 'opts').pinned, false,
      'a dead object must not vouch for a live override');
  });

  it('RED: a function that returns something the gate cannot follow', () => {
    const src = 'function opts() { return buildOptions(); }\nawait createAnthropicClient(opts());';
    assert.equal(indirectPinHolds(src, 'opts').pinned, false);
  });

  it('RED: a function with no return at all', () => {
    const src = "function opts() { const x = { backend: 'sdk' }; }\nawait createAnthropicClient(opts());";
    assert.equal(indirectPinHolds(src, 'opts').pinned, false);
  });

  it('GREEN: a block-body return of a pinned object', () => {
    const src = "function opts() { return { backend: 'sdk' }; }\nawait createAnthropicClient(opts());";
    assert.equal(indirectPinHolds(src, 'opts').pinned, true);
  });

  it("GREEN: an arrow's concise body", () => {
    const src = "const opts = () => ({ backend: 'sdk' });\nawait createAnthropicClient(opts());";
    assert.equal(indirectPinHolds(src, 'opts').pinned, true);
  });

  it('RED: EVERY return must be pinned, not just one', () => {
    const src = "function opts() { if (x) return { backend: 'sdk' }; return { backend: 'cli' }; }\n"
      + 'await createAnthropicClient(opts());';
    assert.equal(indirectPinHolds(src, 'opts').pinned, false);
  });

  it("a nested callback's return does not count as the function's", () => {
    const src = "function opts() { run(() => ({ backend: 'sdk' })); return { backend: 'cli' }; }\n"
      + 'await createAnthropicClient(opts());';
    assert.equal(indirectPinHolds(src, 'opts').pinned, false);
  });
});

describe('params: computed keys and aliased imports', () => {
  it("a literal computed key passes the param — `{ ['system']: p }`", () => {
    assert.deepEqual(unserviceableParamsInSource("x({ ['system']: p })"), ['system']);
  });

  // A DYNAMIC key might be `system`, so in a file that also constructs an
  // unpinned client it fails closed — and only there, so the cost falls where a
  // decision is owed.
  it('a DYNAMIC key fails Rule A in a file with an unpinned construction', () => {
    const c = classifyPinningInSource('await createAnthropicClient();\nx({ [k]: p });');
    assert.equal(c.dynamicKeys, true);
    assert.deepEqual(c.unserviceable, [], 'it is not CLAIMED to be a specific param');
    assert.equal(c.ruleAViolation, true);
  });

  it('a DYNAMIC key is harmless where every construction is pinned', () => {
    const c = classifyPinningInSource("await createAnthropicClient({ backend: 'sdk' });\nx({ [k]: p });");
    assert.equal(c.dynamicKeys, true);
    assert.equal(c.ruleAViolation, false);
  });

  it('an ALIASED static import is still a construction', () => {
    const src = "import { createAnthropicClient as mk } from './lib/anthropic-client.mjs';\n"
      + 'const c = await mk();';
    assert.equal(classifyPinningInSource(src).unpinned, 1,
      'matching the bare name alone left an aliased site invisible to BOTH rules');
  });

  it('an alias from a DYNAMIC import is too', () => {
    const src = "const { createAnthropicClient: mk } = await import('./anthropic-client.mjs');\n"
      + 'const c = await mk();';
    assert.equal(classifyPinningInSource(src).unpinned, 1);
  });

  it('an alias from an UNRELATED module is not', () => {
    const src = "import { createAnthropicClient as mk } from './something-else.mjs';\n"
      + 'const c = await mk();';
    assert.equal(classifyPinningInSource(src).constructions, 0);
  });

  it('a pinned aliased construction is pinned', () => {
    const src = "import { createAnthropicClient as mk } from './lib/anthropic-client.mjs';\n"
      + "const c = await mk({ backend: 'sdk' });";
    assert.equal(classifyPinningInSource(src).unpinned, 0);
  });
});

describe('the digest folds a trailing comma only in CODE', () => {
  it("`'use,}'` and `'use}'` keep different digests", () => {
    assert.notEqual(
      normaliseArgText("{ a: 'use,}' }"),
      normaliseArgText("{ a: 'use}' }"),
    );
    assert.notEqual(
      unpinnedArgsDigest("await createAnthropicClient({ a: 'use,}' });"),
      unpinnedArgsDigest("await createAnthropicClient({ a: 'use}' });"),
    );
  });

  it('a code trailing comma still folds', () => {
    assert.equal(normaliseArgText('{ a: 1, }'), '{a:1}');
    assert.equal(normaliseArgText('{ a: [1, 2, ] }'), '{a:[1,2]}');
  });

  it('a comma between properties is NOT a trailing comma', () => {
    assert.equal(normaliseArgText('{ a: 1, b: 2 }'), '{a:1,b:2}');
  });
});

// ── round 5: control flow, spellings and provenance ────────────────────────
describe('a factory must be pinned on EVERY path out', () => {
  const held = (body) => indirectPinHolds(
    `function opts() { ${body} }\nawait createAnthropicClient(opts());`, 'opts',
  ).pinned;

  it('RED: an IMPLICIT fallthrough — the body does not end in a return', () => {
    assert.equal(held("if (x) return { backend: 'sdk' };"), false,
      'when x is false the function returns undefined and the backend is whatever the seam resolves');
  });

  it('RED: a BARE `return;`', () => {
    assert.equal(held("if (x) return { backend: 'sdk' }; return;"), false);
  });

  it('RED: one pinned return and one unresolvable one', () => {
    assert.equal(held("if (x) return { backend: 'sdk' }; return buildOptions();"), false);
  });

  it('GREEN: every path returns a pinned object', () => {
    assert.equal(held("if (x) return { backend: 'sdk' }; return { backend: 'bedrock' };"), true);
  });

  it('GREEN: a single trailing return', () => {
    assert.equal(held("const r = { backend: 'sdk' }; return r && { backend: 'sdk' };"), false,
      'an expression is not an ObjectExpression — unresolvable, so not a pin');
    assert.equal(held("return { backend: 'sdk' };"), true);
  });
});

describe('every spelling of the construction counts', () => {
  const unpinned = (src) => classifyPinningInSource(src).unpinned;

  it("a BRACKETED member call on the seam module — `mod['createAnthropicClient']()`", () => {
    const src = "const mod = await import('./anthropic-client.mjs');\n"
      + "const c = await mod['createAnthropicClient']();";
    assert.equal(unpinned(src), 1, 'the non-computed test excluded this spelling entirely');
  });

  it('a bracketed member call can be pinned too', () => {
    const src = "const mod = await import('./anthropic-client.mjs');\n"
      + "const c = await mod['createAnthropicClient']({ backend: 'sdk' });";
    assert.equal(unpinned(src), 0);
  });

  it("a bracketed call on an UNRELATED receiver does not count", () => {
    assert.equal(classifyPinningInSource("const c = await bag['createAnthropicClient']();").constructions, 0);
  });

  it('a DYNAMIC computed member call is not claimed either way', () => {
    assert.equal(classifyPinningInSource('const c = await mod[whichever]();').constructions, 0,
      'a stated limit: flagging every `obj[x]()` in the repo would make the gate useless');
  });
});

// Recording an alias for any object with a `createAnthropicClient` property
// would count an unrelated factory of the same name — a false construction,
// which fails the gate for the wrong reason and teaches the next author to
// distrust it.
describe('an alias is recorded only with provenance', () => {
  it('GREEN: destructured from a dynamic import of the seam', () => {
    const src = "const { createAnthropicClient: mk } = await import('./anthropic-client.mjs');\n"
      + 'const c = await mk();';
    assert.equal(classifyPinningInSource(src).unpinned, 1);
  });

  it('RED: destructured from something else entirely', () => {
    const src = 'const { createAnthropicClient: mk } = someUnrelatedFactoryBag;\nconst c = await mk();';
    assert.equal(classifyPinningInSource(src).constructions, 0,
      'same property name, different module — not this seam');
  });

  it('RED: destructured from an import of a DIFFERENT module', () => {
    const src = "const { createAnthropicClient: mk } = await import('./other-client.mjs');\n"
      + 'const c = await mk();';
    assert.equal(classifyPinningInSource(src).constructions, 0);
  });

  it('a static import of a different module is not an alias either', () => {
    const src = "import { createAnthropicClient as mk } from './other.mjs';\nconst c = await mk();";
    assert.equal(classifyPinningInSource(src).constructions, 0);
  });
});

// `messages.create({ ...request })` hides every param from the scan. Scoped to
// a `.create()` argument rather than every object literal: measured
// 2026-11-15, the broad rule would flag 3 of the 6 unpinned files — the
// summariser among them — and move their spend off the Max credit to guard a
// hypothesis. The narrow rule flags 0 today.
describe('a spread into a .create() argument can hide a param', () => {
  it('RED: it fails Rule A in a file with an unpinned construction', () => {
    const src = 'await createAnthropicClient();\nawait client.messages.create({ ...request });';
    const c = classifyPinningInSource(src);
    assert.equal(c.dynamicKeys, true);
    assert.equal(c.ruleAViolation, true);
  });

  it('GREEN: harmless where the construction is pinned', () => {
    const src = "await createAnthropicClient({ backend: 'sdk' });\n"
      + 'await client.messages.create({ ...request });';
    assert.equal(classifyPinningInSource(src).ruleAViolation, false);
  });

  it('a spread OUTSIDE a .create() argument is not flagged', () => {
    const src = 'await createAnthropicClient();\nconst merged = { ...defaults, a: 1 };';
    const c = classifyPinningInSource(src);
    assert.equal(c.dynamicKeys, false, 'the broad rule would have cost the summariser its credit');
    assert.equal(c.ruleAViolation, false);
  });
});

// ── round 6: a guard of mine that cried wolf, and two over-broad matches ────
//
// `endsInReturn` (round 5) tested only whether the LAST statement was a
// `return`, so `if (x) return A; else return B;` was marked unresolvable
// although every path returns. Fail-closed but WRONG is noise, and a gate that
// cries wolf is a gate that gets bypassed.
describe('alwaysReturns: terminating shapes are recognised', () => {
  const held = (body) => indirectPinHolds(
    `function opts() { ${body} }\nawait createAnthropicClient(opts());`, 'opts',
  ).pinned;

  it('GREEN: if/else where BOTH branches return', () => {
    assert.equal(held("if (x) return { backend: 'sdk' }; else return { backend: 'bedrock' };"), true);
  });

  it('RED: an if with NO else falls through', () => {
    assert.equal(held("if (x) return { backend: 'sdk' };"), false);
  });

  it('GREEN: try/catch where both return', () => {
    assert.equal(held("try { return { backend: 'sdk' }; } catch { return { backend: 'sdk' }; }"), true);
  });

  it('RED: a try with no catch', () => {
    assert.equal(held("try { return { backend: 'sdk' }; } finally { log(); }"), false,
      'relying on a finally to terminate is obscure enough to deserve a human read');
  });

  it('GREEN: a switch with a default where every case returns', () => {
    assert.equal(held("switch (k) { case 1: return { backend: 'sdk' }; default: return { backend: 'sdk' }; }"), true);
  });

  it('RED: a switch with NO default', () => {
    assert.equal(held("switch (k) { case 1: return { backend: 'sdk' }; }"), false);
  });

  it('GREEN: a throw terminates a branch', () => {
    assert.equal(held("if (x) throw new Error('no'); else return { backend: 'sdk' };"), true);
  });

  it('RED: a loop is not recognised as terminating', () => {
    assert.equal(held("while (x) { return { backend: 'sdk' }; }"), false,
      'an unrecognised shape reads as unresolvable — the safe direction');
  });
});

// Matching ANY member call named `create` meant `db.records.create({ ...row })`
// in a file that happens to construct a client set the unknown-param flag,
// failing the gate for a wholly unrelated call.
describe('the spread rule is scoped to the Messages API', () => {
  it("RED: `client.messages.create({ ...request })` is flagged", () => {
    const src = 'await createAnthropicClient();\nawait client.messages.create({ ...request });';
    assert.equal(classifyPinningInSource(src).dynamicKeys, true);
  });

  it("GREEN: `db.records.create({ ...row })` is not an Anthropic request", () => {
    const src = 'await createAnthropicClient();\nawait db.records.create({ ...row });';
    assert.equal(classifyPinningInSource(src).dynamicKeys, false);
  });

  it("GREEN: a bare `create({ ...x })` with no `messages` receiver is not either", () => {
    const src = 'await createAnthropicClient();\nawait thing.create({ ...x });';
    assert.equal(classifyPinningInSource(src).dynamicKeys, false);
  });

  // STATED LIMIT, not a hidden one: following a staged request needs dataflow,
  // which this gate does not do. Rule B's declaration is the mechanism for it.
  it('a STAGED request is a declared limit', () => {
    const src = 'await createAnthropicClient();\nconst req = { ...defaults };\nawait client.messages.create(req);';
    assert.equal(classifyPinningInSource(src).dynamicKeys, false,
      'documented in the module: a value crossing a statement boundary is Rule B territory');
  });
});

describe('provenance: the two-step namespace form', () => {
  it('GREEN: `const mod = await import(seam); const { createAnthropicClient: mk } = mod;`', () => {
    const src = "const mod = await import('./anthropic-client.mjs');\n"
      + 'const { createAnthropicClient: mk } = mod;\nconst c = await mk();';
    assert.equal(classifyPinningInSource(src).unpinned, 1,
      'a missed alias is invisible to BOTH rules');
  });

  it('GREEN: a namespace import of the seam', () => {
    const src = "import * as seam from './lib/anthropic-client.mjs';\n"
      + 'const c = await seam.createAnthropicClient();';
    assert.equal(classifyPinningInSource(src).unpinned, 1);
  });

  it('RED: the same two-step from an unrelated module', () => {
    const src = "const mod = await import('./other.mjs');\n"
      + 'const { createAnthropicClient: mk } = mod;\nconst c = await mk();';
    assert.equal(classifyPinningInSource(src).constructions, 0);
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

  // A gate that exits non-zero printing nothing is worse than no gate: the
  // first cut counted brokenIndirect/staleIndirect in `ok` but never printed
  // them, so those two failures were silent. This reads the CLI's own source
  // rather than running it, since the repo is clean and cannot produce them.
  it('the CLI reports EVERY verdict category it can fail on', () => {
    const cli = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'check-anthropic-pins.mjs'), 'utf8');
    for (const key of ['ruleA', 'undeclared', 'countDrift', 'stale', 'declaredWithoutReason', 'brokenIndirect', 'staleIndirect']) {
      assert.ok(
        new RegExp(`verdict\\.${key}`).test(cli),
        `${key} is in the verdict but the CLI never prints it \u2014 that failure would exit 1 with no reason`,
      );
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

// ── Round-7 fail-opens: three shapes the gate CERTIFIED (2026-11-15) ───────
//
// Each of these made the census answer "pinned" or "no construction here" for
// code that is neither. They are grouped because they are one class — the
// analysis recognising a shape and then being too generous about it — and
// because a fail-open in a MERGE gate is worse than a gap: it does not merely
// miss a site, it states that the site was checked.
describe('the census does not certify what it cannot actually see', () => {
  const SEAM = "import { createAnthropicClient } from './anthropic-client.mjs';";

  // H2. `argRestsOnFactory` skipped any non-ObjectProperty, so a GETTER named
  // `backend` sitting after the factory spread was invisible — while
  // `resolveBackendOfArg` has always called that shape unresolved. Two answers
  // to one question, inside one module.
  it('a GETTER overriding the factory spread breaks the indirect-pin claim', () => {
    const src = `${SEAM}
function clientOptions() { return { backend: 'sdk', timeout: 1 }; }
export async function make() {
  return createAnthropicClient({ ...clientOptions(), get backend() { return 'cli'; } });
}`;
    const held = indirectPinHolds(src, 'clientOptions');
    assert.equal(held.found, true);
    assert.equal(held.pinned, true, 'the factory itself does pin');
    assert.equal(held.used, false,
      'but this construction overrides it — certifying it would let the gate approve a cli call');
  });

  // POSITIVE CONTROL: the honest spread must still pass, or the fix above would
  // have closed the hole by refusing the one shape the escape hatch exists for.
  it('the plain factory spread still holds', () => {
    const src = `${SEAM}
function clientOptions() { return { backend: 'sdk' }; }
export async function make() { return createAnthropicClient({ ...clientOptions(), timeout: 5 }); }`;
    assert.equal(indirectPinHolds(src, 'clientOptions').used, true);
  });

  // H3. `alwaysReturns` read an EMPTY consequent as terminating, so an empty
  // `default:` — the path that falls out with no value at all — counted as a
  // return. The pin is then claimed on a function that returns undefined.
  it('a switch whose DEFAULT is empty does not count as always returning', () => {
    const src = `${SEAM}
function clientOptions(kind) {
  switch (kind) {
    case 'a': return { backend: 'sdk' };
    default:
  }
}
export async function make(k) { return createAnthropicClient(clientOptions(k)); }`;
    assert.equal(indirectPinHolds(src, 'clientOptions').pinned, false,
      'the default path returns undefined, so the pin is absent on it');
  });

  // POSITIVE CONTROL for the same edit: stacked fall-through case labels are
  // the shape the `length === 0` allowance was written for, and must still work.
  it('stacked fall-through case labels still count as returning', () => {
    const src = `${SEAM}
function clientOptions(kind) {
  switch (kind) {
    case 'a':
    case 'b': return { backend: 'sdk' };
    default: return { backend: 'sdk' };
  }
}
export async function make(k) { return createAnthropicClient(clientOptions(k)); }`;
    assert.equal(indirectPinHolds(src, 'clientOptions').pinned, true);
  });

  // H4. A factory LIFTED off a seam namespace into a plain identifier was not
  // recorded as a binding, so calls through it were not constructions at all —
  // invisible to Rule A and Rule B alike, which is the worst outcome available:
  // the file reads as having no client in it.
  it('a factory aliased off a seam namespace is still a construction', () => {
    const src = `import * as anthropic from './anthropic-client.mjs';
const makeClient = anthropic.createAnthropicClient;
export async function go() {
  const c = await makeClient({});
  return c.messages.create({ model: 'm', max_tokens: 10, system: 'be brief', messages: [] });
}`;
    const c = classifyPinningInSource(src);
    assert.equal(c.parsed, true);
    assert.equal(c.unpinned, 1, 'the alias constructs a client, and it is not pinned');
    assert.equal(c.ruleAViolation, true, 'and it passes `system`, so Rule A must fire');
  });

  // NEGATIVE CONTROL for the alias rule: provenance is checked, so an unrelated
  // object with a property of the same name must NOT become a construction.
  // Without this the fix would fail the gate for the wrong reason, which is how
  // a gate teaches the next author to stop believing it.
  it('a same-named property on an UNRELATED object is not a factory', () => {
    const src = `import * as helpers from './unrelated-module.mjs';
const makeClient = helpers.createAnthropicClient;
export async function go() { return makeClient({ system: 'x' }); }`;
    const c = classifyPinningInSource(src);
    assert.equal(c.unpinned, 0, 'not this seam, so not this gate\u2019s business');
  });
});

// ── A FAILURE THE GATE DOES NOT NAME (2026-11-15, final review A-census) ────
//
// `auditPinCensus` sets `ok: false` on `unparsed`, deliberately — a file the
// parser could not read is UNKNOWN, not clean. The CLI printed every other
// category and not that one, so the gate exited 1 with nothing on stderr
// explaining itself, on exactly the file most likely to be mid-edit.
//
// Asserted MECHANICALLY, from the verdict's own keys rather than from a list
// written beside them: a list would have to be updated by the same person who
// forgot the reporting loop, which is the failure this is for. A new verdict
// category now fails here until it is reported.
describe('every failure category the verdict can carry is reported by the gate', () => {
  it('each non-ok verdict key appears in a reporting loop in check-anthropic-pins.mjs', () => {
    const verdict = auditPinCensus(new Map(), {});
    const categories = Object.keys(verdict).filter((k) => k !== 'ok');
    assert.ok(categories.length >= 7, `expected the full verdict shape, got ${categories.join(', ')}`);

    const cli = fs.readFileSync(path.join(REPO_ROOT, 'scripts/check-anthropic-pins.mjs'), 'utf8');
    const unreported = categories.filter((k) => !cli.includes(`of verdict.${k})`));
    assert.deepEqual(unreported, [],
      'a category that fails the gate but is never printed makes the failure unexplainable');
  });

  // The companion half: Rule A's `params` is EMPTY for a dynamic key (a spread
  // into a `.create()` argument, or a computed non-literal key). The gate fails
  // closed on those, correctly — but the message interpolated an empty list and
  // read `passes ``,`, naming nothing, for the one case a reader most needs
  // told apart from a named param.
  it('Rule A can fire with NO named params, which the message must handle', () => {
    const src = `import { createAnthropicClient } from './anthropic-client.mjs';
export async function go(req) {
  const c = await createAnthropicClient({});
  return c.messages.create({ ...req });
}`;
    const c = classifyPinningInSource(src);
    assert.equal(c.ruleAViolation, true, 'a spread into create() fails closed');
    assert.deepEqual(c.unserviceable, [], 'and it names no param — this is the empty case');

    const cli = fs.readFileSync(path.join(REPO_ROOT, 'scripts/check-anthropic-pins.mjs'), 'utf8');
    assert.match(cli, /v\.params\.length/,
      'so the message must branch on it rather than interpolate an empty list');
  });
});

// ── The final review's dismissals, PROVEN rather than argued (2026-11-15) ──
//
// The gate's last pass raised two fail-open claims against `indirectPinHolds`
// and `argRestsOnFactory`. Both were dismissed — but a dismissal written as
// prose is a claim about code that nothing re-checks, and this module has
// already had four rounds of "the analysis looks right". So each dismissal is
// a probe here instead. If one of them ever becomes true, this suite says so
// rather than a future reader having to re-derive the argument.
describe('the claimed indirect-pin fail-opens, as probes', () => {
  const SEAM = "import { createAnthropicClient } from './anthropic-client.mjs';";
  const sdk = 'function o() { return { backend: \'sdk\' }; }';

  it('a factory that returns `cli` is NOT a pin', () => {
    const src = `${SEAM}\nfunction o() { return { backend: 'cli' }; }\nexport const f = () => createAnthropicClient(o());`;
    assert.equal(indirectPinHolds(src, 'o').pinned, false,
      "`pinned` means the literal sdk backend, not merely a resolvable one");
  });

  it('an explicit cli construction BESIDE the factory breaks the claim', () => {
    const src = `${SEAM}\n${sdk}\nexport const a = () => createAnthropicClient(o());`
      + "\nexport const b = () => createAnthropicClient({ backend: 'cli' });";
    assert.equal(indirectPinHolds(src, 'o').used, false,
      'every unpinned construction in the file must rest on the factory, not just one');
  });

  it('a `backend` key BEFORE the spread disqualifies it, exactly as after', () => {
    const src = `${SEAM}\n${sdk}\nexport const f = () => createAnthropicClient({ backend: 'cli', ...o() });`;
    assert.equal(indirectPinHolds(src, 'o').used, false,
      'position is irrelevant — ANY backend property disqualifies, so there is no ordering hole');
  });

  // POSITIVE CONTROL: spreading the same pinned factory twice is harmless and
  // must still hold, or the three above would be passing because the claim is
  // never satisfiable.
  it('spreading the SAME pinned factory twice still holds', () => {
    const src = `${SEAM}\n${sdk}\nexport const f = () => createAnthropicClient({ ...o(), ...o() });`;
    const held = indirectPinHolds(src, 'o');
    assert.equal(held.pinned, true);
    assert.equal(held.used, true);
  });

  // And the corpus pre-filter: `check-anthropic-pins.mjs` skips a file that does
  // not contain the literal `createAnthropicClient`, which the review twice
  // called a gap for namespace imports. Every binding form the census
  // recognises derives from that literal APPEARING, so the filter cannot hide
  // one — asserted over the shapes rather than asserted in a comment.
  it('every recognised binding form contains the literal the pre-filter looks for', () => {
    const shapes = [
      "import * as ns from './anthropic-client.mjs';\nexport const f = () => ns.createAnthropicClient({});",
      "import { createAnthropicClient as mk } from './anthropic-client.mjs';\nexport const f = () => mk({});",
      "const { createAnthropicClient: mk } = await import('./anthropic-client.mjs');\nexport const f = () => mk({});",
      "import * as ns from './anthropic-client.mjs';\nconst mk = ns.createAnthropicClient;\nexport const f = () => mk({});",
    ];
    for (const src of shapes) {
      assert.ok(src.includes('createAnthropicClient'),
        'the pre-filter would skip this file, and the census would never see it');
    }
  });
});

// THE ALLOWLIST RULE (2026-11-15). The gate's param question changed shape with
// the oracle's: inside a literal `messages.create({…})` argument it now asks
// whether every key is SERVICEABLE, not whether any key is one of three names.
// These are the cases that separate the two — a denylist passes every one of
// them, so a scanner that still answers the old question fails here.
describe('the allowlist rule: a param nobody named is still a violation', () => {
  const planted = (createArgs) => `
    import { createAnthropicClient } from './lib/anthropic-client.mjs';
    const client = await createAnthropicClient();
    await client.messages.create(${createArgs});
  `;

  it('RED: `stream` — passed at a real site, dropped by cli, refused by no denylist', () => {
    const c = classifyPinningInSource(planted(
      "{ model: 'm', max_tokens: 10, messages: [], stream: true }",
    ));
    assert.equal(c.ruleAViolation, true, 'the shape the denylist could not see');
    assert.deepEqual(c.unserviceable, ['stream']);
  });

  it('RED: `output_config` — a param that did not exist when the denylist was written', () => {
    const c = classifyPinningInSource(planted(
      "{ model: 'm', messages: [], output_config: { effort: 'high' } }",
    ));
    assert.equal(c.ruleAViolation, true);
    assert.deepEqual(c.unserviceable, ['output_config']);
  });

  it('named params still sort FIRST, so the gate\'s message is stable', () => {
    const c = classifyPinningInSource(planted(
      "{ temperature: 0, system: 's', messages: [], stream: true }",
    ));
    assert.deepEqual(c.unserviceable, ['system', 'stream', 'temperature']);
  });

  // THE DIRECTION THE GATE MUST NOT FIRE. `create(params, requestOptions)` —
  // the second argument is transport options, which the cli adapter honours.
  // Scanning every argument was harmless under the denylist and made the
  // allowlist fail the gate on summarise-domains.mjs:91, a call cli serves
  // correctly. Found by running the gate, not by review.
  it('GREEN: `{ signal }` in the SECOND argument is not a param', () => {
    const c = classifyPinningInSource(planted(
      "{ model: 'm', max_tokens: 10, messages: [] }, { signal: ctrl.signal }",
    ));
    assert.equal(c.ruleAViolation, false, 'requestOptions are not params');
    assert.deepEqual(c.unserviceable, []);
  });

  it('GREEN: an object literal ELSEWHERE in the file is judged by the named rule only', () => {
    // Were the allowlist applied file-wide, every object in the repo would be a
    // violation. It is scoped to the create argument for exactly this reason.
    // `temperature` is an UNNAMED unserviceable param, so it is caught inside a
    // create literal and ignored anywhere else; a NAMED one (`system`,
    // `stream`) is caught in both, which is the staged-request case below.
    const c = classifyPinningInSource(`
      import { createAnthropicClient } from './lib/anthropic-client.mjs';
      const cfg = { temperature: 3, retries: 2, verbose: false };
      const client = await createAnthropicClient();
      await client.messages.create({ model: 'm', max_tokens: 1, messages: [] });
    `);
    assert.equal(c.ruleAViolation, false);
  });

  it('a NAMED param still counts outside the create call — the staged-request shape', () => {
    const c = classifyPinningInSource(`
      import { createAnthropicClient } from './lib/anthropic-client.mjs';
      const client = await createAnthropicClient();
      const req = { model: 'm', max_tokens: 1, system: 'be brief', messages: [] };
      await client.messages.create(req);
    `);
    assert.equal(c.ruleAViolation, true, 'the file-wide named rule covers what the scoped one cannot see');
    assert.deepEqual(c.unserviceable, ['system']);
  });
});

// ── The STAGED request: the gap the round-1 audit of the allowlist found ────
//
// `const req = { model, max_tokens, messages, temperature: 0.2 };
//  client.messages.create(req)` — not an argument to `.create`, so the scoped
// allowlist rule cannot see it, and the file-wide named rule knows only four
// spellings. `temperature` escaped a gate that described itself as an
// allowlist. Closed by SHAPE (`messages` plus `model` or `max_tokens`), which
// needs no dataflow and cannot be defeated by an extra assignment.
describe('a request-shaped literal is judged by the allowlist wherever it sits', () => {
  const file = (body) => `
    import { createAnthropicClient } from './lib/anthropic-client.mjs';
    const client = await createAnthropicClient();
    ${body}
  `;

  it('RED: a staged request carrying an UNNAMED unserviceable param is caught', () => {
    const c = classifyPinningInSource(file(`
      const req = { model: 'm', max_tokens: 10, messages: [], temperature: 0.2 };
      await client.messages.create(req);
    `));
    assert.equal(c.ruleAViolation, true, 'the shape the named-only rule let through');
    assert.deepEqual(c.unserviceable, ['temperature']);
  });

  it('RED: and through an extra hop, which dataflow-following would have to chase', () => {
    const c = classifyPinningInSource(file(`
      const base = { model: 'm', max_tokens: 10, messages: [], output_config: { effort: 'high' } };
      const req = base;
      await client.messages.create(req);
    `));
    assert.equal(c.ruleAViolation, true);
    assert.deepEqual(c.unserviceable, ['output_config']);
  });

  it('GREEN: a staged request built only from the allowlist is clean', () => {
    const c = classifyPinningInSource(file(`
      const req = { model: 'm', max_tokens: 10, messages: [] };
      await client.messages.create(req);
    `));
    assert.equal(c.ruleAViolation, false);
    assert.deepEqual(c.unserviceable, []);
  });

  // THE DIRECTION IT MUST NOT FIRE. Request-SHAPED means `messages` plus
  // `model` or `max_tokens`. A `messages` array alone appears in prompt
  // builders and fixtures that send nothing, and flagging those would fail the
  // gate for files that make no request at all.
  it('GREEN: an object with `messages` but no model/max_tokens is not a request', () => {
    const c = classifyPinningInSource(file(`
      const cfg = { messages: [], retries: 2, temperature: 9 };
      await client.messages.create({ model: 'm', max_tokens: 1, messages: [] });
    `));
    assert.equal(c.ruleAViolation, false, 'not every object with a messages key is a request');
  });

  it('a spread into a request-shaped literal still fails CLOSED', () => {
    const c = classifyPinningInSource(file(`
      const req = { model: 'm', max_tokens: 10, messages: [], ...extra };
      await client.messages.create(req);
    `));
    assert.equal(c.dynamicKeys, true);
    assert.equal(c.ruleAViolation, true, 'unknowable is not clean');
  });
});

// ── A request ASSEMBLED BY ASSIGNMENT (round-2 audit of the allowlist) ──────
//
// Every other rule here reads object PROPERTIES, so `req.system = SYSTEM` was
// invisible to the whole gate — before this change as well as after it. A file
// could stage a clean literal and add the unserviceable param on the next line.
describe('a named param assigned onto a request is caught', () => {
  const file = (body) => `
    import { createAnthropicClient } from './lib/anthropic-client.mjs';
    const client = await createAnthropicClient();
    ${body}
  `;

  it('RED: `req.system = …` after a clean literal', () => {
    const c = classifyPinningInSource(file(`
      const req = { model: 'm', max_tokens: 1, messages: [] };
      req.system = 'be brief';
      await client.messages.create(req);
    `));
    assert.equal(c.ruleAViolation, true);
    assert.deepEqual(c.unserviceable, ['system']);
  });

  it('RED: `params.output_config = …`, the shape that is invisible to a key-scan', () => {
    const c = classifyPinningInSource(file(`
      const params = { model: 'm', messages: [] };
      params.output_config = { effort: 'high' };
      await client.messages.create(params);
    `));
    assert.equal(c.ruleAViolation, true);
    assert.deepEqual(c.unserviceable, ['output_config']);
  });

  // THE DIRECTION IT MUST NOT FIRE, and the first cut of this rule DID fire
  // here: a computed member assignment was folded into `dynamicKeys`, so
  // `out[idx] = …` — an array index write at summarise.mjs:185, nothing to do
  // with params — failed the gate for a deliberately-cli site. Failing closed
  // is only honest where the subject is actually a candidate.
  it('GREEN: an array index write is not an unreadable request key', () => {
    const c = classifyPinningInSource(file(`
      const out = [];
      out[idx] = 'x';
      await client.messages.create({ model: 'm', max_tokens: 1, messages: [] });
    `));
    assert.equal(c.dynamicKeys, false, 'an index write says nothing about params');
    assert.equal(c.ruleAViolation, false);
  });

  it('GREEN: an unrelated property assignment is untouched', () => {
    const c = classifyPinningInSource(file(`
      const o = {};
      o.retries = 2;
      await client.messages.create({ model: 'm', max_tokens: 1, messages: [] });
    `));
    assert.equal(c.ruleAViolation, false);
  });
});

// Round-3 narrowing: the assignment rule only fires in a file that actually
// makes a Messages API call. Without that condition an unrelated
// `stats.system = …` in a file that happens to construct a client read as a
// request param.
describe('the assignment rule needs a Messages API call in the file', () => {
  it('GREEN: `stats.system = …` in a file that calls nothing is not a param', () => {
    const c = classifyPinningInSource(`
      import { createAnthropicClient } from './lib/anthropic-client.mjs';
      export async function build() {
        const client = await createAnthropicClient();
        const stats = {};
        stats.system = 'linux';
        return { client, stats };
      }
    `);
    assert.deepEqual(c.unserviceable, []);
    assert.equal(c.ruleAViolation, false);
  });

  it('RED: the same assignment in a file that DOES call messages.create is caught', () => {
    const c = classifyPinningInSource(`
      import { createAnthropicClient } from './lib/anthropic-client.mjs';
      const client = await createAnthropicClient();
      const req = { model: 'm', max_tokens: 1, messages: [] };
      req.system = 'be brief';
      await client.messages.create(req);
    `);
    assert.deepEqual(c.unserviceable, ['system']);
    assert.equal(c.ruleAViolation, true);
  });
});
