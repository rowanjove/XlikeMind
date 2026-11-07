import type { NormalizedPost } from './types';

export const CAPTURE_GAP_KEYS = ['authorHandle', 'postedAt', 'text', 'truncated_text', 'media', 'article_body',
  'thread_continuation', 'quoted_post_body', 'quoted_post_media', 'video_body', 'unknown'] as const;
const STATUS_KEYS = ['complete', 'partial', 'failed', 'unknown'] as const;
export interface CaptureQuality {
  statuses: Record<typeof STATUS_KEYS[number], number>;
  missingFields: Record<typeof CAPTURE_GAP_KEYS[number], number>;
}
export function emptyCaptureQuality(): CaptureQuality {
  return { statuses: { complete: 0, partial: 0, failed: 0, unknown: 0 },
    missingFields: Object.fromEntries(CAPTURE_GAP_KEYS.map(key => [key, 0])) as CaptureQuality['missingFields'] };
}
export function countCaptureQuality(summary: CaptureQuality, post: Pick<NormalizedPost, 'captureStatus' | 'missingFields'>) {
  const status = STATUS_KEYS.find(key => key === post.captureStatus) ?? 'unknown';
  summary.statuses[status]++;
  const gaps = new Set((Array.isArray(post.missingFields) ? post.missingFields : []).map(value =>
    CAPTURE_GAP_KEYS.find(key => key === value) ?? 'unknown'));
  for (const gap of gaps) summary.missingFields[gap]++;
}
/** Only fixed labels and nonnegative safe counts may enter a diagnostic export. */
export function safeCaptureQuality(value: CaptureQuality): CaptureQuality {
  const result = emptyCaptureQuality();
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  for (const key of STATUS_KEYS) result.statuses[key] = count(value?.statuses?.[key]);
  for (const key of CAPTURE_GAP_KEYS) result.missingFields[key] = count(value?.missingFields?.[key]);
  return result;
}
