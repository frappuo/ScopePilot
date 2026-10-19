import type { TextStyle, ViewStyle } from 'react-native';

// Design tokens as plain data, so they can be unit-tested and swapped without touching components.
// Each *Soft colour is its foreground at 13% over surface; tests/theme.contrast.test.cjs enforces
// that and the WCAG AA contrast of every text pair.

export type ColorScheme = 'light' | 'dark';

export type ColorTokens = {
  canvas: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  accent: string;
  onAccent: string;
  accentSoft: string;
  info: string;
  infoSoft: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
};

export const palettes: Record<ColorScheme, ColorTokens> = {
  light: {
    canvas: '#F3EFE8',
    surface: '#FFFFFF',
    surfaceMuted: '#EAE5DC',
    border: '#E2DCD2',
    borderStrong: '#8A8178',
    text: '#1C1917',
    textMuted: '#6B635C',
    accent: '#9F5012',
    onAccent: '#FFFFFF',
    accentSoft: '#F3E8E0',
    info: '#246A9A',
    infoSoft: '#E3ECF2',
    success: '#2B7248',
    successSoft: '#E3EDE7',
    warning: '#875E00',
    warningSoft: '#EFEADE',
    danger: '#B42318',
    dangerSoft: '#F5E2E1',
  },
  dark: {
    canvas: '#12100D',
    surface: '#1C1915',
    surfaceMuted: '#26221D',
    border: '#2E2924',
    borderStrong: '#7D746A',
    text: '#EEE9E2',
    textMuted: '#A29A90',
    accent: '#F0913A',
    onAccent: '#1C1917',
    accentSoft: '#38291A',
    info: '#5AAEE6',
    infoSoft: '#242C30',
    success: '#5CC98A',
    successSoft: '#243024',
    warning: '#E5B53A',
    warningSoft: '#362D1A',
    danger: '#F97066',
    dangerSoft: '#392420',
  },
};

// 4-pt scale.
export const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

export const radius = { sm: 8, control: 12, card: 18, pill: 999 } as const;

export const layout = { maxWidth: 680, minTouch: 44 } as const;

export type TypeVariant = 'display' | 'title' | 'headline' | 'body' | 'label' | 'caption';

export type TypeStyle = Pick<TextStyle, 'fontSize' | 'lineHeight' | 'fontWeight' | 'letterSpacing'> & {
  maxFontSizeMultiplier: number;
};

// System font, three weights. Font scaling stays on; the multiplier caps how far each variant grows
// (body text keeps 2x for 200% resize, large headings grow less so they do not overflow).
export const typeScale: Record<TypeVariant, TypeStyle> = {
  display: { fontSize: 34, lineHeight: 41, fontWeight: '700', maxFontSizeMultiplier: 1.5 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700', maxFontSizeMultiplier: 1.6 },
  headline: { fontSize: 20, lineHeight: 26, fontWeight: '600', maxFontSizeMultiplier: 1.8 },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400', maxFontSizeMultiplier: 2 },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '600', letterSpacing: 0.4, maxFontSizeMultiplier: 2 },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400', maxFontSizeMultiplier: 2 },
};

export type Elevation = Pick<ViewStyle,
  'shadowColor' | 'shadowOpacity' | 'shadowRadius' | 'shadowOffset' | 'elevation' | 'borderWidth' | 'borderColor'>;

// A soft shadow in light mode; in dark mode shadows are invisible, so a border separates the card.
export function elevation(scheme: ColorScheme, colors: ColorTokens): Elevation {
  return scheme === 'light'
    ? { shadowColor: colors.text, shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 }
    : { borderWidth: 1, borderColor: colors.border, elevation: 0 };
}

export type Theme = {
  scheme: ColorScheme;
  colors: ColorTokens;
  spacing: typeof spacing;
  radius: typeof radius;
  layout: typeof layout;
  type: typeof typeScale;
  elevation: Elevation;
};

export function themeFor(scheme: ColorScheme): Theme {
  const colors = palettes[scheme];
  return { scheme, colors, spacing, radius, layout, type: typeScale, elevation: elevation(scheme, colors) };
}
