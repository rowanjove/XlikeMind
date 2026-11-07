import { describe, expect, it, vi } from 'vitest';
import type { CaptureResult } from '../src/adapters/types';
import { runReadingSession, type ReadingTransport } from '../src/content/readSession';
import { LikeMindDB } from '../src/storage/db';
import { SyncService } from '../src/sync/syncService';

function transport(overrides: Partial<ReadingTransport> = {}): ReadingTransport & {
  events: string[];
} {
  const events: string[] = [];
  return {
    events,
    begin: vi.fn(async () => {
      events.push('begin');
      return { success: true, runId: 'run_1' };
    }),
    ingest: vi.fn(async () => {
      events.push('ingest');
      return { success: true };
    }),
    finish: vi.fn(async (_runId: string, outcome) => {
      events.push(`finish:${outcome.cancelled ? 'cancelled' : outcome.terminalStatus}:${outcome.hasMore}`);
    }),
    ...overrides,
  };
}

describe('runReadingSession', () => {
  it('resumes the durable checkpoint when a committed batch loses its acknowledgement', async () => {
    const database = new LikeMindDB('lost-acknowledgement-fixture');
    try {
      const first = { postId: '51', text: 'First post' };
      const second = { postId: '52', text: 'Second post' };
      const makeBridge = (service: SyncService, dropAcknowledgement = false, replay = false): ReadingTransport => ({
        begin: async (limit, downloadMedia) => {
          const run = await service.beginXSync(limit, downloadMedia);
          return { success: true, runId: run.id, targetLimit: run.targetLimit, seenPostIds: run.seenPostIds, ...run.stats };
        },
        ingest: async (id, items) => {
          const saved = await service.ingestXBatch(id, replay ? [{ postId: first.postId, text: null as unknown as string }, ...items] : items);
          return dropAcknowledgement ? { success: false, transportError: 'timeout' } : { success: true, ...saved.stats };
        },
        finish: async (id, outcome) => { await service.finishXSync(id, outcome); },
      });
      const options = { limit: 2, downloadMedia: false, signal: new AbortController().signal };
      await runReadingSession(async () => ({ items: [first], status: 'partial', hasMore: true }),
        makeBridge(new SyncService(database), true), options);
      const paused = await database.syncRuns.toCollection().first();
      expect(paused).toMatchObject({ status: 'paused', failureCode: 'save_interrupted',
        seenPostIds: ['51'], stats: { scanned: 1, added: 1 } });
      const loadCheckpoint = vi.fn(async (_id, seenPostIds) => ({ cursor: 'continue', seenPostIds }));
      const capture = vi.fn(async (): Promise<CaptureResult> => ({ items: [second], status: 'partial', hasMore: false }));
      await runReadingSession(capture, makeBridge(new SyncService(database), false, true), { ...options, loadCheckpoint });
      expect(loadCheckpoint).toHaveBeenCalledWith(paused?.id, ['51']);
      expect(capture).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
      expect(await database.syncRuns.count()).toBe(1);
      expect(await database.syncRuns.get(paused!.id)).toMatchObject({
        status: 'partial', stats: { scanned: 2, added: 2, updated: 0, skipped: 0, failed: 0 },
      });
      expect(await database.posts.toCollection().primaryKeys()).toEqual(['x:51', 'x:52']);
      expect((await database.posts.get('x:51'))?.text).toBe(first.text);
    } finally {
      await database.delete();
    }
  });

  it('replays only the unacknowledged batch after a disconnect, then uses the saved scan count', async () => {
    const item = { postId: '51', text: 'saved before losing the acknowledgement' };
    const ingest = vi.fn<ReadingTransport['ingest']>()
      .mockResolvedValueOnce({ success: false, transportError: 'disconnected' })
      .mockResolvedValueOnce({ success: true, scanned: 1, added: 1 });
    const bridge = transport({ begin: async () => ({ success: true, runId: 'run_1', seenPostIds: [] }), ingest });
    const capture = vi.fn(async (): Promise<CaptureResult> => ({ items: [item], status: 'partial', hasMore: false }));
    expect(await runReadingSession(capture, bridge, { limit: 1, downloadMedia: false, signal: new AbortController().signal })).toBe(true);
    expect(ingest.mock.calls).toEqual([['run_1', [item]], ['run_1', [item]]]);
    expect(capture).toHaveBeenCalledOnce();
  });

  it('pauses a resumable run when the worker does not acknowledge the batch before timeout', async () => {
    const finish = vi.fn<ReadingTransport['finish']>().mockResolvedValue(undefined);
    const ingest = vi.fn<ReadingTransport['ingest']>().mockResolvedValue({ success: false, transportError: 'timeout' });
    const bridge = transport({ begin: async () => ({ success: true, runId: 'run_1', seenPostIds: [] }), ingest, finish });
    const capture = async (): Promise<CaptureResult> => ({ items: [{ postId: '51', text: 'fixture' }], status: 'partial', hasMore: true });
    expect(await runReadingSession(capture, bridge, { limit: 2, downloadMedia: false, signal: new AbortController().signal })).toBe(false);
    expect(ingest).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith('run_1', expect.objectContaining({ paused: true, failureCode: 'save_interrupted' }));
  });

  it('uses the persisted quota and continues through a replay-only segment', async () => {
    const bridge = transport({
      begin: vi.fn(async () => ({ success: true, runId: 'run_1', scanned: 1, targetLimit: 2, seenPostIds: ['51'] })),
      ingest: vi.fn(async () => ({ success: true, scanned: 2 })),
    });
    const capture = vi.fn()
      .mockResolvedValueOnce({ items: [], hasMore: true, cursor: 'continue', status: 'partial' })
      .mockResolvedValueOnce({ items: [{ postId: '52', text: 'New' }], hasMore: true, status: 'partial' });
    const loadCheckpoint = vi.fn(async (_runId, seenPostIds) => ({ cursor: 'continue', seenPostIds }));
    await runReadingSession(capture, bridge, {
      limit: 50, downloadMedia: false, signal: new AbortController().signal, loadCheckpoint,
    });
    expect(loadCheckpoint).toHaveBeenCalledWith('run_1', ['51']);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1, cursor: 'continue' }));
    expect(bridge.ingest).toHaveBeenCalledOnce();
  });

  it('saves a repair-only batch separately from fresh observations', async () => {
    const repair = { postId: '52', text: '补齐后的正文' };
    const bridge = transport({
      begin: vi.fn(async () => ({ success: true, runId: 'run_1', scanned: 5, resumePostIds: ['52'] })),
    });
    const capture = vi.fn(async (): Promise<CaptureResult> => ({
      items: [], repairs: [repair], hasMore: false, status: 'partial',
    }));
    await runReadingSession(capture, bridge, {
      limit: 20, downloadMedia: false, signal: new AbortController().signal,
    });
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ limit: 8, repairPostIds: ['52'] }));
    expect(bridge.ingest).toHaveBeenCalledWith('run_1', [], undefined, [repair]);
  });

  it('pauses at the continuous-read deadline after saving the current batch', async () => {
    vi.useFakeTimers();
    try {
      const bridge = transport();
      const checkpoint = vi.fn();
      const capture = vi.fn<(options: { signal?: AbortSignal }) => Promise<CaptureResult>>(({ signal }) =>
        new Promise((resolve) => signal?.addEventListener('abort', () => resolve({
          items: [{ postId: 'deadline', text: '已采集内容' }], hasMore: true, status: 'partial', cursor: 'continue',
        }), { once: true }))
      );
      const pending = runReadingSession(capture, bridge, {
        limit: 50, downloadMedia: false, signal: new AbortController().signal, maxDurationMs: 100,
        onCheckpoint: checkpoint,
      });
      await vi.advanceTimersByTimeAsync(101);
      expect(await pending).toBe(false);
      expect(bridge.ingest).toHaveBeenCalledWith('run_1', [{ postId: 'deadline', text: '已采集内容' }]);
      expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ seenPostIds: ['deadline'] }), 'run_1');
      expect(bridge.finish).toHaveBeenCalledWith('run_1', expect.objectContaining({
        paused: true, cancelled: false, failureCode: 'time_limit',
      }));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops after an explicit rate-limit notice while saving the parsed part of its batch', async () => {
    const bridge = transport();
    const capture = vi.fn(async (): Promise<CaptureResult> => ({
      items: [{ postId: 'saved', text: 'partial batch' }], status: 'failed', hasMore: false,
      failureCode: 'access_restricted', error: '页面提示请求频率受限',
    }));
    expect(await runReadingSession(capture, bridge, {
      limit: 50, downloadMedia: false, signal: new AbortController().signal,
    })).toBe(false);
    expect(bridge.ingest).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
    expect(bridge.finish).toHaveBeenCalledWith('run_1', expect.objectContaining({
      terminalStatus: 'failed', failureCode: 'access_restricted', paused: false,
    }));
  });

  it('saves each batch and finishes partial when the timeline ends', async () => {
    const capture = vi
      .fn<(_options: unknown) => Promise<CaptureResult>>()
      .mockResolvedValueOnce({
        items: [{ postId: '1', text: '展开后的全文' }],
        hasMore: true,
        cursor: 'continue',
        status: 'partial',
      })
      .mockResolvedValueOnce({
        items: [{ postId: '2', text: '第二条' }],
        hasMore: false,
        status: 'partial',
        error: '已到达末尾。这不代表历史点赞已全部采集。',
      });
    const bridge = transport();
    const controller = new AbortController();

    await runReadingSession(capture, bridge, { limit: 50, downloadMedia: true, signal: controller.signal });

    expect(bridge.events).toEqual(['begin', 'ingest', 'ingest', 'finish:partial:false']);
    expect(bridge.begin).toHaveBeenCalledWith(50, true);
  });

  it('emits a bounded resume checkpoint after each saved batch', async () => {
    const capture = vi.fn<(_options: unknown) => Promise<CaptureResult>>().mockResolvedValue({
      items: [{ postId: 'resume-1', text: 'saved' }],
      hasMore: false,
      status: 'partial',
    });
    const bridge = transport();
    const checkpoints: Array<{ seenPostIds: string[]; anchorPostId?: string }> = [];

    await runReadingSession(capture, bridge, {
      limit: 50,
      downloadMedia: false,
      signal: new AbortController().signal,
      loadCheckpoint: async (runId) => {
        expect(runId).toBe('run_1');
        return { cursor: 'continue', seenPostIds: Array.from({ length: 2500 }, (_, index) => String(index)) };
      },
      onCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    });

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].seenPostIds).toHaveLength(2000);
    expect(checkpoints[0].seenPostIds.at(-1)).toBe('resume-1');
    expect(checkpoints[0].anchorPostId).toBe('resume-1');
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'continue' }));
  });

  it('pauses after the saved batch and keeps the checkpoint', async () => {
    const controller = new AbortController();
    const capture = vi.fn<(_options: unknown) => Promise<CaptureResult>>(async () => {
      controller.abort('pause');
      return {
        items: [{ postId: 'paused-1', text: '先记下' }],
        hasMore: true,
        cursor: 'continue',
        status: 'partial',
      };
    });
    const bridge = transport();
    const checkpoints: Array<{ cursor?: string; anchorPostId?: string }> = [];

    const completed = await runReadingSession(capture, bridge, {
      limit: 50,
      downloadMedia: false,
      signal: controller.signal,
      onCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    });

    expect(completed).toBe(false);
    expect(checkpoints[0]).toMatchObject({ cursor: 'continue', anchorPostId: 'paused-1' });
    expect(bridge.finish).toHaveBeenCalledWith(
      'run_1',
      expect.objectContaining({ paused: true, cancelled: false, hasMore: true })
    );
  });

  it('finishes paused without capturing when pause is already requested', async () => {
    const capture = vi.fn();
    const bridge = transport();
    const controller = new AbortController();
    controller.abort('pause');

    const completed = await runReadingSession(capture, bridge, {
      limit: 25,
      downloadMedia: true,
      signal: controller.signal,
    });

    expect(completed).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    expect(bridge.finish).toHaveBeenCalledWith(
      'run_1',
      expect.objectContaining({ paused: true, cancelled: false })
    );
  });

  it('does not replay beyond the persisted scan limit when resuming', async () => {
    const capture = vi.fn();
    const bridge = transport({ begin: vi.fn(async () => ({ success: true, runId: 'run_1', scanned: 20 })) });
    await runReadingSession(capture, bridge, {
      limit: 20, downloadMedia: false, signal: new AbortController().signal,
    });
    expect(capture).not.toHaveBeenCalled();
    expect(bridge.finish).toHaveBeenCalledWith('run_1', expect.objectContaining({ hasMore: true, cancelled: false }));
  });

  it('finishes cancelled without capturing when stop is already requested', async () => {
    const capture = vi.fn();
    const bridge = transport();
    const controller = new AbortController();
    controller.abort();

    await runReadingSession(capture, bridge, { limit: 25, downloadMedia: true, signal: controller.signal });

    expect(capture).not.toHaveBeenCalled();
    expect(bridge.finish).toHaveBeenCalledWith(
      'run_1',
      expect.objectContaining({ cancelled: true })
    );
  });

  it('reports a rejected resume without replacing the paused snapshot', async () => {
    const paused = { runId: 'run_paused', status: 'paused' };
    await chrome.storage.local.set({ likemind_live_sync: paused });
    const bridge = transport({
      begin: vi.fn(async () => ({ success: false, error: '暂停任务的来源与当前页面不一致' })),
    });
    const onStart = vi.fn();
    const loadCheckpoint = vi.fn();
    await runReadingSession(vi.fn(), bridge, {
      limit: 50,
      downloadMedia: true,
      signal: new AbortController().signal,
      onStart,
      loadCheckpoint,
    });

    expect(bridge.finish).not.toHaveBeenCalled();
    const stored = await chrome.storage.local.get('likemind_live_sync');
    expect(stored.likemind_live_sync).toEqual(paused);
    expect(loadCheckpoint).not.toHaveBeenCalled();
    expect(onStart).toHaveBeenCalledWith({ started: false, reason: '暂停任务的来源与当前页面不一致' });
  });
});
