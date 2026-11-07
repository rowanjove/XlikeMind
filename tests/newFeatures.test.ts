import { describe, it, expect, beforeEach } from 'vitest';
import { isLocalEndpoint, OpenAIClient } from '../src/ai/openaiClient';
import { localDirectorySync } from '../src/sync/localDirSync';
import { db } from '../src/storage/db';

describe('New features and requirements verification', () => {
  beforeEach(async () => {
    await db.posts.clear();
    await db.media.clear();
    await db.syncRuns.clear();
    await db.userOverrides.clear();
    await db.aiAnalysis.clear();
  });

  describe('Local AI Model invocation', () => {
    it('correctly detects local endpoints', () => {
      expect(isLocalEndpoint('http://localhost:11434/v1')).toBe(true);
      expect(isLocalEndpoint('http://127.0.0.1:1234/v1')).toBe(true);
      expect(isLocalEndpoint('http://172.16.0.4:11434/v1')).toBe(true);
      expect(isLocalEndpoint('http://172.15.0.4:11434/v1')).toBe(false);
      expect(isLocalEndpoint('http://0.0.0.0:8080/v1')).toBe(true);
      expect(isLocalEndpoint('https://api.openai.com/v1')).toBe(false);
      expect(isLocalEndpoint('https://api.deepseek.com')).toBe(false);
    });

    it('does not reject local model when apiKey is empty during testConnection validation', async () => {
      const client = new OpenAIClient({
        baseUrl: 'http://127.0.0.1:9999/v1',
        apiKey: '',
        modelName: 'qwen2.5',
        timeoutSec: 1,
        concurrencyLimit: 1,
        allowSendImages: false,
        sessionOnlyKey: false,
        useMock: false,
      });

      // Instead of failing with "未填写 API Key", it proceeds to network call (which fails with connection refusal or timeout)
      const res = await client.testConnection();
      expect(res.success).toBe(false);
      expect(res.message).not.toContain('未填写 API Key');
      expect(res.message).toContain('本地模型服务');
    });
  });

  describe('Local Directory incremental sync interface', () => {
    it('ingests raw records and skips identical records on subsequent runs', async () => {
      const samplePosts = [
        {
          postId: '1001',
          authorHandle: 'alice',
          authorDisplayName: 'Alice',
          text: 'First local test post with code',
        },
        {
          postId: '1002',
          authorHandle: 'bob',
          authorDisplayName: 'Bob',
          text: 'Second local test post about AI',
        },
      ];

      // First sync: 2 added
      const res1 = await localDirectorySync.ingestLocalRecords(samplePosts);
      expect(res1.success).toBe(true);
      expect(res1.stats.scanned).toBe(2);
      expect(res1.stats.added).toBe(2);
      expect(res1.stats.skipped).toBe(0);

      const dbCount1 = await db.posts.count();
      expect(dbCount1).toBe(2);

      // Second sync with identical data: 0 added, 2 skipped (incremental deduplication)
      const res2 = await localDirectorySync.ingestLocalRecords(samplePosts);
      expect(res2.success).toBe(true);
      expect(res2.stats.scanned).toBe(2);
      expect(res2.stats.added).toBe(0);
      expect(res2.stats.skipped).toBe(2);

      const dbCount2 = await db.posts.count();
      expect(dbCount2).toBe(2);

      // Third sync with one new and one existing: 1 added, 1 skipped
      const mixedPosts = [
        samplePosts[0],
        {
          postId: '1003',
          authorHandle: 'charlie',
          authorDisplayName: 'Charlie',
          text: 'Third post',
        },
      ];
      const res3 = await localDirectorySync.ingestLocalRecords(mixedPosts);
      expect(res3.stats.added).toBe(1);
      expect(res3.stats.skipped).toBe(1);
      expect(await db.posts.count()).toBe(3);
    });

    it('does not invent an unknown author over a handle that is already saved', async () => {
      await localDirectorySync.ingestLocalRecords([
        { postId: '1001', authorHandle: 'alice', authorDisplayName: 'Alice', text: '正文保持足够长' },
      ]);
      await localDirectorySync.ingestLocalRecords([
        { postId: '1001', authorHandle: '', text: '正文保持足够长，又补了一句。' },
      ]);
      const saved = await db.posts.get('x:1001');
      expect(saved?.author?.handle).toBe('alice');
      expect(saved?.author?.displayName).toBe('Alice');
    });

    it('drops unsafe links and refuses to overwrite another post id', async () => {
      const result = await localDirectorySync.ingestLocalRecords([
        {
          id: 'x:1001',
          postId: '../1009',
          authorHandle: 'mallory',
          text: 'bad id',
          canonicalUrl: 'javascript:alert(1)',
        },
        {
          id: 'x:owned',
          postId: '1009',
          authorHandle: 'mallory',
          text: 'imported',
          canonicalUrl: 'javascript:alert(1)',
        },
      ]);
      expect(result.stats.failed).toBe(1);
      expect(result.stats.added).toBe(1);
      expect(await db.posts.get('x:owned')).toBeUndefined();
      const saved = await db.posts.get('x:1009');
      expect(saved?.canonicalUrl).toBe('https://x.com/i/web/status/1009');
      expect(saved?.text).toBe('imported');
    });
  });
});
