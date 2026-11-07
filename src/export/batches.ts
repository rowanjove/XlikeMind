import type { MediaAsset } from '../domain/types';

export const EXPORT_BATCH_SIZE = 200;
export const EXPORT_MEDIA_BYTES_LIMIT = 64 * 1024 * 1024;

export class OversizedExportPostError extends Error {}

export function exportMediaBytes(asset: MediaAsset): number {
  return asset.status === 'downloaded' ? asset.blob?.size ?? 0 : 0;
}

export function planExportBatches<T>(items: T[], batchSize = EXPORT_BATCH_SIZE, mediaBytes?: (item: T) => number): T[][] {
  const size = Math.max(1, Math.floor(batchSize) || EXPORT_BATCH_SIZE);
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const itemBytes = mediaBytes?.(item) ?? 0;
    if (itemBytes > EXPORT_MEDIA_BYTES_LIMIT) {
      throw new OversizedExportPostError('所选范围中有单篇帖子的已归档媒体超过 64 MiB。可勾选「仅导出文字与图片链接」后重试，或使用目录快照。');
    }
    if (batch.length >= size || bytes + itemBytes > EXPORT_MEDIA_BYTES_LIMIT) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += itemBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function exportBatchCount(itemCount: number, batchSize = EXPORT_BATCH_SIZE): number {
  if (itemCount <= 0) return 0;
  return Math.ceil(itemCount / Math.max(1, batchSize));
}

/** Single export keeps the old name. Later parts are numbered so downloads do not overwrite each other. */
export function exportZipFilename(dateTag: string, index: number, total: number): string {
  if (total <= 1) return `likemind-knowledge-base-${dateTag}.zip`;
  return `likemind-knowledge-base-${dateTag}-part-${index + 1}-of-${total}.zip`;
}
