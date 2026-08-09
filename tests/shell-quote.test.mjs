/**
 * @fileoverview Contract tests for POSIX shell quoting of values rendered into
 * copy-pasteable command lines.
 *
 * Subject: the worksheet renderer interpolated a filesystem-derived path and
 * model-generated text into a ```bash fence, with the free-text field inside
 * DOUBLE quotes — which still expand `$(...)`, backticks and `$VAR`. Escaping
 * only `"` closed the least interesting hole.
 *
 * The assertions below check the property that actually matters (no shell
 * metacharacter survives UNQUOTED), not a fixed output string, so they cannot
 * be satisfied by a denylist that happens to cover today's examples.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { shellQuoteSingle, shellQuoteLabel } from '../scripts/lib/shell-quote.mjs';

// The payloads an attacker (or an unlucky filename) would actually use.
const HOSTILE = [
  ['command substitution', '$(touch /tmp/pwned)'],
  ['backtick substitution', '`touch /tmp/pwned`'],
  ['variable expansion', '$HOME'],
  ['brace expansion', '${HOME}'],
  ['statement separator', 'a; touch /tmp/pwned'],
  ['pipe', 'a | tee /tmp/pwned'],
  ['background + chain', 'a & touch /tmp/pwned'],
  ['redirect', 'a > /tmp/pwned'],
  ['and-chain', 'a && touch /tmp/pwned'],
  ['embedded double quote', 'a" ; touch /tmp/pwned; echo "'],
  ['embedded single quote', "a' ; touch /tmp/pwned; echo '"],
  ['backslash', 'a\\b'],
  ['newline injection', 'a\ntouch /tmp/pwned'],
  ['glob', '*'],
  ['tilde', '~/secret'],
];

describe('shellQuoteSingle — POSIX quoting is total, not a denylist', () => {
  for (const [label, payload] of HOSTILE) {
    it(`neutralises ${label}`, () => {
      const quoted = shellQuoteSingle(payload);
      // The ONLY quotes in the result must be the wrapping pair plus the
      // `'\''` splices. Everything else is inert by construction.
      assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
      // Strip the splices, then assert no bare quote remains inside.
      const inner = quoted.slice(1, -1).replaceAll("'\\''", '');
      assert.ok(!inner.includes("'"), `an unspliced quote escapes the literal: ${quoted}`);
    });
  }

  it('round-trips byte-exactly through a real shell (the assertion that matters)', function () {
    // Vacuous-pass guard AND the real oracle: ask a POSIX shell what the token
    // actually expands to. A quoting bug that my regex reasoning missed shows
    // up here as a mismatch.
    // Skip ONLY for a genuinely absent interpreter, and say so. A bare
    // `catch { return }` also swallows a broken invocation or a real oracle
    // failure, turning "the probe could not run" into a silent pass — the
    // vacuous-green shape these tests exist to prevent.
    let sh;
    try {
      sh = execFileSync('sh', ['-c', 'echo ok'], { encoding: 'utf-8' }).trim();
    } catch (err) {
      if (err.code === 'ENOENT') {
        process.stderr.write('  [shell-quote] SKIP: no POSIX `sh` on this platform; '
          + 'the structural assertions above still ran, the round-trip oracle did not\n');
        return;
      }
      throw err; // a present-but-failing shell is a real failure, not a skip
    }
    assert.equal(sh, 'ok', 'sanity: the probe shell works');

    for (const [label, payload] of HOSTILE) {
      if (payload.includes('\n')) continue; // echo would add its own newline handling
      const out = execFileSync('sh', ['-c', `printf %s ${shellQuoteSingle(payload)}`], { encoding: 'utf-8' });
      assert.equal(out, payload, `${label} did not survive verbatim`);
    }
  });

  it('proves the probe can FAIL — an unquoted payload does expand (negative control)', function () {
    try {
      execFileSync('sh', ['-c', 'echo ok'], { encoding: 'utf-8' });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    const out = execFileSync('sh', ['-c', 'printf %s $HOME'], { encoding: 'utf-8' });
    assert.notEqual(
      out, '$HOME',
      'if an UNQUOTED $HOME came back literally, the probe cannot detect expansion at all',
    );
  });

  it('coerces null and undefined to an empty quoted token rather than the string "null"', () => {
    assert.equal(shellQuoteSingle(null), "''");
    assert.equal(shellQuoteSingle(undefined), "''");
  });

  it('leaves an ordinary token readable (quoting must not make the worksheet unusable)', () => {
    assert.equal(shellQuoteSingle('tests/foo.test.mjs'), "'tests/foo.test.mjs'");
  });
});

describe('shellQuoteLabel — free text, one line, both shells', () => {
  it('collapses a newline so the command cannot continue onto a second line', () => {
    const q = shellQuoteLabel('pins: a\ntouch /tmp/pwned');
    assert.ok(!q.includes('\n'), 'an embedded newline ends the command early — injection without metacharacters');
    assert.match(q, /touch \/tmp\/pwned/, 'the text is preserved, just flattened');
  });

  it('removes the one character POSIX and PowerShell escape differently', () => {
    const q = shellQuoteLabel("the plan's constraint");
    assert.ok(
      !q.slice(1, -1).includes("'"),
      "a splice would be correct in bash and WRONG in PowerShell; the glyph sidesteps both",
    );
    assert.match(q, /plan’s constraint/);
  });

  it('still neutralises substitution in free text', () => {
    const q = shellQuoteLabel('pins: $(whoami) and `id`');
    assert.equal(q, "'pins: $(whoami) and `id`'");
  });

  it('collapses tabs and trims, so a padded category renders cleanly', () => {
    assert.equal(shellQuoteLabel('  a\tb  '), "'a b'");
  });

  // ── Gaps found by mutation testing, not by review ───────────────────────
  //
  // `npm run mutation -- --target shell-quote` scored 77.78% on the first run
  // with SIX survivors, on tests written deliberately an hour earlier. Both
  // gaps below are real: every assertion above passed against a mutant that
  // broke the behaviour. This is the concrete argument for the instrument.

  // 5 of the 6 survivors were the null/undefined guard: nothing exercised
  // shellQuoteLabel's coercion at all, so Stryker could delete the whole
  // condition, invert its operator, or replace the empty string with
  // "Stryker was here!" and every test still passed.
  it('coerces null and undefined to an empty quoted token', () => {
    assert.equal(shellQuoteLabel(null), "''");
    assert.equal(shellQuoteLabel(undefined), "''");
  });

  it('does not stringify null into the literal text "null"', () => {
    assert.ok(
      !shellQuoteLabel(null).includes('null'),
      'String(null) is "null" — a description reading "null" is a silent data bug',
    );
  });

  it('coerces a non-string value rather than dropping it', () => {
    assert.equal(shellQuoteLabel(42), "'42'");
    assert.equal(shellQuoteLabel(0), "'0'", '0 is falsy but is NOT absent — it must survive');
  });

  // The 6th survivor: /[\r\n\t]+/ mutated to /[\r\n\t]/ and nothing noticed,
  // because every input had only SINGLE separators. A CRLF is two characters,
  // so this is the common case, not an exotic one.
  it('collapses a RUN of whitespace to one space, not one space per character', () => {
    assert.equal(shellQuoteLabel('a\r\n\r\nb'), "'a b'");
    assert.equal(shellQuoteLabel('a\t\t\tb'), "'a b'");
  });
});
