import type { NormalizedPost, MediaAsset } from './types';
import { isOwnStatusPermalink, sanitizeUrl } from './sanitize';
import { getPostSources } from './sources';

export interface MergeOptions {
  /**
   * Live recaptures may replace a complete body when the author edits it.
   * Archive import turns this off and only accepts a strictly longer body.
   */
  replaceCompleteEdits?: boolean;
}

// These gaps describe fields outside the visible body of the post itself.
const NON_BODY_GAPS = new Set([
  'author', 'authorHandle', 'postedAt', 'media', 'thread_continuation',
  'quoted_post_body', 'quoted_post_media', 'video_body',
]);

function hasCompletePostText(post: NormalizedPost): boolean {
  if (post.missingFields.some((field) => field === 'text' || field === 'truncated_text' || field === 'article_body')) {
    return false;
  }
  return post.captureStatus === 'complete' || (post.captureStatus === 'partial' &&
    post.missingFields.length > 0 && post.missingFields.every((field) => NON_BODY_GAPS.has(field)));
}

const FIELD_GAPS = new Set(['author', 'authorHandle', 'postedAt', 'text', 'truncated_text']);

/**
 * Merge an incoming scraped post with an existing stored post.
 * Rules:
 * 1. Never overwrite complete, high quality fields with empty/null/partial ones.
 * 2. firstObservedAt is strictly preserved from the existing record.
 * 3. lastObservedAt is updated to incoming.lastObservedAt.
 * 4. likedAt is strictly preserved (defaults to null, never guessed).
 * 5. Text is preserved if existing was complete and incoming is partial.
 * 6. Content hash is updated if content actually changed.
 */
export function mergeNormalizedPost(
  existing: NormalizedPost,
  incoming: NormalizedPost,
  options?: MergeOptions
): { merged: NormalizedPost; isUpdated: boolean } {
  const replaceCompleteEdits = options?.replaceCompleteEdits !== false;
  let isUpdated = false;

  const merged: NormalizedPost = { ...existing };

  // Observation time moves forward. sourceRunId stays on the run that first
  // stored the post, so incremental digests keep meaning "first seen here".
  merged.lastObservedAt = incoming.lastObservedAt;
  const priorSources = getPostSources(existing);
  const sources = [...new Set([...priorSources, ...getPostSources(incoming)])];
  if (sources.length > priorSources.length) {
    merged.sources = sources;
    isUpdated = true;
  }

  // Author merge
  if (incoming.author) {
    const handle = incoming.author.handle?.trim() || existing.author?.handle;
    const displayName = incoming.author.displayName?.trim() ? incoming.author.displayName : existing.author?.displayName;
    const avatarUrl = sanitizeUrl(incoming.author.avatarUrl || '') || existing.author?.avatarUrl;
    const id = incoming.author.id?.trim() || existing.author?.id;

    if (
      handle !== existing.author?.handle ||
      displayName !== existing.author?.displayName ||
      avatarUrl !== existing.author?.avatarUrl ||
      id !== existing.author?.id
    ) {
      merged.author = { handle, displayName, avatarUrl, id };
      isUpdated = true;
    }
  }

  // Text merge:
  // - a complete record is not replaced by a partial or empty scrape
  // - a real edit (both sides complete, text changed) replaces the text, even if shorter
  // - a partial record only grows toward longer, non-empty text
  const incomingText = incoming.text?.trim() ? incoming.text : '';
  const existingText = existing.text?.trim() ? existing.text : '';
  const incomingComplete = hasCompletePostText(incoming) && incomingText.length > 0;
  const existingComplete = hasCompletePostText(existing) && existingText.length > 0;
  const threadIncomplete = existing.missingFields.includes('thread_continuation') ||
    incoming.missingFields.includes('thread_continuation');
  const completeStatus = threadIncomplete ? 'partial' : 'complete';
  let textObservation = existing;

  if (incomingComplete && existingComplete && incomingText !== existingText) {
    const acceptEdit = replaceCompleteEdits || incomingText.length > existingText.length;
    if (acceptEdit) {
      merged.text = incoming.text;
      merged.contentHash = incoming.contentHash;
      merged.captureStatus = completeStatus;
      textObservation = incoming;
      isUpdated = true;
    }
  } else if (incomingComplete && !existingComplete && incomingText.length >= existingText.length) {
    isUpdated ||= merged.text !== incoming.text || merged.contentHash !== incoming.contentHash;
    merged.text = incoming.text;
    merged.contentHash = incoming.contentHash;
    merged.captureStatus = completeStatus;
    textObservation = incoming;
  } else if (!existingComplete && incomingText.length > existingText.length) {
    merged.text = incoming.text;
    merged.contentHash = incoming.contentHash;
    merged.captureStatus = incoming.captureStatus === 'failed' ? existing.captureStatus : incoming.captureStatus;
    textObservation = incoming;
    isUpdated = true;
  } else if (!existingText && !incomingText && existing.captureStatus !== 'complete' &&
    incoming.captureStatus === 'complete' && incoming.mediaIds.length > 0 && !threadIncomplete) {
    merged.captureStatus = completeStatus;
  }

  // postedAt: if existing didn't have it, but incoming does
  if (!existing.postedAt && incoming.postedAt) {
    merged.postedAt = incoming.postedAt;
    isUpdated = true;
  }

  // externalLinks: union of safe outbound links. Drop this post's own permalink.
  const keepLink = (link: string) => link.length > 0 && !isOwnStatusPermalink(link, existing.postId);
  const nextLinks: string[] = [];
  const seenLinks = new Set<string>();
  for (const link of [...existing.externalLinks, ...incoming.externalLinks]) {
    const safe = sanitizeUrl(link);
    if (!keepLink(safe) || seenLinks.has(safe)) continue;
    seenLinks.add(safe);
    nextLinks.push(safe);
  }
  const linksChanged =
    nextLinks.length !== existing.externalLinks.length ||
    nextLinks.some((link, index) => link !== existing.externalLinks[index]);
  if (linksChanged) {
    merged.externalLinks = nextLinks;
    isUpdated = true;
  }

  const previousReferences = existing.references ?? [];
  const references = new Map(previousReferences.map((reference) => [`${reference.kind}:${reference.id}`, reference]));
  for (const reference of incoming.references ?? []) {
    const key = `${reference.kind}:${reference.id}`;
    if (!references.has(key)) references.set(key, reference);
  }
  if (references.size > previousReferences.length) {
    merged.references = [...references.values()];
    isUpdated = true;
  }

  // mediaIds: merge union
  const mediaSet = new Set([...existing.mediaIds, ...incoming.mediaIds]);
  if (mediaSet.size !== existing.mediaIds.length) {
    merged.mediaIds = Array.from(mediaSet);
    isUpdated = true;
  }

  // Metadata comes from the merged fields, while truncation follows the retained text.
  const acceptedComplete = incoming.captureStatus === 'complete' &&
    (textObservation === incoming || incoming.text === merged.text);
  const captureGaps = acceptedComplete ? incoming.missingFields : [
    ...existing.missingFields, ...(textObservation === incoming ? incoming.missingFields : []),
  ];
  const nextMissing = new Set(captureGaps.filter((field) => !FIELD_GAPS.has(field)));
  const observedMissing = new Set([...existing.missingFields, ...incoming.missingFields]);
  // A snapshot that omits an attachment or related post does not resolve its gap.
  for (const field of ['article_body', 'video_body', 'quoted_post_media']) {
    if (observedMissing.has(field)) nextMissing.add(field);
  }
  const previousQuotes = previousReferences.filter(({ kind }) => kind === 'quote');
  const refreshedQuotes = new Set((incoming.references ?? []).filter(({ kind }) => kind === 'quote').map(({ id }) => id));
  const quoteBodyRecovered = (textObservation === incoming || incoming.text === merged.text) &&
    incoming.captureStatus !== 'failed' && !incoming.missingFields.includes('quoted_post_body') &&
    previousQuotes.length > 0 && previousQuotes.every(({ id }) => refreshedQuotes.has(id));
  if (observedMissing.has('quoted_post_body') && !quoteBodyRecovered) nextMissing.add('quoted_post_body');
  if (quoteBodyRecovered) nextMissing.delete('quoted_post_body');
  if (observedMissing.has('media') && (!acceptedComplete || !incoming.mediaIds.length || incoming.missingFields.includes('media'))) {
    nextMissing.add('media');
  }
  if (observedMissing.has('author') && !(merged.author?.handle || merged.author?.displayName || merged.author?.id)) {
    nextMissing.add('author');
  }
  if (observedMissing.has('authorHandle') && !merged.author?.handle) nextMissing.add('authorHandle');
  if (observedMissing.has('postedAt') && !merged.postedAt) nextMissing.add('postedAt');
  if (observedMissing.has('text') && !merged.text.trim() && !merged.mediaIds.length) nextMissing.add('text');
  if (textObservation.missingFields.includes('truncated_text')) nextMissing.add('truncated_text');
  if (threadIncomplete) nextMissing.add('thread_continuation');
  if (['thread_continuation', 'article_body', 'video_body', 'quoted_post_body', 'quoted_post_media', 'media']
    .some((field) => nextMissing.has(field))) {
    merged.captureStatus = 'partial';
  } else if (acceptedComplete && incomingComplete && nextMissing.size === 0) {
    merged.captureStatus = 'complete';
  }
  if (merged.captureStatus !== existing.captureStatus) isUpdated = true;
  if (nextMissing.size !== existing.missingFields.length || existing.missingFields.some((field) => !nextMissing.has(field))) {
    merged.missingFields = [...nextMissing];
    isUpdated = true;
  }

  return { merged, isUpdated };
}

/**
 * Merge incoming media assets with existing ones.
 * Avoid re-downloading downloaded media.
 */
export function mergeMediaAssets(
  existingMedia: MediaAsset[],
  incomingMedia: MediaAsset[]
): { toInsert: MediaAsset[]; toUpdate: MediaAsset[]; unchanged: MediaAsset[] } {
  const existingMap = new Map(existingMedia.map((m) => [m.id, m]));
  const toInsert: MediaAsset[] = [];
  const toUpdate: MediaAsset[] = [];
  const unchanged: MediaAsset[] = [];

  for (const incoming of incomingMedia) {
    const existing = existingMap.get(incoming.id);
    if (!existing) {
      toInsert.push(incoming);
    } else {
      // If already downloaded, do NOT overwrite with pending
      if (existing.status === 'downloaded' && existing.blob) {
        unchanged.push(existing);
      } else if (existing.status === 'failed' && incoming.status === 'pending') {
        // Allow retry
        toUpdate.push(incoming);
      } else {
        unchanged.push(existing);
      }
    }
  }

  return { toInsert, toUpdate, unchanged };
}
