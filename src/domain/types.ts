export type CaptureStatus = 'complete' | 'partial' | 'failed';
export type PostSource = 'x_likes' | 'x_bookmarks' | 'x_archive';
export type AIStatus = 'unprocessed' | 'processing' | 'complete' | 'failed' | 'stale';
export type MediaStatus = 'pending' | 'downloaded' | 'failed' | 'remote_only';
export type SyncStatus = 'idle' | 'running' | 'paused' | 'partial' | 'completed' | 'failed' | 'cancelled';
export type ReadingStatus = 'to_read' | 'to_practice' | 'practiced' | 'ignored';

export interface AuthorInfo {
  handle?: string;
  displayName?: string;
  id?: string;
  avatarUrl?: string;
}

export interface PostReference {
  kind: 'quote' | 'reply' | 'article' | 'thread';
  id: string;
  url: string;
}

export interface NormalizedPost {
  id: string; // x:<numeric_id>，稳定主键
  platform: 'x';
  postId: string;
  canonicalUrl: string;
  author?: AuthorInfo;
  text: string; // 原文；不允许 AI 重写覆盖
  postedAt: string | null; // 发帖时间，未知为 null
  likedAt: string | null; // 真实点赞时间，通常未知，绝不推断，默认 null
  firstObservedAt: string; // 系统首次采集到的时间 (ISO string)
  lastObservedAt: string; // 最近一次观察到的时间 (ISO string)
  captureStatus: CaptureStatus;
  missingFields: string[];
  externalLinks: string[];
  references?: PostReference[];
  mediaIds: string[];
  contentHash: string; // 对采集源内容规范化后计算
  sourceAdapter: string;
  sources?: PostSource[];
  sourceRunId: string;
  schemaVersion: number;
}

export interface MediaAsset {
  id: string; // <postId>_media_<position>
  postId: string;
  position: number;
  kind: 'image' | 'video' | 'gif' | 'other';
  sourceUrl: string;
  downloadedFromUrl?: string;
  status: MediaStatus;
  mime?: string;
  altText?: string;
  blob?: Blob; // IndexedDB 保存
  failureReason?: string;
}

export interface SyncStats {
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface ExportJob {
  id: string;
  startedAt: string;
  endedAt?: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  totalPackages: number;
  submittedFiles: string[];
  downloadIds?: Record<string, number>;
  failureMessage?: string;
  failedPackage?: number;
  diagnosticFrames?: string[];
}

export interface SyncRun {
  id: string;
  /** Raw post IDs whose observations were committed to this DOM run. */
  seenPostIds?: string[];
  /** Existing local posts whose analysis source changed in this run. */
  changedPostIds?: string[];
  startedAt: string;
  lastCheckpointAt: string;
  endedAt?: string;
  status: SyncStatus;
  stats: SyncStats;
  repairStats?: {
    textAttempts: number;
    textRecovered: number;
    imageAttempts: number;
    imagesRecovered: number;
    remainingPosts?: number;
    remainingImages?: number;
  };
  failureCode?: string;
  failureMessage?: string;
  diagnosticFrames?: string[];
  targetLimit: number;
  downloadMedia: boolean;
  adapterType: 'fixture' | 'x_dom' | 'x_archive';
  source?: PostSource;
  cursor?: string;
}

export interface UserOverrides {
  postId: string;
  customTitle?: string;
  customTags?: string[];
  customCategories?: string[];
  notes?: string;
  readingStatus?: ReadingStatus;
  updatedAt: string;
}

export type AIFailureCode = 'request' | 'response_format' | 'storage' | 'interrupted';

export interface AIAnalysis {
  postId: string;
  sourceHash: string;
  imageInputKey?: string;
  model: string;
  promptVersion: string;
  status: AIStatus;
  titleZh?: string;
  summaryZh?: string;
  categories: string[];
  tags: string[];
  contentType?: 'tutorial' | 'project' | 'tool' | 'news' | 'opinion' | 'other';
  steps?: string[];
  prerequisites?: string[];
  usefulLinks?: string[];
  uncertainties?: string[];
  risksAndLimits?: string[];
  quality?: 'high' | 'medium' | 'low';
  confidenceNote?: string;
  failureReason?: string;
  failureCode?: AIFailureCode;
  updatedAt?: string;
}

export interface AIConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  timeoutSec: number;
  concurrencyLimit: number;
  batchLimit?: number;
  allowSendImages: boolean;
  sessionOnlyKey: boolean;
  useMock: boolean;
  updatedAt?: string;
}

export const DEFAULT_TOPICS = [
  'AI/Agent',
  '编程开发',
  'GitHub 开源项目',
  '软件工具',
  '网络技术',
  '设计/UI',
  '综合知识',
  '其他',
  '杂项',
] as const;

export type DefaultTopicName = (typeof DEFAULT_TOPICS)[number];

export interface TopicSummary {
  topic: string;
  postCount: number;
  toReadCount: number;
  toPracticeCount: number;
  practicedCount: number;
  ignoredCount: number;
  postIds: string[];
}

export interface TopicSynthesis {
  topic: string;
  generatedAt: string;
  postCount: number;
  commonPatterns: Array<{ title: string; description: string; sourcePostIds: string[] }>;
  differences: Array<{ aspect: string; description: string; sourcePostIds: string[] }>;
  actionableList: Array<{ task: string; sourcePostIds: string[] }>;
}

export interface IncrementalDigest {
  runId: string;
  startedAt: string;
  endedAt?: string;
  adapterType: string;
  newPostCount: number;
  posts: Array<{
    postId: string;
    title: string;
    author: string;
    canonicalUrl: string;
    categories: string[];
    readingStatus: ReadingStatus;
  }>;
  summaryByTopic: Record<string, number>;
  synthesis: TopicSynthesis;
}

export interface ExportManifest {
  manifestVersion: string;
  appName: string;
  appVersion: string;
  exportedAt: string;
  postCount: number;
  assetsCount: number;
  packageInfo?: {
    exportId: string;
    part: number;
    totalParts: number;
    totalPosts: number;
    linksOnly: boolean;
  };
  status: 'complete' | 'partial';
  failuresCount: number;
  failures: Array<{
    postId: string;
    reason: string;
    kind?: 'capture' | 'media';
    missingFields?: string[];
  }>;
}
