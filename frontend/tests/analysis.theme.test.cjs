const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createElement, Fragment } = require('react');
const { renderToString } = require('react-dom/server');
const { loadTs } = require('./helpers/loadTs.cjs');

const { palettes, themeFor } = loadTs('src/theme/tokens.ts');
const themes = { light: themeFor('light'), dark: themeFor('dark') };

// Stub hosts record their props (Pressable style functions resolved unpressed) and render their children.
let rendered = [];
function host(name) {
  return function Host(props) {
    const style = typeof props.style === 'function' ? props.style({ pressed: false }) : props.style;
    rendered.push({ name, props: { ...props, style } });
    return createElement(Fragment, null, props.children);
  };
}
const reactNative = {
  ActivityIndicator: host('ActivityIndicator'), Image: host('Image'), KeyboardAvoidingView: host('KeyboardAvoidingView'),
  Pressable: host('Pressable'), ScrollView: host('ScrollView'), Text: host('Text'),
  TextInput: host('TextInput'), View: host('View'),
  Dimensions: { get: () => ({ width: 390, height: 844 }) },
  Keyboard: { addListener: () => ({ remove() {} }) },
  Platform: { OS: 'ios' },
  StyleSheet: { create: styles => styles, hairlineWidth: 1 },
};

let current = themes.light;
const screen = loadTs('src/screens/AnalysisScreen.tsx', {
  'react-native': reactNative,
  'react-native-safe-area-context': { SafeAreaView: host('SafeAreaView') },
  '../services/api': { analyzeImage: async () => null, askQuestion: async () => '', generateQuiz: async () => null },
  '../services/images': { selectImage: async () => null },
  '../theme/ThemeProvider': { useTheme: () => current },
});

function render(scheme) {
  current = themes[scheme];
  rendered = [];
  const html = renderToString(createElement(screen.default));
  return { html, hosts: rendered };
}

function flatten(style) {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style || {};
}

const find = (hosts, name) => hosts.filter(entry => entry.name === name);

// Every colour a host received, from its style or from a *Color / color prop.
function coloursOf(hosts) {
  return hosts.flatMap(({ props }) => [
    ...Object.entries(flatten(props.style)).filter(([key]) => /color$/i.test(key)).map(([, value]) => value),
    ...Object.entries(props).filter(([key]) => /color$/i.test(key)).map(([, value]) => value),
  ]);
}

test('the screen source has no colour literals', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'screens', 'AnalysisScreen.tsx'), 'utf8');
  assert.deepEqual(source.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi) ?? [], []);
});

for (const scheme of ['light', 'dark']) {
  const colors = palettes[scheme];
  const allowed = new Set(Object.values(colors));

  test(`${scheme}: makeAnalysisStyles uses only palette colours`, () => {
    const styles = screen.makeAnalysisStyles(themes[scheme]);
    const outside = Object.entries(styles).flatMap(([name, style]) =>
      Object.entries(style).filter(([key, value]) => /color$/i.test(key) && !allowed.has(value)).map(([key, value]) => `${name}.${key}=${value}`));
    assert.deepEqual(outside, []);
  });

  test(`${scheme}: the rendered screen uses only palette colours`, () => {
    const { hosts } = render(scheme);
    const outside = coloursOf(hosts).filter(colour => !allowed.has(colour));
    assert.deepEqual(outside, []);
    assert.equal(flatten(find(hosts, 'SafeAreaView')[0].props.style).backgroundColor, colors.canvas);
  });

  test(`${scheme}: quiz options use the success and danger tokens`, () => {
    const styles = screen.makeAnalysisStyles(themes[scheme]);
    assert.equal(styles.optionCorrect.backgroundColor, colors.successSoft);
    assert.equal(styles.optionCorrect.borderColor, colors.success);
    assert.equal(styles.optionWrong.backgroundColor, colors.dangerSoft);
    assert.equal(styles.optionWrong.borderColor, colors.danger);
    assert.equal(styles.optionWrongText.color, colors.danger);
  });

  test(`${scheme}: font sizes and weights come from the type scale`, () => {
    const sizes = new Set(Object.values(themes[scheme].type).map(variant => variant.fontSize));
    const weights = new Set(Object.values(themes[scheme].type).map(variant => variant.fontWeight));
    const styles = screen.makeAnalysisStyles(themes[scheme]);
    const outside = Object.entries(styles).flatMap(([name, style]) => [
      ...('fontSize' in style && !sizes.has(style.fontSize) ? [`${name}.fontSize=${style.fontSize}`] : []),
      ...('fontWeight' in style && !weights.has(style.fontWeight) ? [`${name}.fontWeight=${style.fontWeight}`] : []),
    ]);
    assert.deepEqual(outside, []);
  });
}

test('the idle screen keeps its roles, states and strings', () => {
  const { html, hosts } = render('light');
  const [pick, analyze] = find(hosts, 'Pressable').map(entry => entry.props);
  assert.equal(pick.accessibilityRole, 'button');
  assert.equal(analyze.accessibilityRole, 'button');
  assert.deepEqual(analyze.accessibilityState, { disabled: true });
  assert.equal(analyze.disabled, true);
  assert.equal(flatten(analyze.style).opacity, 0.5);
  assert.equal(find(hosts, 'ActivityIndicator').length, 0);
  assert.equal(find(hosts, 'Text').filter(entry => entry.props.accessibilityRole === 'header').length, 1);
  for (const text of ['MICROSCOPY LEARNING', 'ScopePilot', 'Take a closer look.', 'Choose from gallery', 'Analyze image',
    'Your specimen, up close', 'Not a medical diagnosis.']) {
    assert.ok(html.includes(text), text);
  }
});
