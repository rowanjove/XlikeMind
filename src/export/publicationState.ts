import { getProfileDatabase } from '../storage/db';
import { getPageProfileId, profileStorageKey } from '../storage/profileScope';
import type { AIAnalysis, MediaAsset, NormalizedPost, SyncRun, UserOverrides } from '../domain/types';

export async function publicationSignature(data: {
  posts: NormalizedPost[]; media: MediaAsset[]; overrides: UserOverrides[]; analysis: AIAnalysis[]; runs: SyncRun[];
}) {
  const sorted = <T>(rows: T[], key: (row: T) => string) => [...rows].sort((a, b) => key(a).localeCompare(key(b)));
  const text = JSON.stringify({
    posts: sorted(data.posts, row => row.id),
    media: sorted(data.media, row => row.id).map(({ blob, ...metadata }) => ({ ...metadata, bytes: blob?.size ?? 0 })),
    overrides: sorted(data.overrides, row => row.postId),
    analysis: sorted(data.analysis, row => row.postId),
    runs: sorted(data.runs, row => row.id),
  });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function getPublicationState(profileId = getPageProfileId()) {
  const db = getProfileDatabase(profileId);
  const snapshot = await db.transaction('r', [db.posts, db.media, db.userOverrides, db.aiAnalysis, db.syncRuns, db.folders], async () => {
    const binding = await db.folders.get(profileStorageKey('knowledge-library', profileId));
    if (!binding) return null;
    // Discard each Blob after obtaining its size; never retain an entire image library here.
    const posts = await db.posts.toArray();
    const ids = new Set(posts.map(row => row.id));
    const media: MediaAsset[] = [];
    await db.media.each(({ blob, ...metadata }) => { if (ids.has(metadata.postId)) media.push({ ...metadata, blob: { size: blob?.size ?? 0 } as Blob }); });
    return { binding, posts, media, overrides: (await db.userOverrides.toArray()).filter(row => ids.has(row.postId)),
      analysis: (await db.aiAnalysis.toArray()).filter(row => ids.has(row.postId)), runs: await db.syncRuns.toArray() };
  });
  if (!snapshot) return 'unbound' as const;
  if (!snapshot.binding.latestSnapshot) return 'unpublished' as const;
  if (!snapshot.binding.publishedSignature) return 'unknown' as const;
  return await publicationSignature(snapshot) === snapshot.binding.publishedSignature ? 'current' as const : 'changed' as const;
}
