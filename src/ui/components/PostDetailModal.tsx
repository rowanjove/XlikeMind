import { useDialogFocus } from './useDialogFocus';
import { hasArchivedMedia } from '../../domain/media';
import React, { useEffect, useRef, useState } from 'react';
import type { NormalizedPost, MediaAsset, UserOverrides, ReadingStatus, AIAnalysis, AIConfig } from '../../domain/types';
import type { RawCapturedItem } from '../../adapters/types';
import { DEFAULT_TOPICS } from '../../domain/types';
import { describePostSources } from '../../domain/sources';
import { buildUserOverrides } from '../../domain/overrides';
import { AI_FAILURE_LABELS, analysisFailureCode, analysisStatus, currentAnalysis, sourceGroundedLinks } from '../../domain/analysis';
import { getCaptureNotices, POST_REFERENCE_LABELS } from '../../domain/postReferences';
import {
  X,
  ExternalLink,
  Image as ImageIcon,
  Save,
  Sparkles,
  RefreshCw,
  AlertTriangle,
  AlertCircle,
  Loader2,
  CheckCircle2,
  FileEdit,
  ZoomIn,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { db } from '../../storage/db';
import { aiService, describeAITransfer, isCachedAnalysis } from '../../ai/aiService';
import { requestApiAccess } from '../../ai/permissions';
import { safeImageSrc } from '../../domain/sanitize';
import { retryPostMedia } from '../../sync/retryMedia';
import { syncService } from '../../sync/syncService';
import { SafeExternalLink } from './SafeExternalLink';

const DEFAULT_TOPIC_SET = new Set<string>(DEFAULT_TOPICS);

interface PostDetailModalProps {
  post: NormalizedPost | null;
  onClose: () => void;
  onPostUpdated?: (updated: NormalizedPost) => void;
}

export const PostDetailModal: React.FC<PostDetailModalProps> = ({ post, onClose, onPostUpdated }) => {
  const [currentPost, setCurrentPost] = useState<NormalizedPost | null>(post);
  const [mediaList, setMediaList] = useState<MediaAsset[]>([]);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [unreadableMedia, setUnreadableMedia] = useState<Set<string>>(() => new Set());
  const [overrides, setOverrides] = useState<UserOverrides | null>();
  const [analysis, setAi] = useState<AIAnalysis | null>(null);
  const ai = currentPost ? currentAnalysis(currentPost, analysis ?? undefined) : undefined;
  const aiLinks = currentPost ? sourceGroundedLinks(currentPost, ai?.usefulLinks) : [];
  const stale = currentPost && analysisStatus(currentPost, analysis ?? undefined) === 'stale';
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null);

  const [customTitle, setCustomTitle] = useState('');
  const [customTags, setCustomTags] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [extraCategories, setExtraCategories] = useState('');
  const [notes, setNotes] = useState('');
  const [readingStatus, setReadingStatus] = useState<ReadingStatus>('to_read');
  const [retryingMedia, setRetryingMedia] = useState(false);
  const [mediaNote, setMediaNote] = useState('');

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState('');

  // New states for Subpage Note Editing, Image Lightbox, and Reloading Post
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesError, setNotesError] = useState('');
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const previewOpen = previewIndex !== null || Boolean(previewImageUrl);
  const detailRef = useDialogFocus(Boolean(currentPost), onClose, !isEditingNotes && !previewOpen);
  const notesRef = useDialogFocus(isEditingNotes, () => setIsEditingNotes(false), !previewOpen);
  const previewRef = useDialogFocus(previewOpen, () => { setPreviewIndex(null); setPreviewImageUrl(null); });
  const [isReloadingPost, setIsReloadingPost] = useState(false);
  const [reloadNote, setReloadNote] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const blobUrls = useRef<string[]>([]);

  const loadAiAnalysis = (postId: string) => {
    db.aiAnalysis.get(postId).then((res) => {
      setAi(res || null);
    });
  };

  const showAssets = (assets: MediaAsset[]) => {
    setUnreadableMedia(new Set());
    for (const url of blobUrls.current) URL.revokeObjectURL(url);
    blobUrls.current = [];
    const urlMap: Record<string, string> = {};
    for (const asset of assets) {
      if (hasArchivedMedia(asset)) {
        const blobUrl = URL.createObjectURL(asset.blob);
        blobUrls.current.push(blobUrl);
        urlMap[asset.id] = blobUrl;
      } else {
        const remote = safeImageSrc(asset.sourceUrl);
        if (remote) urlMap[asset.id] = remote;
      }
    }
    setMediaList(assets);
    setMediaUrls(urlMap);
  };

  function loadOverrideDraft(override: UserOverrides | null) {
    const categories = override?.customCategories ?? [];
    setOverrides(override);
    setCustomTitle(override?.customTitle ?? '');
    setCustomTags((override?.customTags ?? []).join(', '));
    setSelectedCategories(categories.filter((name) => DEFAULT_TOPIC_SET.has(name)));
    setExtraCategories(categories.filter((name) => !DEFAULT_TOPIC_SET.has(name)).join(', '));
    setNotes(override?.notes ?? '');
    setReadingStatus(override?.readingStatus ?? 'to_read');
  }

  useEffect(() => {
    let active = true;
    setAiConfig(null);
    if (post?.id) void aiService.getConfig().then((config) => {
      if (active) setAiConfig(config);
    });
    return () => { active = false; };
  }, [post?.id]);

  useEffect(() => {
    setCurrentPost(post);
    setOverrides(undefined);
    setNotesError('');
    setAiNote('');
    setReloadNote(null);
    setIsEditingNotes(false);
    setPreviewImageUrl(null);
    setPreviewIndex(null);
    if (!post) return;

    let active = true;
    db.media.where('postId').equals(post.id).sortBy('position').then((assets) => {
      if (active) showAssets(assets);
    });

    db.userOverrides.get(post.id).then((ov) => {
      if (active) loadOverrideDraft(ov ?? null);
    });

    loadAiAnalysis(post.id);
    setMediaNote('');

    return () => {
      active = false;
      for (const url of blobUrls.current) URL.revokeObjectURL(url);
      blobUrls.current = [];
    };
  }, [post]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'ArrowLeft' && previewIndex !== null && mediaList.length > 1) {
        setPreviewIndex((idx) => (idx !== null && idx > 0 ? idx - 1 : mediaList.length - 1));
      } else if (e.key === 'ArrowRight' && previewIndex !== null && mediaList.length > 1) {
        setPreviewIndex((idx) => (idx !== null && idx < mediaList.length - 1 ? idx + 1 : 0));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewIndex, previewImageUrl, isEditingNotes, mediaList.length, onClose]);

  if (!currentPost) return null;

  const handleSaveOverrides = async () => {
    if (overrides === undefined || savingNotes) return;
    setSavingNotes(true);
    setNotesError('');
    const updated = buildUserOverrides({
      postId: currentPost.id,
      customTitle,
      customTags,
      categories: [...selectedCategories, ...extraCategories.split(/[,，]/)],
      notes,
      readingStatus,
    });

    const categories = overrides?.customCategories ?? [];
    const baseline = buildUserOverrides({
      postId: currentPost.id,
      customTitle: overrides?.customTitle ?? '',
      customTags: (overrides?.customTags ?? []).join(', '),
      categories: [...categories.filter((name) => DEFAULT_TOPIC_SET.has(name)),
        ...categories.filter((name) => !DEFAULT_TOPIC_SET.has(name)).join(', ').split(/[,，]/)],
      notes: overrides?.notes ?? '',
      readingStatus: overrides?.readingStatus ?? 'to_read',
    });
    const fields = ['customTitle', 'customTags', 'customCategories', 'notes', 'readingStatus'] as const;
    const changed = fields.filter((field) => JSON.stringify(updated[field]) !== JSON.stringify(baseline[field]));
    try {
      const saved = await db.transaction('rw', db.posts, db.userOverrides, async () => {
        if (!await db.posts.get(currentPost.id)) throw new Error('帖子已删除');
        const latest = await db.userOverrides.get(currentPost.id);
        if (!changed.length) return latest ?? null;
        const patch = Object.fromEntries(changed.map((field) => [field, updated[field]]));
        const merged = { ...latest, ...patch, postId: currentPost.id, updatedAt: updated.updatedAt };
        await db.userOverrides.put(merged);
        return merged;
      });
      loadOverrideDraft(saved);
      setIsEditingNotes(false);
    } catch {
      setNotesError('无法保存笔记，请确认帖子仍在文库后重试。');
    } finally {
      setSavingNotes(false);
    }
  };

  const handleRetryMedia = async () => {
    setRetryingMedia(true);
    setMediaNote('');
    try {
      const result = await retryPostMedia(db, currentPost.id, { unreadableIds: unreadableMedia });
      showAssets(result.assets);
      setMediaNote(
        result.tried === 0
          ? '图片都已经保存。'
          : `重试 ${result.tried} 张，新保存 ${result.downloaded} 张，仍失败 ${result.failed} 张。`
      );
    } catch (err) {
      setMediaNote(err instanceof Error ? err.message : String(err));
    } finally {
      setRetryingMedia(false);
    }
  };

  const toggleCategory = (name: string) => {
    setSelectedCategories((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name]
    );
  };

  const handleTriggerAI = async () => {
    const loaded = aiConfig;
    if (!loaded || isAnalyzing) return;
    if (ai?.postId === currentPost.id && (loaded.useMock || !loaded.allowSendImages) &&
      isCachedAnalysis(ai, currentPost.contentHash, loaded)) {
      setAiError(null);
      setAiNote('已使用现有摘要。');
      return;
    }
    setIsAnalyzing(true);
    setAiError(null);
    setAiNote('');
    try {
      if (!loaded.useMock) {
        const gate = await requestApiAccess(loaded.baseUrl);
        if (!gate.ok) {
          setAiError(gate.message);
          return;
        }
        if (!window.confirm(`整理这篇帖子。\n${describeAITransfer(loaded)}\n确定继续？`)) return;
      }
      const res = await aiService.analyzePost(currentPost.id, { config: loaded });
      if (ai && res.status === 'complete' && res.updatedAt === ai.updatedAt &&
        res.model === ai.model && res.imageInputKey === ai.imageInputKey) {
        setAiNote('已使用现有摘要。');
      }
      setAi(res);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
      loadAiAnalysis(currentPost.id);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleReloadPost = async () => {
    if (!currentPost) return;
    setIsReloadingPost(true);
    setReloadNote(null);
    try {
      const rawPostId = currentPost.postId || currentPost.id.replace(/^x:/, '');
      let response: { success: boolean; item?: RawCapturedItem; error?: string } | null = null;

      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
        try {
          const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTabs.length > 0 && typeof activeTabs[0].id === 'number') {
            response = (await chrome.tabs.sendMessage(activeTabs[0].id, {
              type: 'RELOAD_SINGLE_POST',
              postId: rawPostId,
            })) as { success: boolean; item?: RawCapturedItem; error?: string } | null;
          }
        } catch {
          // ignore
        }

        if (!response || !response.success) {
          try {
            const xTabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
            for (const tab of xTabs) {
              if (typeof tab.id === 'number') {
                try {
                  const res = (await chrome.tabs.sendMessage(tab.id, {
                    type: 'RELOAD_SINGLE_POST',
                    postId: rawPostId,
                  })) as { success: boolean; item?: RawCapturedItem; error?: string } | null;
                  if (res && res.success) {
                    response = res;
                    break;
                  }
                } catch {
                  // ignore
                }
              }
            }
          } catch {
            // ignore
          }
        }
      }

      if (response && response.success && response.item) {
        if (response.item.postId !== rawPostId) {
          throw new Error('页面返回了其他帖子，已保留当前记录。');
        }
        const merged = await syncService.refreshPost(response.item);

        setCurrentPost(merged);
        onPostUpdated?.(merged);

        const updatedAssets = await db.media.where('postId').equals(merged.id).sortBy('position');
        showAssets(updatedAssets);
        setReloadNote({
          type: 'success',
          message: `原文已更新（最新正文共 ${merged.text.length} 字）`,
        });
      } else {
        const errMsg =
          response?.error ||
          '未在已打开的 X 标签页中找到该博文。请先点击右上角「访问原帖」在标签页打开它，再点击重新载入。';
        setReloadNote({ type: 'error', message: errMsg });
      }
    } catch (err) {
      setReloadNote({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsReloadingPost(false);
    }
  };

  const authorName = currentPost.author?.displayName || '未知作者';
  const authorHandle = currentPost.author?.handle ? `@${currentPost.author.handle}` : '';

  const hasNotes = Boolean(
    customTitle || notes || selectedCategories.length > 0 || extraCategories.trim() || customTags.trim()
  );

  return (
    <div ref={detailRef} role="dialog" aria-modal="true" aria-label="帖子详情" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-stone-900/40 p-4">
      <div className="bg-white rounded-3xl max-w-3xl w-full max-h-[90vh] shadow-2xl flex flex-col overflow-hidden border border-slate-200">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
          <div className="flex items-center space-x-3">
            {safeImageSrc(currentPost.author?.avatarUrl) ? (
              <img
                src={safeImageSrc(currentPost.author?.avatarUrl)}
                alt={authorName}
                className="w-10 h-10 rounded-full border border-slate-200 object-cover"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-sky-100 text-sky-700 flex items-center justify-center font-bold">
                {authorName.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <div className="font-semibold text-slate-900">{authorName}</div>
              <div className="text-xs text-slate-500">{authorHandle}</div>
              <div className="text-xs text-slate-600">收录来源 · {describePostSources(currentPost)}</div>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {(!ai || ai.status !== 'complete') && (
              <button
                type="button"
                onClick={handleTriggerAI}
                disabled={isAnalyzing || !aiConfig}
                className="flex items-center space-x-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-xs font-medium rounded-xl shadow-xs transition-colors"
              >
                {isAnalyzing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                <span>{isAnalyzing ? '正在写…' : '写摘要'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setIsEditingNotes(true)}
              className="flex items-center space-x-1 px-3 py-1.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium transition-colors"
            >
              <FileEdit className="w-3.5 h-3.5 text-slate-500" />
              <span>{hasNotes ? '编辑笔记' : '写笔记'}</span>
            </button>

            <SafeExternalLink
              href={currentPost.canonicalUrl}
              className="text-xs text-sky-600 hover:text-sky-800 font-medium flex items-center space-x-1 px-3 py-1.5 rounded-xl border border-sky-200 bg-sky-50"
            >
              <span>访问原帖</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </SafeExternalLink>

            <button
              type="button" aria-label="关闭帖子详情"
              onClick={onClose}
              className="p-1.5 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Content Scroll Area */}
        <div className="p-6 overflow-y-auto space-y-6">
          <p className="text-xs text-stone-600">
            {aiConfig ? describeAITransfer(aiConfig) : '正在读取 AI 设置…'}
          </p>
          {/* AI Analysis Section: Only show full summary card when complete, or show error/stale banner */}
          {(aiError || analysis?.status === 'failed') && (
            <div className="text-xs bg-rose-50 border border-rose-200 text-rose-700 p-3 rounded-2xl flex items-start space-x-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                {analysis?.status === 'failed' && <p className="font-semibold">{AI_FAILURE_LABELS[analysisFailureCode(analysis)]}</p>}
                {aiError && <p>{aiError}</p>}
              </div>
            </div>
          )}

          {stale && (
            <div className="text-xs bg-amber-50 border border-amber-200 text-stone-700 p-3 rounded-2xl flex justify-between items-center">
              <span>原文或整理规则已更新，可以重新整理这篇帖子。</span>
              <button
                type="button"
                onClick={handleTriggerAI}
                disabled={isAnalyzing || !aiConfig}
                className="text-amber-700 hover:text-amber-900 font-medium underline ml-2"
              >
                重写摘要
              </button>
            </div>
          )}

          {ai && ai.status === 'complete' && (
            <div className="border border-amber-200 bg-amber-50/40 rounded-2xl p-5 space-y-3">
              <div className="flex justify-between items-center">
                <div className="flex items-center space-x-2">
                  <Sparkles className="w-4 h-4 text-amber-600" />
                  <h3 className="text-sm font-semibold text-stone-900">AI 摘要</h3>
                </div>

                <button
                  type="button"
                  onClick={handleTriggerAI}
                  disabled={isAnalyzing || !aiConfig}
                  className="flex items-center space-x-1.5 px-3 py-1 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-xs font-medium rounded-xl shadow-xs transition-colors"
                >
                  {isAnalyzing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  <span>{isAnalyzing ? '正在检查…' : '检查更新'}</span>
                </button>
              </div>
              {aiNote && <p role="status" className="text-xs text-stone-600">{aiNote}</p>}

              <div className="space-y-3 pt-1 text-xs">
                {ai.titleZh && (
                  <div>
                    <span className="font-medium text-stone-700">标题 </span>
                    <span className="font-bold text-slate-900 text-sm">{ai.titleZh}</span>
                  </div>
                )}

                {ai.summaryZh && (
                  <div className="bg-white p-3.5 rounded-xl border border-amber-100 text-slate-800 leading-relaxed shadow-2xs">
                    <span className="font-medium text-stone-800">摘要 </span>
                    {ai.summaryZh}
                  </div>
                )}

                <div className="flex flex-wrap gap-2 items-center">
                  <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-lg border border-slate-200">
                    {ai.contentType || '未分类'}
                  </span>
                  <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-lg border border-slate-200">
                    {ai.quality === 'high' ? '值得看' : ai.quality === 'low' ? '可跳过' : '一般'}
                  </span>
                  {ai.categories.map((c, i) => (
                    <span key={i} className="bg-sky-50 text-sky-700 border border-sky-200 px-2 py-0.5 rounded-lg font-medium">
                      {c}
                    </span>
                  ))}
                  {ai.tags.map((t, i) => (
                    <span key={i} className="bg-slate-50 text-slate-600 border border-slate-200 px-2 py-0.5 rounded-lg">
                      #{t}
                    </span>
                  ))}
                </div>

                {ai.steps && ai.steps.length > 0 && (
                  <div>
                    <h4 className="font-semibold text-slate-800 mb-1.5 flex items-center space-x-1">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                      <span>步骤</span>
                    </h4>
                    <ol className="list-decimal list-inside space-y-1 bg-white p-3 rounded-xl border border-slate-200 text-slate-800">
                      {ai.steps.map((step, idx) => (
                        <li key={idx} className="leading-relaxed">
                          {step}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {ai.prerequisites && ai.prerequisites.length > 0 && (
                  <div>
                    <h4 className="mb-1 font-medium text-stone-800">需要先有</h4>
                    <ul className="list-disc list-inside space-y-0.5 text-slate-700">
                      {ai.prerequisites.map((pre, idx) => (
                        <li key={idx}>{pre}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {aiLinks.length > 0 && (
                  <div>
                    <h4 className="mb-1 font-medium text-stone-800">链接</h4>
                    <ul className="space-y-1">
                      {aiLinks.map((link, idx) => (
                        <li key={idx}>
                          <SafeExternalLink
                            href={link}
                            className="text-sky-600 hover:text-sky-800 underline break-all flex items-center space-x-1"
                          >
                            <span>{link}</span>
                            <ExternalLink className="w-3 h-3 flex-shrink-0" />
                          </SafeExternalLink>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {ai.confidenceNote && (
                  <div>
                    <h4 className="mb-1 font-semibold">置信说明</h4>
                    <p className="whitespace-pre-wrap">{ai.confidenceNote}</p>
                  </div>
                )}

                {Boolean(ai.risksAndLimits?.length) && (
                  <div>
                    <h4 className="mb-1 font-semibold">风险与限制</h4>
                    <ul className="list-disc list-inside">
                      {ai.risksAndLimits?.map((item, idx) => <li key={idx}>{item}</li>)}
                    </ul>
                  </div>
                )}

                {ai.uncertainties && ai.uncertainties.length > 0 && (
                  <div className="bg-amber-100/40 p-2.5 rounded-xl border border-amber-200 text-amber-900">
                    <div className="font-semibold flex items-center space-x-1 mb-1">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                      <span>还不确定</span>
                    </div>
                    <ul className="list-disc list-inside space-y-0.5 text-slate-700">
                      {ai.uncertainties.map((unc, idx) => (
                        <li key={idx}>{unc}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* User Overrides / Annotations Display */}
          {hasNotes ? (
            <div className="rounded-2xl border border-stone-200 bg-white p-4 space-y-2.5 shadow-2xs">
              <div className="flex justify-between items-center">
                <div className="flex items-center space-x-2">
                  <h3 className="text-sm font-semibold text-stone-900">我的笔记</h3>
                  {readingStatus && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-stone-100 text-stone-700 border border-stone-200">
                      {readingStatus === 'to_read' ? '待读' : readingStatus === 'to_practice' ? '待做' : readingStatus === 'practiced' ? '做过' : '忽略'}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setIsEditingNotes(true)}
                  className="inline-flex items-center gap-1 text-xs text-sky-600 hover:text-sky-800 font-medium px-2 py-1 rounded-lg hover:bg-sky-50 transition-colors"
                >
                  <FileEdit className="w-3.5 h-3.5" />
                  <span>编辑笔记</span>
                </button>
              </div>

              {customTitle && (
                <div className="text-xs font-medium text-slate-900">
                  <span className="text-stone-500 font-normal">标题：</span>{customTitle}
                </div>
              )}

              {(selectedCategories.length > 0 || extraCategories.trim()) && (
                <div className="flex flex-wrap gap-1.5 items-center">
                  <span className="text-stone-500 text-xs">分类：</span>
                  {selectedCategories.map((c) => (
                    <span key={c} className="rounded-full border border-stone-900 bg-stone-900 text-white px-2.5 py-0.5 text-xs">
                      {c}
                    </span>
                  ))}
                  {extraCategories.split(/[,，]/).map((c) => c.trim()).filter(Boolean).map((c) => (
                    <span key={c} className="rounded-full border border-stone-300 bg-stone-50 text-stone-700 px-2.5 py-0.5 text-xs">
                      {c}
                    </span>
                  ))}
                </div>
              )}

              {customTags.trim() && (
                <div className="flex flex-wrap gap-1.5 items-center text-xs">
                  <span className="text-stone-500">标签：</span>
                  {customTags.split(/[,，]/).map((t) => t.trim()).filter(Boolean).map((t) => (
                    <span key={t} className="text-slate-600 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-md">
                      #{t}
                    </span>
                  ))}
                </div>
              )}

              {notes && (
                <div className="mt-1 bg-stone-50 p-3 rounded-xl border border-stone-200/80 text-xs text-slate-800 whitespace-pre-wrap leading-relaxed">
                  {notes}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-2xl border border-dashed border-stone-200 bg-stone-50/50 px-4 py-3 text-xs text-stone-500">
              <span>暂无个人笔记与分类标注</span>
              <button
                type="button"
                onClick={() => setIsEditingNotes(true)}
                className="inline-flex items-center gap-1 font-medium text-sky-600 hover:text-sky-800 transition-colors"
              >
                <FileEdit className="w-3.5 h-3.5" />
                <span>添加笔记</span>
              </button>
            </div>
          )}

          {/* Post Text */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-stone-900">原文</h3>
              <button
                type="button"
                onClick={handleReloadPost}
                disabled={isReloadingPost}
                title="若推文抓取不全或被截断，可从打开的 X 网页重新载入完整原文"
                className="inline-flex items-center gap-1.5 rounded-xl border border-stone-300 bg-white px-3 py-1 text-xs text-stone-700 hover:bg-stone-50 hover:text-stone-900 disabled:opacity-50 transition-colors shadow-2xs"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isReloadingPost ? 'animate-spin' : ''}`} />
                <span>{isReloadingPost ? '正在载入…' : '重新载入原文'}</span>
              </button>
            </div>

            {reloadNote && (
              <div
                className={`text-xs p-3 rounded-2xl border flex items-center justify-between ${
                  reloadNote.type === 'success'
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                    : 'bg-rose-50 text-rose-800 border-rose-200'
                }`}
              >
                <span>{reloadNote.message}</span>
                <button
                  type="button"
                  onClick={() => setReloadNote(null)}
                  className="text-stone-400 hover:text-stone-700 ml-2"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-slate-900 text-sm leading-relaxed whitespace-pre-wrap break-words font-sans">
              {currentPost.text || <span className="text-slate-400 italic">（此帖子未包含文本）</span>}
            </div>
          </div>

          {/* Media Assets */}
          {mediaList.length > 0 && (
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-stone-900 flex items-center space-x-1.5">
                  <ImageIcon className="w-3.5 h-3.5" />
                  <span>图片 {mediaList.length}</span>
                </h3>
                <button
                  type="button"
                  onClick={handleRetryMedia}
                  disabled={retryingMedia}
                  className="inline-flex items-center gap-1 rounded-xl border border-stone-300 bg-white px-2.5 py-1 text-xs text-stone-800 hover:bg-stone-50 disabled:opacity-50 shadow-2xs transition-colors"
                >
                  {retryingMedia ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  <span>{retryingMedia ? '正在重试…' : '重新下载图片'}</span>
                </button>
              </div>
              {mediaNote ? <p className="mb-2 text-xs text-stone-600">{mediaNote}</p> : null}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {mediaList.map((m, idx) => (
                  <div
                    key={m.id}
                    className="border border-slate-200 rounded-2xl overflow-hidden bg-slate-50 flex flex-col group shadow-2xs"
                  >
                    <div
                      onClick={() => {
                        if (unreadableMedia.has(m.id)) return;
                        const url = mediaUrls[m.id] || m.sourceUrl;
                        if (url) {
                          setPreviewIndex(idx);
                          setPreviewImageUrl(url);
                        }
                      }}
                      className="relative h-48 overflow-hidden bg-slate-100 flex items-center justify-center cursor-zoom-in"
                      title="点击放大查看图片"
                    >
                      {unreadableMedia.has(m.id) ? (
                        <span className="px-3 text-xs text-rose-700">本地图片打不开，可重新下载。</span>
                      ) : mediaUrls[m.id] ? (
                        <>
                          <img
                            src={mediaUrls[m.id]}
                            alt={m.altText || `图片 ${idx + 1}`}
                            onError={(event) => {
                              if (blobUrls.current.includes(event.currentTarget.src)) {
                                setUnreadableMedia((ids) => new Set(ids).add(m.id));
                              }
                            }}
                            className="w-full h-full object-contain transition-transform duration-200 group-hover:scale-[1.02]"
                          />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                            <span className="bg-stone-900/75 text-white text-[11px] px-2.5 py-1 rounded-full flex items-center gap-1 shadow-md">
                              <ZoomIn className="w-3 h-3" /> 点击放大
                            </span>
                          </div>
                        </>
                      ) : (
                        <span className="text-xs text-slate-400">正在加载预览...</span>
                      )}
                    </div>
                    <div className="p-2.5 text-xs flex justify-between items-center border-t border-slate-200 bg-white">
                      <span className="text-slate-500 font-mono">图 #{idx + 1}</span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${
                          hasArchivedMedia(m) && !unreadableMedia.has(m.id)
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : m.status === 'remote_only'
                              ? 'bg-stone-100 text-stone-600 border border-stone-200'
                              : 'bg-rose-50 text-rose-700 border border-rose-200'
                        }`}
                      >
                        {unreadableMedia.has(m.id) ? '无法预览' : hasArchivedMedia(m)
                          ? '已保存'
                          : m.status === 'remote_only'
                            ? '未下载，导出时用原链接'
                            : `没下下来：${m.failureReason || '未下载'}`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {getCaptureNotices(currentPost.missingFields).map((notice) => (
            <p key={notice} className="text-sm text-stone-600">{notice}</p>
          ))}

          {Boolean(currentPost.references?.length) && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-stone-900">关联原文</h3>
              <ul className="space-y-1.5">
                {currentPost.references?.map((reference) => (
                  <li key={`${reference.kind}:${reference.id}`}>
                    <SafeExternalLink href={reference.url} className="text-sm text-sky-700 underline">
                      {POST_REFERENCE_LABELS[reference.kind]}
                    </SafeExternalLink>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* External Links */}
          {currentPost.externalLinks.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-stone-900">链接 {currentPost.externalLinks.length}</h3>
              <ul className="space-y-1.5">
                {currentPost.externalLinks.map((link, idx) => (
                  <li key={idx}>
                    <SafeExternalLink
                      href={link}
                      className="text-xs text-sky-600 hover:text-sky-800 underline break-all flex items-center space-x-1"
                    >
                      <span>{link}</span>
                      <ExternalLink className="w-3 h-3 flex-shrink-0" />
                    </SafeExternalLink>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Metadata Grid */}
          <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200 text-xs">
            <h3 className="mb-3 font-semibold text-stone-800">记录</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-4">
              <div>
                <span className="text-slate-500">编号</span>{' '}
                <span className="font-mono text-slate-800">{currentPost.id}</span>
              </div>
              <div>
                <span className="text-slate-500">来源</span>{' '}
                <span className="font-mono text-slate-800">{currentPost.sourceAdapter}</span>
              </div>
              <div>
                <span className="text-slate-500">发帖</span>{' '}
                <span className="text-slate-800">{currentPost.postedAt || '未知'}</span>
              </div>
              <div>
                <span className="text-slate-500">点赞时间</span>{' '}
                <span className="text-slate-800">{currentPost.likedAt || '未知'}</span>
              </div>
              <div>
                <span className="text-slate-500">第一次看到</span>{' '}
                <span className="text-slate-800">{currentPost.firstObservedAt}</span>
              </div>
              <div>
                <span className="text-slate-500">最近看到</span>{' '}
                <span className="text-slate-800">{currentPost.lastObservedAt}</span>
              </div>
              <div className="sm:col-span-2">
                <span className="text-slate-500">内容指纹</span>{' '}
                <span className="font-mono text-slate-600 break-all">{currentPost.contentHash}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-slate-200 bg-slate-50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-medium rounded-xl transition-colors"
          >
            关闭
          </button>
        </div>
      </div>

      {/* Subpage Modal: Edit Notes */}
      {isEditingNotes && (
        <div ref={notesRef} role="dialog" aria-modal="true" aria-label="编辑笔记与标注" tabIndex={-1}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-stone-900/50 backdrop-blur-xs p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsEditingNotes(false);
          }}
        >
          <div className="bg-white rounded-3xl max-w-xl w-full max-h-[88vh] shadow-2xl flex flex-col overflow-hidden border border-slate-200 animate-in fade-in zoom-in-95 duration-150">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
              <div className="flex items-center space-x-2">
                <FileEdit className="w-4 h-4 text-sky-600" />
                <h3 className="font-semibold text-slate-900 text-sm">编辑笔记与标注</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsEditingNotes(false)}
                className="p-1.5 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4 text-xs">
              <p className="text-stone-500 text-xs">
                改过的标题、分类和标签会留下来，下一次同步或重新整理不会被覆盖。
              </p>

              <div>
                <label className="mb-1 block font-medium text-stone-700">标题</label>
                <input
                  type="text"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder="给这篇推文起个便于检索的标题"
                  className="w-full text-xs px-3 py-2.5 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-sky-500 bg-white"
                />
              </div>

              <div>
                <span className="mb-1.5 block font-medium text-stone-700">分类（可多选）</span>
                <div className="flex flex-wrap gap-1.5">
                  {DEFAULT_TOPICS.map((topic) => {
                    const selected = selectedCategories.includes(topic);
                    return (
                      <button
                        key={topic}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleCategory(topic)}
                        className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                          selected
                            ? 'border-stone-900 bg-stone-900 text-white'
                            : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
                        }`}
                      >
                        {topic}
                      </button>
                    );
                  })}
                </div>
                {selectedCategories.length === 0 && extraCategories.trim() === '' && ai?.categories?.length ? (
                  <p className="mt-2 text-[11px] text-stone-500">
                    整理建议：{ai.categories.join('、')}。点选并保存后生效。
                  </p>
                ) : null}
              </div>

              <div>
                <label className="mb-1 block font-medium text-stone-700" htmlFor="modal-extra-categories">
                  其他自定义分类（用逗号分开）
                </label>
                <input
                  id="modal-extra-categories"
                  type="text"
                  value={extraCategories}
                  onChange={(e) => setExtraCategories(e.target.value)}
                  placeholder="例如：投资, 读书"
                  className="w-full text-xs px-3 py-2.5 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-sky-500 bg-white"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block font-medium text-stone-700">标签（用逗号分开）</label>
                  <input
                    type="text"
                    value={customTags}
                    onChange={(e) => setCustomTags(e.target.value)}
                    placeholder="前端, Vite, 工具..."
                    className="w-full text-xs px-3 py-2.5 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-sky-500 bg-white"
                  />
                </div>

                <div>
                  <label className="mb-1 block font-medium text-stone-700">阅读状态</label>
                  <select
                    value={readingStatus}
                    onChange={(e) => setReadingStatus(e.target.value as ReadingStatus)}
                    className="w-full text-xs px-3 py-2.5 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-sky-500 bg-white"
                  >
                    <option value="to_read">待读</option>
                    <option value="to_practice">待做</option>
                    <option value="practiced">做过</option>
                    <option value="ignored">忽略</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="mb-1 block font-medium text-stone-700">笔记</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={4}
                  placeholder="写下你的想法、要点或总结..."
                  className="w-full text-xs p-3 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-sky-500 bg-white leading-relaxed"
                />
              </div>
            </div>

            {notesError && <p role="alert" className="px-6 pb-2 text-sm text-rose-700">{notesError}</p>}
            <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsEditingNotes(false)}
                className="px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSaveOverrides}
                disabled={savingNotes || overrides === undefined}
                className="flex items-center gap-1.5 rounded-xl bg-stone-900 px-5 py-2 text-xs font-medium text-white hover:bg-stone-800 transition-colors shadow-xs"
              >
                <Save className="w-3.5 h-3.5" />
                <span>保存笔记</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox Modal: Enlarge Image with Previous/Next Controls */}
      {(previewIndex !== null || previewImageUrl) && (() => {
        const activePreviewUrl =
          (previewIndex !== null && mediaList[previewIndex]
            ? mediaUrls[mediaList[previewIndex].id] || mediaList[previewIndex].sourceUrl
            : null) || previewImageUrl;

        if (!activePreviewUrl) return null;

        return (
          <div ref={previewRef} role="dialog" aria-modal="true" aria-label="图片预览" tabIndex={-1}
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 backdrop-blur-sm p-4 select-none animate-in fade-in duration-150"
            onClick={() => {
              setPreviewIndex(null);
              setPreviewImageUrl(null);
            }}
          >
            <button
              type="button"
              onClick={() => {
                setPreviewIndex(null);
                setPreviewImageUrl(null);
              }}
              className="absolute top-5 right-5 p-2 rounded-full bg-stone-800/80 hover:bg-stone-700 text-white transition-colors shadow-lg cursor-pointer z-10"
              title="关闭预览 (Esc)"
            >
              <X className="w-6 h-6" />
            </button>

            {mediaList.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPreviewIndex((idx) => (idx !== null && idx > 0 ? idx - 1 : mediaList.length - 1));
                  }}
                  className="absolute left-5 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-stone-800/80 hover:bg-stone-700 text-white transition-colors shadow-lg cursor-pointer z-10"
                  title="上一张 (←)"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPreviewIndex((idx) => (idx !== null && idx < mediaList.length - 1 ? idx + 1 : 0));
                  }}
                  className="absolute right-5 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-stone-800/80 hover:bg-stone-700 text-white transition-colors shadow-lg cursor-pointer z-10"
                  title="下一张 (→)"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>

                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-stone-900/80 text-white text-xs font-mono tracking-wider shadow-lg">
                  {(previewIndex ?? 0) + 1} / {mediaList.length}
                </div>
              </>
            )}

            <div
              className="max-w-[92vw] max-h-[90vh] flex items-center justify-center"
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={activePreviewUrl}
                alt="放大图"
                className="max-w-full max-h-[88vh] object-contain rounded-2xl shadow-2xl"
              />
            </div>
          </div>
        );
      })()}
    </div>
  );
};
