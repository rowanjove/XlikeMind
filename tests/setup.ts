import { vi } from 'vitest';
import 'fake-indexeddb/auto';

const mockStorage: Record<string, unknown> = {};

// Global chrome API mock for testing
(globalThis as unknown as Record<string, unknown>).chrome = {
  runtime: {
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    getURL: (path: string) => `chrome-extension://mock-extension-id/${path}`,
  },
  storage: {
    local: {
      get: vi.fn().mockImplementation((keys: unknown, callback?: (res: Record<string, unknown>) => void) => {
        const res: Record<string, unknown> = {};
        if (typeof keys === 'string') {
          res[keys] = mockStorage[keys];
        } else if (Array.isArray(keys)) {
          for (const k of keys) res[k] = mockStorage[k];
        } else if (keys && typeof keys === 'object') {
          for (const k of Object.keys(keys)) {
            res[k] = mockStorage[k] !== undefined ? mockStorage[k] : (keys as Record<string, unknown>)[k];
          }
        } else {
          Object.assign(res, mockStorage);
        }
        if (callback) callback(res);
        return Promise.resolve(res);
      }),
      set: vi.fn().mockImplementation((items: Record<string, unknown>, callback?: () => void) => {
        Object.assign(mockStorage, items);
        if (callback) callback();
        return Promise.resolve();
      }),
    },
  },
  tabs: {
    query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://x.com/i/history/likes' }]),
    sendMessage: vi.fn().mockResolvedValue({ status: 'ok' }),
    create: vi.fn().mockResolvedValue({ id: 2 }),
  },
  downloads: {
    download: vi.fn().mockResolvedValue(100),
  },
};
