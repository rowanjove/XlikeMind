import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { LikeMindDB } from '../src/storage/db';
import { MEDIA_RETRY_BATCH_LIMIT, retryMissingImages, retryPostMedia } from '../src/sync/retryMedia';
import type { MediaAsset } from '../src/domain/types';

function media(patch: Partial<MediaAsset> & Pick<MediaAsset, 'id' | 'sourceUrl' | 'status'>): MediaAsset {
  return {
    postId: 'x:1',
    position: 0,
    kind: 'image',
    ...patch,
  };
}

describe('retry one post media', () => {
  let database: LikeMindDB;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prioritizes failures, caps requests, and keeps the unprocessed images available', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    database = new LikeMindDB(`retry_batch_${Date.now()}`);
    const pending = Array.from({ length: MEDIA_RETRY_BATCH_LIMIT }, (_, index) => media({
      id: `pending-${index}`, sourceUrl: `https://pbs.twimg.com/media/pending-${index}.png`,
      status: index === 0 ? 'downloaded' : 'pending',
      blob: index === 0 ? new Blob([], { type: 'image/png' }) : undefined,
    }));
    const failed = media({ id: 'failed', sourceUrl: 'https://pbs.twimg.com/media/previously-failed.png', status: 'failed' });
    await database.media.bulkPut([...pending, failed]);
    const fetchImage = vi.fn<(url: string) => Promise<Response>>(async () =>
      new Response(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), { headers: { 'Content-Type': 'image/png' } })
    );
    vi.stubGlobal('fetch', fetchImage);
    const onProgress = vi.fn();
    await retryMissingImages(database, ['x:1'], { signal: new AbortController().signal, onProgress });
    expect(fetchImage).toHaveBeenCalledTimes(MEDIA_RETRY_BATCH_LIMIT);
    expect(fetchImage.mock.calls[0]?.[0]).toBe(failed.sourceUrl);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      processed: MEDIA_RETRY_BATCH_LIMIT, downloaded: MEDIA_RETRY_BATCH_LIMIT, remaining: 1, failed: 0,
    }));
    expect(await database.media.where('status').equals('pending').count()).toBe(1);
    expect((await database.media.get('pending-0'))?.blob?.size).toBeGreaterThan(0);
  });

  it('preserves an interrupted image and stops before the next download', async () => {
    database = new LikeMindDB(`retry_cancel_${Date.now()}`);
    await database.media.bulkPut(['one', 'two'].map((id) => media({
      id, sourceUrl: `https://pbs.twimg.com/media/${id}.png`, status: 'pending',
    })));
    const controller = new AbortController();
    const fetchImage = vi.fn(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetchImage);
    const onProgress = vi.fn();
    await retryMissingImages(database, ['x:1'], { signal: controller.signal, onProgress });
    expect(fetchImage).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ attempted: 1, processed: 0 }));
    expect(await database.media.where('status').equals('pending').count()).toBe(2);
  });

  it('saves a fixture image, refuses other hosts, and leaves a saved blob alone', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    database = new LikeMindDB(`retry_media_${Date.now()}_${Math.random()}`);
    const saved = new Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'image/png' });
    await database.media.bulkPut([
      media({
        id: 'x:1_media_0',
        position: 0,
        sourceUrl: 'https://pbs.twimg.com/media/mock_retry.jpg',
        status: 'downloaded',
        blob: new Blob([], { type: 'image/jpeg' }),
      }),
      media({
        id: 'x:1_media_1',
        position: 1,
        sourceUrl: 'https://example.com/nope.jpg',
        status: 'failed',
        failureReason: '之前失败',
      }),
      media({
        id: 'x:1_media_2',
        position: 2,
        sourceUrl: 'https://example.com/already.png',
        status: 'downloaded',
        blob: saved,
      }),
    ]);

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), { headers: { 'Content-Type': 'image/png' } })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await retryPostMedia(database, 'x:1');

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.tried).toBe(2);
    expect(result.downloaded).toBe(1);
    expect(result.failed).toBe(1);

    expect(result.assets[0]?.blob).toBeInstanceOf(Blob);
    expect(result.assets[1]?.failureReason).toContain('pbs.twimg.com');
    expect(result.assets[2]?.status).toBe('downloaded');
    expect(result.assets[2]?.sourceUrl).toBe('https://example.com/already.png');
    expect(result.assets[2]?.failureReason).toBeUndefined();

    const fixture = await database.media.get('x:1_media_0');
    const blocked = await database.media.get('x:1_media_1');
    const kept = await database.media.get('x:1_media_2');
    expect(fixture?.status).toBe('downloaded');
    expect(blocked?.status).toBe('failed');
    expect(kept?.status).toBe('downloaded');
  });
});
