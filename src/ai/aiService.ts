import { db, type LikeMindDB } from '../storage/db';
import type { AIAnalysis, AIConfig, MediaAsset, NormalizedPost } from '../domain/types';
import type { AIClient } from './client';
import { OpenAIClient } from './openaiClient';
import { MockAIClient } from './mockClient';
import { PROMPT_VERSION, sourceGroundedLinks } from '../domain/analysis';
import { sanitizeErrorMessage } from './client';
import { assertApiAccess } from './permissions';
import { isLocalEndpoint, selectVisionImages } from './openaiClient';
import { getPageProfileId, profileStorageKey } from '../storage/profiles';
import { AIResponseFormatError } from './schema';

export interface BatchAIProgress {
  current: number;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  deferred?: number;
  activePostId?: string;
  stage: 'idle' | 'running' | 'completed' | 'cancelled';
}

interface AIRequestOptions {
  force?: boolean;
  signal?: AbortSignal;
  config?: AIConfig;
}

export const DEFAULT_AI_CONFIG: AIConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  modelName: 'gpt-4o-mini',
  timeoutSec: 30,
  concurrencyLimit: 2,
  batchLimit: 20,
  allowSendImages: false,
  sessionOnlyKey: false,
  useMock: false,
};

export const MAX_AI_BATCH_LIMIT = 100;

export function normalizeAIBatchLimit(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_AI_BATCH_LIMIT, Math.floor(value)))
    : 20;
}

export function isCachedAnalysis(existing: AIAnalysis, sourceHash: string, config: AIConfig): boolean {
  return existing.status === 'complete' && existing.sourceHash === sourceHash &&
    existing.model === (config.useMock ? 'mock_ai' : config.modelName) && existing.promptVersion === PROMPT_VERSION;
}

async function imageInputKey(media: MediaAsset[]): Promise<string | undefined> {
  const images = selectVisionImages(media);
  if (!images.length) return undefined;
  const inputs = await Promise.all(images.map(async (asset) => {
    const digest = await crypto.subtle.digest('SHA-256', await asset.blob.arrayBuffer());
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return [asset.id, asset.blob.type, hash];
  }));
  return JSON.stringify(inputs);
}

function postLockName(profileId: string, postId: string): string {
  return `likemind-ai:${profileId}:${postId}`;
}

export function describeAITransfer(config: AIConfig): string {
  if (config.useMock) return '使用离线样本整理，正文和图片留在本机。';
  let destination = '设置中的接口';
  try {
    destination = new URL(config.baseUrl).origin;
  } catch {
    // The request gate shows the address validation error on click.
  }
  return `整理会把原文发送到 ${destination}。${config.allowSendImages ? '每篇最多附带两张已下载图片。' : '仅发送文字。'}若模型输出格式无效，最多向同一接口再请求一次。`;
}

class ConcurrentAnalysisUnavailable extends Error {
  constructor() {
    super('另一窗口刚处理过这篇帖子，当前没有可复用的摘要。请检查结果后手动重试。');
  }
}

export class AIService {
  private database: LikeMindDB;
  private readonly sessionApiKeys = new Map<string, string>();
  private customClient: AIClient | null = null;
  private readonly inFlight = new Map<string, Promise<AIAnalysis>>();

  constructor(database: LikeMindDB = db) {
    this.database = database;
  }

  /**
   * For testing: inject custom or mock client
   */
  setClient(client: AIClient | null) {
    this.customClient = client;
  }

  async getConfig(profileId = getPageProfileId(), options?: { strict?: boolean }): Promise<AIConfig> {
    let stored: Partial<AIConfig> = {};
    const storageKey = profileStorageKey('ai_config', profileId);
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        const res = await new Promise<Record<string, unknown>>((resolve, reject) => {
          chrome.storage.local.get(storageKey, (items) => {
            if (chrome.runtime?.lastError) reject(new Error('无法读取 AI 设置'));
            else resolve((items || {}) as Record<string, unknown>);
          });
        });
        stored = (res[storageKey] as Partial<AIConfig>) || {};
      } catch (error) {
        if (options?.strict) throw error;
      }
    }

    const config: AIConfig = {
      ...DEFAULT_AI_CONFIG,
      ...stored,
      batchLimit: normalizeAIBatchLimit(stored.batchLimit),
    };

    // If sessionOnlyKey was enabled, restore apiKey from memory
    if (config.sessionOnlyKey) {
      config.apiKey = this.sessionApiKeys.get(profileId) ?? '';
    }

    return config;
  }

  async saveConfig(newConfig: AIConfig, profileId = getPageProfileId()): Promise<void> {
    const toStore: AIConfig = {
      ...newConfig,
      apiKey: newConfig.sessionOnlyKey ? '' : newConfig.apiKey,
      batchLimit: normalizeAIBatchLimit(newConfig.batchLimit),
      updatedAt: new Date().toISOString(),
    };

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [profileStorageKey('ai_config', profileId)]: toStore });
    }

    if (newConfig.sessionOnlyKey) {
      this.sessionApiKeys.set(profileId, newConfig.apiKey);
    } else {
      this.sessionApiKeys.delete(profileId);
    }

  }

  async getClient(approvedConfig?: AIConfig, profileId = getPageProfileId()): Promise<AIClient> {
    if (this.customClient) {
      return this.customClient;
    }
    const config = approvedConfig ?? await this.getConfig(profileId);
    if (config.useMock) {
      return new MockAIClient();
    }
    if (!config.apiKey.trim() && !isLocalEndpoint(config.baseUrl)) {
      throw new Error('未配置 API Key。请填写密钥，或开启离线 Mock 模式。未配置时不会假装分析成功。');
    }
    return new OpenAIClient(config);
  }

  async testConnection(options?: { signal?: AbortSignal; config?: AIConfig }): Promise<{ success: boolean; message: string }> {
    const config = options?.config ?? await this.getConfig();
    if (!config.useMock) await assertApiAccess(config.baseUrl);
    const client = await this.getClient(config);
    return client.testConnection(options);
  }

  /**
   * Analyze a single post by ID.
   * Checks cache before calling client to prevent duplicate charges.
   */
  async analyzePost(
    postId: string,
    options?: AIRequestOptions
  ): Promise<AIAnalysis> {
    options?.signal?.throwIfAborted();
    const profileId = getPageProfileId();
    const inFlightKey = `${profileId}:${postId}`;
    const current = this.inFlight.get(inFlightKey);
    if (current) return current;
    const pending = this.runWithPostLock(postId, profileId, (reuseOnly) => this.analyzePostInternal(postId, options, reuseOnly));
    this.inFlight.set(inFlightKey, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(inFlightKey) === pending) this.inFlight.delete(inFlightKey);
    }
  }

  private async runWithPostLock(postId: string, profileId: string, task: (reuseOnly: boolean) => Promise<AIAnalysis>): Promise<AIAnalysis> {
    const lockManager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!lockManager?.request) return task(false);
    const key = postLockName(profileId, postId);
    const result = await lockManager.request(key, { mode: 'exclusive', ifAvailable: true },
      (lock) => lock ? task(false) : undefined);
    if (result) return result;
    return lockManager.request(key, { mode: 'exclusive' }, () => task(true));
  }

  async recoverInterruptedAnalyses(): Promise<void> {
    const lockManager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!lockManager?.request) return;

    const profileId = getPageProfileId();
    const postIds = await this.database.aiAnalysis.where('status').equals('processing').primaryKeys();
    for (const postId of postIds) {
      await lockManager.request(postLockName(profileId, postId), { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!lock) return;
        await this.database.transaction('rw', this.database.aiAnalysis, async () => {
          const record = await this.database.aiAnalysis.get(postId);
          if (record?.status !== 'processing') return;
          await this.database.aiAnalysis.update(postId, {
            status: 'failed',
            failureReason: '上次整理中断，未收到完整结果。可手动重试。',
            failureCode: 'interrupted',
            updatedAt: new Date().toISOString(),
          });
        });
      });
    }
  }

  private async analyzePostInternal(
    postId: string,
    options: AIRequestOptions | undefined,
    reuseOnly: boolean,
  ): Promise<AIAnalysis> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    const post = await this.database.posts.get(postId);
    if (!post) {
      throw new Error(`未找到帖子记录: ${postId}`);
    }

    const profileId = getPageProfileId();
    const config = options?.config ?? await this.getConfig(profileId);
    if (!config.useMock && !this.customClient) await assertApiAccess(config.baseUrl);
    const existing = await this.database.aiAnalysis.get(postId);
    const sendImages = config.allowSendImages && !config.useMock;
    const media = sendImages ? await this.database.media.where('postId').equals(post.id).sortBy('position') : [];
    const currentImageKey = await imageInputKey(media);

    // Caching check: same contentHash, model and promptVersion
    if (
      (reuseOnly || !options?.force) &&
      existing &&
      isCachedAnalysis(existing, post.contentHash, config) &&
      (!sendImages || existing.imageInputKey === currentImageKey)
    ) {
      return existing; // Cached! No API call.
    }

    if (reuseOnly) throw new ConcurrentAnalysisUnavailable();

    const modelName = config.useMock ? 'mock_ai' : config.modelName;
    const client = await this.getClient(config, profileId);
    signal?.throwIfAborted();

    // Mark as processing
    const processingRecord: AIAnalysis = {
      postId: post.id,
      sourceHash: post.contentHash,
      model: modelName,
      promptVersion: PROMPT_VERSION,
      status: 'processing',
      categories: existing?.categories || [],
      tags: existing?.tags || [],
      updatedAt: new Date().toISOString(),
    };
    await this.database.transaction('rw', this.database.posts, this.database.aiAnalysis, async () => {
      if (!await this.database.posts.get(postId)) throw new Error('帖子已从本地文库删除');
      signal?.throwIfAborted();
      await this.database.aiAnalysis.put(processingRecord);
    });

    let savingResult = false;
    try {
      signal?.throwIfAborted();
      const payload = await client.analyzePost({
        post,
        media,
        signal,
      });
      signal?.throwIfAborted();

      const completeRecord: AIAnalysis = {
        postId: post.id,
        sourceHash: post.contentHash,
        imageInputKey: currentImageKey,
        model: modelName,
        promptVersion: PROMPT_VERSION,
        status: 'complete',
        titleZh: payload.titleZh,
        summaryZh: payload.summaryZh,
        categories: payload.categories,
        tags: payload.tags,
        contentType: payload.contentType,
        steps: payload.steps,
        prerequisites: payload.prerequisites,
        usefulLinks: [],
        uncertainties: payload.uncertainties ?? [],
        risksAndLimits: payload.risksAndLimits ?? [],
        quality: payload.quality,
        confidenceNote: payload.confidenceNote,
        failureReason: undefined,
        updatedAt: new Date().toISOString(),
      };

      completeRecord.usefulLinks = sourceGroundedLinks(post, payload.usefulLinks);
      const ungroundedCount = payload.usefulLinks.length - completeRecord.usefulLinks.length;
      if (ungroundedCount > 0) {
        const uncertainties = completeRecord.uncertainties ?? [];
        completeRecord.uncertainties = [
          ...uncertainties,
          `AI 返回了 ${ungroundedCount} 个原文未出现的链接，已移出可追溯资源列表。`,
        ];
      }

      let committedRecord = completeRecord;
      savingResult = true;
      await this.database.transaction('rw', this.database.posts, this.database.aiAnalysis, async () => {
        const currentPost = await this.database.posts.get(postId);
        signal?.throwIfAborted();
        const contentChanged = !currentPost || currentPost.contentHash !== post.contentHash;
        committedRecord = contentChanged ? { ...completeRecord, status: 'stale' } : completeRecord;
        if (currentPost) await this.database.aiAnalysis.put(committedRecord);
      });
      return committedRecord;
    } catch (err) {
      if (signal?.aborted) {
        await this.database.transaction('rw', this.database.posts, this.database.aiAnalysis, async () => {
          const currentPost = await this.database.posts.get(postId);
          const current = await this.database.aiAnalysis.get(postId);
          if (!currentPost || current?.status !== 'processing' || current.updatedAt !== processingRecord.updatedAt) return;
          if (existing && existing.status !== 'processing') {
            await this.database.aiAnalysis.put(currentPost.contentHash === existing.sourceHash
              ? existing : { ...existing, status: 'stale' });
          } else {
            await this.database.aiAnalysis.delete(postId);
          }
        });
        signal.throwIfAborted();
      }
      const safeReason = sanitizeErrorMessage(err, config.apiKey);
      const failedRecord: AIAnalysis = {
        postId: post.id,
        sourceHash: post.contentHash,
        model: modelName,
        promptVersion: PROMPT_VERSION,
        status: 'failed',
        failureReason: safeReason,
        failureCode: savingResult ? 'storage' : err instanceof AIResponseFormatError ? 'response_format' : 'request',
        categories: existing?.categories || [],
        tags: existing?.tags || [],
        updatedAt: new Date().toISOString(),
      };
      await this.database.transaction('rw', this.database.posts, this.database.aiAnalysis, async () => {
        const currentPost = await this.database.posts.get(postId);
        if (!currentPost) return;
        if (currentPost.contentHash !== post.contentHash) failedRecord.status = 'stale';
        await this.database.aiAnalysis.put(failedRecord);
      });
      throw new Error(safeReason);
    }
  }

  private async matchesBatchCache(post: NormalizedPost, existing: AIAnalysis, config: AIConfig): Promise<boolean> {
    if (!isCachedAnalysis(existing, post.contentHash, config)) return false;
    if (!config.allowSendImages || config.useMock) return true;
    const media = await this.database.media.where('postId').equals(post.id).sortBy('position');
    return existing.imageInputKey === await imageInputKey(media);
  }

  /**
   * Batch analyze multiple posts with concurrency limit and progress callback.
   */
  async analyzeBatch(
    postIds: string[],
    options?: {
      force?: boolean;
      signal?: AbortSignal;
      config?: AIConfig;
      failedOnly?: boolean;
      onProgress?: (progress: BatchAIProgress) => void;
    }
  ): Promise<{ succeeded: number; failed: number; skipped: number }> {
    const profileId = getPageProfileId();
    const config = options?.config ?? await this.getConfig(profileId);
    if (!config.useMock && !this.customClient) await assertApiAccess(config.baseUrl);
    await this.getClient(config, profileId);
    const concurrency = Math.max(1, Math.min(config.concurrencyLimit || 2, 5));

    const uniqueIds = [...new Set(postIds)];
    const [posts, analyses] = await Promise.all([
      this.database.posts.bulkGet(uniqueIds),
      this.database.aiAnalysis.bulkGet(uniqueIds),
    ]);
    let skipped = 0;
    const eligibleIds: string[] = [];
    for (const [index, id] of uniqueIds.entries()) {
      const post = posts[index];
      const analysis = analyses[index];
      if (options?.failedOnly && analysis?.status !== 'failed') continue;
      if (!options?.force && post && analysis && await this.matchesBatchCache(post, analysis, config)) {
        skipped++;
        continue;
      }
      eligibleIds.push(id);
    }
    const queue = eligibleIds.slice(0, normalizeAIBatchLimit(config.batchLimit));
    const total = queue.length;
    let completed = 0;
    let succeeded = 0;
    let failed = 0;

    const progress: BatchAIProgress = {
      current: 0,
      total,
      succeeded: 0,
      failed: 0,
      skipped,
      deferred: eligibleIds.length - total,
      stage: 'running',
    };

    options?.onProgress?.({ ...progress });

    const worker = async () => {
      while (queue.length > 0) {
        if (options?.signal?.aborted) {
          progress.stage = 'cancelled';
          options?.onProgress?.({ ...progress });
          break;
        }

        const id = queue.shift()!;
        progress.activePostId = id;
        let settled = true;

        try {
          const post = await this.database.posts.get(id);
          const existing = await this.database.aiAnalysis.get(id);
          if (
            (options?.failedOnly && existing?.status !== 'failed') ||
            (!options?.force && post && existing && await this.matchesBatchCache(post, existing, config))
          ) {
            skipped++;
            progress.skipped = skipped;
          } else {
            await this.analyzePost(id, { ...options, config });
            succeeded++;
            progress.succeeded = succeeded;
          }
        } catch (error) {
          if (options?.signal?.aborted) {
            settled = false;
          } else if (error instanceof ConcurrentAnalysisUnavailable) {
            progress.skipped = ++skipped;
          } else {
            failed++;
            progress.failed = failed;
          }
        } finally {
          if (settled) completed++;
          progress.current = completed;
          options?.onProgress?.({ ...progress });
        }
      }
    };

    // Run workers up to concurrency
    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);

    progress.stage = options?.signal?.aborted ? 'cancelled' : 'completed';
    options?.onProgress?.({ ...progress });

    return { succeeded, failed, skipped };
  }
}

export const aiService = new AIService();
