// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { LikeMindDB } from '../src/storage/db';
import { mergeNormalizedPost, mergeMediaAssets } from '../src/domain/merge';
import { SyncService } from '../src/sync/syncService';
import { FixtureCaptureAdapter, generateMockPosts } from '../src/adapters/fixtureAdapter';
import type { NormalizedPost, MediaAsset } from '../src/domain/types';

describe('Deduplication, Merging & Idempotency', () => {
  let testDb: LikeMindDB;
  let syncService: SyncService;

  beforeEach(async () => {
    testDb = new LikeMindDB(`test_db_${Date.now()}_${Math.random()}`);
    syncService = new SyncService(testDb);
  });

  describe('mergeNormalizedPost unit logic', () => {
    const existingPost: NormalizedPost = {
      id: 'x:1850000000000000001',
      platform: 'x',
      postId: '1850000000000000001',
      canonicalUrl: 'https://x.com/user/status/1850000000000000001',
      author: { handle: 'alice', displayName: 'Alice' },
      text: '这是完整的原始推文正文。包含很多重要信息。',
      postedAt: '2026-10-01T12:00:00.000Z',
      likedAt: null,
      firstObservedAt: '2026-10-01T14:00:00.000Z',
      lastObservedAt: '2026-10-01T14:00:00.000Z',
      captureStatus: 'complete',
      missingFields: [],
      externalLinks: ['https://example.com/a'],
      mediaIds: ['media_1'],
      contentHash: 'hash_123',
      sourceAdapter: 'fixture',
      sourceRunId: 'run_1',
      schemaVersion: 1,
    };

    it('preserves complete text and status when incoming is partial', () => {
      const incomingPost: NormalizedPost = {
        ...existingPost,
        text: '截断的...',
        captureStatus: 'partial',
        lastObservedAt: '2026-10-02T10:00:00.000Z',
        sourceRunId: 'run_2',
      };

      const { merged } = mergeNormalizedPost(existingPost, incomingPost);
      expect(merged.text).toBe(existingPost.text);
      expect(merged.captureStatus).toBe('complete');
      expect(merged.sourceRunId).toBe(existingPost.sourceRunId);
      expect(merged.firstObservedAt).toBe(existingPost.firstObservedAt);
      expect(merged.lastObservedAt).toBe('2026-10-02T10:00:00.000Z');
      expect(merged.likedAt).toBeNull();
    });

    it('upgrades partial post to complete when incoming has complete text', () => {
      const partialExisting: NormalizedPost = {
        ...existingPost,
        text: '推文开头...',
        captureStatus: 'partial',
      };

      const completeIncoming: NormalizedPost = {
        ...existingPost,
        text: '这是完整的推文正文全部内容。',
        captureStatus: 'complete',
        contentHash: 'hash_new',
      };

      const { merged, isUpdated } = mergeNormalizedPost(partialExisting, completeIncoming);
      expect(isUpdated).toBe(true);
      expect(merged.text).toBe('这是完整的推文正文全部内容。');
      expect(merged.captureStatus).toBe('complete');
    });

    it('keeps known thread gaps on recapture without accepting truncated text', () => {
      const thread = { ...existingPost, captureStatus: 'partial' as const, missingFields: ['thread_continuation'],
        references: [{ kind: 'thread' as const, id: existingPost.postId, url: existingPost.canonicalUrl }] };
      const first = mergeNormalizedPost(existingPost, thread).merged;
      expect(first.captureStatus).toBe('partial');
      const recapture = mergeNormalizedPost(first, existingPost);
      expect(recapture.merged.missingFields).toContain('thread_continuation');
      expect(recapture.isUpdated).toBe(false);
      expect(mergeNormalizedPost(first, {
        ...existingPost, captureStatus: 'partial', missingFields: ['truncated_text'],
        text: existingPost.text.repeat(2),
      }).merged.text).toBe(existingPost.text);
    });

    it('clears recovered metadata independently while retaining truncation on rejected text', () => {
      const partial = {
        ...existingPost, postedAt: null, captureStatus: 'partial' as const,
        missingFields: ['truncated_text', 'postedAt'],
      };
      const incoming = { ...existingPost, text: '短正文', missingFields: ['authorHandle'] };
      const { merged } = mergeNormalizedPost(partial, incoming);
      expect(merged.text).toBe(partial.text);
      expect(merged.postedAt).toBe(incoming.postedAt);
      expect(merged.missingFields).toEqual(['truncated_text']);
      expect(merged.captureStatus).toBe('partial');
      expect(mergeNormalizedPost(merged, existingPost).merged.missingFields).toEqual([]);
    });

    it('retains missing quote and media when an equally worded snapshot omits them', () => {
      const quote = { kind: 'quote' as const, id: '42', url: 'https://x.com/user/status/42' };
      const partial = { ...existingPost, captureStatus: 'partial' as const, references: [quote],
        missingFields: ['quoted_post_body', 'media'] };
      const sparse = { ...existingPost, mediaIds: [] };
      const { merged, isUpdated } = mergeNormalizedPost(partial, sparse);
      expect(merged.captureStatus).toBe('partial');
      expect(merged.missingFields).toEqual(['quoted_post_body', 'media']);
      expect(merged.references).toEqual([quote]);
      expect(merged.mediaIds).toEqual(existingPost.mediaIds);
      expect(isUpdated).toBe(false);

      const recovered = mergeNormalizedPost(merged, { ...existingPost, references: [quote] });
      expect(recovered.merged.captureStatus).toBe('complete');
      expect(recovered.merged.missingFields).toEqual([]);
    });

    it('accepts a later edit when both captures are complete', () => {
      const incomingPost: NormalizedPost = {
        ...existingPost,
        text: '作者后来改短了。',
        contentHash: 'hash_edited',
        lastObservedAt: '2026-10-03T10:00:00.000Z',
        sourceRunId: 'run_edit',
      };

      const { merged, isUpdated } = mergeNormalizedPost(existingPost, incomingPost);
      expect(isUpdated).toBe(true);
      expect(merged.text).toBe('作者后来改短了。');
      expect(merged.contentHash).toBe('hash_edited');
      expect(merged.firstObservedAt).toBe(existingPost.firstObservedAt);
      expect(merged.likedAt).toBeNull();
      expect(merged.sourceRunId).toBe('run_1');
    });

    it('drops unsafe incoming links while unioning the safe ones', () => {
      const incomingPost: NormalizedPost = {
        ...existingPost,
        externalLinks: ['javascript:alert(1)', 'https://example.com/b'],
      };

      const { merged } = mergeNormalizedPost(existingPost, incomingPost);
      expect(merged.externalLinks).toEqual(['https://example.com/a', 'https://example.com/b']);
    });

    it('keeps a complete body when a shorter archive must not replace it', () => {
      const incomingPost: NormalizedPost = {
        ...existingPost,
        text: '短',
        contentHash: 'hash_short',
      };

      const { merged, isUpdated } = mergeNormalizedPost(existingPost, incomingPost, {
        replaceCompleteEdits: false,
      });
      expect(isUpdated).toBe(false);
      expect(merged.text).toBe(existingPost.text);
      expect(merged.contentHash).toBe(existingPost.contentHash);
    });

    it('accepts a longer complete body from an archive', () => {
      const incomingPost: NormalizedPost = {
        ...existingPost,
        text: `${existingPost.text}\n补充的后半段。`,
        contentHash: 'hash_longer',
      };

      const { merged, isUpdated } = mergeNormalizedPost(existingPost, incomingPost, {
        replaceCompleteEdits: false,
      });
      expect(isUpdated).toBe(true);
      expect(merged.text).toContain('补充的后半段');
      expect(merged.contentHash).toBe('hash_longer');
    });

    it('drops the post permalink from the outbound link list', () => {
      const incomingPost: NormalizedPost = {
        ...existingPost,
        externalLinks: [existingPost.canonicalUrl, 'https://example.com/c'],
      };

      const { merged } = mergeNormalizedPost(existingPost, incomingPost);
      expect(merged.externalLinks).not.toContain(existingPost.canonicalUrl);
      expect(merged.externalLinks).toContain('https://example.com/a');
      expect(merged.externalLinks).toContain('https://example.com/c');
    });

    it('unions external links and media ids without duplicates', () => {
      const incomingPost: NormalizedPost = {
        ...existingPost,
        externalLinks: ['https://example.com/a', 'https://example.com/b'],
        mediaIds: ['media_1', 'media_2'],
      };

      const { merged } = mergeNormalizedPost(existingPost, incomingPost);
      expect(merged.externalLinks).toEqual(['https://example.com/a', 'https://example.com/b']);
      expect(merged.mediaIds).toEqual(['media_1', 'media_2']);
    });
  });

  describe('mergeMediaAssets logic', () => {
    it('does not re-download already downloaded media', () => {
      const existingMedia: MediaAsset = {
        id: 'post1_media_0',
        postId: 'x:post1',
        position: 0,
        kind: 'image',
        sourceUrl: 'https://example.com/pic.jpg',
        status: 'downloaded',
        blob: new Blob(['image data']),
      };

      const incomingMedia: MediaAsset = {
        id: 'post1_media_0',
        postId: 'x:post1',
        position: 0,
        kind: 'image',
        sourceUrl: 'https://example.com/pic.jpg',
        status: 'pending',
      };

      const { toInsert, toUpdate, unchanged } = mergeMediaAssets([existingMedia], [incomingMedia]);
      expect(toInsert).toHaveLength(0);
      expect(toUpdate).toHaveLength(0);
      expect(unchanged).toHaveLength(1);
      expect(unchanged[0].status).toBe('downloaded');
    });
  });

  describe('End-to-End Idempotency & Soft Retention in Database', () => {
    it('replays the same 100 posts without duplicating records or downloaded media', async () => {
      const adapter = new FixtureCaptureAdapter(generateMockPosts(100));

      // First run
      const run1 = await syncService.runSync({
        adapter,
        targetLimit: 100,
        downloadMedia: true,
      });

      const initialCount = await testDb.posts.count();
      expect(initialCount).toBe(run1.stats.added);
      expect(run1.stats.added).toBe(100);
      const savedMedia = await testDb.media.toArray();
      expect(savedMedia.length).toBeGreaterThan(0);
      expect(savedMedia.every((item) => item.status === 'downloaded' && Boolean(item.blob?.size))).toBe(true);

      // Second run with same fixture
      const run2 = await syncService.runSync({
        adapter,
        targetLimit: 100,
        downloadMedia: true,
      });

      const secondCount = await testDb.posts.count();
      expect(secondCount).toBe(initialCount); // Did not double!
      expect(run2.stats.added).toBe(0);
      expect(run2.stats.skipped + run2.stats.updated).toBe(initialCount);
      const repeatedMedia = await testDb.media.toArray();
      expect(repeatedMedia.map(({ id, sourceUrl, status, blob }) => [id, sourceUrl, status, blob?.size]))
        .toEqual(savedMedia.map(({ id, sourceUrl, status, blob }) => [id, sourceUrl, status, blob?.size]));
      const imageBytes = (rows: MediaAsset[]) => Promise.all(rows.map(async ({ blob }) => new Uint8Array(await blob!.arrayBuffer())));
      expect(await imageBytes(repeatedMedia)).toEqual(await imageBytes(savedMedia));
    });

    it('captures old post newly liked without dropping it', async () => {
      const adapter = new FixtureCaptureAdapter();
      await syncService.runSync({ adapter, targetLimit: 10, downloadMedia: false });

      // Check the 2023 post (post_1658000000000000005)
      const oldPost = await testDb.posts.get('x:1658000000000000005');
      expect(oldPost).toBeDefined();
      expect(oldPost?.postedAt).toContain('2023-05-15');
      expect(oldPost?.likedAt).toBeNull(); // Strictly null
      expect(oldPost?.firstObservedAt).toBeDefined();
      // firstObservedAt is in 2026 (now)
      expect(new Date(oldPost!.firstObservedAt).getFullYear()).toBeGreaterThanOrEqual(2026);
    });

    it('performs soft retention: does not delete older stored posts absent in new batch', async () => {
      // Step 1: Ingest batch with 2 posts
      const adapter1 = new FixtureCaptureAdapter([
        {
          postId: 'post_AAA',
          text: 'First batch post A',
          postedAt: '2026-10-01T00:00:00Z',
        },
      ]);
      await syncService.runSync({ adapter: adapter1, targetLimit: 10 });
      expect(await testDb.posts.count()).toBe(1);

      // Step 2: Ingest batch with completely different post
      const adapter2 = new FixtureCaptureAdapter([
        {
          postId: 'post_BBB',
          text: 'Second batch post B',
          postedAt: '2026-10-02T00:00:00Z',
        },
      ]);
      await syncService.runSync({ adapter: adapter2, targetLimit: 10 });

      // Both post_AAA and post_BBB must be preserved
      expect(await testDb.posts.count()).toBe(2);
      expect(await testDb.posts.get('x:post_AAA')).toBeDefined();
      expect(await testDb.posts.get('x:post_BBB')).toBeDefined();
    });

    it('keeps the first source run id so a later sync does not rewrite the digest batch', async () => {
      const adapter = new FixtureCaptureAdapter();
      const run1 = await syncService.runSync({ adapter, targetLimit: 10, downloadMedia: false });
      const run2 = await syncService.runSync({ adapter, targetLimit: 10, downloadMedia: false });
      const stored = await testDb.posts.get('x:1851234567890123001');
      expect(stored?.sourceRunId).toBe(run1.id);
      expect(stored?.sourceRunId).not.toBe(run2.id);

      const security = await testDb.posts.get('x:1851234567890123006');
      expect(security?.externalLinks).toEqual(['https://safe-security.org/audit']);
      expect(security?.externalLinks.join(' ')).not.toContain('javascript:');
    });
  });
});
