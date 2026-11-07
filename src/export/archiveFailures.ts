import { hasArchivedMedia } from '../domain/media';
import type { ExportManifest, MediaAsset, NormalizedPost } from '../domain/types';

const CAPTURE_GAPS = new Set([
  'author', 'authorHandle', 'postedAt', 'text', 'truncated_text', 'media',
  'article_body', 'thread_continuation', 'quoted_post_body', 'quoted_post_media', 'video_body',
]);

export function archiveMissingFields(post: NormalizedPost): string[] {
  return [...new Set((post.missingFields ?? []).filter((field) => CAPTURE_GAPS.has(field)))];
}

export function getArchiveFailures(posts: NormalizedPost[], mediaMap: Map<string, MediaAsset[]>): ExportManifest['failures'] {
  const failures: ExportManifest['failures'] = [];
  for (const post of posts) {
    if (post.captureStatus !== 'complete') {
      const missingFields = archiveMissingFields(post);
      failures.push({ postId: post.id, kind: 'capture', reason: `Post capture: ${post.captureStatus}`,
        ...(missingFields.length ? { missingFields } : {}) });
    }
    const media = mediaMap.get(post.id) ?? [];
    const presentIds = new Set(media.map((asset) => asset.id));
    for (const id of post.mediaIds) {
      if (!presentIds.has(id)) failures.push({ postId: post.id, kind: 'media', reason: `Media ${id}: missing` });
    }
    for (const asset of media) {
      if (!hasArchivedMedia(asset)) {
        failures.push({ postId: post.id, kind: 'media', reason: `Media ${asset.id}: ${asset.status === 'downloaded' ? 'missing file' : asset.status}` });
      }
    }
  }
  return failures;
}
