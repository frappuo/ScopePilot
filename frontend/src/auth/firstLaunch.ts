// iOS keeps Keychain items after the app is uninstalled, so a reinstalled app could restore an
// old session. A marker file in the app's documents folder is removed with the app; when it is
// missing, stored auth is cleared before the Supabase client reads it.

export type InstallMarker = {
  exists(): boolean;
  create(): void;
};

function diagnostic(category: string) {
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.info('[ScopePilot auth]', { category });
}

export async function clearAuthOnFirstLaunch(marker: InstallMarker, clearStoredAuth: () => Promise<void>): Promise<void> {
  let present: boolean;
  try { present = marker.exists(); }
  catch {
    diagnostic('marker_read_failed');
    return;
  }
  if (present) return;
  // The marker is written first: if it cannot be written, nothing is cleared, so a device that
  // cannot keep the marker is not signed out on every launch.
  try { marker.create(); }
  catch {
    diagnostic('marker_write_failed');
    return;
  }
  try { await clearStoredAuth(); }
  catch { diagnostic('clear_failed'); }
}
