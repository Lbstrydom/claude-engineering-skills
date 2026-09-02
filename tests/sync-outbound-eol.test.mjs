/**
 * @fileoverview Unit contract for the sync's outbound EOL fold.
 *
 * Covers defect 1 of the 2026-09-02 consumer report (see
 * `sync-outbound-eol-e2e.test.mjs` for the full narrative): the sync copied
 * WORKING-TREE bytes, so a Windows checkout holding CRLF shipped CRLF into
 * consumers while the same run wrote a `.gitattributes` block pinning those
 * paths to `text eol=lf`. The e2e suite next door cannot prove this half —
 * reproducing it would mean making the source checkout CRLF, which would make
 * the test assert a property of whoever is running it.
 *
 * The load-bearing assertions here are the NEGATIVE ones. A fold that folds is
 * easy; the ways this goes wrong are folding something it must not touch — a
 * CRLF-pinned Windows launcher, or binary content where `0x0D 0x0A` is ordinary
 * data rather than a line ending.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicaliseOutboundEol,
  shouldEmitLf,
  CRLF_PINNED_EXTENSIONS,
  EOL_PIN_GLOBS,
  renderEolPinLines,
} from '../scripts/lib/sync-eol-pins.mjs';

describe('shouldEmitLf', () => {
  it('says yes for every ordinary synced surface', () => {
    for (const p of [
      '.claude/hooks/quickfix-scan.mjs',
      '.claude/skills/plan/SKILL.md',
      '.claude/settings.json',
      '.audit-loop/migrations/0001_init.sql',
      'scripts/.claude-skills/cross-skill.mjs',
    ]) {
      assert.equal(shouldEmitLf(p), true, `${p} should be written LF`);
    }
  });

  it('exempts the CRLF-pinned Windows launcher extensions', () => {
    for (const ext of CRLF_PINNED_EXTENSIONS) {
      assert.equal(shouldEmitLf(`bin/launcher${ext}`), false, `${ext} must keep CRLF`);
    }
  });

  it('matches the extension case-insensitively', () => {
    // Windows paths arrive in whatever case the filesystem reports; a
    // case-sensitive check would fold `.CMD` and corrupt the launcher.
    assert.equal(shouldEmitLf('bin/launcher.CMD'), false);
    assert.equal(shouldEmitLf('bin/launcher.Ps1'), false);
  });

  it('is insensitive to path separator style', () => {
    assert.equal(shouldEmitLf('bin\\launcher.cmd'), false);
  });
});

describe('canonicaliseOutboundEol', () => {
  it('folds CRLF to LF for a synced text destination', () => {
    assert.equal(
      canonicaliseOutboundEol('.claude/hooks/a.mjs', 'a\r\nb\r\nc'),
      'a\nb\nc',
    );
  });

  it('is idempotent — already-LF content is returned unchanged', () => {
    const lf = 'a\nb\nc\n';
    assert.equal(canonicaliseOutboundEol('.claude/hooks/a.mjs', lf), lf);
  });

  it('leaves a lone CR alone — only CRLF pairs are line endings', () => {
    // A bare CR can be data (or an old-Mac line ending we have no mandate to
    // rewrite). Folding it would widen a line-ending fold into a normalizer.
    assert.equal(canonicaliseOutboundEol('a.md', 'a\rb'), 'a\rb');
  });

  it('does NOT fold a CRLF-pinned launcher', () => {
    const crlf = '@echo off\r\nnode x.mjs\r\n';
    assert.equal(canonicaliseOutboundEol('bin/run.cmd', crlf), crlf);
  });

  it('does NOT fold content carrying a NUL byte', () => {
    // In binary the exact bytes are the contract and 0x0D 0x0A is ordinary
    // data — the same rule `eolInsensitiveEqual` and git itself apply.
    // Built from char codes on purpose: a raw NUL in this file would make git
    // call the whole test BINARY (guarded by no-raw-nul-in-source.test.mjs).
    const bin = 'PK' + String.fromCharCode(0) + '\r\n' + String.fromCharCode(0) + 'tail';
    // Vacuous-pass guard: the fixture must carry BOTH a NUL (or nothing is
    // being exempted) and a CRLF (or there is nothing the fold could have
    // wrongly changed). Without these, an edit to the literal could quietly
    // turn this into an assertion that LF text is returned unchanged.
    assert.ok(bin.includes(String.fromCharCode(0)), 'fixture lost its NUL — nothing is being exempted');
    assert.ok(bin.includes('\r\n'), 'fixture lost its CRLF — the fold has nothing to wrongly change');
    assert.equal(canonicaliseOutboundEol('assets/x.bin', bin), bin);
  });

  it('passes non-string and empty input straight through', () => {
    // `readSource` returns null for a missing file, and the ownership
    // classifier feeds that result in directly.
    assert.equal(canonicaliseOutboundEol('a.md', null), null);
    assert.equal(canonicaliseOutboundEol('a.md', undefined), undefined);
    assert.equal(canonicaliseOutboundEol('a.md', ''), '');
  });

  it('preserves non-ASCII content byte-for-byte while folding', () => {
    // The fold round-trips through a Buffer; a UTF-8 bug here would corrupt
    // every skill file, which are full of em-dashes and arrows.
    assert.equal(
      canonicaliseOutboundEol('.claude/skills/plan/SKILL.md', '— ✓ ✗\r\nnext — line\r\n'),
      '— ✓ ✗\nnext — line\n',
    );
  });

  it('does not mutate or alias its input', () => {
    const src = 'a\r\nb';
    const out = canonicaliseOutboundEol('a.md', src);
    assert.equal(src, 'a\r\nb', 'input string must be untouched');
    assert.notEqual(out, src);
  });
});

describe('the fold agrees with the pins the sync writes', () => {
  it('every emitted pin declares eol=lf, which is what the fold produces', () => {
    // The report's root contradiction was the sync declaring `eol=lf` in a
    // consumer's .gitattributes while writing CRLF. Tie the two together so
    // they cannot drift apart again: if a pin ever stops saying eol=lf, the
    // fold is no longer the right transform for it.
    const lines = renderEolPinLines([...EOL_PIN_GLOBS]);
    assert.ok(lines.length > 0, 'no pins rendered — this assertion would be vacuous');
    for (const line of lines) {
      assert.match(line, /\stext eol=lf$/, `pin does not declare eol=lf: ${line}`);
    }
  });

  it('no pinned glob targets a CRLF-pinned extension', () => {
    for (const glob of EOL_PIN_GLOBS) {
      for (const ext of CRLF_PINNED_EXTENSIONS) {
        assert.ok(
          !String(glob).toLowerCase().endsWith(ext),
          `${glob} is pinned eol=lf but ends in a CRLF-pinned extension`,
        );
      }
    }
  });
});
