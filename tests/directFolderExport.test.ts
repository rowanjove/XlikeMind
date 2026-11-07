import { describe, it, expect, vi } from 'vitest';
import Dexie from 'dexie';
import { Blob as NodeBlob } from 'node:buffer';
import { db, LikeMindDB } from '../src/storage/db';
import { publishLibrarySnapshot, readSnapshotHistory } from '../src/export/libraryFolder';
import { compareWithSnapshot } from '../src/export/snapshotComparison';
import {
  exportToDirectoryHandle,
  isFileSystemAccessSupported,
  getOrCreateDirectoryHandle,
  writeFileToDirectory,
} from '../src/export/directFolderExport';
import type { NormalizedPost, MediaAsset, ExportManifest } from '../src/domain/types';

class MockFileHandle {
  readonly kind = 'file';
  constructor(public name: string, public writtenData: { content?: string | Blob } = {}) {}

  async getFile() {
    return { text: async () => String(this.writtenData.content ?? '') };
  }

  async createWritable() {
    return {
      write: async (data: string | Blob) => {
        this.writtenData.content = data;
      },
      close: async () => {},
      abort: async () => {},
    };
  }
}

class MockDirectoryHandle {
  readonly kind = 'directory';
  public files = new Map<string, MockFileHandle>();
  public directories = new Map<string, MockDirectoryHandle>();

  constructor(public name: string = 'root') {}

  async *values() {
    yield* this.directories.values();
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let dir = this.directories.get(name);
    if (!dir && options?.create) {
      dir = new MockDirectoryHandle(name);
      this.directories.set(name, dir);
    }
    if (!dir) throw new Error(`Directory not found: ${name}`);
    return dir as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    let file = this.files.get(name);
    if (!file && options?.create) {
      file = new MockFileHandle(name);
      this.files.set(name, file);
    }
    if (!file) throw new Error(`File not found: ${name}`);
    return file as unknown as FileSystemFileHandle;
  }
}

const asDirectory = (dir: MockDirectoryHandle) => dir as unknown as FileSystemDirectoryHandle;

describe('Direct Folder Export (File System Access)', () => {
  it('compares stable post ids and media completeness across snapshots of the same profile', async () => {
    const root = new MockDirectoryHandle('snapshots');
    const previous = { name: 'old', exportedAt: '2026-11-01T00:00:00Z', postCount: 3 };
    const folder = await root.getDirectoryHandle(previous.name, { create: true });
    const manifest: ExportManifest = {
      manifestVersion: '1.0', appName: 'LikeMind', appVersion: '0.1.0',
      exportedAt: previous.exportedAt, postCount: 3, assetsCount: 0, status: 'partial', failuresCount: 2,
      failures: [{ postId: 'x:1', reason: 'Media old: pending' }, { postId: 'x:2', reason: 'Post capture: partial' }],
    };
    await writeFileToDirectory(folder, 'manifest.json', JSON.stringify(manifest));
    await writeFileToDirectory(folder, 'catalog.json', JSON.stringify({
      schemaVersion: 1, profileId: 'default', posts: [{ id: 'x:1' }, { id: 'x:2' }, { id: 'x:removed' }],
    }));
    const current = { ...manifest, failures: [
      { postId: 'x:2', reason: 'Media new: failed' }, { postId: 'x:3', reason: 'Media new: pending' },
    ] };
    const ids = ['x:1', 'x:2', 'x:3'];
    await expect(compareWithSnapshot(asDirectory(root), previous, 'default', ids, current)).resolves.toMatchObject({
      added: ['x:3'], resolved: ['x:1'], newlyMissing: ['x:2'], previousMissing: 1, currentMissing: 2,
    });
    await expect(compareWithSnapshot(asDirectory(root), previous, 'different', ids, current)).resolves.toBeUndefined();
  });

  it('lists completed older snapshots and omits the current and incomplete folders', async () => {
    const folder = new MockDirectoryHandle('snapshots');
    const name = (day: string) => `LikeMind-2026-11-${day}T00-00-00-000Z-00000000-0000-4000-8000-000000000000`;
    for (const day of ['01', '02', '03', '04']) {
      const snapshot = await folder.getDirectoryHandle(name(day), { create: true });
      if (day !== '03') await writeFileToDirectory(snapshot, 'index.html', '<p>Snapshot</p>');
      await writeFileToDirectory(snapshot, 'manifest.json', JSON.stringify({
        appName: 'LikeMind', manifestVersion: '1.0', exportedAt: `2026-11-${day}T00:00:00.000Z`, postCount: Number(day),
      }));
    }
    expect(await readSnapshotHistory(asDirectory(folder), name('04'))).toEqual([
      { name: name('02'), exportedAt: '2026-11-02T00:00:00.000Z', postCount: 2 },
      { name: name('01'), exportedAt: '2026-11-01T00:00:00.000Z', postCount: 1 },
    ]);
  });
  it('detects file system access support safely', () => {
    // In node/jsdom it returns false safely
    expect(typeof isFileSystemAccessSupported()).toBe('boolean');
  });

  it('creates nested directories and writes content directly', async () => {
    const root = new MockDirectoryHandle('vault');
    const nested = await getOrCreateDirectoryHandle(root as unknown as FileSystemDirectoryHandle, ['posts', '2026', '10']);
    expect(nested).toBeDefined();

    await writeFileToDirectory(nested, 'test.md', '# Hello World');
    const postsDir = root.directories.get('posts')!;
    const yearDir = postsDir.directories.get('2026')!;
    const monthDir = yearDir.directories.get('10')!;
    const file = monthDir.files.get('test.md')!;

    expect(file).toBeDefined();
    expect(file.writtenData.content).toBe('# Hello World');
  });

  it('exports complete knowledge base into mock directory handle', async () => {
    const samplePost: NormalizedPost = {
      id: 'x:998877',
      platform: 'x',
      postId: '998877',
      canonicalUrl: 'https://x.com/user/status/998877',
      author: { handle: 'antigravity_dev', displayName: 'Developer' },
      text: 'Direct folder export tutorial.',
      postedAt: '2026-10-18T12:00:00.000Z',
      likedAt: null,
      firstObservedAt: '2026-10-31T00:00:00.000Z',
      lastObservedAt: '2026-10-31T00:00:00.000Z',
      captureStatus: 'complete',
      missingFields: [],
      externalLinks: ['https://example.com'],
      mediaIds: ['998877_media_0'],
      contentHash: 'hash_test',
      sourceAdapter: 'fixture',
      sourceRunId: 'run_1',
      schemaVersion: 1,
    };

    const sampleMedia: MediaAsset = {
      id: '998877_media_0',
      postId: samplePost.id,
      position: 0,
      kind: 'image',
      sourceUrl: 'https://pbs.twimg.com/media/test.png',
      status: 'downloaded',
      mime: 'image/png',
      blob: new Blob(['test-png-bytes'], { type: 'image/png' }),
    };

    const mediaMap = new Map([[samplePost.id, [sampleMedia]]]);
    const root = new MockDirectoryHandle('obsidian_vault');

    const result = await exportToDirectoryHandle(root as unknown as FileSystemDirectoryHandle, {
      posts: [samplePost],
      mediaMap,
      includeCatalog: true,
      overridesMap: new Map([[samplePost.id, {
        postId: samplePost.id,
        updatedAt: samplePost.firstObservedAt,
        customCategories: ['A/B', 'A:B'],
        readingStatus: 'to_read',
      }]]),
    });

    expect(result.success).toBe(true);
    expect(result.writtenFilesCount).toBeGreaterThan(0);
    expect(root.files.get('index.html')?.writtenData.content).toContain('src="assets/998877/01.png"');
    expect(JSON.parse(String(root.files.get('catalog.json')?.writtenData.content))).toMatchObject({
      schemaVersion: 1,
      posts: [{ id: samplePost.id, markdownPath: 'posts/2026/10/998877.md', media: [{ path: 'assets/998877/01.png' }] }],
    });
    expect([...root.directories.get('topics')!.files.keys()].sort()).toEqual(['A_B-2.md', 'A_B.md']);

    // Verify manifest.json written at root
    const manifestFile = root.files.get('manifest.json');
    expect(manifestFile).toBeDefined();
    expect(manifestFile?.writtenData.content).toContain('"appName": "LikeMind"');

    // Verify post Markdown written at posts/2026/10/998877.md
    const postsDir = root.directories.get('posts')!;
    const yearDir = postsDir.directories.get('2026')!;
    const monthDir = yearDir.directories.get('10')!;
    const mdFile = monthDir.files.get('998877.md');
    expect(mdFile).toBeDefined();
    expect(mdFile?.writtenData.content).toContain('Direct folder export tutorial.');
    expect(mdFile?.writtenData.content).toContain('../../../assets/998877/01.png');

    // Verify asset written at assets/998877/01.png
    const assetsDir = root.directories.get('assets')!;
    const postAssetDir = assetsDir.directories.get('998877')!;
    const imgFile = postAssetDir.files.get('01.png');
    expect(imgFile).toBeDefined();
  });

  it('preserves existing data when upgrading the database to store directory handles', async () => {
    const old = new Dexie('directory-migration-test');
    old.version(1).stores({
      posts: 'id, postId, postedAt, firstObservedAt, lastObservedAt, captureStatus, sourceRunId, contentHash',
      media: 'id, postId, position, status, kind',
      syncRuns: 'id, startedAt, lastCheckpointAt, status',
      userOverrides: 'postId, updatedAt, readingStatus',
      aiAnalysis: 'postId, sourceHash, status, model',
    });
    const timestamp = '2026-10-31T00:00:00Z';
    const post = { id: 'x:991', postId: '991', text: 'Existing note', contentHash: 'original' };
    const media = {
      id: '991_media_0', postId: post.id, position: 0, kind: 'image',
      status: 'downloaded', blob: new NodeBlob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    };
    const run = {
      id: 'existing-run', startedAt: timestamp, lastCheckpointAt: timestamp, status: 'paused',
      cursor: 'existing-checkpoint', stats: { scanned: 1, added: 1, updated: 0, skipped: 0, failed: 0 },
    };
    const overrides = { postId: post.id, customTitle: 'My title', customTags: ['manual'], updatedAt: timestamp };
    const analysis = { postId: post.id, sourceHash: post.contentHash, status: 'complete', model: 'fixture', summaryZh: '已有摘要' };

    const upgraded = new LikeMindDB(old.name);
    try {
      await old.transaction('rw', old.tables, async () => {
        await old.table('posts').add(post);
        await old.table('media').add(media);
        await old.table('syncRuns').add(run);
        await old.table('userOverrides').add(overrides);
        await old.table('aiAnalysis').add(analysis);
      });
      old.close();

      for (let open = 0; open < 2; open++) {
        await upgraded.open();
        expect(upgraded.verno).toBe(3);
        expect(await upgraded.posts.toArray()).toEqual([post]);
        expect(await upgraded.syncRuns.toArray()).toEqual([run]);
        expect(await upgraded.userOverrides.toArray()).toEqual([overrides]);
        expect(await upgraded.aiAnalysis.toArray()).toEqual([analysis]);
        const [savedImage] = await upgraded.media.toArray();
        expect(savedImage).toEqual({ ...media, blob: expect.any(NodeBlob) });
        expect(savedImage.blob?.type).toBe('image/png');
        expect(new Uint8Array(await savedImage.blob!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        expect(await upgraded.folders.count()).toBe(0);
        expect(await upgraded.exportJobs.count()).toBe(0);
        upgraded.close();
      }
    } finally {
      old.close();
      await upgraded.delete();
    }
  });

  it('does not create a snapshot with denied permission or an empty selection', async () => {
    const root = Object.assign(new MockDirectoryHandle(), {
      requestPermission: vi.fn().mockResolvedValueOnce('denied').mockResolvedValueOnce('granted'),
    });
    const onProgress = vi.fn();
    await expect(publishLibrarySnapshot(asDirectory(root), undefined, onProgress)).rejects.toThrow('需要目录写入权限');
    await expect(publishLibrarySnapshot(asDirectory(root), [], onProgress)).rejects.toThrow('没有可导出的帖子');
    expect(root.directories.size).toBe(0);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('leaves the completion manifest unwritten after a failed file write', async () => {
    const root = Object.assign(new MockDirectoryHandle(), {
      requestPermission: vi.fn().mockResolvedValue('granted'),
    });
    const post = {
      id: 'x:992', postId: '992', platform: 'x', canonicalUrl: 'https://x.com/i/status/992',
      text: 'Fixture', postedAt: null, likedAt: null, firstObservedAt: '2026-10-31T00:00:00Z',
      lastObservedAt: '2026-10-31T00:00:00Z', captureStatus: 'complete', missingFields: [],
      externalLinks: [], mediaIds: [], contentHash: 'test', sourceAdapter: 'fixture',
      sourceRunId: 'test', schemaVersion: 1,
    } satisfies NormalizedPost;
    const abort = vi.fn().mockResolvedValue(undefined);
    const writable = vi.spyOn(MockFileHandle.prototype, 'createWritable').mockResolvedValueOnce({
      write: vi.fn().mockRejectedValue(new Error('disk full')),
      close: vi.fn(),
      abort,
    });
    try {
      await db.posts.put(post);
      await expect(publishLibrarySnapshot(asDirectory(root), [post.id], vi.fn())).rejects.toThrow('写入中断');
      expect(abort).toHaveBeenCalledOnce();
      const [snapshot] = root.directories.values();
      expect(snapshot.files.has('manifest.json')).toBe(false);
      expect(await db.posts.get(post.id)).toEqual(post);
    } finally {
      writable.mockRestore();
      await db.posts.delete(post.id);
    }
  });
});
