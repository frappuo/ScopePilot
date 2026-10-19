const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/loadTs.cjs');
const { channels, contrastRatio, mix } = require('./helpers/contrast.cjs');

const { palettes, themeFor } = loadTs('src/theme/tokens.ts');

const TEXT = 4.5; // WCAG AA, normal text
const UI = 3; // WCAG AA, UI component boundaries
const SOFT_ALPHA = 0.13;
const STATUS = ['accent', 'info', 'success', 'warning', 'danger'];
const SOFTS = STATUS.map(name => `${name}Soft`);
const BASES = ['canvas', 'surface', 'surfaceMuted'];

// [foreground, background, minimum ratio]
const CONTRAST_PAIRS = [
  ...['text', 'textMuted'].flatMap(fg => [...BASES, ...SOFTS].map(bg => [fg, bg, TEXT])),
  ...STATUS.flatMap(fg => [...BASES, `${fg}Soft`].map(bg => [fg, bg, TEXT])),
  ['onAccent', 'accent', TEXT],
  ['onAccent', 'danger', TEXT], // destructive button label
  ...BASES.map(bg => ['borderStrong', bg, UI]),
  ['accent', 'surface', UI],
];

for (const scheme of ['light', 'dark']) {
  const colors = palettes[scheme];

  test(`${scheme}: every pair meets its WCAG AA minimum`, () => {
    const failures = CONTRAST_PAIRS
      .map(([fg, bg, minimum]) => ({ fg, bg, minimum, ratio: contrastRatio(colors[fg], colors[bg]) }))
      .filter(pair => pair.ratio < pair.minimum)
      .map(pair => `${pair.fg} on ${pair.bg}: ${pair.ratio.toFixed(2)} < ${pair.minimum}`);
    assert.deepEqual(failures, []);
  });

  test(`${scheme}: each soft colour is its foreground at 13% over surface`, () => {
    for (const name of STATUS) {
      const expected = channels(mix(colors[name], colors.surface, SOFT_ALPHA));
      const actual = channels(colors[`${name}Soft`]);
      actual.forEach((value, index) =>
        assert.ok(Math.abs(value - expected[index]) <= 1, `${name}Soft ${colors[`${name}Soft`]} should be about ${mix(colors[name], colors.surface, SOFT_ALPHA)}`));
    }
  });

  test(`${scheme}: every token is a #RRGGBB colour`, () => {
    for (const [name, value] of Object.entries(colors)) assert.match(value, /^#[0-9A-F]{6}$/, name);
  });

  test(`${scheme}: themeFor returns the palette and a matching elevation`, () => {
    const theme = themeFor(scheme);
    assert.equal(theme.scheme, scheme);
    assert.equal(theme.colors, colors);
    if (scheme === 'dark') {
      assert.equal(theme.elevation.borderColor, colors.border);
      assert.equal(theme.elevation.shadowOpacity, undefined);
    } else {
      assert.ok(theme.elevation.shadowOpacity > 0);
    }
  });
}

test('both palettes define the same tokens', () => {
  assert.deepEqual(Object.keys(palettes.dark).sort(), Object.keys(palettes.light).sort());
});

test('the pair list covers every text and soft token', () => {
  const used = new Set(CONTRAST_PAIRS.flatMap(([fg, bg]) => [fg, bg]));
  for (const name of Object.keys(palettes.light).filter(key => key !== 'border')) assert.ok(used.has(name), name);
});
