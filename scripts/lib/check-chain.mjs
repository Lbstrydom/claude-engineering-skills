/**
 * @fileoverview The full push check as ONE chain: `package.json`'s `check` is `npm run check:static && npm test`
 * (docs/plans/gate-cost-slice-2.md D7, so the pre-push sandbox can run the static gates, ask the test-tier oracle, then
 * run the tests), but a reader that wants "every step of the check" (the archive-lane classification, the ratchet
 * wiring tests) must see the static gates inline. This is the one place that expands it.
 *
 * @module scripts/lib/check-chain
 */

/**
 * `scripts.check` with `npm run check:static` replaced by the `check:static` script's own chain. A `check` that does not
 * use the split (an older or consumer `package.json`) is returned unchanged.
 *
 * @param {Record<string, string>} scripts a package.json `scripts` object
 * @returns {string}
 */
export function expandedCheckScript(scripts) {
  const check = scripts?.check;
  if (typeof check !== 'string') throw new Error('package.json has no "check" script');
  const steps = check.split('&&').map((s) => s.trim());
  if (!steps.includes('npm run check:static')) return check;
  const inner = scripts['check:static'];
  if (typeof inner !== 'string' || inner.trim() === '') throw new Error('"check" runs check:static but package.json has no "check:static" script');
  return steps.flatMap((s) => (s === 'npm run check:static' ? [inner.trim()] : [s])).join(' && ');
}
