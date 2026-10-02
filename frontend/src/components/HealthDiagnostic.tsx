import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { checkBackendHealth, checkBackendPost } from '../services/api';

// Temporary: remove this component and its screen insertion after diagnosis.
export default function HealthDiagnostic() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  async function check(method: 'GET' | 'POST') {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setResult('');
    try { setResult(await (method === 'GET' ? checkBackendHealth() : checkBackendPost())); }
    finally { running.current = false; setBusy(false); }
  }

  return <View style={{ padding: 16, gap: 10, borderWidth: 1, borderColor: '#60716a', borderRadius: 12 }}>
    <Text style={{ color: '#40554f' }}>Temporary connection diagnostic</Text>
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => check('GET')}
      style={{ padding: 14, backgroundColor: '#14685c', borderRadius: 8, opacity: busy ? 0.5 : 1 }}>
      <Text style={{ color: 'white', textAlign: 'center', fontWeight: '600' }}>{busy ? 'Checking…' : 'Check backend connection'}</Text>
    </Pressable>
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => check('POST')}
      style={{ padding: 14, backgroundColor: '#14685c', borderRadius: 8, opacity: busy ? 0.5 : 1 }}>
      <Text style={{ color: 'white', textAlign: 'center', fontWeight: '600' }}>{busy ? 'Checking…' : 'Check POST without image'}</Text>
    </Pressable>
    {!!result && <Text accessibilityLiveRegion="polite" style={{ color: '#173c35', lineHeight: 22 }}>{result}</Text>}
  </View>;
}
