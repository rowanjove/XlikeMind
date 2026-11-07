import { describe, it, expect, beforeEach } from 'vitest';
import { LikeMindDB } from '../src/storage/db';
import { generateMockPosts } from '../src/adapters/fixtureAdapter';
import { SyncService } from '../src/sync/syncService';
import { FixtureCaptureAdapter } from '../src/adapters/fixtureAdapter';
import { buildTopicSummaries } from '../src/domain/topics';
import { buildExportZip } from '../src/export/zip';
import { planExportBatches } from '../src/export/batches';
import type { NormalizedPost, UserOverrides, AIAnalysis, MediaAsset } from '../src/domain/types';
import JSZip from 'jszip';

describe('1000 Items Scale & Performance Stress Testing (M3)', { timeout: 30000 }, () => {
  let testDb: LikeMindDB;
  let syncService: SyncService;

  beforeEach(() => {
    testDb = new LikeMindDB(`stress_db_${Date.now()}_${Math.random()}`);
    syncService = new SyncService(testDb);
  });

  it('ingests 1000 posts into IndexedDB efficiently', async () => {
    const raw1000 = generateMockPosts(1000);
    const adapter = new FixtureCaptureAdapter(raw1000);

    const startTime = Date.now();
    const run = await syncService.runSync({
      adapter,
      targetLimit: 1000,
      downloadMedia: false, // In stress test we test 1000 posts text & structure
    });
    const durationMs = Date.now() - startTime;

    expect(run.status).toBe('completed');
    expect(run.stats.added).toBe(1000);

    const countInDb = await testDb.posts.count();
    expect(countInDb).toBe(1000);

    // 1000 items inserted with checkpoints
    expect(durationMs).toBeLessThan(15000);
  });

  it('performs keyword search and status filtering over 1000 posts in < 100ms', async () => {
    const raw1000 = generateMockPosts(1000);
    const adapter = new FixtureCaptureAdapter(raw1000);
    await syncService.runSync({ adapter, targetLimit: 1000, downloadMedia: false });

    const allPosts = await testDb.posts.toArray();
    expect(allPosts.length).toBe(1000);

    const searchStart = performance.now();
    const query = 'AI';
    const matches = allPosts.filter(
      (p) =>
        p.text.toLowerCase().includes(query.toLowerCase()) ||
        p.author?.displayName?.toLowerCase().includes(query.toLowerCase())
    );
    const searchDurationMs = performance.now() - searchStart;

    expect(matches.length).toBeGreaterThan(0);
    expect(searchDurationMs).toBeLessThan(100); // Super fast in-memory filter!
  });

  it('aggregates topics across 1000 posts in < 50ms', () => {
    const raw1000 = generateMockPosts(1000);
    const mockPosts: NormalizedPost[] = raw1000.map((r, i) => ({
      id: `x:${r.postId}`,
      platform: 'x',
      postId: r.postId,
      canonicalUrl: r.url || `https://x.com/status/${r.postId}`,
      author: { handle: r.authorHandle, displayName: r.authorDisplayName },
      text: r.text,
      postedAt: r.postedAt || null,
      likedAt: null,
      firstObservedAt: '2026-10-31T00:00:00Z',
      lastObservedAt: '2026-10-31T00:00:00Z',
      captureStatus: 'complete',
      missingFields: [],
      externalLinks: r.externalLinks || [],
      mediaIds: [],
      contentHash: `hash_${i}`,
      sourceAdapter: 'fixture',
      sourceRunId: 'run_stress',
      schemaVersion: 1,
    }));

    const overridesMap = new Map<string, UserOverrides>();
    const aiMap = new Map<string, AIAnalysis>();

    const start = performance.now();
    const summaries = buildTopicSummaries(mockPosts, overridesMap, aiMap);
    const duration = performance.now() - start;

    expect(summaries.length).toBeGreaterThan(0);
    expect(duration).toBeLessThan(50);
  });

  it('exports 1000 posts and their media across production-sized ZIP parts in memory', async () => {
    const mockPosts: NormalizedPost[] = generateMockPosts(1000).map((r, i) => ({
      id: `x:${r.postId}`,
      platform: 'x',
      postId: r.postId,
      canonicalUrl: r.url || `https://x.com/status/${r.postId}`,
      author: { handle: r.authorHandle, displayName: r.authorDisplayName },
      text: r.text,
      postedAt: r.postedAt || null,
      likedAt: null,
      firstObservedAt: '2026-10-31T00:00:00Z',
      lastObservedAt: '2026-10-31T00:00:00Z',
      captureStatus: 'complete',
      missingFields: [],
      externalLinks: r.externalLinks || [],
      mediaIds: [`${r.postId}_media_0`],
      contentHash: `hash_${i}`,
      sourceAdapter: 'fixture',
      sourceRunId: 'run_zip_parts',
      schemaVersion: 1,
    }));

    const batches = planExportBatches(mockPosts);
    expect(batches.map((batch) => batch.length)).toEqual([200, 200, 200, 200, 200]);
    const seen = new Set<string>();
    for (const batch of batches) {
      const mediaMap = new Map<string, MediaAsset[]>(batch.map((post) => [post.id, [{
        id: post.mediaIds[0], postId: post.id, position: 0, kind: 'image', mime: 'image/png',
        sourceUrl: `https://pbs.twimg.com/media/${post.postId}.png`, status: 'downloaded',
        blob: new Blob([post.postId], { type: 'image/png' }),
      }]]));
      const { blob, manifest } = await buildExportZip({ posts: batch, mediaMap });
      expect(manifest).toMatchObject({ postCount: batch.length, assetsCount: batch.length, status: 'complete' });
      const zip = await JSZip.loadAsync(blob, { checkCRC32: true });
      const postsInZip = zip.file(/^posts\/.*\.md$/);
      expect(postsInZip).toHaveLength(batch.length);
      expect(zip.file(/^assets\//)).toHaveLength(batch.length);
      const markdownById = new Map(postsInZip.map((file) => [file.name.split('/').at(-1), file]));
      for (const post of batch) {
        expect(seen.has(post.id)).toBe(false);
        seen.add(post.id);
        const assetPath = `assets/${post.postId}/01.png`;
        expect(await markdownById.get(`${post.postId}.md`)?.async('string')).toContain(`../../../${assetPath}`);
        expect(await zip.file(assetPath)?.async('string')).toBe(post.postId);
      }
    }
    expect(seen.size).toBe(mockPosts.length);
  });
});
