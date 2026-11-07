import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/content/readSession', () => ({
  runReadingSession: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock('../src/adapters/findLikesTab', () => ({
  isLikesUrl: () => true,
  isBookmarksUrl: () => false,
  isArchiveUrl: () => true,
}));

import { runReadingSession } from '../src/content/readSession';
import '../src/content/index';
const registeredListener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0];

type Listener = (
  message: { type?: string; limit?: number; downloadMedia?: boolean; profileId?: string },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => boolean | void;

function listener(): Listener {
  const fn = registeredListener;
  if (!fn) throw new Error('content listener missing');
  return fn as Listener;
}

describe('content script reading controls', () => {
  it('pings, refuses an empty page, then restores the scoped checkpoint and can be stopped', async () => {
    document.body.innerHTML = '';
    const sendResponse = vi.fn();
    const onMessage = listener();

    onMessage({ type: 'PING' }, {} as chrome.runtime.MessageSender, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ok', reading: false, articlesCount: 0, xHandle: undefined })
    );

    sendResponse.mockClear();
    onMessage({ type: 'PAUSE_READING' }, {} as chrome.runtime.MessageSender, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ status: 'idle' });

    sendResponse.mockClear();
    onMessage({ type: 'START_READING', limit: 50 }, {} as chrome.runtime.MessageSender, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ started: false, reason: expect.stringContaining('帖子') })
    );
    expect(runReadingSession).not.toHaveBeenCalled();

    document.body.innerHTML = `
      <article data-testid="tweet">
        <a href="/user/status/1"><time datetime="2026-01-01T00:00:00.000Z"></time></a>
        <div data-testid="tweetText">可见帖子</div>
      </article>
    `;
    const profileId = '11111111-1111-4111-8111-111111111111';
    const checkpoint = { cursor: 'continue', seenPostIds: ['42'] };
    await chrome.storage.local.set({
      [`likemind_reading_checkpoint:http://localhost:3000/:${profileId}`]: { ...checkpoint, runId: 'run_paused' },
    });
    vi.mocked(runReadingSession).mockImplementationOnce(async (_capture, _transport, options) => {
      options.onStart?.({ started: true });
      return new Promise(() => undefined);
    });
    sendResponse.mockClear();
    onMessage(
      { type: 'START_READING', limit: 50, downloadMedia: true, profileId },
      {} as chrome.runtime.MessageSender,
      sendResponse
    );
    expect(sendResponse).toHaveBeenCalledWith({ started: true });
    await vi.waitFor(() => expect(runReadingSession).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Object),
      expect.objectContaining({ limit: 50, downloadMedia: true, profileId })
    ));
    const options = vi.mocked(runReadingSession).mock.calls[0][2];
    await expect(options.loadCheckpoint?.('run_new')).resolves.toBeNull();
    await expect(options.loadCheckpoint?.('run_paused')).resolves.toMatchObject(checkpoint);

    sendResponse.mockClear();
    onMessage({ type: 'PING' }, {} as chrome.runtime.MessageSender, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ reading: true, articlesCount: 1 }));

    const signal = vi.mocked(runReadingSession).mock.calls[0]?.[2]?.signal;
    sendResponse.mockClear();
    onMessage({ type: 'PAUSE_READING', profileId: '22222222-2222-4222-8222-222222222222' }, {} as chrome.runtime.MessageSender, sendResponse);
    expect(signal?.aborted).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 'ignored' }));
    onMessage({ type: 'STOP_READING', profileId: '22222222-2222-4222-8222-222222222222' }, {} as chrome.runtime.MessageSender, sendResponse);
    expect(signal?.aborted).toBe(false);
    onMessage({ type: 'STOP_READING', profileId }, {} as chrome.runtime.MessageSender, sendResponse);
    expect(signal?.aborted).toBe(true);
  });
});
