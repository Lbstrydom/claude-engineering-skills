/**
 * @fileoverview Cross-parser agreement for the NUL-delimited record framing.
 *
 * There are two independent implementations of the same wire protocol in this
 * repo, and that is deliberate rather than accidental:
 *
 *   - `vcs.mjs::parseUntrackedPathsZ` parses `git ls-files -z` and returns a
 *     STRUCTURED RESULT (`{ok:true,paths}` / `{ok:false,error:{code}}`) — the
 *     `VcsErrorCode` contract AGENTS.md requires of that module, whose callers
 *     switch on error codes and must never see a throw.
 *   - `files-manifest.mjs::parseFilesManifest` parses the `--files-from`
 *     manifest at a CLI boundary and THROWS, because there is no caller that
 *     could act on a structured error there.
 *
 * Unifying them would force one to adopt the other's error contract, so the
 * duplication is the lesser cost (audit round 13, MEDIUM — accepted as debt,
 * mitigated here rather than refactored). What was NOT acceptable is the
 * docblock claiming one "mirrors the other verbatim" while nothing enforced it:
 * an advertised coupling with no check is exactly the stated-but-unenforced
 * class this repo's gate-honesty work exists to catch.
 *
 * This test IS the enforcement. Both parsers are fed the same framing cases and
 * must agree on ACCEPT vs REJECT and, when accepting, on the identical record
 * list. It compares framing decisions only — not error text, not error shape —
 * because those legitimately differ.
 *
 * Disposition: permanent. Retire only if the two implementations are genuinely
 * unified behind one primitive, at which point this becomes tautological.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilesManifest } from '../scripts/lib/symbol-index/files-manifest.mjs';
import { _internals as vcsInternals } from '../scripts/lib/vcs.mjs';

const parseUntrackedPathsZ = vcsInternals?.parseUntrackedPathsZ;

/** Normalise both parsers to `{accepted, records}` so framing can be compared. */
function viaManifest(content) {
  try { return { accepted: true, records: parseFilesManifest(content, 'x') }; }
  catch { return { accepted: false, records: null }; }
}
function viaVcs(content) {
  const r = parseUntrackedPathsZ(content);
  return r.ok ? { accepted: true, records: r.paths } : { accepted: false, records: null };
}

// Framing cases only — every one is a statement about the PROTOCOL, not about
// git or about manifests specifically.
const CASES = [
  ['empty content is a valid zero-record stream', ''],
  ['one terminated record', 'a.mjs\0'],
  ['several terminated records', 'a.mjs\0b/c.mjs\0d.mjs\0'],
  ['a record containing spaces', 'a b.mjs\0'],
  ['a record with leading/trailing whitespace', ' lead.mjs\0trail.mjs \0'],
  ['a record containing a newline', 'has\nnewline.mjs\0'],
  ['missing terminator on the only record', 'a.mjs'],
  ['missing terminator on the last of several', 'a.mjs\0b.mjs'],
  ['interior empty record', 'a.mjs\0\0b.mjs\0'],
  ['leading empty record', '\0a.mjs\0'],
  ['a lone NUL', '\0'],
  ['legacy newline-delimited content', 'a.mjs\nb.mjs\n'],
];

describe('NUL framing parity — files-manifest vs vcs', () => {
  it('exposes the vcs parser for comparison (vacuous-pass guard)', () => {
    // Without this, a rename or a missing _internals export would make every
    // case below throw identically in both helpers and "agree" trivially.
    assert.equal(typeof parseUntrackedPathsZ, 'function',
      'vcs.mjs must expose parseUntrackedPathsZ via _internals for this parity check');
    assert.deepEqual(viaVcs('a.mjs\0'), { accepted: true, records: ['a.mjs'] });
    assert.deepEqual(viaManifest('a.mjs\0'), { accepted: true, records: ['a.mjs'] });
  });

  for (const [name, content] of CASES) {
    it(`agrees on: ${name}`, () => {
      const m = viaManifest(content);
      const v = viaVcs(content);
      assert.equal(m.accepted, v.accepted,
        `framing disagreement on ${JSON.stringify(content)}: manifest ${m.accepted ? 'accepted' : 'rejected'}, vcs ${v.accepted ? 'accepted' : 'rejected'}`);
      if (m.accepted) assert.deepEqual(m.records, v.records, `record list disagreement on ${JSON.stringify(content)}`);
    });
  }

  it('covers both accepting and rejecting outcomes (no all-one-way census)', () => {
    // A parity suite where every case lands on the same side would pass even if
    // one parser accepted nothing at all.
    const outcomes = CASES.map(([, c]) => viaManifest(c).accepted);
    assert.ok(outcomes.includes(true), 'at least one case must be accepted');
    assert.ok(outcomes.includes(false), 'at least one case must be rejected');
  });
});
