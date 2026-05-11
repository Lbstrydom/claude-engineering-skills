import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isThinDelegate } from '../scripts/lib/symbol-index/thin-delegate.mjs';

describe('isThinDelegate — positive cases (correctly classified as thin delegate)', () => {
  it('arrow expression body with member call', () => {
    assert.equal(isThinDelegate('(a, b) => target.method(a, b)'), true);
  });
  it('full assignment + arrow + member call', () => {
    // ts-morph getBodyText() returns body only; this case mirrors arrow body
    assert.equal(isThinDelegate('target.method(a, b)'), true);
  });
  it('block body with single return + member call', () => {
    assert.equal(isThinDelegate('{ return target.method(a); }'), true);
  });
  it('block body with single member-call statement', () => {
    assert.equal(isThinDelegate('{ target.method(a); }'), true);
  });
  it('block body with await + return + member call', () => {
    assert.equal(isThinDelegate('{ return await store.write(payload); }'), true);
  });
});

describe('isThinDelegate — negative cases (correctly NOT classified)', () => {
  it('multi-statement block', () => {
    assert.equal(isThinDelegate('{ const x = 1; return target.method(x); }'), false);
  });
  it('conditional inside block', () => {
    assert.equal(isThinDelegate('{ if (x) return target.method(x); }'), false);
  });
  it('nested call — wrapping logic', () => {
    assert.equal(isThinDelegate('{ return target.method(target.other(x)); }'), false);
  });
  it('pure expression, no call', () => {
    assert.equal(isThinDelegate('(x) => x + 1'), false);
  });
  it('bare function call (no member access)', () => {
    assert.equal(isThinDelegate('{ return foo(x); }'), false);
  });
  it('return this — not a call', () => {
    assert.equal(isThinDelegate('{ return this; }'), false);
  });
});

// R1 audit M4 follow-up: original regex allowed any non-paren content in
// args.  These cases prove the tightened argument-passthrough rule rejects
// operator/literal/object/ternary expressions in arg positions.
describe('isThinDelegate — argument-passthrough enforcement (M4 follow-up)', () => {
  it('nullish-coalescing in args (x ?? defaultVal)', () => {
    assert.equal(isThinDelegate('(x) => store.set(x ?? defaultVal)'), false);
  });
  it('arithmetic in args (x + 1)', () => {
    assert.equal(isThinDelegate('(x) => target.method(x + 1)'), false);
  });
  it('object spread literal in args', () => {
    assert.equal(isThinDelegate('(payload) => store.write({...payload, ts})'), false);
  });
  it('ternary in args', () => {
    assert.equal(isThinDelegate('(x) => target.method(x ? a : b)'), false);
  });
  it('string literal in args', () => {
    assert.equal(isThinDelegate('() => target.method("hardcoded")'), false);
  });
  it('rest spread arg IS accepted (pure passthrough)', () => {
    assert.equal(isThinDelegate('(...args) => target.method(...args)'), true);
  });
  it('mixed spread + identifier args (pure passthrough)', () => {
    assert.equal(isThinDelegate('(el, e, h) => registry.add(el, e, h)'), true);
  });
});

// Gemini final review caught: ts-morph's getText() on VariableDeclaration
// returns `name = ...` (full declarator).  These cases verify the prefix
// strip handles both arrow-form and function-expression-form facades.
describe('isThinDelegate — VariableDeclaration prefix handling (Gemini follow-up)', () => {
  it('const-init arrow form via v.getText()', () => {
    assert.equal(isThinDelegate('addListener = (el, e, h) => registry.add(el, e, h)'), true);
  });
  it('const-init named function-expression form', () => {
    assert.equal(isThinDelegate('addListener = function listen(el, e, h) { registry.add(el, e, h); }'), true);
  });
  it('const-init anonymous function-expression form', () => {
    assert.equal(isThinDelegate('addListener = function(el, e, h) { registry.add(el, e, h); }'), true);
  });
  it('const-init function-expression with return', () => {
    assert.equal(isThinDelegate('write = function(payload) { return store.write(payload); }'), true);
  });
  it('const-init function-expression with operator in args is NOT a delegate', () => {
    assert.equal(isThinDelegate('inc = function(x) { return store.set(x + 1); }'), false);
  });
  it('async anonymous function-expression', () => {
    assert.equal(isThinDelegate('write = async function(payload) { return store.write(payload); }'), true);
  });
  it('async named function-expression', () => {
    assert.equal(isThinDelegate('write = async function inner(payload) { await store.write(payload); }'), true);
  });
});

describe('isThinDelegate — input guards', () => {
  it('empty string', () => {
    assert.equal(isThinDelegate(''), false);
  });
  it('null', () => {
    assert.equal(isThinDelegate(null), false);
  });
  it('undefined', () => {
    assert.equal(isThinDelegate(undefined), false);
  });
  it('non-string', () => {
    assert.equal(isThinDelegate(42), false);
  });
});
