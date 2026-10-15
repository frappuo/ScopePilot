import type { ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Shared building blocks for the auth and account screens, in the existing app palette.

export function Screen({ children, edges = ['bottom', 'left', 'right'] }: { children: ReactNode; edges?: ('top' | 'bottom' | 'left' | 'right')[] }) {
  return <SafeAreaView edges={edges} style={styles.safe}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.flex}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

export function Title({ children }: { children: ReactNode }) {
  return <Text accessibilityRole="header" style={styles.title}>{children}</Text>;
}

export function Body({ children }: { children: ReactNode }) {
  return <Text style={styles.body}>{children}</Text>;
}

export function Field({ label, ...input }: TextInputProps & { label: string }) {
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} placeholderTextColor="#7b8d86" style={styles.input} {...input} />
  </View>;
}

export function Button({ title, onPress, disabled, busy, variant = 'primary' }: {
  title: string; onPress: () => void; disabled?: boolean; busy?: boolean; variant?: 'primary' | 'secondary';
}) {
  const inactive = Boolean(disabled || busy);
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: inactive, busy: Boolean(busy) }}
    disabled={inactive} onPress={onPress}
    style={({ pressed }) => [styles.button, variant === 'primary' ? styles.primary : styles.secondary, (inactive || pressed) && styles.dim]}>
    {busy ? <ActivityIndicator color={variant === 'primary' ? '#fff' : '#14685c'} />
      : <Text style={variant === 'primary' ? styles.primaryText : styles.secondaryText}>{title}</Text>}
  </Pressable>;
}

export function LinkButton({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="link" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.link, (pressed || disabled) && styles.dim]}>
    <Text style={styles.linkText}>{title}</Text>
  </Pressable>;
}

export function Notice({ kind, children }: { kind: 'error' | 'info'; children: ReactNode }) {
  return <View accessibilityRole={kind === 'error' ? 'alert' : undefined} accessibilityLiveRegion="polite"
    style={kind === 'error' ? styles.error : styles.info}>
    <Text style={kind === 'error' ? styles.errorText : styles.infoText}>{children}</Text>
  </View>;
}

export function Loading() {
  return <View style={styles.center}><ActivityIndicator color="#14685c" size="large" /></View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f7f3' },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f4f7f3' },
  page: { padding: 24, gap: 14, width: '100%', maxWidth: 680, alignSelf: 'center', paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '800', color: '#173c35', marginTop: 8 },
  body: { fontSize: 16, lineHeight: 24, color: '#40554f' },
  field: { gap: 6 },
  label: { fontSize: 15, fontWeight: '600', color: '#173c35' },
  input: { backgroundColor: '#fff', borderColor: '#a9bbb3', borderRadius: 10, borderWidth: 1, color: '#173c35', fontSize: 16, padding: 14 },
  button: { borderRadius: 12, padding: 16, alignItems: 'center', justifyContent: 'center', minHeight: 52 },
  primary: { backgroundColor: '#14685c' }, primaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  secondary: { borderWidth: 1, borderColor: '#14685c' }, secondaryText: { color: '#14685c', fontSize: 16, fontWeight: '600' },
  dim: { opacity: 0.5 },
  link: { paddingVertical: 8, alignSelf: 'flex-start' },
  linkText: { color: '#14685c', fontSize: 16, fontWeight: '600', textDecorationLine: 'underline' },
  error: { padding: 16, backgroundColor: '#fcebe6', borderRadius: 12 }, errorText: { color: '#8a3220', lineHeight: 22 },
  info: { padding: 16, backgroundColor: '#e7eee8', borderRadius: 12 }, infoText: { color: '#173c35', lineHeight: 22 },
});
