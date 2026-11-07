import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { LikeMindDB } from '../src/storage/db';
import { SyncService } from '../src/sync/syncService';
import { FixtureCaptureAdapter, generateMockPosts } from '../src/adapters/fixtureAdapter';
import type { CaptureAdapter, CaptureResult } from '../src/adapters/types';
import { generatePostMarkdown } from '../src/export/markdown';
import { generateArchiveReader } from '../src/export/reader';

describe('SyncService & Lifecycle Recovery', () => {
  it('retains visible references and image descriptions across less complete reads and renders them in exports', async () => {
    const url = 'https://pbs.twimg.com/media/description.jpg';
    const raw = { postId: '978', text: '可见正文', mediaUrls: [url] };
    const run = await syncService.beginXSync(5, false);
    await syncService.ingestXBatch(run.id, [raw]);
    await syncService.finishXSync(run.id, { hasMore: false, terminalStatus: 'complete' });
    await syncService.refreshPost({
      ...raw,
      isPartial: true,
      mediaAltTexts: { [url]: '坐标图 <示例>' },
      references: [
        { kind: 'reply', id: 'wrong', url: 'https://twitter.com/ada/status/977?t=tracker' },
        { kind: 'article', id: '970', url: 'https://outside.invalid/i/article/970' },
      ],
    });
    await syncService.refreshPost(raw);
    const saved = (await testDb.posts.get('x:978'))!;
    const media = await testDb.media.where('postId').equals(saved.id).toArray();
    expect(saved.references).toEqual([{ kind: 'reply', id: '977', url: 'https://x.com/ada/status/977' }]);
    expect(media[0]?.altText).toBe('坐标图 <示例>');
    const md = generatePostMarkdown({ post: saved, media, exportedAt: saved.lastObservedAt });
    expect(md).toContain('[回复的帖子](https://x.com/ada/status/977)');
    expect(md).toContain('图片说明：坐标图');
    const html = generateArchiveReader([saved], new Map([[saved.id, media]]), new Map(), new Map());
    expect(html).toContain('href="https://x.com/ada/status/977"');
    expect(html).not.toContain('outside.invalid');
  });
  it('keeps an intact body when the stored post is partial only because of a quote', async () => {
    const raw = { postId: '979', text: '完整正文', authorHandle: 'ada', authorDisplayName: 'Ada',
      isPartial: true, missingFields: ['quoted_post_body'],
      references: [{ kind: 'quote' as const, id: '978', url: 'https://x.com/ada/status/978' }] };
    const run = await syncService.beginXSync(2, false);
    await syncService.ingestXBatch(run.id, [raw]);
    await syncService.finishXSync(run.id, { hasMore: false, terminalStatus: 'complete' });
    const saved = (await testDb.posts.get('x:979'))!;

    const recapture = await syncService.beginXSync(2, false);
    await syncService.ingestXBatch(recapture.id, [{
      ...raw, text: '这段采集的正文更长，但它仍然只是一段截断文本',
      authorHandle: ' ', authorDisplayName: ' ', missingFields: ['truncated_text'],
    }]);
    expect(await testDb.posts.get('x:979')).toMatchObject({
      text: saved.text, author: saved.author, contentHash: saved.contentHash,
      captureStatus: 'partial', missingFields: ['quoted_post_body'], sourceRunId: run.id,
    });
  });

  it('reopens an interrupted DOM run with durable deduplication and its original quota', async () => {
    const original = { tabId: 17, documentId: 'before-restart', expectedXHandle: 'reader', observedXHandle: 'reader' };
    const reopened = { ...original, tabId: 31, documentId: 'after-restart' };
    const first = { postId: '881', text: 'Committed before the browser closed' };
    const run = await syncService.beginXSync(2, false, 'x_likes', original);
    await syncService.ingestXBatch(run.id, [first], original);

    testDb.close();
    await testDb.open();
    const restartedService = new SyncService(testDb);
    expect(await restartedService.recoverStaleRuns()).toMatchObject([
      { id: run.id, status: 'paused', failureCode: 'interrupted', seenPostIds: ['881'] },
    ]);
    await expect(restartedService.beginXSync(50, false, 'x_bookmarks', reopened)).rejects.toThrow('来源');
    await expect(restartedService.beginXSync(50, false, 'x_likes', { ...reopened, expectedXHandle: 'another' }))
      .rejects.toThrow('账号');
    const resumed = await restartedService.beginXSync(50, false, 'x_likes', reopened);
    expect(resumed).toMatchObject({ id: run.id, targetLimit: 2, seenPostIds: ['881'], stats: { scanned: 1 } });
    await expect(restartedService.finishXSync(run.id, { hasMore: false, terminalStatus: 'partial' }, {
      ...reopened, documentId: original.documentId,
    })).rejects.toThrow('来源页面');
    const saved = await restartedService.ingestXBatch(run.id, [
      first, { postId: '882', text: 'First new post after restart' }, { postId: '883', text: 'Over quota' },
    ], reopened);
    expect(saved.stats).toMatchObject({ scanned: 2, added: 2, skipped: 0 });
    expect(await testDb.posts.count()).toBe(2);
    expect(await testDb.posts.get('x:881')).toMatchObject({ text: first.text, sourceRunId: run.id });
    expect(await testDb.posts.get('x:882')).toMatchObject({ sourceRunId: run.id });
  });

  it('finishes pending images when a committed batch is replayed at its scan limit', async () => {
    const downloader = await import('../src/sync/mediaDownloader');
    const download = vi.spyOn(downloader, 'downloadMediaAsset')
      .mockRejectedValueOnce(new Error('Worker stopped before image storage'));
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), { headers: { 'Content-Type': 'image/png' } })));
    vi.stubGlobal('Blob', NodeBlob);
    const first = { postId: '883', text: 'Already archived' };
    const second = { postId: '884', text: 'Text committed before image storage',
      mediaUrls: ['https://pbs.twimg.com/media/replayed.png'] };
    try {
      const run = await syncService.beginXSync(2, true);
      await expect(syncService.ingestXBatch(run.id, [first, second])).rejects.toThrow('Worker stopped');
      const saved = await testDb.posts.get('x:884');
      expect(await testDb.media.get('884_media_0')).toMatchObject({ status: 'pending' });

      const restartedService = new SyncService(testDb);
      const replayed = await restartedService.ingestXBatch(run.id, [first, second, { postId: '885', text: 'Over quota' }]);
      expect(replayed.stats).toEqual({ scanned: 2, added: 2, updated: 0, skipped: 0, failed: 0 });
      expect(await testDb.posts.get('x:884')).toEqual(saved);
      expect(await testDb.posts.get('x:885')).toBeUndefined();
      expect(await testDb.media.get('884_media_0')).toMatchObject({ status: 'downloaded', blob: expect.objectContaining({ size: 8 }) });
      await restartedService.ingestXBatch(run.id, [first, second]);
      expect(download).toHaveBeenCalledTimes(2);
    } finally {
      download.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('retries images and accepts visible repairs only from the resumed run, without charging scan quota', async () => {
    const old = await syncService.beginXSync(10, false);
    const unrelated = { postId: '90', text: 'Other', isPartial: true, mediaUrls: ['https://pbs.twimg.com/media/unrelated.png'] };
    const revisited = { postId: '89', text: 'Previously saved excerpt', isPartial: true,
      mediaUrls: ['https://pbs.twimg.com/media/revisited.png'] };
    await syncService.ingestXBatch(old.id, [unrelated, revisited]);
    await syncService.finishXSync(old.id, { hasMore: false, terminalStatus: 'complete' });
    const run = await syncService.beginXSync(10, false);
    const incomplete = { postId: '91', text: 'Start', isPartial: true, mediaUrls: ['https://pbs.twimg.com/media/recover.png'] };
    await syncService.ingestXBatch(run.id, [incomplete, revisited]);
    await syncService.finishXSync(run.id, { hasMore: true, terminalStatus: 'partial', paused: true });
    const newlySeen = 'https://pbs.twimg.com/media/newly-visible.png';
    const unavailable = 'https://pbs.twimg.com/media/not-available.png';
    const fetchImage = vi.fn(async (url: string) => url.includes('/media/not-available')
      ? new Response(null, { status: 404 })
      : new Response(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchImage);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const resumed = await syncService.beginXSync(10, true);
      expect(resumed.id).toBe(run.id);
      expect(resumed.resumePostIds).toEqual(['91', '89']);
      expect(fetchImage).toHaveBeenCalledTimes(2);
      expect(fetchImage).toHaveBeenCalledWith(incomplete.mediaUrls[0], expect.anything());
      expect(fetchImage).toHaveBeenCalledWith(revisited.mediaUrls[0], expect.anything());
      expect((await testDb.media.get('91_media_0'))?.status).toBe('downloaded');
      expect((await testDb.media.get('89_media_0'))?.status).toBe('downloaded');
      const result = await syncService.ingestXBatch(run.id, [{ postId: '92', text: 'Fresh' }], undefined, [
        { ...incomplete, text: 'Start with the full body', isPartial: false,
          mediaUrls: [...incomplete.mediaUrls, newlySeen, unavailable] },
        { ...revisited, text: 'Previously saved excerpt with complete text', isPartial: false },
        { ...unrelated, text: 'Should not change', isPartial: false },
      ]);
      expect(result.stats).toMatchObject({ scanned: 3, added: 2, updated: 0 });
      expect(fetchImage).toHaveBeenCalledWith(newlySeen, expect.anything());
      expect((await testDb.media.get('91_media_1'))?.status).toBe('downloaded');
      expect(await testDb.media.get('91_media_2')).toMatchObject({ status: 'failed', sourceUrl: unavailable });
      expect(await testDb.posts.get('x:89')).toMatchObject({ captureStatus: 'complete', sourceRunId: old.id });
      expect(await testDb.posts.get('x:91')).toMatchObject({ text: 'Start with the full body', captureStatus: 'complete', sourceRunId: run.id });
      expect(await testDb.posts.get('x:90')).toMatchObject({ text: 'Other', captureStatus: 'partial' });
      await syncService.ingestXBatch(run.id, [], undefined, [{ ...incomplete, text: 'Duplicate repair', isPartial: false }]);
      expect((await testDb.posts.get('x:91'))?.text).toBe('Start with the full body');
      const finished = await syncService.finishXSync(run.id, { hasMore: false, terminalStatus: 'complete' });
      expect(finished.repairStats).toEqual({
        textAttempts: 2, textRecovered: 2, imageAttempts: 4, imagesRecovered: 3,
        remainingPosts: 0, remainingImages: 1,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reaches later pending images after earlier images fail during a resume', async () => {
    const run = await syncService.beginXSync(20, false);
    const items = Array.from({ length: 5 }, (_, index) => ({
      postId: String(600 + index), text: 'Image retry fixture',
      mediaUrls: [`https://pbs.twimg.com/media/resume-${index}.png`],
    }));
    await syncService.ingestXBatch(run.id, items);
    const pause = { hasMore: true, terminalStatus: 'partial', paused: true } as const;
    await syncService.finishXSync(run.id, pause);
    const fetchImage = vi.fn(async (url: string) => url === items[4].mediaUrls[0]
      ? new Response(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), { headers: { 'Content-Type': 'image/png' } })
      : new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchImage);
    try {
      await syncService.beginXSync(20, true);
      expect(await testDb.media.get('604_media_0')).toMatchObject({ status: 'remote_only' });
      await syncService.finishXSync(run.id, pause);
      fetchImage.mockClear();
      await new SyncService(testDb).beginXSync(20, true);
      expect(fetchImage.mock.calls[0]?.[0]).toBe(items[4].mediaUrls[0]);
      expect(await testDb.media.get('604_media_0')).toMatchObject({ status: 'downloaded' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rotates bounded text repairs across pauses when earlier posts stay incomplete', async () => {
    const run = await syncService.beginXSync(20, false);
    const items = Array.from({ length: 10 }, (_, index) => ({
      postId: String(500 + index), text: 'Incomplete text', isPartial: true,
    }));
    await syncService.ingestXBatch(run.id, items);
    const pause = { hasMore: true, terminalStatus: 'partial', paused: true } as const;
    await syncService.finishXSync(run.id, pause);
    expect((await syncService.beginXSync(20, false)).resumePostIds).toEqual(items.slice(0, 8).map((item) => item.postId));
    await syncService.finishXSync(run.id, pause);
    const reopened = new SyncService(testDb);
    expect((await reopened.beginXSync(20, false)).resumePostIds).toEqual(
      [...items.slice(8), ...items.slice(0, 6)].map((item) => item.postId),
    );
  });

  it('persists a timed pause and a platform failure without discarding saved posts', async () => {
    const run = await syncService.beginXSync(20, false);
    await syncService.ingestXBatch(run.id, [{ postId: '171', text: '已保存' }]);
    expect(await syncService.finishXSync(run.id, {
      hasMore: true, terminalStatus: 'partial', paused: true, failureCode: 'time_limit',
    })).toMatchObject({ status: 'paused', failureCode: 'time_limit', stats: { added: 1 } });
    const resumed = await syncService.beginXSync(20, false);
    expect(resumed.id).toBe(run.id);
    expect(await syncService.finishXSync(run.id, {
      hasMore: false, terminalStatus: 'failed', failureCode: 'access_restricted', error: 'X 页面提示请求频率受限',
    })).toMatchObject({ status: 'partial', failureCode: 'access_restricted' });
    expect(await testDb.posts.get('x:171')).toMatchObject({ text: '已保存' });
  });

  it('retains sanitized save failure frames without advancing the checkpoint', async () => {
    const run = await syncService.beginXSync(20, false);
    const first = await syncService.ingestXBatch(run.id, [{ postId: '171', text: '已保存' }]);
    const error = new Error('private storage details');
    error.stack = `Error: private storage details\n    at ${chrome.runtime.getURL('background.js')}:12:34`;
    const normalize = vi.spyOn(syncService, 'normalizeItem').mockRejectedValueOnce(error);
    try {
      await expect(syncService.ingestXBatch(run.id, [{ postId: '172', text: '尚未保存' }])).rejects.toBe(error);
    } finally {
      normalize.mockRestore();
    }
    const paused = await syncService.finishXSync(run.id, {
      hasMore: true, terminalStatus: 'partial', paused: true, failureCode: 'save_interrupted',
    });
    expect(paused).toMatchObject({ status: 'paused', stats: first.stats, diagnosticFrames: ['background.js:12:34'] });
    expect(paused.failureMessage).not.toContain('private');
    expect(await testDb.posts.get('x:172')).toBeUndefined();
    expect((await syncService.beginXSync(20, false)).id).toBe(run.id);
    expect((await testDb.syncRuns.get(run.id))?.diagnosticFrames).toBeUndefined();
  });

  it('keeps one post and its original batch when observed as both a like and a bookmark', async () => {
    const first = await syncService.beginXSync(1, false, 'x_likes');
    const second = await syncService.beginXSync(1, false, 'x_bookmarks');
    const raw = { postId: '5060', text: 'Shared post' };
    await syncService.ingestXBatch(first.id, [raw]);
    await syncService.ingestXBatch(second.id, [raw]);
    expect((await testDb.syncRuns.get(second.id))?.changedPostIds ?? []).toEqual([]);
    expect(await testDb.posts.count()).toBe(1);
    expect(await testDb.posts.get('x:5060')).toMatchObject({
      sources: ['x_likes', 'x_bookmarks'],
      sourceRunId: first.id,
      likedAt: null,
    });
    const edited = await syncService.beginXSync(1, false, 'x_bookmarks');
    await syncService.ingestXBatch(edited.id, [{ ...raw, text: 'Shared post with updated source content' }]);
    expect(await testDb.syncRuns.get(edited.id)).toMatchObject({ changedPostIds: ['x:5060'] });
    expect(await testDb.posts.get('x:5060')).toMatchObject({ sourceRunId: first.id });
  });
  it('does not commit an older download after a concurrent capture replaces its URL', async () => {
    const media = await import('../src/sync/mediaDownloader');
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const oldUrl = 'https://pbs.twimg.com/media/old.png';
    const newUrl = 'https://pbs.twimg.com/media/new.png';
    const spy = vi.spyOn(media, 'downloadMediaAsset').mockImplementation(async (asset) => {
      if (asset.sourceUrl === oldUrl) await gate;
      return { success: true, asset: { ...asset, status: 'downloaded', blob: new Blob([asset.sourceUrl]) } };
    });
    try {
      const first = await syncService.beginXSync(1, true);
      const older = syncService.ingestXBatch(first.id, [{ postId: '5010', text: 'old', mediaUrls: [oldUrl] }]);
      await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
      const second = await syncService.beginXSync(1, true);
      await syncService.ingestXBatch(second.id, [{ postId: '5010', text: 'new', mediaUrls: [newUrl] }]);
      release();
      await older;
      expect((await testDb.posts.get('x:5010'))?.text).toBe('new');
      expect(await testDb.media.get('5010_media_0')).toMatchObject({ sourceUrl: newUrl, status: 'downloaded' });
    } finally {
      release();
      spy.mockRestore();
    }
  });
  let testDb: LikeMindDB;
  let syncService: SyncService;

  beforeEach(() => {
    testDb = new LikeMindDB(`sync_test_${Date.now()}_${Math.random()}`);
    syncService = new SyncService(testDb);
  });

  it('runs a full batch sync using standard fixtures and stores posts and media', async () => {
    const adapter = new FixtureCaptureAdapter();
    const run = await syncService.runSync({
      adapter,
      targetLimit: 10,
      downloadMedia: true,
    });

    expect(run.status).toBe('completed');
    expect(run.stats.scanned).toBe(8); // Standard fixtures contain 8 items
    expect(run.stats.added).toBe(8);

    const postCount = await testDb.posts.count();
    expect(postCount).toBe(8);

    // Media should also be saved
    const mediaCount = await testDb.media.count();
    expect(mediaCount).toBeGreaterThan(0);

    // Verify broken image item was marked failed but did not break the sync
    const failedMedia = await testDb.media.where('status').equals('failed').toArray();
    expect(failedMedia.length).toBeGreaterThanOrEqual(1);
    expect(failedMedia[0].failureReason).toBeDefined();
  });

  it('replaces media by position when a later capture changes the source URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fixture image unavailable')));
    try {
    const first = await syncService.beginXSync(10, true);
    await syncService.ingestXBatch(first.id, [
      {
        postId: 'media-change-1',
        text: 'original body',
        mediaUrls: [
          'https://pbs.twimg.com/media/mock_a.png',
          'https://pbs.twimg.com/media/mock_b.png',
        ],
      },
    ]);

    const second = await syncService.beginXSync(10, true);
    await syncService.ingestXBatch(second.id, [
      {
        postId: 'media-change-1',
        text: 'updated body',
        mediaUrls: ['https://pbs.twimg.com/media/mock_c.png'],
      },
    ]);

    const post = await testDb.posts.get('x:media-change-1');
    const media = await testDb.media.where('postId').equals('x:media-change-1').sortBy('position');
    expect(post?.text).toBe('updated body');
    expect(post?.mediaIds).toEqual(['media-change-1_media_0']);
    expect(media.map((asset) => asset.sourceUrl)).toEqual(['https://pbs.twimg.com/media/mock_c.png']);
    expect(media[0]?.status).toBe('failed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('preserves downloaded media and its order when a partial observation shifts positions', async () => {
    const first = 'https://pbs.twimg.com/media/first.png';
    const second = 'https://pbs.twimg.com/media/second.png';
    const third = 'https://pbs.twimg.com/media/third.png';
    const raw = { postId: '7771', text: '完整正文', mediaUrls: [first, second] };
    const original = await syncService.refreshPost(raw);
    const blob = new Blob(['offline archive'], { type: 'image/png' });
    await testDb.media.update('7771_media_1', { status: 'downloaded', mime: 'image/png', blob });

    const partial = await syncService.refreshPost({ ...raw, text: '完整', mediaUrls: [second], isPartial: true });
    expect(partial).toMatchObject({ text: raw.text, contentHash: original.contentHash, mediaIds: original.mediaIds });
    const appended = await syncService.refreshPost({ ...raw, mediaUrls: [second, third], isPartial: true });
    expect(appended.contentHash).not.toBe(original.contentHash);
    const saved = await testDb.media.where('postId').equals(original.id).sortBy('position');
    expect(saved.map(({ sourceUrl }) => sourceUrl)).toEqual([first, second, third]);
    expect(saved[1]).toMatchObject({ id: '7771_media_1', status: 'downloaded' });
    expect(saved[1].blob).toBeDefined();
  });

  it('refreshes a visible post with a pending media source and keeps downloads explicit', async () => {
    await testDb.posts.put({
      id: 'x:refresh-1',
      platform: 'x',
      postId: 'refresh-1',
      canonicalUrl: 'https://x.com/user/status/refresh-1',
      text: 'old',
      postedAt: null,
      likedAt: null,
      firstObservedAt: '2026-10-01T00:00:00.000Z',
      lastObservedAt: '2026-10-01T00:00:00.000Z',
      captureStatus: 'complete',
      missingFields: [],
      externalLinks: [],
      mediaIds: ['refresh-1_media_0'],
      contentHash: 'old',
      sourceAdapter: 'x_dom',
      sourceRunId: 'run_old',
      schemaVersion: 1,
    });
    await testDb.media.put({
      id: 'refresh-1_media_0',
      postId: 'x:refresh-1',
      position: 0,
      kind: 'image',
      sourceUrl: 'https://pbs.twimg.com/media/old.png',
      status: 'downloaded',
      blob: new Blob(['old']),
    });

    const refreshed = await syncService.refreshPost({
      postId: 'refresh-1',
      url: 'https://x.com/user/status/refresh-1',
      text: 'new',
      mediaUrls: ['https://pbs.twimg.com/media/new.png'],
    });
    const media = await testDb.media.get('refresh-1_media_0');
    expect(refreshed.text).toBe('new');
    expect(media?.sourceUrl).toBe('https://pbs.twimg.com/media/new.png');
    expect(media?.status).toBe('pending');
    expect(media?.blob).toBeUndefined();
  });

  it('can detect and recover dangling interrupted sync runs', async () => {
    // Simulate a sync run left in 'running' state when browser crashed
    await testDb.syncRuns.put({
      id: 'interrupted_run_001',
      startedAt: new Date(Date.now() - 60000).toISOString(),
      lastCheckpointAt: new Date(Date.now() - 30000).toISOString(),
      status: 'running',
      stats: { scanned: 5, added: 5, updated: 0, skipped: 0, failed: 0 },
      targetLimit: 50,
      downloadMedia: true,
      adapterType: 'x_dom',
    });

    const recovered = await syncService.checkAndRecoverDanglingRuns();
    expect(recovered).not.toBeNull();
    expect(recovered?.id).toBe('interrupted_run_001');
    expect(recovered?.status).toBe('partial');
    expect(recovered?.failureMessage).toContain('已保存的帖子都还在');

    const inDb = await testDb.syncRuns.get('interrupted_run_001');
    expect(inDb?.status).toBe('partial');
  });

  it('handles cancellation signal gracefully and persists checkpoint', async () => {
    const adapter = new FixtureCaptureAdapter(generateMockPosts(50));
    const controller = new AbortController();

    // Abort after 3 items
    let count = 0;
    const run = await syncService.runSync({
      adapter,
      targetLimit: 50,
      downloadMedia: false,
      signal: controller.signal,
      onProgress: () => {
        count++;
        if (count >= 3) {
          controller.abort();
        }
      },
    });

    expect(run.status).toBe('cancelled');
    const postsCount = await testDb.posts.count();
    expect(postsCount).toBeGreaterThanOrEqual(3);
  });

  it('handles volume of 100 mock posts efficiently', async () => {
    const adapter = new FixtureCaptureAdapter(generateMockPosts(100));
    const startTime = Date.now();

    const run = await syncService.runSync({
      adapter,
      targetLimit: 100,
      downloadMedia: false,
    });

    const durationMs = Date.now() - startTime;
    expect(run.status).toBe('completed');
    expect(run.stats.added).toBe(100);
    expect(await testDb.posts.count()).toBe(100);
    // 100 items normalized, hashed, and inserted into Dexie should complete in well under 3 seconds
    expect(durationMs).toBeLessThan(5000);
  });

  it('keeps a timeline-end capture partial and does not delete saved posts', async () => {
    const adapter: CaptureAdapter = {
      name: 'x_dom',
      async captureBatch(): Promise<CaptureResult> {
        return {
          items: [{ postId: '9001', text: 'visible like', postedAt: '2024-01-01T00:00:00.000Z' }],
          hasMore: false,
          status: 'partial',
          error: '已到达当前可见列表末尾。这不代表历史点赞已全部采集。',
        };
      },
    };

    const run = await syncService.runSync({ adapter, targetLimit: 20, downloadMedia: false });
    expect(run.status).toBe('partial');
    expect(run.failureCode).toBe('range_unknown');
    expect(run.failureMessage).toContain('不代表历史点赞已全部采集');
    const stored = await testDb.posts.get('x:9001');
    expect(stored?.text).toBe('visible like');
    expect(stored?.likedAt).toBeNull();
  });

  it('keeps a legacy analysis current until the source links actually change', async () => {
    const raw = { postId: '989', text: 'Source text stays the same', externalLinks: ['https://example.com/one'] };
    const previous = await syncService.refreshPost(raw);
    await testDb.posts.update(previous.id, { contentHash: 'legacy-hash' });
    await testDb.aiAnalysis.put({
      postId: previous.id, sourceHash: 'legacy-hash', model: 'fixture', promptVersion: 'fixture',
      status: 'complete', categories: [], tags: [],
    });
    expect((await syncService.refreshPost(raw)).contentHash).toBe('legacy-hash');
    expect((await testDb.aiAnalysis.get(previous.id))?.status).toBe('complete');

    const run = await syncService.beginXSync(10, false);
    await syncService.ingestXBatch(run.id, [{ ...raw, externalLinks: ['https://example.com/two'] }]);
    expect(await testDb.syncRuns.get(run.id)).toMatchObject({ changedPostIds: [previous.id] });
    expect(await testDb.aiAnalysis.get(previous.id)).toMatchObject({ status: 'stale' });
    const updated = await testDb.posts.get(previous.id);
    expect(updated?.contentHash).not.toBe('legacy-hash');
    expect((await syncService.refreshPost({ ...raw, externalLinks: [...updated!.externalLinks].reverse() })).contentHash)
      .toBe(updated?.contentHash);
  });

  it('marks an existing AI result stale after the source text changes', async () => {
    const first: CaptureAdapter = {
      name: 'fixture',
      async captureBatch(): Promise<CaptureResult> {
        return {
          items: [{ postId: '42', text: 'original tutorial steps', postedAt: '2026-01-01T00:00:00.000Z' }],
          hasMore: false,
          status: 'complete',
        };
      },
    };
    await syncService.runSync({ adapter: first, targetLimit: 5, downloadMedia: false });
    const original = await testDb.posts.get('x:42');
    await testDb.aiAnalysis.put({
      postId: 'x:42',
      sourceHash: original!.contentHash,
      model: 'mock',
      promptVersion: 'v1',
      status: 'complete',
      categories: ['编程开发'],
      tags: ['tutorial'],
    });

    const edited: CaptureAdapter = {
      name: 'fixture',
      async captureBatch(): Promise<CaptureResult> {
        return {
          items: [{ postId: '42', text: 'original tutorial steps, edited', postedAt: '2026-01-01T00:00:00.000Z' }],
          hasMore: false,
          status: 'complete',
        };
      },
    };
    const run = await syncService.runSync({ adapter: edited, targetLimit: 5, downloadMedia: false });
    expect(run.stats.updated).toBe(1);
    expect((await testDb.posts.get('x:42'))?.text).toContain('edited');
    expect((await testDb.posts.get('x:42'))?.firstObservedAt).toBe(original?.firstObservedAt);
    expect((await testDb.aiAnalysis.get('x:42'))?.status).toBe('stale');
  });

  it('ingests a popup batch and keeps a bounded X read partial', async () => {
    const run = await syncService.beginXSync(50, false);
    expect(run.adapterType).toBe('x_dom');
    expect(run.status).toBe('running');

    const saved = await syncService.ingestXBatch(run.id, [
      {
        postId: '777',
        text: '全文没有被截断',
        postedAt: '2026-02-02T00:00:00.000Z',
        mediaUrls: ['https://pbs.twimg.com/media/abc.jpg?format=jpg&name=large'],
      },
    ]);
    expect(saved.stats.added).toBe(1);
    const post = await testDb.posts.get('x:777');
    expect(post?.text).toBe('全文没有被截断');
    expect(post?.sourceAdapter).toBe('x_dom');
    expect(post?.likedAt).toBeNull();
    expect((await testDb.media.get('777_media_0'))?.status).toBe('remote_only');

    const done = await syncService.finishXSync(run.id, {
      hasMore: false,
      terminalStatus: 'partial',
      error: '已到达当前可见列表末尾。这不代表历史点赞已全部采集。',
    });
    expect(done.status).toBe('partial');
    expect(done.failureCode).toBe('range_unknown');

    const limited = await syncService.beginXSync(1, false);
    await syncService.ingestXBatch(limited.id, [{ postId: '778', text: 'one' }]);
    const hitLimit = await syncService.finishXSync(limited.id, { hasMore: true, terminalStatus: 'partial' });
    expect(hitLimit.failureCode).toBe('limit_reached');

    const empty = await syncService.beginXSync(10, false);
    const failed = await syncService.finishXSync(empty.id, {
      hasMore: false,
      terminalStatus: 'failed',
      error: '未检测到推文',
    });
    expect(failed.status).toBe('failed');

    const stopping = await syncService.beginXSync(10, false);
    const cancelled = await syncService.finishXSync(stopping.id, {
      hasMore: true,
      terminalStatus: 'partial',
      cancelled: true,
    });
    expect(cancelled.status).toBe('cancelled');
  });

  it('recovers every stale run and leaves a fresh one running', async () => {
    const stale = {
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      lastCheckpointAt: new Date(Date.now() - 120_000).toISOString(),
      status: 'running' as const,
      stats: { scanned: 1, added: 1, updated: 0, skipped: 0, failed: 0 },
      targetLimit: 10,
      downloadMedia: false,
      adapterType: 'x_dom' as const,
    };
    await testDb.syncRuns.put({ ...stale, id: 'old_a' });
    await testDb.syncRuns.put({ ...stale, id: 'old_b' });
    await testDb.syncRuns.put({
      ...stale,
      id: 'fresh',
      lastCheckpointAt: new Date().toISOString(),
    });

    const recovered = await syncService.recoverStaleRuns(90_000);
    expect(recovered.map((run) => run.id).sort()).toEqual(['old_a', 'old_b']);
    expect((await testDb.syncRuns.get('fresh'))?.status).toBe('running');
    expect((await testDb.syncRuns.get('old_a'))?.status).toBe('partial');
  });

  it('does not put a finished run back to running', async () => {
    const media = await import('../src/sync/mediaDownloader');
    let notifyDownload = () => {};
    let finishDownload = () => {};
    const downloadStarted = new Promise<void>((resolve) => { notifyDownload = resolve; });
    const downloadReleased = new Promise<void>((resolve) => { finishDownload = resolve; });
    const spy = vi.spyOn(media, 'downloadMediaAsset').mockImplementation(async (asset) => {
      notifyDownload();
      await downloadReleased;
      return { asset: { ...asset, status: 'failed', failureReason: 'slow' }, success: false };
    });
    try {
      const run = await syncService.beginXSync(10, true);
      const pending = syncService.ingestXBatch(run.id, [
        { postId: '501', text: 'slow post', mediaUrls: ['https://pbs.twimg.com/media/slow.jpg'] },
      ]);
      await downloadStarted;
      await syncService.finishXSync(run.id, {
        hasMore: true,
        terminalStatus: 'partial',
        cancelled: true,
      });
      finishDownload();
      const saved = await pending;
      expect(saved.status).toBe('cancelled');
      expect((await testDb.syncRuns.get(run.id))?.status).toBe('cancelled');
      expect((await testDb.posts.get('x:501'))?.text).toBe('slow post');
    } finally {
      finishDownload();
      spy.mockRestore();
    }
  });

  it('pauses a run, keeps its checkpoint, and continues the same run', async () => {
    const run = await syncService.beginXSync(20, false);
    await syncService.ingestXBatch(run.id, [{ postId: 'pause-1', text: '已保存' }]);
    await testDb.syncRuns.update(run.id, { cursor: 'continue' });

    const paused = await syncService.finishXSync(run.id, {
      hasMore: true,
      terminalStatus: 'partial',
      paused: true,
    });
    expect(paused.status).toBe('paused');
    expect(paused.cursor).toBe('continue');
    expect(paused.stats).toMatchObject({ scanned: 1, added: 1 });
    expect(paused.failureMessage).toMatch(/检查点还在/);

    await syncService.recoverStaleRuns(0);
    expect((await testDb.syncRuns.get(run.id))?.status).toBe('paused');

    const resumed = await syncService.beginXSync(50, false);
    expect(resumed.id).toBe(run.id);
    expect(resumed.status).toBe('running');
    expect(resumed.endedAt).toBeUndefined();
    expect(resumed.cursor).toBe('continue');
    expect(resumed.stats.added).toBe(1);
    expect(resumed.targetLimit).toBe(50);

    await syncService.finishXSync(run.id, { hasMore: true, terminalStatus: 'partial', paused: true });
    expect(await syncService.endPausedSync()).toBe(1);
    expect((await testDb.syncRuns.get(run.id))?.status).toBe('cancelled');
    const fresh = await syncService.beginXSync(10, false);
    expect(fresh.id).not.toBe(run.id);
  });

  it('stops ingesting once the run reaches its limit', async () => {
    const run = await syncService.beginXSync(1, false);
    const saved = await syncService.ingestXBatch(run.id, [
      { postId: '601', text: 'first' },
      { postId: '602', text: 'second' },
    ]);
    expect(saved.stats.added).toBe(1);
    expect(await testDb.posts.get('x:602')).toBeUndefined();
  });
});
