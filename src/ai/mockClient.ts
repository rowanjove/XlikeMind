import type { AIClient } from './client';
import type { NormalizedPost, MediaAsset } from '../domain/types';
import type { AIAnalysisPayload } from './schema';
import { parseAndValidateAIResponse } from './schema';

export type MockBehavior =
  | 'success'
  | 'simulate_401'
  | 'simulate_429'
  | 'simulate_500'
  | 'simulate_timeout'
  | 'simulate_malformed_json';

export class MockAIClient implements AIClient {
  readonly name = 'mock_ai';
  public behavior: MockBehavior = 'success';
  public callCount = 0;

  constructor(behavior: MockBehavior = 'success') {
    this.behavior = behavior;
  }

  async testConnection(options?: { signal?: AbortSignal }): Promise<{ success: boolean; message: string }> {
    if (options?.signal?.aborted) {
      throw new Error('Connection test aborted');
    }

    if (this.behavior === 'simulate_401') {
      return { success: false, message: 'HTTP 401: Unauthorized (Invalid API Key)' };
    }
    if (this.behavior === 'simulate_429') {
      return { success: false, message: 'HTTP 429: Too Many Requests (Rate limit reached)' };
    }
    if (this.behavior === 'simulate_500') {
      return { success: false, message: 'HTTP 500: Internal Server Error' };
    }

    return { success: true, message: 'Mock AI 连接测试成功！响应正常。' };
  }

  async analyzePost(options: {
    post: NormalizedPost;
    media?: MediaAsset[];
    signal?: AbortSignal;
  }): Promise<AIAnalysisPayload> {
    const { post, signal } = options;
    this.callCount++;

    if (signal?.aborted) {
      throw new Error('AI analysis cancelled by user');
    }

    if (this.behavior === 'simulate_401') {
      throw new Error('HTTP 401 (Unauthorized): Invalid API key provided');
    }
    if (this.behavior === 'simulate_429') {
      throw new Error('HTTP 429 (Rate Limit): You exceeded your current quota');
    }
    if (this.behavior === 'simulate_500') {
      throw new Error('HTTP 500 (Internal Server Error): The server encountered an error');
    }
    if (this.behavior === 'simulate_timeout') {
      throw new Error('AI request timed out after 30 seconds');
    }
    if (this.behavior === 'simulate_malformed_json') {
      return parseAndValidateAIResponse('Sorry, I cannot return JSON: Here is a raw markdown block: {invalid_json');
    }

    // Success generation based on post content
    const text = post.text || '';
    const hasCode = text.includes('```') || text.includes('npm') || text.includes('npx') || text.includes('git');
    const isDesign = text.includes('设计') || text.includes('卡片') || text.includes('UI') || text.includes('排版');

    let titleZh = '推文核心观点梳理';
    let summaryZh = '该帖子分享了实用的技术要点与思考。';
    let categories = ['综合知识'];
    let tags = ['X-Like'];
    let contentType: AIAnalysisPayload['contentType'] = 'other';
    const steps: string[] = [];
    const prerequisites: string[] = [];
    const usefulLinks: string[] = [...post.externalLinks];
    const uncertainties: string[] = [];

    if (hasCode) {
      titleZh = '轻量级前端 CLI 工具与工程构建指南';
      summaryZh = '介绍如何使用 TypeScript 与现代化脚手架快速初始化轻量化工程，提升前端开发效能。';
      categories = ['编程开发', '开源项目'];
      tags = ['TypeScript', 'Vite', 'CLI', '前端工具'];
      contentType = 'tutorial';
      steps.push('运行 npx create-likemind-app 初始化项目');
      steps.push('进入项目目录并执行 npm install 安装依赖');
      steps.push('执行 npm run dev 启动本地热重载调试');
      prerequisites.push('Node.js >= 18.0.0', 'npm 或 pnpm');
    } else if (isDesign) {
      titleZh = '现代卡片式 UI 排版与视觉层级设计对比';
      summaryZh = '对比了扁平化与微阴影卡片设计的 4 种方案，强调克制视觉元素与清晰内容排版。';
      categories = ['设计/UI'];
      tags = ['UI设计', '排版规范', '设计系统'];
      contentType = 'project';
      uncertainties.push('原文未提供设计源文件 (Figma) 下载链接');
    } else if (text.includes('SQLite') || text.includes('B-Tree')) {
      titleZh = '经典 SQLite B-Tree 底层原理与存储模型解析';
      summaryZh = '深入剖析 SQLite 数据库存储引擎的核心 B-Tree 算法与页式磁盘管理结构。';
      categories = ['编程开发', '软件工具'];
      tags = ['SQLite', '数据库', '底层原理', '数据结构'];
      contentType = 'tutorial';
      steps.push('理解 B-Tree 叶子节点与内部节点的划分');
      steps.push('掌握 Page Cache 与 WAL 日志机制的协同方式');
      prerequisites.push('了解基本 C 语言与操作系统磁盘 I/O 原理');
    } else if (text.includes('Multi-agent') || text.includes('Agent')) {
      titleZh = '多智能体系统与长期编程任务基准论文解读';
      summaryZh = '基于共享记忆与反应式检查点的多智能体架构在长时间跨度编程任务中可提升 3 倍效率。';
      categories = ['AI/Agent'];
      tags = ['Agent', 'AI编码', 'DeepMind', 'LLM'];
      contentType = 'news';
      uncertainties.push('论文代码开源仓库尚未在推文中公布');
    } else {
      titleZh = post.author?.displayName ? `${post.author.displayName} 的观点分享` : 'X 知识片段速记';
      summaryZh = text.length > 50 ? `${text.slice(0, 50)}...` : text;
      uncertainties.push('推文篇幅较短，未提供具体操作步骤');
    }

    return {
      titleZh,
      summaryZh,
      categories,
      tags,
      contentType,
      steps,
      prerequisites,
      usefulLinks,
      uncertainties,
      risksAndLimits: [],
      quality: steps.length > 0 ? 'high' : 'medium',
      confidenceNote: '基于推文正文与附件链接真实提取',
    };
  }
}
