import * as ImagePicker from 'expo-image-picker';
import type { SelectedImage } from '../types/analysis';

export async function selectImage(): Promise<SelectedImage | null> {
  const selection = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'], allowsMultipleSelection: false, allowsEditing: false, quality: 1,
  });
  if (selection.canceled) return null;
  const asset = selection.assets[0];
  // Temporary isolation test: preserve the picker URI; do not manipulate or copy it.
  const extensions: Record<string, SelectedImage['type']> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  };
  const extension = (asset.fileName || asset.uri.split(/[?#]/)[0]).split('.').pop()?.toLowerCase();
  const mime = asset.mimeType?.trim().toLowerCase() || (extension ? extensions[extension] : undefined);
  if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') {
    throw new Error('Choose a JPEG, PNG, or WebP image for this test. HEIC conversion is disabled.');
  }
  return {
    uri: asset.uri,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    fileSize: asset.fileSize,
    name: asset.fileName || `microscopy.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`,
    type: mime,
    blob: asset.file, // Only supplied by ImagePicker on web.
  };
}
