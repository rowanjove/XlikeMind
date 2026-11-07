import type { NormalizedPost, PostSource } from './types';

export const SOURCE_LABELS: Record<PostSource, string> = {
  x_likes: 'X 点赞',
  x_bookmarks: 'X 收藏',
  x_archive: 'X 官方归档',
};

export function getPostSources(post: NormalizedPost): PostSource[] {
  return post.sources ?? (post.sourceAdapter === 'x_archive' ? ['x_archive'] : []);
}

export function describePostSources(post: NormalizedPost): string {
  return getPostSources(post).map((source) => SOURCE_LABELS[source]).join('、') || '未知';
}
