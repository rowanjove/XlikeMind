import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../storage/db';
import type { NormalizedPost } from '../domain/types';
import { Navbar, type NavTab } from './components/Navbar';
import { DashboardPage } from './pages/DashboardPage';
import { SyncPage } from './pages/SyncPage';
import { LibraryPage, type LibrarySubView } from './pages/LibraryPage';
import { SettingsPage } from './pages/SettingsPage';
import { PostDetailModal } from './components/PostDetailModal';
import { ExportModal } from './components/ExportModal';
import { DiagnosticsModal } from './components/DiagnosticsModal';
import { aiService } from '../ai/aiService';
import { syncService } from '../sync/syncService';
import { FolderSetup } from './components/FolderSetup';
import { isFileSystemAccessSupported } from '../export/directFolderExport';
import { getPublicationState } from '../export/publicationState';
import { chooseLibraryFolder, forgetLibraryFolder, getLibraryFolder, grantLibraryWrite, inspectLibraryEntry, publishBoundLibrary } from '../export/libraryFolder';

const TAB_IDS: NavTab[] = ['dashboard', 'sync', 'library', 'settings'];

function tabFromLocation(): { tab: NavTab; subView?: LibrarySubView } {
  const hash = window.location.hash.replace(/^#/, '');
  if (hash === 'topics') return { tab: 'library', subView: 'topics' };
  if (hash === 'library') {
    return { tab: 'library', subView: 'posts' };
  }
  return { tab: TAB_IDS.includes(hash as NavTab) ? (hash as NavTab) : 'dashboard' };
}

export const App: React.FC = () => {
  const initial = tabFromLocation();
  const [currentTab, setCurrentTab] = useState<NavTab>(initial.tab);
  const [librarySubView, setLibrarySubView] = useState<LibrarySubView>(initial.subView || 'posts');
  const [libraryBatch, setLibraryBatch] = useState<{ id: string; repairOnly: boolean; changesOnly?: boolean }>();
  const [selectedPost, setSelectedPost] = useState<NormalizedPost | null>(null);
  const [deleteError, setDeleteError] = useState(false);

  // Modals state
  const [exportPosts, setExportPosts] = useState<NormalizedPost[] | null>(null);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [deferSetup, setDeferSetup] = useState(false);
  const [folderBusy, setFolderBusy] = useState(false);
  const [libraryMediaBusy, setLibraryMediaBusy] = useState(false);
  const [folderMessage, setFolderMessage] = useState('');
  const [publication, setPublication] = useState<{ stage: 'idle' | 'writing' | 'done' | 'error'; message: string }>({ stage: 'idle', message: '' });
  const publishing = useRef(false);
  const attempted = useRef('');
  const setupDialog = useRef<HTMLDialogElement>(null);
  const supported = isFileSystemAccessSupported();
  const folder = useLiveQuery(async () => (await getLibraryFolder()) ?? null, []);
  const diskState = useLiveQuery(async () => {
    try { return await getPublicationState(); } catch { return 'unavailable' as const; }
  }, []);

  // Live queries from Dexie IndexedDB
  const [libraryReadAttempt, setLibraryReadAttempt] = useState(0);
  const libraryRead = useLiveQuery(async () => {
    try {
      return { attempt: libraryReadAttempt, posts: await db.posts.toArray() };
    } catch {
      return { attempt: libraryReadAttempt, posts: null };
    }
  }, [libraryReadAttempt]);
  const currentRead = libraryRead?.attempt === libraryReadAttempt ? libraryRead : undefined;
  const posts = currentRead?.posts ?? [];
  const libraryReady = Array.isArray(currentRead?.posts);
  const latestRun = useLiveQuery(() => db.syncRuns.orderBy('startedAt').reverse().first(), []) || null;
  const syncRuns = useLiveQuery(() => db.syncRuns.orderBy('startedAt').reverse().toArray(), []) || [];

  const handleDeletePost = async (postId: string) => {
    setDeleteError(false);
    const { posts, media, userOverrides, aiAnalysis } = db;
    try {
      await db.transaction('rw', posts, media, userOverrides, aiAnalysis, async () => {
        await posts.delete(postId);
        await media.where('postId').equals(postId).delete();
        await userOverrides.delete(postId);
        await aiAnalysis.delete(postId);
      });
    } catch {
      setDeleteError(true);
    }
  };

  const pendingRun = syncRuns.find((run) =>
    run.stats.scanned > 0 && run.endedAt &&
    (run.status === 'completed' || run.status === 'partial' || run.status === 'cancelled') &&
    (!folder?.boundAt || run.startedAt >= folder.boundAt)
  );
  const pendingRunId = pendingRun?.id;
  const showSetup = supported && folder === null && !deferSetup && currentTab !== 'settings';
  const diskMessage = diskState === 'changed' ? '有未写入的更改。本地 index.html 仍是上次写入的版本。'
    : diskState === 'unknown' ? '已有本地文库，尚未核对内容版本。可手动写入以更新。'
    : diskState === 'unpublished' ? '当前文库尚未写入本地目录。'
    : diskState === 'unavailable' ? '暂时无法核对本地文库版本，请重试或检查保存位置。'
    : diskState === 'current' ? '扩展内容没有新的待写入更改。' : '';
  const visiblePublication = publication.stage === 'writing' || publication.stage === 'error'
    ? publication : { stage: diskState === 'current' ? 'done' as const : 'idle' as const, message: diskMessage };

  useEffect(() => {
    const dialog = setupDialog.current;
    if (!showSetup || !dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, [showSetup]);
  const publish = useCallback(async (runId?: string, handle?: FileSystemDirectoryHandle) => {
    if (publishing.current) return;
    publishing.current = true;
    setFolderMessage('');
    setPublication({ stage: 'writing', message: '正在写入本地文库…' });
    try {
      if (handle) await grantLibraryWrite(handle);
      const name = await publishBoundLibrary(runId, () => undefined, Boolean(handle));
      setPublication({ stage: 'done', message: name ? '本地文库已更新。可从绑定目录的 index.html 打开。' : '本次同步已写入本地文库。' });
    } catch (error) {
      setPublication({ stage: 'error', message: error instanceof Error ? error.message : '写入失败。请到设置重试。' });
    } finally {
      publishing.current = false;
    }
  }, []);

  const inspectFolder = async () => {
    if (!folder || folderBusy || publication.stage === 'writing') return;
    setFolderBusy(true);
    setFolderMessage('正在检查目录授权与入口…');
    try {
      const entry = await inspectLibraryEntry(folder.handle, folder.managedName);
      setFolderMessage(entry.status === 'ready'
        ? `目录已授权。index.html 为 ${entry.bytes.toLocaleString('zh-CN')} 字节，最后更新于 ${new Date(entry.modifiedAt).toLocaleString('zh-CN')}。`
        : entry.status === 'empty' ? '目录已授权，但 index.html 为空，请点击「立即写入文库」恢复入口。'
        : '目录已授权，尚未找到 index.html，请点击「立即写入文库」生成入口。');
    } catch (error) {
      setFolderMessage(error instanceof Error ? error.message : '目录检查失败，请重新授权或选择文件夹。');
    } finally {
      setFolderBusy(false);
    }
  };

  useEffect(() => {
    if (!folder || folderBusy || !pendingRunId || folder.publishedRunId === pendingRunId || publication.stage === 'writing') return;
    const key = `${folder.managedName ?? folder.handle.name}:${pendingRunId}`;
    if (attempted.current === key) return;
    attempted.current = key;
    void publish(pendingRunId);
  }, [folder, folderBusy, pendingRunId, publication.stage, publish]);

  const updateBinding = async (action: () => Promise<void>) => {
    setFolderBusy(true);
    setFolderMessage('');
    try {
      await action();
      setDeferSetup(true);
      setPublication({ stage: 'idle', message: '' });
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) setFolderMessage('目录设置失败。请重新选择可写入的文件夹。');
    } finally {
      setFolderBusy(false);
    }
  };

  const changeTab = (tab: NavTab) => {
    setCurrentTab(tab);
    setLibraryBatch(undefined);
    if (tab === 'library') {
      setLibrarySubView('posts');
    }
    const nextHash = tab === 'dashboard' ? '' : `#${tab}`;
    if (window.location.hash !== nextHash) {
      const url = `${window.location.pathname}${window.location.search}${nextHash}`;
      window.history.replaceState(null, '', url);
    }
  };

  useEffect(() => {
    void aiService.getConfig().catch(() => undefined);
    void syncService.recoverStaleRuns(90_000).catch(() => undefined);
  }, []);

  useEffect(() => {
    const handleHashChange = () => {
      const loc = tabFromLocation();
      setCurrentTab(loc.tab);
      setLibraryBatch(undefined);
      if (loc.subView) {
        setLibrarySubView(loc.subView);
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  return (
    <div className="min-h-screen bg-[#f6f5f2] text-stone-900 flex flex-col font-sans antialiased">
      {/* Top Navbar */}
      <Navbar
        currentTab={currentTab}
        onChangeTab={changeTab}
        postCount={posts.length}
        busy={folderBusy || libraryMediaBusy || publication.stage === 'writing' || latestRun?.status === 'running'}
        blocked={folderBusy || libraryMediaBusy || publication.stage === 'writing' || latestRun?.status === 'running'}
      />

      {/* Main Content Area */}
      <main className={`flex-1 w-full mx-auto px-4 sm:px-6 ${currentTab === 'library' ? 'max-w-7xl py-5 sm:py-6' : 'max-w-6xl py-8'}`}>
        {deleteError && (
          <p role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
            删除失败，这篇帖子的本地资料仍保留。请重试。
          </p>
        )}
        {(currentTab === 'dashboard' || currentTab === 'library') && !libraryReady && (
          <section className="lm-panel space-y-3 p-5">
            <h1 className="text-xl font-semibold">{currentTab === 'library' ? '文库' : '总览'}</h1>
            {currentRead?.posts === null ? (
              <>
                <p role="alert" className="text-rose-800">无法读取本地文库。</p>
                <button type="button" className="lm-button-quiet px-3 py-2"
                  onClick={() => setLibraryReadAttempt((attempt) => attempt + 1)}>重试读取</button>
              </>
            ) : <p role="status">正在读取本地文库…</p>}
          </section>
        )}
        {currentTab === 'dashboard' && libraryReady && (
          <DashboardPage
            posts={posts}
            latestRun={latestRun}
            onNavigateTab={changeTab}
            onViewPostDetails={setSelectedPost}
            onDeletePost={handleDeletePost}
          />
        )}

        {currentTab === 'sync' && (
          <SyncPage folderName={folder?.handle.name} onOpenFolderSettings={() => changeTab('settings')}
            beforeSync={folder ? () => grantLibraryWrite(folder.handle) : undefined}
            onOpenBatch={(id, repairOnly, changesOnly) => {
              changeTab('library');
              setLibraryBatch({ id, repairOnly, changesOnly });
            }}
            publication={visiblePublication} onOpenDiagnostics={() => setIsDiagnosticsOpen(true)} />
        )}

        {currentTab === 'library' && libraryReady && (
          <>
          {folder && diskMessage && <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm">
            <span>{diskMessage}</span>
            <button type="button" onClick={() => changeTab('settings')} className="shrink-0 text-emerald-800 underline">管理本地写入</button>
          </div>}
          <LibraryPage
            posts={posts}
            syncRuns={syncRuns}
            initialSubView={librarySubView}
            initialBatch={libraryBatch}
            onViewPostDetails={setSelectedPost}
            onDeletePost={handleDeletePost}
            onExportFiltered={folderBusy || publication.stage === 'writing' ? undefined : setExportPosts}
            onMediaRetryBusyChange={setLibraryMediaBusy}
          />
          </>
        )}

        {currentTab === 'settings' && (
          <SettingsPage
            profileBusy={latestRun?.status === 'running' || publication.stage === 'writing'}
            canExport={posts.length > 0 && publication.stage !== 'writing' && !folderBusy}
            onOpenExport={() => setExportPosts(posts)}
            folderSettings={<FolderSetup
              folderName={folder?.handle.name} managedName={folder?.managedName}
              ready={Boolean(folder?.latestSnapshot)}
              message={folderMessage || visiblePublication.message}
              supported={supported} busy={folderBusy || publication.stage === 'writing'}
              onChoose={() => void updateBinding(chooseLibraryFolder)}
              actions={folder && <>
                <button type="button" disabled={folderBusy || publication.stage === 'writing'}
                  onClick={() => void inspectFolder()}
                  className="rounded-lg border border-stone-300 px-4 py-2 text-sm disabled:opacity-50">检查授权与入口</button>
                <button type="button" disabled={!posts.length || folderBusy || publication.stage === 'writing'}
                  onClick={() => void publish(pendingRunId, folder.handle)}
                  className="rounded-lg border border-stone-300 px-4 py-2 text-sm disabled:opacity-50">立即写入文库</button>
                <button type="button" disabled={folderBusy || publication.stage === 'writing'}
                  onClick={() => void updateBinding(forgetLibraryFolder)}
                  className="px-3 py-2 text-sm text-stone-600 disabled:opacity-50">解除绑定</button>
              </>}
            />}
            onOpenDiagnostics={() => setIsDiagnosticsOpen(true)}
            onDatabaseReset={() => {}}
          />
        )}
      </main>

      {showSetup && (
          <dialog ref={setupDialog} aria-label="设置本地文库"
            onCancel={(event) => { event.preventDefault(); if (!folderBusy) setDeferSetup(true); }}
            className="m-auto w-[calc(100%-2.5rem)] max-w-xl rounded-xl bg-transparent p-0 backdrop:bg-stone-900/35">
            <FolderSetup message={folderMessage} busy={folderBusy} supported={supported}
              onChoose={() => void updateBinding(chooseLibraryFolder)}
              actions={<button type="button" disabled={folderBusy} onClick={() => setDeferSetup(true)} className="px-3 py-2 text-sm text-stone-700">先浏览</button>} />
          </dialog>
      )}

      {/* Footer */}
      {/* Modals */}
      <PostDetailModal
        post={selectedPost}
        onClose={() => setSelectedPost(null)}
        onPostUpdated={(updated) => setSelectedPost(updated)}
      />

      {exportPosts && <ExportModal
        isOpen
        onClose={() => setExportPosts(null)}
        filteredPosts={exportPosts}
        totalPostsCount={posts.length}
      />}

      <DiagnosticsModal
        isOpen={isDiagnosticsOpen}
        onClose={() => setIsDiagnosticsOpen(false)}
      />
    </div>
  );
};
