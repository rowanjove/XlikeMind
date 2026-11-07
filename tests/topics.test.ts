import { PROMPT_VERSION } from '../src/domain/analysis';
import { describe, it, expect } from 'vitest';
import {
  buildTopicSummaries,
  generateTopicSynthesis,
  generateTopicMarkdown,
  getPostTopics,
} from '../src/domain/topics';
import { buildIncrementalDigest, generateDigestMarkdown } from '../src/domain/digests';
import type { NormalizedPost, UserOverrides, AIAnalysis, SyncRun } from '../src/domain/types';

describe('Topics Knowledge Synthesis & Incremental Digests (M3)', () => {
  const post1: NormalizedPost = {
    id: 'x:1001',
    platform: 'x',
    postId: '1001',
    canonicalUrl: 'https://x.com/tech/status/1001',
    author: { handle: 'alice', displayName: 'Alice' },
    text: '分享一个超棒的前端脚手架，基于 TypeScript 和 Vite 构建。',
    postedAt: '2026-10-15T00:00:00Z',
    likedAt: null,
    firstObservedAt: '2026-10-31T01:00:00Z',
    lastObservedAt: '2026-10-31T01:00:00Z',
    captureStatus: 'complete',
    missingFields: [],
    externalLinks: ['https://vite.dev'],
    mediaIds: [],
    contentHash: 'hash_1001',
    sourceAdapter: 'fixture',
    sourceRunId: 'run_batch_01',
    schemaVersion: 1,
  };

  const post2: NormalizedPost = {
    id: 'x:1002',
    platform: 'x',
    postId: '1002',
    canonicalUrl: 'https://x.com/tech/status/1002',
    author: { handle: 'bob', displayName: 'Bob' },
    text: '介绍使用 Rust 构建超高速构建工具的实践。',
    postedAt: '2026-10-18T00:00:00Z',
    likedAt: null,
    firstObservedAt: '2026-10-31T01:00:00Z',
    lastObservedAt: '2026-10-31T01:00:00Z',
    captureStatus: 'complete',
    missingFields: [],
    externalLinks: ['https://github.com/example/rust-tool'],
    mediaIds: [],
    contentHash: 'hash_1002',
    sourceAdapter: 'fixture',
    sourceRunId: 'run_batch_01',
    schemaVersion: 1,
  };

  const aiMap = new Map<string, AIAnalysis>([
    [
      'x:1001',
      {
        postId: 'x:1001',
        sourceHash: 'hash_1001',
        model: 'mock_ai',
        promptVersion: PROMPT_VERSION,
        status: 'complete',
        titleZh: '前端现代化构建指南',
        summaryZh: '使用 Vite 和 TypeScript 提升开发体验。',
        categories: ['编程开发', '开源项目'],
        tags: ['TypeScript', 'Vite'],
        contentType: 'tutorial',
        steps: ['运行 npm install', '运行 npm run dev'],
        prerequisites: ['终端', 'Node.js >= 18'],
        usefulLinks: ['https://vite.dev'],
        uncertainties: [],
        quality: 'high',
      },
    ],
    [
      'x:1002',
      {
        postId: 'x:1002',
        sourceHash: 'hash_1002',
        model: 'mock_ai',
        promptVersion: PROMPT_VERSION,
        status: 'complete',
        titleZh: 'Rust 编译器工具链实践',
        summaryZh: 'Rust 构建高性能开发工具指南。',
        categories: ['编程开发'],
        tags: ['Rust', '编译器'],
        contentType: 'project',
        steps: ['cargo build --release'],
        prerequisites: ['终端', 'Rust 1.75+'],
        usefulLinks: ['https://github.com/example/rust-tool'],
        uncertainties: [],
        quality: 'high',
      },
    ],
  ]);

  const overridesMap = new Map<string, UserOverrides>([
    [
      'x:1001',
      {
        postId: 'x:1001',
        readingStatus: 'to_practice',
        updatedAt: '2026-10-31T01:30:00Z',
      },
    ],
    [
      'x:1002',
      {
        postId: 'x:1002',
        readingStatus: 'practiced',
        updatedAt: '2026-10-31T01:35:00Z',
      },
    ],
  ]);

  describe('short likes', () => {
    it('groups a few characters without an image as 杂项', () => {
      const short = { ...post1, text: '哈哈', mediaIds: [] };
      expect(getPostTopics(short, undefined, aiMap.get(short.id))).toEqual(['杂项']);
    });

    it('keeps a category the reader already saved', () => {
      const short = { ...post1, text: '收藏', mediaIds: [] };
      expect(
        getPostTopics(short, {
          postId: short.id,
          customCategories: ['设计/UI'],
          updatedAt: '2026-10-31T00:00:00.000Z',
        })
      ).toEqual(['设计/UI']);
    });

    it('leaves an image with a short caption in its real topic', () => {
      const caption = { ...post1, text: '见图', mediaIds: ['media-1'] };
      expect(getPostTopics(caption, undefined, aiMap.get(caption.id))[0]).toBe('编程开发');
    });
  });

  describe('Topic Categorization & Synthesis', () => {
    it('aggregates posts into topic summaries and counts reading statuses', () => {
      const summaries = buildTopicSummaries([post1, post2], overridesMap, aiMap);
      const devSummary = summaries.find((s) => s.topic === '编程开发');

      expect(devSummary).toBeDefined();
      expect(devSummary?.postCount).toBe(2);
      expect(devSummary?.toPracticeCount).toBe(1);
      expect(devSummary?.practicedCount).toBe(1);
      expect(devSummary?.toReadCount).toBe(0);
    });

    it('generates synthesis with common patterns, differences, and actionable items linking to original URLs', () => {
      const synthesis = generateTopicSynthesis('编程开发', [post1, post2], aiMap);

      expect(synthesis.topic).toBe('编程开发');
      expect(synthesis.postCount).toBe(2);
      expect(synthesis.commonPatterns).toEqual([
        { title: '前置条件', description: '终端', sourcePostIds: [post1.id, post2.id] },
      ]);
      expect(synthesis.differences).toContainEqual({
        aspect: '前置条件', description: 'Rust 1.75+', sourcePostIds: [post2.id],
      });
      expect(synthesis.actionableList.length).toBeGreaterThan(0);

      // Verify each actionable item links back to the exact post
      for (const item of synthesis.actionableList) {
        expect([post1.id, post2.id]).toEqual(expect.arrayContaining(item.sourcePostIds));
        expect(item.task).toBeDefined();
      }
    });

    it('merges a repeated practice step and keeps every supporting post in topic and batch exports', () => {
      const analyses = new Map(aiMap);
      analyses.set(post2.id, { ...aiMap.get(post2.id)!, steps: ['  运行 npm install  '] });
      const posts = [post1, { ...post2, sourceRunId: post1.sourceRunId }];
      const synthesis = generateTopicSynthesis('编程开发', posts, analyses);
      expect(synthesis.actionableList.filter(({ task }) => task === '运行 npm install')).toEqual([
        { task: '运行 npm install', sourcePostIds: [post1.id, post2.id] },
      ]);
      const topicMd = generateTopicMarkdown(synthesis, posts, overridesMap, analyses);
      const digest = buildIncrementalDigest({ id: post1.sourceRunId, startedAt: post1.firstObservedAt,
        adapterType: 'x_dom' } as SyncRun, posts, overridesMap, analyses);
      for (const markdown of [topicMd, generateDigestMarkdown(digest)]) {
        expect(markdown).toMatch(/运行 npm install — .*status\/1001.*status\/1002/);
      }
    });

    it('generates offline topic Markdown with YAML frontmatter and checklist', () => {
      const synthesis = generateTopicSynthesis('编程开发', [post1, post2], aiMap);
      const md = generateTopicMarkdown(synthesis, [post1, post2], overridesMap, aiMap);

      expect(md).toContain('topic: "编程开发"');
      expect(md).toContain('post_count: 2');
      expect(md).toContain('# 主题知识汇总：编程开发');
      expect(md).toContain('## 值得实践清单 (Actionable Checklist)');
      expect(md).toContain('- [ ] 运行 npm install');
      expect(md).toContain('[原帖 1001](https://x.com/tech/status/1001)');
      expect(md).toContain('## 差异与各自出处');
      expect(md).toContain('[原帖 1002](https://x.com/tech/status/1002)');
    });
  });

  describe('Incremental Sync Digest', () => {
    const run: SyncRun = {
      id: 'run_batch_01',
      startedAt: '2026-10-31T01:00:00Z',
      lastCheckpointAt: '2026-10-31T01:05:00Z',
      endedAt: '2026-10-31T01:05:00Z',
      status: 'completed',
      stats: { scanned: 2, added: 2, updated: 0, skipped: 0, failed: 0 },
      targetLimit: 10,
      downloadMedia: true,
      adapterType: 'fixture',
    };

    it('builds digest strictly for posts newly observed in this run', () => {
      const digest = buildIncrementalDigest(run, [post1, post2], overridesMap, aiMap);

      expect(digest.runId).toBe('run_batch_01');
      expect(digest.newPostCount).toBe(2);
      expect(digest.summaryByTopic['编程开发']).toBe(2);
      expect(digest.posts).toHaveLength(2);
    });

    it('generates digest Markdown without faking likedAt as today', () => {
      const digest = buildIncrementalDigest(run, [post1, post2], overridesMap, aiMap);
      const md = generateDigestMarkdown(digest);

      expect(md).toContain('run_id: "run_batch_01"');
      expect(md).toContain('# 本次增量同步简报 (run_batch_01)');
      expect(md).toContain('点赞时间未知时保持 null，绝不伪称当天点赞');
      expect(md).toContain('- **编程开发**: 2 篇');
      expect(md).toContain('https://x.com/tech/status/1001');
      expect(md).toContain('[待实践]');
      expect(md).toContain('## 共性');
      expect(md).toMatch(/前置条件.*终端.*status\/1001.*status\/1002/);
      expect(md).toMatch(/前置条件.*Rust 1\.75\+.*status\/1002/);
      expect(md).toMatch(/运行 npm install.*status\/1001/);

      const laterDigest = buildIncrementalDigest(
        { ...run, id: 'later_run' }, [post1, { ...post2, sourceRunId: 'later_run' }], overridesMap, aiMap,
      );
      expect(laterDigest.synthesis.commonPatterns).toEqual([]);
      expect(generateDigestMarkdown(laterDigest)).not.toContain('status/1001');
    });

    it('counts each post once per custom topic, including names inherited by ordinary objects', () => {
      const customOverrides = new Map<string, UserOverrides>([
        [post1.id, { postId: post1.id, updatedAt: run.startedAt, customCategories: ['constructor', '__proto__', 'constructor'] }],
        [post2.id, { postId: post2.id, updatedAt: run.startedAt, customCategories: ['__proto__'] }],
      ]);
      const digest = buildIncrementalDigest(run, [post1, post2], customOverrides, aiMap);

      expect(Object.entries(digest.summaryByTopic)).toEqual([['constructor', 1], ['__proto__', 2]]);
      expect(buildTopicSummaries([post1, post2], customOverrides, aiMap)
        .find(({ topic }) => topic === 'constructor')?.postIds).toEqual([post1.id]);
    });
  });
});
