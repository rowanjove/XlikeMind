import React, { useState, useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { SyncRun, SyncStats } from '../../domain/types';
import {
  Pause,
  Play,
  Square,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Upload,
  FolderOpen,
  Database,
  Settings2,
} from 'lucide-react';
import { getPausedCaptureSource, PAUSED_CAPTURE_MESSAGE, syncService } from '../../sync/syncService';
import { isXAuthenticationUrl } from '../../adapters/captureFailure';
import { isXPageUrl, matchesCaptureSource, missingCaptureSource } from '../../adapters/findLikesTab';
import { DEFAULT_SCAN_LIMIT, MAX_SCAN_LIMIT } from '../../adapters/captureLimits';
import { getLikesEntry } from '../../storage/capturePreferences';
import { describePageProbe, type PageProbe } from '../pageProbe';
import { hasFixedResumeLimit, LIVE_SYNC_KEY, type LiveSyncSnapshot, type SyncPhase } from '../../sync/liveSync';
import { db } from '../../storage/db';
import { parseArchiveFile, importArchiveItems, type ArchiveImportResult } from '../../importers/archiveImporter';
import { describeSyncSource } from '../../domain/digests';
import { getPageProfileId, profileStorageKey } from '../../storage/profileScope';

function hasNoNewPosts(
  { status, failureCode }: Pick<LiveSyncSnapshot, 'status' | 'failureCode'>,
  { scanned, added, skipped, updated, failed }: SyncStats,
): boolean {
  const scannedNormally = status === 'completed' ||
    (status === 'partial' && (failureCode === 'range_unknown' || failureCode === 'limit_reached'));
  return scannedNormally && scanned > 0 && added === 0 && failed === 0 && skipped + updated === scanned;
}

const NO_NEW_POSTS = '本次扫描未发现新帖。';

export interface SyncPageProps {
  onSyncCompleted?: () => void;
  onOpenDiagnostics?: () => void;
  onOpenBatch?: (runId: string, repairOnly: boolean, changesOnly?: boolean) => void;
  folderName?: string;
  onOpenFolderSettings?: () => void;
  beforeSync?: () => Promise<void>;
  publication?: {
    stage: 'idle' | 'writing' | 'done' | 'error';
    message: string;
  };
}

const PAUSED_CONTINUE_UNANSWERED = '点赞页没有响应。这次采集仍暂停，请先刷新点赞页。';
const PAUSED_REFRESH_UNANSWERED = '内容脚本还没接上。这次采集仍暂停，可以再点一次「刷新点赞页」。';
const PAUSED_SCRIPT_HINT = '内容脚本还没接上。可以再点一次「刷新点赞页」。';
const PAUSED_EMPTY_LIST_HINT = '列表还是空的。可以再点一次「刷新点赞页」。没登录的话这里不会有帖子。';
const PAUSED_EMPTY_AFTER_REFRESH = '列表还是空的。这次采集仍暂停。';
const PAUSED_REFRESH_READY = '点赞页已重新载入。这次采集仍暂停，可以继续。';
const PAUSED_WRONG_PAGE_AFTER_REFRESH = '这不是点赞或收藏页。这次采集仍暂停，请先打开点赞页。';
const PAUSED_SCRIPT_READY = '内容脚本已接上。这次采集仍暂停，可以继续。';
const PAUSED_SCRIPT_CONNECTED = '内容脚本已接上。这次采集仍暂停。';

const PHASE_LABELS: Record<SyncPhase, string> = {
  reading: '读取 X 列表',
  saving: '保存帖子和媒体',
  repairing: '检查并重试未归档图片',
  finishing: '保存任务结果',
};

function runDuration(run: SyncRun, end = Date.parse(run.endedAt ?? run.lastCheckpointAt)): string {
  const start = Date.parse(run.startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  const seconds = Math.floor((end - start) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return [hours && `${hours} 小时`, (hours || minutes) && `${minutes} 分`, `${seconds % 60} 秒`].filter(Boolean).join(' ');
}

function runRetries(run: SyncRun): string {
  const stats = run.repairStats;
  return stats ? `正文 ${stats.textAttempts} 次 · 图片 ${stats.imageAttempts} 次` : '暂无记录';
}

function detectionDetail(detail: string, paused: boolean): string {
  if (!paused) return detail;
  if (detail.includes('F5') || detail.includes('未响应采集脚本')) return PAUSED_SCRIPT_HINT;
  if (detail.includes('或点「刷新」')) return PAUSED_EMPTY_LIST_HINT;
  return detail;
}

type ProbeLink = 'blocked' | 'startable' | 'connected' | 'empty' | 'wrong-page' | 'reading' | 'unanswered' | 'missing';

function refreshedStatus(link: ProbeLink): string {
  if (link === 'blocked') return 'X 页面仍需处理。这次采集保持暂停。';
  if (link === 'empty') return PAUSED_EMPTY_AFTER_REFRESH;
  if (link === 'startable') return PAUSED_REFRESH_READY;
  if (link === 'wrong-page') return PAUSED_WRONG_PAGE_AFTER_REFRESH;
  if (link === 'connected' || link === 'reading') {
    return '点赞页已重新载入。这次采集仍暂停。';
  }
  if (link === 'unanswered') return PAUSED_REFRESH_UNANSWERED;
  return '没有找到已打开的点赞页。这次采集仍暂停。';
}
const profileId = getPageProfileId();

function startFailureText(resuming: boolean, reason?: string): string {
  if (reason === 'reading-other-profile') {
    return '当前 X 标签页正在为另一个档案读取，请等待完成或切换到对应档案。';
  }
  if (resuming && !reason) return PAUSED_CONTINUE_UNANSWERED;
  return `未能开始: ${reason || '页面未响应'}`;
}

async function reloadTabAndWait(tabId: number): Promise<void> {
  if (!chrome.tabs?.reload) return;
  await chrome.tabs.reload(tabId);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!chrome.tabs.get) break;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') break;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
}
const liveSyncKey = profileStorageKey(LIVE_SYNC_KEY, profileId);

const LAMP_STYLES: Record<PageProbe['lamp'], { dot: string; ring: string; text: string; bg: string }> = {
  ready: {
    dot: 'bg-emerald-500',
    ring: 'ring-emerald-200',
    text: 'text-emerald-800',
    bg: 'bg-emerald-50 border-emerald-200',
  },
  wait: {
    dot: 'bg-amber-400',
    ring: 'ring-amber-200',
    text: 'text-amber-800',
    bg: 'bg-amber-50 border-amber-200',
  },
  blocked: {
    dot: 'bg-rose-500',
    ring: 'ring-rose-200',
    text: 'text-rose-800',
    bg: 'bg-rose-50 border-rose-200',
  },
  reading: {
    dot: 'bg-stone-900',
    ring: 'ring-stone-300',
    text: 'text-stone-900',
    bg: 'bg-stone-100 border-stone-300',
  },
  checking: {
    dot: 'bg-slate-400',
    ring: 'ring-slate-200',
    text: 'text-slate-700',
    bg: 'bg-slate-50 border-slate-200',
  },
};

export const SyncPage: React.FC<SyncPageProps> = ({
  onSyncCompleted,
  onOpenDiagnostics,
  onOpenBatch,
  folderName,
  onOpenFolderSettings,
  beforeSync,
  publication = { stage: 'idle', message: '' },
}) => {
  const [targetLimit, setTargetLimit] = useState(DEFAULT_SCAN_LIMIT);
  const [customLimit, setCustomLimit] = useState<string | null>(null);
  const [downloadMedia, setDownloadMedia] = useState<boolean>(true);
  const [switchTabOnStart, setSwitchTabOnStart] = useState<boolean>(true);

  // Probe and Tab state
  const [probe, setProbe] = useState<PageProbe>(describePageProbe(null));
  const [targetTab, setTargetTab] = useState<{ id: number; url: string; title?: string } | null>(null);
  const [isProbing, setIsProbing] = useState<boolean>(false);

  // Sync execution state
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [refreshingPage, setRefreshingPage] = useState(false);
  const [currentStats, setCurrentStats] = useState<SyncStats | null>(null);
  const [currentStatusText, setCurrentStatusText] = useState<string>('就绪');
  const [syncHistory, setSyncHistory] = useState<SyncRun[]>([]);
  const [currentRunId, setCurrentRunId] = useState<string>();
  const [currentPhase, setCurrentPhase] = useState<SyncPhase>();
  const [clock, setClock] = useState(Date.now);
  const currentRun = useLiveQuery(() => currentRunId ? db.syncRuns.get(currentRunId) : undefined, [currentRunId]);
  const fixedResumeLimit = isPaused && hasFixedResumeLimit(currentRun) ? currentRun?.targetLimit : undefined;
  const requestedLimit = fixedResumeLimit ?? (customLimit === null ? targetLimit : Number(customLimit));
  const validLimit = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= MAX_SCAN_LIMIT;
  const currentLimit = currentRun?.targetLimit ?? (validLimit ? requestedLimit : targetLimit);

  useEffect(() => {
    if (!isRunning) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isRunning]);

  // Archive import state
  const [isImportingArchive, setIsImportingArchive] = useState<boolean>(false);
  const [archiveStopping, setArchiveStopping] = useState(false);
  const archiveAbortRef = useRef<AbortController | null>(null);
  const [archiveProgress, setArchiveProgress] = useState<{ total: number; stats: SyncStats } | null>(null);
  const [archiveResult, setArchiveResult] = useState<ArchiveImportResult | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const lastNotifiedCompletionRef = useRef<string | null>(null);
  const liveStatusRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const archiveInputRef = useRef<HTMLInputElement>(null);

  const checkTabProbe = async (): Promise<ProbeLink> => {
    setIsProbing(true);
    try {
      if (typeof chrome === 'undefined' || !chrome.tabs?.query) {
        setProbe(describePageProbe({ ok: false, error: '请在 Chrome 扩展环境下运行' }));
        setTargetTab(null);
        return 'missing';
      }

      const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
      const pausedSource = await getPausedCaptureSource(db);
      let candidate = tabs.find((t) => typeof t.id === 'number' && !!t.url && matchesCaptureSource(t.url, pausedSource));
      if (!candidate && tabs.some((tab) => tab.url && isXAuthenticationUrl(tab.url))) {
        setProbe(describePageProbe({ ok: true, failureCode: 'login_required' }));
        setTargetTab(null);
        return 'blocked';
      }
      if (!candidate && !pausedSource) {
        candidate = tabs.find((t) => typeof t.id === 'number' && !!t.url && isXPageUrl(t.url));
      }

      if (!candidate?.id) {
        setProbe(describePageProbe({ ok: false, error: pausedSource ? missingCaptureSource(pausedSource) : '没有找到已打开的点赞或收藏页' }));
        setTargetTab(null);
        return 'missing';
      }

      setTargetTab({ id: candidate.id, url: candidate.url || '', title: candidate.title });

      try {
        const res = (await chrome.tabs.sendMessage(candidate.id, { type: 'PING' })) as
          | { status?: string; isLikesPage?: boolean; articlesCount?: number; failureCode?: unknown; reading?: boolean; profileId?: string; url?: string }
          | undefined;

        if (!res || res.status !== 'ok') {
          setProbe(describePageProbe({ ok: false, error: 'X 页面未响应采集脚本。请刷新该标签页重试。' }));
          return 'unanswered';
        }
        const nextProbe = describePageProbe({
          ok: true,
          isLikesPage: Boolean(res.isLikesPage),
          articlesCount: Number(res.articlesCount) || 0,
          failureCode: res.failureCode,
          reading: Boolean(res.reading),
          url: typeof res.url === 'string' ? res.url : candidate.url,
        });
        setProbe(nextProbe);
        if (res.reading && res.profileId === profileId) {
          setIsRunning(true);
          return 'reading';
        }
        if (nextProbe.pageBlocked) return 'blocked';
        if (nextProbe.canStart) return 'startable';
        if (nextProbe.detail.includes('或点「刷新」')) return 'empty';
        if (nextProbe.title === '这不是点赞或收藏页') return 'wrong-page';
        return 'connected';
      } catch {
        setProbe(
          describePageProbe({
            ok: false,
            error: '无法连接到页面脚本，请在 X 页面按 F5 刷新后再次检测。',
          })
        );
        return 'unanswered';
      }
    } finally {
      setIsProbing(false);
    }
  };

  const handleCheckStatus = async () => {
    const paused = isPaused;
    const link = await checkTabProbe();
    if (!paused || link === 'reading') return;
    if (link === 'blocked') {
      setCurrentStatusText(refreshedStatus(link));
      return;
    }
    if (link === 'startable') {
      setCurrentStatusText(PAUSED_SCRIPT_READY);
      return;
    }
    if (link === 'connected' || link === 'empty' || link === 'wrong-page') {
      setCurrentStatusText(PAUSED_SCRIPT_CONNECTED);
      return;
    }
    if (link === 'unanswered') {
      setCurrentStatusText(PAUSED_REFRESH_UNANSWERED);
      return;
    }
    setCurrentStatusText('没有找到已打开的点赞页。这次采集仍暂停。');
  };

  const loadHistory = async () => {
    const runs = await db.syncRuns.orderBy('startedAt').reverse().limit(15).toArray();
    if (!mountedRef.current) return;
    setSyncHistory(runs);
    const latest = runs[0];
    if (latest?.status === 'paused' && liveStatusRef.current !== 'running') {
      setCurrentRunId(latest.id);
      setIsPaused(true);
      setIsRunning(false);
      setCurrentStats(latest.stats);
      setTargetLimit(latest.targetLimit);
      setCustomLimit(null);
      setDownloadMedia(latest.downloadMedia);
      setCurrentStatusText(latest.failureMessage || PAUSED_CAPTURE_MESSAGE);
    }
  };

  const handleArchiveFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImportingArchive(true);
    setArchiveProgress(null);
    setArchiveResult(null);
    setArchiveError(null);

    try {
      const items = await parseArchiveFile(file);
      if (items.length === 0) {
        throw new Error('未在上传的文件中解析到有效的推文或点赞条目。');
      }
      setArchiveProgress({ total: items.length, stats: { scanned: 0, added: 0, updated: 0, skipped: 0, failed: 0 } });
      const controller = new AbortController();
      archiveAbortRef.current = controller;
      let lastProgress = -Infinity;
      const res = await importArchiveItems(items, {
        signal: controller.signal,
        onProgress: (stats) => {
          const now = performance.now();
          if (now - lastProgress < 250) return;
          lastProgress = now;
          setArchiveProgress({ total: items.length, stats: { ...stats } });
        },
      });
      setArchiveResult(res);
      await loadHistory();
      onSyncCompleted?.();
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsImportingArchive(false);
      setArchiveStopping(false);
      archiveAbortRef.current = null;
      setArchiveProgress(null);
      e.target.value = '';
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    checkTabProbe();
    loadHistory();

    // Listen for live sync updates from Background / Content Script
    const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes[liveSyncKey]?.newValue) {
        const snap = changes[liveSyncKey].newValue as LiveSyncSnapshot;
        setCurrentRunId(snap.runId);
        setCurrentPhase(snap.phase);
        setCurrentStats({
          scanned: snap.scanned,
          added: snap.added,
          updated: snap.updated,
          skipped: snap.skipped,
          failed: snap.failed,
        });

        liveStatusRef.current = snap.status;
        if (snap.status === 'running') {
          setIsRunning(true);
          setIsPaused(false);
          setCurrentStatusText(`正在增量读取中… (${snap.scanned}/${snap.targetLimit})`);
        } else if (snap.status === 'paused') {
          setIsRunning(false);
          setIsPaused(true);
          setCurrentStatusText(snap.message || PAUSED_CAPTURE_MESSAGE);
          void loadHistory();
        } else if (
          snap.status === 'completed' ||
          snap.status === 'partial' ||
          snap.status === 'cancelled' ||
          snap.status === 'failed'
        ) {
          setIsRunning(false);
          setIsPaused(false);
          const reason =
            snap.status === 'completed'
              ? '同步完成'
              : snap.status === 'cancelled'
                ? '已手动停止'
                : snap.status === 'failed'
                  ? '同步失败'
                  : '部分完成';
          const summary = `${reason}：新增 ${snap.added}，跳过已同步 ${snap.skipped}，更新 ${snap.updated}`;
          const detail = [hasNoNewPosts(snap, snap) ? NO_NEW_POSTS : '', snap.message].filter(Boolean).join(' ');
          setCurrentStatusText(detail ? `${summary}。 ${detail}` : summary);
          void loadHistory();
          // A storage snapshot may be written more than once for the same run;
          // one callback per run keeps the parent writer idempotent.
          const completionKey = snap.runId || snap.status;
          if (lastNotifiedCompletionRef.current !== completionKey) {
            lastNotifiedCompletionRef.current = completionKey;
            onSyncCompleted?.();
          }
        }
      }
    };

    chrome.storage?.onChanged?.addListener(handleStorageChange);

    // Initial check from storage
    chrome.storage?.local?.get?.([liveSyncKey]).then((res) => {
      const snap = res?.[liveSyncKey] as LiveSyncSnapshot | undefined;
      if (snap && (snap.status === 'running' || snap.status === 'paused')) {
        setCurrentRunId(snap.runId);
        setCurrentPhase(snap.phase);
        liveStatusRef.current = snap.status;
        setCurrentStats({
          scanned: snap.scanned,
          added: snap.added,
          updated: snap.updated,
          skipped: snap.skipped,
          failed: snap.failed,
        });
        if (snap.status === 'running') {
          setIsRunning(true);
          setIsPaused(false);
          setCurrentStatusText(`正在增量读取中… (${snap.scanned}/${snap.targetLimit})`);
        } else {
          setIsRunning(false);
          setIsPaused(true);
          setCurrentStatusText(snap.message || PAUSED_CAPTURE_MESSAGE);
        }
      }
    });

    return () => {
      mountedRef.current = false;
      chrome.storage?.onChanged?.removeListener(handleStorageChange);
    };
  }, []);

  const handleOpenPage = async (url: string) => {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      await chrome.tabs.create({ url });
      setTimeout(checkTabProbe, 1500);
    }
  };

  /**
   * New reliable sync strategy:
   * Communicates directly with Content Script via START_READING.
   * Runs in the real webpage execution loop with incremental deduplication.
   */
  const handleStartSync = async () => {
    if (!validLimit) return;
    if (beforeSync) {
      try {
        await beforeSync();
      } catch (err) {
        setCurrentStatusText(`目录授权失败：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    if (!folderName) {
      setCurrentStatusText('请先绑定本地文库文件夹');
      onOpenFolderSettings?.();
      return;
    }

    if (!targetTab?.id) {
      alert('未检测到可同步的 X 标签页，请先打开 X 点赞或收藏页。');
      return;
    }

    const resuming = isPaused;
    setIsRunning(true);
    setIsPaused(false);
    if (!resuming) {
      setCurrentRunId(undefined);
      setCurrentStats({ scanned: 0, added: 0, updated: 0, skipped: 0, failed: 0 });
    }
    setCurrentPhase(undefined);
    setCurrentStatusText(resuming ? '正在继续这次采集…' : '正在启动增量同步…');

    try {
      if (switchTabOnStart && typeof chrome !== 'undefined' && chrome.tabs?.update) {
        // Bring X tab to focus so browser does not throttle DOM rendering/scroll
        await chrome.tabs.update(targetTab.id, { active: true });
      }

      const res = (await chrome.tabs.sendMessage(targetTab.id, {
        type: 'START_READING',
        limit: requestedLimit,
        downloadMedia,
        profileId,
      })) as { started?: boolean; reason?: string } | undefined;

      if (!res?.started && res?.reason !== 'already-reading') {
        setIsRunning(false);
        if (resuming) setIsPaused(true);
        setCurrentStatusText(startFailureText(resuming, res?.reason));
      } else {
        setCurrentStatusText(resuming
          ? `正在继续这次采集（上限 ${requestedLimit} 条）…`
          : `已启动增量读取（上限 ${requestedLimit} 条，跳过已同步帖子）…`);
      }
    } catch (err: unknown) {
      setIsRunning(false);
      if (resuming) setIsPaused(true);
      setCurrentStatusText(resuming
        ? PAUSED_CONTINUE_UNANSWERED
        : `启动失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handlePauseSync = async () => {
    if (!targetTab?.id) {
      setCurrentStatusText('没有找到正在采集的页面，暂停没有发出。');
      return;
    }
    try {
      const res = (await chrome.tabs.sendMessage(targetTab.id, { type: 'PAUSE_READING', profileId })) as
        | { status?: string; error?: string }
        | undefined;
      if (res?.status === 'ignored') {
        setCurrentStatusText(res.error || '当前读取属于另一个档案');
        return;
      }
      setCurrentStatusText('正在暂停，检查点保存后可以继续。');
    } catch (err: unknown) {
      setCurrentStatusText(`暂停失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRefreshLikes = async () => {
    if (!isPaused || refreshingPage) return;
    if (!targetTab?.id) {
      setCurrentStatusText(refreshedStatus(await checkTabProbe()));
      return;
    }
    setRefreshingPage(true);
    setCurrentStatusText('正在刷新点赞页。这次采集仍暂停。');
    try {
      await reloadTabAndWait(targetTab.id);
      const link = await checkTabProbe();
      setCurrentStatusText(refreshedStatus(link));
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      setCurrentStatusText(detail ? `刷新没有完成。这次采集仍暂停。${detail}` : '刷新没有完成。这次采集仍暂停。');
    } finally {
      setRefreshingPage(false);
    }
  };

  const handleEndPaused = async () => {
    const ended = await syncService.endPausedSync();
    setIsPaused(false);
    setIsRunning(false);
    liveStatusRef.current = ended > 0 ? 'cancelled' : liveStatusRef.current;
    setCurrentStatusText(ended > 0 ? '已结束这次暂停的采集，已保存的帖子都还在。' : '没有暂停中的采集。');
    await loadHistory();
  };

  const handleStopSync = async () => {
    if (targetTab?.id) {
      try {
        await chrome.tabs.sendMessage(targetTab.id, { type: 'STOP_READING', profileId });
      } catch {}
    }
    setIsRunning(false);
    setCurrentStatusText('已发送停止指令，正在保存当前检查点…');
    await loadHistory();
  };

  const handleRecover = async () => {
    const recovered = await syncService.recoverStaleRuns(15_000);
    if (recovered.length > 0) {
      const resumable = recovered.filter((run) => run.status === 'paused').length;
      alert(`已恢复 ${recovered.length} 次中断任务的状态，其中 ${resumable} 次可继续采集。已收录的帖子都还在。`);
    } else {
      const stillRunning = await db.syncRuns.where('status').equals('running').count();
      alert(stillRunning > 0 ? '读取还在进行，已保存的帖子都在。' : '没有中断的读取任务。');
    }
    await loadHistory();
    if (recovered.some((run) => run.status === 'paused')) await checkTabProbe();
  };

  const lampStyle = LAMP_STYLES[probe.lamp];

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="rounded-2xl border border-stone-300 bg-[#fbfaf7] px-5 py-5 shadow-[0_12px_30px_rgba(62,52,36,0.06)]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-stone-500">THE READING ROOM / 01</p>
            <h1 className="mt-2 font-serif text-3xl font-semibold tracking-tight text-stone-950">把喜欢的内容，收进自己的文库</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
              从 X 增量读取帖子，先存入本机，再整理成可以长期阅读的资料。同步过程可随时暂停或停止，已保存的内容和检查点都还在。
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-stone-500">
            <Database className="h-4 w-4" />
            <span>本地优先 · 离线可读</span>
          </div>
        </div>
      </div>

      {/* Status Lamp Banner (Requirement 4) */}
      <div className={`rounded-xl border p-4 transition-all ${lampStyle.bg}`}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <span
              className={`inline-flex mt-1 h-3 w-3 rounded-full ring-4 flex-shrink-0 ${lampStyle.dot} ${lampStyle.ring} ${
                probe.lamp === 'checking' || probe.lamp === 'reading' ? 'animate-pulse' : ''
              }`}
            />
            <div>
              <div className="flex items-center gap-2">
                <span className={`text-sm font-semibold ${lampStyle.text}`}>{probe.title}</span>
                {probe.lamp === 'ready' && (
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800">
                    <CheckCircle2 className="w-3 h-3" /> 可同步
                  </span>
                )}
                {probe.lamp === 'blocked' && (
                  <span className="inline-flex items-center gap-1 rounded bg-rose-100 px-1.5 py-0.5 text-xs font-medium text-rose-800">
                    <AlertCircle className="w-3 h-3" /> 无法同步
                  </span>
                )}
                {probe.lamp === 'wait' && (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                    <AlertTriangle className="w-3 h-3" /> 待就绪
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-stone-600 leading-relaxed">{detectionDetail(probe.detail, isPaused)}</p>
              {targetTab && (
                <div className="mt-1 text-xs text-stone-500 font-mono truncate max-w-lg">
                  当前目标标签: {targetTab.title || targetTab.url}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-center flex-shrink-0">
            <button
              type="button"
              onClick={() => void handleCheckStatus()}
              disabled={isProbing || isRunning}
              className="flex items-center gap-1 rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isProbing ? 'animate-spin' : ''}`} />
              <span>检测状态</span>
            </button>

            {onOpenDiagnostics && (
              <button
                type="button"
                onClick={onOpenDiagnostics}
                className="flex items-center gap-1 rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-xs text-stone-700 hover:bg-stone-50"
              >
                <span>自检排查</span>
              </button>
            )}

            {!probe.canStart && (
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={async () => handleOpenPage(await getLikesEntry(profileId))}
                  className="flex items-center gap-1 rounded-lg bg-stone-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-stone-800"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>打开 X 点赞</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <section
        className={`rounded-xl border p-4 ${folderName ? 'border-stone-200 bg-white' : 'border-amber-300 bg-amber-50'}`}
        aria-label="本地文库目录"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className={`mt-0.5 rounded-lg p-2 ${folderName ? 'bg-stone-100 text-stone-700' : 'bg-amber-100 text-amber-800'}`}>
              <FolderOpen className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-stone-900">本地文库</h2>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${folderName ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-100 text-amber-800'}`}>
                  {folderName ? '已绑定' : '尚未绑定'}
                </span>
              </div>
              <p className="mt-1 truncate text-xs text-stone-600">
                {folderName ? `资料将写入「${folderName}」` : '先绑定一个本地文件夹，完成同步后才能写入文库。'}
              </p>
            </div>
          </div>
          {onOpenFolderSettings && (
            <button
              type="button"
              onClick={onOpenFolderSettings}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs font-medium text-stone-700 hover:bg-stone-50"
            >
              <Settings2 className="h-3.5 w-3.5" />
              <span>{folderName ? '更换目录' : '去设置绑定'}</span>
            </button>
          )}
        </div>
        <div className={`mt-3 flex items-center gap-2 border-t pt-3 text-xs ${publication.stage === 'error' ? 'border-rose-200 text-rose-700' : publication.stage === 'done' ? 'border-emerald-200 text-emerald-700' : publication.stage === 'writing' ? 'border-sky-200 text-sky-700' : 'border-stone-200 text-stone-500'}`}>
          <span className={`h-2 w-2 rounded-full ${publication.stage === 'error' ? 'bg-rose-500' : publication.stage === 'done' ? 'bg-emerald-500' : publication.stage === 'writing' ? 'animate-pulse bg-sky-500' : 'bg-stone-300'}`} />
          <span>
            {publication.message || (publication.stage === 'writing' ? '正在写入本地文库…' : publication.stage === 'done' ? '最近一次同步已写入本地文库。' : publication.stage === 'error' ? '写入本地文库失败，请打开设置检查目录权限。' : folderName ? '同步完成后会自动写入本地文库。' : '绑定目录后，这里会显示写入进度。')}
          </span>
        </div>
      </section>

      {/* Configuration Card */}
      <div className="rounded-xl border border-stone-200 bg-white p-5">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-medium text-stone-900">增量同步设置</h2>
            <p className="mt-1 text-sm text-stone-600">
              增量同步会自动跳过本地已经保存过的帖子，只新增未收录推文并更新变动。列表滚完，不代表点赞都收齐了。
              每轮连续采集最多 5 分钟，到时自动暂停；当前批次保存后可继续。
              继续时会优先重试本次已扫描帖子的缺图，并在页面再次出现时尝试补齐不完整原文。
            </p>
          </div>
        </div>

        <div className="mt-4 max-w-lg space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="sync-scan-limit" className="mb-1 block text-sm text-stone-700">本次最大扫描条数</label>
              <select
                id="sync-scan-limit"
                value={customLimit === null ? targetLimit : 'custom'}
                disabled={isRunning || fixedResumeLimit !== undefined}
                onChange={(e) => {
                  if (e.target.value === 'custom') setCustomLimit(String(targetLimit));
                  else {
                    setTargetLimit(Number(e.target.value));
                    setCustomLimit(null);
                  }
                }}
                className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 disabled:bg-stone-100"
              >
                <option value={20}>20 条（小步增量）</option>
                <option value={50}>50 条</option>
                <option value={100}>100 条（默认）</option>
                <option value={200}>200 条</option>
                <option value={500}>500 条</option>
                {![20, 50, 100, 200, 500].includes(targetLimit) && <option value={targetLimit}>{targetLimit} 条</option>}
                <option value="custom">自定义条数</option>
              </select>
              {customLimit !== null && (
                <>
                  <input type="number" min={1} max={MAX_SCAN_LIMIT} step={1} disabled={isRunning || fixedResumeLimit !== undefined}
                    aria-label="自定义扫描条数" aria-describedby="sync-scan-limit-hint" aria-invalid={!validLimit}
                    value={customLimit} onChange={(event) => setCustomLimit(event.target.value)}
                    className="lm-control mt-2 w-full px-3 py-2 text-sm" />
                  <p id="sync-scan-limit-hint" className={`mt-1 text-xs ${validLimit ? 'text-stone-600' : 'text-rose-700'}`}>
                    请输入 1–{MAX_SCAN_LIMIT} 之间的整数。
                  </p>
                </>
              )}
              {fixedResumeLimit !== undefined && <p className="mt-1 text-xs text-stone-600">恢复中断任务时沿用原上限 {fixedResumeLimit} 条。</p>}
            </div>

            <div className="space-y-2 pt-2 sm:pt-6">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-stone-700">
                <input
                  type="checkbox"
                  disabled={isRunning}
                  checked={downloadMedia}
                  onChange={(e) => setDownloadMedia(e.target.checked)}
                />
                <span>保存推文图片</span>
              </label>

              <label className="flex cursor-pointer items-center gap-2 text-sm text-stone-700">
                <input
                  type="checkbox"
                  disabled={isRunning}
                  checked={switchTabOnStart}
                  onChange={(e) => setSwitchTabOnStart(e.target.checked)}
                />
                <span>开始时聚焦到 X 标签页 (防止后台限流)</span>
              </label>
            </div>
          </div>

          <div className="pt-2 flex flex-wrap items-center gap-3">
            {isRunning ? (
              <>
                <button
                  type="button"
                  onClick={() => void handlePauseSync()}
                  className="flex items-center justify-center gap-2 rounded-lg border border-stone-300 bg-white px-5 py-2.5 text-sm font-medium text-stone-800 hover:bg-stone-50"
                >
                  <Pause className="h-4 w-4" />
                  <span>暂停</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleStopSync()}
                  className="flex items-center justify-center gap-2 rounded-lg bg-rose-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-rose-800"
                >
                  <Square className="h-4 w-4 fill-white" />
                  <span>停止同步</span>
                </button>
              </>
            ) : isPaused ? (
              <>
                <button
                  type="button"
                  onClick={() => void handleStartSync()}
                  disabled={!probe.canStart || !folderName || refreshingPage || !validLimit}
                  className="flex items-center justify-center gap-2 rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-500"
                  title={!folderName ? '请先绑定本地文库文件夹' : undefined}
                >
                  <Play className="h-4 w-4 fill-white" />
                  <span>继续这次采集</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleEndPaused()}
                  disabled={refreshingPage}
                  className="flex items-center justify-center gap-2 rounded-lg border border-stone-300 bg-white px-5 py-2.5 text-sm font-medium text-stone-800 hover:bg-stone-50 disabled:cursor-not-allowed disabled:text-stone-400"
                >
                  <Square className="h-4 w-4" />
                  <span>结束这次采集</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleRefreshLikes()}
                  disabled={refreshingPage || !targetTab}
                  className="flex items-center justify-center gap-2 rounded-lg border border-stone-300 bg-white px-5 py-2.5 text-sm font-medium text-stone-800 hover:bg-stone-50 disabled:cursor-not-allowed disabled:text-stone-400"
                >
                  <RefreshCw className={`h-4 w-4 ${refreshingPage ? 'animate-spin' : ''}`} />
                  <span>{refreshingPage ? '正在刷新…' : '刷新点赞页'}</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void handleStartSync()}
                disabled={!probe.canStart || !folderName || !validLimit}
                className="flex items-center justify-center gap-2 rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-500"
                title={!folderName ? '请先绑定本地文库文件夹' : undefined}
              >
                <Play className="h-4 w-4 fill-white" />
                <span>开始增量同步</span>
              </button>
            )}

            <button
              onClick={handleRecover}
              title="检查是否有上次异常关闭的读取记录"
              className="flex items-center gap-1 rounded-lg border border-stone-300 px-3 py-2.5 text-sm text-stone-700 hover:bg-stone-50"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>查中断</span>
            </button>
          </div>
          {!folderName && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-800">
              <AlertTriangle className="h-3.5 w-3.5" />
              开始同步前，请先绑定本地文库文件夹。
              {onOpenFolderSettings && (
                <button type="button" onClick={onOpenFolderSettings} className="font-semibold underline underline-offset-2">
                  现在设置
                </button>
              )}
            </p>
          )}
        </div>
      </div>

      {/* Live Progress Card */}
      {(isRunning || isPaused || currentStats) && (
        <div className="space-y-3 rounded-xl border border-stone-200 bg-white p-5">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 font-medium text-stone-900">
              <span className={`h-2.5 w-2.5 rounded-full ${isRunning ? 'animate-pulse bg-emerald-600' : isPaused ? 'bg-amber-500' : 'bg-stone-400'}`} />
              <span>{currentStatusText}</span>
            </span>
            <span className="text-stone-500 font-mono">
              {currentStats?.scanned || 0} / {currentLimit}
            </span>
          </div>

          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-stone-600" aria-label="当前任务诊断">
            <div className="flex gap-1.5">
              <dt>步骤</dt>
              <dd className="font-medium text-stone-800">
                {isRunning ? (currentPhase ? PHASE_LABELS[currentPhase] : '正在连接采集页') : isPaused ? '等待继续' : '采集已结束'}
              </dd>
            </div>
            {currentRun && (
              <>
                <div className="flex gap-1.5">
                  <dt>批次历时</dt>
                  <dd>{runDuration(currentRun, currentRun.status === 'running' ? Math.max(clock, Date.parse(currentRun.lastCheckpointAt)) : undefined)}</dd>
                </div>
                <div className="flex gap-1.5"><dt>重试</dt><dd>{runRetries(currentRun)}</dd></div>
                {currentRun.failureCode && (
                  <div className="flex gap-1.5"><dt>错误码</dt><dd><code>{currentRun.failureCode}</code></dd></div>
                )}
              </>
            )}
          </dl>

          <div className="h-2 w-full overflow-hidden rounded-full bg-stone-100">
            <div
              className="h-2 bg-stone-900 transition-all duration-300"
              style={{
                width: `${Math.min(
                  100,
                  currentLimit > 0 ? ((currentStats?.scanned || 0) / currentLimit) * 100 : 0
                )}%`,
              }}
            />
          </div>

          {currentStats && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1 text-center text-sm">
              <div className="rounded-lg border border-stone-200 p-2 bg-stone-50">
                <div className="text-xs text-stone-500">已扫描</div>
                <div className="mt-0.5 font-semibold text-stone-900">{currentStats.scanned}</div>
              </div>
              <div className="rounded-lg border border-emerald-200 p-2 bg-emerald-50">
                <div className="text-xs text-emerald-700">新收录</div>
                <div className="mt-0.5 font-semibold text-emerald-900">+{currentStats.added}</div>
              </div>
              <div className="rounded-lg border border-stone-200 p-2 bg-stone-50">
                <div className="text-xs text-stone-500">跳过已同步</div>
                <div className="mt-0.5 font-semibold text-stone-700">={currentStats.skipped}</div>
              </div>
              <div className="rounded-lg border border-sky-200 p-2 bg-sky-50">
                <div className="text-xs text-sky-700">更新内容</div>
                <div className="mt-0.5 font-semibold text-sky-900">~{currentStats.updated}</div>
              </div>
              <div className="rounded-lg border border-stone-200 p-2 bg-stone-50">
                <div className="text-xs text-stone-500">失败</div>
                <div className="mt-0.5 font-semibold text-stone-900">!{currentStats.failed}</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Official Archive Import Card */}
      <div className="rounded-xl border border-stone-200 bg-white p-5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-medium text-stone-900 flex items-center gap-2">
              <Upload className="w-4 h-4 text-stone-700" />
              <span>导入 X 官方历史归档</span>
            </h2>
            <p className="text-xs text-stone-500 mt-0.5">
              支持导入从 X 官方下载的数据包（.zip）或其中的 data/like.js、tweets.js，直接将历史点赞入库。
            </p>
          </div>
          <div>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3.5 py-2 text-xs font-medium text-stone-800 shadow-sm transition-colors hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-slate-700 focus-visible:ring-offset-2 disabled:opacity-50"
              disabled={isImportingArchive || !folderName}
              onClick={() => archiveInputRef.current?.click()}
              title={!folderName ? '请先绑定本地文库文件夹' : undefined}
            >
              <Upload className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{isImportingArchive ? '正在导入…' : !folderName ? '绑定目录后导入归档' : '选择归档文件 (ZIP/JS)'}</span>
            </button>
            <input
              ref={archiveInputRef}
              type="file"
              accept=".zip,.js,.json"
              disabled={isImportingArchive || !folderName}
              onChange={handleArchiveFileChange}
              hidden
            />
          </div>
        </div>

        {!folderName && (
          <p className="flex items-center gap-1.5 text-xs text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5" />
            归档会直接进入本地文库；请先绑定目录，再选择文件。
          </p>
        )}

        <div role="status">
          {isImportingArchive && !archiveResult && (
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs text-stone-800">
              {archiveProgress ? (
                <>
                  <p className="font-semibold">正在写入归档 · 扫描 {archiveProgress.stats.scanned} / {archiveProgress.total} 篇</p>
                  <p className="mt-1">
                    新增 {archiveProgress.stats.added} · 更新 {archiveProgress.stats.updated} · 跳过 {archiveProgress.stats.skipped} · 失败 {archiveProgress.stats.failed}
                  </p>
                </>
              ) : <p>正在解析归档文件…</p>}
            </div>
          )}
          {archiveResult && (
            <div className={`flex items-start gap-2 rounded-lg border p-3 text-xs ${
              archiveResult.status === 'completed' ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : archiveResult.status === 'failed' ? 'border-rose-200 bg-rose-50 text-rose-900'
                  : 'border-amber-200 bg-amber-50 text-amber-900'
            }`}>
              {archiveResult.status === 'completed'
                ? <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                : <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}
              <div>
                <div className="font-semibold">{archiveResult.message}</div>
                <div className="mt-0.5">
                  扫描 {archiveResult.stats.scanned} 篇 · 新收录 +{archiveResult.stats.added} · 更新 ~{archiveResult.stats.updated} · 跳过 ={archiveResult.stats.skipped} · 失败 {archiveResult.stats.failed}
                </div>
              </div>
            </div>
          )}
        </div>

        {isImportingArchive && archiveProgress && !archiveResult && (
          <button type="button" className="lm-button-quiet px-3 py-2 text-sm disabled:opacity-50"
            disabled={archiveStopping} onClick={() => {
              archiveAbortRef.current?.abort();
              setArchiveStopping(true);
            }}>
            {archiveStopping ? '正在停止导入…' : '停止导入'}
          </button>
        )}

        {archiveError && (
          <div role="alert" className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-900 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">导入失败</div>
              <div className="mt-0.5">{archiveError}</div>
            </div>
          </div>
        )}
      </div>

      {/* Sync History Table */}
      <div className="rounded-xl border border-stone-200 bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-medium text-stone-900">同步历史</h2>
          <span className="text-sm text-stone-500">最近 15 次</span>
        </div>

        {syncHistory.length === 0 ? (
          <div className="py-8 text-center text-sm text-stone-500">还没有同步记录。点上面的「开始增量同步」。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-left text-sm [&_th]:whitespace-nowrap [&_th]:pr-5 [&_td]:pr-5 [&_td]:align-top">
              <thead>
                <tr className="border-b border-stone-200 text-stone-500">
                  <th className="pb-2.5 font-medium">编号</th>
                  <th className="pb-2.5 font-medium">来源</th>
                  <th className="pb-2.5 font-medium">状态</th>
                  <th className="pb-2.5 font-medium">扫描 / 新增 / 跳过 / 更新 / 失败</th>
                  <th className="pb-2.5 font-medium">开始 / 批次历时</th>
                  <th className="pb-2.5 font-medium">说明</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {syncHistory.map((run) => (
                  <tr key={run.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap py-2.5 font-mono text-slate-600">{run.id.slice(0, 16)}</td>
                    <td className="whitespace-nowrap py-2.5 font-medium text-slate-800">
                      {describeSyncSource(run)}
                    </td>
                    <td className="min-w-[88px] whitespace-nowrap py-2.5">
                      <span
                        className={`inline-flex shrink-0 whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium ${
                          run.status === 'completed'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : run.status === 'partial'
                            ? 'bg-amber-50 text-amber-700 border border-amber-200'
                            : run.status === 'running'
                            ? 'bg-sky-50 text-sky-700 border border-sky-200'
                            : run.status === 'paused'
                            ? 'bg-amber-50 text-amber-800 border border-amber-200'
                            : 'bg-rose-50 text-rose-700 border border-rose-200'
                        }`}
                      >
                        {run.status === 'completed'
                          ? '完成'
                          : run.status === 'partial'
                          ? '部分'
                          : run.status === 'running'
                          ? '进行中'
                          : run.status === 'paused'
                          ? '已暂停'
                          : run.status === 'failed'
                          ? '失败'
                          : run.status === 'cancelled'
                          ? '已停'
                          : run.status}
                      </span>
                    </td>
                    <td className="min-w-[240px] py-2.5 font-mono text-xs">
                      {run.stats.scanned} / +{run.stats.added} / ={run.stats.skipped} / ~{run.stats.updated} / !{run.stats.failed}
                      {run.repairStats && (
                        <div className="mt-1 space-y-0.5 font-sans text-stone-600">
                          <p>重试 {runRetries(run)}</p>
                          <p>补抓正文 {run.repairStats.textRecovered}/{run.repairStats.textAttempts} 篇 · 恢复图片 {run.repairStats.imagesRecovered}/{run.repairStats.imageAttempts} 张</p>
                          {run.repairStats.remainingPosts !== undefined && run.repairStats.remainingImages !== undefined && (
                            <p>结束时待处理：不完整帖子 {run.repairStats.remainingPosts} 篇 · 未归档图片记录 {run.repairStats.remainingImages} 张</p>
                          )}
                        </div>
                      )}
                      {onOpenBatch && (run.stats.added > 0 || run.repairStats || run.changedPostIds?.length) ? (
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-sans">
                          <button type="button" className="text-[#315846] underline underline-offset-2"
                            onClick={() => onOpenBatch(run.id, false)}>查看本批帖子</button>
                          <button type="button" className="text-[#315846] underline underline-offset-2"
                            onClick={() => onOpenBatch(run.id, true)}>查看本批待修复</button>
                          {run.status !== 'running' && (run.stats.added > 0 || run.changedPostIds?.length) ? (
                            <button type="button" className="text-[#315846] underline underline-offset-2"
                              onClick={() => onOpenBatch(run.id, false, true)}>查看本批待整理</button>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap py-2.5 text-slate-500">
                      {new Date(run.startedAt).toLocaleTimeString('zh-CN')}
                      <p className="mt-1 text-xs">{runDuration(run)}</p>
                    </td>
                    <td className="min-w-[220px] max-w-xs break-words py-2.5 text-xs text-slate-500">
                      {hasNoNewPosts(run, run.stats) && <p>{NO_NEW_POSTS}</p>}
                      <p>{run.failureMessage || (run.status === 'completed' ? '正常结束' : '—')}</p>
                      {run.failureCode && <p className="mt-1">错误码 <code>{run.failureCode}</code></p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
