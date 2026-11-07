import type { PostSource } from '../domain/types';

export interface LikesTabRef {
  id: number;
  url: string;
}

export const DEFAULT_LIKES_URL = 'https://x.com/i/history/likes';

export function normalizeLikesEntry(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || !['x.com', 'twitter.com'].includes(url.host) || url.username || url.password) return;
    if (!/^\/(?:i\/history|[a-z0-9_]{1,15})\/likes\/?$/i.test(url.pathname)) return;
    return url.origin + url.pathname.replace(/\/$/, '');
  } catch {
    return;
  }
}

export function isXPageUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'x.com' || host === 'twitter.com' || host === 'mobile.x.com' || host === 'mobile.twitter.com';
  } catch {
    return false;
  }
}

export function isLikesUrl(url: string): boolean {
  return normalizeLikesEntry(url) !== undefined;
}

export function isBookmarksUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!isXPageUrl(url)) return false;
    return parsed.pathname.includes('/i/bookmarks') || /\/bookmarks\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** Likes and bookmarks are both lists the reader can walk. */
export function isArchiveUrl(url: string): boolean {
  return isLikesUrl(url) || isBookmarksUrl(url);
}

export function matchesCaptureSource(url: string, source?: PostSource): boolean {
  if (source === 'x_likes') return isLikesUrl(url);
  if (source === 'x_bookmarks') return isBookmarksUrl(url);
  return isArchiveUrl(url);
}

export function missingCaptureSource(source: PostSource): string {
  return source === 'x_bookmarks' ? '请打开原来的 X 收藏页，再继续这次采集。' : '请打开原来的 X 点赞页，再继续这次采集。';
}

/**
 * Find an already-open X likes tab. Never falls back to the active tab:
 * the dashboard itself is usually the active tab, and a home timeline is not likes.
 */
export async function findXLikesTab(): Promise<LikesTabRef> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) {
    throw new Error('当前环境无法访问浏览器标签页。请从已加载的扩展页面发起采集。');
  }

  const tabs = await chrome.tabs.query({
    url: ['https://x.com/*', 'https://twitter.com/*'],
  });

  const likes = tabs.find((tab) => typeof tab.id === 'number' && !!tab.url && isLikesUrl(tab.url));
  if (!likes?.id || !likes.url) {
    throw new Error(
      '没有找到已打开的 X 点赞页。请先打开 https://x.com/i/history/likes 并等页面加载完成，再开始采集。扩展不会抓取当前活动标签，避免把首页时间线误存成点赞。'
    );
  }

  return { id: likes.id, url: likes.url };
}

