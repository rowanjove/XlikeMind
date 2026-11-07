import { hasArchivedMedia } from '../domain/media';
import type {
  NormalizedPost,
  MediaAsset,
  UserOverrides,
  AIAnalysis,
  SyncRun,
  ExportManifest,
} from '../domain/types';
import { generatePostMarkdown, getPostRelativePath, getMediaArchivePaths } from './markdown';
import {
  buildTopicSummaries,
  generateTopicSynthesis,
  generateTopicMarkdown,
} from '../domain/topics';
import { buildIncrementalDigest, generateDigestMarkdown } from '../domain/digests';
import { sanitizeFilename } from '../domain/sanitize';
import { getArchiveFailures } from './archiveFailures';
import { getTopicFilenames } from './topicFilenames';
import { generateArchiveReader } from './reader';
import { getPostSources } from '../domain/sources';
import { currentAnalysis } from '../domain/analysis';
import { getPageProfileId } from '../storage/profiles';

export interface DirectExportProgress {
  current: number;
  total: number;
  currentFile: string;
  stage: 'preparing' | 'writing_posts' | 'writing_assets' | 'writing_topics' | 'writing_digests' | 'done';
}

export interface DirectExportOptions {
  posts: NormalizedPost[];
  mediaMap: Map<string, MediaAsset[]>;
  overridesMap?: Map<string, UserOverrides>;
  aiMap?: Map<string, AIAnalysis>;
  syncRuns?: SyncRun[];
  runId?: string;
  onProgress?: (progress: DirectExportProgress) => void;
  includeCatalog?: boolean;
  /** Profile namespace recorded in catalog.json for managed-library snapshots. */
  profileId?: string;
}

export interface DirectExportResult {
  success: boolean;
  manifest: ExportManifest;
  writtenFilesCount: number;
}

/**
 * Check if the browser environment supports HTML5 File System Access API
 */
export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/**
 * Recursively get or create nested subdirectories given an array of folder names
 */
export async function getOrCreateDirectoryHandle(
  root: FileSystemDirectoryHandle,
  subdirs: string[]
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const dirName of subdirs) {
    if (!dirName || dirName === '.') continue;
    const cleanDir = sanitizeFilename(dirName);
    current = await current.getDirectoryHandle(cleanDir, { create: true });
  }
  return current;
}

/**
 * Write string or Blob directly to a file handle
 */
export async function writeFileToDirectory(
  dir: FileSystemDirectoryHandle,
  filename: string,
  content: string | Blob
): Promise<void> {
  const cleanFilename = sanitizeFilename(filename);
  const fileHandle = await dir.getFileHandle(cleanFilename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(content);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

/**
 * Directly writes the full knowledge base hierarchy into a local directory handle.
 * Compatible with Obsidian Vaults, VS Code folders, and local Markdown tools.
 */
export async function exportToDirectoryHandle(
  rootHandle: FileSystemDirectoryHandle,
  options: DirectExportOptions
): Promise<DirectExportResult> {
  const {
    posts,
    mediaMap,
    overridesMap = new Map(),
    aiMap = new Map(),
    syncRuns = [],
    onProgress,
  } = options;
  const profileId = options.profileId ?? getPageProfileId();

  const exportedAt = new Date().toISOString();
  let assetCount = 0;
  let writtenFilesCount = 0;
  const failures = getArchiveFailures(posts, mediaMap);

  const totalSteps = posts.length * 2 + 10;
  let currentStep = 0;

  // 1. Write post Markdown files: posts/YYYY/MM/<post_id>.md
  for (const post of posts) {
    const postMedia = mediaMap.get(post.id) || [];
    const overrides = overridesMap.get(post.id);
    const ai = aiMap.get(post.id);

    const mdContent = generatePostMarkdown({
      post,
      media: postMedia,
      overrides,
      ai,
      exportedAt,
    });

    const { dir, filename, fullPath } = getPostRelativePath(post);
    const pathParts = dir.split('/');
    const targetDir = await getOrCreateDirectoryHandle(rootHandle, pathParts);
    await writeFileToDirectory(targetDir, filename, mdContent);
    writtenFilesCount++;

    currentStep++;
    onProgress?.({
      current: currentStep,
      total: totalSteps,
      currentFile: fullPath,
      stage: 'writing_posts',
    });
  }

  // 2. Write media assets: assets/<post_id>/<filename>
  const assetsRootDir = await getOrCreateDirectoryHandle(rootHandle, ['assets']);
  for (const post of posts) {
    const postMedia = mediaMap.get(post.id) || [];
    if (postMedia.length > 0) {
      const safePostId = sanitizeFilename(post.postId || post.id);
      const postAssetDir = await getOrCreateDirectoryHandle(assetsRootDir, [safePostId]);

      for (const m of postMedia) {
        if (hasArchivedMedia(m)) {
          const { archivePath } = getMediaArchivePaths(m, post);
          const filename = archivePath.split('/').pop() || 'image.jpg';
          await writeFileToDirectory(postAssetDir, filename, m.blob);
          assetCount++;
          writtenFilesCount++;
        }
      }
    }

    currentStep++;
    onProgress?.({
      current: currentStep,
      total: totalSteps,
      currentFile: `assets/${post.postId}`,
      stage: 'writing_assets',
    });
  }

  // 3. Write topics: topics/<topic>.md
  const topicsRootDir = await getOrCreateDirectoryHandle(rootHandle, ['topics']);
  const topicSummaries = buildTopicSummaries(posts, overridesMap, aiMap);
  const topicFilenames = getTopicFilenames(topicSummaries.map(({ topic }) => topic));
  const postsMap = new Map(posts.map((p) => [p.id, p]));

  for (const ts of topicSummaries) {
    if (ts.postCount > 0) {
      const topicPosts = ts.postIds.map((id) => postsMap.get(id)).filter(Boolean) as NormalizedPost[];
      const synthesis = generateTopicSynthesis(ts.topic, topicPosts, aiMap);
      const topicMd = generateTopicMarkdown(synthesis, topicPosts, overridesMap, aiMap);
      const safeTopicName = topicFilenames.get(ts.topic)!;
      await writeFileToDirectory(topicsRootDir, safeTopicName, topicMd);
      writtenFilesCount++;
    }
  }

  // 4. Write incremental digests: digests/<run_id>.md
  const digestsRootDir = await getOrCreateDirectoryHandle(rootHandle, ['digests']);
  for (const run of syncRuns) {
    const digest = buildIncrementalDigest(run, posts, overridesMap, aiMap);
    if (digest.newPostCount > 0) {
      const digestMd = generateDigestMarkdown(digest);
      const safeRunName = `${sanitizeFilename(run.id)}.md`;
      await writeFileToDirectory(digestsRootDir, safeRunName, digestMd);
      writtenFilesCount++;
    }
  }

  // 5. Write manifest.json
  const manifest: ExportManifest = {
    manifestVersion: '1.0',
    appName: 'LikeMind',
    appVersion: '0.1.0',
    exportedAt,
    postCount: posts.length,
    assetsCount: assetCount,
    status: failures.length === 0 ? 'complete' : 'partial',
    failuresCount: failures.length,
    failures,
  };

  await writeFileToDirectory(rootHandle, 'index.html', generateArchiveReader(posts, mediaMap, overridesMap, aiMap, {
    exportedAt, syncRuns, runId: options.runId,
  }));
  if (options.includeCatalog) {
    const catalog = {
      schemaVersion: 1,
      profileId,
      exportedAt,
      posts: posts.map((post) => ({
        id: post.id,
        canonicalUrl: post.canonicalUrl,
        author: { handle: post.author?.handle, displayName: post.author?.displayName },
        text: post.text,
        postedAt: post.postedAt,
        likedAt: post.likedAt,
        firstObservedAt: post.firstObservedAt,
        captureStatus: post.captureStatus,
        sources: getPostSources(post),
        markdownPath: getPostRelativePath(post).fullPath,
        overrides: overridesMap.get(post.id),
        analysis: currentAnalysis(post, aiMap.get(post.id)),
        media: (mediaMap.get(post.id) ?? []).map((asset) => ({
          id: asset.id,
          position: asset.position,
          status: asset.status,
          path: hasArchivedMedia(asset) ? getMediaArchivePaths(asset, post).archivePath : null,
        })),
      })),
    };
    await writeFileToDirectory(rootHandle, 'catalog.json', JSON.stringify(catalog));
    writtenFilesCount++;
  }
  await writeFileToDirectory(rootHandle, 'manifest.json', JSON.stringify(manifest, null, 2));
  writtenFilesCount += 2;

  onProgress?.({
    current: totalSteps,
    total: totalSteps,
    currentFile: 'manifest.json',
    stage: 'done',
  });

  return {
    success: true,
    manifest,
    writtenFilesCount,
  };
}
