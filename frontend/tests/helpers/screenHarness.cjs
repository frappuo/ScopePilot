// Renders screens with the real ui.tsx over stub React Native hosts that record their props.
const { createElement, Fragment } = require('react');
const { renderToString } = require('react-dom/server');
const { loadTs } = require('./loadTs.cjs');

const { palettes, themeFor } = loadTs('src/theme/tokens.ts');
const themes = { light: themeFor('light'), dark: themeFor('dark') };

let rendered = [];
let current = themes.light;

// Pressable style functions are resolved unpressed.
function host(name) {
  return function Host(props) {
    const style = typeof props.style === 'function' ? props.style({ pressed: false }) : props.style;
    rendered.push({ name, props: { ...props, style } });
    return createElement(Fragment, null, props.children);
  };
}

function reactNative(extra = {}) {
  return {
    ActivityIndicator: host('ActivityIndicator'), Image: host('Image'), KeyboardAvoidingView: host('KeyboardAvoidingView'),
    Pressable: host('Pressable'), RefreshControl: host('RefreshControl'), ScrollView: host('ScrollView'), Text: host('Text'),
    TextInput: host('TextInput'), View: host('View'),
    Platform: { OS: 'ios' },
    StyleSheet: { create: styles => styles, hairlineWidth: 1 },
    ...extra,
  };
}

// `stubs` are added to the React Native, safe-area and theme stubs (for example the auth hook).
function loadModule(file, stubs = {}, nativeExtra = {}) {
  return loadTs(file, {
    'react-native': reactNative(nativeExtra),
    'react-native-safe-area-context': { SafeAreaView: host('SafeAreaView') },
    '../theme/ThemeProvider': { useTheme: () => current },
    ...stubs,
  });
}

// The screen component (the default export).
function loadScreen(file, stubs, nativeExtra) {
  return loadModule(file, stubs, nativeExtra).default;
}

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

// The text a Text host shows, when its children are plain strings.
function textOf(entry) {
  const children = entry.props.children;
  return Array.isArray(children) ? children.join('') : String(children);
}

// The footer element passed to Screen, rendered on its own.
function footerHtml(scheme, hosts) {
  const footer = find(hosts, 'KeyboardAvoidingView')[0].props.children[1];
  return footer ? render(scheme, footer).html : '';
}

module.exports = { palettes, themes, host, loadModule, loadScreen, render, flatten, find, coloursOf, textOf, footerHtml };
