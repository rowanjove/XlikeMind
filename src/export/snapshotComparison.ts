import type { ExportManifest } from '../domain/types';

export interface SnapshotComparison {
  previousName: string;
  previousExportedAt: string;
  added: string[];
  resolved: string[];
  newlyMissing: string[];
  previousMissing: number;
  currentMissing: number;
}

function missingPosts(failures: ExportManifest['failures'], postIds: Set<string>) {
  return new Set(failures.filter(({ postId, reason }) => postIds.has(postId) && reason.startsWith('Media '))
    .map(({ postId }) => postId));
}

export async function compareWithSnapshot(
  folder: FileSystemDirectoryHandle,
  previous: { name: string; exportedAt: string; postCount: number },
  profileId: string,
  currentIds: string[],
  currentManifest: ExportManifest,
): Promise<SnapshotComparison | undefined> {
  try {
    const directory = await folder.getDirectoryHandle(previous.name);
    const [catalog, manifest] = await Promise.all(['catalog.json', 'manifest.json'].map(async (name) =>
      JSON.parse(await (await (await directory.getFileHandle(name)).getFile()).text())
    ));
    if (catalog?.schemaVersion !== 1 || catalog.profileId !== profileId || !Array.isArray(catalog.posts) ||
      catalog.posts.length !== previous.postCount || manifest?.exportedAt !== previous.exportedAt ||
      manifest.postCount !== previous.postCount || !Array.isArray(manifest.failures) ||
      !manifest.failures.every((item: unknown) => item && typeof item === 'object' &&
        'postId' in item && typeof item.postId === 'string' && 'reason' in item && typeof item.reason === 'string')) return;
    const previousIds = new Set<string>();
    for (const post of catalog.posts) {
      if (typeof post?.id !== 'string' || !post.id || previousIds.has(post.id)) return;
      previousIds.add(post.id);
    }
    const previousMissing = missingPosts(manifest.failures, previousIds);
    const currentMissing = missingPosts(currentManifest.failures, new Set(currentIds));
    return {
      previousName: previous.name,
      previousExportedAt: previous.exportedAt,
      added: currentIds.filter((id) => !previousIds.has(id)),
      resolved: currentIds.filter((id) => previousMissing.has(id) && !currentMissing.has(id)),
      newlyMissing: currentIds.filter((id) => previousIds.has(id) && !previousMissing.has(id) && currentMissing.has(id)),
      previousMissing: previousMissing.size,
      currentMissing: currentMissing.size,
    };
  } catch {
    // Older or incomplete data can still be opened from history.
    return undefined;
  }
}
