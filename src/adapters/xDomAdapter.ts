import type { CaptureAdapter, CaptureOptions, CaptureResult, RawCapturedItem } from './types';
import { isArchiveUrl, isXPageUrl } from './findLikesTab';
import { hasUnresolvedMedia, parseTweetArticle, primaryStatusLinks, revealTruncatedText } from './xDomParser';
import { detectCaptureFailure } from './captureFailure';

export function visibleTweetArticles(root: ParentNode = document): Element[] {
  const primary = root.querySelectorAll('article[data-testid="tweet"]');
  const cards = primary.length > 0 ? primary : root.querySelectorAll('article[role="article"]');
  return Array.from(cards).filter((card) => !card.parentElement?.closest('article[data-testid="tweet"], article[role="article"]'));
}

export function peekPostId(article: Element): string {
  const href = primaryStatusLinks(article)[0]?.getAttribute('href') || '';
  return href.match(/\/status\/(\d+)/)?.[1] ?? '';
}

/** Remember post ids that are on screen now. Virtualized timelines drop cards that scroll away. */
export function rememberVisiblePostIds(seen: Set<string>, root: ParentNode = document): number {
  for (const article of visibleTweetArticles(root)) {
    const postId = peekPostId(article);
    if (postId) {
      seen.add(postId);
      continue;
    }
    const text = (article.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (text) seen.add(`text:${text}`);
  }
  return seen.size;
}

function findScrollContainer(start: Element | null): HTMLElement | null {
  let node = start instanceof HTMLElement ? start.parentElement : null;
  while (node && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    const canScroll =
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      node.scrollHeight > node.clientHeight + 80;
    if (canScroll) return node;
    node = node.parentElement;
  }
  const column = document.querySelector('[data-testid="primaryColumn"]');
  if (column instanceof HTMLElement && column.scrollHeight > column.clientHeight + 80) return column;
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
}

/** Move the timeline that actually loads more posts. Window scroll alone does not. */
export function scrollFeed(): void {
  if (isJsdom()) return;
  const articles = visibleTweetArticles();
  const last = articles[articles.length - 1];
  if (last instanceof HTMLElement) {
    try {
      last.scrollIntoView({ block: 'end', behavior: 'auto' });
    } catch {
      // Some environments throw on unimplemented scrolling.
    }
  }
  const scroller = findScrollContainer(last ?? document.documentElement);
  const distance = Math.max((scroller?.clientHeight || window.innerHeight || 800) * 0.9, 480);
  if (scroller && scroller !== document.body && scroller !== document.documentElement) {
    scroller.scrollTop += distance;
  }
  try {
    window.scrollBy({ top: distance, behavior: 'auto' });
  } catch {
    // jsdom logs and throws for unimplemented scrolling.
  }
}

function isJsdom(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('jsdom');
}

const TIMELINE_END_MESSAGE =
  '已到达当前可见列表末尾，或页面不再加载新卡片。这只说明本次扫描停止，不代表历史点赞已全部采集。';

/**
 * Reads the likes timeline from the X tab this script is running in.
 * One captureBatch call collects at most `limit` new posts, then returns so the
 * caller can checkpoint. Pass the previous cursor to keep the seen-id set.
 * Scrolling to a stop is always `partial`: the DOM cannot prove the history is complete.
 */
export class XDomCaptureAdapter implements CaptureAdapter {
  readonly name = 'x_dom';
  private seen = new Set<string>();
  private attemptedRepairs = new Set<string>();
  private replaying = false;

  constructor(private readonly scrollDelayMs = 1200) {}

  resetSession(): void {
    this.seen.clear();
    this.attemptedRepairs.clear();
    this.replaying = false;
  }

  restoreSeenPostIds(postIds: string[]): void {
    for (const postId of postIds.slice(-2000)) {
      if (/^\d{1,25}$/.test(postId)) this.seen.add(postId);
    }
    this.replaying = this.seen.size > 0;
  }

  private async prepareArticle(article: Element, signal?: AbortSignal): Promise<void> {
    const jsdom = isJsdom();
    let delay = 0;
    if (!jsdom && hasUnresolvedMedia(article)) {
      try {
        (article as HTMLElement).scrollIntoView({ block: 'center', behavior: 'auto' });
      } catch {
        // jsdom logs and throws for unimplemented scrolling.
      }
      delay = 400;
    }
    if (revealTruncatedText(article) && !jsdom) {
      delay = 500;
    }
    if (delay > 0) await this.wait(delay, signal);
  }

  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async captureBatch(options: CaptureOptions): Promise<CaptureResult> {
    const { limit, cursor, signal, onProgress, repairPostIds } = options;
    if (!cursor) {
      this.resetSession();
    }

    if (typeof document === 'undefined') {
      return {
        items: [],
        hasMore: false,
        status: 'failed',
        error: 'DOM environment not available in this context',
      };
    }

    if (isXPageUrl(window.location.href) && !isArchiveUrl(window.location.href)) {
      return {
        items: [],
        hasMore: false,
        status: 'failed',
        error: '采集页面已离开点赞或收藏列表。请回到原页面后重新开始。',
      };
    }

    if (signal?.aborted) {
      return {
        items: [],
        hasMore: true,
        status: 'partial',
        error: 'User cancelled sync',
      };
    }

    const initialArticles = visibleTweetArticles();
    const failure = detectCaptureFailure(document, window.location.href);
    if (failure) return { items: [], hasMore: false, status: 'failed', ...failure };
    if (initialArticles.length === 0 && this.seen.size === 0) {
      const currentUrl = window.location.href;
      const onArchive = isArchiveUrl(currentUrl);
      let diagMessage = '当前页面未检测到推文元素。';
      if (!onArchive) {
        diagMessage += ' 请先打开 X 的点赞或收藏 (https://x.com/i/bookmarks)。';
      } else {
        diagMessage += ' 请确认页面已完成加载并已登录 X 账号。';
      }
      return {
        items: [],
        hasMore: false,
        status: 'failed',
        error: diagMessage,
        failureCode: 'page_not_ready',
      };
    }

    const fresh: RawCapturedItem[] = [];
    const repairs: RawCapturedItem[] = [];
    const unparsedCards = new Set<Element>();
    const repairIds = new Set(repairPostIds);
    let consecutiveNoNewItems = 0;
    const maxConsecutiveNoNew = 4;
    let scrollAttempts = 0;
    const replayed = new Set<string>();
    const replaying = this.replaying;
    this.replaying = false;
    const maxScrollAttempts = replaying ? 80 : Math.max(4, Math.ceil(limit / 3) + 4);
    const page = window.location.origin + window.location.pathname;
    const changedPage = () => isXPageUrl(window.location.href) &&
      (!isArchiveUrl(window.location.href) || window.location.origin + window.location.pathname !== page);

    while (fresh.length < limit && scrollAttempts < maxScrollAttempts) {
      const failure = detectCaptureFailure(document, window.location.href);
      if (failure) return { items: fresh, repairs, hasMore: false, status: 'failed', ...failure };
      if (changedPage()) {
        return {
          items: fresh,
          repairs,
          hasMore: false,
          cursor: undefined,
          status: 'failed',
          error: '采集页面已离开点赞或收藏列表，本批已保存，后续读取已停止。',
        };
      }
      if (signal?.aborted) {
        return {
          items: fresh,
          repairs,
          hasMore: true,
          cursor: 'continue',
          status: 'partial',
          error: 'User cancelled sync',
        };
      }

      const articles = visibleTweetArticles();
      let newInThisTurn = 0;

      for (const el of articles) {
        if (signal?.aborted) {
          return {
            items: fresh,
            repairs,
            hasMore: true,
            cursor: 'continue',
            status: 'partial',
            error: 'User cancelled sync',
          };
        }
        const postId = peekPostId(el);
        const repairing = repairIds.has(postId) && !this.attemptedRepairs.has(postId);
        if (!repairing && postId && this.seen.has(postId)) {
          unparsedCards.delete(el);
          if (replaying && !replayed.has(postId)) {
            replayed.add(postId);
            newInThisTurn++;
          }
          continue;
        }
        await this.prepareArticle(el, signal);
        if (changedPage()) {
          return { items: fresh, repairs, hasMore: false, status: 'failed', error: '采集页面已切换。' };
        }
        if (signal?.aborted) {
          return {
            items: fresh,
            repairs,
            hasMore: true,
            cursor: 'continue',
            status: 'partial',
            error: 'User cancelled sync',
          };
        }
        const parsed = parseTweetArticle(el);
        if (parsed) unparsedCards.delete(el);
        else unparsedCards.add(el);
        if (repairing) {
          this.attemptedRepairs.add(postId);
          if (parsed?.postId === postId) {
            this.seen.add(postId);
            repairs.push(parsed);
            newInThisTurn++;
          }
        } else if (parsed && !this.seen.has(parsed.postId)) {
          this.seen.add(parsed.postId);
          fresh.push(parsed);
          newInThisTurn++;
          onProgress?.(this.seen.size);
          if (fresh.length >= limit) {
            break;
          }
        }
      }

      if (fresh.length >= limit) {
        break;
      }

      if (newInThisTurn === 0) {
        consecutiveNoNewItems++;
        if (consecutiveNoNewItems >= maxConsecutiveNoNew) {
          break;
        }
      } else {
        consecutiveNoNewItems = 0;
      }

      scrollFeed();
      scrollAttempts++;
      await this.wait(this.scrollDelayMs, signal);
    }

    if (unparsedCards.size > 0 || (fresh.length === 0 && this.seen.size === 0)) {
      return {
        items: fresh,
        repairs,
        hasMore: false,
        status: 'failed',
        error: '检测到推文卡片，但部分或全部卡片无法解析。可能是页面结构变化，请刷新后重试。',
        failureCode: 'parse_failed',
      };
    }

    const reachedEnd = consecutiveNoNewItems >= maxConsecutiveNoNew;
    const hitLimit = fresh.length >= limit;
    const replayBudgetReached = replaying && scrollAttempts >= maxScrollAttempts && !reachedEnd && !hitLimit;
    if (replayBudgetReached) this.replaying = true;
    const hasMore = !reachedEnd && (hitLimit || replayBudgetReached);

    return {
      items: fresh,
      repairs,
      hasMore,
      cursor: hasMore ? 'continue' : undefined,
      status: 'partial',
      error: reachedEnd ? TIMELINE_END_MESSAGE : undefined,
    };
  }
}
