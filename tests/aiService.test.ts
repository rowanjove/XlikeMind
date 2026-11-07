import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { LikeMindDB } from '../src/storage/db';
import { AIService, DEFAULT_AI_CONFIG } from '../src/ai/aiService';
import { MockAIClient } from '../src/ai/mockClient';
import type { NormalizedPost } from '../src/domain/types';
import type { AIAnalysisPayload } from '../src/ai/schema';
import { SyncService } from '../src/sync/syncService';

describe('AIService Orchestration & Cache Key Protection', () => {
  let testDb: LikeMindDB;
  let service: AIService;

  const samplePost: NormalizedPost = {
    id: 'x:888001',
    platform: 'x',
    postId: '888001',
    canonicalUrl: 'https://x.com/tech/status/888001',
    author: { handle: 'tech', displayName: 'Tech User' },
    text: '分享一个超棒的前端脚手架，使用 TypeScript 构建。',
    postedAt: '2026-10-15T00:00:00Z',
    likedAt: null,
    firstObservedAt: '2026-10-31T00:00:00Z',
    lastObservedAt: '2026-10-31T00:00:00Z',
    captureStatus: 'complete',
    missingFields: [],
    externalLinks: ['https://example.com/project'],
    mediaIds: [],
    contentHash: 'hash_content_888',
    sourceAdapter: 'fixture',
    sourceRunId: 'run_1',
    schemaVersion: 1,
  };

  beforeEach(async () => {
    testDb = new LikeMindDB(`ai_test_${Date.now()}_${Math.random()}`);
    service = new AIService(testDb);
    await testDb.posts.put(samplePost);
  });

  it('analyzes post and saves complete AI record to aiAnalysis table', async () => {
    const mockClient = new MockAIClient('success');
    service.setClient(mockClient);

    const result = await service.analyzePost('x:888001');

    expect(result.status).toBe('complete');
    expect(result.titleZh).toBeDefined();
    expect(result.summaryZh).toBeDefined();

    // Verify stored in Dexie
    const inDb = await testDb.aiAnalysis.get('x:888001');
    expect(inDb).toBeDefined();
    expect(inDb?.status).toBe('complete');
    expect(inDb?.sourceHash).toBe(samplePost.contentHash);

    // Verify original post was NOT mutated
    const postInDb = await testDb.posts.get('x:888001');
    expect(postInDb?.text).toBe(samplePost.text);
  });

  it('prevents repeat charges: skips API call when contentHash, model and promptVersion match', async () => {
    const mockClient = new MockAIClient('success');
    service.setClient(mockClient);

    // Call 1
    await service.analyzePost('x:888001');
    expect(mockClient.callCount).toBe(1);

    // Call 2: should be cached!
    await service.analyzePost('x:888001');
    expect(mockClient.callCount).toBe(1); // Call count didn't increase!

    // Call 3 with force=true: forces API call
    await service.analyzePost('x:888001', { force: true });
    expect(mockClient.callCount).toBe(2);
  });

  it('invalidates an image-only analysis when the saved image changes', async () => {
    const client = new MockAIClient('success');
    service.setClient(client);
    const sync = new SyncService(testDb);
    const raw = { postId: '888002', text: '', mediaUrls: ['https://pbs.twimg.com/media/old.png'] };
    const initial = await sync.refreshPost(raw);
    const config = { ...DEFAULT_AI_CONFIG, useMock: true, allowSendImages: true };
    await service.analyzePost(initial.id, { config });
    const current = await sync.refreshPost({ ...raw, mediaUrls: ['https://pbs.twimg.com/media/new.png'] });
    expect(current.contentHash).not.toBe(initial.contentHash);
    expect(await testDb.aiAnalysis.get(initial.id)).toMatchObject({ status: 'stale' });
    expect(await service.analyzePost(initial.id, { config })).toMatchObject({ status: 'complete', sourceHash: current.contentHash });
    expect(client.callCount).toBe(2);
  });

  it('refreshes cached analysis when an eligible image becomes available', async () => {
    vi.stubGlobal('crypto', webcrypto);
    try {
      const client = new MockAIClient('success');
      service.setClient(client);
      const config = { ...DEFAULT_AI_CONFIG, allowSendImages: true };
      const image = { id: 'fixture-media', postId: samplePost.id, position: 0, kind: 'image' as const,
        sourceUrl: 'https://pbs.twimg.com/media/fixture.png' };
      await testDb.media.put({ ...image, status: 'pending' });
      await service.analyzePost(samplePost.id, { config });
      expect(client.callCount).toBe(1);

      await testDb.media.put({ ...image, status: 'downloaded',
        blob: new NodeBlob(['fixture'], { type: 'image/png' }) as unknown as Blob });
      await service.analyzeBatch([samplePost.id], { config });
      expect(client.callCount).toBe(2);
      expect((await testDb.aiAnalysis.get(samplePost.id))?.imageInputKey).toContain(image.id);
      await service.analyzeBatch([samplePost.id], { config });
      await service.analyzePost(samplePost.id, { config: { ...config, allowSendImages: false } });
      expect(client.callCount).toBe(2);
      await testDb.media.put({ ...image, status: 'downloaded',
        blob: new NodeBlob(['changed'], { type: 'image/png' }) as unknown as Blob });
      await service.analyzeBatch([samplePost.id], { config });
      expect(client.callCount).toBe(3);
      await service.analyzePost(samplePost.id, { config });
      expect(client.callCount).toBe(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('serializes two dashboard instances and rejects stale completion', async () => {
    let tail: Promise<unknown> | undefined;
    const locks = { request: async (name: string, options: LockOptions, task: LockGrantedCallback<unknown>) => {
      if (options.ifAvailable && tail) return task(null);
      const result = Promise.resolve(tail).catch(() => undefined).then(() => task({ name, mode: 'exclusive' }));
      tail = result;
      try {
        return await result;
      } finally {
        if (tail === result) tail = undefined;
      }
    } };
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
    const other = new AIService(testDb);
    const client = new MockAIClient('success');
    service.setClient(client);
    other.setClient(client);
    try {
      await Promise.all([service.analyzePost(samplePost.id), other.analyzePost(samplePost.id)]);
      expect(client.callCount).toBe(1);

      const fail = vi.fn(async () => { throw new Error('Mock API failed'); });
      service.setClient({ name: 'fixture', testConnection: async () => ({ success: true, message: '' }), analyzePost: fail });
      await testDb.aiAnalysis.delete(samplePost.id);
      const [first, concurrent] = await Promise.allSettled([
        service.analyzePost(samplePost.id), other.analyzePost(samplePost.id),
      ]);
      expect(first).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'Mock API failed' }) });
      expect(concurrent).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('手动重试') }) });
      expect(fail).toHaveBeenCalledTimes(1);
      expect(client.callCount).toBe(1);
      expect(await other.analyzePost(samplePost.id)).toMatchObject({ status: 'complete' });
      expect(client.callCount).toBe(2);

      service.setClient({
        name: 'fixture',
        testConnection: async () => ({ success: true, message: '' }),
        analyzePost: async ({ post }) => {
          await testDb.posts.update(post.id, { text: 'updated', contentHash: 'new-hash' });
          return client.analyzePost({ post });
        },
      });
      expect((await service.analyzePost(samplePost.id, { force: true })).status).toBe('stale');
      expect((await testDb.aiAnalysis.get(samplePost.id))?.status).toBe('stale');
    } finally {
      Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it('recovers orphaned processing records without touching active requests or calling the provider', async () => {
    const orphan = samplePost.id;
    const active = 'x:888002';
    const completed = 'x:888003';
    await testDb.aiAnalysis.bulkPut([orphan, active, completed].map((postId) => ({
      postId, sourceHash: samplePost.contentHash, model: 'fixture', promptVersion: 'fixture',
      status: postId === completed ? 'complete' : 'processing', categories: [], tags: [],
    })));
    const request = vi.fn((name: string, _options: LockOptions, task: LockGrantedCallback<Promise<void>>) =>
      task(name.endsWith(active) ? null : { name, mode: 'exclusive' }));
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    const client = new MockAIClient('success');
    service.setClient(client);
    try {
      await service.recoverInterruptedAnalyses();
      expect(await testDb.aiAnalysis.get(orphan)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('中断') });
      expect(await testDb.aiAnalysis.get(active)).toMatchObject({ status: 'processing' });
      expect(await testDb.aiAnalysis.get(completed)).toMatchObject({ status: 'complete' });
      expect(request).toHaveBeenCalledWith(expect.stringMatching(/:x:888001$/), { mode: 'exclusive', ifAvailable: true }, expect.any(Function));
      expect(client.callCount).toBe(0);
    } finally {
      Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it('uses the confirmed endpoint and image policy even if settings changed', async () => {
    const confirmed = { ...DEFAULT_AI_CONFIG, baseUrl: 'http://localhost:11434/v1', allowSendImages: false };
    const payload = await new MockAIClient('success').analyzePost({ post: samplePost });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await service.saveConfig({ ...confirmed, baseUrl: 'http://127.0.0.1:1234/v1', allowSendImages: true });
      await service.analyzeBatch([samplePost.id], { config: confirmed });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
      expect(fetchMock.mock.calls[0][1].body).not.toContain('image_url');
    } finally {
      await service.saveConfig(DEFAULT_AI_CONFIG);
      vi.unstubAllGlobals();
    }
  });

  it('records failed status and reason when AI client errors out', async () => {
    const mockClient = new MockAIClient('simulate_429');
    service.setClient(mockClient);

    await expect(service.analyzePost('x:888001')).rejects.toThrow(/429/);

    const inDb = await testDb.aiAnalysis.get('x:888001');
    expect(inDb).toBeDefined();
    expect(inDb?.status).toBe('failed');
    expect(inDb?.failureCode).toBe('request');
    expect(inDb?.failureReason).toContain('429');
  });

  it('records response format and result storage failures separately', async () => {
    service.setClient(new MockAIClient('simulate_malformed_json'));
    await expect(service.analyzePost(samplePost.id)).rejects.toThrow();
    expect(await testDb.aiAnalysis.get(samplePost.id)).toMatchObject({ failureCode: 'response_format' });

    service.setClient(new MockAIClient());
    const table = testDb.aiAnalysis;
    const put = table.put.bind(table);
    const spy = vi.spyOn(table, 'put').mockImplementation((record) => {
      if (record.status === 'complete') throw new Error('local storage failure');
      return put(record);
    });
    try {
      await expect(service.analyzePost(samplePost.id)).rejects.toThrow();
      expect(await table.get(samplePost.id)).toMatchObject({ status: 'failed', failureCode: 'storage' });
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps only source-grounded AI links and records rejected links as uncertainties', async () => {
    const payload: AIAnalysisPayload = {
      titleZh: '来源链接测试',
      summaryZh: '只保留原文链接。',
      categories: ['综合知识'],
      tags: [],
      contentType: 'other',
      steps: [],
      prerequisites: [],
      usefulLinks: ['https://example.com/project', 'https://untrusted.example/added-by-model'],
      uncertainties: [],
      risksAndLimits: ['仅支持原文列出的版本'],
      quality: 'medium',
    };
    service.setClient({
      name: 'fixture',
      testConnection: async () => ({ success: true, message: 'ok' }),
      analyzePost: async () => payload,
    });

    const result = await service.analyzePost(samplePost.id);

    expect(result.usefulLinks).toEqual(['https://example.com/project']);
    expect(result.risksAndLimits).toEqual(['仅支持原文列出的版本']);
    expect(result.uncertainties).toContain('AI 返回了 1 个原文未出现的链接，已移出可追溯资源列表。');
  });

  it('batch analyzes multiple posts and reports progress and results', async () => {
    // Add two more posts
    await testDb.posts.put({ ...samplePost, id: 'x:888002', postId: '888002' });
    await testDb.posts.put({ ...samplePost, id: 'x:888003', postId: '888003' });

    const mockClient = new MockAIClient('success');
    service.setClient(mockClient);

    const progressUpdates: number[] = [];
    const res = await service.analyzeBatch(['x:888001', 'x:888002', 'x:888003'], {
      onProgress: (p) => progressUpdates.push(p.current),
    });

    expect(res.succeeded).toBe(3);
    expect(res.failed).toBe(0);
    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(await testDb.aiAnalysis.count()).toBe(3);
  });

  it('limits each batch after deduplication and reuses cached results to advance', async () => {
    const ids = ['x:888001', 'x:888002', 'x:888003'];
    await testDb.posts.bulkPut(ids.slice(1).map((id) => ({ ...samplePost, id, postId: id.slice(2) })));
    const client = new MockAIClient('success');
    const analyze = vi.spyOn(client, 'analyzePost');
    service.setClient(client);
    const config = { ...DEFAULT_AI_CONFIG, batchLimit: 1 };
    const progress = vi.fn();
    await service.analyzeBatch([ids[0], ...ids], { config, onProgress: progress });
    expect(analyze).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ total: 1, deferred: 2, succeeded: 1 }));
    await service.analyzeBatch(ids, { config, onProgress: progress });
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(analyze.mock.calls[1][0].post.id).toBe(ids[1]);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ total: 1, deferred: 1, skipped: 1 }));
    const analysis = (await testDb.aiAnalysis.get(ids[1]))!;
    await testDb.aiAnalysis.put({ ...analysis, status: 'failed' });
    await service.analyzeBatch(ids, { config, failedOnly: true });
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(analyze.mock.calls[2][0].post.id).toBe(ids[1]);
    expect(await testDb.aiAnalysis.get(ids[2])).toBeUndefined();
  });

  it('respects abort signal during batch analysis', async () => {
    await testDb.posts.put({ ...samplePost, id: 'x:888002', postId: '888002' });
    await testDb.posts.put({ ...samplePost, id: 'x:888003', postId: '888003' });

    const mockClient = new MockAIClient('success');
    service.setClient(mockClient);

    const controller = new AbortController();
    controller.abort(); // Pre-abort

    const res = await service.analyzeBatch(['x:888001', 'x:888002', 'x:888003'], {
      signal: controller.signal,
    });

    expect(res.succeeded).toBe(0);
  });

  it('preserves a previous summary on user cancellation even when a response arrives late', async () => {
    const client = new MockAIClient('success');
    service.setClient(client);
    const saved = await service.analyzePost(samplePost.id);
    const payload = await client.analyzePost({ post: samplePost });
    const controller = new AbortController();
    vi.spyOn(client, 'analyzePost').mockImplementationOnce(async () => {
      controller.abort();
      return { ...payload, summaryZh: 'late response' };
    });
    const progress = vi.fn();
    expect(await service.analyzeBatch([samplePost.id], { force: true, signal: controller.signal, onProgress: progress }))
      .toEqual({ succeeded: 0, failed: 0, skipped: 0 });
    expect(await testDb.aiAnalysis.get(samplePost.id)).toEqual(saved);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'cancelled', current: 0 }));
  });

  it('leaves a cancelled first analysis available for another attempt', async () => {
    const client = new MockAIClient('success');
    service.setClient(client);
    const controller = new AbortController();
    vi.spyOn(client, 'analyzePost').mockImplementationOnce(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(service.analyzePost(samplePost.id, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await testDb.aiAnalysis.get(samplePost.id)).toBeUndefined();
    expect(await service.analyzePost(samplePost.id)).toMatchObject({ status: 'complete' });
  });

  it('does not pretend to analyze when mock mode is off and no API key is saved', async () => {
    await service.saveConfig({ ...DEFAULT_AI_CONFIG, apiKey: '', useMock: false, sessionOnlyKey: false });
    await expect(service.analyzeBatch(['x:888001'])).rejects.toThrow(/API Key/);
    expect(await testDb.aiAnalysis.get('x:888001')).toBeUndefined();
  });

  it('sessionOnlyKey retains key in memory without persisting to chrome.storage.local', async () => {
    const secretKey = 'sk-session-only-secret-key-xyz';

    await service.saveConfig({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: secretKey,
      modelName: 'gpt-4o-mini',
      timeoutSec: 30,
      concurrencyLimit: 2,
      allowSendImages: false,
      sessionOnlyKey: true,
      useMock: false,
    });

    // Retrieved config in this session has the key
    const currentCfg = await service.getConfig();
    expect(currentCfg.apiKey).toBe(secretKey);

    // But verify what got sent to storage mock has empty apiKey
    const storageMock = chrome.storage.local.set as unknown as {
      mock: { calls: Array<[Record<string, { apiKey: string }>]> };
    };
    const storageCall = storageMock.mock.calls[storageMock.mock.calls.length - 1][0];
    expect(storageCall.ai_config.apiKey).toBe(''); // Not stored on disk!
    const failedWrite = vi.spyOn(chrome.storage.local, 'set').mockRejectedValueOnce(new Error('fixture write failure'));
    try {
      await expect(service.saveConfig({ ...currentCfg, apiKey: '', sessionOnlyKey: false })).rejects.toThrow('fixture write failure');
      expect(await service.getConfig()).toEqual(currentCfg);
    } finally {
      failedWrite.mockRestore();
    }
  });
});
