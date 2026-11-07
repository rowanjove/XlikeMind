import type { CaptureOptions, CaptureResult, RawCapturedItem } from '../adapters/types';
import type { SyncStats } from '../domain/types';
import { publishLiveSnapshot, type SyncPhase } from '../sync/liveSync';
import { CAPTURE_TIME_LIMIT_MS, CAPTURE_TIME_LIMIT_MESSAGE, type CaptureFailureCode } from '../adapters/captureFailure';
import { normalizeScanLimit } from '../adapters/captureLimits';
import type { SyncReply } from '../messaging/syncClient';

export interface ReadingOutcome {
  hasMore: boolean;
  terminalStatus: CaptureResult['status'];
  error?: string;
  failureCode?: CaptureFailureCode;
  cancelled: boolean;
  /** User asked to pause. The page checkpoint stays so the same run can continue. */
  paused?: boolean;
}

export interface ReadingTransport {
  begin(
    targetLimit: number,
    downloadMedia: boolean,
    profileId?: string
  ): Promise<{ success: boolean; runId?: string; error?: string; targetLimit?: number; seenPostIds?: string[]; resumePostIds?: string[] } & Partial<SyncStats>>;
  ingest(
    runId: string,
    items: RawCapturedItem[],
    profileId?: string,
    repairs?: RawCapturedItem[],
  ): Promise<SyncReply>;
  finish(runId: string, outcome: ReadingOutcome, profileId?: string): Promise<void>;
}

export interface ReadingCheckpoint {
  cursor?: string;
  seenPostIds: string[];
  anchorPostId?: string;
}

/**
 * Scroll/expand stays in the likes tab. Each batch is saved by the service worker,
 * so closing the toolbar popup does not drop the run.
 */
export async function runReadingSession(
  capture: (options: CaptureOptions) => Promise<CaptureResult>,
  transport: ReadingTransport,
  options: {
    limit: number;
    downloadMedia: boolean;
    signal: AbortSignal;
    /** Profile is pinned by START_READING and carried through every save call. */
    profileId?: string;
    onStart?: (response: { started: boolean; reason?: string }) => void;
    loadCheckpoint?: (runId: string, seenPostIds?: string[]) => Promise<ReadingCheckpoint | null>;
    onCheckpoint?: (checkpoint: ReadingCheckpoint, runId: string) => void | Promise<void>;
    maxDurationMs?: number;
  }
): Promise<boolean> {
  let limit = normalizeScanLimit(options.limit);
  let runId = '';
  let hasMore = false;
  let terminalStatus: CaptureResult['status'] = 'complete';
  let terminalError: string | undefined;
  let failureCode: CaptureFailureCode | undefined;
  let cancelled = false;
  let paused = false;
  const controller = new AbortController();
  const signal = controller.signal;
  const forwardAbort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener('abort', forwardAbort, { once: true });
  if (options.signal.aborted) forwardAbort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scanned = 0;
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const publishPhase = (phase: SyncPhase, observed = scanned) => publishLiveSnapshot({
    runId,
    status: 'running',
    phase,
    scanned: Math.max(scanned, observed),
    added,
    updated,
    skipped,
    failed,
    targetLimit: limit,
    updatedAt: new Date().toISOString(),
  }, options.profileId);
  const noteAbort = () => {
    if (!signal.aborted) return;
    if (signal.reason === 'time_limit') {
      if (terminalStatus === 'failed' && failureCode && failureCode !== 'time_limit') return;
      paused = true;
      failureCode = 'time_limit';
      terminalError = CAPTURE_TIME_LIMIT_MESSAGE;
    } else if (signal.reason === 'pause') paused = true;
    else cancelled = true;
  };

  try {
    const begun = options.profileId === undefined
      ? await transport.begin(limit, options.downloadMedia)
      : await transport.begin(limit, options.downloadMedia, options.profileId);
    if (!begun.success || !begun.runId) {
      throw new Error(begun.error || '无法开始保存');
    }
    runId = begun.runId;
    limit = begun.targetLimit ?? limit;
    const duration = options.maxDurationMs;
    timer = setTimeout(() => controller.abort('time_limit'),
      duration && Number.isFinite(duration) && duration > 0 ? Math.min(duration, CAPTURE_TIME_LIMIT_MS) : CAPTURE_TIME_LIMIT_MS);
    options.onStart?.({ started: true });

    const checkpoint = await options.loadCheckpoint?.(runId, begun.seenPostIds);
    let cursor = checkpoint ? checkpoint.cursor || 'continue' : undefined;
    const seenPostIds = new Set(checkpoint?.seenPostIds);
    scanned = begun.scanned ?? 0;
    added = begun.added ?? 0;
    updated = begun.updated ?? 0;
    skipped = begun.skipped ?? 0;
    failed = begun.failed ?? 0;
    hasMore = scanned >= limit;
    noteAbort();
    while (scanned < limit) {
      if (signal.aborted) {
        noteAbort();
        break;
      }

      await publishPhase('reading');
      const result = await capture({
        limit: Math.min(8, limit - scanned),
        cursor,
        signal,
        repairPostIds: begun.resumePostIds,
        onProgress: (seen) => {
          void publishPhase('reading', seen);
        },
      });
      terminalStatus = result.status;
      failureCode = result.failureCode;
      if (result.error) terminalError = result.error;
      noteAbort();

      if (result.items.length > 0 || result.repairs?.length) {
        await publishPhase('saving');
        for (const item of result.items) {
          if (item.postId) seenPostIds.add(item.postId);
        }
        const saveBatch = () => result.repairs?.length
          ? transport.ingest(runId, result.items, options.profileId, result.repairs)
          : options.profileId === undefined
          ? transport.ingest(runId, result.items)
          : transport.ingest(runId, result.items, options.profileId);
        let saved = await saveBatch();
        if (saved.transportError === 'disconnected' && begun.seenPostIds && !signal.aborted) {
          saved = await saveBatch();
        }
        if (!saved.success) {
          const recoverable = Boolean(saved.transportError && begun.seenPostIds);
          failureCode = recoverable ? 'save_interrupted' : undefined;
          terminalStatus = 'failed';
          terminalError = saved.error || '保存这一批帖子失败';
          hasMore = false;
          paused = recoverable && !cancelled;
          if (!recoverable) cancelled = false;
          break;
        }
        for (const repair of result.repairs ?? []) seenPostIds.add(repair.postId);
        scanned = saved.scanned ?? scanned + result.items.length;
        if (typeof saved.added === 'number') added = saved.added;
        if (typeof saved.updated === 'number') updated = saved.updated;
        if (typeof saved.skipped === 'number') skipped = saved.skipped;
        if (typeof saved.failed === 'number') failed = saved.failed;
      }

      hasMore = Boolean(result.hasMore);
      cursor = result.cursor;
      await options.onCheckpoint?.({
        cursor,
        seenPostIds: Array.from(seenPostIds).slice(-2000),
        anchorPostId: result.items.at(-1)?.postId,
      }, runId);
      noteAbort();

      if (cancelled || paused || result.status === 'failed' || !hasMore || (!result.items.length && !cursor)) {
        if (!cancelled && !paused && result.status !== 'failed' && !result.items.length) {
          hasMore = false;
        }
        break;
      }
    }
  } catch (err) {
    terminalStatus = 'failed';
    terminalError = err instanceof Error ? err.message : String(err);
    hasMore = false;
    if (!runId) {
      options.onStart?.({ started: false, reason: terminalError });
      return false;
    }
    noteAbort();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal.removeEventListener('abort', forwardAbort);
  }

  if (!runId) return false;
  await publishPhase('finishing');
  const outcome: ReadingOutcome = {
    hasMore,
    terminalStatus: cancelled || paused ? 'partial' : terminalStatus,
    error: cancelled || (paused && failureCode !== 'time_limit') ? undefined : terminalError,
    failureCode,
    cancelled,
    paused,
  };
  if (options.profileId === undefined) {
    await transport.finish(runId, outcome);
  } else {
    await transport.finish(runId, outcome, options.profileId);
  }
  return !cancelled && !paused && terminalStatus !== 'failed';
}
