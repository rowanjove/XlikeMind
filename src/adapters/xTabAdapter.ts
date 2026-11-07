import type { CaptureAdapter, CaptureOptions, CaptureResult } from './types';

/**
 * Runs in the dashboard. Each batch asks the likes tab's content script
 * to collect one bounded step, so IndexedDB can checkpoint between steps.
 */
export class XTabCaptureAdapter implements CaptureAdapter {
  readonly name = 'x_dom';

  constructor(private readonly tabId: number) {}

  private stopRemote(): void {
    chrome.tabs.sendMessage(this.tabId, { type: 'STOP_DOM_CAPTURE' }).catch(() => undefined);
  }

  async captureBatch(options: CaptureOptions): Promise<CaptureResult> {
    if (options.signal?.aborted) {
      this.stopRemote();
      return {
        items: [],
        hasMore: false,
        status: 'partial',
        error: 'User cancelled sync',
      };
    }

    const onAbort = () => this.stopRemote();
    options.signal?.addEventListener('abort', onAbort);

    try {
      const response = (await chrome.tabs.sendMessage(this.tabId, {
        type: 'CAPTURE_STEP',
        limit: options.limit,
        reset: !options.cursor,
      })) as { success?: boolean; result?: CaptureResult; error?: string } | undefined;

      if (!response?.success || !response.result) {
        return {
          items: [],
          hasMore: false,
          status: 'failed',
          error: response?.error || '无法与 X 页面建立连接。请刷新点赞页后重试。',
        };
      }

      return response.result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        items: [],
        hasMore: false,
        status: 'failed',
        error: message.includes('Receiving end does not exist')
          ? '点赞页还没有注入采集脚本。请刷新 https://x.com/i/history/likes 后重试。'
          : message,
      };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}
