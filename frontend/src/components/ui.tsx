import { Children, Fragment, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type RefreshControlProps, type StyleProp, type TextInputProps, type TextProps, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import type { Theme, TypeVariant } from '../theme/tokens';

// Shared building blocks for the auth and account screens. Every colour and size comes from the theme.

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
type NoticeKind = 'error' | 'info' | 'success' | 'warning';
type TextTone = 'default' | 'muted' | 'accent' | 'danger';
export type Glyph = 'account' | 'chevron' | 'more' | 'warning';
type PillTone = 'info' | 'warning' | 'neutral';

// Thumbnail edge in list rows; the row separators are inset to start after it.
export const LIST_THUMB_SIZE = 44;

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
    pageFill: { flexGrow: 1 },
    footer: { backgroundColor: colors.canvas },
    footerInner: { width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center', paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.lg },
    card: { backgroundColor: colors.surface, borderRadius: radius.card, padding: spacing.lg, gap: spacing.sm, ...theme.elevation },
    cardMuted: { backgroundColor: colors.surfaceMuted, borderRadius: radius.card, padding: spacing.lg, gap: spacing.sm },
    cardWarning: { backgroundColor: colors.warningSoft, borderRadius: radius.card, padding: spacing.lg, gap: spacing.sm },
    display: typeStyle(theme, 'display'),
    title: { ...typeStyle(theme, 'title'), marginTop: spacing.sm },
    headline: typeStyle(theme, 'headline'),
    bodyLarge: typeStyle(theme, 'bodyLarge'),
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
    buttonLarge: { borderRadius: radius.button, paddingVertical: spacing.md, minHeight: 54 },
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
    // 40 plus the page's 16 px gap leaves 56 px below the brand row.
    brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xxl + spacing.sm },
    brandMark: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
    brandRing: { width: 22, height: 22, borderRadius: radius.pill, borderWidth: 2, borderColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    brandLens: { width: 10, height: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.accent, backgroundColor: colors.accentSoft },
    brandArm: { width: 12, height: 2, borderRadius: 1, marginTop: 2, backgroundColor: colors.accent },
    wordmark: { fontWeight: '600' },
    heading: { gap: spacing.xs },
    headingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    fieldGroup: { backgroundColor: colors.surface, borderColor: colors.borderStrong, borderWidth: 1, borderRadius: radius.card, overflow: 'hidden' },
    separator: { height: StyleSheet.hairlineWidth, marginLeft: spacing.lg, backgroundColor: colors.border },
    fieldRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    fieldRowTrailing: { paddingRight: spacing.xs },
    fieldColumn: { flex: 1, gap: spacing.xxs },
    rowInput: { ...typeStyle(theme, 'bodyLarge'), color: colors.text, backgroundColor: colors.surface, minHeight: 24, padding: 0 },
    iconButton: { width: layout.minTouch, height: layout.minTouch, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
    glyph: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
    revealToggle: { minWidth: layout.minTouch, minHeight: layout.minTouch, paddingHorizontal: spacing.xs, alignItems: 'center', justifyContent: 'center' },
    head: { width: 9, height: 9, borderRadius: radius.pill, borderWidth: 2, borderColor: colors.textMuted },
    shoulders: { width: 16, height: 8, marginTop: 2, borderTopLeftRadius: 8, borderTopRightRadius: 8, borderWidth: 2, borderBottomWidth: 0, borderColor: colors.textMuted },
    textLink: { minHeight: layout.minTouch, justifyContent: 'center' },
    textLinkText: { ...typeStyle(theme, 'body'), fontWeight: '600', color: colors.accent },
    inlinePrompt: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', columnGap: spacing.xs },
    emptyState: { alignItems: 'center' },
    centered: { textAlign: 'center' },
    spacer: { flex: 1, minHeight: spacing.xl },
    chevron: { width: 9, height: 9, marginRight: 4, borderTopWidth: 2, borderRightWidth: 2, borderColor: colors.textMuted, transform: [{ rotate: '45deg' }] },
    dots: { flexDirection: 'row', gap: 3 },
    dot: { width: 4, height: 4, borderRadius: radius.pill, backgroundColor: colors.textMuted },
    warningRing: { width: 20, height: 20, borderRadius: radius.pill, borderWidth: 2, borderColor: colors.warning, alignItems: 'center', justifyContent: 'center' },
    warningMark: { fontSize: 12, lineHeight: 14, fontWeight: '700', color: colors.warning },
    listGroup: { backgroundColor: colors.surface, borderRadius: radius.card, ...theme.elevation },
    listSeparator: { height: StyleSheet.hairlineWidth, marginLeft: spacing.lg + LIST_THUMB_SIZE + spacing.md, backgroundColor: colors.border },
    listRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 64, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    listRowText: { flex: 1, gap: spacing.xxs },
    thumb: { width: LIST_THUMB_SIZE, height: LIST_THUMB_SIZE, borderRadius: radius.sm, backgroundColor: colors.surfaceMuted },
    statRow: { flexDirection: 'row', gap: spacing.sm },
    statTile: { flex: 1, gap: spacing.xxs, padding: spacing.md },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs + spacing.xxs },
    chip: { backgroundColor: colors.surfaceMuted, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
    pill: { alignSelf: 'flex-start', borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: spacing.xxs },
    pillInfo: { backgroundColor: colors.infoSoft }, pillInfoText: { color: colors.info },
    pillWarning: { backgroundColor: colors.warningSoft }, pillWarningText: { color: colors.warning },
    pillNeutral: { backgroundColor: colors.surfaceMuted }, pillNeutralText: { color: colors.textMuted },
    imageFrame: { width: '100%', aspectRatio: 4 / 3, backgroundColor: colors.surfaceMuted, borderRadius: radius.card, overflow: 'hidden' },
    imageFill: { width: '100%', height: '100%' },
    imageEmpty: { alignItems: 'center', justifyContent: 'center' },
    group: { gap: spacing.xs },
    sectionLabel: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    sectionLabelWarning: { color: colors.warning },
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

// `footer` stays pinned below the scrolling content and rises with the keyboard; `fill` lets a
// Spacer push the last content line to the bottom; `refreshControl` adds pull-to-refresh.
export function Screen({ children, edges = ['bottom', 'left', 'right'], footer, fill, refreshControl }: {
  children: ReactNode; edges?: ('top' | 'bottom' | 'left' | 'right')[]; footer?: ReactNode; fill?: boolean;
  refreshControl?: ReactElement<RefreshControlProps>;
}) {
  const [styles, theme] = useUiStyles();
  // KeyboardAvoidingView compares its own frame with the keyboard's window position, so it needs
  // to know where it sits in the window (below a native header, for example).
  const frame = useRef<View>(null);
  const [offset, setOffset] = useState(0);
  return <SafeAreaView edges={edges} style={styles.safe}>
    <View ref={frame} style={styles.flex} onLayout={() => frame.current?.measureInWindow((_x, y) => setOffset(y))}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={offset} style={styles.flex}>
        <ScrollView contentContainerStyle={[styles.page, fill && styles.pageFill]} keyboardShouldPersistTaps="handled"
          indicatorStyle={theme.scheme === 'dark' ? 'white' : 'default'} refreshControl={refreshControl}>
          {children}
        </ScrollView>
        {footer ? <View style={styles.footer}><View style={styles.footerInner}>{footer}</View></View> : null}
      </KeyboardAvoidingView>
    </View>
  </SafeAreaView>;
}

const CARD = { surface: 'card', muted: 'cardMuted', warning: 'cardWarning' } as const;

export function Card({ children, tone = 'surface', style }: { children: ReactNode; tone?: keyof typeof CARD; style?: StyleProp<ViewStyle> }) {
  const [styles] = useUiStyles();
  return <View style={[styles[CARD[tone]], style]}>{children}</View>;
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

export function Button({ title, onPress, disabled, busy, variant = 'primary', size = 'regular' }: {
  title: string; onPress: () => void; disabled?: boolean; busy?: boolean; variant?: ButtonVariant; size?: 'regular' | 'large';
}) {
  const [styles, theme] = useUiStyles();
  const inactive = Boolean(disabled || busy);
  const filled = variant === 'primary' || variant === 'destructive';
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: inactive, busy: Boolean(busy) }}
    disabled={inactive} onPress={onPress}
    style={({ pressed }) => [styles.button, size === 'large' && styles.buttonLarge, styles[variant], (inactive || pressed) && styles.dim]}>
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

// A simple lens mark drawn with Views, plus the wordmark. The mark is decorative.
export function BrandHeader() {
  const [styles] = useUiStyles();
  return <View style={styles.brand}>
    <View style={styles.brandMark} accessible={false} accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      <View style={styles.brandRing}><View style={styles.brandLens} /></View>
      <View style={styles.brandArm} />
    </View>
    <AppText variant="bodyLarge" style={styles.wordmark}>ScopePilot</AppText>
  </View>;
}

// `trailing` (for example an IconButton) sits top-right, beside the title.
export function ScreenHeading({ title, subtitle, trailing }: { title: string; subtitle?: ReactNode; trailing?: ReactNode }) {
  const [styles] = useUiStyles();
  const heading = <View style={[styles.heading, trailing ? styles.flex : null]}>
    <AppText accessibilityRole="header" variant="display">{title}</AppText>
    {subtitle ? <AppText tone="muted">{subtitle}</AppText> : null}
  </View>;
  return trailing ? <View style={styles.headingRow}>{heading}{trailing}</View> : heading;
}

// One card for a set of FieldRows, with an inset hairline between rows.
export function FieldGroup({ children }: { children: ReactNode }) {
  const [styles] = useUiStyles();
  const rows = Children.toArray(children);
  return <View style={styles.fieldGroup}>
    {rows.map((row, index) => <Fragment key={index}>
      {index > 0 && <View style={styles.separator} />}
      {row}
    </Fragment>)}
  </View>;
}

// A borderless input with a small label above it; the label takes the accent colour while focused.
export function FieldRow({ label, trailing, onFocus, onBlur, ...input }: TextInputProps & { label: string; trailing?: ReactNode }) {
  const [styles, theme] = useUiStyles();
  const [focused, setFocused] = useState(false);
  return <View style={[styles.fieldRow, trailing ? styles.fieldRowTrailing : null]}>
    <View style={styles.fieldColumn}>
      <AppText variant="caption" tone={focused ? 'accent' : 'muted'}>{label}</AppText>
      <TextInput accessibilityLabel={label} placeholderTextColor={theme.colors.textMuted}
        selectionColor={theme.colors.accent} cursorColor={theme.colors.accent}
        keyboardAppearance={theme.scheme === 'dark' ? 'dark' : 'light'}
        maxFontSizeMultiplier={theme.type.bodyLarge.maxFontSizeMultiplier} style={styles.rowInput}
        onFocus={event => { setFocused(true); onFocus?.(event); }}
        onBlur={event => { setFocused(false); onBlur?.(event); }} {...input} />
    </View>
    {trailing}
  </View>;
}

export function passwordToggle(revealed: boolean): { secureTextEntry: boolean; accessibilityLabel: string; title: string } {
  return revealed
    ? { secureTextEntry: false, accessibilityLabel: 'Hide password', title: 'Hide' }
    : { secureTextEntry: true, accessibilityLabel: 'Show password', title: 'Show' };
}

// A "Show" / "Hide" text toggle; the spoken label names the password.
export function PasswordRow(props: TextInputProps & { label: string }) {
  const [styles, theme] = useUiStyles();
  const [revealed, setRevealed] = useState(false);
  const toggle = passwordToggle(revealed);
  return <FieldRow {...props} secureTextEntry={toggle.secureTextEntry}
    trailing={<Pressable accessibilityRole="button" accessibilityLabel={toggle.accessibilityLabel}
      onPress={() => setRevealed(value => !value)} style={({ pressed }) => [styles.revealToggle, pressed && styles.dim]}>
      <Text maxFontSizeMultiplier={theme.type.body.maxFontSizeMultiplier} style={styles.textLinkText}>{toggle.title}</Text>
    </Pressable>} />;
}

// Simple glyphs drawn with Views. They are decorative: whatever carries them supplies the label.
export function GlyphView({ glyph }: { glyph: Glyph }) {
  const [styles] = useUiStyles();
  return <View style={styles.glyph} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {glyph === 'account' && <><View style={styles.head} /><View style={styles.shoulders} /></>}
    {glyph === 'chevron' && <View style={styles.chevron} />}
    {glyph === 'more' && <View style={styles.dots}><View style={styles.dot} /><View style={styles.dot} /><View style={styles.dot} /></View>}
    {glyph === 'warning' && <View style={styles.warningRing}>
      <Text maxFontSizeMultiplier={1} style={styles.warningMark}>!</Text>
    </View>}
  </View>;
}

export function IconButton({ glyph, accessibilityLabel, onPress, disabled, busy }: {
  glyph: Glyph; accessibilityLabel: string; onPress: () => void; disabled?: boolean; busy?: boolean;
}) {
  const [styles, theme] = useUiStyles();
  const inactive = Boolean(disabled || busy);
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel}
    accessibilityState={{ disabled: inactive, busy: Boolean(busy) }} disabled={inactive} onPress={onPress}
    style={({ pressed }) => [styles.iconButton, (inactive || pressed) && styles.dim]}>
    {busy ? <ActivityIndicator color={theme.colors.accent} /> : <GlyphView glyph={glyph} />}
  </Pressable>;
}

const ALIGN = { start: 'flex-start', end: 'flex-end', center: 'center' } as const;

// A quiet text action. role="button" keeps the role of actions that were buttons before.
export function TextLink({ title, onPress, disabled, align = 'start', role = 'link' }: {
  title: string; onPress: () => void; disabled?: boolean; align?: keyof typeof ALIGN; role?: 'link' | 'button';
}) {
  const [styles, theme] = useUiStyles();
  return <Pressable accessibilityRole={role} accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => [styles.textLink, { alignSelf: ALIGN[align] }, (pressed || disabled) && styles.dim]}>
    <Text maxFontSizeMultiplier={theme.type.body.maxFontSizeMultiplier} style={styles.textLinkText}>{title}</Text>
  </Pressable>;
}

export function InlinePrompt({ prompt, linkTitle, onPress, disabled }: {
  prompt: string; linkTitle: string; onPress: () => void; disabled?: boolean;
}) {
  const [styles] = useUiStyles();
  return <View style={styles.inlinePrompt}>
    <AppText tone="muted">{prompt}</AppText>
    <TextLink title={linkTitle} onPress={onPress} disabled={disabled} />
  </View>;
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  const [styles] = useUiStyles();
  return <Card style={styles.emptyState}>
    <AppText variant="headline" style={styles.centered}>{title}</AppText>
    <AppText tone="muted" style={styles.centered}>{body}</AppText>
  </Card>;
}

export function Spacer() {
  const [styles] = useUiStyles();
  return <View style={styles.spacer} />;
}

// One card for a set of ListRows; the hairlines start after the thumbnail.
export function ListGroup({ children }: { children: ReactNode }) {
  const [styles] = useUiStyles();
  const rows = Children.toArray(children);
  return <View style={styles.listGroup}>
    {rows.map((row, index) => <Fragment key={index}>
      {index > 0 && <View style={styles.listSeparator} />}
      {row}
    </Fragment>)}
  </View>;
}

// A tappable row: optional leading thumbnail, a title, a muted meta line and a chevron.
// Screen readers hear one button labelled with the title and the meta line.
export function ListRow({ title, meta, leading, onPress, disabled }: {
  title: string; meta?: string; leading?: ReactNode; onPress: () => void; disabled?: boolean;
}) {
  const [styles] = useUiStyles();
  return <Pressable accessibilityRole="button" accessibilityLabel={meta ? `${title}, ${meta}` : title}
    accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.listRow, (pressed || disabled) && styles.dim]}>
    {leading}
    <View style={styles.listRowText}>
      <AppText variant="bodyLarge" numberOfLines={2}>{title}</AppText>
      {meta ? <AppText variant="caption" numberOfLines={1}>{meta}</AppText> : null}
    </View>
    <GlyphView glyph="chevron" />
  </Pressable>;
}

// A list thumbnail, or a neutral tile when there is no image or it fails to load. Decorative.
export function ListThumbnail({ uri, onError }: { uri: string | null; onError?: () => void }) {
  const [styles] = useUiStyles();
  const [failed, setFailed] = useState(false);
  if (!uri || failed) return <View style={styles.thumb} accessible={false} />;
  return <Image source={{ uri }} style={styles.thumb} resizeMode="cover" accessible={false}
    accessibilityIgnoresInvertColors onError={() => { setFailed(true); onError?.(); }} />;
}

// A 4:3 frame on the muted surface showing the whole image (contain). `label` is what screen readers
// hear. Without a URI the frame says "Image unavailable".
export function ImageFrame({ uri, label, onError }: { uri: string | null; label: string; onError?: () => void }) {
  const [styles] = useUiStyles();
  if (!uri) {
    return <View style={[styles.imageFrame, styles.imageEmpty]}>
      <AppText tone="muted">Image unavailable</AppText>
    </View>;
  }
  return <View style={styles.imageFrame}>
    <Image source={{ uri }} style={styles.imageFill} resizeMode="contain" accessible accessibilityRole="image"
      accessibilityLabel={label} accessibilityIgnoresInvertColors onError={onError} />
  </View>;
}

// Keeps closely related lines together (a label and its value) inside the page's wider spacing.
export function Group({ children }: { children: ReactNode }) {
  const [styles] = useUiStyles();
  return <View style={styles.group}>{children}</View>;
}

// A small section header inside a card, optionally with a glyph. The words carry the meaning;
// the glyph and the warning colour only support them.
export function SectionLabel({ title, glyph, tone = 'default' }: { title: string; glyph?: Glyph; tone?: 'default' | 'warning' }) {
  const [styles] = useUiStyles();
  return <View style={styles.sectionLabel}>
    {glyph ? <GlyphView glyph={glyph} /> : null}
    <AppText accessibilityRole="header" variant="label" style={tone === 'warning' ? styles.sectionLabelWarning : undefined}>{title}</AppText>
  </View>;
}

export function StatRow({ children }: { children: ReactNode }) {
  const [styles] = useUiStyles();
  return <View style={styles.statRow}>{children}</View>;
}

// A count and its label. Counts only: the value is a whole number, never a score or percentage;
// `capped` shows it as a lower bound ("200+").
export function StatTile({ count, label, capped }: { count: number; label: string; capped?: boolean }) {
  const [styles] = useUiStyles();
  const shown = `${Math.max(0, Math.floor(count))}${capped ? '+' : ''}`;
  return <Card style={styles.statTile}>
    <View accessible accessibilityLabel={`${label}: ${shown}`}>
      <AppText variant="headline">{shown}</AppText>
      <AppText variant="caption">{label}</AppText>
    </View>
  </Card>;
}

export function ChipRow({ children }: { children: ReactNode }) {
  const [styles] = useUiStyles();
  return <View style={styles.chipRow}>{children}</View>;
}

export function Chip({ label }: { label: string }) {
  const [styles] = useUiStyles();
  return <View style={styles.chip}><AppText variant="caption" tone="default">{label}</AppText></View>;
}

const PILL: Record<PillTone, ['pillInfo' | 'pillWarning' | 'pillNeutral', 'pillInfoText' | 'pillWarningText' | 'pillNeutralText']> = {
  info: ['pillInfo', 'pillInfoText'], warning: ['pillWarning', 'pillWarningText'], neutral: ['pillNeutral', 'pillNeutralText'],
};

// A short status label such as "Tentative"; the word carries the meaning, the colour only supports it.
export function Pill({ label, tone = 'neutral' }: { label: string; tone?: PillTone }) {
  const [styles] = useUiStyles();
  const [box, text] = PILL[tone];
  return <View style={[styles.pill, styles[box]]}>
    <AppText variant="label" style={styles[text]}>{label}</AppText>
  </View>;
}
