import type { MediaAsset } from './types';

export function hasArchivedMedia(asset: MediaAsset): asset is MediaAsset & { blob: Blob } {
  return asset.status === 'downloaded' && (asset.blob?.size ?? 0) > 0;
}
