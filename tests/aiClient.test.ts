import { describe, it, expect, vi } from 'vitest';
import { sanitizeErrorMessage } from '../src/ai/client';
import { MockAIClient } from '../src/ai/mockClient';
import { OpenAIClient, isLocalEndpoint } from '../src/ai/openaiClient';
import type { NormalizedPost } from '../src/domain/types';
import { DEFAULT_AI_CONFIG } from '../src/ai/aiService';
import { AIResponseFormatError } from '../src/ai/schema';

describe('AI Clients & Key Leakage Prevention', () => {
  const secretKey = 'sk-proj-super-secret-key-1234567890abcdef';

  const mockPost: NormalizedPost = {
    id: 'x:999001',
    platform: 'x',
    postId: '999001',
    canonicalUrl: 'https://x.com/dev/status/999001',
    text: '分享一个超棒的前端工具：使用 npx create-likemind-app 快速构建！',
    postedAt: '2026-10-31T00:00:00Z',
    likedAt: null,
    firstObservedAt: '2026-10-31T00:00:00Z',
    lastObservedAt: '2026-10-31T00:00:00Z',
    captureStatus: 'complete',
    missingFields: [],
    externalLinks: ['https://example.com/tool'],
    mediaIds: [],
    contentHash: 'hash_test_1',
    sourceAdapter: 'fixture',
    sourceRunId: 'run_1',
    schemaVersion: 1,
  };

  describe('sanitizeErrorMessage', () => {
    it('completely removes raw API key string from error messages', () => {
      const err = new Error(`Request failed with Bearer ${secretKey} at https://api.openai.com/v1`);
      const safe = sanitizeErrorMessage(err, secretKey);
      expect(safe).not.toContain(secretKey);
      expect(safe).toContain('***[REDACTED_API_KEY]***');
    });

    it('redacts generic bearer authorization headers', () => {
      const err = 'Failed header: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
      const safe = sanitizeErrorMessage(err);
      expect(safe).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(safe).toContain('Bearer ***[REDACTED]***');
    });
  });

  describe('MockAIClient', () => {
    it('generates rich, structured output for coding post', async () => {
      const client = new MockAIClient('success');
      const result = await client.analyzePost({ post: mockPost });

      expect(result.titleZh).toContain('前端');
      expect(result.summaryZh).toBeDefined();
      expect(result.steps.length).toBeGreaterThan(0);
      expect(result.categories).toContain('编程开发');
      expect(result.tags).toContain('TypeScript');
    });

    it('simulates 401 Unauthorized cleanly', async () => {
      const client = new MockAIClient('simulate_401');
      await expect(client.analyzePost({ post: mockPost })).rejects.toThrow(/401/);
    });

    it('simulates 429 Rate Limit cleanly', async () => {
      const client = new MockAIClient('simulate_429');
      await expect(client.analyzePost({ post: mockPost })).rejects.toThrow(/429/);
    });

    it('simulates 500 Server Error cleanly', async () => {
      const client = new MockAIClient('simulate_500');
      await expect(client.analyzePost({ post: mockPost })).rejects.toThrow(/500/);
    });

    it('simulates Timeout cleanly', async () => {
      const client = new MockAIClient('simulate_timeout');
      await expect(client.analyzePost({ post: mockPost })).rejects.toThrow(/timed out/i);
    });
  });

  describe('OpenAIClient Network & Sanitization', () => {
    it('requires a model message before reporting a successful connection', async () => {
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('<html>proxy health page</html>'))
        .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] })));
      vi.stubGlobal('fetch', fetchMock);
      try {
        const client = new OpenAIClient({ ...DEFAULT_AI_CONFIG, baseUrl: 'http://127.0.0.1:1234/v1' });
        expect(await client.testConnection()).toMatchObject({ success: false });
        expect(await client.testConnection()).toMatchObject({ success: true });
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
      } finally {
        vi.unstubAllGlobals();
      }
    });
    it('repairs invalid output once using the original approved input and a shared timeout', async () => {
      const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(reply(`bad JSON containing ${secretKey}`))
        .mockResolvedValueOnce(reply(JSON.stringify({ titleZh: '标题', summaryZh: '摘要', risksAndLimits: ['已知限制'] })));
      vi.stubGlobal('fetch', fetchMock);
      try {
        const client = new OpenAIClient({ ...DEFAULT_AI_CONFIG, apiKey: secretKey });
        expect(await client.analyzePost({ post: mockPost })).toMatchObject({ risksAndLimits: ['已知限制'] });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [first, repair] = fetchMock.mock.calls;
        expect(repair[0]).toBe(first[0]);
        expect(repair[1]?.signal).toBe(first[1]?.signal);
        const repairBody = String(repair[1]?.body);
        expect(repairBody).toContain('上一次输出无法通过结构校验');
        expect(repairBody).not.toContain(secretKey);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('stops after one unsuccessful repair and does not retry a rate limit', async () => {
      const fetchMock = vi.fn<typeof fetch>()
        .mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'invalid' } }] })));
      vi.stubGlobal('fetch', fetchMock);
      try {
        const client = new OpenAIClient({ ...DEFAULT_AI_CONFIG, apiKey: secretKey });
        await expect(client.analyzePost({ post: mockPost })).rejects.toBeInstanceOf(AIResponseFormatError);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        fetchMock.mockClear().mockImplementation(async () => new Response('rate limit', { status: 429 }));
        await expect(client.analyzePost({ post: mockPost })).rejects.toThrow(/429/);
        expect(fetchMock).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('applies the configured timeout even when an external abort signal is supplied', async () => {
      const client = new OpenAIClient({
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: '',
        modelName: 'local-model',
        timeoutSec: 0.01,
        concurrencyLimit: 1,
        allowSendImages: false,
        sessionOnlyKey: false,
        useMock: false,
      });
      const originalFetch = globalThis.fetch;
      let requestSignal: AbortSignal | undefined;
      globalThis.fetch = vi.fn((_url, init) => {
        requestSignal = init?.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }) as typeof fetch;
      try {
        await expect(client.analyzePost({ post: mockPost, signal: new AbortController().signal })).rejects.toThrow(
          /aborted/
        );
        expect(requestSignal?.aborted).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('does not classify a hostname that merely starts with a private IPv4 prefix as local', () => {
      expect(isLocalEndpoint('http://10.example.test/v1')).toBe(false);
      expect(isLocalEndpoint('http://10.0.0.5/v1')).toBe(true);
      expect(isLocalEndpoint('http://172.32.0.1/v1')).toBe(false);
    });

    it('catches network errors without leaking API key', async () => {
      const client = new OpenAIClient({
        baseUrl: 'https://invalid-non-existent-ai-provider.test',
        apiKey: secretKey,
        modelName: 'gpt-4o-mini',
        timeoutSec: 2,
        concurrencyLimit: 2,
        allowSendImages: false,
        sessionOnlyKey: false,
        useMock: false,
      });

      // Mock global fetch to simulate failure with secretKey in response body
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: vi.fn().mockResolvedValue(`Invalid API key: ${secretKey}`),
      });

      try {
        const testRes = await client.testConnection();
        expect(testRes.success).toBe(false);
        // Crucial test: error message must NOT contain the secret key!
        expect(testRes.message).not.toContain(secretKey);
        expect(testRes.message).toContain('***[REDACTED_API_KEY]***');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
