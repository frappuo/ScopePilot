import * as ImagePicker from 'expo-image-picker';
import type { SelectedImage } from '../types/analysis';

// One image from the library. The picked file is uploaded unchanged; the backend validates and
// re-encodes it.
export async function selectImage(): Promise<SelectedImage | null> {
  const selection = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'], allowsMultipleSelection: false, allowsEditing: false, quality: 1,
  });
  if (selection.canceled) return null;
  const asset = selection.assets[0];
  // The type comes from the picker, or from the file extension when the picker gives none.
  const extensions: Record<string, SelectedImage['type']> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  };
  const extension = (asset.fileName || asset.uri.split(/[?#]/)[0]).split('.').pop()?.toLowerCase();
  const mime = asset.mimeType?.trim().toLowerCase() || (extension ? extensions[extension] : undefined);
  if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') {
    throw new Error("This image type can't be used. Choose a JPEG, PNG or WebP image.");
  }
  return {
    uri: asset.uri,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    fileSize: asset.fileSize,
    name: asset.fileName || `microscopy.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`,
    type: mime,
  };
}
