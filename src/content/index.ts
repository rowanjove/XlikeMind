import { completeCapture } from './completionNotice';
import { isArchiveUrl, isBookmarksUrl, isLikesUrl } from '../adapters/findLikesTab';
import { rememberVisiblePostIds, XDomCaptureAdapter, visibleTweetArticles, peekPostId } from '../adapters/xDomAdapter';
import { createSyncClient, explainSaveError, SYNC_PORT_NAME } from '../messaging/syncClient';
import { runReadingSession, type ReadingCheckpoint, type ReadingTransport } from './readSession';
import { parseTweetArticle, revealTruncatedText } from '../adapters/xDomParser';
import { DEFAULT_PROFILE_ID, profileStorageKey } from '../storage/profileScope';
import { readSignedInXHandle } from '../adapters/xAccount';
import { detectCaptureFailure } from '../adapters/captureFailure';
import { normalizeScanLimit } from '../adapters/captureLimits';

console.debug('[LikeMind] Content script ready');

let adapter = new XDomCaptureAdapter();
let activeAbortController: AbortController | null = null;
let reading = false;
let sessionToken = 0;
let activeProfileId = DEFAULT_PROFILE_ID;
const seenOnPage = new Set<string>();
let seenPageUrl = '';
const READING_CHECKPOINT_KEY = 'likemind_reading_checkpoint';

function archivePageKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

async function loadReadingCheckpoint(key: string, runId: string): Promise<ReadingCheckpoint | null> {
  try {
    const result = await chrome.storage.local.get(key);
    const value = result?.[key] as Partial<ReadingCheckpoint & { runId: string }> | undefined;
    if (value?.runId !== runId || !Array.isArray(value.seenPostIds)) return null;
    return {
      cursor: typeof value.cursor === 'string' ? value.cursor : undefined,
      seenPostIds: value.seenPostIds.filter((id): id is string => typeof id === 'string').slice(-2000),
      anchorPostId: typeof value.anchorPostId === 'string' ? value.anchorPostId : undefined,
    };
  } catch {
    return null;
  }
}

async function saveReadingCheckpoint(key: string, checkpoint: ReadingCheckpoint, runId: string): Promise<void> {
  try {
    await chrome.storage.local.set({
      [key]: {
        ...checkpoint,
        runId,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch {
    // Checkpoint storage is best effort. The service worker still checkpoints every batch.
  }
}

async function clearReadingCheckpoint(key: string, runId: string): Promise<void> {
  try {
    if (await loadReadingCheckpoint(key, runId)) await chrome.storage.local.remove(key);
  } catch {
    // Ignore storage teardown while the tab is closing.
  }
}

function observedCount(): number {
  const href = typeof window === 'undefined' ? '' : window.location?.href || '';
  if (!href) return visibleTweetArticles().length;
  if (href !== seenPageUrl) {
    seenPageUrl = href;
    seenOnPage.clear();
  }
  const remembered = rememberVisiblePostIds(seenOnPage);
  return remembered > 0 ? remembered : visibleTweetArticles().length;
}

function watchTimeline(): void {
  if (typeof document === 'undefined' || !document.body) return;
  let timer = 0;
  const note = () => {
    if (typeof window === 'undefined') return;
    if (!isArchiveUrl(window.location.href)) return;
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      try {
        observedCount();
      } catch {
        // The tab can close while a mutation is still flushing.
      }
    }, 400);
  };
  document.addEventListener('scroll', note, true);
  const observer = new MutationObserver(note);
  observer.observe(document.body, { childList: true, subtree: true });
}

watchTimeline();

const syncClient = createSyncClient(
  () => chrome.runtime.connect({ name: SYNC_PORT_NAME }),
  () => chrome.runtime.lastError?.message
);

const transport: ReadingTransport = {
  async begin(targetLimit, downloadMedia, profileId = activeProfileId) {
    try {
      const url = window.location.href;
      const source = isBookmarksUrl(url) ? 'x_bookmarks' : isLikesUrl(url) ? 'x_likes' : undefined;
      const xHandle = readSignedInXHandle(document, url);
      const reply = await syncClient.request({ type: 'BEGIN_X_SYNC', targetLimit, downloadMedia, source, profileId, xHandle });
      return {
        ...reply,
        error: reply.success && reply.runId ? undefined : explainSaveError(reply.error),
      };
    } catch (err) {
      return { success: false, error: explainSaveError(err instanceof Error ? err.message : String(err)) };
    }
  },
  async ingest(runId, items, profileId = activeProfileId, repairs) {
    try {
      const xHandle = readSignedInXHandle(document, window.location.href);
      return await syncClient.request({ type: 'INGEST_X_BATCH', runId, items, repairs, profileId, xHandle }, 120_000);
    } catch (err) {
      return { success: false, error: explainSaveError(err instanceof Error ? err.message : String(err)) };
    }
  },
  async finish(runId, outcome, profileId = activeProfileId) {
    const reply = await syncClient.request({ type: 'FINISH_X_SYNC', runId, ...outcome, profileId });
    if (!reply.success) throw new Error(reply.error || '保存任务状态失败');
    if (!outcome.paused && !outcome.cancelled &&
      (reply.status === 'completed' || reply.status === 'partial' || reply.status === 'failed') && reply.scanned !== undefined) {
      await completeCapture(profileId, reply.status, { scanned: reply.scanned, added: reply.added ?? 0, updated: reply.updated ?? 0, skipped: reply.skipped ?? 0, failed: reply.failed ?? 0 }).catch(() => undefined);
    }
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({
      status: 'ok',
      url: window.location.href,
      isLikesPage: isArchiveUrl(window.location.href),
      articlesCount: observedCount(),
      failureCode: detectCaptureFailure(document, window.location.href)?.failureCode,
      reading,
      profileId: reading ? activeProfileId : undefined,
      xHandle: readSignedInXHandle(document, window.location.href),
    });
    return false;
  }

  if (message.type === 'START_READING') {
    if (reading) {
      const requestedProfileId = typeof message.profileId === 'string' && message.profileId.trim()
        ? message.profileId
        : DEFAULT_PROFILE_ID;
      sendResponse({
        started: false,
        reason: requestedProfileId === activeProfileId ? 'already-reading' : 'reading-other-profile',
        activeProfileId,
      });
      return false;
    }
    const failure = detectCaptureFailure(document, window.location.href);
    if (failure) {
      sendResponse({ started: false, reason: failure.error });
      return false;
    }
    if (!isArchiveUrl(window.location.href)) {
      sendResponse({ started: false, reason: '当前标签不是点赞或收藏页' });
      return false;
    }
    if (observedCount() === 0) {
      sendResponse({ started: false, reason: '页面上还没有帖子' });
      return false;
    }

    sessionToken += 1;
    const token = sessionToken;
    activeAbortController?.abort();
    const controller = new AbortController();
    activeAbortController = controller;
    adapter = new XDomCaptureAdapter();
    reading = true;
    const limit = normalizeScanLimit(message.limit);
    const downloadMedia = message.downloadMedia !== false;
    const sessionProfileId = typeof message.profileId === 'string' && message.profileId.trim()
      ? message.profileId
      : DEFAULT_PROFILE_ID;
    activeProfileId = sessionProfileId;

    const page = archivePageKey(window.location.href);
    const key = profileStorageKey(`${READING_CHECKPOINT_KEY}:${page}`, sessionProfileId);
    const sessionAdapter = adapter;
    void (async () => {
      let activeRunId: string | undefined;
      const completed = await runReadingSession(
        (options) => archivePageKey(window.location.href) === page
          ? sessionAdapter.captureBatch(options)
          : Promise.resolve({ items: [], hasMore: false, status: 'failed', error: '采集页面已切换。' }),
        transport,
        {
          limit,
          downloadMedia,
          signal: controller.signal,
          profileId: sessionProfileId,
          onStart: sendResponse,
          loadCheckpoint: async (runId, seenPostIds) => {
            activeRunId = runId;
            const checkpoint = seenPostIds
              ? { cursor: 'continue', seenPostIds }
              : await loadReadingCheckpoint(key, runId);
            if (checkpoint) sessionAdapter.restoreSeenPostIds(checkpoint.seenPostIds);
            return checkpoint;
          },
          onCheckpoint: (next, runId) => saveReadingCheckpoint(key, next, runId),
        }
      );
      if (completed && activeRunId) await clearReadingCheckpoint(key, activeRunId);
    })()
      .catch(() => {
        console.error('[LikeMind] Capture session stopped before finishing');
      })
      .finally(() => {
        if (token === sessionToken) {
          reading = false;
          activeProfileId = DEFAULT_PROFILE_ID;
        }
      });
    return true;
  }

  if (message.type === 'CAPTURE_STEP') {
    if (reading) {
      sendResponse({ success: false, error: '弹窗正在读取点赞页，请先停止后再从控制台采集。' });
      return false;
    }
    if (message.reset) {
      activeAbortController?.abort();
      adapter = new XDomCaptureAdapter();
      activeAbortController = new AbortController();
    }
    if (!activeAbortController) {
      activeAbortController = new AbortController();
    }

    const limit = typeof message.limit === 'number' && message.limit > 0 ? message.limit : 25;
    adapter
      .captureBatch({
        limit,
        cursor: message.reset ? undefined : 'continue',
        signal: activeAbortController.signal,
      })
      .then((result) => {
        sendResponse({ success: true, result });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return true;
  }

  if (message.type === 'PAUSE_READING') {
    if (
      reading &&
      typeof message.profileId === 'string' &&
      message.profileId !== activeProfileId
    ) {
      sendResponse({ status: 'ignored', error: '当前读取属于另一个档案' });
      return false;
    }
    if (!reading) {
      sendResponse({ status: 'idle' });
      return false;
    }
    activeAbortController?.abort('pause');
    sendResponse({ status: 'paused' });
    return undefined;
  }

  if (message.type === 'STOP_READING' || message.type === 'STOP_DOM_CAPTURE') {
    if (
      reading &&
      typeof message.profileId === 'string' &&
      message.profileId !== activeProfileId
    ) {
      sendResponse({ status: 'ignored', error: '当前读取属于另一个档案' });
      return false;
    }
    activeAbortController?.abort();
    sendResponse({ status: 'stopped' });
    return undefined;
  }

  if (message.type === 'RELOAD_SINGLE_POST') {
    const targetPostId = String(message.postId || '').trim();
    if (!targetPostId) {
      sendResponse({ success: false, error: '缺少推文编号' });
      return false;
    }

    const articles = visibleTweetArticles();
    let targetArticle: Element | null = null;
    for (const el of articles) {
      const pid = peekPostId(el);
      if (pid === targetPostId) {
        targetArticle = el;
        break;
      }
    }

    // If not found in feed list, check if this tab is the tweet's detail page
    if (!targetArticle && window.location.href.includes(targetPostId)) {
      if (articles.length > 0) targetArticle = articles[0];
    }

    if (!targetArticle) {
      sendResponse({
        success: false,
        error: '当前标签页中未找到该推文。请确认页面已加载该推文或已打开原帖。',
      });
      return false;
    }

    // Reveal truncated lines (click "Show more" without navigation)
    revealTruncatedText(targetArticle);

    // Give DOM a tick if show-more was triggered, then parse
    setTimeout(() => {
      try {
        const parsed = parseTweetArticle(targetArticle!);
        if (!parsed) {
          sendResponse({ success: false, error: '无法解析该推文内容' });
          return;
        }
        sendResponse({ success: true, item: parsed });
      } catch (err) {
        sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }, 150);

    return true; // Keep reply channel open for async setTimeout
  }

  // Unknown messages belong to the service worker. Returning false here can
  // answer the sender with null before the worker's reply arrives.
  return undefined;
});
