import { logDiagnosticError } from '../domain/diagnosticFrames';
import type { RawCapturedItem } from './types';
import { sanitizeUrl } from '../domain/sanitize';
import { normalizePostReference } from '../domain/postReferences';
import type { PostReference } from '../domain/types';

const QUOTE_CONTEXT = 'blockquote, [data-testid="quoteTweet"], [data-testid="quotedTweet"]';
const REPLY_CONTEXT = '[data-testid="replyContext"], [data-testid="replyingTo"]';
const THREAD_LINK_LABEL = /^(?:(?:show|view) (?:this |the )?thread|(?:查看|显示)(?:此|该|完整)?(?:讨论串|推文串|串帖|帖子串))$/i;
const SHOW_MORE_SELECTOR = '[data-testid="tweet-text-show-more-link"], button, [role="button"]';
const SHOW_MORE_LABEL = /^(show more|显示更多)$/i;
const QUOTED_MEDIA_SELECTOR = '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], video';

function isShowMoreControl(element: Element): boolean {
  const label = (element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim();
  return element.getAttribute('data-testid') === 'tweet-text-show-more-link' || SHOW_MORE_LABEL.test(label);
}

function isThreadLink(link: HTMLAnchorElement): boolean {
  return !link.closest('[data-testid="tweetText"]') && THREAD_LINK_LABEL.test(
    (link.getAttribute('aria-label') || link.textContent || '').trim().replace(/\s+/g, ' '),
  );
}

function belongsToArticle(element: Element, article: Element): boolean {
  const quote = element.closest(QUOTE_CONTEXT);
  return element.closest('article') === article && !(quote && article.contains(quote));
}

function ownedElements<T extends Element>(article: Element, selector: string): T[] {
  return Array.from(article.querySelectorAll<T>(selector)).filter((element) => belongsToArticle(element, article));
}

/**
 * Pure DOM parser that extracts RawCapturedItem from an <article data-testid="tweet"> element.
 * Isolated from browser scrolling so it can be easily tested with mock DOM fixtures.
 */
export function parseTweetArticle(article: Element): RawCapturedItem | null {
  try {
    // 1. Extract Post ID and URL
    // Look for link containing /status/<id>
    const statusLinks = primaryStatusLinks(article);
    let postId = '';
    let canonicalUrl = '';
    let statusLink: HTMLAnchorElement | undefined;

    for (const link of Array.from(statusLinks)) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/status\/(\d+)/);
      if (match) {
        postId = match[1];
        statusLink = link;
        const absolute = href.startsWith('http') ? href : `https://x.com${href}`;
        try {
          const parsed = new URL(absolute);
          parsed.search = '';
          parsed.hash = '';
          canonicalUrl = parsed.toString();
        } catch {
          canonicalUrl = `https://x.com/i/web/status/${postId}`;
        }
        break;
      }
    }

    if (!postId) {
      return null;
    }

    // 2. Extract Author Information
    let authorHandle: string | undefined;
    let authorDisplayName: string | undefined;
    let authorAvatarUrl: string | undefined;

    const [userNameEl] = ownedElements(article, '[data-testid="User-Name"]');
    if (userNameEl) {
      // Find handle: text matching @\w+
      const text = userNameEl.textContent || '';
      const handleMatch = text.match(/@([a-zA-Z0-9_]+)/);
      if (handleMatch) {
        authorHandle = handleMatch[1];
      }

      // Display name is typically in the first span
      const firstSpan = userNameEl.querySelector('span');
      if (firstSpan) {
        authorDisplayName = firstSpan.textContent?.trim();
      }
    }

    const [avatarImg] = ownedElements<HTMLImageElement>(article, 'img[src*="profile_images"]');
    if (avatarImg) {
      authorAvatarUrl = avatarImg.src;
    }

    // 3. Extract Tweet Text. Walk text nodes so CSS line-clamp cannot cut the body.
    const tweetText = readTweetText(article);

    // 4. Extract Timestamp (postedAt)
    let postedAt: string | null = null;
    const timeEl = statusLink?.querySelector('time') ?? ownedElements(article, 'time')[0];
    if (timeEl) {
      const dt = timeEl.getAttribute('datetime');
      if (dt) {
        const parsed = new Date(dt);
        if (!isNaN(parsed.getTime())) {
          postedAt = parsed.toISOString();
        }
      }
    }

    // 5. Extract images from photo grids, srcset, posters and background images.
    const media = collectMedia(article, article);
    const mediaUrls = media.map(({ url }) => url);
    const mediaAltTexts = Object.fromEntries(media.flatMap(({ url, altText }) => altText ? [[url, altText]] : []));

    // 6. Extract External Links
    const externalLinks: string[] = [];
    const references = new Map<string, PostReference>();
    const quoteCards = new Set<Element>();
    const allLinks = article.querySelectorAll<HTMLAnchorElement>('a[href]');
    for (const a of Array.from(allLinks)) {
      const href = a.getAttribute('href') || '';
      const context = a.closest(`article, ${QUOTE_CONTEXT}, ${REPLY_CONTEXT}`);
      const kind = context && context !== article && article.contains(context)
        ? context.matches(REPLY_CONTEXT) ? 'reply' : 'quote'
        : isThreadLink(a) ? 'thread' : 'article';
      if (kind === 'quote' && a.closest('[data-testid="tweetText"]')) continue;
      const reference = normalizePostReference(kind, href);
      if (reference && (reference.kind === 'article' || reference.kind === 'thread' || reference.id !== postId)) {
        references.set(`${reference.kind}:${reference.id}`, reference);
        if (reference.kind === 'quote' && context) quoteCards.add(context);
        continue;
      }
      if (context !== article) continue;
      // Ignore internal hashtags/cashtags/status navigation
      if (
        href.includes('t.co/') ||
        (href.startsWith('http') && !href.includes('x.com/') && !href.includes('twitter.com/'))
      ) {
        const safe = sanitizeUrl(href);
        if (safe && !externalLinks.includes(safe)) {
          externalLinks.push(safe);
        }
      }
    }

    const showMore = ownedElements(article, SHOW_MORE_SELECTOR).some(isShowMoreControl);
    const quotedBodyMissing = [...quoteCards].some((card) =>
      !Array.from(card.querySelectorAll('[data-testid="tweetText"]')).some((block) => Boolean(readBlock(block))) ||
      Array.from(card.querySelectorAll(SHOW_MORE_SELECTOR)).some(isShowMoreControl));
    const quotedMediaMissing = [...quoteCards].some((card) =>
      Boolean(card.querySelector(QUOTED_MEDIA_SELECTOR)) || collectMediaUrls(card).length > 0);
    const unresolvedMedia = hasUnresolvedMedia(article);
    const videoBodyMissing = ownedElements(article, 'video, [data-testid="videoPlayer"]').length > 0;
    const missingFields: string[] = [];
    if (!authorHandle) missingFields.push('authorHandle');
    if (!postedAt) missingFields.push('postedAt');
    if (!tweetText && mediaUrls.length === 0) missingFields.push('text');
    if (showMore) missingFields.push('truncated_text');
    if (unresolvedMedia) missingFields.push('media');
    const articleBodyMissing = [...references.values()].some(({ kind }) => kind === 'article');
    const threadContinuationMissing = [...references.values()].some(({ kind }) => kind === 'thread');
    if (articleBodyMissing) missingFields.push('article_body');
    if (threadContinuationMissing) missingFields.push('thread_continuation');
    if (quotedBodyMissing) missingFields.push('quoted_post_body');
    if (quotedMediaMissing) missingFields.push('quoted_post_media');
    if (videoBodyMissing) missingFields.push('video_body');

    // Missing author or time is incomplete metadata, not incomplete body.
    // Visible references can point to bodies that the timeline cannot provide.
    const isPartial = (!tweetText && mediaUrls.length === 0) || Boolean(showMore) ||
      unresolvedMedia || articleBodyMissing || threadContinuationMissing || quotedBodyMissing || quotedMediaMissing || videoBodyMissing;

    const safeAvatar = authorAvatarUrl ? sanitizeUrl(authorAvatarUrl) : '';

    return {
      postId,
      url: canonicalUrl,
      authorHandle,
      authorDisplayName,
      authorAvatarUrl: safeAvatar || undefined,
      text: tweetText,
      postedAt,
      mediaUrls,
      mediaAltTexts,
      externalLinks,
      references: [...references.values()],
      missingFields,
      isPartial,
    };
  } catch (err) {
    logDiagnosticError('parse_post', err);
    return null;
  }
}

/** Return the status links owned by this card, excluding nested quoted cards. */
export function primaryStatusLinks(article: Element): HTMLAnchorElement[] {
  const owned = ownedElements<HTMLAnchorElement>(article, 'a[href*="/status/"]')
    .filter((link) => !link.closest(REPLY_CONTEXT) && !isThreadLink(link));
  const withTimestamp = owned.filter((link) => link.querySelector('time'));
  return withTimestamp.length > 0 ? withTimestamp : owned;
}

const SKIP_MEDIA = /profile_images|profile_banners|\/emoji\/|twemoji|abs\.twimg\.com/i;
const MEDIA_PATH = /^\/(media|card_img|amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\//i;

function upgradeTwimg(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url;
    if (parsed.hostname.endsWith('twimg.com') && parsed.searchParams.has('name')) {
      if (parsed.searchParams.get('name') !== 'orig') {
        parsed.searchParams.set('name', 'large');
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function mediaRank(url: string): number {
  if (url.includes('name=orig')) return 4;
  if (url.includes('name=large')) return 3;
  if (url.includes('name=medium') || url.includes('name=900')) return 2;
  return 1;
}

function pushMediaCandidate(found: MediaCandidate[], raw: string | null | undefined, altText?: string): void {
  if (!raw) return;
  const trimmed = raw.trim().replace(/&amp;/g, '&');
  if (!trimmed || /^(javascript|data|blob|vbscript):/i.test(trimmed)) return;
  const upgraded = sanitizeUrl(upgradeTwimg(trimmed));
  if (!upgraded || SKIP_MEDIA.test(upgraded)) return;
  const parsed = new URL(upgraded);
  if (parsed.host !== 'pbs.twimg.com' || !MEDIA_PATH.test(parsed.pathname)) return;
  found.push({ url: upgraded, altText });
}

interface MediaCandidate {
  url: string;
  altText?: string;
}

/**
 * Collect tweet images in DOM order. Avatars and emoji are ignored.
 * The same photo in src and srcset is kept once, preferring the larger URL.
 */
export function collectMediaUrls(article: Element): string[] {
  return collectMedia(article).map(({ url }) => url);
}

function collectMedia(root: Element, owner?: Element): MediaCandidate[] {
  const found: MediaCandidate[] = [];
  const selector = 'img, source, video[poster], [style*="twimg.com"]';
  const candidates = [
    ...(root.matches(selector) ? [root] : []),
    ...root.querySelectorAll(selector),
  ];

  for (const node of candidates) {
    if (owner && !belongsToArticle(node, owner)) continue;
    if (node.matches('img, source')) {
      const label = (node.getAttribute('alt') || node.closest('picture')?.querySelector('img')?.getAttribute('alt'))?.trim();
      const altText = label && !/^(image|photo|图片|图像)$/i.test(label) ? label : undefined;
      pushMediaCandidate(found, node.getAttribute('src'), altText);
      pushMediaCandidate(found, node.getAttribute('data-src'), altText);
      if (node instanceof HTMLImageElement) pushMediaCandidate(found, node.currentSrc, altText);
      for (const part of (node.getAttribute('srcset') ?? '').split(',')) {
        pushMediaCandidate(found, part.trim().split(/\s+/)[0], altText);
      }
    }
    if (node.matches('video[poster]')) pushMediaCandidate(found, node.getAttribute('poster'));
    const style = node.getAttribute('style') || '';
    const matched = style.match(/url\((['"]?)(https?:\/\/[^'")]+)\1\)/i);
    if (matched) pushMediaCandidate(found, matched[2]);
  }

  const byPath = new Map<string, MediaCandidate>();
  for (const { url, altText } of found) {
    const key = new URL(url).pathname;
    const previous = byPath.get(key);
    const preferred = !previous || mediaRank(url) > mediaRank(previous.url) ? url : previous.url;
    byPath.set(key, { url: preferred, altText: previous?.altText ?? altText });
  }
  return Array.from(byPath.values());
}

export function hasUnresolvedMedia(article: Element): boolean {
  const slots = ownedElements(article, '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="card.layoutLarge.media"]');
  return slots.some((slot) => collectMedia(slot, article).length === 0);
}

function readBlock(root: Element): string {
  const parts: string[] = [];
  const separateBlock = () => {
    if (parts.length > 0 && !parts.at(-1)?.endsWith('\n')) parts.push('\n');
  };
  const walk = (node: Node, isRoot: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || '');
      return;
    }
    if (!(node instanceof HTMLElement)) {
      node.childNodes.forEach((child) => walk(child, false));
      return;
    }
    if (node.matches('script, style, template') || (node.matches(SHOW_MORE_SELECTOR) && isShowMoreControl(node))) return;
    if (node.tagName === 'BR') {
      parts.push('\n');
      return;
    }
    if (node.tagName === 'IMG') {
      const alt = node.getAttribute('alt') || '';
      if (alt && !/^image$/i.test(alt)) parts.push(alt);
      return;
    }
    const block = !isRoot && node.matches('div, p, pre');
    if (block) separateBlock();
    node.childNodes.forEach((child) => walk(child, false));
    if (block && node.nextSibling) separateBlock();
  };
  walk(root, true);
  const text = parts.join('');
  return text.trim() ? text : '';
}

/** Full tweet body, including lines that CSS has visually clamped. */
export function readTweetText(article: Element): string {
  const blocks = Array.from(article.querySelectorAll('[data-testid="tweetText"]'));
  const primary = new Set(ownedElements(article, '[data-testid="tweetText"]'));
  const body: string[] = [];
  const quotes: string[] = [];
  for (const block of blocks) {
    const text = readBlock(block);
    if (!text) continue;
    if (primary.has(block)) body.push(text);
    else quotes.push(text);
  }
  return [...body, ...quotes.map((text) => `引用：\n${text}`)].join('\n\n');
}

/**
 * Click an in-page "Show more" control. Skip real links so the likes tab stays put.
 * Returns true when a control was clicked.
 */
export function revealTruncatedText(article: Element): boolean {
  const nodes = Array.from(
    article.querySelectorAll<HTMLElement>(SHOW_MORE_SELECTOR)
  );
  let clicked = false;
  for (const el of nodes) {
    if (!isShowMoreControl(el)) continue;
    if (el.matches('a[href]') || el.parentElement?.matches('a[href]')) continue;
    el.click();
    clicked = true;
  }
  return clicked;
}
