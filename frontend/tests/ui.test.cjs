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
  ActivityIndicator: host('ActivityIndicator'), Image: host('Image'), KeyboardAvoidingView: host('KeyboardAvoidingView'),
  Pressable: host('Pressable'), RefreshControl: host('RefreshControl'), ScrollView: host('ScrollView'), Text: host('Text'),
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

// The last Text host's string content.
const textOfLast = hosts => { const texts = find(hosts, 'Text'); return texts[texts.length - 1].props.children; };

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
      createElement(ui.IconButton, { glyph: 'account', accessibilityLabel: 'Account', onPress() {} }),
      createElement(ui.IconButton, { glyph: 'account', accessibilityLabel: 'Account', onPress() {}, busy: true }),
      createElement(ui.TextLink, { title: 'Link', onPress() {} }),
      createElement(ui.TextLink, { title: 'Action', onPress() {}, role: 'button', disabled: true, align: 'end' }),
      createElement(ui.InlinePrompt, { prompt: 'New to ScopePilot?', linkTitle: 'Create an account', onPress() {} }),
      createElement(ui.EmptyState, { title: 'Empty', body: 'Nothing yet.' }),
      createElement(ui.Button, { title: 'Large', onPress() {}, size: 'large' }),
      createElement(ui.Spacer),
      createElement(ui.ListGroup, null,
        createElement(ui.ListRow, { title: 'Onion epidermis', meta: 'Saved', leading: createElement(ui.ListThumbnail, { uri: 'https://example.test/t.jpg' }), onPress() {} }),
        createElement(ui.ListRow, { title: 'Yeast', leading: createElement(ui.ListThumbnail, { uri: null }), onPress() {}, disabled: true })),
      createElement(ui.StatRow, null, createElement(ui.StatTile, { count: 3, label: 'Saved' })),
      createElement(ui.ChipRow, null, createElement(ui.Chip, { label: 'Cell wall' })),
      ...['info', 'warning', 'neutral'].map(tone => createElement(ui.Pill, { key: tone, label: tone, tone })),
      ...['chevron', 'more', 'warning'].map(glyph => createElement(ui.GlyphView, { key: glyph, glyph }))));
    const outside = coloursOf(hosts).filter(colour => !allowed.has(colour));
    assert.deepEqual(outside, []);
  });

  test(`${scheme}: chevron and more glyphs are muted; the warning glyph uses the warning colour`, () => {
    for (const glyph of ['chevron', 'more']) {
      const { hosts } = render(scheme, createElement(ui.GlyphView, { glyph }));
      assert.deepEqual([...new Set(coloursOf(hosts))], [colors.textMuted], glyph);
    }
    const { hosts } = render(scheme, createElement(ui.GlyphView, { glyph: 'warning' }));
    assert.deepEqual([...new Set(coloursOf(hosts))], [colors.warning]);
  });

  test(`${scheme}: pills pair each tone with its soft background`, () => {
    const expected = {
      info: [colors.infoSoft, colors.info],
      warning: [colors.warningSoft, colors.warning],
      neutral: [colors.surfaceMuted, colors.textMuted],
    };
    for (const [tone, [background, text]] of Object.entries(expected)) {
      const { hosts } = render(scheme, createElement(ui.Pill, { label: 'Tentative', tone }));
      assert.equal(flatten(find(hosts, 'View')[0].props.style).backgroundColor, background, tone);
      assert.equal(flatten(find(hosts, 'Text')[0].props.style).color, text, tone);
    }
  });

  test(`${scheme}: chips are body text on the muted surface`, () => {
    const { hosts } = render(scheme, createElement(ui.Chip, { label: 'Nucleus' }));
    assert.equal(flatten(find(hosts, 'View')[0].props.style).backgroundColor, colors.surfaceMuted);
    assert.equal(flatten(find(hosts, 'Text')[0].props.style).color, colors.text);
  });

  test(`${scheme}: the list group is a surface card with hairlines inset past the thumbnail`, () => {
    const { hosts } = render(scheme, createElement(ui.ListGroup, null,
      createElement(ui.ListRow, { title: 'A', onPress() {} }),
      createElement(ui.ListRow, { title: 'B', onPress() {} }),
      createElement(ui.ListRow, { title: 'C', onPress() {} })));
    const group = flatten(find(hosts, 'View')[0].props.style);
    assert.equal(group.backgroundColor, colors.surface);
    assert.equal(group.borderRadius, themes[scheme].radius.card);
    const separators = find(hosts, 'View').map(view => flatten(view.props.style)).filter(style => style.height === 1);
    assert.equal(separators.length, 2);
    assert.equal(separators[0].marginLeft, 16 + ui.LIST_THUMB_SIZE + 12);
    assert.equal(separators[0].backgroundColor, colors.border);
  });
}

test('a list row is one button labelled with its title and meta, with a hidden chevron', () => {
  const { html, hosts } = render('light', createElement(ui.ListRow, { title: 'Onion epidermis', meta: '24 October · Saved', onPress() {} }));
  const pressable = find(hosts, 'Pressable')[0].props;
  assert.equal(pressable.accessibilityRole, 'button');
  assert.equal(pressable.accessibilityLabel, 'Onion epidermis, 24 October · Saved');
  assert.deepEqual(pressable.accessibilityState, { disabled: false });
  assert.equal(flatten(pressable.style).minHeight, 64);
  const [title, meta] = find(hosts, 'Text');
  assert.equal(title.props.numberOfLines, 2);
  assert.equal(flatten(meta.props.style).color, palettes.light.textMuted);
  const glyph = find(hosts, 'View').find(view => view.props.importantForAccessibility === 'no-hide-descendants');
  assert.equal(glyph.props.accessible, false);
  assert.match(html, /Onion epidermis/);
  const plain = render('light', createElement(ui.ListRow, { title: 'Yeast', onPress() {}, disabled: true }));
  const plainProps = find(plain.hosts, 'Pressable')[0].props;
  assert.equal(plainProps.accessibilityLabel, 'Yeast');
  assert.deepEqual(plainProps.accessibilityState, { disabled: true });
  assert.equal(find(plain.hosts, 'Text').length, 1);
});

test('a list row passes long-press and offers named actions to screen readers', () => {
  const calls = [];
  const { hosts } = render('light', createElement(ui.ListRow, {
    title: 'Onion', meta: 'Saved', onPress: () => calls.push('open'), onLongPress: () => calls.push('long'),
    actions: [{ name: 'edit', label: 'Edit title and notes', onPress: () => calls.push('edit') },
      { name: 'delete', label: 'Delete', onPress: () => calls.push('delete') }],
  }));
  const row = find(hosts, 'Pressable')[0].props;
  assert.deepEqual(row.accessibilityActions, [{ name: 'edit', label: 'Edit title and notes' }, { name: 'delete', label: 'Delete' }]);
  row.onPress();
  row.onLongPress();
  row.onAccessibilityAction({ nativeEvent: { actionName: 'delete' } });
  row.onAccessibilityAction({ nativeEvent: { actionName: 'edit' } });
  row.onAccessibilityAction({ nativeEvent: { actionName: 'unknown' } });
  assert.deepEqual(calls, ['open', 'long', 'delete', 'edit']);
  const plain = find(render('light', createElement(ui.ListRow, { title: 'Yeast', onPress() {} })).hosts, 'Pressable')[0].props;
  assert.equal(plain.accessibilityActions, undefined);
  assert.equal(plain.onAccessibilityAction, undefined);
  assert.equal(plain.onLongPress, undefined);
});

test('a list thumbnail is a decorative image, or a neutral tile without one', () => {
  const calls = [];
  const image = render('light', createElement(ui.ListThumbnail, { uri: 'https://example.test/t.jpg', onError: () => calls.push('error') }));
  const props = find(image.hosts, 'Image')[0].props;
  assert.deepEqual(props.source, { uri: 'https://example.test/t.jpg' });
  assert.equal(props.accessible, false);
  assert.equal(flatten(props.style).width, ui.LIST_THUMB_SIZE);
  props.onError();
  assert.deepEqual(calls, ['error']);
  const tile = render('light', createElement(ui.ListThumbnail, { uri: null }));
  assert.equal(find(tile.hosts, 'Image').length, 0);
  assert.equal(flatten(find(tile.hosts, 'View')[0].props.style).backgroundColor, palettes.light.surfaceMuted);
});

test('stat tiles show a whole count and its label, read as one element', () => {
  const { html, hosts } = render('light', createElement(ui.StatTile, { count: 3, label: 'Saved' }));
  const labelled = find(hosts, 'View').find(view => view.props.accessible === true);
  assert.equal(labelled.props.accessibilityLabel, 'Saved: 3');
  assert.deepEqual(find(hosts, 'Text').map(text => text.props.children), ['3', 'Saved']);
  assert.doesNotMatch(html, /%/);
  const odd = render('light', createElement(ui.StatTile, { count: 2.7, label: 'Drafts' }));
  assert.equal(find(odd.hosts, 'Text')[0].props.children, '2');
  const negative = render('light', createElement(ui.StatTile, { count: -1, label: 'Drafts' }));
  assert.equal(find(negative.hosts, 'Text')[0].props.children, '0');
  const capped = render('light', createElement(ui.StatTile, { count: 200, label: 'Saved', capped: true }));
  assert.equal(find(capped.hosts, 'Text')[0].props.children, '200+');
  assert.equal(find(capped.hosts, 'View').find(view => view.props.accessible === true).props.accessibilityLabel, 'Saved: 200+');
});

test('the screen passes its refresh control to the scroll view', () => {
  const control = createElement(reactNative.RefreshControl, { refreshing: false, onRefresh() {} });
  const { hosts } = render('light', createElement(ui.Screen, { refreshControl: control }, 'Content'));
  assert.equal(find(hosts, 'ScrollView')[0].props.refreshControl, control);
  const plain = render('light', createElement(ui.Screen, null, 'Content'));
  assert.equal(find(plain.hosts, 'ScrollView')[0].props.refreshControl, undefined);
});

test('glyphs are hidden from assistive tech', () => {
  for (const glyph of ['account', 'chevron', 'more', 'warning']) {
    const view = find(render('light', createElement(ui.GlyphView, { glyph })).hosts, 'View')[0].props;
    assert.equal(view.accessible, false, glyph);
    assert.equal(view.importantForAccessibility, 'no-hide-descendants', glyph);
    assert.equal(view.accessibilityElementsHidden, true, glyph);
  }
});

test('the warning glyph text does not scale with the font size', () => {
  const { hosts } = render('light', createElement(ui.GlyphView, { glyph: 'warning' }));
  assert.equal(find(hosts, 'Text')[0].props.maxFontSizeMultiplier, 1);
});

test('chip rows wrap and pills keep their label', () => {
  const row = render('light', createElement(ui.ChipRow, null, createElement(ui.Chip, { label: 'Cell wall' })));
  assert.equal(flatten(find(row.hosts, 'View')[0].props.style).flexWrap, 'wrap');
  const pill = render('light', createElement(ui.Pill, { label: 'Tentative', tone: 'info' }));
  assert.match(pill.html, /Tentative/);
  assert.equal(flatten(find(pill.hosts, 'View')[0].props.style).alignSelf, 'flex-start');
});

// Per-scheme checks for the auth primitives.
for (const scheme of ['light', 'dark']) {
  const colors = palettes[scheme];
  const allowed = new Set(Object.values(colors));

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

  test(`${scheme}: the account glyph is muted`, () => {
    const { hosts } = render(scheme, createElement(ui.IconButton, { glyph: 'account', accessibilityLabel: 'Account', onPress() {} }));
    assert.deepEqual([...new Set(coloursOf(hosts))], [colors.textMuted]);
  });

  test(`${scheme}: the password toggle is accent text, not a glyph`, () => {
    const { hosts } = render(scheme, createElement(ui.PasswordRow, { label: 'Password', value: '', placeholder: 'Your password' }));
    const texts = find(hosts, 'Text');
    const toggleText = flatten(texts[texts.length - 1].props.style);
    assert.equal(toggleText.color, colors.accent);
    assert.equal(toggleText.fontWeight, '600');
    assert.equal(find(hosts, 'TextInput')[0].props.placeholderTextColor, colors.textMuted);
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
  assert.deepEqual(ui.passwordToggle(false), { secureTextEntry: true, accessibilityLabel: 'Show password', title: 'Show' });
  assert.deepEqual(ui.passwordToggle(true), { secureTextEntry: false, accessibilityLabel: 'Hide password', title: 'Hide' });
});

test('a password row starts hidden with a 44 pt "Show" text button', () => {
  const { html, hosts } = render('light', createElement(ui.PasswordRow, { label: 'Password', secureTextEntry: false }));
  const input = find(hosts, 'TextInput')[0].props;
  assert.equal(input.secureTextEntry, true);
  assert.equal(input.accessibilityLabel, 'Password');
  const toggle = find(hosts, 'Pressable')[0].props;
  assert.equal(toggle.accessibilityRole, 'button');
  assert.equal(toggle.accessibilityLabel, 'Show password');
  assert.equal(flatten(toggle.style).minWidth, 44);
  assert.equal(flatten(toggle.style).minHeight, 44);
  assert.equal(textOfLast(hosts), 'Show');
  assert.doesNotMatch(html, /Hide/);
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

test('a screen heading with a trailing element puts it beside the title', () => {
  const { html, hosts } = render('light', createElement(ui.ScreenHeading, {
    title: 'Logbook', trailing: createElement(ui.IconButton, { glyph: 'account', accessibilityLabel: 'Account', onPress() {} }),
  }));
  assert.equal(flatten(find(hosts, 'View')[0].props.style).flexDirection, 'row');
  assert.equal(flatten(find(hosts, 'View')[1].props.style).flex, 1);
  assert.equal(find(hosts, 'Pressable')[0].props.accessibilityLabel, 'Account');
  assert.match(html, /Logbook/);
  const plain = render('light', createElement(ui.ScreenHeading, { title: 'Welcome back' }));
  assert.equal(flatten(find(plain.hosts, 'View')[0].props.style).flexDirection, undefined);
});

test('dark mode uses the dark keyboard and scroll indicator', () => {
  const field = render('dark', createElement(ui.Field, { label: 'Email' }));
  assert.equal(find(field.hosts, 'TextInput')[0].props.keyboardAppearance, 'dark');
  const screen = render('dark', createElement(ui.Screen, null, 'x'));
  assert.equal(find(screen.hosts, 'ScrollView')[0].props.indicatorStyle, 'white');
});
