const { test } = require('node:test');
const assert = require('node:assert/strict');
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
  ActivityIndicator: host('ActivityIndicator'), KeyboardAvoidingView: host('KeyboardAvoidingView'),
  Pressable: host('Pressable'), ScrollView: host('ScrollView'), Text: host('Text'),
  TextInput: host('TextInput'), View: host('View'),
  Platform: { OS: 'ios' },
  StyleSheet: { create: styles => styles, hairlineWidth: 1 },
};

let current = themes.light;
const ui = loadTs('src/components/ui.tsx', {
  'react-native': reactNative,
  'react-native-safe-area-context': { SafeAreaView: host('SafeAreaView') },
  '../theme/ThemeProvider': { useTheme: () => current },
});

function render(scheme, element) {
  current = themes[scheme];
  rendered = [];
  const html = renderToString(element);
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

for (const scheme of ['light', 'dark']) {
  const colors = palettes[scheme];
  const allowed = new Set(Object.values(colors));

  test(`${scheme}: makeUiStyles uses only palette colours`, () => {
    const styles = ui.makeUiStyles(themes[scheme]);
    const outside = Object.entries(styles).flatMap(([name, style]) =>
      Object.entries(style).filter(([key, value]) => /color$/i.test(key) && !allowed.has(value)).map(([key, value]) => `${name}.${key}=${value}`));
    assert.deepEqual(outside, []);
  });

  test(`${scheme}: every rendered primitive uses only palette colours`, () => {
    const { hosts } = render(scheme, createElement(ui.Screen, null,
      createElement(ui.Title, null, 'Title'), createElement(ui.Body, null, 'Body'),
      createElement(ui.AppText, { variant: 'caption' }, 'Caption'),
      createElement(ui.Card, null, createElement(ui.AppText, null, 'In a card')),
      createElement(ui.Card, { tone: 'muted' }, createElement(ui.AppText, null, 'Muted card')),
      createElement(ui.Field, { label: 'Email', value: '' }),
      ...['primary', 'secondary', 'ghost', 'destructive'].flatMap(variant => [
        createElement(ui.Button, { key: variant, title: variant, onPress() {}, variant }),
        createElement(ui.Button, { key: `${variant}-busy`, title: variant, onPress() {}, variant, busy: true }),
      ]),
      createElement(ui.LinkButton, { title: 'Link', onPress() {} }),
      ...['error', 'info', 'success', 'warning'].map(kind => createElement(ui.Notice, { key: kind, kind }, kind)),
      createElement(ui.Loading),
      createElement(ui.BrandHeader),
      createElement(ui.ScreenHeading, { title: 'Welcome back', subtitle: 'Subtitle' }),
      createElement(ui.FieldGroup, null,
        createElement(ui.FieldRow, { label: 'Email', value: '' }),
        createElement(ui.PasswordRow, { label: 'Password', value: '' })),
      ...['eye', 'eyeOff', 'account'].map(glyph => createElement(ui.IconButton, { key: glyph, glyph, accessibilityLabel: glyph, onPress() {} })),
      createElement(ui.IconButton, { glyph: 'account', accessibilityLabel: 'Account', onPress() {}, busy: true }),
      createElement(ui.TextLink, { title: 'Link', onPress() {} }),
      createElement(ui.TextLink, { title: 'Action', onPress() {}, role: 'button', disabled: true, align: 'end' }),
      createElement(ui.InlinePrompt, { prompt: 'New to ScopePilot?', linkTitle: 'Create an account', onPress() {} }),
      createElement(ui.EmptyState, { title: 'Empty', body: 'Nothing yet.' }),
      createElement(ui.Button, { title: 'Large', onPress() {}, size: 'large' }),
      createElement(ui.Spacer)));
    const outside = coloursOf(hosts).filter(colour => !allowed.has(colour));
    assert.deepEqual(outside, []);
  });

  test(`${scheme}: the field group has a strong boundary and inset hairlines`, () => {
    const { hosts } = render(scheme, createElement(ui.FieldGroup, null,
      createElement(ui.FieldRow, { label: 'Email', value: '' }),
      createElement(ui.FieldRow, { label: 'Name', value: '' })));
    const group = flatten(find(hosts, 'View')[0].props.style);
    assert.equal(group.backgroundColor, colors.surface);
    assert.equal(group.borderColor, colors.borderStrong);
    assert.equal(group.borderWidth, 1);
    assert.equal(group.borderRadius, themes[scheme].radius.card);
    const separators = find(hosts, 'View').map(view => flatten(view.props.style)).filter(style => style.height === 1);
    assert.equal(separators.length, 1);
    assert.equal(separators[0].backgroundColor, colors.border);
    assert.equal(separators[0].marginLeft, 16);
  });

  test(`${scheme}: field rows use a muted label and a borderless input`, () => {
    const { hosts } = render(scheme, createElement(ui.FieldRow, { label: 'Email', value: '' }));
    assert.equal(flatten(find(hosts, 'Text')[0].props.style).color, colors.textMuted);
    const input = flatten(find(hosts, 'TextInput')[0].props.style);
    assert.equal(input.color, colors.text);
    assert.equal(input.backgroundColor, colors.surface);
    assert.equal(input.fontSize, 17);
    assert.equal(input.borderWidth, undefined);
  });

  test(`${scheme}: text links are accent without an underline`, () => {
    const { hosts } = render(scheme, createElement(ui.TextLink, { title: 'Forgot password?', onPress() {} }));
    const text = flatten(find(hosts, 'Text')[0].props.style);
    assert.equal(text.color, colors.accent);
    assert.equal(text.textDecorationLine, undefined);
    assert.equal(flatten(find(hosts, 'Pressable')[0].props.style).minHeight, 44);
  });

  test(`${scheme}: icon glyphs are muted`, () => {
    for (const glyph of ['eye', 'eyeOff', 'account']) {
      const { hosts } = render(scheme, createElement(ui.IconButton, { glyph, accessibilityLabel: glyph, onPress() {} }));
      assert.deepEqual([...new Set(coloursOf(hosts))], [colors.textMuted], glyph);
    }
  });

  test(`${scheme}: the large button is 54 tall with the button radius`, () => {
    const { hosts } = render(scheme, createElement(ui.Button, { title: 'Sign in', onPress() {}, size: 'large' }));
    const pressable = flatten(find(hosts, 'Pressable')[0].props.style);
    assert.equal(pressable.minHeight, 54);
    assert.equal(pressable.borderRadius, 14);
    assert.equal(pressable.backgroundColor, colors.accent);
  });

  test(`${scheme}: button variants use their tokens`, () => {
    const expected = {
      primary: { background: colors.accent, text: colors.onAccent },
      destructive: { background: colors.danger, text: colors.onAccent },
      secondary: { background: undefined, border: colors.borderStrong, text: colors.accent },
      ghost: { background: undefined, border: undefined, text: colors.accent },
    };
    for (const [variant, tokens] of Object.entries(expected)) {
      const { hosts } = render(scheme, createElement(ui.Button, { title: 'Go', onPress() {}, variant }));
      const pressable = flatten(find(hosts, 'Pressable')[0].props.style);
      assert.equal(pressable.backgroundColor, tokens.background, variant);
      if ('border' in tokens) assert.equal(pressable.borderColor, tokens.border, variant);
      assert.equal(flatten(find(hosts, 'Text')[0].props.style).color, tokens.text, variant);
    }
  });

  test(`${scheme}: screen background is the canvas`, () => {
    const { hosts } = render(scheme, createElement(ui.Screen, null, 'Content'));
    assert.equal(flatten(find(hosts, 'SafeAreaView')[0].props.style).backgroundColor, colors.canvas);
  });

  test(`${scheme}: a screen footer sits on the canvas and uses only palette colours`, () => {
    const { hosts } = render(scheme, createElement(ui.Screen, { footer: createElement(ui.Button, { title: 'Sign in', onPress() {}, size: 'large' }) }, 'Content'));
    const footer = find(hosts, 'View').map(view => flatten(view.props.style)).find(style => style.backgroundColor === colors.canvas);
    assert.ok(footer, 'footer view');
    assert.deepEqual(coloursOf(hosts).filter(colour => !allowed.has(colour)), []);
  });
}

test('the default button keeps its role, state and label', () => {
  const { html, hosts } = render('light', createElement(ui.Button, { title: 'Sign in', onPress() {} }));
  const pressable = find(hosts, 'Pressable')[0].props;
  assert.equal(pressable.accessibilityRole, 'button');
  assert.deepEqual(pressable.accessibilityState, { disabled: false, busy: false });
  assert.equal(pressable.disabled, false);
  assert.match(html, /Sign in/);
  assert.equal(find(hosts, 'ActivityIndicator').length, 0);
});

test('a disabled button reports disabled and is dimmed', () => {
  const { hosts } = render('light', createElement(ui.Button, { title: 'Verify code', onPress() {}, disabled: true }));
  const pressable = find(hosts, 'Pressable')[0].props;
  assert.deepEqual(pressable.accessibilityState, { disabled: true, busy: false });
  assert.equal(pressable.disabled, true);
  assert.equal(flatten(pressable.style).opacity, 0.5);
});

test('a busy button keeps today\'s state and shows a spinner instead of its label', () => {
  for (const variant of ['primary', 'secondary']) {
    const { html, hosts } = render('light', createElement(ui.Button, { title: 'Sign out', onPress() {}, busy: true, variant }));
    const pressable = find(hosts, 'Pressable')[0].props;
    assert.equal(pressable.accessibilityRole, 'button');
    assert.deepEqual(pressable.accessibilityState, { disabled: true, busy: true });
    assert.equal(pressable.disabled, true);
    assert.equal(find(hosts, 'ActivityIndicator').length, 1);
    assert.equal(find(hosts, 'Text').length, 0);
    assert.doesNotMatch(html, /Sign out/);
  }
});

test('notices: only errors are alerts, all are polite live regions', () => {
  for (const kind of ['error', 'info', 'success', 'warning']) {
    const { html, hosts } = render('light', createElement(ui.Notice, { kind }, 'Message'));
    const view = find(hosts, 'View')[0].props;
    assert.equal(view.accessibilityRole, kind === 'error' ? 'alert' : undefined, kind);
    assert.equal(view.accessibilityLiveRegion, 'polite', kind);
    assert.match(html, /Message/);
  }
});

test('field labels its input and lets callers override props', () => {
  const { html, hosts } = render('light', createElement(ui.Field, { label: 'Password', secureTextEntry: true, placeholder: 'x' }));
  const input = find(hosts, 'TextInput')[0].props;
  assert.equal(input.accessibilityLabel, 'Password');
  assert.equal(input.secureTextEntry, true);
  assert.equal(input.placeholderTextColor, palettes.light.textMuted);
  assert.match(html, /Password/);
  const overridden = render('light', createElement(ui.Field, { label: 'Code', accessibilityLabel: 'Six-digit code' }));
  assert.equal(find(overridden.hosts, 'TextInput')[0].props.accessibilityLabel, 'Six-digit code');
});

test('title is a header; link keeps its role', () => {
  const title = render('light', createElement(ui.Title, null, 'Sign in to ScopePilot'));
  assert.equal(find(title.hosts, 'Text')[0].props.accessibilityRole, 'header');
  const link = render('light', createElement(ui.LinkButton, { title: 'Forgot password?', onPress() {} }));
  assert.equal(find(link.hosts, 'Pressable')[0].props.accessibilityRole, 'link');
  assert.match(link.html, /Forgot password\?/);
});

test('text variants cap font scaling from the type scale', () => {
  const { hosts } = render('light', createElement(ui.AppText, { variant: 'display' }, '3'));
  assert.equal(find(hosts, 'Text')[0].props.maxFontSizeMultiplier, themes.light.type.display.maxFontSizeMultiplier);
});

test('bodyLarge is 17/24 and has its own text style', () => {
  assert.deepEqual(themes.light.type.bodyLarge, { fontSize: 17, lineHeight: 24, fontWeight: '400', maxFontSizeMultiplier: 2 });
  assert.equal(themes.light.radius.button, 14);
  const { hosts } = render('light', createElement(ui.AppText, { variant: 'bodyLarge' }, 'Input text'));
  const text = find(hosts, 'Text')[0].props;
  assert.equal(flatten(text.style).fontSize, 17);
  assert.equal(flatten(text.style).maxFontSizeMultiplier, undefined);
  assert.equal(text.maxFontSizeMultiplier, 2);
});

test('a regular button keeps today\'s size', () => {
  const { hosts } = render('light', createElement(ui.Button, { title: 'Go', onPress() {} }));
  const pressable = flatten(find(hosts, 'Pressable')[0].props.style);
  assert.equal(pressable.minHeight, 52);
  assert.equal(pressable.borderRadius, 12);
});

test('passwordToggle labels follow the state', () => {
  assert.deepEqual(ui.passwordToggle(false), { secureTextEntry: true, accessibilityLabel: 'Show password', glyph: 'eye' });
  assert.deepEqual(ui.passwordToggle(true), { secureTextEntry: false, accessibilityLabel: 'Hide password', glyph: 'eyeOff' });
});

test('a password row starts hidden with a 44 pt "Show password" button', () => {
  const { hosts } = render('light', createElement(ui.PasswordRow, { label: 'Password', secureTextEntry: false }));
  const input = find(hosts, 'TextInput')[0].props;
  assert.equal(input.secureTextEntry, true);
  assert.equal(input.accessibilityLabel, 'Password');
  const toggle = find(hosts, 'Pressable')[0].props;
  assert.equal(toggle.accessibilityRole, 'button');
  assert.equal(toggle.accessibilityLabel, 'Show password');
  assert.equal(flatten(toggle.style).width, 44);
  assert.equal(flatten(toggle.style).height, 44);
});

test('icon buttons report role, label and state', () => {
  const idle = render('light', createElement(ui.IconButton, { glyph: 'account', accessibilityLabel: 'Account', onPress() {} }));
  const pressable = find(idle.hosts, 'Pressable')[0].props;
  assert.equal(pressable.accessibilityRole, 'button');
  assert.equal(pressable.accessibilityLabel, 'Account');
  assert.deepEqual(pressable.accessibilityState, { disabled: false, busy: false });
  assert.equal(find(idle.hosts, 'ActivityIndicator').length, 0);
  const busy = render('light', createElement(ui.IconButton, { glyph: 'account', accessibilityLabel: 'Account', onPress() {}, busy: true }));
  assert.deepEqual(find(busy.hosts, 'Pressable')[0].props.accessibilityState, { disabled: true, busy: true });
  assert.equal(find(busy.hosts, 'ActivityIndicator').length, 1);
});

test('text links default to the link role; role="button" keeps a button role and its state', () => {
  const link = render('light', createElement(ui.TextLink, { title: 'Forgot password?', onPress() {} }));
  const linkProps = find(link.hosts, 'Pressable')[0].props;
  assert.equal(linkProps.accessibilityRole, 'link');
  assert.deepEqual(linkProps.accessibilityState, { disabled: false });
  assert.match(link.html, /Forgot password\?/);
  const action = render('light', createElement(ui.TextLink, { title: 'Send a new code', onPress() {}, role: 'button', disabled: true }));
  const actionProps = find(action.hosts, 'Pressable')[0].props;
  assert.equal(actionProps.accessibilityRole, 'button');
  assert.deepEqual(actionProps.accessibilityState, { disabled: true });
  assert.equal(actionProps.disabled, true);
});

test('field rows label their input, allow overrides and use the dark keyboard in dark mode', () => {
  const row = render('dark', createElement(ui.FieldRow, { label: 'Email' }));
  const input = find(row.hosts, 'TextInput')[0].props;
  assert.equal(input.accessibilityLabel, 'Email');
  assert.equal(input.keyboardAppearance, 'dark');
  const overridden = render('light', createElement(ui.FieldRow, { label: 'Code', accessibilityLabel: 'Six-digit code' }));
  assert.equal(find(overridden.hosts, 'TextInput')[0].props.accessibilityLabel, 'Six-digit code');
});

test('field rows still call the caller\'s focus handlers', () => {
  const calls = [];
  const { hosts } = render('light', createElement(ui.FieldRow, {
    label: 'Email', onFocus: () => calls.push('focus'), onBlur: () => calls.push('blur'),
  }));
  const input = find(hosts, 'TextInput')[0].props;
  // The server renderer ignores state updates after rendering; only the callbacks matter here.
  input.onFocus({});
  input.onBlur({});
  assert.deepEqual(calls, ['focus', 'blur']);
});

test('the brand mark is hidden from assistive tech and the wordmark reads ScopePilot', () => {
  const { html, hosts } = render('light', createElement(ui.BrandHeader));
  const mark = find(hosts, 'View')[1].props;
  assert.equal(mark.accessible, false);
  assert.equal(mark.importantForAccessibility, 'no-hide-descendants');
  assert.equal(mark.accessibilityElementsHidden, true);
  assert.match(html, /ScopePilot/);
});

test('the screen heading is a header with a muted subtitle', () => {
  const { hosts } = render('light', createElement(ui.ScreenHeading, { title: 'Welcome back', subtitle: 'Sign in.' }));
  const [title, subtitle] = find(hosts, 'Text');
  assert.equal(title.props.accessibilityRole, 'header');
  assert.equal(flatten(title.props.style).fontSize, 34);
  assert.equal(flatten(subtitle.props.style).color, palettes.light.textMuted);
});

test('the footer renders outside the scroll view, after the content', () => {
  const { html, hosts } = render('light', createElement(ui.Screen, { footer: 'Footer' }, 'Content'));
  assert.equal(find(hosts, 'ScrollView')[0].props.children, 'Content');
  const avoiding = find(hosts, 'KeyboardAvoidingView')[0].props;
  assert.equal(Array.isArray(avoiding.children), true);
  assert.equal(avoiding.children.length, 2);
  assert.ok(html.indexOf('Content') < html.indexOf('Footer'));
});

test('without a footer or fill the screen keeps today\'s content layout', () => {
  const { hosts } = render('light', createElement(ui.Screen, null, 'Content'));
  const views = find(hosts, 'View');
  assert.equal(views.length, 1); // only the measuring wrapper
  assert.equal(flatten(find(hosts, 'ScrollView')[0].props.contentContainerStyle).flexGrow, undefined);
  assert.equal(find(hosts, 'ScrollView')[0].props.keyboardShouldPersistTaps, 'handled');
});

test('fill lets the content grow to the screen height', () => {
  const { hosts } = render('light', createElement(ui.Screen, { fill: true }, 'Content'));
  assert.equal(flatten(find(hosts, 'ScrollView')[0].props.contentContainerStyle).flexGrow, 1);
});

test('the keyboard offset starts at 0 and is measured on layout', () => {
  const { hosts } = render('light', createElement(ui.Screen, null, 'Content'));
  assert.equal(find(hosts, 'KeyboardAvoidingView')[0].props.keyboardVerticalOffset, 0);
  const wrapper = find(hosts, 'View')[0].props;
  assert.equal(typeof wrapper.onLayout, 'function');
  // Without a mounted native view there is nothing to measure, and the handler must not throw.
  assert.doesNotThrow(() => wrapper.onLayout({}));
});

test('dark mode uses the dark keyboard and scroll indicator', () => {
  const field = render('dark', createElement(ui.Field, { label: 'Email' }));
  assert.equal(find(field.hosts, 'TextInput')[0].props.keyboardAppearance, 'dark');
  const screen = render('dark', createElement(ui.Screen, null, 'x'));
  assert.equal(find(screen.hosts, 'ScrollView')[0].props.indicatorStyle, 'white');
});
