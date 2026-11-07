import { describe, it, expect, vi } from 'vitest';
import {
  OpenAIClient,
  blobToBase64DataUrl,
} from '../src/ai/openaiClient';
import { buildMultimodalMessages } from '../src/ai/prompt';
import type { NormalizedPost, MediaAsset, AIConfig } from '../src/domain/types';

describe('Multimodal Vision AI Analysis (F06 Enhancement)', () => {
  const samplePost: NormalizedPost = {
    id: 'x:556677',
    platform: 'x',
    postId: '556677',
    canonicalUrl: 'https://x.com/tech_guru/status/556677',
    author: { handle: 'tech_guru', displayName: 'Tech Guru' },
    text: '架构图与执行步骤说明如下，请参考附图。',
    postedAt: '2026-10-18T10:00:00.000Z',
    likedAt: null,
    firstObservedAt: '2026-10-31T00:00:00.000Z',
    lastObservedAt: '2026-10-31T00:00:00.000Z',
    captureStatus: 'complete',
    missingFields: [],
    externalLinks: ['https://github.com/architecture'],
    mediaIds: ['556677_media_0'],
    contentHash: 'hash_vision',
    sourceAdapter: 'fixture',
    sourceRunId: 'run_vision',
    schemaVersion: 1,
  };

  const sampleMedia: MediaAsset = {
    id: '556677_media_0',
    postId: samplePost.id,
    position: 0,
    kind: 'image',
    sourceUrl: 'https://pbs.twimg.com/media/arch.png',
    status: 'downloaded',
    mime: 'image/png',
    blob: new Blob(['fake-image-bytes'], { type: 'image/png' }),
  };

  it('converts image Blob to valid Base64 data URL', async () => {
    const dataUrl = await blobToBase64DataUrl(sampleMedia.blob!);
    expect(dataUrl).toContain('data:image/png;base64,');
  });

  it('builds multimodal messages structure according to OpenAI vision specs', () => {
    const fakeDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE=';
    const messages = buildMultimodalMessages(samplePost, [fakeDataUrl]);

    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');

    const content = messages[1].content;
    expect(Array.isArray(content)).toBe(true);

    const parts = content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('架构图与执行步骤说明');
    expect(parts[0].text).toContain('多模态图片分析');

    expect(parts[1].type).toBe('image_url');
    expect(parts[1].image_url?.url).toBe(fakeDataUrl);
  });

  it('keeps the initial request and format repair text-only when images are disabled', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  titleZh: '推文架构解析',
                  summaryZh: '提炼要点',
                  categories: ['编程开发'],
                  tags: ['架构'],
                  contentType: 'tutorial',
                  steps: ['第一步'],
                  prerequisites: [],
                  usefulLinks: ['https://github.com/architecture'],
                  uncertainties: [],
                  quality: 'high',
                }),
              },
            },
          ],
        }),
      };
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'invalid fixture output' } }] }),
    });

    vi.stubGlobal('fetch', fetchMock);

    const config: AIConfig = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key-mock',
      modelName: 'gpt-4o-mini',
      timeoutSec: 15,
      concurrencyLimit: 1,
      allowSendImages: false, // Disabled!
      sessionOnlyKey: false,
      useMock: false,
    };

    const client = new OpenAIClient(config);
    try {
      await client.analyzePost({ post: samplePost, media: [sampleMedia] });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [, options] of fetchMock.mock.calls) {
        const { messages } = JSON.parse(options.body as string) as { messages: Array<{ role: string; content: unknown }> };
        expect(messages.filter((message) => message.role === 'user').every((message) => typeof message.content === 'string')).toBe(true);
        expect(options.body).not.toContain('image_url');
      }
      expect(fetchMock.mock.calls[1][1].body).not.toContain('invalid fixture output');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends image_url when allowSendImages is explicitly true', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = JSON.parse(options.body as string);
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  titleZh: '推文架构解析',
                  summaryZh: '提炼要点',
                  categories: ['编程开发'],
                  tags: ['架构'],
                  contentType: 'tutorial',
                  steps: ['图解第一步'],
                  prerequisites: [],
                  usefulLinks: ['https://github.com/architecture'],
                  uncertainties: [],
                  quality: 'high',
                }),
              },
            },
          ],
        }),
      };
    });

    vi.stubGlobal('fetch', fetchMock);

    const config: AIConfig = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key-mock',
      modelName: 'gpt-4o-mini',
      timeoutSec: 15,
      concurrencyLimit: 1,
      allowSendImages: true, // Enabled!
      sessionOnlyKey: false,
      useMock: false,
    };

    const client = new OpenAIClient(config);
    await client.analyzePost({ post: samplePost, media: [sampleMedia] });

    expect(capturedBody).not.toBeNull();
    const messages = (capturedBody as unknown as Record<string, unknown>).messages as Array<{ role: string; content: unknown }>;
    const userMessage = messages.find((m) => m.role === 'user');

    expect(Array.isArray(userMessage?.content)).toBe(true);
    const parts = userMessage?.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);

    vi.unstubAllGlobals();
  });
});
