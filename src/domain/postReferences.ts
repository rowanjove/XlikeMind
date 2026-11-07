import type { PostReference } from './types';

export const POST_REFERENCE_LABELS: Record<PostReference['kind'], string> = {
  quote: '引用帖',
  reply: '回复的帖子',
  article: 'X 文章（正文未归档）',
  thread: '在 X 查看串帖',
};

export function getCaptureNotices(missingFields: readonly string[]): string[] {
  const missing = new Set(missingFields);
  const notices: string[] = [];
  if (missing.has('truncated_text')) notices.push('帖子正文只保存了可见部分。请打开 X 原帖查看全文。');
  if (missing.has('article_body')) notices.push('X 文章正文未归档。请在 X 打开文章阅读。');
  if (missing.has('media')) notices.push('有媒体未能从原帖识别，已识别的媒体单独列出。');
  if (missing.has('video_body')) notices.push('视频内容未归档，可前往 X 原帖观看。');
  if (missing.has('thread_continuation')) notices.push('这里只保存了可见内容。请前往 X 查看串帖其余部分。');
  if (missing.has('quoted_post_body') || missing.has('quoted_post_media')) {
    notices.push('引用帖只保存了可见预览。请打开关联原文查看其余内容。');
  }
  return notices;
}

export function normalizePostReference(kind: PostReference['kind'], href: string): PostReference | undefined {
  if (!Object.hasOwn(POST_REFERENCE_LABELS, kind)) return;
  try {
    const url = new URL(href, 'https://x.com');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      !/^(www\.)?(x|twitter)\.com$/i.test(url.host)) return;
    const path = kind === 'article'
      ? url.pathname.match(/^\/(?:i|[\w]+)\/article\/(\d{1,25})\/?$/)
      : url.pathname.match(/^\/(?:[\w]+|i\/web)\/status\/(\d{1,25})\/?$/);
    if (!path) return;
    const id = path[1];
    return { kind, id, url: kind === 'article' ? `https://x.com/i/article/${id}` : `https://x.com${url.pathname.replace(/\/$/, '')}` };
  } catch {
    return;
  }
}
