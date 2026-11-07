import { hasArchivedMedia } from '../domain/media';
import { captureDiagnosticFrames, logDiagnosticError } from '../domain/diagnosticFrames';
import Dexie from 'dexie';
import { db, type LikeMindDB } from '../storage/db';
import type { NormalizedPost, MediaAsset, SyncRun, SyncStats, PostSource } from '../domain/types';
import type { CaptureAdapter, CaptureResult, RawCapturedItem } from '../adapters/types';
import { calculateContentHash, calculateMergedContentHash } from '../domain/hash';
import { normalizePostReference } from '../domain/postReferences';
import { mergeNormalizedPost } from '../domain/merge';
import { sanitizeUrl } from '../domain/sanitize';
import { downloadMediaAsset } from './mediaDownloader';
import { hasFixedResumeLimit, publishLiveSnapshot, snapshotFromRun } from './liveSync';
import { DEFAULT_PROFILE_ID, getPageProfileId } from '../storage/profileScope';
import { CAPTURE_TIME_LIMIT_MESSAGE, type CaptureFailureCode } from '../adapters/captureFailure';
import { DEFAULT_SCAN_LIMIT, normalizeScanLimit } from '../adapters/captureLimits';
import { isMissingImage, retryMissingImages } from './retryMedia';

export const PAUSED_CAPTURE_MESSAGE = '采集已暂停，检查点还在。可以继续，也可以结束这次采集。';

export async function getPausedCaptureSource(database: LikeMindDB): Promise<PostSource | undefined> {
  const runs = await database.syncRuns.where('status').equals('paused').sortBy('lastCheckpointAt');
  return runs.at(-1)?.source;
}

export interface FinishXSyncOutcome {
  hasMore: boolean;
  terminalStatus: CaptureResult['status'];
  error?: string;
  failureCode?: CaptureFailureCode;
  cancelled?: boolean;
  paused?: boolean;
}

export interface StartSyncOptions {
  adapter: CaptureAdapter;
  targetLimit?: number;
  downloadMedia?: boolean;
  signal?: AbortSignal;
  onProgress?: (stats: SyncStats, currentPost?: NormalizedPost) => void;
}

/** Binding supplied by the background message channel for a content-script run. */
export interface SyncRunBinding {
  profileId?: string;
  tabId?: number;
  documentId?: string;
  expectedXHandle?: string;
  observedXHandle?: string;
}

type ProfileBoundSyncRun = SyncRun & {
  profileId?: string;
  sourceTabId?: number;
  sourceDocumentId?: string;
  expectedXHandle?: string;
  resumeRepairIds?: string[];
  resumeRepairAfterId?: string;
  resumeImageAfterId?: string;
};

const RESUME_POST_RETRY_LIMIT = 8;
const RESUME_IMAGE_RETRY_LIMIT = 4;
const RESUME_IMAGE_TIMEOUT_MS = 6_000;

export class SyncService {
  private database: LikeMindDB;
  private readonly profileId: string;

  constructor(database: LikeMindDB = db, profileId = getPageProfileId()) {
    this.database = database;
    this.profileId = profileId;
  }

  private async getObservedPosts(run: SyncRun): Promise<NormalizedPost[]> {
    const { posts } = this.database;
    if (!run.seenPostIds) return posts.where('sourceRunId').equals(run.id).toArray();
    const observed = await posts.bulkGet(run.seenPostIds.map((id) => `x:${id}`));
    return observed.filter((post): post is NormalizedPost => post !== undefined);
  }

  private bindRun(syncRun: SyncRun, binding?: SyncRunBinding): SyncRun {
    const bound = syncRun as ProfileBoundSyncRun;
    bound.profileId = this.profileId;
    if (typeof binding?.tabId === 'number') bound.sourceTabId = binding.tabId;
    if (binding?.documentId) bound.sourceDocumentId = binding.documentId;
    if (binding?.expectedXHandle) bound.expectedXHandle = binding.expectedXHandle;
    return syncRun;
  }

  private assertRunBinding(syncRun: SyncRun, binding?: SyncRunBinding): void {
    const bound = syncRun as ProfileBoundSyncRun;
    // Runs created before profile support have no marker and are only accepted
    // by the legacy default database. This keeps old local data readable while
    // preventing a run from being replayed into another profile database.
    if ((bound.profileId || DEFAULT_PROFILE_ID) !== this.profileId) {
      throw new Error('这次读取属于另一个档案');
    }
    if (binding?.profileId && binding.profileId !== this.profileId) {
      throw new Error('档案已切换，请重新开始读取');
    }
    if (typeof bound.sourceTabId === 'number' && bound.sourceTabId !== binding?.tabId) {
      throw new Error('读取来源标签页已变化，请重新开始读取');
    }
    if (bound.sourceDocumentId && bound.sourceDocumentId !== binding?.documentId) {
      throw new Error('读取来源页面已更新，请继续当前任务');
    }
  }

  /**
   * Normalize a raw scraped item to NormalizedPost
   */
  async normalizeItem(
    raw: RawCapturedItem,
    sourceAdapter: string,
    sourceRunId: string
  ): Promise<{ post: NormalizedPost; mediaAssets: MediaAsset[] }> {
    const nowIso = new Date().toISOString();
    const postId = raw.postId.trim();
    const mediaUrls = (raw.mediaUrls || []).map((url) => sanitizeUrl(url)).filter((url) => url.length > 0);
    const externalLinks = (raw.externalLinks || []).map((url) => sanitizeUrl(url)).filter((url) => url.length > 0);
    const references = (Array.isArray(raw.references) ? raw.references : []).flatMap((entry) => {
      const reference = typeof entry?.url === 'string' ? normalizePostReference(entry.kind, entry.url) : undefined;
      return reference && (reference.kind === 'article' || reference.kind === 'thread' || reference.id !== postId) ? [reference] : [];
    });
    const canonicalUrl = sanitizeUrl(raw.url || '') || `https://x.com/i/web/status/${encodeURIComponent(postId)}`;
    const avatarUrl = raw.authorAvatarUrl ? sanitizeUrl(raw.authorAvatarUrl) : '';

    const contentHash = await calculateContentHash({
      text: raw.text,
      authorHandle: raw.authorHandle,
      mediaUrls,
      externalLinks,
    });

    const mediaIds: string[] = mediaUrls.map((_, idx) => `${postId}_media_${idx}`);

    const post: NormalizedPost = {
      id: `x:${postId}`,
      platform: 'x',
      postId,
      canonicalUrl,
      author: {
        handle: raw.authorHandle,
        displayName: raw.authorDisplayName,
        avatarUrl: avatarUrl || undefined,
      },
      text: raw.text,
      postedAt: raw.postedAt || null,
      likedAt: null, // Strictly null; cannot be inferred from postedAt
      firstObservedAt: nowIso,
      lastObservedAt: nowIso,
      captureStatus: raw.isPartial ? 'partial' : 'complete',
      missingFields: raw.missingFields || [],
      externalLinks,
      ...(references.length ? { references } : {}),
      mediaIds,
      contentHash,
      sourceAdapter,
      sourceRunId,
      schemaVersion: 1,
    };

    const mediaAssets: MediaAsset[] = mediaUrls.map((url, idx) => ({
      id: `${postId}_media_${idx}`,
      postId: post.id,
      position: idx,
      kind: 'image',
      sourceUrl: url,
      altText: typeof raw.mediaAltTexts?.[url] === 'string' ? raw.mediaAltTexts[url].trim() || undefined : undefined,
      status: 'pending',
    }));

    return { post, mediaAssets };
  }

  private async markAnalysisStale(postId: string, contentHash: string): Promise<void> {
    const existing = await this.database.aiAnalysis.get(postId);
    if (!existing) return;
    if (existing.sourceHash === contentHash) return;
    if (existing.status !== 'complete' && existing.status !== 'failed') return;
    await this.database.aiAnalysis.put({
      ...existing,
      status: 'stale',
      updatedAt: new Date().toISOString(),
    });
  }

  private applyTerminalStatus(syncRun: SyncRun, outcome: FinishXSyncOutcome): void {
    if (syncRun.status !== 'running') return;
    if (outcome.paused) {
      syncRun.status = 'paused';
      if (outcome.failureCode === 'save_interrupted') {
        syncRun.failureCode = 'save_interrupted';
        syncRun.failureMessage = '扩展后台未确认这一批保存。已落盘的帖子仍在，可以继续原任务。';
      } else {
        syncRun.failureCode = outcome.failureCode === 'time_limit' ? 'time_limit' : 'paused';
        syncRun.failureMessage = outcome.failureCode === 'time_limit' ? CAPTURE_TIME_LIMIT_MESSAGE : PAUSED_CAPTURE_MESSAGE;
      }
      return;
    }
    if (outcome.cancelled) {
      syncRun.status = 'cancelled';
      syncRun.failureCode = 'cancelled';
      syncRun.failureMessage = '用户停止了本次同步，已保存检查点';
      return;
    }
    if (outcome.terminalStatus === 'failed') {
      syncRun.failureCode = outcome.failureCode ?? 'capture_failed';
      syncRun.failureMessage = outcome.error || 'Capture adapter reported failure';
      syncRun.status = syncRun.stats.scanned > 0 ? 'partial' : 'failed';
      return;
    }
    if (outcome.hasMore) {
      syncRun.status = 'partial';
      syncRun.failureCode = 'limit_reached';
      syncRun.failureMessage = `已达到本次扫描上限 ${syncRun.targetLimit}。这不代表历史点赞已全部采集。`;
      return;
    }
    if (outcome.terminalStatus === 'partial') {
      syncRun.status = 'partial';
      syncRun.failureCode = 'range_unknown';
      syncRun.failureMessage = outcome.error || '本次采集范围有限。这不代表历史点赞已全部采集。';
      return;
    }
    syncRun.status = 'completed';
  }

  private async persistRawItem(
    rawItem: RawCapturedItem,
    syncRun: SyncRun,
    sourceAdapter: string,
    signal?: AbortSignal,
    onProgress?: (stats: SyncStats, currentPost?: NormalizedPost) => void
  ): Promise<boolean> {
    if (!rawItem.postId?.trim()) {
      syncRun.stats.failed++;
      return this.checkpoint(syncRun);
    }

    syncRun.stats.scanned++;

    try {
      const { post, mediaAssets } = await this.normalizeItem(rawItem, sourceAdapter, syncRun.id);
      if (syncRun.source) post.sources = [syncRun.source];
      const { savedPost, outcome, observedMedia, contentChanged } = await this.saveObservedPost(
        post, mediaAssets, syncRun.downloadMedia ? 'pending' : 'remote_only'
      );
      syncRun.stats[outcome]++;
      if (contentChanged && !syncRun.changedPostIds?.includes(post.id)) (syncRun.changedPostIds ??= []).push(post.id);

      if (syncRun.downloadMedia) await this.downloadObservedMedia(observedMedia, post.id, sourceAdapter, signal);
      onProgress?.(syncRun.stats, savedPost);
    } catch (itemErr) {
      logDiagnosticError('sync_item', itemErr);
      syncRun.stats.failed++;
    }
    return this.checkpoint(syncRun);
  }

  private async downloadObservedMedia(assets: MediaAsset[], postId: string, sourceAdapter: string, signal?: AbortSignal): Promise<void> {
    await Promise.all(assets.map(async (media) => {
      const existingMedia = await this.database.media.get(media.id);
      if (!existingMedia || existingMedia.sourceUrl !== media.sourceUrl ||
          hasArchivedMedia(existingMedia)) return;
      const { asset: downloaded } = await downloadMediaAsset(media, {
        signal,
        fixtureMode: sourceAdapter === 'fixture',
      });
      await this.database.transaction('rw', [this.database.posts, this.database.media], async () => {
        const latestPost = await this.database.posts.get(postId);
        const current = await this.database.media.get(media.id);
        if (!latestPost?.mediaIds.includes(media.id) || !current || current.sourceUrl !== media.sourceUrl) return;
        if (hasArchivedMedia(current) && !hasArchivedMedia(downloaded)) return;
        await this.database.media.put({ ...downloaded, sourceUrl: media.sourceUrl, altText: current.altText });
      });
    }));
  }

  /**
   * Write the checkpoint without moving a finished run back to running.
   * Returns false when this task should stop.
   */
  private async checkpoint(syncRun: SyncRun): Promise<boolean> {
    const now = new Date().toISOString();
    const current = await this.database.syncRuns.get(syncRun.id);
    if (current && current.status !== 'running' && syncRun.status === 'running') {
      current.stats = { ...syncRun.stats };
      current.lastCheckpointAt = now;
      await this.database.syncRuns.put(current);
      await publishLiveSnapshot(snapshotFromRun(current), this.profileId);
      return false;
    }
    syncRun.lastCheckpointAt = now;
    await this.database.syncRuns.put(syncRun);
    await publishLiveSnapshot(snapshotFromRun(syncRun), this.profileId);
    return syncRun.status === 'running';
  }

  /** Start a likes-page read whose batches arrive from the content script. A paused run continues as the same task. */
  async beginXSync(
    targetLimit: number,
    downloadMedia: boolean,
    source?: PostSource,
    binding?: SyncRunBinding
  ): Promise<ProfileBoundSyncRun & { resumePostIds?: string[] }> {
    const limit = normalizeScanLimit(targetLimit);
    const nowIso = new Date().toISOString();
    const { syncRuns, posts } = this.database;
    const { syncRun, resumeMediaPostIds, resumePostIds } = await this.database.transaction('rw', syncRuns, posts, async () => {
      if (binding?.documentId && await syncRuns.where('status').equals('running')
        .filter((run) => run.adapterType === 'x_dom').count()) {
        throw new Error('此档案已有正在进行的采集。请等待任务保存，或在同步页恢复已中断的任务。');
      }
      const pausedRuns = await syncRuns.where('status').equals('paused').toArray();
      pausedRuns.sort((a, b) => (b.lastCheckpointAt || b.startedAt).localeCompare(a.lastCheckpointAt || a.startedAt));
      const paused = pausedRuns[0] as ProfileBoundSyncRun | undefined;
      if (paused) {
        if (paused.expectedXHandle !== binding?.expectedXHandle) {
          throw new Error('暂停任务的 X 账号与当前账号不一致。请切回原账号和绑定，或结束这次采集后重新开始。');
        }
        if (paused.source !== source) {
          throw new Error('暂停任务的来源与当前页面不一致。请回到原点赞或收藏列表，或结束这次采集后重新开始。');
        }
        this.assertRunBinding(paused, { ...binding, tabId: paused.sourceTabId, documentId: paused.sourceDocumentId });
        const interrupted = hasFixedResumeLimit(paused);
        if (interrupted && paused.source && !paused.expectedXHandle) {
          throw new Error('无法确认中断前的 X 账号。请结束该任务，再开始新的采集。');
        }
        paused.status = 'running';
        delete paused.endedAt;
        delete paused.failureCode;
        delete paused.failureMessage;
        delete paused.diagnosticFrames;
        paused.lastCheckpointAt = nowIso;
        if (!interrupted) paused.targetLimit = Math.max(limit, paused.stats.scanned);
        paused.downloadMedia = downloadMedia;
        this.bindRun(paused, binding);
        const saved = await this.getObservedPosts(paused);
        const nextRepairIndex = saved.findIndex((post) => post.id === paused.resumeRepairAfterId) + 1;
        const repairOrder = [...saved.slice(nextRepairIndex), ...saved.slice(0, nextRepairIndex)];
        const incomplete = repairOrder.filter((post) => post.captureStatus !== 'complete' && /^\d{1,25}$/.test(post.postId))
          .slice(0, RESUME_POST_RETRY_LIMIT);
        paused.resumeRepairIds = incomplete.map((post) => post.id);
        if (incomplete.length) paused.resumeRepairAfterId = incomplete[incomplete.length - 1].id;
        paused.repairStats ??= { textAttempts: 0, textRecovered: 0, imageAttempts: 0, imagesRecovered: 0 };
        delete paused.repairStats.remainingPosts;
        delete paused.repairStats.remainingImages;
        await syncRuns.put(paused);
        return {
          syncRun: paused,
          resumeMediaPostIds: downloadMedia ? saved.map((post) => post.id) : [],
          resumePostIds: incomplete.map((post) => post.postId),
        };
      }
      const run: SyncRun = {
        id: `run_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        startedAt: nowIso,
        lastCheckpointAt: nowIso,
        status: 'running',
        stats: { scanned: 0, added: 0, updated: 0, skipped: 0, failed: 0 },
        targetLimit: limit,
        downloadMedia,
        adapterType: 'x_dom',
        source,
      };
      this.bindRun(run, binding);
      (run as ProfileBoundSyncRun).seenPostIds = [];
      await syncRuns.put(run);
      return { syncRun: run };
    });
    await publishLiveSnapshot(snapshotFromRun(syncRun, resumeMediaPostIds?.length ? 'repairing' : 'reading'), this.profileId);
    if (resumeMediaPostIds?.length) {
      await this.retryResumeImages(syncRun.id, resumeMediaPostIds);
    }
    return resumePostIds?.length ? { ...syncRun, resumePostIds } : syncRun;
  }

  private async retryResumeImages(runId: string, postIds: string[], assetIds?: ReadonlySet<string>): Promise<void> {
    let imageAttempts = 0;
    let imagesRecovered = 0;
    let lastAttemptedId: string | undefined;
    const priorRun = assetIds ? undefined : await this.database.syncRuns.get(runId) as ProfileBoundSyncRun | undefined;
    try {
      await retryMissingImages(this.database, postIds, {
        signal: AbortSignal.timeout(RESUME_IMAGE_TIMEOUT_MS), limit: RESUME_IMAGE_RETRY_LIMIT,
        assetIds,
        afterAssetId: priorRun?.resumeImageAfterId,
        onProgress: (progress) => {
          imageAttempts = progress.attempted;
          imagesRecovered = progress.downloaded;
          lastAttemptedId = progress.lastAttemptedId;
        },
      });
    } catch {
      // Leave failed assets available for another retry. Resuming the page scan can proceed.
    }
    if (imageAttempts > 0) {
      await this.database.syncRuns.where('id').equals(runId).modify((current) => {
        if (!current.repairStats) return;
        current.repairStats.imageAttempts += imageAttempts;
        current.repairStats.imagesRecovered += imagesRecovered;
        if (!assetIds && lastAttemptedId) (current as ProfileBoundSyncRun).resumeImageAfterId = lastAttemptedId;
      });
    }
  }

  async ingestXBatch(runId: string, items: RawCapturedItem[], binding?: SyncRunBinding, repairs: RawCapturedItem[] = []): Promise<SyncRun> {
    const syncRun = await this.database.syncRuns.get(runId);
    if (!syncRun) throw new Error('找不到这次读取任务');
    this.assertRunBinding(syncRun, binding);
    const expected = (syncRun as ProfileBoundSyncRun).expectedXHandle;
    if (expected && binding?.observedXHandle !== expected) {
      throw new Error('读取期间无法确认原登录账号，已停止保存本批次。');
    }
    if (syncRun.status !== 'running') throw new Error('这次读取已经结束');

    try {
      return await this.saveXBatch(syncRun, items, binding, repairs);
    } catch (error) {
      const diagnosticFrames = captureDiagnosticFrames(error);
      if (diagnosticFrames) {
        const { syncRuns } = this.database;
        try {
          await this.database.transaction('rw', syncRuns, async () => {
            const current = await syncRuns.get(runId);
            if (current?.status !== 'running') return;
            this.assertRunBinding(current, binding);
            await syncRuns.update(runId, { diagnosticFrames });
          });
        } catch {
          // A diagnostic write must not replace the original save failure.
        }
      }
      throw error;
    }
  }

  private async saveXBatch(syncRun: SyncRun, items: RawCapturedItem[], binding: SyncRunBinding | undefined, repairs: RawCapturedItem[]) {
    const runId = syncRun.id;
    const { syncRuns, posts, media, aiAnalysis } = this.database;
    const repairedImages = new Set<string>();
    const repairedPostIds: string[] = [];
    for (const item of repairs.slice(0, RESUME_POST_RETRY_LIMIT)) {
      if (typeof item?.postId !== 'string' || !/^\d{1,25}$/.test(item.postId) || typeof item.text !== 'string') continue;
      const postId = `x:${item.postId}`;
      const pendingImages = await this.database.transaction('rw', syncRuns, posts, media, aiAnalysis, async () => {
        const latest = await syncRuns.get(runId) as ProfileBoundSyncRun | undefined;
        if (latest?.status !== 'running' || !latest.resumeRepairIds?.includes(postId)) return;
        this.assertRunBinding(latest, binding);
        const saved = await posts.get(postId);
        let pendingImages: string[] = [];
        if (saved && saved.captureStatus !== 'complete') {
          const { post, mediaAssets } = await Dexie.waitFor(this.normalizeItem(item, 'x_dom_reload', runId));
          const { savedPost, observedMedia, contentChanged } = await this.saveObservedPost(post, mediaAssets, latest.downloadMedia ? 'pending' : 'remote_only');
          if (contentChanged && !latest.changedPostIds?.includes(postId)) (latest.changedPostIds ??= []).push(postId);
          if (latest.downloadMedia) {
            pendingImages = observedMedia.filter((asset) => asset.status === 'pending' && isMissingImage(asset)).map((asset) => asset.id);
          }
          if (latest.repairStats) {
            latest.repairStats.textAttempts++;
            if (savedPost.captureStatus === 'complete') latest.repairStats.textRecovered++;
          }
        }
        latest.resumeRepairIds = latest.resumeRepairIds.filter((id) => id !== postId);
        await syncRuns.put(latest);
        return pendingImages;
      });
      if (pendingImages?.length) {
        repairedPostIds.push(postId);
        for (const id of pendingImages) repairedImages.add(id);
      }
    }
    if (repairs.length) {
      const latest = await syncRuns.get(runId);
      if (latest?.status !== 'running') throw new Error('这次读取已经结束');
      syncRun = latest;
      this.assertRunBinding(syncRun, binding);
      if (repairedImages.size) {
        await this.retryResumeImages(runId, repairedPostIds, repairedImages);
        syncRun = (await syncRuns.get(runId)) ?? syncRun;
      }
    }
    for (const item of items) {
      syncRun = await this.persistXObservation(runId, item, binding);
      if (syncRun.status !== 'running') break;
    }
    return syncRun;
  }

  private async persistXObservation(runId: string, item: RawCapturedItem, binding?: SyncRunBinding): Promise<SyncRun> {
    const { syncRuns, posts, media, aiAnalysis } = this.database;
    const postId = typeof item?.postId === 'string' ? item.postId.trim() : '';
    const { run, observedMedia } = await this.database.transaction('rw', syncRuns, posts, media, aiAnalysis, async () => {
      const run = await syncRuns.get(runId) as ProfileBoundSyncRun;
      this.assertRunBinding(run, binding);
      if (run.status !== 'running') return { run, observedMedia: [] };
      if (run.seenPostIds?.includes(postId)) {
        // The observation can commit before its image downloads finish. A replay
        // only completes pending images, leaving the post and quota untouched.
        const saved = run.downloadMedia ? await posts.get(`x:${postId}`) : undefined;
        const pending = saved ? await media.bulkGet(saved.mediaIds) : [];
        return { run, observedMedia: pending.filter((asset): asset is MediaAsset => asset?.status === 'pending') };
      }
      if (run.stats.scanned >= run.targetLimit) return { run, observedMedia: [] };
      const normalized = postId ? await Dexie.waitFor(this.normalizeItem(item, 'x_dom', runId)) : undefined;
      let observedMedia: MediaAsset[] = [];
      if (normalized) {
        const { post, mediaAssets } = normalized;
        if (run.source) post.sources = [run.source];
        const saved = await this.saveObservedPost(post, mediaAssets, run.downloadMedia ? 'pending' : 'remote_only');
        observedMedia = saved.observedMedia;
        run.stats[saved.outcome]++;
        if (saved.contentChanged && !run.changedPostIds?.includes(post.id)) (run.changedPostIds ??= []).push(post.id);
        run.stats.scanned++;
        run.seenPostIds?.push(postId);
      } else {
        run.stats.failed++;
      }
      run.lastCheckpointAt = new Date().toISOString();
      await syncRuns.put(run);
      return { run, observedMedia };
    });
    await publishLiveSnapshot(snapshotFromRun(run, run.status === 'running' ? 'saving' : undefined), this.profileId);
    if (run.downloadMedia && observedMedia.length) {
      await this.downloadObservedMedia(observedMedia, observedMedia[0].postId, 'x_dom');
    }
    return (await syncRuns.get(runId)) ?? run;
  }

  /** Refresh a visible post without downloading media. New URLs are persisted
   * as pending placeholders so a later explicit retry cannot restore an old
   * image Blob. */
  async refreshPost(rawItem: RawCapturedItem, sourceAdapter = 'x_dom_reload'): Promise<NormalizedPost> {
    const { post, mediaAssets } = await this.normalizeItem(rawItem, sourceAdapter, `reload_${Date.now()}`);
    return (await this.saveObservedPost(post, mediaAssets, 'pending')).savedPost;
  }

  private saveObservedPost(post: NormalizedPost, mediaAssets: MediaAsset[], pendingStatus: 'pending' | 'remote_only') {
    const { posts, media, aiAnalysis } = this.database;
    return this.database.transaction('rw', [posts, media, aiAnalysis], async () => {
      const existing = await posts.get(post.id);
      const { merged, isUpdated } = existing ? mergeNormalizedPost(existing, post) : { merged: post, isUpdated: true };
      const stored = await media.where('postId').equals(post.id).sortBy('position');
      const storedById = new Map(stored.map((asset) => [asset.id, asset]));
      const storedByUrl = new Map(stored.map((asset) => [asset.sourceUrl, asset]));
      const preserve = post.captureStatus !== 'complete' || mediaAssets.length === 0;
      const retained = preserve ? [...stored] : [];
      let nextPosition = (stored.at(-1)?.position ?? -1) + 1;
      const observedMedia = mediaAssets.map((asset) => {
        const previous = storedByUrl.get(asset.sourceUrl);
        const altText = asset.altText ?? previous?.altText;
        if (!preserve) {
          // A complete observation owns order. Carry a matching Blob to its new position.
          return previous ? { ...previous, id: asset.id, position: asset.position, altText } : { ...asset, status: pendingStatus };
        }
        if (previous) return { ...previous, altText };
        // A partial list has no reliable position for an attachment it just revealed.
        const position = nextPosition++;
        const appended = { ...asset, id: `${post.postId}_media_${position}`, position, status: pendingStatus };
        retained.push(appended);
        storedByUrl.set(appended.sourceUrl, appended);
        return appended;
      });
      const observedById = new Map(observedMedia.map((asset) => [asset.id, asset]));
      const finalMedia = preserve ? retained.map((asset) => observedById.get(asset.id) ?? asset) : observedMedia;
      merged.mediaIds = finalMedia.map((asset) => asset.id);
      const retainedIds = new Set(merged.mediaIds);
      const removed = stored.filter((asset) => !retainedIds.has(asset.id)).map((asset) => asset.id);
      const changed = finalMedia.filter((asset) => {
        const previous = storedById.get(asset.id);
        return previous?.sourceUrl !== asset.sourceUrl || previous.altText !== asset.altText;
      });
      if (removed.length) await media.bulkDelete(removed);
      if (changed.length) await media.bulkPut(changed);

      merged.contentHash = await Dexie.waitFor(calculateMergedContentHash(
        merged, finalMedia.map((asset) => asset.sourceUrl), post, mediaAssets.map((asset) => asset.sourceUrl),
        existing ? { post: existing, mediaUrls: stored.map((asset) => asset.sourceUrl) } : undefined,
      ));
      await posts.put(merged);
      const contentChanged = Boolean(existing && merged.contentHash !== existing.contentHash);
      if (contentChanged) {
        await this.markAnalysisStale(post.id, merged.contentHash);
      }
      const updated = isUpdated || removed.length > 0 || changed.length > 0 || merged.contentHash !== existing?.contentHash;
      const outcome: 'added' | 'updated' | 'skipped' = !existing ? 'added' : updated ? 'updated' : 'skipped';
      return { savedPost: merged, outcome, observedMedia, contentChanged };
    });
  }

  async finishXSync(runId: string, outcome: FinishXSyncOutcome, binding?: SyncRunBinding): Promise<SyncRun> {
    const { syncRuns, posts, media } = this.database;
    const syncRun = await this.database.transaction('rw', syncRuns, posts, media, async () => {
      const run = await syncRuns.get(runId);
      if (!run) throw new Error('找不到这次读取任务');
      this.assertRunBinding(run, binding);
      if (run.status !== 'running') return run;
      this.applyTerminalStatus(run, outcome);
      if (run.repairStats) {
        const saved = await this.getObservedPosts(run);
        run.repairStats.remainingPosts = saved.filter((post) => post.captureStatus !== 'complete').length;
        run.repairStats.remainingImages = await media.where('postId').anyOf(saved.map((post) => post.id))
          .filter(isMissingImage).count();
      }
      run.endedAt = new Date().toISOString();
      run.lastCheckpointAt = run.endedAt;
      await syncRuns.put(run);
      return run;
    });
    await publishLiveSnapshot(snapshotFromRun(syncRun), this.profileId);
    return syncRun;
  }

  /**
   * Run a sync operation with the provided adapter and options
   */
  async runSync(options: StartSyncOptions): Promise<SyncRun> {
    const { adapter, targetLimit = DEFAULT_SCAN_LIMIT, downloadMedia = true, signal, onProgress } = options;

    const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const nowIso = new Date().toISOString();

    const syncRun: SyncRun = {
      id: runId,
      startedAt: nowIso,
      lastCheckpointAt: nowIso,
      status: 'running',
      stats: {
        scanned: 0,
        added: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
      },
      targetLimit,
      downloadMedia,
      adapterType: adapter.name === 'fixture' ? 'fixture' : 'x_dom',
    };

    this.bindRun(syncRun);
    await this.database.syncRuns.put(syncRun);

    let hasMore = true;
    let terminalStatus: CaptureResult['status'] = 'complete';
    let terminalError: string | undefined;
    let terminalFailureCode: CaptureFailureCode | undefined;

    try {
      let currentCursor: string | undefined = undefined;

      while (hasMore && syncRun.stats.scanned < targetLimit) {
        if (signal?.aborted) {
          syncRun.status = 'cancelled';
          syncRun.failureCode = 'cancelled';
          syncRun.failureMessage = '用户停止了本次同步，已保存检查点';
          break;
        }

        const batchLimit = Math.min(25, targetLimit - syncRun.stats.scanned);
        const result = await adapter.captureBatch({
          limit: batchLimit,
          cursor: currentCursor,
          signal,
        });
        terminalStatus = result.status;
        terminalFailureCode = result.failureCode;
        if (result.error) terminalError = result.error;

        if (signal?.aborted) {
          syncRun.status = 'cancelled';
          syncRun.failureCode = 'cancelled';
          syncRun.failureMessage = '用户停止了本次同步，已保存检查点';
        }

        if (result.status === 'failed') {
          syncRun.failureCode = result.failureCode ?? 'capture_failed';
          syncRun.failureMessage = result.error || 'Capture adapter reported failure';
          syncRun.status = syncRun.stats.scanned > 0 ? 'partial' : 'failed';
          break;
        }

        for (const rawItem of result.items) {
          if (signal?.aborted) {
            syncRun.status = 'cancelled';
            syncRun.failureCode = 'cancelled';
            syncRun.failureMessage = '用户停止了本次同步，已保存检查点';
            break;
          }
          const keepGoing = await this.persistRawItem(rawItem, syncRun, adapter.name, signal, onProgress);
          if (!keepGoing) break;
        }

        hasMore = result.hasMore;
        currentCursor = result.cursor;
        syncRun.cursor = currentCursor;

        if (syncRun.status === 'cancelled' || result.items.length === 0 || !hasMore) {
          break;
        }
      }

      this.applyTerminalStatus(syncRun, {
        hasMore,
        terminalStatus,
        error: terminalError,
        failureCode: terminalFailureCode,
      });
    } catch (err: unknown) {
      syncRun.status = syncRun.stats.scanned > 0 ? 'partial' : 'failed';
      syncRun.failureCode = 'capture_failed';
      syncRun.failureMessage = err instanceof Error ? err.message : String(err);
      syncRun.diagnosticFrames = captureDiagnosticFrames(err);
    } finally {
      const now = new Date().toISOString();
      const current = await this.database.syncRuns.get(syncRun.id);
      if (current && current.status !== 'running' && syncRun.status === 'running') {
        current.stats = { ...syncRun.stats };
        current.lastCheckpointAt = now;
        if (!current.endedAt) current.endedAt = now;
        await this.database.syncRuns.put(current);
        await publishLiveSnapshot(snapshotFromRun(current), this.profileId);
      } else {
        syncRun.endedAt = now;
        syncRun.lastCheckpointAt = now;
        await this.database.syncRuns.put(syncRun);
        await publishLiveSnapshot(snapshotFromRun(syncRun), this.profileId);
      }
    }

    return syncRun;
  }

  /**
   * Make interrupted DOM runs with durable observations available to continue.
   * Legacy runs lack the information needed to safely replay their prefix.
   */
  /**
   * Mark abandoned running tasks as partial.
   * maxAgeMs 0 recovers every running task. A positive age leaves a live
   * checkpoint alone so opening the dashboard does not kill an active read.
   */
  async recoverStaleRuns(maxAgeMs = 0): Promise<SyncRun[]> {
    const now = Date.now();
    const { syncRuns } = this.database;
    const recovered = await this.database.transaction('rw', syncRuns, async () => {
      const running = await syncRuns.where('status').equals('running').toArray() as ProfileBoundSyncRun[];
      const stale = running.filter((run) => {
        const checkpoint = Date.parse(run.lastCheckpointAt || run.startedAt);
        return maxAgeMs <= 0 || !Number.isFinite(checkpoint) || now - checkpoint >= maxAgeMs;
      });
      for (const run of stale) {
        const resumable = run.adapterType === 'x_dom' && Array.isArray(run.seenPostIds) &&
          (!run.source || !!run.expectedXHandle);
        run.status = resumable ? 'paused' : 'partial';
        run.failureCode = 'interrupted';
        run.failureMessage = resumable
          ? '上次读取被中断，已保存的帖子都还在。可从原点赞或收藏页继续采集。'
          : run.adapterType === 'x_archive'
            ? '上次归档导入被中断。可重新选择同一归档，已保存的帖子会去重。'
            : '上次读取被中断，已保存的帖子都还在。请重新开始采集。';
        run.endedAt = new Date(now).toISOString();
        this.bindRun(run);
      }
      await syncRuns.bulkPut(stale);
      return stale;
    });
    for (const run of recovered) {
      await publishLiveSnapshot(snapshotFromRun(run), this.profileId);
    }
    return recovered;
  }

  /** End a paused capture so the library can be deleted. Saved posts stay. */
  async endPausedSync(): Promise<number> {
    const { syncRuns } = this.database;
    const paused = await this.database.transaction('rw', syncRuns, async () => {
      const runs = await syncRuns.where('status').equals('paused').toArray();
      const now = new Date().toISOString();
      for (const run of runs) {
        run.status = 'cancelled';
        run.failureCode = 'cancelled';
        run.failureMessage = '用户结束了暂停的采集，已保存的帖子都还在。';
        run.endedAt = now;
        run.lastCheckpointAt = now;
      }
      if (runs.length) await syncRuns.bulkPut(runs);
      return runs;
    });
    for (const run of paused) {
      await publishLiveSnapshot(snapshotFromRun(run), this.profileId);
    }
    return paused.length;
  }

  async checkAndRecoverDanglingRuns(): Promise<SyncRun | null> {
    const recovered = await this.recoverStaleRuns(0);
    return recovered[0] ?? null;
  }
}

export const syncService = new SyncService();
