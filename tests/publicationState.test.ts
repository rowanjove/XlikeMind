import { beforeEach, describe, expect, it } from 'vitest';
import { getProfileDatabase } from '../src/storage/db';
import { getPublicationState, publicationSignature } from '../src/export/publicationState';
import type { AIAnalysis, MediaAsset, NormalizedPost } from '../src/domain/types';

const profile = 'publication-state-test';
const db = getProfileDatabase(profile);
const folderId = `knowledge-library:${profile}`;
const post: NormalizedPost = { id: 'x:1', platform: 'x', postId: '1', canonicalUrl: 'https://x.com/fixture/status/1',
  text: '原文', postedAt: null, likedAt: null, firstObservedAt: '2026-11-07T00:00:00Z', lastObservedAt: '2026-11-07T00:00:00Z',
  captureStatus: 'complete', missingFields: [], externalLinks: [], mediaIds: [], contentHash: 'fixture',
  sourceAdapter: 'fixture', sourceRunId: 'same-run', schemaVersion: 1 };
const base = { posts: [post], media: [] as MediaAsset[], overrides: [], analysis: [] as AIAnalysis[], runs: [] };

beforeEach(async () => {
  await Promise.all(db.tables.map(table => table.clear()));
  await db.posts.put(post);
  await db.folders.put({ id: folderId, handle: {} as FileSystemDirectoryHandle, latestSnapshot: 'snapshot',
    publishedRunId: 'same-run', publishedSignature: await publicationSignature(base) });
});

describe('publication state', () => {
  it('detects manual edits without changing the published sync run', async () => {
    expect(await getPublicationState(profile)).toBe('current');
    await db.userOverrides.put({ postId: post.id, customTitle: '手工修改', notes: '笔记', updatedAt: new Date().toISOString() });
    expect(await getPublicationState(profile)).toBe('changed');
    expect((await db.folders.get(folderId))?.publishedRunId).toBe('same-run');
  });

  it('detects AI results, media recovery and deletion', async () => {
    await db.aiAnalysis.put({ postId: post.id, status: 'failed', failureReason: 'fixture' } as AIAnalysis);
    expect(await getPublicationState(profile)).toBe('changed');
    await db.aiAnalysis.clear();
    expect(await getPublicationState(profile)).toBe('current');
    await db.media.put({ id: 'image', postId: post.id, position: 0, kind: 'image', sourceUrl: 'https://pbs.twimg.com/a.png', status: 'downloaded' });
    expect(await getPublicationState(profile)).toBe('changed');
    await db.media.clear();
    await db.posts.delete(post.id);
    expect(await getPublicationState(profile)).toBe('changed');
  });

  it('distinguishes unknown legacy versions, never published folders, and unbound profiles', async () => {
    await db.folders.update(folderId, { publishedSignature: undefined });
    expect(await getPublicationState(profile)).toBe('unknown');
    await db.folders.update(folderId, { latestSnapshot: undefined });
    expect(await getPublicationState(profile)).toBe('unpublished');
    await db.folders.delete(folderId);
    expect(await getPublicationState(profile)).toBe('unbound');
    expect(await getPublicationState('different-unbound-profile')).toBe('unbound');
  });

  it('keeps the published baseline unchanged when later edits occur', async () => {
    const before = (await db.folders.get(folderId))!.publishedSignature;
    await db.posts.update(post.id, { text: '发布期间的新正文' });
    expect(await getPublicationState(profile)).toBe('changed');
    expect((await db.folders.get(folderId))!.publishedSignature).toBe(before);
  });
});
