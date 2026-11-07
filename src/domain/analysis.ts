import type { AIAnalysis, AIFailureCode, AIStatus, NormalizedPost } from './types';
import { sanitizeUrl } from './sanitize';

export const PROMPT_VERSION = 'v1.2';

export const AI_FAILURE_LABELS = {
  request: '接口请求失败',
  response_format: '响应格式错误',
  storage: '结果保存失败',
  interrupted: '整理中断',
  unknown: '原因未知',
} satisfies Record<AIFailureCode | 'unknown', string>;

export function analysisFailureCode(analysis?: AIAnalysis | null): keyof typeof AI_FAILURE_LABELS {
  const code = analysis?.failureCode;
  return code && Object.hasOwn(AI_FAILURE_LABELS, code) ? code : 'unknown';
}

export function isPendingAnalysis(status: AIStatus): boolean {
  return status === 'unprocessed' || status === 'stale';
}

export function analysisStatus(post: NormalizedPost, analysis?: AIAnalysis): AIStatus {
  if (analysis?.status === 'complete' &&
    (analysis.sourceHash !== post.contentHash || analysis.promptVersion !== PROMPT_VERSION)) return 'stale';
  return analysis?.status ?? 'unprocessed';
}

export function currentAnalysis(post: NormalizedPost, analysis?: AIAnalysis): AIAnalysis | undefined {
  return analysisStatus(post, analysis) === 'complete' ? analysis : undefined;
}

export function sourceGroundedLinks(post: NormalizedPost, links?: string[]): string[] {
  if (!links?.length) return [];
  const bodyLinks = post.text.match(/https?:\/\/[^\s<>\])}]+/gi) ?? [];
  const sourceUrls = new Set([...post.externalLinks, ...bodyLinks].map(sanitizeUrl).filter(Boolean));
  return links.map(sanitizeUrl).filter((url) => url && sourceUrls.has(url));
}
