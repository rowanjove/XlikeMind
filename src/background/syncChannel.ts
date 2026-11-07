import type { CaptureResult, RawCapturedItem } from '../adapters/types';
import { normalizeXHandle } from '../adapters/xAccount';
import { getProfile, getProfiles, DEFAULT_PROFILE_ID } from '../storage/profiles';
import { getProfileDatabase } from '../storage/db';
import { SyncService, type SyncRunBinding } from '../sync/syncService';
import { isCaptureFailureCode } from '../adapters/captureFailure';
import { normalizeScanLimit } from '../adapters/captureLimits';

const SYNC_TYPES = new Set(['BEGIN_X_SYNC', 'INGEST_X_BATCH', 'FINISH_X_SYNC', 'GET_QUICK_STATS']);
const services = new Map<string, SyncService>();

export interface SyncMessageContext {
  tabId?: number;
  documentId?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  const text = String(err).trim();
  return text && text !== 'undefined' ? text : '无法开始保存';
}

export function isSyncMessage(message: unknown): boolean {
  return SYNC_TYPES.has(String(asRecord(message).type || ''));
}

function requestedProfileId(record: Record<string, unknown>): string {
  if (record.profileId === undefined) return DEFAULT_PROFILE_ID;
  if (typeof record.profileId !== 'string' || !record.profileId.trim()) {
    throw new Error('缺少有效的档案编号');
  }
  return record.profileId;
}

function observedHandle(record: Record<string, unknown>): string | undefined {
  return typeof record.xHandle === 'string' ? normalizeXHandle(record.xHandle) : undefined;
}

async function verifyProfileAccount(profileId: string, observed?: string): Promise<string | undefined> {
  const profile = await getProfile(profileId);
  if (!profile) throw new Error('找不到该档案，请刷新扩展页面后重试');
  if (profile.bindingConflict) throw new Error('此文库的旧账号绑定有冲突，请先在设置中确认并保存账号绑定。');
  const expected = profile.xHandle;
  if (expected && !observed) throw new Error('无法确认 X 当前登录账号。请登录后刷新 X 页面，再重试。');
  if (expected && expected !== observed) throw new Error('当前 X 登录账号与此档案绑定的用户名不符。请切换账号或档案。');
  return expected;
}

async function getService(profileId: string): Promise<SyncService> {
  const existing = services.get(profileId);
  if (existing) return existing;
  const profile = await getProfile(profileId);
  if (!profile) throw new Error('找不到该档案，请刷新扩展页面后重试');
  const service = new SyncService(getProfileDatabase(profile.id), profile.id);
  services.set(profile.id, service);
  return service;
}

export async function recoverProfileRuns(maxAgeMs = 0): Promise<void> {
  const profiles = await getProfiles();
  await Promise.all(profiles.map(async (profile) => {
    await (await getService(profile.id)).recoverStaleRuns(maxAgeMs);
  }));
}

/** Save-path messages. Returns null when this channel does not own the message. */
export async function handleSyncMessage(
  message: unknown,
  context: SyncMessageContext = {}
): Promise<Record<string, unknown> | null> {
  const record = asRecord(message);
  const type = record.type;

  if (type === 'BEGIN_X_SYNC') {
    try {
      const profileId = requestedProfileId(record);
      const service = await getService(profileId);
      const xHandle = observedHandle(record);
      const expectedXHandle = await verifyProfileAccount(profileId, xHandle);
      const targetLimit = normalizeScanLimit(record.targetLimit);
      const source = record.source === 'x_likes' || record.source === 'x_bookmarks' ? record.source : undefined;
      const binding: SyncRunBinding = { profileId, ...context, expectedXHandle: expectedXHandle ?? xHandle };
      const run = await service.beginXSync(targetLimit, record.downloadMedia !== false, source, binding);
      if (!run.id) return { success: false, error: '无法开始保存' };
      return { success: true, runId: run.id, profileId, stats: run.stats, targetLimit: run.targetLimit,
        resumePostIds: run.resumePostIds, seenPostIds: run.seenPostIds };
    } catch (err) {
      return { success: false, error: errorText(err) };
    }
  }

  if (type === 'INGEST_X_BATCH') {
    try {
      if (typeof record.runId !== 'string' || !record.runId) {
        return { success: false, error: '缺少读取任务编号' };
      }
      const profileId = requestedProfileId(record);
      const service = await getService(profileId);
      const xHandle = observedHandle(record);
      await verifyProfileAccount(profileId, xHandle);
      const items = Array.isArray(record.items) ? (record.items as RawCapturedItem[]).slice(0, 50) : [];
      const repairs = Array.isArray(record.repairs) ? record.repairs as RawCapturedItem[] : [];
      const run = await service.ingestXBatch(record.runId, items, { profileId, ...context, observedXHandle: xHandle }, repairs);
      return { success: true, stats: run.stats };
    } catch (err) {
      return { success: false, error: errorText(err) };
    }
  }

  if (type === 'FINISH_X_SYNC') {
    try {
      if (typeof record.runId !== 'string' || !record.runId) {
        return { success: false, error: '缺少读取任务编号' };
      }
      const profileId = requestedProfileId(record);
      const service = await getService(profileId);
      const terminalStatus: CaptureResult['status'] =
        record.terminalStatus === 'failed' || record.terminalStatus === 'complete'
          ? record.terminalStatus
          : 'partial';
      const run = await service.finishXSync(record.runId, {
        hasMore: Boolean(record.hasMore),
        terminalStatus,
        error: typeof record.error === 'string' ? record.error : undefined,
        failureCode: isCaptureFailureCode(record.failureCode) ? record.failureCode : undefined,
        cancelled: Boolean(record.cancelled),
        paused: Boolean(record.paused),
      }, { profileId, ...context });
      return { success: true, status: run.status, stats: run.stats };
    } catch (err) {
      return { success: false, error: errorText(err) };
    }
  }

  if (type === 'GET_QUICK_STATS') {
    try {
      const profileId = requestedProfileId(record);
      const profile = await getProfile(profileId);
      if (!profile) throw new Error('找不到该档案，请刷新扩展页面后重试');
      const profileDb = getProfileDatabase(profile.id);
      const totalPosts = await profileDb.posts.count();
      const downloadedMedia = await profileDb.media.where('status').equals('downloaded').count();
      const latestRun = await profileDb.syncRuns.orderBy('startedAt').reverse().first();
      return {
        success: true,
        stats: { totalPosts, downloadedMedia, latestRun },
      };
    } catch (err) {
      return { success: false, error: errorText(err) };
    }
  }

  return null;
}
