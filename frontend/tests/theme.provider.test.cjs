const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createElement } = require('react');
const { renderToString } = require('react-dom/server');
const { loadTs } = require('./helpers/loadTs.cjs');

const { palettes } = loadTs('src/theme/tokens.ts');

// The system setting the stubbed useColorScheme reports.
let system = 'light';
// The style the stubbed StatusBar was last rendered with.
let statusBarStyle = null;
const {
  FOLLOW_SYSTEM_SCHEME, ThemeProvider, ThemedStatusBar, applyRootBackground, resolveScheme, useTheme,
} = loadTs('src/theme/ThemeProvider.tsx', {
  'react-native': { useColorScheme: () => system },
  'expo-status-bar': { StatusBar: props => { statusBarStyle = props.style; return null; } },
  'expo-system-ui': { setBackgroundColorAsync: () => Promise.resolve() },
});

function renderedTheme(providerProps) {
  let seen = null;
  function Probe() { seen = useTheme(); return null; }
  const probe = createElement(Probe);
  renderToString(providerProps ? createElement(ThemeProvider, providerProps, probe) : probe);
  return seen;
}

test('the app follows the system setting by default', () => {
  assert.equal(FOLLOW_SYSTEM_SCHEME, true);
});

test('with the default flag a dark system gives the dark theme', () => {
  system = 'dark';
  const theme = renderedTheme({});
  assert.equal(theme.scheme, 'dark');
  assert.deepStrictEqual(theme.colors, palettes.dark);
});

test('with following turned off the theme is light even when the system is dark', () => {
  system = 'dark';
  const theme = renderedTheme({ followSystem: false });
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

test('the status bar text contrasts with the theme, not the raw system setting', () => {
  for (const [value, expected] of [['dark', 'light'], ['light', 'dark'], [null, 'dark']]) {
    system = value;
    statusBarStyle = null;
    renderToString(createElement(ThemeProvider, {}, createElement(ThemedStatusBar)));
    assert.equal(statusBarStyle, expected, String(value));
  }
  system = 'dark';
  renderToString(createElement(ThemeProvider, { followSystem: false }, createElement(ThemedStatusBar)));
  assert.equal(statusBarStyle, 'dark');
});

function silenceConsole(context) {
  const calls = [];
  for (const method of ['error', 'warn', 'info', 'log']) {
    context.mock.method(console, method, (...args) => calls.push(args));
  }
  return calls;
}

test('applyRootBackground passes the colour to the setter', () => {
  const seen = [];
  applyRootBackground('#12100D', color => { seen.push(color); return Promise.resolve(); });
  assert.deepEqual(seen, ['#12100D']);
});

test('applyRootBackground swallows a rejected promise without logging', async context => {
  const calls = silenceConsole(context);
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.doesNotThrow(() => applyRootBackground('#12100D', () => Promise.reject(new Error('native failed'))));
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled.length, 0);
  assert.equal(calls.length, 0);
});

test('applyRootBackground swallows a synchronous throw without logging', context => {
  const calls = silenceConsole(context);
  assert.doesNotThrow(() => applyRootBackground('#12100D', () => { throw new Error('module missing'); }));
  assert.equal(calls.length, 0);
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
