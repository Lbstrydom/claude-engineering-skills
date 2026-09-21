/**
 * @fileoverview Tier-1 tests for token normalization + allowed-set extraction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeColor, normalizeLength, normalizeByFamily, extractAllowedSet, buildTokenIndex, inferClusters } from '../scripts/lib/visual/tokens.mjs';

test('normalizeColor canonicalizes hex/rgb/shorthand to r,g,b[,a]', () => {
  assert.equal(normalizeColor('#FFF'), '255,255,255');
  assert.equal(normalizeColor('#ff0000'), '255,0,0');
  assert.equal(normalizeColor('rgb(0, 128, 255)'), '0,128,255');
  assert.equal(normalizeColor('rgba(0,0,0,0.5)'), '0,0,0,0.5');
  assert.equal(normalizeColor('transparent'), '0,0,0,0');
  assert.equal(normalizeColor('not-a-color'), null);
});

test('normalizeLength converts rem→px at 16 base and rounds', () => {
  assert.equal(normalizeLength('1rem'), '16px');
  assert.equal(normalizeLength('8px'), '8px');
  assert.equal(normalizeLength('0.5rem'), '8px');
  assert.equal(normalizeLength('auto'), null);
});

test('normalizeByFamily maps fontWeight keywords + unitless lineHeight', () => {
  assert.equal(normalizeByFamily('fontWeight', 'bold'), '700');
  assert.equal(normalizeByFamily('lineHeight', '1.5'), '1.5');
  assert.equal(normalizeByFamily('colors', '#000'), '0,0,0');
});

test('extractAllowedSet reads css-vars + json and builds a usable index', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-tokens-'));
  fs.writeFileSync(path.join(dir, 'tokens.css'), ':root{--color-brand:#3366ff;--space-2:8px;--radius-md:6px;}');
  fs.writeFileSync(path.join(dir, 'extra.json'), JSON.stringify({ colors: { accent: '#ff8800' }, spacing: { lg: '16px' } }));
  const contract = {
    tokenSources: [
      { type: 'css-vars', path: 'tokens.css' },
      { type: 'json', path: 'extra.json' },
    ],
  };
  const { allowedSet, tokenIndex } = await extractAllowedSet(dir, contract);
  assert.equal(allowedSet.inferredMode, false);
  assert.ok(tokenIndex.has('colors', '51,102,255'), 'css var color in scale');
  assert.ok(tokenIndex.has('spacing', '8px'), 'css var spacing in scale');
  assert.ok(tokenIndex.has('colors', '255,136,0'), 'json color in scale');
  assert.equal(tokenIndex.has('colors', '1,2,3'), false, 'unknown color not in scale');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('`--font-*` named length tokens classify as fontSize, not spacing (shakedown #1)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-font-'));
  fs.writeFileSync(path.join(dir, 'vars.css'), ':root{--font-sm:0.85rem;--btn-font-lg:1.2rem;--space-2:8px;--font-weight-bold:700;}');
  const { allowedSet, tokenIndex } = await extractAllowedSet(dir, { tokenSources: [{ type: 'css-vars', path: 'vars.css' }] });
  assert.ok(tokenIndex.has('fontSize', '13.6px'), '0.85rem → 13.6px in fontSize (rem→px)');
  assert.ok(tokenIndex.has('fontSize', '19.2px'), '--btn-font-lg 1.2rem → 19.2px in fontSize');
  assert.ok(tokenIndex.has('spacing', '8px'), '--space-2 stays spacing');
  assert.ok(!(allowedSet.families.spacing || []).some((t) => t.value === '13.6px'), 'font sizes no longer pollute spacing');
  assert.ok(tokenIndex.has('fontWeight', '700'), '--font-weight-bold stays fontWeight (unitless)');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('extractAllowedSet with no sources → inferredMode', async () => {
  const { allowedSet } = await extractAllowedSet('/nonexistent', { tokenSources: [] });
  assert.equal(allowedSet.inferredMode, true);
});

test('inferClusters flags a minority outlier only when a dominant cluster exists', () => {
  const vals = [];
  for (let i = 0; i < 9; i++) vals.push({ family: 'spacing', value: '8px' });
  vals.push({ family: 'spacing', value: '11px' });
  const out = inferClusters(vals);
  assert.ok(out.some((o) => o.value === '11px'), 'outlier flagged');
  assert.ok(!out.some((o) => o.value === '8px'), 'dominant value not flagged');
});

test('buildTokenIndex respects theme scoping', () => {
  const idx = buildTokenIndex({ colors: [{ value: '0,0,0', varName: '--fg', theme: 'dark' }] });
  assert.equal(idx.has('colors', '0,0,0', 'dark'), true);
  assert.equal(idx.has('colors', '0,0,0', 'light'), false, 'dark-scoped token not valid in light');
});

// ── light-dark() (storyline 2026-09-21: 20 light-dark() colours + 2 var() aliases
// out of 38 custom properties extracted as `colors: absent, warnings: []`) ──────

/** A `:root` block in the shape of storyline's tokens.css: every colour is ONE
 *  declaration carrying both themes via light-dark(), plus var() aliases, a
 *  spacing scale, a type scale and the color-scheme switches. */
function storylineShapedCss(n = 22) {
  const colors = [];
  for (let i = 0; i < n; i++) {
    // Distinct per-theme values so the count is a count of declarations, not of
    // deduplicated values (the real file repeats #ffffff three times in light).
    const l = (0x100000 + i * 0x010101).toString(16).padStart(6, '0');
    const d = (0xe00000 + i * 0x010101).toString(16).padStart(6, '0');
    colors.push(`  --color-t${i}: light-dark(#${l}, #${d});`);
  }
  return [
    ':root {',
    '  color-scheme: light dark;',
    ...colors,
    '  --color-border: var(--color-t3);',
    '  --color-focus-ring: var(--color-t8);',
    '  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;',
    '  --space-5: 24px; --space-6: 32px; --space-7: 48px;',
    "  --font-family-base: -apple-system, 'Segoe UI', Roboto, sans-serif;",
    '  --font-size-sm: 13px; --font-size-base: 15px; --font-size-lg: 18px; --font-size-xl: 22px;',
    '  --line-height-base: 1.5;',
    '  --radius-sm: 4px; --radius-md: 8px;',
    '  --target-min: 44px;',
    '}',
    '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; } }',
    ':root[data-theme="dark"] { color-scheme: dark; }',
    ':root[data-theme="light"] { color-scheme: light; }',
  ].join('\n');
}

test('css-vars: a light-dark(a, b) colour yields one light + one dark token, never a silent drop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-light-dark-'));
  fs.writeFileSync(path.join(dir, 'tokens.css'), storylineShapedCss(22));
  const { allowedSet, tokenIndex, warnings } = await extractAllowedSet(dir, { tokenSources: [{ type: 'css-vars', path: 'tokens.css' }] });
  const colors = allowedSet.families.colors || [];
  assert.equal(new Set(colors.map((t) => t.varName)).size, 22, '22 light-dark() colour declarations all survive extraction');
  assert.equal(colors.filter((t) => t.theme === 'light').length, 22, 'one light half per declaration');
  assert.equal(colors.filter((t) => t.theme === 'dark').length, 22, 'one dark half per declaration');
  assert.equal(colors.length, 44);
  // --color-t0: light-dark(#100000, #e00000)
  assert.equal(tokenIndex.has('colors', '16,0,0', 'light'), true, 'light half counts for light');
  assert.equal(tokenIndex.has('colors', '16,0,0', 'dark'), false, 'light half does NOT count for dark (buildTokenIndex theme semantics kept)');
  assert.equal(tokenIndex.has('colors', '224,0,0', 'dark'), true, 'dark half counts for dark');
  assert.equal(tokenIndex.has('colors', '224,0,0', 'light'), false);
  assert.equal(tokenIndex.varFor('colors', '224,0,0'), '--color-t0', 'provenance survives the split');
  // The rest of the file is unchanged by the fix (the pre-fix measurement).
  const counts = Object.fromEntries(Object.entries(allowedSet.families).map(([k, v]) => [k, v.length]));
  assert.deepEqual({ spacing: counts.spacing, fontSize: counts.fontSize, lineHeight: counts.lineHeight, radius: counts.radius }, { spacing: 8, fontSize: 4, lineHeight: 1, radius: 2 });
  assert.deepEqual(warnings, [], 'a fully-parsed file warns about nothing');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('css-vars: light-dark() halves may themselves contain commas (rgb()/rgba())', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-light-dark-rgb-'));
  fs.writeFileSync(path.join(dir, 'tokens.css'), ':root{--color-a: light-dark(rgb(1, 2, 3), rgba(4,5,6,0.5));--color-b:light-dark( #fff , #000 );}');
  const { tokenIndex, warnings } = await extractAllowedSet(dir, { tokenSources: [{ type: 'css-vars', path: 'tokens.css' }] });
  assert.equal(tokenIndex.has('colors', '1,2,3', 'light'), true);
  assert.equal(tokenIndex.has('colors', '4,5,6,0.5', 'dark'), true);
  assert.equal(tokenIndex.has('colors', '255,255,255', 'light'), true, 'whitespace around halves is tolerated');
  assert.equal(tokenIndex.has('colors', '0,0,0', 'dark'), true);
  assert.deepEqual(warnings, []);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('css-vars: a theme-scoped source takes only the matching light-dark() half and says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-light-dark-scoped-'));
  fs.writeFileSync(path.join(dir, 'dark.css'), ':root{--color-a: light-dark(#111111, #eeeeee);--color-b: light-dark(#222222, #dddddd);--color-c:#333333;}');
  const { allowedSet, tokenIndex, warnings } = await extractAllowedSet(dir, { tokenSources: [{ type: 'css-vars', path: 'dark.css', theme: 'dark' }] });
  const colors = allowedSet.families.colors || [];
  assert.equal(tokenIndex.has('colors', '238,238,238', 'dark'), true, 'dark half kept');
  assert.equal(colors.some((t) => t.value === '17,17,17'), false, 'light half of a dark-scoped source is NOT admitted');
  assert.ok(colors.every((t) => t.theme === 'dark'), 'every token carries the source theme');
  assert.equal(tokenIndex.has('colors', '51,51,51', 'dark'), true, 'plain value still scoped to the source theme');
  const mismatch = warnings.filter((w) => w.startsWith('token_light_dark_theme_scoped:'));
  assert.equal(mismatch.length, 1, 'one aggregated warning per source, not one per declaration');
  assert.match(mismatch[0], /dark\.css/);
  assert.match(mismatch[0], /theme=dark/);
  assert.match(mismatch[0], /\b2\b/, 'names how many declarations lost a half');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('css-vars: a colour-named var whose value the normaliser cannot parse WARNS instead of vanishing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-unparsed-color-'));
  fs.writeFileSync(path.join(dir, 'tokens.css'), [
    ':root{',
    '--color-brand: hsl(210 40% 50%);',          // `--color-*`
    '--brand-color: oklch(0.7 0.1 250);',          // `--*-color`
    '--text-color-muted: color-mix(in srgb, #000 40%, #fff);', // `--*-color-*`
    '--color-ok: #123456;',                       // parseable control — no warning
    '--color-swatch-size: 24px;',                 // colour-named but a LENGTH: not a colour, not a warning
    '}',
  ].join('\n'));
  const { allowedSet, tokenIndex, warnings } = await extractAllowedSet(dir, { tokenSources: [{ type: 'css-vars', path: 'tokens.css' }] });
  const unparsed = warnings.filter((w) => w.startsWith('token_unparsed_color:'));
  assert.equal(unparsed.length, 3, 'one warning per unparseable colour declaration');
  for (const name of ['--color-brand', '--brand-color', '--text-color-muted']) {
    assert.ok(unparsed.some((w) => w.includes(name) && w.includes('tokens.css')), `${name} is named in a warning`);
  }
  assert.ok(unparsed.some((w) => w.includes('hsl(210 40% 50%)')), 'the offending value is quoted');
  assert.equal(tokenIndex.has('colors', '18,52,86'), true, 'parseable neighbour unaffected');
  assert.equal((allowedSet.families.colors || []).length, 1, 'unparseable values are dropped from the scale (warned, not fabricated)');
  assert.equal(tokenIndex.has('spacing', '24px'), true, '--color-swatch-size stays a length');
  assert.ok(!warnings.some((w) => w.includes('--color-swatch-size')), 'a length is not an unparsed colour');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('json: a colours-family value the normaliser cannot parse warns the same way (one seam, all adapters)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-unparsed-json-'));
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ colors: { brand: 'hsl(210 40% 50%)', ok: '#000' } }));
  const { warnings, tokenIndex } = await extractAllowedSet(dir, { tokenSources: [{ type: 'json', path: 'tokens.json' }] });
  // walkJson names a nested leaf by its enclosing FAMILY key, not its own key
  // (pre-existing provenance limit, out of scope here) — locate by value instead.
  assert.equal(warnings.filter((w) => w.startsWith('token_unparsed_color:') && w.includes('tokens.json') && w.includes('hsl(210 40% 50%)')).length, 1);
  assert.equal(tokenIndex.has('colors', '0,0,0'), true);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
