/**
 * @fileoverview d93e - the doctor (`check-setup`) must give a VERDICT on a required bundle package that package.json does not
 * declare. Until now only the sync's end-of-run warning said so; a consumer could run the doctor, see all green, and lose the
 * package on the next install. `checkBundleDependencies` now FAILS on undeclared / optional-only required packages, carrying the
 * exact command for the consumer's package manager, and says "not checked" (never a pass) when it cannot measure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkBundleDependencies } from '../scripts/lib/install/bundle-deps.mjs';
import { Report } from '../scripts/lib/doctor/report.mjs';

const SCRIPTS_DIR = new URL('../scripts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Everything is installed (the existing presence probe stays out of the way); only the declaration varies. */
const run = (assessDeclared) => {
  const report = new Report();
  checkBundleDependencies(report, process.cwd(), SCRIPTS_DIR, { installed: () => true, assessDeclared });
  const items = report.sections.flatMap((s) => s.items);
  return { report, items, find: (re) => items.find((i) => re.test(i.label ?? i.title ?? i.name ?? JSON.stringify(i))) };
};
const item = (name) => ({ name, importer: 'scripts/lib/glob.mjs' });
const measured = (over) => ({
  measured: true, required: 13, undeclared: [], optionalOnly: [], uncommitted: [], committedKnown: true, command: null, pmNote: null, ...over,
});

describe('checkBundleDependencies - declared, not merely present (d93e)', () => {
  it('an UNDECLARED required package FAILS the doctor and carries the exact install command', () => {
    const { report, items } = run(() => measured({ undeclared: [item('picomatch')], command: 'pnpm add -D picomatch' }));
    assert.equal(report.failures, 1);
    const text = JSON.stringify(items);
    assert.match(text, /not declared in package\.json/);
    assert.match(text, /picomatch \(imported by scripts\/lib\/glob\.mjs\)/);
    assert.match(text, /pnpm add -D picomatch/);
  });

  it('an optional-only declaration FAILS too, and says why optional is not enough', () => {
    const { report, items } = run(() => measured({ optionalOnly: [item('yaml')], command: 'npm i -D yaml' }));
    assert.equal(report.failures, 1);
    assert.match(JSON.stringify(items), /optionalDependencies/);
  });

  it('an ambiguous package manager still fails, naming the note instead of guessing a command', () => {
    const { report, items } = run(() => measured({ undeclared: [item('minimatch')], command: null, pmNote: 'package manager is ambiguous (npm, pnpm)' }));
    assert.equal(report.failures, 1);
    assert.match(JSON.stringify(items), /ambiguous/);
  });

  it('NEGATIVE CONTROL: everything declared and committed is a PASS with no failure', () => {
    const { report, items } = run(() => measured());
    assert.equal(report.failures, 0);
    assert.equal(report.warnings, 0);
    assert.match(JSON.stringify(items), /declares all 13 required packages/);
  });

  it('declared but uncommitted is a WARN, not a failure (the declaration exists; it just has not reached git)', () => {
    const { report } = run(() => measured({ uncommitted: [item('yaml')] }));
    assert.equal(report.failures, 0);
    assert.equal(report.warnings, 1);
  });

  it('unmeasurable is SAID as a warning and never a pass or a zero', () => {
    const { report, items } = run(() => ({ measured: false, reason: 'no package.json' }));
    assert.equal(report.failures, 0);
    assert.equal(report.warnings, 1);
    assert.match(JSON.stringify(items), /not checked/);
    assert.doesNotMatch(JSON.stringify(items), /declares all/);
  });
});

describe('checkBundleDependencies - against this repository, un-injected', () => {
  it('the source repo declares every required package it ships (the real assessment, not a stub)', () => {
    const report = new Report();
    checkBundleDependencies(report, new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), SCRIPTS_DIR);
    assert.equal(report.failures, 0, JSON.stringify(report.sections));
  });
});
