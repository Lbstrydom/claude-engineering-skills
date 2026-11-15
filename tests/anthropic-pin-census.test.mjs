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

  it('a member-expression callee counts — `mod.createAnthropicClient()` after a dynamic import', () => {
    assert.equal(unpinned('const c = await mod.createAnthropicClient();'), 1);
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

  it("a BRACKETED member call — `mod['createAnthropicClient']()`", () => {
    assert.equal(unpinned("const c = await mod['createAnthropicClient']();"), 1,
      'the non-computed test excluded this spelling entirely');
  });

  it('a bracketed member call can be pinned too', () => {
    assert.equal(unpinned("const c = await mod['createAnthropicClient']({ backend: 'sdk' });"), 0);
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
