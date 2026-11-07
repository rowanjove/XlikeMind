import { hasArchivedMedia } from '../domain/media';
import Dexie from 'dexie';
import type { LikeMindDB } from '../storage/db';
import type { MediaAsset } from '../domain/types';
import { downloadMediaAsset, isDecodableImage } from './mediaDownloader';

export interface MediaRetryResult {
  tried: number;
  downloaded: number;
  failed: number;
  assets: MediaAsset[];
}

export const MEDIA_RETRY_BATCH_LIMIT = 20;

export function isMissingImage(asset: MediaAsset): boolean {
  return asset.kind === 'image' && !hasArchivedMedia(asset);
}

async function downloadAndSave(database: LikeMindDB, asset: MediaAsset, signal?: AbortSignal) {
  const result = await downloadMediaAsset({ ...asset, status: 'pending', failureReason: undefined }, { signal });
  if (signal?.aborted) return undefined;
  return database.transaction('rw', database.media, async () => {
    const current = await database.media.get(asset.id);
    if (!current || current.sourceUrl !== asset.sourceUrl || signal?.aborted) return current;
    if (hasArchivedMedia(current)) return current;
    const updated = { ...result.asset, sourceUrl: asset.sourceUrl, altText: current.altText };
    await database.media.put(updated);
    return updated;
  });
}

/** Download missing images and recheck explicitly reported broken previews. */
export async function retryPostMedia(
  database: LikeMindDB,
  postId: string,
  options?: { signal?: AbortSignal; unreadableIds?: ReadonlySet<string> }
): Promise<MediaRetryResult> {
  const existing = await database.media.where('postId').equals(postId).sortBy('position');
  const assets: MediaAsset[] = [];
  let tried = 0;
  let downloaded = 0;
  let failed = 0;

  for (let asset of existing) {
    if (options?.signal?.aborted) {
      assets.push(asset);
      continue;
    }
    if (options?.unreadableIds?.has(asset.id) && hasArchivedMedia(asset)) {
      const checked = await database.transaction('rw', database.media, async () => {
        const current = await database.media.get(asset.id);
        if (!current || current.postId !== postId) return;
        if (hasArchivedMedia(current) && !(await Dexie.waitFor(isDecodableImage(current.blob))) && !options.signal?.aborted) {
          current.status = 'failed';
          current.failureReason = '本地图片无法解码';
          await database.media.put(current);
        }
        return current;
      });
      if (!checked) continue;
      asset = checked;
    }
    if (hasArchivedMedia(asset)) {
      assets.push(asset);
      continue;
    }
    tried++;
    const saved = await downloadAndSave(database, asset, options?.signal);
    if (options?.signal?.aborted) {
      assets.push(saved ?? asset);
      continue;
    }
    if (saved) assets.push(saved);
    if (saved && hasArchivedMedia(saved)) downloaded++;
    else failed++;
  }

  return { tried, downloaded, failed, assets };
}

export async function retryMissingImages(
  database: LikeMindDB,
  postIds: string[],
  { signal, onProgress, limit = MEDIA_RETRY_BATCH_LIMIT, assetIds, afterAssetId }: {
    signal: AbortSignal;
    onProgress?: (progress: ImageRetryProgress) => void;
    limit?: number;
    assetIds?: ReadonlySet<string>;
    afterAssetId?: string;
  },
) {
  const candidates = await database.media.where('postId').anyOf(postIds)
    .filter((asset) => (!assetIds || assetIds.has(asset.id)) && isMissingImage(asset) && Boolean(asset.sourceUrl)).toArray();
  if (afterAssetId) {
    candidates.sort((a, b) =>
      Number(a.id <= afterAssetId) - Number(b.id <= afterAssetId) ||
      (a.id < b.id ? -1 : Number(a.id > b.id)));
  } else {
    // On the first pass, retry earlier failures before pending images.
    candidates.sort((a, b) => Number(b.status === 'failed') - Number(a.status === 'failed'));
  }
  const batch = candidates.slice(0, Math.min(limit, MEDIA_RETRY_BATCH_LIMIT));
  const progress: ImageRetryProgress = {
    total: batch.length, remaining: candidates.length - batch.length, attempted: 0, processed: 0, downloaded: 0, failed: 0, skipped: 0,
  };
  onProgress?.({ ...progress });
  for (const asset of batch) {
    if (signal.aborted) break;
    const current = await database.media.get(asset.id);
    if (!current || current.sourceUrl !== asset.sourceUrl || !isMissingImage(current)) {
      progress.skipped++;
    } else {
      progress.attempted++;
      progress.lastAttemptedId = asset.id;
      onProgress?.({ ...progress });
      const saved = await downloadAndSave(database, current, signal);
      if (signal.aborted) break;
      if (!saved || saved.sourceUrl !== asset.sourceUrl) progress.skipped++;
      else if (hasArchivedMedia(saved)) progress.downloaded++;
      else progress.failed++;
    }
    progress.processed++;
    onProgress?.({ ...progress });
  }
}

export interface ImageRetryProgress {
  total: number;
  remaining: number;
  attempted: number;
  processed: number;
  downloaded: number;
  failed: number;
  skipped: number;
  lastAttemptedId?: string;
}
