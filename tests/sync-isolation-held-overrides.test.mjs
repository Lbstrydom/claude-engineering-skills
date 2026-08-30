/**
 * @fileoverview Gate 2B — a DECLARED override is held, not a hash mismatch.
 *
 * ## The defect
 *
 * An entry in `.sync-overrides.json` tells the sync not to overwrite a path.
 * The sync obeys by leaving the file alone and carrying the PRIOR base forward
 * in the manifest, so the manifest deliberately records one hash and the disk
 * deliberately holds another — for ever. Gate 2B read that as corruption.
 *
 * The consequence was that the documented remedy defeated the verifier.
 * `storyline` declared four SKILL.md overrides (its `<!-- repo-electron-target -->`
 * adapter blocks, which upstream cannot carry because they are repo-specific),
 * did exactly what the sync's own REFUSED message instructs, and its
 * `sync-isolation-verify` exited 1 ever after — on precisely the four paths it
 * had just legitimised. A check that fires because you followed its advice
 * trains an operator to ignore it, and takes the other seven gates' credibility
 * with it.
 *
 * Same family as gate 5's prefix test in
 * `tests/sync-isolation-npm-script-targets.test.mjs`: a gate that judged a
 * consumer's declared, legitimate state by a rule that could not see the
 * declaration.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { _internals } from '../scripts/lib/sync-isolation-verify.mjs';

const { gate2B } = _internals;

let root;
const write = (rel, body) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
};
const sha = (s) => `sha256:${crypto.createHash('sha256').update(Buffer.from(s)).digest('hex')}`;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-held-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const SKILL = '.claude/skills/nav-audit/SKILL.md';

/** A consumer whose SKILL.md on disk differs from what the manifest records. */
function divergedConsumer() {
  write(SKILL, 'upstream body\n<!-- repo-electron-target -->\nconsumer block\n');
  return { files: { [SKILL]: sha('upstream body\n') } };
}

/**
 * `path` is a LITERAL and `glob` is a pattern — the schema keeps them as
 * separate keys, and a `**` written under `path` is escaped rather than
 * expanded. Modelling that here rather than assuming one key does both is what
 * caught this test asserting glob behaviour against a literal declaration.
 */
const declare = (entries) => write('.sync-overrides.json', JSON.stringify({
  version: 1,
  overrides: entries.map((e) => (typeof e === 'string'
    ? { path: e, reason: 'carries this repo\'s Electron adapter block' }
    : { ...e, reason: 'carries this repo\'s Electron adapter block' })),
  gitignoreExtra: [],
}));

describe('gate 2B — declared overrides', () => {
  it('FAILS on an undeclared mismatch (the gate still does its job)', () => {
    // The direction that must not fire. Relaxing the gate for declared paths
    // must not relax it for anything else — a corrupted skill file is exactly
    // what 2B exists to catch.
    const manifest = divergedConsumer();
    const res = gate2B(root, manifest);
    assert.equal(res.pass, false);
    assert.equal(res.details.mismatched.length, 1);
    assert.deepEqual(res.details.held, []);
  });

  it('PASSES once the path is declared, and says what it excused', () => {
    const manifest = divergedConsumer();
    declare([SKILL]);
    const res = gate2B(root, manifest);
    assert.equal(res.pass, true);
    assert.equal(res.details.held.length, 1);
    assert.equal(res.details.held[0].path, SKILL);
    assert.match(res.details.held[0].reason, /Electron/);
  });

  it('a GLOB declaration covers the paths it matches; a literal path does not', () => {
    const manifest = divergedConsumer();
    declare([{ glob: '.claude/skills/**' }]);
    assert.equal(gate2B(root, manifest).pass, true);
  });

  it('the same pattern under "path" is a LITERAL and matches nothing', () => {
    // The schema keeps "path" and "glob" as separate keys and escapes a
    // literal, so a consumer who writes ** under "path" gets an override that
    // matches no file. Asserted so the distinction is pinned rather than
    // assumed — this suite itself got it wrong first, and a silently
    // non-matching override is a guard that reads as active and is not.
    const manifest = divergedConsumer();
    declare(['.claude/skills/**']);
    assert.equal(gate2B(root, manifest).pass, false);
  });

  it('declaring a DIFFERENT path does not excuse this one', () => {
    // Otherwise any override anywhere would silence the whole gate.
    const manifest = divergedConsumer();
    declare(['.claude/skills/click-test/SKILL.md']);
    const res = gate2B(root, manifest);
    assert.equal(res.pass, false);
    assert.equal(res.details.mismatched.length, 1);
  });

  it('an override does NOT excuse an ABSENT file', () => {
    // An override says "do not overwrite my version", never "I do not need
    // this file". And since the sync stopped recording a held path that is not
    // on disk, an entry both claimed and missing is a real fault whatever the
    // overrides say.
    const manifest = { files: { [SKILL]: sha('upstream body\n') } };
    declare([SKILL]);
    const res = gate2B(root, manifest);
    assert.equal(res.pass, false);
    assert.deepEqual(res.details.missing, [SKILL]);
  });

  it('a MALFORMED overrides file fails the gate rather than being ignored', () => {
    // Fail-open here would silently restore the old behaviour for every
    // declared path, and the sync itself aborts on a malformed overrides file —
    // a verifier that shrugged at one would disagree with the tool it verifies.
    const manifest = divergedConsumer();
    write('.sync-overrides.json', '{ not json');
    const res = gate2B(root, manifest);
    assert.equal(res.pass, false);
    assert.match(res.error, /unusable/);
    assert.ok(res.details.overrideErrors.length > 0);
  });

  it('no overrides file at all is the ordinary case, not an error', () => {
    write(SKILL, 'body\n');
    const manifest = { files: { [SKILL]: sha('body\n') } };
    assert.equal(gate2B(root, manifest).pass, true);
  });

  it('a matching hash needs no override and reports nothing held', () => {
    write(SKILL, 'body\n');
    declare([SKILL]);
    const res = gate2B(root, { files: { [SKILL]: sha('body\n') } });
    assert.equal(res.pass, true);
    assert.equal(res.details, undefined, 'nothing was excused, so nothing is reported');
  });
});
