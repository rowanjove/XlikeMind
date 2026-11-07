import { CompletionSettings } from './components/CompletionSettings';
import { useDialogFocus } from './components/useDialogFocus';
import { logDiagnosticError } from '../domain/diagnosticFrames';
import { isXAuthenticationUrl } from '../adapters/captureFailure';
import { hasArchivedMedia } from '../domain/media';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Settings, ChevronLeft, Cpu, ArrowUpRight, BookOpen, Image as ImageIcon, Activity, Radio, UserRound } from 'lucide-react';
import { isXPageUrl, matchesCaptureSource, missingCaptureSource, normalizeLikesEntry } from '../adapters/findLikesTab';
import type { PostSource } from '../domain/types';
import { DEFAULT_SCAN_LIMIT, MAX_SCAN_LIMIT, normalizeScanLimit } from '../adapters/captureLimits';
import { getLikesEntry } from '../storage/capturePreferences';
import { getProfileDatabase } from '../storage/db';
import { hasFixedResumeLimit, LIVE_SYNC_KEY, type LiveSyncSnapshot } from '../sync/liveSync';
import { describePageProbe, type PageProbe } from './pageProbe';
import { getPausedCaptureSource, PAUSED_CAPTURE_MESSAGE, SyncService, syncService } from '../sync/syncService';
import { BrandMark } from './components/BrandMark';
import { getLibraryFolder } from '../export/libraryFolder';
import {
  createProfile,
  getPageProfileId,
  getProfile,
  matchLibraryForXHandle,
  profileStorageKey,
  switchProfile,
  updateProfile,
  type XLibraryMatch,
} from '../storage/profiles';
import { readOpenXAccount } from './signedInX';

const PRESETS = [20, 50, 100, 200, 500] as const;
const POPUP_PREFS_KEY = 'likemind_popup_prefs';
const PAGE_PROFILE_ID = getPageProfileId();

const LAMP_CLASS: Record<PageProbe['lamp'], string> = {
  checking: 'bg-slate-300 ring-slate-100',
  ready: 'bg-emerald-500 ring-emerald-100',
  wait: 'bg-amber-400 ring-amber-100',
  blocked: 'bg-rose-500 ring-rose-100',
  reading: 'bg-stone-900 ring-stone-200',
};

const STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  partial: '部分完成',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  paused: '已暂停',
  idle: '就绪',
};

const PAUSED_CONTINUE_UNANSWERED = '点赞页没有响应。这次采集仍暂停，可以先点「刷新」。';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function continueFailureNote(status: string | undefined, reason?: string): string {
  if (status === 'paused' && !reason) return PAUSED_CONTINUE_UNANSWERED;
  return reason || '页面未响应';
}

async function loadCounts(profileId: string): Promise<{ posts: number; media: number; status: string }> {
  const database = getProfileDatabase(profileId);
  const posts = await database.posts.count();
  const media = await database.media.where('status').equals('downloaded').filter(hasArchivedMedia).count();
  const run = await database.syncRuns.orderBy('startedAt').reverse().first();
  const label = run ? STATUS_LABEL[run.status] || run.status : '还没有同步';
  return {
    posts,
    media,
    status: run ? `${label}，新增 ${run.stats.added}` : label,
  };
}

async function locateProbeTab(source?: PostSource): Promise<{ id: number; url: string } | null> {
  if (!chrome.tabs?.query) return null;
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  if (!Array.isArray(tabs)) return null;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id && active.url && matchesCaptureSource(active.url, source)) return { id: active.id, url: active.url };
  const archive = tabs.find((tab) => typeof tab.id === 'number' && !!tab.url && matchesCaptureSource(tab.url, source));
  if (archive?.id && archive.url) return { id: archive.id, url: archive.url };
  const auth = tabs.find((tab) => typeof tab.id === 'number' && !!tab.url && isXAuthenticationUrl(tab.url));
  if (auth?.id && auth.url) return { id: auth.id, url: auth.url };
  if (!source && active?.id && active.url && isXPageUrl(active.url)) return { id: active.id, url: active.url };
  return null;
}

async function pingTab(tabId: number): Promise<{ probe: PageProbe; xHandle?: string; readingProfileId?: string }> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type: 'PING', profileId: PAGE_PROFILE_ID })) as
      | { status?: string; isLikesPage?: boolean; articlesCount?: number; failureCode?: unknown; reading?: boolean; url?: string; xHandle?: string; profileId?: string }
      | undefined;
    if (!res || res.status !== 'ok') {
      return { probe: describePageProbe({ ok: false, error: '点赞页没有回应。点刷新重新载入后再试。' }) };
    }
    return {
      probe: describePageProbe({
        ok: true,
        isLikesPage: Boolean(res.isLikesPage),
        articlesCount: Number(res.articlesCount) || 0,
        failureCode: res.failureCode,
        reading: Boolean(res.reading),
        url: typeof res.url === 'string' ? res.url : undefined,
      }),
      xHandle: typeof res.xHandle === 'string' ? res.xHandle : undefined,
      readingProfileId: typeof res.profileId === 'string' ? res.profileId : undefined,
    };
  } catch (err) {
    return { probe: describePageProbe({ ok: false, error: err instanceof Error ? err.message : String(err) }) };
  }
}

async function readProbe(source?: PostSource): Promise<{ tabId: number | null; url?: string; probe: PageProbe; xHandle?: string; readingProfileId?: string }> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) {
    return {
      tabId: null,
      probe: describePageProbe({ ok: false, error: '请从 Chrome 工具栏打开 XlikeMind。' }),
    };
  }
  const tab = await locateProbeTab(source);
  if (!tab) {
    return {
      tabId: null,
      probe: describePageProbe({ ok: false, error: source ? missingCaptureSource(source) : '没有找到已打开的点赞或收藏页。' }),
    };
  }
  if (isXAuthenticationUrl(tab.url)) {
    return { tabId: null, url: tab.url, probe: describePageProbe({ ok: true, failureCode: 'login_required' }) };
  }
  const ping = await pingTab(tab.id);
  return { tabId: tab.id, url: tab.url, ...ping };
}

async function reloadAndWait(tabId: number): Promise<void> {
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
    await delay(200);
  }
  await delay(600);
}

function progressLine(snapshot: LiveSyncSnapshot): string {
  return `已扫描 ${snapshot.scanned} 条，新增 ${snapshot.added}，更新 ${snapshot.updated}。`;
}

export const Popup: React.FC = () => {
  const [summary, setSummary] = useState<{
    profileId: string;
    counts: Awaited<ReturnType<typeof loadCounts>> | null;
  }>();
  const [preset, setPreset] = useState(String(DEFAULT_SCAN_LIMIT));
  const [customLimit, setCustomLimit] = useState(String(DEFAULT_SCAN_LIMIT));
  const [probe, setProbe] = useState<PageProbe>(describePageProbe(null));
  const [tabId, setTabId] = useState<number | null>(null);
  const [live, setLive] = useState<LiveSyncSnapshot | null>(null);
  const pausedLimit = live?.status === 'paused' ? live.targetLimit : undefined;
  const fixedResumeLimit = hasFixedResumeLimit(live) ? pausedLimit : undefined;
  useEffect(() => {
    if (pausedLimit === undefined) return;
    setPreset(PRESETS.some((value) => value === pausedLimit) ? String(pausedLimit) : 'custom');
    setCustomLimit(String(pausedLimit));
  }, [pausedLimit]);
  const [refreshing, setRefreshing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [armedReading, setArmedReading] = useState(false);
  const [note, setNote] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useDialogFocus(settingsOpen, () => setSettingsOpen(false));
  const [downloadMedia, setDownloadMedia] = useState(true);
  const [libraryFolderName, setLibraryFolderName] = useState<string | null | undefined>(undefined);
  const [libraryMatch, setLibraryMatch] = useState<XLibraryMatch>({
    profileId: PAGE_PROFILE_ID,
    profileName: '我的文库',
    kind: 'unknown',
  });
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountReady, setAccountReady] = useState(false);
  const [bindingDraft, setBindingDraft] = useState<{ id: string; name: string; handle: string } | null>(null);
  const [bindingNotice, setBindingNotice] = useState('');
  const refreshingRef = useRef(false);
  const profileIdRef = useRef(PAGE_PROFILE_ID);
  const readingProfileRef = useRef<string | undefined>(undefined);
  const matchRef = useRef(libraryMatch);
  matchRef.current = libraryMatch;

  const refreshSummary = useCallback(async (profileId: string) => {
    const counts = await loadCounts(profileId).catch(() => null);
    if (matchRef.current.profileId === profileId) setSummary({ profileId, counts });
  }, []);

  const applyProbe = async () => {
    let next = await readProbe();
    setTabId(next.tabId);
    setProbe(next.probe);
    readingProfileRef.current = next.readingProfileId;
    let observedHandle = next.xHandle;
    if (!observedHandle) {
      const open = await readOpenXAccount();
      if (open.status === 'known') observedHandle = open.handle;
    }
    const match = await matchLibraryForXHandle(observedHandle, PAGE_PROFILE_ID);
    setLibraryMatch(match);
    matchRef.current = match;
    setAccountReady(true);
    const activeId = match.profileId;
    profileIdRef.current = activeId ?? PAGE_PROFILE_ID;
    if (!activeId) {
      setSummary(undefined);
      setLibraryFolderName(null);
      return next;
    }
    const pausedSource = await getPausedCaptureSource(getProfileDatabase(activeId));
    if (pausedSource && (!next.url || !matchesCaptureSource(next.url, pausedSource))) {
      next = await readProbe(pausedSource);
      setTabId(next.tabId);
      setProbe(next.probe);
      readingProfileRef.current = next.readingProfileId;
    }
    await refreshSummary(activeId);
    try {
      const binding = await getLibraryFolder(activeId);
      setLibraryFolderName(binding?.handle.name ?? null);
    } catch {
      setLibraryFolderName(null);
    }
    const liveKey = profileStorageKey(LIVE_SYNC_KEY, activeId);
    const prefsKey = profileStorageKey(POPUP_PREFS_KEY, activeId);
    const stored = await chrome.storage?.local?.get?.([liveKey, prefsKey]);
    const snapshot = stored?.[liveKey] as LiveSyncSnapshot | undefined;
    if (snapshot?.status === 'paused' && snapshot.failureCode === undefined) {
      const run = await getProfileDatabase(activeId).syncRuns.get(snapshot.runId);
      setLive({ ...snapshot, failureCode: run?.status === 'paused' ? run.failureCode : undefined });
    } else if (snapshot) setLive(snapshot);
    const prefs = stored?.[prefsKey] as { downloadMedia?: boolean } | undefined;
    if (prefs?.downloadMedia === false) setDownloadMedia(false);
    return next;
  };
  const applyProbeRef = useRef(applyProbe);
  applyProbeRef.current = applyProbe;

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await syncService.recoverStaleRuns(90_000);
      } catch (err) {
        logDiagnosticError('popup_recovery', err);
      }
      if (!active) return;
      try {
        await applyProbeRef.current();
      } catch (err) {
        if (!active) return;
        setAccountReady(true);
        setProbe(describePageProbe({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      }
    })();

    const onLive = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area !== 'local') return;
      const liveKey = profileStorageKey(LIVE_SYNC_KEY, profileIdRef.current);
      if (!changes[liveKey]) return;
      const next = changes[liveKey].newValue as LiveSyncSnapshot | undefined;
      if (!next) return;
      setLive(next);
      if (next.status === 'paused' || (next.status === 'cancelled' && next.message?.includes('暂停'))) {
        setArmedReading(false);
        setStopping(false);
        setPausing(false);
        setNote('');
        void applyProbeRef.current();
        return;
      }
      if (next.status !== 'running') {
        setArmedReading(false);
        setStopping(false);
        setPausing(false);
        if (next.message) setNote(next.message);
        void applyProbeRef.current();
        return;
      }
      const activeId = matchRef.current.profileId;
      if (!activeId) return;
      void refreshSummary(activeId);
    };
    chrome.storage?.onChanged?.addListener(onLive);
    const timer = window.setInterval(() => {
      if (refreshingRef.current) return;
      void applyProbeRef.current().catch(() => undefined);
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
      chrome.storage?.onChanged?.removeListener(onLive);
    };
  }, [refreshSummary]);

  useEffect(() => {
    if (settingsOpen && matchRef.current.profileId) {
      void getLibraryFolder(matchRef.current.profileId).then((binding) => {
        setLibraryFolderName(binding?.handle.name ?? null);
      }).catch(() => setLibraryFolderName(null));
    }
  }, [settingsOpen]);

  const pageReading = armedReading || probe.lamp === 'reading';
  let view = probe;
  if (pageReading || (live?.status === 'running' && probe.lamp === 'checking')) {
    view = {
      lamp: 'reading',
      title: pausing ? '正在暂停' : stopping ? '正在停止' : '正在读取',
      detail:
        live && live.status === 'running'
          ? `${progressLine(live)}可以关掉这个窗口。`
          : '可以关掉这个窗口。',
      canStart: false,
      needsReload: false,
    };
  } else if (!pageReading && live?.status === 'paused') {
    view = {
      lamp: 'wait',
      title: '已暂停',
      detail: probe.pageBlocked ? probe.detail : live.message || PAUSED_CAPTURE_MESSAGE,
      canStart: false,
      needsReload: false,
    };
  } else if (live?.status === 'running' && probe.lamp === 'ready') {
    view = {
      ...probe,
      detail: `${probe.detail} 上次读取已中断，已经保存的帖子还在。`,
    };
  }

  const openDashboard = (hash = '') => {
    if (matchRef.current.kind === 'missing' || !matchRef.current.profileId) return;
    const profileId = matchRef.current.profileId;
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.runtime?.getURL) {
      const url = new URL(chrome.runtime.getURL('dashboard.html'));
      url.searchParams.set('profile', profileId);
      if (hash) url.hash = hash.replace(/^#?/, '#');
      chrome.tabs.create({ url: url.toString() });
    } else {
      const url = new URL('dashboard.html', window.location.href);
      url.searchParams.set('profile', profileId);
      if (hash) url.hash = hash.replace(/^#?/, '#');
      window.open(url.toString(), '_blank');
    }
  };

  const bindPageLibrary = async () => {
    const match = matchRef.current;
    if (match.kind !== 'unbound' || !match.handle || !match.profileId) return;
    setAccountBusy(true);
    setNote('');
    try {
      await updateProfile(match.profileId, match.profileName, `@${match.handle}`);
      await applyProbeRef.current();
    } catch (err) {
      setNote(err instanceof Error ? err.message : '绑定失败');
    } finally {
      setAccountBusy(false);
    }
  };

  const beginEditBinding = async () => {
    const match = matchRef.current;
    if (!match.profileId || match.kind === 'missing' || accountBusy) return;
    setNote('');
    setBindingNotice('');
    const profile = await getProfile(match.profileId);
    if (!profile) {
      setNote('找不到该文库。');
      return;
    }
    setBindingDraft({
      id: profile.id,
      name: profile.name,
      handle: profile.xHandle ? `@${profile.xHandle}` : '',
    });
  };

  const saveBindingDraft = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!bindingDraft || accountBusy) return;
    setAccountBusy(true);
    setNote('');
    setBindingNotice('');
    try {
      await updateProfile(bindingDraft.id, bindingDraft.name, bindingDraft.handle);
      const saved = await getProfile(bindingDraft.id);
      const savedName = saved?.name ?? bindingDraft.name.trim();
      setBindingNotice(saved?.xHandle ? `「${savedName}」已绑定 @${saved.xHandle}` : `已解除「${savedName}」的绑定`);
      setBindingDraft(null);
      await applyProbeRef.current();
    } catch (err) {
      setNote(err instanceof Error ? err.message : '修改绑定失败');
    } finally {
      setAccountBusy(false);
    }
  };

  const createLibraryForAccount = async () => {
    const match = matchRef.current;
    if (match.kind !== 'missing' || !match.handle) return;
    setAccountBusy(true);
    setNote('');
    try {
      const profile = await createProfile(`@${match.handle}`, `@${match.handle}`);
      await switchProfile(profile.id);
      await applyProbeRef.current();
    } catch (err) {
      setNote(err instanceof Error ? err.message : '创建文库失败');
    } finally {
      setAccountBusy(false);
    }
  };

  const handleOpenDashboard = () => {
    openDashboard('#library');
  };

  const handleOpenSync = () => {
    openDashboard('#sync');
  };

  const handleOpenSettings = () => {
    openDashboard('#settings');
  };

  const handleDownloadMedia = (next: boolean) => {
    setDownloadMedia(next);
    const profileId = matchRef.current.profileId ?? PAGE_PROFILE_ID;
    void chrome.storage?.local?.set?.({ [profileStorageKey(POPUP_PREFS_KEY, profileId)]: { downloadMedia: next } });
  };

  const handleOpenX = async () => {
    const entry = await getLikesEntry(profileIdRef.current);
    if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
      try {
        const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
        const likesTab = tabs.find((t) => typeof t.id === 'number' && !!t.url && normalizeLikesEntry(t.url) === entry);
        if (likesTab?.id) {
          await chrome.tabs.update(likesTab.id, { active: true });
          return;
        }
      } catch {
        // fallback to create
      }
      await chrome.tabs.create({ url: entry });
    } else {
      window.open(entry, '_blank', 'noopener');
    }
  };

  const handleStop = async () => {
    if (!pageReading && live?.status === 'paused') {
      setStopping(true);
      setNote('');
      try {
        const profileId = profileIdRef.current;
        const ended = await new SyncService(getProfileDatabase(profileId), profileId).endPausedSync();
        if (ended === 0) setNote('没有暂停中的采集。');
        await applyProbeRef.current();
      } catch (err) {
        setNote(err instanceof Error ? err.message : String(err));
      } finally {
        setStopping(false);
      }
      return;
    }
    if (!tabId) return;
    setStopping(true);
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'STOP_READING', profileId: readingProfileRef.current || profileIdRef.current });
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
      setStopping(false);
    }
  };

  const handlePause = async () => {
    if (!tabId) return;
    setPausing(true);
    setNote('');
    try {
      const res = (await chrome.tabs.sendMessage(tabId, {
        type: 'PAUSE_READING',
        profileId: readingProfileRef.current || profileIdRef.current,
      })) as { status?: string; error?: string } | undefined;
      if (res?.status === 'ignored') setNote(res.error || '当前读取属于另一个档案');
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setPausing(false);
    }
  };

  const handleContinue = async () => {
    if (!tabId || libraryMatch.kind === 'missing' || probe.pageBlocked) return;
    const raw = Number(preset === 'custom' ? customLimit : preset);
    if (fixedResumeLimit === undefined && (!Number.isInteger(raw) || raw < 1 || raw > MAX_SCAN_LIMIT)) {
      setNote(`请输入 1–${MAX_SCAN_LIMIT} 之间的整数扫描上限。`);
      return;
    }
    const limit = fixedResumeLimit ?? normalizeScanLimit(raw);
    setContinuing(true);
    setNote('');
    try {
      if (live?.status !== 'paused') {
        const folder = await getLibraryFolder(profileIdRef.current);
        const handle = folder?.handle as (FileSystemDirectoryHandle & {
          queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
        }) | undefined;
        if (!handle || await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
          setNote('请先在完整设置中绑定文件夹并授予写入权限。');
          return;
        }
      }
      const res = (await chrome.tabs.sendMessage(tabId, {
        type: 'START_READING',
        limit,
        downloadMedia,
        profileId: profileIdRef.current,
      })) as { started?: boolean; reason?: string } | undefined;
      if (!res?.started && res?.reason !== 'already-reading') {
        setNote(continueFailureNote(live?.status, res?.reason));
        return;
      }
      setArmedReading(true);
      void chrome.tabs.update(tabId, { active: true });
    } catch (err) {
      setNote(live?.status === 'paused'
        ? PAUSED_CONTINUE_UNANSWERED
        : (err instanceof Error ? err.message : String(err)));
    } finally {
      setContinuing(false);
    }
  };

  const handleRefresh = async () => {
    if (pageReading) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setNote('');
    setProbe(describePageProbe(null));
    try {
      const source = await getPausedCaptureSource(getProfileDatabase(profileIdRef.current));
      const tab = await locateProbeTab(source);
      if (!tab) {
        await chrome.tabs.create({ url: source === 'x_bookmarks' ? 'https://x.com/i/bookmarks' : await getLikesEntry(profileIdRef.current) });
        setTabId(null);
        setProbe({
          lamp: 'wait',
          title: source === 'x_bookmarks' ? '正在打开收藏' : '正在打开点赞',
          detail: '等列表加载完，再点一次刷新。登录后才能看到帖子。',
          canStart: false,
          needsReload: false,
        });
        return;
      }
      if (isXAuthenticationUrl(tab.url)) {
        setTabId(null);
        setProbe(describePageProbe({ ok: true, failureCode: 'login_required' }));
        return;
      }
      setTabId(tab.id);
      await reloadAndWait(tab.id);
      const next = await readProbe(source);
      setTabId(next.tabId);
      setProbe(next.probe);
      if (live?.status === 'paused' && !next.probe.canStart) setNote(next.probe.detail);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setProbe(describePageProbe({ ok: false, error: message }));
      if (live?.status === 'paused') setNote(message);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  const readingNow = view.lamp === 'reading';
  const capturePaused = !readingNow && live?.status === 'paused';
  const folderBound = libraryMatch.kind !== 'missing' && Boolean(libraryFolderName);
  const folderKnown = libraryMatch.kind === 'missing' || libraryFolderName !== undefined;

  const currentSummary = summary?.profileId === libraryMatch.profileId ? summary : undefined;
  const noLibrary = accountReady && libraryMatch.kind === 'missing';
  const summaryStatus = noLibrary ? '还没有这个账号的文库'
    : currentSummary?.counts === null ? '无法读取文库概况'
    : currentSummary?.counts?.status ?? '正在读取…';
  const metricPlaceholder = noLibrary ? '0' : currentSummary?.counts === null ? '—' : '…';

  return (
    <div className="lm-popup relative w-full text-sm text-slate-800">
      {/* Subpage: Settings Drawer / Overlay */}
      {settingsOpen && (
        <div ref={settingsRef} role="dialog" aria-modal="true" aria-label="扩展设置" tabIndex={-1}
          className="lm-popup-settings bg-[#f3f6fa] p-4 flex flex-col justify-between">
          <div className="space-y-3.5">
            {/* Subpage Header with Back Button */}
            <div className="flex items-center justify-between border-b border-stone-200 pb-2.5">
              <button
                type="button"
                aria-label="返回"
                onClick={() => setSettingsOpen(false)}
                className="flex items-center gap-1 text-xs font-medium text-stone-700 hover:text-stone-900 rounded-lg py-1 px-2 hover:bg-stone-200 transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
                <span>返回</span>
              </button>
              <span className="font-semibold text-stone-900 text-sm">扩展设置</span>
              <div className="w-12" />
            </div>

            <CompletionSettings profileId={libraryMatch.profileId ?? PAGE_PROFILE_ID} />
            {/* Media Download Toggle */}
            <div className="rounded-2xl border border-stone-200 bg-white p-3.5 space-y-1.5 shadow-xs">
              <label className="flex cursor-pointer items-center gap-2 text-stone-800 font-medium text-sm">
                <input
                  type="checkbox"
                  aria-label="保存图片"
                  checked={downloadMedia}
                  disabled={readingNow}
                  onChange={(event) => handleDownloadMedia(event.target.checked)}
                  className="rounded border-stone-300 text-stone-900 focus:ring-stone-900"
                />
                <span>保存图片</span>
              </label>
              <p className="text-xs text-stone-500 leading-relaxed">
                关掉后增量采集只保存文字内容。已下载的图片不受影响。
              </p>
            </div>

            {/* Local AI Model Call */}
            <div className="rounded-2xl border border-stone-200 bg-white p-3.5 space-y-1.5 shadow-xs">
              <div className="flex items-center gap-2 text-stone-900 font-medium text-xs">
                <Cpu className="w-4 h-4 text-stone-600" />
                <span>本地模型调用</span>
              </div>
              <p className="text-xs text-stone-500 leading-relaxed">
                支持直接调用本地 Ollama / LM Studio 离线模型，无需 API Key，数据不出本机。
              </p>
            </div>


          </div>

          <div className="pt-3">
            <button
              type="button"
              onClick={handleOpenSettings}
              className="h-10 w-full rounded-xl border border-stone-300 bg-white font-medium text-stone-800 hover:bg-stone-50 text-xs flex items-center justify-center gap-2 shadow-xs transition-colors"
            >
              <Settings className="w-3.5 h-3.5" />
              <span>打开完整设置</span>
            </button>
          </div>
        </div>
      )}

      <div className="lm-popup-view" hidden={settingsOpen}>
        <header className="lm-popup-header flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="h-9 w-9 shrink-0" />
            <div>
              <h1 className="text-base font-bold leading-tight text-slate-950">XlikeMind</h1>
              <p className="mt-0.5 text-xs text-slate-600">X 点赞与收藏归档</p>
            </div>
          </div>
          <div className="flex items-center text-stone-500">
            <button
              type="button"
              aria-label="设置"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
              className="lm-popup-icon-button"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        </header>
        <div className="lm-popup-content">
          <div className={`lm-popup-account flex justify-between gap-2 ${bindingDraft ? 'items-start' : 'items-center'}`} aria-label="当前 X 账号">
            {bindingDraft ? (
              <form onSubmit={(event) => void saveBindingDraft(event)} className="min-w-0 flex-1 space-y-1">
                <input
                  aria-label="文库名称"
                  value={bindingDraft.name}
                  autoFocus
                  maxLength={48}
                  disabled={accountBusy}
                  onChange={(event) => setBindingDraft({ ...bindingDraft, name: event.target.value })}
                  className="h-7 w-full rounded-md border border-stone-300 bg-white px-2 text-xs text-stone-900 outline-none focus:border-stone-500 disabled:opacity-50"
                />
                <div className="flex min-w-0 items-center gap-1">
                  <input
                    aria-label="绑定 X 用户名（可选）"
                    title="留空则解除绑定，文库内容不变"
                    value={bindingDraft.handle}
                    disabled={accountBusy}
                    placeholder="@sample_name"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setBindingDraft({ ...bindingDraft, handle: event.target.value })}
                    className="h-7 min-w-0 flex-1 rounded-md border border-stone-300 bg-white px-2 text-xs text-stone-900 outline-none focus:border-stone-500 disabled:opacity-50"
                  />
                  <button type="submit" disabled={accountBusy || readingNow} className="shrink-0 text-[11px] font-medium text-stone-800 underline underline-offset-2 disabled:opacity-50">保存</button>
                  <button type="button" disabled={accountBusy} onClick={() => { setBindingDraft(null); setNote(''); setBindingNotice(''); }} className="shrink-0 text-[11px] font-medium text-stone-500 underline underline-offset-2 disabled:opacity-50">取消</button>
                </div>
              </form>
            ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <UserRound size={15} className="shrink-0 text-slate-500" aria-hidden="true" />
              <p className="min-w-0 truncate text-sm font-semibold text-stone-950">
                {accountReady && libraryMatch.handle ? `@${libraryMatch.handle}` : accountReady ? '还没读到用户名' : '正在确认'}
              </p>
              {libraryMatch.kind === 'unbound' && libraryMatch.handle && (
                <button
                  type="button"
                  disabled={accountBusy}
                  onClick={() => void bindPageLibrary()}
                  className="shrink-0 text-[11px] font-medium text-stone-600 underline underline-offset-2 hover:text-stone-900 disabled:opacity-50"
                >
                  绑定到此文库
                </button>
              )}
              {libraryMatch.kind === 'missing' && libraryMatch.handle && (
                <button
                  type="button"
                  disabled={accountBusy}
                  onClick={() => void createLibraryForAccount()}
                  className="shrink-0 text-[11px] font-medium text-stone-600 underline underline-offset-2 hover:text-stone-900 disabled:opacity-50"
                >
                  新建文库
                </button>
              )}
              {accountReady && libraryMatch.profileId && libraryMatch.kind !== 'missing' && (
                <button
                  type="button"
                  aria-label={`修改「${libraryMatch.profileName}」`}
                  title={`修改文库「${libraryMatch.profileName}」的名称和绑定用户名`}
                  disabled={accountBusy || readingNow}
                  onClick={() => void beginEditBinding()}
                  className="block max-w-28 truncate text-left text-[11px] font-medium text-stone-600 underline underline-offset-2 hover:text-stone-900 disabled:opacity-50"
                >
                  修改「{libraryMatch.profileName}」
                </button>
              )}
            </div>
            )}
            {folderKnown && (folderBound ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-emerald-700" title={libraryFolderName ?? undefined}>
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                已绑定
              </span>
            ) : (
              <button
                type="button"
                onClick={handleOpenSettings}
                disabled={libraryMatch.kind === 'missing'}
                title="本地文库还没有绑定文件夹"
                className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-rose-700 disabled:opacity-70"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-rose-500" aria-hidden />
                未绑定
              </button>
            ))}
          </div>
          {bindingNotice ? <p className="mt-1 text-xs leading-5 text-stone-500">{bindingNotice}</p> : null}

          <section aria-label="采集控制" className="lm-popup-capture">
            {!folderBound && <button type="button" onClick={handleOpenSettings} className="mb-3 text-xs text-sky-800 underline">先设置保存位置</button>}
            <h2 className="lm-popup-section-title"><Radio size={16} aria-hidden="true" />采集控制</h2>
            <div role="status" aria-live="polite" className="lm-popup-status" data-state={view.lamp}>
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex h-2.5 w-2.5 rounded-full ring-4 ${LAMP_CLASS[view.lamp]} ${
                    view.lamp === 'checking' || view.lamp === 'reading' ? 'animate-pulse' : ''
                  }`}
                  aria-hidden
                />
                <span className="font-medium text-stone-900">{view.title}</span>
              </div>
              <p className="mt-1 leading-5 text-stone-600 text-xs">{view.detail}</p>
              {note ? <p className="mt-2 text-rose-700 text-xs">{note}</p> : null}
            </div>

            <div className="my-3 lm-popup-limit">
              <label className="text-xs font-medium text-slate-700" htmlFor="read-limit">
                本次扫描上限
              </label>
              <select
                id="read-limit"
                value={preset}
                disabled={readingNow || fixedResumeLimit !== undefined}
                onChange={(event) => setPreset(event.target.value)}
                className="h-8 w-full rounded-lg border border-slate-300 bg-white px-2 text-stone-900 shadow-2xs transition-colors focus:border-stone-500 focus:outline-none disabled:opacity-50"
              >
                {PRESETS.map((value) => (
                  <option key={value} value={String(value)}>
                    {value}
                  </option>
                ))}
                <option value="custom">自定义</option>
              </select>
              {preset === 'custom' ? (
                <input
                  type="number"
                  min={1}
                  max={MAX_SCAN_LIMIT}
                  inputMode="numeric"
                  aria-label="自定义条数"
                  value={customLimit}
                  disabled={readingNow || fixedResumeLimit !== undefined}
                  onChange={(event) => setCustomLimit(event.target.value)}
                  className="col-span-2 h-9 w-full rounded-lg border border-stone-300 bg-white px-3 text-stone-900 shadow-2xs transition-colors focus:border-stone-500 focus:outline-none disabled:opacity-50"
                />
              ) : null}
              {fixedResumeLimit !== undefined && <p className="col-span-2 text-xs text-slate-600">恢复时沿用原上限 {fixedResumeLimit} 条。</p>}
            </div>

            <div className={readingNow || capturePaused ? 'space-y-2' : 'grid grid-cols-[1fr_auto] items-center gap-2'}>
              <button
                type="button"
                onClick={readingNow ? handleOpenSync : () => void handleContinue()}
                disabled={libraryMatch.kind === 'missing' || (!readingNow && (!probe.canStart || continuing || !folderBound))}
                className="flex h-9 w-full items-center justify-center rounded-lg bg-[#20568e] font-semibold text-white shadow-sm hover:bg-[#174676] active:scale-[0.99] transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-500"
              >
                {readingNow ? '查看同步进度' : continuing ? '正在启动…' : '开始同步'}
                <ArrowUpRight size={15} className="ml-1.5" aria-hidden="true" />
              </button>
              <div className={`grid gap-2 ${capturePaused ? 'grid-cols-3 text-xs' : readingNow ? 'grid-cols-2' : 'grid-cols-1'}`}>
                {readingNow ? (
                  <button
                    type="button"
                    onClick={() => void handlePause()}
                    disabled={pausing || stopping}
                    className="h-8 rounded-xl border border-stone-300 bg-white font-medium text-stone-800 shadow-2xs hover:bg-stone-50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:cursor-not-allowed disabled:text-stone-400"
                  >
                    {pausing ? '正在暂停…' : '暂停'}
                  </button>
                ) : capturePaused ? (
                  <button
                    type="button"
                    onClick={() => void handleContinue()}
                    disabled={continuing || stopping || refreshing || !tabId || libraryMatch.kind === 'missing' || probe.pageBlocked}
                    className="h-8 rounded-xl border border-stone-300 bg-white font-medium text-stone-800 shadow-2xs hover:bg-stone-50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:cursor-not-allowed disabled:text-stone-400"
                  >
                    {continuing ? '正在继续…' : '继续采集'}
                  </button>
                ) : null}
                {capturePaused ? (
                  <button
                    type="button"
                    onClick={() => void handleStop()}
                    disabled={stopping || refreshing}
                    className="h-8 rounded-xl border border-stone-300 bg-white font-medium text-stone-800 shadow-2xs hover:bg-stone-50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:cursor-not-allowed disabled:text-stone-400"
                  >
                    {stopping ? '正在停止…' : '停止'}
                  </button>
                ) : null}
                {readingNow ? (
                  <button
                    type="button"
                    onClick={() => void handleStop()}
                    disabled={stopping || pausing}
                    className="h-8 rounded-xl border border-stone-300 bg-white font-medium text-stone-800 shadow-2xs hover:bg-stone-50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:cursor-not-allowed disabled:text-stone-400"
                  >
                    {stopping ? '正在停止…' : '停止'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleRefresh()}
                    disabled={refreshing || stopping}
                    className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                    <span>{refreshing ? '正在刷新…' : '刷新'}</span>
                  </button>
                )}
              </div>
            </div>

          </section>

          <section aria-label="文库概况" className="lm-popup-summary">
            <dl className="grid grid-cols-2 gap-3">
              <div>
                <dt className="lm-popup-metric-label"><BookOpen size={14} aria-hidden="true" />已收录帖子</dt>
                <dd className="lm-popup-metric">{currentSummary?.counts?.posts.toLocaleString('zh-CN') ?? metricPlaceholder}</dd>
              </div>
              <div className="border-l border-slate-200 pl-3">
                <dt className="lm-popup-metric-label"><ImageIcon size={14} aria-hidden="true" />已保存图片</dt>
                <dd className="lm-popup-metric">{currentSummary?.counts?.media.toLocaleString('zh-CN') ?? metricPlaceholder}</dd>
              </div>
            </dl>
            <p className="mt-2 flex items-center gap-1.5 border-t border-slate-200 pt-2 text-xs leading-5 text-slate-600">
              <Activity size={14} aria-hidden="true" />最近同步 · {summaryStatus}
            </p>
          </section>

          <button type="button" onClick={handleOpenSync} disabled={libraryMatch.kind === 'missing'} className="mt-3 text-xs text-slate-600 underline">同步详情与历史</button>
          <footer className="lm-popup-footer grid grid-cols-2 items-center gap-2">
            <button
              type="button"
              onClick={handleOpenDashboard}
              disabled={libraryMatch.kind === 'missing'}
              className="lm-popup-shortcut"
            >
              <BookOpen size={15} aria-hidden="true" />打开文库
            </button>
            <button
              type="button"
              onClick={handleOpenX}
              className="lm-popup-shortcut"
            >
              打开 X 点赞<ArrowUpRight size={15} aria-hidden="true" />
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
};
