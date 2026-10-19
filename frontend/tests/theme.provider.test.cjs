const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createElement } = require('react');
const { renderToString } = require('react-dom/server');
const { loadTs } = require('./helpers/loadTs.cjs');

const { palettes } = loadTs('src/theme/tokens.ts');

// The system setting the stubbed useColorScheme reports.
let system = 'light';
const { FOLLOW_SYSTEM_SCHEME, ThemeProvider, resolveScheme, useTheme } = loadTs('src/theme/ThemeProvider.tsx', {
  'react-native': { useColorScheme: () => system },
});

function renderedTheme(providerProps) {
  let seen = null;
  function Probe() { seen = useTheme(); return null; }
  const probe = createElement(Probe);
  renderToString(providerProps ? createElement(ThemeProvider, providerProps, probe) : probe);
  return seen;
}

test('following the system is off until app.json allows dark mode', () => {
  assert.equal(FOLLOW_SYSTEM_SCHEME, false);
});

test('with the default flag the theme is light even when the system is dark', () => {
  system = 'dark';
  const theme = renderedTheme({});
  assert.equal(theme.scheme, 'light');
  assert.deepStrictEqual(theme.colors, palettes.light);
});

test('following the system: dark gives dark, anything else gives light', () => {
  for (const [value, expected] of [['dark', 'dark'], ['light', 'light'], [null, 'light'], [undefined, 'light'], ['unspecified', 'light']]) {
    system = value;
    const theme = renderedTheme({ followSystem: true });
    assert.equal(theme.scheme, expected, String(value));
    assert.deepStrictEqual(theme.colors, palettes[expected]);
  }
});

test('a system change re-renders with the other theme', () => {
  system = 'light';
  assert.equal(renderedTheme({ followSystem: true }).scheme, 'light');
  system = 'dark';
  assert.equal(renderedTheme({ followSystem: true }).scheme, 'dark');
  system = 'light';
  assert.equal(renderedTheme({ followSystem: true }).scheme, 'light');
});

test('resolveScheme only returns dark when following a dark system', () => {
  assert.equal(resolveScheme('dark', false), 'light');
  assert.equal(resolveScheme('dark', true), 'dark');
  assert.equal(resolveScheme('light', true), 'light');
  assert.equal(resolveScheme(null, true), 'light');
});

test('useTheme outside a provider gives the light theme', () => {
  system = 'dark';
  assert.equal(renderedTheme(null).scheme, 'light');
});

test('the navigation theme maps the tokens and keeps the base fonts', () => {
  const fonts = { regular: { fontFamily: 'System', fontWeight: '400' } };
  const base = dark => ({ dark, colors: { primary: '#000000', background: '#000000', card: '#000000', text: '#000000', border: '#000000', notification: '#000000' }, fonts });
  const { toNavigationTheme } = loadTs('src/theme/navigationTheme.ts', {
    '@react-navigation/native': { DefaultTheme: base(false), DarkTheme: base(true) },
  });
  const { themeFor } = loadTs('src/theme/tokens.ts');
  for (const scheme of ['light', 'dark']) {
    const colors = palettes[scheme];
    const navigation = toNavigationTheme(themeFor(scheme));
    assert.equal(navigation.dark, scheme === 'dark');
    assert.deepEqual(navigation.colors, {
      primary: colors.accent, background: colors.canvas, card: colors.canvas,
      text: colors.text, border: colors.border, notification: colors.danger,
    });
    assert.deepStrictEqual(navigation.fonts, fonts);
  }
});
