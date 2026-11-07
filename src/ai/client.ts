import type { NormalizedPost, MediaAsset } from '../domain/types';
import type { AIAnalysisPayload } from './schema';

export interface AIClient {
  readonly name: string;
  testConnection(options?: { signal?: AbortSignal }): Promise<{ success: boolean; message: string }>;
  analyzePost(options: {
    post: NormalizedPost;
    media?: MediaAsset[];
    signal?: AbortSignal;
  }): Promise<AIAnalysisPayload>;
}

/**
 * Strips sensitive API keys and tokens from error messages so they never leak into logs or UI.
 */
export function sanitizeErrorMessage(err: unknown, apiKey?: string): string {
  let message = err instanceof Error ? err.message : String(err);
  if (apiKey && apiKey.length >= 4) {
    message = message.split(apiKey).join('***[REDACTED_API_KEY]***');
  }
  // Also filter common token patterns
  message = message.replace(/Bearer\s+[a-zA-Z0-9_\-\.]{8,}/gi, 'Bearer ***[REDACTED]***');
  message = message.replace(/sk-[a-zA-Z0-9]{12,}/g, 'sk-***[REDACTED]***');
  return message;
}
