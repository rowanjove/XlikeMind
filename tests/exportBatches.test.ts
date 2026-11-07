import { describe, expect, it } from 'vitest';
import {
  EXPORT_BATCH_SIZE,
  EXPORT_MEDIA_BYTES_LIMIT,
  exportBatchCount,
  exportZipFilename,
  planExportBatches,
} from '../src/export/batches';

describe('export batches', () => {
  it('keeps a small library in one zip', () => {
    expect(EXPORT_BATCH_SIZE).toBe(200);
    expect(exportBatchCount(0)).toBe(0);
    expect(exportBatchCount(200)).toBe(1);
    expect(planExportBatches([1, 2, 3], 200)).toEqual([[1, 2, 3]]);
    expect(exportZipFilename('20261031', 0, 1)).toBe('likemind-knowledge-base-20261031.zip');
  });

  it('splits 201 posts into two zips and names each part', () => {
    const items = Array.from({ length: 201 }, (_, index) => index);
    const batches = planExportBatches(items);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(200);
    expect(batches[1]).toEqual([200]);
    expect(exportBatchCount(450)).toBe(3);
    expect(exportZipFilename('20261031', 1, 3)).toBe('likemind-knowledge-base-20261031-part-2-of-3.zip');
  });

  it('keeps posts together while applying the media budget and rejects an oversized post', () => {
    const half = EXPORT_MEDIA_BYTES_LIMIT / 2;
    const items = [half, half, 1, EXPORT_MEDIA_BYTES_LIMIT - 1, 1];
    expect(planExportBatches(items, 200, (bytes) => bytes)).toEqual([[half, half], [1, EXPORT_MEDIA_BYTES_LIMIT - 1], [1]]);
    expect(() => planExportBatches([EXPORT_MEDIA_BYTES_LIMIT + 1], 200, (bytes) => bytes)).toThrow('单篇帖子的已归档媒体超过');
  });
});
