import { hasArchivedMedia } from '../domain/media';
import JSZip from 'jszip';
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
import { EXPORT_MEDIA_BYTES_LIMIT, exportMediaBytes } from './batches';

const COMPRESSED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

export interface ExportProgress {
  current: number;
  total: number;
  stage: 'preparing' | 'markdown' | 'assets' | 'topics' | 'compressing' | 'done';
}

export interface BuildZipOptions {
  posts: NormalizedPost[];
  mediaMap: Map<string, MediaAsset[]>;
  overridesMap?: Map<string, UserOverrides>;
  aiMap?: Map<string, AIAnalysis>;
  syncRuns?: SyncRun[];
  packageInfo?: ExportManifest['packageInfo'];
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
}

function compressZip(zip: JSZip, signal?: AbortSignal, onProgress?: BuildZipOptions['onProgress']): Promise<Blob> {
  signal?.throwIfAborted();
  const stream = zip.generateInternalStream({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return new Promise((resolve, reject) => {
    const chunks: BlobPart[] = [];
    let percent = 0;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const stop = (error: unknown) => {
      cleanup();
      stream.pause();
      chunks.length = 0;
      reject(error);
    };
    const abort = () => stop(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    stream.on('data', (chunk, metadata) => {
      if (signal?.aborted) return;
      // JSZip uses ArrayBuffer-backed chunks. Copy only if the view has a shared backing store.
      chunks.push(chunk.buffer instanceof ArrayBuffer ? chunk as Uint8Array<ArrayBuffer> : new Uint8Array(chunk));
      const next = Math.round(metadata.percent);
      if (next !== percent) {
        percent = next;
        try {
          onProgress?.({ current: percent, total: 100, stage: 'compressing' });
        } catch (error) {
          stop(error);
        }
      }
    }).on('end', () => {
      cleanup();
      if (!signal?.aborted) resolve(new Blob(chunks, { type: 'application/zip' }));
    }).on('error', stop).resume();
  });
}

/**
 * Build a structured ZIP file containing posts, media assets, topics, digests, and manifest.json
 */
export async function buildExportZip(options: BuildZipOptions): Promise<{
  blob: Blob;
  manifest: ExportManifest;
}> {
  const { posts, mediaMap, overridesMap = new Map(), aiMap = new Map(), syncRuns = [], onProgress, signal } = options;
  signal?.throwIfAborted();
  let mediaBytes = 0;
  for (const post of posts) {
    for (const asset of mediaMap.get(post.id) ?? []) {
      mediaBytes += exportMediaBytes(asset);
      if (mediaBytes > EXPORT_MEDIA_BYTES_LIMIT) {
        throw new Error('此分包的已归档媒体超过 64 MiB。请重试导出，或缩小导出范围。');
      }
    }
  }
  const zip = new JSZip();
  const exportedAt = new Date().toISOString();

  let assetCount = 0;
  const failures = getArchiveFailures(posts, mediaMap);

  const totalSteps = posts.length * 2 + 10;
  let currentStep = 0;

  // 1. Generate and add post markdown files
  for (const post of posts) {
    signal?.throwIfAborted();
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

    const { fullPath } = getPostRelativePath(post);
    if (zip.file(fullPath)) throw new Error('帖子导出路径重复。');
    zip.file(fullPath, mdContent);

    currentStep++;
    onProgress?.({
      current: currentStep,
      total: totalSteps,
      stage: 'markdown',
    });
  }

  // 2. Add media assets
  for (const post of posts) {
    signal?.throwIfAborted();
    const postMedia = mediaMap.get(post.id) || [];
    for (const m of postMedia) {
      if (hasArchivedMedia(m)) {
        const { archivePath } = getMediaArchivePaths(m, post);
        if (zip.file(archivePath)) throw new Error('媒体导出路径重复。');
        const mime = m.mime || m.blob.type;
        zip.file(archivePath, m.blob, COMPRESSED_IMAGE_TYPES.has(mime) ? { compression: 'STORE' } : undefined);
        assetCount++;
      }
    }

    currentStep++;
    onProgress?.({
      current: currentStep,
      total: totalSteps,
      stage: 'assets',
    });
  }

  // 3. Generate and add topic summaries (topics/*.md)
  onProgress?.({
    current: currentStep,
    total: totalSteps,
    stage: 'topics',
  });

  const topicSummaries = buildTopicSummaries(posts, overridesMap, aiMap);
  const topicFilenames = getTopicFilenames(topicSummaries.map(({ topic }) => topic));
  const postsMap = new Map(posts.map((p) => [p.id, p]));

  for (const ts of topicSummaries) {
    signal?.throwIfAborted();
    if (ts.postCount > 0) {
      const topicPosts = ts.postIds.map((id) => postsMap.get(id)).filter(Boolean) as NormalizedPost[];
      const synthesis = generateTopicSynthesis(ts.topic, topicPosts, aiMap);
      const topicMd = generateTopicMarkdown(synthesis, topicPosts, overridesMap, aiMap);
      zip.file(`topics/${topicFilenames.get(ts.topic)}`, topicMd);
    }
  }

  // 4. Generate and add incremental digests (digests/*.md)
  for (const run of syncRuns) {
    signal?.throwIfAborted();
    const digest = buildIncrementalDigest(run, posts, overridesMap, aiMap);
    if (digest.newPostCount > 0) {
      const digestMd = generateDigestMarkdown(digest);
      zip.file(`digests/${sanitizeFilename(run.id)}.md`, digestMd);
    }
  }

  // 5. Add manifest.json
  const manifest: ExportManifest = {
    manifestVersion: '1.0',
    appName: 'LikeMind',
    appVersion: '0.1.0',
    exportedAt,
    postCount: posts.length,
    assetsCount: assetCount,
    ...(options.packageInfo && { packageInfo: options.packageInfo }),
    status: failures.length === 0 ? 'complete' : 'partial',
    failuresCount: failures.length,
    failures,
  };

  zip.file('index.html', generateArchiveReader(posts, mediaMap, overridesMap, aiMap, { exportedAt, syncRuns }));
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  onProgress?.({
    current: 0,
    total: 100,
    stage: 'compressing',
  });

  const blob = await compressZip(zip, signal, onProgress);
  signal?.throwIfAborted();

  onProgress?.({
    current: 100,
    total: 100,
    stage: 'done',
  });

  return { blob, manifest };
}
