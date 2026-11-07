import { PROMPT_VERSION } from '../src/domain/analysis';
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { generatePostMarkdown, getPostRelativePath } from '../src/export/markdown';
import { buildExportZip } from '../src/export/zip';
import type { NormalizedPost, AIAnalysis, UserOverrides } from '../src/domain/types';

describe('Markdown & ZIP Export with AI Analysis', () => {
  const post: NormalizedPost = {
    id: 'x:777001',
    platform: 'x',
    postId: '777001',
    canonicalUrl: 'https://x.com/tech_guru/status/777001',
    author: { handle: 'tech_guru', displayName: 'Tech Guru 🚀' },
    text: '分享一个超好用的 CLI 工具，使用 TypeScript + Vite 构建快速前端工程！\n\nnpx create-likemind-app',
    postedAt: '2026-10-15T10:20:00.000Z',
    likedAt: null,
    firstObservedAt: '2026-10-31T01:00:00.000Z',
    lastObservedAt: '2026-10-31T01:00:00.000Z',
    captureStatus: 'complete',
    missingFields: [],
    externalLinks: ['https://github.com/example/likemind'],
    mediaIds: [],
    contentHash: 'hash_guru_1',
    sourceAdapter: 'fixture',
    sourceRunId: 'run_1',
    schemaVersion: 1,
  };

  const completedAi: AIAnalysis = {
    postId: post.id,
    sourceHash: post.contentHash,
    model: 'gpt-4o-mini',
    promptVersion: PROMPT_VERSION,
    status: 'complete',
    titleZh: '轻量化前端脚手架与自动化工具开发指南',
    summaryZh: '基于 Vite 和 TypeScript 快速初始化现代化命令行前端脚手架。',
    categories: ['编程开发', '开源项目'],
    tags: ['TypeScript', 'Vite', 'CLI'],
    contentType: 'tutorial',
    steps: ['运行 npx create-likemind-app 初始化', '执行 npm install 安装依赖', '运行 npm run dev 启动调试'],
    prerequisites: ['Node.js >= 18.0.0'],
    usefulLinks: ['https://github.com/example/likemind'],
    uncertainties: ['未提及 Windows 路径特殊兼容性说明'],
    quality: 'high',
    confidenceNote: '根据原文步骤提取',
  };

  it('renders rich AI analysis in Markdown when AI is complete', () => {
    const md = generatePostMarkdown({
      post,
      media: [],
      ai: completedAi,
      exportedAt: '2026-10-31T02:00:00.000Z',
    });

    // Check title fallback to AI title
    expect(md).toContain('# 轻量化前端脚手架与自动化工具开发指南');

    // Check Frontmatter has AI tags and categories
    expect(md).toContain('categories:');
    expect(md).toContain('  - "编程开发"');
    expect(md).toContain('tags:');
    expect(md).toContain('content_type: "tutorial"');
    expect(md).toContain('  - "TypeScript"');

    // Check AI Knowledge section
    expect(md).toContain('## AI 知识提炼');
    expect(md).toContain('**摘要**: 基于 Vite 和 TypeScript 快速初始化现代化命令行前端脚手架。');
    expect(md).toContain('### 步骤 / 要点');
    expect(md).toContain('- 运行 npx create-likemind-app 初始化');
    expect(md).toContain('### 前置要求');
    expect(md).toContain('- Node.js >= 18.0.0');
    expect(md).toContain('### 待核实 / 信息缺失');
    expect(md).toContain('未提及 Windows 路径特殊兼容性说明');
    expect(md).toContain('**置信说明**: 根据原文步骤提取');
  });

  it('exports old-prompt analysis as stale while preserving manual tags and the original text', () => {
    const md = generatePostMarkdown({
      post,
      media: [],
      ai: { ...completedAi, promptVersion: 'legacy' },
      overrides: { postId: post.id, customTags: ['人工标签'], updatedAt: post.firstObservedAt },
      exportedAt: post.firstObservedAt,
    });
    expect(md).toContain('ai_status: "stale"');
    expect(md).toContain('content_type: null');
    expect(md).toContain('人工标签');
    expect(md).toContain(post.text);
    expect(md).not.toContain(completedAi.summaryZh);
  });

  it('ensures UserOverrides take precedence over AI fields', () => {
    const userOverrides: UserOverrides = {
      postId: post.id,
      customTitle: '我的自定义收藏标题 (人工优先)',
      customTags: ['我的精选', '必读'],
      customCategories: ['个人收藏'],
      notes: '这是我自己的实践笔记，比 AI 更重要。',
      readingStatus: 'to_practice',
      updatedAt: '2026-10-31T02:30:00.000Z',
    };

    const md = generatePostMarkdown({
      post,
      media: [],
      overrides: userOverrides,
      ai: completedAi,
      exportedAt: '2026-10-31T03:00:00.000Z',
    });

    // Custom title overrides AI title
    expect(md).toContain('# 我的自定义收藏标题 (人工优先)');
    expect(md).not.toContain('# 轻量化前端脚手架与自动化工具开发指南');

    // Custom categories & tags override AI ones
    expect(md).toContain('  - "个人收藏"');
    expect(md).toContain('  - "我的精选"');

    // User notes present
    expect(md).toContain('## 个人笔记');
    expect(md).toContain('这是我自己的实践笔记，比 AI 更重要。');

    // AI Knowledge section is still preserved for reference!
    expect(md).toContain('## AI 知识提炼');
    expect(md).toContain('### 步骤 / 要点');
  });

  it('packs post with AI analysis into ZIP correctly', async () => {
    const mediaMap = new Map();
    const aiMap = new Map([[post.id, {
      ...completedAi, risksAndLimits: ['依赖本地环境 <script>'],
      usefulLinks: [...completedAi.usefulLinks!, 'javascript:alert(1)', 'https://fixture.invalid/invented-resource'],
    }]]);

    const { blob, manifest } = await buildExportZip({
      posts: [post],
      mediaMap,
      aiMap,
    });

    expect(blob.size).toBeGreaterThan(0);
    expect(manifest.postCount).toBe(1);
    expect(manifest.status).toBe('complete');
    const zip = await JSZip.loadAsync(blob);
    const reader = await zip.file('index.html')!.async('string');
    const markdown = await zip.file(getPostRelativePath(post).fullPath)!.async('string');
    expect(reader).toContain('<summary>查看 AI 整理详情</summary>');
    expect(reader).toContain('运行 npx create-likemind-app 初始化');
    expect(reader).toContain('Node.js &gt;= 18.0.0');
    expect(reader).toContain('置信说明：根据原文步骤提取');
    expect(reader).toContain('依赖本地环境 &lt;script&gt;');
    expect(reader).toContain('href="https://github.com/example/likemind"');
    expect(reader).not.toContain('javascript:alert(1)');
    expect(reader).not.toContain('invented-resource');
    expect(markdown).not.toContain('invented-resource');
  });
});
