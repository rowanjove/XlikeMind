function linkSetKey(links?: string[]): string {
  return JSON.stringify([...new Set(links ?? [])].sort());
}

/**
 * Deterministic hash for normalized content comparison
 */
export async function calculateContentHash(content: {
  text: string;
  authorHandle?: string;
  mediaUrls: string[];
  externalLinks?: string[];
}): Promise<string> {
  const links = linkSetKey(content.externalLinks);
  const payload = [
    content.text.trim(),
    (content.authorHandle || '').trim().toLowerCase(),
    content.mediaUrls.join(','),
    ...(links === '[]' ? [] : [links]),
  ].join('|||');

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(payload);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback FNV-1a 32-bit hash string if subtle crypto is somehow not present
  let hash = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Hash the saved inputs when a merge keeps fields that differ from the observation. */
type HashablePost = { text: string; author?: { handle?: string }; externalLinks: string[]; contentHash: string };

export function calculateMergedContentHash(
  saved: HashablePost,
  savedMediaUrls: string[],
  observed: HashablePost,
  observedMediaUrls: string[],
  previous?: { post: HashablePost; mediaUrls: string[] },
): Promise<string> {
  const matches = (post: HashablePost, mediaUrls: string[]) =>
    saved.text.trim() === post.text.trim() &&
    (saved.author?.handle ?? '').trim().toLowerCase() === (post.author?.handle ?? '').trim().toLowerCase() &&
    linkSetKey(saved.externalLinks) === linkSetKey(post.externalLinks) &&
    savedMediaUrls.length === mediaUrls.length &&
    savedMediaUrls.every((url, index) => url === mediaUrls[index]);
  // Keep legacy hashes valid while the inputs of a saved post are unchanged.
  if (previous && matches(previous.post, previous.mediaUrls)) return Promise.resolve(previous.post.contentHash);
  if (matches(observed, observedMediaUrls)) return Promise.resolve(observed.contentHash);
  return calculateContentHash({
    text: saved.text, authorHandle: saved.author?.handle, mediaUrls: savedMediaUrls, externalLinks: saved.externalLinks,
  });
}
