import React, { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { NormalizedPost, MediaAsset, AIAnalysis, ExportManifest, ExportJob, UserOverrides } from '../../domain/types';
import { X, Download, FileArchive, CheckCircle2, Loader2, FolderDown, FolderCheck } from 'lucide-react';
import { buildExportZip, type ExportProgress } from '../../export/zip';
import { EXPORT_BATCH_SIZE, OversizedExportPostError, exportBatchCount, exportMediaBytes, exportZipFilename, planExportBatches } from '../../export/batches';
import { db } from '../../storage/db';
import { isFileSystemAccessSupported, type DirectExportProgress } from '../../export/directFolderExport';
import { chooseLibraryFolder, forgetLibraryFolder, getLibraryFolder, publishLibrarySnapshot } from '../../export/libraryFolder';
import { useDialogFocus } from './useDialogFocus';
import { captureDiagnosticFrames } from '../../domain/diagnosticFrames';
import { hasArchivedMedia } from '../../domain/media';

interface FinishedZip {
  filename: string;
  downloadUrl?: string;
  postCount: number;
  assetsCount: number;
  status: ExportManifest['status'];
}

async function submitZipDownload(url: string, filename: string): Promise<number | undefined> {
  if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
    return chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
  }
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function ZipDownloadStatus({ id }: { id?: number }) {
  const [label, setLabel] = useState('仅记录已提交');
  useEffect(() => {
    if (id === undefined || typeof chrome === 'undefined' || !chrome.downloads?.search) return;
    const downloads = chrome.downloads;
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      try {
        const [item] = await downloads.search({ id });
        if (current !== revision) return;
        setLabel(item?.state === 'complete' ? (item.exists ? '已保存' : '文件已移除')
          : item?.state === 'interrupted' ? '下载中断'
          : item?.state === 'in_progress' ? '下载中' : '浏览器记录不可用');
      } catch {
        if (current === revision) setLabel('浏览器记录不可用');
      }
    };
    const changed = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === id && (delta.state || delta.exists)) void refresh();
    };
    const erased = (erasedId: number) => {
      if (erasedId === id) void refresh();
    };
    downloads.onChanged?.addListener(changed);
    downloads.onErased?.addListener(erased);
    void refresh();
    return () => {
      revision++;
      downloads.onChanged?.removeListener(changed);
      downloads.onErased?.removeListener(erased);
    };
  }, [id]);
  return <span className="text-stone-600"> · {label}</span>;
}

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  filteredPosts: NormalizedPost[];
  totalPostsCount: number;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  filteredPosts,
  totalPostsCount,
}) => {
  const [scope, setScope] = useState<'all' | 'filtered'>('filtered');
  const [exportMethod, setExportMethod] = useState<'zip' | 'folder'>('zip');
  const [linksOnly, setLinksOnly] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [directProgress, setDirectProgress] = useState<DirectExportProgress | null>(null);
  const [directFolderResult, setDirectFolderResult] = useState<Awaited<ReturnType<typeof publishLibrarySnapshot>> | null>(null);
  const [folderError, setFolderError] = useState('');
  const [isChoosingFolder, setIsChoosingFolder] = useState(false);
  const [batchLabel, setBatchLabel] = useState('');
  const [finishedFiles, setFinishedFiles] = useState<FinishedZip[]>([]);
  const [zipCancelled, setZipCancelled] = useState(false);
  const [zipError, setZipError] = useState('');
  const zipAbort = useRef<AbortController | null>(null);
  const liveUrl = useRef<string | null>(null);
  const isDirectSupported = isFileSystemAccessSupported();
  const folder = useLiveQuery(async () => isDirectSupported ? (await getLibraryFolder()) ?? null : null, [isDirectSupported]);
  const latestZipJob = useLiveQuery(() => isOpen ? db.exportJobs.orderBy('startedAt').last() : undefined, [isOpen]);
  const busy = isExporting || isChoosingFolder;
  const dialogRef = useDialogFocus(isOpen, () => { if (!busy) onClose(); });

  useEffect(() => {
    return () => {
      zipAbort.current?.abort();
      if (liveUrl.current) URL.revokeObjectURL(liveUrl.current);
    };
  }, []);

  if (!isOpen) return null;

  const countToExport = scope === 'all' ? totalPostsCount : filteredPosts.length;
  const batchCount = exportBatchCount(countToExport);

  const rememberDownload = (url: string) => {
    if (liveUrl.current) URL.revokeObjectURL(liveUrl.current);
    liveUrl.current = url;
  };

  const handleStartExport = async () => {
    if (zipAbort.current) return;
    const controller = new AbortController();
    zipAbort.current = controller;
    setIsExporting(true);
    setZipCancelled(false);
    setZipError('');
    setProgress({ current: 0, total: 100, stage: 'preparing' });
    setBatchLabel('');
    setFinishedFiles([]);
    if (liveUrl.current) {
      URL.revokeObjectURL(liveUrl.current);
      liveUrl.current = null;
    }

    const job: ExportJob = {
      id: crypto.randomUUID(), startedAt: new Date().toISOString(),
      status: 'running', totalPackages: 0, submittedFiles: [],
    };
    let recorded = false;
    let finalStatus: ExportJob['status'] = 'completed';
    let batchNumber = 0;
    let failureMessage: string | undefined;
    let diagnosticFrames: string[] | undefined;
    try {
      await db.exportJobs.add(job);
      recorded = true;
      const posts = scope === 'all' ? await db.posts.toArray() : filteredPosts;
      controller.signal.throwIfAborted();
      const bytesByPost = new Map<string, number>();
      const countBatches = planExportBatches(posts);
      if (!linksOnly) {
        for (const batch of countBatches) {
          controller.signal.throwIfAborted();
          await db.media.where('postId').anyOf(batch.map((post) => post.id)).each((asset) => {
            controller.signal.throwIfAborted();
            bytesByPost.set(asset.postId, (bytesByPost.get(asset.postId) ?? 0) + exportMediaBytes(asset));
          });
        }
      }
      const batches = linksOnly ? countBatches : planExportBatches(posts, EXPORT_BATCH_SIZE, (post) => bytesByPost.get(post.id) ?? 0);
      await db.exportJobs.update(job.id, { totalPackages: batches.length });
      const syncRuns = await db.syncRuns.toArray();
      const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const finished: FinishedZip[] = [];

      for (let index = 0; index < batches.length; index++) {
        controller.signal.throwIfAborted();
        batchNumber = index + 1;
        const batch = batches[index];
        setBatchLabel(batches.length > 1 ? `第 ${index + 1} / ${batches.length} 包` : '');
        const postIds = batch.map((post) => post.id);
        const mediaMap = new Map<string, MediaAsset[]>();
        const [, overrides, allAi] = await Promise.all([
          db.media.where('postId').anyOf(postIds).each((media) => {
            controller.signal.throwIfAborted();
            const list = mediaMap.get(media.postId) || [];
            list.push(linksOnly ? { ...media, blob: undefined,
              status: hasArchivedMedia(media) ? 'remote_only' : media.status } : media);
            mediaMap.set(media.postId, list);
          }),
          db.userOverrides.where('postId').anyOf(postIds).toArray(),
          db.aiAnalysis.where('postId').anyOf(postIds).toArray(),
        ]);
        controller.signal.throwIfAborted();

        const overridesMap = new Map<string, UserOverrides>(overrides.map((item) => [item.postId, item]));
        const aiMap = new Map<string, AIAnalysis>(allAi.map((item) => [item.postId, item]));

        const { blob, manifest } = await buildExportZip({
          posts: batch,
          mediaMap,
          overridesMap,
          aiMap,
          syncRuns,
          packageInfo: {
            exportId: job.id, part: index + 1, totalParts: batches.length, totalPosts: posts.length, linksOnly,
          },
          signal: controller.signal,
          onProgress: (next) => setProgress(next),
        });
        controller.signal.throwIfAborted();

        const filename = exportZipFilename(dateTag, index, batches.length);
        const downloadUrl = URL.createObjectURL(blob);
        rememberDownload(downloadUrl);
        const file: FinishedZip = {
          filename,
          downloadUrl,
          postCount: manifest.postCount,
          assetsCount: manifest.assetsCount,
          status: manifest.status,
        };
        const downloadId = await submitZipDownload(downloadUrl, filename);
        for (const older of finished) older.downloadUrl = undefined;
        finished.push(file);
        setFinishedFiles(finished.map((item) => ({ ...item })));
        job.submittedFiles.push(filename);
        if (downloadId !== undefined) (job.downloadIds ??= {})[filename] = downloadId;
        await db.exportJobs.update(job.id, { submittedFiles: job.submittedFiles, downloadIds: job.downloadIds });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        finalStatus = 'cancelled';
        setZipCancelled(true);
      } else {
        finalStatus = 'failed';
        diagnosticFrames = captureDiagnosticFrames(error);
        failureMessage = error instanceof OversizedExportPostError ? error.message : batchNumber
          ? `第 ${batchNumber} 包导出失败。`
          : '准备 ZIP 导出失败。';
        setZipError(failureMessage);
      }
    } finally {
      if (recorded) {
        try {
          await db.exportJobs.update(job.id, {
            status: finalStatus, endedAt: new Date().toISOString(), failureMessage, diagnosticFrames,
            failedPackage: finalStatus === 'failed' && batchNumber > 0 ? batchNumber : undefined,
          });
        } catch {
          // The last durable package record still describes the submitted downloads.
        }
      }
      zipAbort.current = null;
      setIsExporting(false);
    }
  };

  const changeFolder = async (action: () => Promise<void>) => {
    setIsChoosingFolder(true);
    setFolderError('');
    try {
      await action();
    } catch (err: unknown) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        setFolderError('无法更新目录绑定。请重新选择有写入权限的文件夹。');
      }
    } finally {
      setIsChoosingFolder(false);
    }
  };

  const handleDirectFolderExport = async () => {
    if (!folder) return;
    setIsExporting(true);
    setFolderError('');
    setDirectProgress({ current: 0, total: 100, currentFile: '准备写入…', stage: 'preparing' });
    try {
      const postIds = scope === 'filtered' ? filteredPosts.map((post) => post.id) : undefined;
      setDirectFolderResult(await publishLibrarySnapshot(folder.handle, postIds, setDirectProgress));
    } catch (err: unknown) {
      setFolderError(err instanceof Error ? err.message : '写入本地知识库失败。');
    } finally {
      setIsExporting(false);
    }
  };

  const getStageLabel = (stage: ExportProgress['stage']) => {
    switch (stage) {
      case 'preparing':
        return '正在读取…';
      case 'markdown':
        return '正在写成 Markdown…';
      case 'assets':
        return '正在放入图片…';
      case 'topics':
        return '正在整理主题…';
      case 'compressing':
        return '正在打包…';
      case 'done':
        return '好了，开始下载。';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-stone-900/40 p-4">
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="导出" className="bg-white rounded-2xl max-w-xl w-full max-h-full shadow-2xl flex flex-col overflow-auto border border-slate-200">
        <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
          <div className="flex items-center space-x-2">
            <FileArchive className="w-5 h-5 text-sky-600" />
            <h2 className="font-medium text-stone-900">导出</h2>
          </div>
          <button
            aria-label="关闭导出"
            onClick={onClose}
            disabled={busy}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5 text-sm">
          {/* Scope selection */}
          {filteredPosts.length === totalPostsCount ? (
            <p className="text-sm text-stone-600">整库导出 · {totalPostsCount} 篇</p>
          ) : <div>
            <label className="mb-2 block text-sm text-stone-600">导出哪些</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setScope('filtered')}
                disabled={busy}
                className={`p-3 rounded-xl border text-left flex flex-col justify-between transition-colors ${
                  scope === 'filtered'
                    ? 'border-sky-500 bg-sky-50/50 text-sky-900 ring-2 ring-sky-500/20'
                    : 'border-slate-200 hover:border-slate-300 text-slate-700'
                }`}
              >
                <div className="text-sm font-medium">当前筛选</div>
                <div className="text-xl font-bold mt-1 text-slate-900">{filteredPosts.length} 篇</div>
              </button>

              <button
                type="button"
                onClick={() => setScope('all')}
                disabled={busy}
                className={`p-3 rounded-xl border text-left flex flex-col justify-between transition-colors ${
                  scope === 'all'
                    ? 'border-sky-500 bg-sky-50/50 text-sky-900 ring-2 ring-sky-500/20'
                    : 'border-slate-200 hover:border-slate-300 text-slate-700'
                }`}
              >
                <div className="text-sm font-medium">全部</div>
                <div className="text-xl font-bold mt-1 text-slate-900">{totalPostsCount} 篇</div>
              </button>
            </div>
          </div>}

          {exportMethod === 'zip' && (
            <label className="flex items-center gap-2 text-sm text-stone-700">
              <input type="checkbox" checked={linksOnly} disabled={busy}
                onChange={(event) => setLinksOnly(event.target.checked)} />
              仅导出文字与图片链接
            </label>
          )}
          {exportMethod === 'zip' && batchCount > 1 && (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm leading-6 text-amber-950">
              按帖子数量会分成 {batchCount} 个压缩包。每包最多 {EXPORT_BATCH_SIZE} 篇。{!linksOnly && '已归档媒体超过 64 MiB 时会继续分包。'}
            </p>
          )}
          {exportMethod === 'zip' && !linksOnly && batchCount <= 1 && (
            <p className="text-xs text-stone-600">每包已归档媒体最多 64 MiB。开始导出时会按实际大小分包。</p>
          )}

          {/* Export Method Toggle */}
          <div>
            <label className="mb-2 block text-sm text-stone-600">导出方式</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setExportMethod('zip')}
                disabled={busy}
                className={`p-3 rounded-xl border text-left flex flex-col justify-between transition-colors ${
                  exportMethod === 'zip'
                    ? 'border-sky-500 bg-sky-50/50 text-sky-900 ring-2 ring-sky-500/20'
                    : 'border-slate-200 hover:border-slate-300 text-slate-700'
                }`}
              >
                <div className="flex items-center gap-1.5 font-medium text-sm">
                  <Download className="w-4 h-4 text-sky-600" />
                  <span>下载 ZIP 压缩包</span>
                </div>
                <div className="text-xs text-stone-500 mt-1">标准离线包，随时下载解压</div>
              </button>

              <button
                type="button"
                onClick={() => isDirectSupported && setExportMethod('folder')}
                disabled={!isDirectSupported || busy}
                className={`p-3 rounded-xl border text-left flex flex-col justify-between transition-colors ${
                  exportMethod === 'folder'
                    ? 'border-sky-500 bg-sky-50/50 text-sky-900 ring-2 ring-sky-500/20'
                    : isDirectSupported
                    ? 'border-slate-200 hover:border-slate-300 text-slate-700'
                    : 'border-slate-100 bg-slate-50 text-slate-400 cursor-not-allowed'
                }`}
              >
                <div className="flex items-center gap-1.5 font-medium text-sm">
                  <FolderDown className="w-4 h-4 text-emerald-600" />
                  <span>发布到本地文件夹</span>
                </div>
                <div className="text-xs text-stone-500 mt-1">
                  {isDirectSupported ? '记住目录，每次发布一份独立快照' : '当前浏览器不支持目录写入'}
                </div>
              </button>
            </div>
          </div>

          {exportMethod === 'folder' && (
            <div className="space-y-3 rounded-xl border border-stone-200 p-3.5">
              <p className="break-words font-medium">
                {folder ? `已绑定 · ${folder.handle.name}` : folder === undefined ? '正在读取目录设置…' : '尚未绑定目录'}
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy || folder === undefined}
                  onClick={() => void changeFolder(chooseLibraryFolder)}
                  className="rounded-lg border border-stone-300 px-3 py-1.5 hover:bg-stone-50 disabled:opacity-50">
                  {folder ? '切换目录' : '绑定目录'}
                </button>
                {folder && (
                  <button type="button" disabled={busy} onClick={() => void changeFolder(forgetLibraryFolder)}
                    className="rounded-lg border border-stone-300 px-3 py-1.5 hover:bg-stone-50 disabled:opacity-50">
                    取消绑定
                  </button>
                )}
              </div>
              {folderError && <p role="alert" className="text-red-800">{folderError}</p>}
            </div>
          )}

          {/* Directory structure preview */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 text-xs text-slate-600 font-mono">
            <div className="mb-1.5 font-sans text-sm font-medium text-stone-700">离线知识库结构</div>
            <div className="space-y-0.5">
              <div className="pl-4">├── index.html（双击打开离线文库）</div>
              <div className="pl-4">├── 📁 posts/YYYY/MM/&lt;post_id&gt;.md</div>
              <div className="pl-4">├── 📁 assets/&lt;post_id&gt;/01.png</div>
              <div className="pl-4">└── 📄 manifest.json (元数据清单)</div>
            </div>
            <div className="font-sans text-[11px] text-slate-500 mt-2">
              * Markdown 内引用路径形如 <code className="bg-slate-200 px-1 py-0.5 rounded">../../../assets/&lt;id&gt;/01.png</code>，可在 Obsidian / VS Code 离线查看。
            </div>
          </div>

          {/* Progress / Status */}
          {isExporting && progress && (
            <div className="bg-sky-50 border border-sky-200 rounded-xl p-4 space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-medium text-sky-800 flex items-center space-x-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>
                    {batchLabel ? `${batchLabel} · ` : ''}
                    {getStageLabel(progress.stage)}
                  </span>
                </span>
                <span className="font-mono text-sky-700">
                  {progress.current} / {progress.total}
                </span>
              </div>
              <div className="w-full bg-sky-200 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-sky-600 h-2 transition-all duration-200"
                  style={{
                    width: `${Math.min(
                      100,
                      progress.total > 0 ? (progress.current / progress.total) * 100 : 0
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}

          {/* Direct Folder Progress / Status */}
          {isExporting && directProgress && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-medium text-emerald-800 flex items-center space-x-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>正在直接写入本地目录: {directProgress.currentFile}</span>
                </span>
                <span className="font-mono text-emerald-700">
                  {directProgress.current} / {directProgress.total}
                </span>
              </div>
              <div className="w-full bg-emerald-200 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-emerald-600 h-2 transition-all duration-200"
                  style={{
                    width: `${Math.min(
                      100,
                      directProgress.total > 0 ? (directProgress.current / directProgress.total) * 100 : 0
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}

          {/* Direct Folder Result Summary */}
          {directFolderResult && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 space-y-1 text-sm text-emerald-950">
              <div className="flex items-center space-x-2 font-medium">
                <FolderCheck className="w-4 h-4 text-emerald-600" />
                <span>{directFolderResult.manifest.status === 'complete' ? '快照已发布' : '快照已发布，部分内容未归档'}</span>
              </div>
              <p role="status" className="break-all text-xs text-stone-600">
                {directFolderResult.name} · {directFolderResult.manifest.postCount} 篇 · {directFolderResult.writtenFilesCount} 个文件
              </p>
            </div>
          )}

          {/* Result summary */}
          {!isExporting && !finishedFiles.length && !zipError && latestZipJob && exportMethod === 'zip' && (
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
              <p className="font-medium">最近一次 ZIP 导出</p>
              <p>{new Date(latestZipJob.startedAt).toLocaleString('zh-CN')} · {{
                running: '未记录结束', completed: '打包完成', cancelled: '已停止', failed: '失败',
              }[latestZipJob.status]}</p>
              <p>已发起下载 {latestZipJob.submittedFiles.length}{latestZipJob.totalPackages ? ` / ${latestZipJob.totalPackages}` : ''} 包</p>
              {latestZipJob.failureMessage && <p className="text-rose-800">{latestZipJob.failureMessage}</p>}
              {latestZipJob.submittedFiles.length > 0 && (
                <ul className="list-disc break-all pl-5">
                  {latestZipJob.submittedFiles.map((filename) => (
                    <li key={filename}>{filename}<ZipDownloadStatus id={latestZipJob.downloadIds?.[filename]} /></li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {zipError && exportMethod === 'zip' && (
            <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">{zipError}</p>
          )}

          {zipCancelled && (
            <p role="status" className="rounded-xl border border-stone-200 p-3 text-stone-700">
              {finishedFiles.length > 0
                ? `已停止 ZIP 导出。已发起下载的 ${finishedFiles.length} 个压缩包可继续使用。`
                : '已停止 ZIP 导出，未生成压缩包。'}
            </p>
          )}
          {finishedFiles.length > 0 && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 space-y-2 text-sm text-emerald-950">
              <div className="flex items-center space-x-2 font-medium">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span>已发起下载 {finishedFiles.length} 个压缩包。</span>
              </div>
              <ul className="space-y-1.5 text-stone-700">
                {finishedFiles.map((file) => (
                  <li key={file.filename} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {file.filename} · {file.postCount} 篇 · {file.assetsCount} 张图 · {file.status === 'complete' ? '完整' : '有未归档项'}
                    </span>
                    {file.downloadUrl ? (
                      <a
                        href={file.downloadUrl}
                        download={file.filename}
                        className="inline-flex items-center gap-1 font-medium text-emerald-800 hover:underline"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>再次下载</span>
                      </a>
                    ) : (
                      <span className="text-stone-500">已开始下载</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-t border-slate-200 bg-slate-50 flex justify-between items-center">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-medium rounded-lg transition-colors"
          >
            {finishedFiles.length > 0 || directFolderResult ? '完成' : '取消'}
          </button>

          {isExporting && exportMethod === 'zip' && (
            <button type="button" onClick={() => zipAbort.current?.abort()}
              className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm text-stone-800">
              停止 ZIP 导出
            </button>
          )}
          {!isExporting && !directFolderResult && finishedFiles.length === 0 && (
            exportMethod === 'folder' ? (
              <button
                onClick={handleDirectFolderExport}
                disabled={busy || !folder || countToExport === 0}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-700 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                <FolderDown className="w-4 h-4" />
                <span>发布快照（{countToExport} 篇）</span>
              </button>
            ) : (
              <button
                onClick={handleStartExport}
                disabled={isExporting || countToExport === 0}
                className="flex items-center gap-1.5 rounded-lg bg-stone-900 px-5 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
              >
                <Download className="w-4 h-4" />
                <span>{batchCount > 1 ? `分 ${batchCount} 批导出` : `导出 ${countToExport} 篇`}</span>
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
};
