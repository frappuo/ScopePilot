import type { ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextProps, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import type { Theme, TypeVariant } from '../theme/tokens';

// Shared building blocks for the auth and account screens. Every colour and size comes from the theme.

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
type NoticeKind = 'error' | 'info' | 'success' | 'warning';
type TextTone = 'default' | 'muted' | 'accent' | 'danger';

function typeStyle(theme: Theme, variant: TypeVariant) {
  const { maxFontSizeMultiplier: _cap, ...style } = theme.type[variant];
  return style;
}

export function makeUiStyles(theme: Theme) {
  const { colors, spacing, radius, layout } = theme;
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.canvas },
    flex: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas },
    page: { padding: spacing.xl, gap: spacing.lg, width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center', paddingBottom: spacing.xxl + spacing.sm },
    card: { backgroundColor: colors.surface, borderRadius: radius.card, padding: spacing.lg, gap: spacing.sm, ...theme.elevation },
    cardMuted: { backgroundColor: colors.surfaceMuted, borderRadius: radius.card, padding: spacing.lg, gap: spacing.sm },
    display: typeStyle(theme, 'display'),
    title: { ...typeStyle(theme, 'title'), marginTop: spacing.sm },
    headline: typeStyle(theme, 'headline'),
    body: typeStyle(theme, 'body'),
    label: typeStyle(theme, 'label'),
    caption: typeStyle(theme, 'caption'),
    toneDefault: { color: colors.text },
    toneMuted: { color: colors.textMuted },
    toneAccent: { color: colors.accent },
    toneDanger: { color: colors.danger },
    field: { gap: spacing.xs + spacing.xxs },
    input: {
      ...typeStyle(theme, 'body'), backgroundColor: colors.surface, borderColor: colors.borderStrong, borderRadius: radius.control,
      borderWidth: 1, color: colors.text, minHeight: 48, paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    },
    button: { borderRadius: radius.control, paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, alignItems: 'center', justifyContent: 'center', minHeight: 52 },
    primary: { backgroundColor: colors.accent },
    secondary: { borderWidth: 1, borderColor: colors.borderStrong },
    ghost: {},
    destructive: { backgroundColor: colors.danger },
    buttonText: { ...typeStyle(theme, 'body'), fontWeight: '600' },
    onFilled: { color: colors.onAccent },
    onPlain: { color: colors.accent },
    dim: { opacity: 0.5 },
    link: { minHeight: layout.minTouch, justifyContent: 'center', alignSelf: 'flex-start' },
    linkText: { ...typeStyle(theme, 'body'), fontWeight: '600', color: colors.info, textDecorationLine: 'underline' },
    notice: { padding: spacing.lg, borderRadius: radius.control },
    error: { backgroundColor: colors.dangerSoft }, errorText: { color: colors.danger },
    info: { backgroundColor: colors.infoSoft }, infoText: { color: colors.text },
    success: { backgroundColor: colors.successSoft }, successText: { color: colors.success },
    warning: { backgroundColor: colors.warningSoft }, warningText: { color: colors.warning },
  });
}

type UiStyles = ReturnType<typeof makeUiStyles>;

// One style sheet per theme object; the provider keeps the theme stable while the scheme is unchanged.
const stylesByTheme = new WeakMap<Theme, UiStyles>();

function useUiStyles(): [UiStyles, Theme] {
  const theme = useTheme();
  let styles = stylesByTheme.get(theme);
  if (!styles) { styles = makeUiStyles(theme); stylesByTheme.set(theme, styles); }
  return [styles, theme];
}

const TONES: Record<TextTone, 'toneDefault' | 'toneMuted' | 'toneAccent' | 'toneDanger'> = {
  default: 'toneDefault', muted: 'toneMuted', accent: 'toneAccent', danger: 'toneDanger',
};

const NOTICE_TEXT: Record<NoticeKind, 'errorText' | 'infoText' | 'successText' | 'warningText'> = {
  error: 'errorText', info: 'infoText', success: 'successText', warning: 'warningText',
};

export function Screen({ children, edges = ['bottom', 'left', 'right'] }: { children: ReactNode; edges?: ('top' | 'bottom' | 'left' | 'right')[] }) {
  const [styles, theme] = useUiStyles();
  return <SafeAreaView edges={edges} style={styles.safe}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.flex}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled"
        indicatorStyle={theme.scheme === 'dark' ? 'white' : 'default'}>
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

export function Card({ children, tone = 'surface', style }: { children: ReactNode; tone?: 'surface' | 'muted'; style?: StyleProp<ViewStyle> }) {
  const [styles] = useUiStyles();
  return <View style={[tone === 'surface' ? styles.card : styles.cardMuted, style]}>{children}</View>;
}

export function AppText({ variant = 'body', tone, style, ...props }: TextProps & { variant?: TypeVariant; tone?: TextTone }) {
  const [styles, theme] = useUiStyles();
  const color = tone ?? (variant === 'label' || variant === 'caption' ? 'muted' : 'default');
  return <Text maxFontSizeMultiplier={theme.type[variant].maxFontSizeMultiplier} {...props}
    style={[styles[variant], styles[TONES[color]], style]} />;
}

export function Title({ children }: { children: ReactNode }) {
  return <AppText accessibilityRole="header" variant="title">{children}</AppText>;
}

export function Body({ children }: { children: ReactNode }) {
  return <AppText variant="body">{children}</AppText>;
}

export function Field({ label, ...input }: TextInputProps & { label: string }) {
  const [styles, theme] = useUiStyles();
  return <View style={styles.field}>
    <AppText variant="label" tone="default">{label}</AppText>
    <TextInput accessibilityLabel={label} placeholderTextColor={theme.colors.textMuted}
      selectionColor={theme.colors.accent} cursorColor={theme.colors.accent}
      keyboardAppearance={theme.scheme === 'dark' ? 'dark' : 'light'}
      maxFontSizeMultiplier={theme.type.body.maxFontSizeMultiplier} style={styles.input} {...input} />
  </View>;
}

export function Button({ title, onPress, disabled, busy, variant = 'primary' }: {
  title: string; onPress: () => void; disabled?: boolean; busy?: boolean; variant?: ButtonVariant;
}) {
  const [styles, theme] = useUiStyles();
  const inactive = Boolean(disabled || busy);
  const filled = variant === 'primary' || variant === 'destructive';
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: inactive, busy: Boolean(busy) }}
    disabled={inactive} onPress={onPress}
    style={({ pressed }) => [styles.button, styles[variant], (inactive || pressed) && styles.dim]}>
    {busy ? <ActivityIndicator color={filled ? theme.colors.onAccent : theme.colors.accent} />
      : <Text maxFontSizeMultiplier={theme.type.body.maxFontSizeMultiplier}
        style={[styles.buttonText, filled ? styles.onFilled : styles.onPlain]}>{title}</Text>}
  </Pressable>;
}

export function LinkButton({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  const [styles, theme] = useUiStyles();
  return <Pressable accessibilityRole="link" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.link, (pressed || disabled) && styles.dim]}>
    <Text maxFontSizeMultiplier={theme.type.body.maxFontSizeMultiplier} style={styles.linkText}>{title}</Text>
  </Pressable>;
}

export function Notice({ kind, children }: { kind: NoticeKind; children: ReactNode }) {
  const [styles, theme] = useUiStyles();
  return <View accessibilityRole={kind === 'error' ? 'alert' : undefined} accessibilityLiveRegion="polite"
    style={[styles.notice, styles[kind]]}>
    <Text maxFontSizeMultiplier={theme.type.body.maxFontSizeMultiplier}
      style={[styles.body, styles[NOTICE_TEXT[kind]]]}>{children}</Text>
  </View>;
}

export function Loading() {
  const [styles, theme] = useUiStyles();
  return <View style={styles.center}><ActivityIndicator color={theme.colors.accent} size="large" /></View>;
}
