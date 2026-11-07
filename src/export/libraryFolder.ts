import { getProfileDatabase } from '../storage/db';
import { exportToDirectoryHandle, writeFileToDirectory, type DirectExportProgress } from './directFolderExport';
import type { MediaAsset } from '../domain/types';
import { generateArchiveReader } from './reader';
import { compareWithSnapshot, type SnapshotComparison } from './snapshotComparison';
import { getPageProfileId, profileStorageKey } from '../storage/profiles';
import { publicationSignature } from './publicationState';

const folderId = 'knowledge-library';
const writeAccess = { mode: 'readwrite' } as const;

type WritableDirectory = FileSystemDirectoryHandle & {
  requestPermission(options: typeof writeAccess): Promise<PermissionState>;
  queryPermission(options: typeof writeAccess): Promise<PermissionState>;
};

export function getLibraryFolder(profileId = getPageProfileId()) {
  return getProfileDatabase(profileId).folders.get(profileStorageKey(folderId, profileId));
}

export async function chooseLibraryFolder(profileId = getPageProfileId()) {
  const picker = window as unknown as {
    showDirectoryPicker(options: typeof writeAccess): Promise<FileSystemDirectoryHandle>;
  };
  const handle = await picker.showDirectoryPicker(writeAccess);
  await getProfileDatabase(profileId).folders.put({
    id: profileStorageKey(folderId, profileId), handle, boundAt: new Date().toISOString(),
    managedName: `LikeMind-${crypto.randomUUID().slice(0, 8)}`,
  });
}

export function forgetLibraryFolder(profileId = getPageProfileId()) {
  return getProfileDatabase(profileId).folders.delete(profileStorageKey(folderId, profileId));
}

export async function readSnapshotHistory(folder: FileSystemDirectoryHandle, current: string) {
  const directory = folder as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };
  const candidates: FileSystemDirectoryHandle[] = [];
  for await (const entry of directory.values()) {
    if (entry.kind === 'directory' && entry.name !== current && /^LikeMind-[0-9T-]+Z-[a-f0-9-]{36}$/.test(entry.name)) {
      candidates.push(entry as FileSystemDirectoryHandle);
    }
  }
  candidates.sort((a, b) => b.name.localeCompare(a.name));
  const history: { name: string; exportedAt: string; postCount: number }[] = [];
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(await (await (await candidate.getFileHandle('manifest.json')).getFile()).text());
      await candidate.getFileHandle('index.html');
      if (manifest.appName === 'LikeMind' && manifest.manifestVersion === '1.0' &&
        typeof manifest.exportedAt === 'string' && Number.isFinite(Date.parse(manifest.exportedAt)) &&
        Number.isSafeInteger(manifest.postCount) && manifest.postCount >= 0) {
        history.push({ name: candidate.name, exportedAt: manifest.exportedAt, postCount: manifest.postCount });
      }
    } catch {
      // Incomplete, removed or unreadable snapshots have no usable entry point.
    }
    if (history.length >= 20) break;
  }
  return history;
}

export async function publishLibrarySnapshot(
  folder: FileSystemDirectoryHandle,
  postIds: string[] | undefined,
  onProgress: (progress: DirectExportProgress) => void,
  profileId = getPageProfileId(),
) {
  // Request before any DB work, while the publish click still grants user activation.
  const permission = await (folder as WritableDirectory).requestPermission(writeAccess);
  if (permission !== 'granted') throw new Error('需要目录写入权限，请授权或重新选择目录。');
  return writeSnapshot(folder, postIds, onProgress, undefined, profileId);
}

async function writeSnapshot(
  folder: FileSystemDirectoryHandle,
  postIds: string[] | undefined,
  onProgress: (progress: DirectExportProgress) => void,
  managedRoot?: FileSystemDirectoryHandle,
  profileId = getPageProfileId(),
  runId?: string,
) {
  const db = getProfileDatabase(profileId);
  const data = await db.transaction('r', [db.posts, db.media, db.userOverrides, db.aiAnalysis, db.syncRuns], async () => {
    const posts = postIds
      ? (await db.posts.bulkGet(postIds)).filter((post) => post !== undefined)
      : await db.posts.toArray();
    if (!posts.length) throw new Error('所选范围已没有可导出的帖子。');

    const ids = posts.map((post) => post.id);
    const [media, overrides, ai, syncRuns] = await Promise.all([
      db.media.where('postId').anyOf(ids).toArray(),
      db.userOverrides.bulkGet(ids),
      db.aiAnalysis.bulkGet(ids),
      db.syncRuns.toArray(),
    ]);
    const mediaMap = new Map<string, MediaAsset[]>();
    for (const asset of media) {
      const group = mediaMap.get(asset.postId) ?? [];
      group.push(asset);
      mediaMap.set(asset.postId, group);
    }
    return {
      posts,
      mediaMap,
      overridesMap: new Map(overrides.flatMap((item) => item ? [[item.postId, item]] : [])),
      aiMap: new Map(ai.flatMap((item) => item ? [[item.postId, item]] : [])),
      syncRuns,
    };
  });

  const signature = await publicationSignature({ posts: data.posts, media: [...data.mediaMap.values()].flat(),
    overrides: [...data.overridesMap.values()], analysis: [...data.aiMap.values()], runs: data.syncRuns });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `LikeMind-${timestamp}-${crypto.randomUUID()}`;
  const snapshot = await folder.getDirectoryHandle(name, { create: true });
  try {
    const result = await exportToDirectoryHandle(snapshot, {
      ...data,
      onProgress,
      includeCatalog: Boolean(managedRoot),
      profileId,
      runId,
    });
    if (managedRoot) {
      const { posts, mediaMap, overridesMap, aiMap, syncRuns } = data;
      const history = await readSnapshotHistory(folder, name);
      const ids = posts.map(({ id }) => id);
      const comparisons: SnapshotComparison[] = [];
      for (const baseline of history) {
        const comparison = await compareWithSnapshot(folder, baseline, profileId, ids, result.manifest);
        if (comparison) comparisons.push(comparison);
      }
      await writeFileToDirectory(managedRoot, 'index.html', generateArchiveReader(posts, mediaMap, overridesMap, aiMap, {
        snapshotPath: `snapshots/${name}`, exportedAt: result.manifest.exportedAt, syncRuns, runId, history, comparisons,
      }));
    }
    return { ...result, name, signature };
  } catch {
    throw new Error(`写入中断。目录「${name}」可能留有未完成的文件，请以清单为准。`);
  }
}

export async function grantLibraryWrite(handle: FileSystemDirectoryHandle) {
  if (await (handle as WritableDirectory).requestPermission(writeAccess) !== 'granted') {
    throw new Error('需要目录写入权限，请重新授权。');
  }
}

/** User-initiated permission recovery and entry inspection without creating or writing files. */
export async function inspectLibraryEntry(handle: FileSystemDirectoryHandle, managedName?: string) {
  await grantLibraryWrite(handle);
  if (!managedName) return { status: 'missing' as const };
  try {
    const root = await handle.getDirectoryHandle(managedName);
    const file = await (await root.getFileHandle('index.html')).getFile();
    return { status: file.size ? 'ready' as const : 'empty' as const, bytes: file.size, modifiedAt: file.lastModified };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return { status: 'missing' as const };
    throw error;
  }
}

export async function publishBoundLibrary(
  runId: string | undefined,
  onProgress: (progress: DirectExportProgress) => void,
  force = false,
  profileId = getPageProfileId(),
) {
  const publish = async () => {
    const db = getProfileDatabase(profileId);
    const binding = await getLibraryFolder(profileId);
    if (!binding) throw new Error('请先绑定本地文件夹。');
    if (!force && runId && binding.publishedRunId === runId) return binding.latestSnapshot;
    if (!force && runId && binding.publishedRunId) {
      const [incoming, previous] = await db.syncRuns.bulkGet([runId, binding.publishedRunId]);
      if (incoming && previous && incoming.startedAt < previous.startedAt) return binding.latestSnapshot;
    }
    if (await (binding.handle as WritableDirectory).queryPermission(writeAccess) !== 'granted') {
      throw new Error('帖子已保存在扩展中。请在设置中重新授权并写入本地文库。');
    }
    const managedName = binding.managedName ?? `LikeMind-${crypto.randomUUID().slice(0, 8)}`;
    // Persist the namespace first so a retry writes into the same library.
    const scopedFolderId = profileStorageKey(folderId, profileId);
    if (!binding.managedName) await db.folders.update(scopedFolderId, { managedName });
    const root = await binding.handle.getDirectoryHandle(managedName, { create: true });
    const snapshots = await root.getDirectoryHandle('snapshots', { create: true });
    const result = await writeSnapshot(snapshots, undefined, onProgress, root, profileId, runId);
    const latest = await getLibraryFolder(profileId);
    if (latest?.managedName === managedName) {
      await db.folders.update(scopedFolderId, { publishedRunId: runId, latestSnapshot: result.name, publishedSignature: result.signature });
    }
    return result.name;
  };
  return typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request(`likemind-bound-library:${profileId}`, publish)
    : publish();
}
