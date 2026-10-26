export type Analysis = {
  probable_specimen: string;
  visible_structures: string[];
  observations: string[];
  explanation: string;
  limitations: string[];
};

export type SelectedImage = {
  uri: string;
  name: string;
  type: 'image/jpeg' | 'image/png' | 'image/webp';
  fileName?: string | null;
  mimeType?: string;
  fileSize?: number;
};
