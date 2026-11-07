import type { PostReference } from '../domain/types';

export interface RawCapturedItem {
  postId: string;
  url?: string;
  authorHandle?: string;
  authorDisplayName?: string;
  authorAvatarUrl?: string;
  text: string;
  postedAt?: string | null;
  mediaUrls?: string[];
  mediaAltTexts?: Record<string, string>;
  externalLinks?: string[];
  references?: PostReference[];
  isPartial?: boolean;
  missingFields?: string[];
}

export interface CaptureResult {
  items: RawCapturedItem[];
  repairs?: RawCapturedItem[];
  hasMore: boolean;
  cursor?: string;
  status: 'complete' | 'partial' | 'failed';
  error?: string;
  failureCode?: CaptureFailureCode;
}

export interface CaptureOptions {
  limit: number;
  cursor?: string;
  signal?: AbortSignal;
  onProgress?: (currentCount: number) => void;
  repairPostIds?: string[];
}

export interface CaptureAdapter {
  readonly name: string;
  captureBatch(options: CaptureOptions): Promise<CaptureResult>;
}
import type { CaptureFailureCode } from './captureFailure';

