import { describe, it, expect, beforeEach } from 'vitest';
import { SyncService } from '../src/sync/syncService';
import JSZip from 'jszip';
import { db } from '../src/storage/db';
import { calculateContentHash } from '../src/domain/hash';
import {
  parseArchiveJsText,
  extractArchiveItems,
  parseArchiveFile,
  importArchiveItems,
  parseTwitterDate,
} from '../src/importers/archiveImporter';

describe('X Official Archive Importer', () => {
  beforeEach(async () => {
    await db.posts.clear();
    await db.media.clear();
    await db.syncRuns.clear();
  });

  describe('parseArchiveJsText & parseTwitterDate', () => {
    it('strips window.YTD prefix and safely parses JSON arrays', () => {
      const rawJs = `window.YTD.like.part0 = [
        {
          "like": {
            "tweetId": "1851234567890123001",
            "fullText": "Official archive tweet content",
            "expandedUrl": "https://twitter.com/i/web/status/1851234567890123001"
          }
        }
      ];`;

      const parsed = parseArchiveJsText(rawJs);
      expect(parsed).toBeInstanceOf(Array);
      expect(parsed.length).toBe(1);
      expect((parsed[0] as Record<string, unknown>).like).toBeDefined();
    });

    it('rejects malformed non-JSON data without using eval', () => {
      expect(() => parseArchiveJsText('maliciousCode();')).toThrow();
    });

    it('parses twitter created_at date format to ISO string', () => {
      const parsed = parseTwitterDate('Sun Oct 18 14:30:00 +0000 2026');
      expect(parsed).toBeTruthy();
      expect(parsed).toContain('2026-10-18');
    });
  });

  describe('extractArchiveItems', () => {
    it('extracts like.js records with strictly null likedAt', () => {
      const raw = [
        {
          like: {
            tweetId: '1001',
            fullText: 'Hello world from like archive',
            expandedUrl: 'https://x.com/user/status/1001',
          },
        },
      ];

      const items = extractArchiveItems(raw);
      expect(items.length).toBe(1);
      expect(items[0].postId).toBe('1001');
      expect(items[0].text).toBe('Hello world from like archive');
      expect(items[0].postedAt).toBeNull();
      expect(items[0].canonicalUrl).toBe('https://x.com/user/status/1001');
      expect(items[0].externalLinks).toEqual([]);
    });

    it('drops non-numeric ids and does not treat a status URL as an outbound link', () => {
      const items = extractArchiveItems([
        { like: { tweetId: '../3003', fullText: 'bad' } },
        { like: { tweetId: '3003', fullText: 'ok', expandedUrl: 'https://x.com/someone/status/3003' } },
      ]);
      expect(items.map((item) => item.postId)).toEqual(['3003']);
      expect(items[0].externalLinks).toEqual([]);
    });

    it('extracts tweets.js records with entities and created_at', () => {
      const raw = [
        {
          tweet: {
            id_str: '2002',
            full_text: 'Tweet with media and link',
            created_at: 'Sun Oct 18 14:30:00 +0000 2026',
            entities: {
              urls: [{ expanded_url: 'https://github.com/project' }],
              media: [{ media_url_https: 'https://pbs.twimg.com/media/pic.jpg' }],
            },
          },
        },
      ];

      const items = extractArchiveItems(raw);
      expect(items.length).toBe(1);
      expect(items[0].postId).toBe('2002');
      expect(items[0].postedAt).toBeTruthy();
      expect(items[0].externalLinks).toContain('https://github.com/project');
      expect(items[0].mediaUrls).toContain('https://pbs.twimg.com/media/pic.jpg');
    });
  });

  describe('parseArchiveFile & importArchiveItems integration', () => {
    it('parses a large ZIP part without spreading all items into function arguments', async () => {
      const zip = new JSZip();
      zip.file('data/like.js', JSON.stringify(Array.from({ length: 150_000 }, (_, index) => ({
        like: { tweetId: String(1_000_000 + index), fullText: '离线样本' },
      }))));
      const items = await parseArchiveFile(await zip.generateAsync({ type: 'blob' }));
      expect(items).toHaveLength(150_000);
      expect(items.at(-1)).toMatchObject({ postId: '1149999', text: '离线样本' });
    }, 20_000);

    it('rejects a compressed entry whose expanded bytes exceed the part limit', async () => {
      const zip = new JSZip();
      zip.file('data/like.js', new Uint8Array(32 * 1024 * 1024 + 1));
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      expect(blob.size).toBeLessThan(1024 * 1024);
      await expect(parseArchiveFile(blob)).rejects.toThrow('32 MiB');
    }, 20_000);

    it('parses a ZIP archive containing data/like.js and imports into IndexedDB', async () => {
      const zip = new JSZip();
      const likeJsContent = `window.YTD.like.part0 = [
        {
          "like": {
            "tweetId": "3003",
            "fullText": "Archived post 3003",
            "expandedUrl": "https://x.com/someone/status/3003"
          }
        },
        {
          "like": {
            "tweetId": "3004",
            "fullText": "Archived post 3004",
            "expandedUrl": "https://x.com/someone/status/3004"
          }
        }
      ];`;

      zip.file('data/like.js', likeJsContent);
      const zipBlob = await zip.generateAsync({ type: 'blob' });

      const items = await parseArchiveFile(zipBlob);
      expect(items.length).toBe(2);

      const importResult = await importArchiveItems(items);
      expect(importResult.success).toBe(true);
      expect(importResult.stats.added).toBe(2);

      // Verify in IndexedDB
      const postInDb = await db.posts.get('x:3003');
      expect(postInDb).toBeDefined();
      expect(postInDb?.text).toBe('Archived post 3003');
      expect(postInDb?.sourceAdapter).toBe('x_archive');
      expect(postInDb?.likedAt).toBeNull(); // Strictly null per PRD
      expect(postInDb?.externalLinks).toEqual([]);
      const runs = await db.syncRuns.toArray();
      expect(runs.every((run) => run.adapterType === 'x_archive')).toBe(true);

      // Idempotency check: import again, should be skipped
      const secondImport = await importArchiveItems(items);
      expect(secondImport.stats.added).toBe(0);
      expect(secondImport.stats.skipped).toBe(2);
    });

    it('reads every like part and ignores the account tweets file', async () => {
      const zip = new JSZip();
      zip.file(
        'data/like-part0.js',
        'window.YTD.like.part0 = [{ "like": { "tweetId": "11", "fullText": "part zero" } }];'
      );
      zip.file(
        'data/like-part1.js',
        'window.YTD.like.part1 = [{ "like": { "tweetId": "12", "fullText": "part one" } }];'
      );
      zip.file(
        'data/tweets.js',
        'window.YTD.tweets.part0 = [{ "tweet": { "id_str": "99", "full_text": "my own tweet" } }];'
      );
      const blob = await zip.generateAsync({ type: 'blob' });
      const items = await parseArchiveFile(blob);
      expect(items.map((item) => item.postId).sort()).toEqual(['11', '12']);
    });

    it('does not replace a fuller captured post with a shorter archive body', async () => {
      const text = '这是页面上已经采集到的完整正文，比归档里的短句更长。';
      const liveMedia = 'https://pbs.twimg.com/media/live.jpg';
      const contentHash = await calculateContentHash({ text, authorHandle: 'someone', mediaUrls: [liveMedia] });
      await db.posts.put({
        id: 'x:3003',
        platform: 'x',
        postId: '3003',
        canonicalUrl: 'https://x.com/i/web/status/3003',
        author: { handle: 'someone' },
        text,
        postedAt: '2026-10-01T00:00:00.000Z',
        likedAt: null,
        firstObservedAt: '2026-10-02T00:00:00.000Z',
        lastObservedAt: '2026-10-02T00:00:00.000Z',
        captureStatus: 'complete',
        missingFields: [],
        externalLinks: [],
        mediaIds: ['3003_media_0'],
        contentHash,
        sourceAdapter: 'x_dom',
        sourceRunId: 'run_dom',
        schemaVersion: 1,
      });
      await db.media.put({
        id: '3003_media_0',
        postId: 'x:3003',
        position: 0,
        kind: 'image',
        sourceUrl: liveMedia,
        status: 'downloaded',
        blob: new Blob(['live']),
      });
      await db.aiAnalysis.put({
        postId: 'x:3003',
        sourceHash: contentHash,
        model: 'mock',
        promptVersion: 'v',
        status: 'complete',
        categories: ['编程开发'],
        tags: [],
        summaryZh: '旧摘要',
      });

      const zip = new JSZip();
      zip.file(
        'data/like.js',
        'window.YTD.like.part0 = [{ "like": { "tweetId": "3003", "fullText": "短" } }];'
      );
      const items = await parseArchiveFile(await zip.generateAsync({ type: 'blob' }));
      items[0].mediaUrls = ['https://pbs.twimg.com/media/archive-a.jpg', 'https://pbs.twimg.com/media/archive-b.jpg'];
      const result = await importArchiveItems(items);
      expect(result.stats.updated).toBe(1); // Adds provenance without replacing the captured body.
      const saved = await db.posts.get('x:3003');
      expect(saved?.text).toContain('完整正文');
      expect(saved?.sourceRunId).toBe('run_dom');
      expect(saved?.sources).toEqual(['x_archive']);
      expect(saved?.contentHash).toBe(contentHash);
      expect(saved?.mediaIds).toEqual(['3003_media_0']);
      expect((await db.media.where('postId').equals('x:3003').toArray()).map((asset) => asset.sourceUrl))
        .toEqual([liveMedia]);
      expect((await db.aiAnalysis.get('x:3003'))?.status).toBe('complete');
    });

    it('fills a partial post from a longer archive body and marks the old summary stale', async () => {
      await db.posts.put({
        id: 'x:3003',
        platform: 'x',
        postId: '3003',
        canonicalUrl: 'https://x.com/i/web/status/3003',
        text: '只有开头',
        postedAt: null,
        likedAt: null,
        firstObservedAt: '2026-10-02T00:00:00.000Z',
        lastObservedAt: '2026-10-02T00:00:00.000Z',
        captureStatus: 'partial',
        missingFields: ['truncated_text'],
        externalLinks: [],
        mediaIds: [],
        contentHash: 'partial-hash',
        sourceAdapter: 'x_dom',
        sourceRunId: 'run_dom',
        schemaVersion: 1,
      });
      await db.aiAnalysis.put({
        postId: 'x:3003',
        sourceHash: 'partial-hash',
        model: 'mock',
        promptVersion: 'v',
        status: 'complete',
        categories: [],
        tags: [],
      });

      const archive = [
        {
          postId: '3003',
          text: '只有开头，后面还有从官方归档补上的步骤和链接。',
          canonicalUrl: 'https://x.com/i/web/status/3003',
        },
      ];
      await importArchiveItems(archive);
      const saved = await db.posts.get('x:3003');
      expect(saved?.text).toContain('官方归档补上');
      expect(saved?.captureStatus).toBe('complete');
      expect(saved?.sourceRunId).toBe('run_dom');
      expect((await db.aiAnalysis.get('x:3003'))?.status).toBe('stale');
      const [changedRun] = await db.syncRuns.toArray();
      expect(changedRun).toMatchObject({ status: 'completed', changedPostIds: ['x:3003'], stats: { added: 0, updated: 1 } });

      await importArchiveItems(archive);
      const runs = await db.syncRuns.toArray();
      expect(runs).toHaveLength(2);
      expect(runs.find((run) => run.id !== changedRun.id)).toMatchObject({ stats: { skipped: 1 } });
      expect(runs.find((run) => run.id !== changedRun.id)?.changedPostIds).toBeUndefined();
    });

    it('preserves committed counts after interruption and deduplicates a replay', async () => {
      const items = [
        { postId: '5011', text: 'First archive entry' },
        { postId: '5012', text: 'Second archive entry' },
      ];
      let recovery: ReturnType<SyncService['recoverStaleRuns']> | undefined;
      const result = await importArchiveItems(items, {
        onProgress: ({ scanned }) => {
          if (scanned === 1) recovery = new SyncService(db).recoverStaleRuns();
        },
      });
      const [run] = (await recovery) ?? [];
      expect(result.success).toBe(false);
      expect(run).toMatchObject({ status: 'partial', failureCode: 'interrupted', stats: { scanned: 1, added: 1 } });
      expect(await db.syncRuns.get(run.id)).toMatchObject({ status: 'partial', stats: { scanned: 1, added: 1 } });
      expect(await db.posts.get('x:5012')).toBeUndefined();
      expect((await importArchiveItems(items)).stats).toMatchObject({ scanned: 2, added: 1, skipped: 1 });
    });

    it('distinguishes a partial import from a batch in which every item fails', async () => {
      const invalid = { postId: 'invalid', text: 'Invalid archive entry' };
      const partial = await importArchiveItems([{ postId: '5013', text: 'Valid archive entry' }, invalid]);
      expect(partial).toMatchObject({ success: true, status: 'partial', stats: { added: 1, failed: 1 } });
      expect(partial.message).toContain('部分完成');
      const failed = await importArchiveItems([invalid]);
      expect(failed).toMatchObject({ success: false, status: 'failed', stats: { added: 0, failed: 1 } });
      expect(await db.syncRuns.where('status').equals('failed').first()).toMatchObject({
        failureCode: 'import_failed', failureMessage: '1 篇归档条目无法保存。',
      });
    });

    it('marks an already aborted import as cancelled', async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await importArchiveItems(
        [{ postId: '4004', text: '这条不应在取消后被当成完整成功。' }],
        { signal: controller.signal }
      );
      expect(result.success).toBe(false);
      expect(result.stats.added).toBe(0);
      const run = await db.syncRuns.orderBy('startedAt').reverse().first();
      expect(run?.status).toBe('cancelled');
      expect(run?.adapterType).toBe('x_archive');
    });

    it('stops at the committed checkpoint when cancelled after the first entry', async () => {
      const controller = new AbortController();
      const result = await importArchiveItems([
        { postId: '6001', text: 'Committed entry' },
        { postId: '6002', text: 'Entry after cancellation' },
      ], {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      });
      expect(result).toMatchObject({ status: 'cancelled', stats: { scanned: 1, added: 1, failed: 0 } });
      expect(await db.posts.toCollection().primaryKeys()).toEqual(['x:6001']);
      expect(await db.syncRuns.where('status').equals('cancelled').first()).toMatchObject({
        failureCode: 'cancelled', stats: { scanned: 1, added: 1 },
      });
    });
  });
});
