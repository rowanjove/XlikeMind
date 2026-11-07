import { describe, expect, it, vi } from 'vitest';
import { readOpenXAccount } from '../src/ui/signedInX';

function tab(id: number, url: string): chrome.tabs.Tab {
  return { id, url } as chrome.tabs.Tab;
}

describe('open X account username', () => {
  it('reads the username from a background X tab while the extension page is active', async () => {
    vi.mocked(chrome.tabs.query).mockImplementation(async (query) => {
      const spec = query && typeof query === 'object' ? query : {};
      if ('active' in spec) return [tab(9, 'chrome-extension://id/dashboard.html')];
      return [tab(3, 'https://x.com/home')];
    });
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ status: 'ok', xHandle: 'Background_User' });

    await expect(readOpenXAccount()).resolves.toEqual({ status: 'known', handle: 'background_user' });
  });

  it('keeps the active X tab username when another tab is a different account', async () => {
    vi.mocked(chrome.tabs.query).mockImplementation(async (query) => {
      const spec = query && typeof query === 'object' ? query : {};
      if ('active' in spec) return [tab(1, 'https://x.com/home')];
      return [tab(1, 'https://x.com/home'), tab(2, 'https://x.com/home')];
    });
    vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (tabId) => {
      return { status: 'ok', xHandle: tabId === 1 ? 'alpha_user' : 'beta_user' };
    });

    await expect(readOpenXAccount()).resolves.toEqual({ status: 'known', handle: 'alpha_user' });
  });

  it('does not pick a username when background tabs disagree', async () => {
    vi.mocked(chrome.tabs.query).mockImplementation(async (query) => {
      const spec = query && typeof query === 'object' ? query : {};
      if ('active' in spec) return [tab(9, 'https://example.com')];
      return [tab(1, 'https://x.com/home'), tab(2, 'https://twitter.com/home')];
    });
    vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (tabId) => {
      return { status: 'ok', xHandle: tabId === 1 ? 'alpha_user' : 'beta_user' };
    });

    await expect(readOpenXAccount()).resolves.toEqual({ status: 'conflict' });
  });
});
