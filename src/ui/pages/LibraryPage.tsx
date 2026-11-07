import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { NormalizedPost, AIAnalysis, UserOverrides, ReadingStatus, SyncRun, AIConfig } from '../../domain/types';
import {
  Search,
  SlidersHorizontal,
  Sparkles,
  Loader2,
  Square,
  CheckSquare,
  X,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  List as ListIcon,
  Download,
  BookOpen,
  Layers3,
  Newspaper,
  ExternalLink,
} from 'lucide-react';
import { PostCard } from '../components/PostCard';
import { PostListItem } from '../components/PostListItem';
import { aiService, describeAITransfer, normalizeAIBatchLimit, type BatchAIProgress } from '../../ai/aiService';
import { getPostSources, SOURCE_LABELS } from '../../domain/sources';
import { LibraryMark } from '../components/BrandMark';
import { requestApiAccess } from '../../ai/permissions';
import { buildTopicSummaries, getPostTopics, isShortTextPost } from '../../domain/topics';
import { buildIncrementalDigest, describeSyncSource } from '../../domain/digests';
import { db } from '../../storage/db';
import { isMissingImage, MEDIA_RETRY_BATCH_LIMIT, retryMissingImages, type ImageRetryProgress } from '../../sync/retryMedia';
import { normalizeXHandle } from '../../adapters/xAccount';
import { AI_FAILURE_LABELS, analysisFailureCode, analysisStatus, currentAnalysis, isPendingAnalysis } from '../../domain/analysis';
import { TopicsPage } from './TopicsPage';
import { SynthesisPanels } from '../components/SynthesisPanels';
import { getPageProfileId } from '../../storage/profiles';

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

export type LibrarySubView = 'posts' | 'topics' | 'digests';
export type DisplayMode = 'grid' | 'list';

interface LibraryPageProps {
  posts: NormalizedPost[];
  syncRuns?: SyncRun[];
  initialSubView?: LibrarySubView;
  initialBatch?: { id: string; repairOnly: boolean; changesOnly?: boolean };
  onViewPostDetails: (post: NormalizedPost) => void;
  onDeletePost: (postId: string) => void;
  onExportFiltered?: (posts: NormalizedPost[]) => void;
  onMediaRetryBusyChange?: (busy: boolean) => void;
}

const VIEW_MODE_STORAGE_KEY = 'likemind_library_view_mode';

export const LibraryPage: React.FC<LibraryPageProps> = ({
  posts,
  syncRuns = [],
  initialSubView = 'posts',
  initialBatch,
  onViewPostDetails,
  onDeletePost,
  onExportFiltered,
  onMediaRetryBusyChange,
}) => {
  const [subView, setSubView] = useState<LibrarySubView>(initialSubView);
  useEffect(() => setSubView(initialSubView), [initialSubView]);

  // Display mode: grid (tile) vs list
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => {
    const saved = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return saved === 'list' || saved === 'grid' ? saved : 'grid';
  });

  const handleSetDisplayMode = (mode: DisplayMode) => {
    setDisplayMode(mode);
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  };

  // Search and Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [topicFilter, setTopicFilter] = useState<string>('all');
  const [authorFilter, setAuthorFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'complete' | 'partial'>('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [mediaFilter, setMediaFilter] = useState<'all' | 'with_media' | 'no_media'>('all');
  const [batchFilter, setBatchFilter] = useState(initialBatch?.id ?? '');
  const [repairOnly, setRepairOnly] = useState(initialBatch?.repairOnly ?? false);
  const [imageRetry, setImageRetry] = useState<ImageRetryProgress | null>(null);
  const [imageRetryState, setImageRetryState] = useState<'idle' | 'running' | 'completed' | 'stopped' | 'error'>('idle');
  const imageRetryController = useRef<AbortController | null>(null);
  useEffect(() => () => imageRetryController.current?.abort(), []);
  useEffect(() => {
    onMediaRetryBusyChange?.(imageRetryState === 'running');
    return () => onMediaRetryBusyChange?.(false);
  }, [imageRetryState, onMediaRetryBusyChange]);
  const repairMedia = useLiveQuery(async () => {
    if (!repairOnly) return null;
    const knownIds = new Set<string>();
    const missingPostIds = new Set<string>();
    const retryablePostIds = new Set<string>();
    await db.media.each((asset) => {
      knownIds.add(asset.id);
      if (!isMissingImage(asset)) return;
      missingPostIds.add(asset.postId);
      if (asset.sourceUrl) retryablePostIds.add(asset.postId);
    });
    return { knownIds, missingPostIds, retryablePostIds };
  }, [repairOnly]);
  const [aiFilter, setAiFilter] = useState<
    'all' | 'complete' | 'unprocessed' | 'processing' | 'failed' | keyof typeof AI_FAILURE_LABELS
  >('all');
  const [readingFilter, setReadingFilter] = useState<'all' | ReadingStatus>('all');
  const [sortOrder, setSortOrder] = useState<'observed_desc' | 'posted_desc'>('observed_desc');

  const [selectedRunId, setSelectedRunId] = useState<string>('');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = displayMode === 'list' ? 30 : 18;

  // Selected posts for batch operations
  const [selection, setSelectedIds] = useState<Set<string>>(new Set());

  // Batch AI progress state
  const [aiProgress, setAiProgress] = useState<BatchAIProgress | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [readingError, setReadingError] = useState('');
  const [aiAbortController, setAiAbortController] = useState<AbortController | null>(null);
  const batchInFlight = useRef(false);
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null);
  const [metadataAttempt, setMetadataAttempt] = useState(0);
  const metadata = useLiveQuery(async () => {
    try {
      const [analyses, overrides] = await Promise.all([db.aiAnalysis.toArray(), db.userOverrides.toArray()]);
      return { failed: false, analyses, overrides };
    } catch {
      return { failed: true, analyses: [], overrides: [] };
    }
  }, [metadataAttempt]);
  const aiRows = metadata?.analyses;
  const overrideRows = metadata?.overrides ?? [];
  const aiMap = useMemo(() => {
    const map: Record<string, AIAnalysis> = {};
    for (const item of aiRows ?? []) map[item.postId] = item;
    return map;
  }, [aiRows]);

  useEffect(() => {
    let active = true;
    void aiService.getConfig().then((config) => {
      if (active) setAiConfig(config);
    }).catch(() => {
      if (active) setAiConfig(null);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const recover = () => {
      void aiService.recoverInterruptedAnalyses().catch(() => undefined);
    };
    recover();
    window.addEventListener('focus', recover);
    return () => window.removeEventListener('focus', recover);
  }, []);
  const overridesMap = useMemo(() => {
    const map: Record<string, UserOverrides> = {};
    for (const item of overrideRows) map[item.postId] = item;
    return map;
  }, [overrideRows]);

  const authorIndex = useMemo(() => {
    const byPost = new Map<string, string>();
    const labels = new Map<string, string>();
    for (const post of posts) {
      const handle = normalizeXHandle(post.author?.handle ?? '');
      const authorId = post.author?.id?.trim();
      const key = handle ? `@${handle}` : authorId ? `id:${authorId}` : 'unknown';
      byPost.set(post.id, key);
      if (labels.has(key)) continue;
      const name = post.author?.displayName?.trim();
      labels.set(key, handle ? (name ? `${name} (@${handle})` : key) : authorId ? `${name || '作者 ID'} (${authorId})` : '作者账号未知');
    }
    return { byPost, options: [...labels].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN')) };
  }, [posts]);

  const tagIndex = useMemo(() => {
    const byPost = new Map<string, Set<string>>();
    const labels = new Map<string, string>();
    for (const post of posts) {
      const tags = overridesMap[post.id]?.customTags ?? currentAnalysis(post, aiMap[post.id])?.tags ?? [];
      const keys = new Set<string>();
      for (const tag of tags) {
        const label = tag.trim();
        if (!label) continue;
        const key = label.toLowerCase();
        keys.add(key);
        if (!labels.has(key)) labels.set(key, label);
      }
      if (keys.size) byPost.set(post.id, keys);
    }
    return { byPost, options: [...labels].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN')) };
  }, [posts, overridesMap, aiMap]);

  // Topic summaries
  const topicOverridesMap = useMemo(
    () => new Map(Object.entries(overridesMap)),
    [overridesMap]
  );
  const topicAiMap = useMemo(
    () => new Map(Object.entries(aiMap)),
    [aiMap]
  );

  const topicSummaries = useMemo(() => {
    return buildTopicSummaries(posts, topicOverridesMap, topicAiMap);
  }, [posts, topicOverridesMap, topicAiMap]);

  const batchOptions = useMemo(() => {
    const ids = new Set(posts.map((post) => post.sourceRunId).filter(Boolean));
    if (batchFilter) ids.add(batchFilter);
    const options = syncRuns.filter((run) => ids.delete(run.id)).map((run) => ({
      id: run.id,
      label: `${new Date(run.startedAt).toLocaleString('zh-CN')} · ${describeSyncSource(run)} · ${run.id.slice(-7)}`,
    }));
    return [...options, ...Array.from(ids, (id) => ({ id, label: id }))];
  }, [batchFilter, posts, syncRuns]);

  // Set default selected run
  useEffect(() => {
    if (syncRuns.length > 0 && !selectedRunId) {
      setSelectedRunId(syncRuns[0].id);
    }
  }, [syncRuns, selectedRunId]);

  // Incremental digest for current selected run
  const currentDigest = useMemo(() => {
    if (subView !== 'digests') return null;
    const run = syncRuns.find((r) => r.id === selectedRunId);
    if (!run) return null;
    return buildIncrementalDigest(run, posts, topicOverridesMap, topicAiMap);
  }, [subView, selectedRunId, syncRuns, posts, topicOverridesMap, topicAiMap]);
  const digestPostsById = useMemo(() => new Map(
    currentDigest ? posts.filter((post) => post.sourceRunId === currentDigest.runId).map((post) => [post.id, post]) : [],
  ), [currentDigest, posts]);

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, topicFilter, authorFilter, tagFilter, sourceFilter, statusFilter, mediaFilter, aiFilter, readingFilter, sortOrder, subView, repairOnly, batchFilter]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAllFiltered = () => {
    const next = new Set<string>();
    for (const p of filteredPosts) {
      next.add(p.id);
    }
    setSelectedIds(next);
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  const handleStartBatchAI = async (targetPostIds: string[], failedOnly = false) => {
    if (targetPostIds.length === 0 || batchInFlight.current) return;
    if (!aiConfig) {
      setAiError('AI 设置尚未加载完成，请稍后再试。');
      return;
    }
    const loaded = aiConfig;
    const total = Math.min(targetPostIds.length, normalizeAIBatchLimit(loaded.batchLimit));
    batchInFlight.current = true;
    setAiError(null);
    try {
      if (!loaded.useMock) {
        const gate = await requestApiAccess(loaded.baseUrl);
        if (!gate.ok) {
          setAiError(gate.message);
          return;
        }
        if (!window.confirm(`本次最多整理 ${total} 篇帖子。\n${describeAITransfer(loaded)}\n确定继续？`)) return;
      }
      const controller = new AbortController();
      setAiAbortController(controller);
      setAiProgress({ current: 0, total,
        succeeded: 0, failed: 0, skipped: 0, stage: 'running' });
      await aiService.analyzeBatch(targetPostIds, {
        config: loaded,
        signal: controller.signal,
        failedOnly,
        onProgress: (p) => setAiProgress(p),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAiError(message);
      setAiProgress(null);
    } finally {
      batchInFlight.current = false;
      setAiAbortController(null);
    }
  };

  const handleStopBatchAI = () => {
    if (aiAbortController) {
      aiAbortController.abort();
    }
  };

  const handleBatchSetReadingStatus = async (status: ReadingStatus) => {
    if (selectedIds.size === 0) return;
    setReadingError('');
    const nowIso = new Date().toISOString();
    try {
      await db.transaction('rw', db.posts, db.userOverrides, async () => {
        const ids = await db.posts.where('id').anyOf([...selectedIds]).primaryKeys();
        const existing = await db.userOverrides.bulkGet(ids);
        await db.userOverrides.bulkPut(ids.map((postId, index) => ({
          ...existing[index],
          postId,
          readingStatus: status,
          updatedAt: nowIso,
        })));
      });
      clearSelection();
    } catch {
      setReadingError('批量阅读状态保存失败，请重试。');
    }
  };

  const repairRun = repairOnly && initialBatch?.repairOnly && batchFilter === initialBatch.id
    ? syncRuns.find((run) => run.id === batchFilter)
    : undefined;
  const repairObservedIds = repairRun?.seenPostIds;
  const changesOnly = initialBatch?.changesOnly === true && batchFilter === initialBatch.id;
  const changedPostIds = changesOnly ? syncRuns.find((run) => run.id === batchFilter)?.changedPostIds : undefined;
  const normalizedQuery = normalizeSearchText(searchQuery).trim();
  const searching = normalizedQuery.length > 0;
  const searchIndex = useMemo(() => {
    if (!searching) return new Map<string, string>();
    return new Map(posts.map((post) => {
      const override = overridesMap[post.id];
      const ai = currentAnalysis(post, aiMap[post.id]);
      const topics = getPostTopics(post, override, ai);
      const tags = override?.customTags ?? ai?.tags ?? [];
      const handle = normalizeXHandle(post.author?.handle ?? '');
      const fields = [
        post.text, handle ? `@${handle}` : post.author?.handle, post.author?.displayName,
        post.canonicalUrl, ...post.externalLinks, ...(post.references ?? []).map(({ url }) => url),
        ai?.titleZh, ai?.summaryZh, override?.customTitle, override?.notes, ...tags, ...topics,
      ];
      return [post.id, normalizeSearchText(fields.join('\n'))] as const;
    }));
  }, [searching, posts, aiMap, overridesMap]);

  const filteredPosts = useMemo(() => {
    const observedIds = repairObservedIds && new Set(repairObservedIds);
    const changedIds = new Set(changedPostIds);
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    return posts
      .filter((post) => {
        if (batchFilter && (observedIds ? !observedIds.has(post.postId) : post.sourceRunId !== batchFilter && !changedIds.has(post.id))) return false;
        if (authorFilter && authorIndex.byPost.get(post.id) !== authorFilter) return false;
        if (tagFilter && !tagIndex.byPost.get(post.id)?.has(tagFilter)) return false;
        if (terms.length && !terms.every((term) => searchIndex.get(post.id)?.includes(term))) return false;

        // 2. Topic filter matches every category, not only the first one.
        if (topicFilter !== 'all') {
          const topics = getPostTopics(post, overridesMap[post.id], aiMap[post.id]);
          if (!topics.includes(topicFilter)) {
            return false;
          }
        }

        // 3. Capture status filter
        if (sourceFilter !== 'all') {
          const sources = getPostSources(post);
          if (sourceFilter === 'unknown' ? sources.length > 0 : !sources.some((source) => source === sourceFilter)) {
            return false;
          }
        }
        if (statusFilter !== 'all' && post.captureStatus !== statusFilter) {
          return false;
        }
        if (repairOnly && post.captureStatus === 'complete' && !post.missingFields.includes('media') &&
          !repairMedia?.missingPostIds.has(post.id) &&
          !post.mediaIds.some((id) => repairMedia && !repairMedia.knownIds.has(id))) {
          return false;
        }

        // 4. Media filter
        if (mediaFilter === 'with_media' && post.mediaIds.length === 0) {
          return false;
        }
        if (mediaFilter === 'no_media' && post.mediaIds.length > 0) {
          return false;
        }

        // 5. AI status filter
        if (aiFilter !== 'all') {
          const analysis = aiMap[post.id];
          const status = analysisStatus(post, analysis);
          if (Object.hasOwn(AI_FAILURE_LABELS, aiFilter)) {
            if (status !== 'failed' || analysisFailureCode(analysis) !== aiFilter) return false;
          } else if (aiFilter === 'unprocessed' ? !isPendingAnalysis(status) : status !== aiFilter) return false;
        }

        // 6. Reading status filter
        if (readingFilter !== 'all') {
          const postReadingStatus = overridesMap[post.id]?.readingStatus || 'to_read';
          if (postReadingStatus !== readingFilter) {
            return false;
          }
        }

        return true;
      })
      .sort((a, b) => {
        if (sortOrder === 'posted_desc') {
          const dateA = a.postedAt ? new Date(a.postedAt).getTime() : 0;
          const dateB = b.postedAt ? new Date(b.postedAt).getTime() : 0;
          return dateB - dateA;
        }
        return new Date(b.firstObservedAt).getTime() - new Date(a.firstObservedAt).getTime();
      });
  }, [posts, normalizedQuery, searchIndex, topicFilter, authorFilter, tagFilter, authorIndex, tagIndex, sourceFilter, statusFilter, mediaFilter, aiFilter, readingFilter, sortOrder, aiMap, overridesMap, repairOnly, repairMedia, batchFilter, repairObservedIds, changedPostIds]);

  const selectedIds = useMemo(() => new Set(
    selection.size ? filteredPosts.filter((post) => selection.has(post.id)).map((post) => post.id) : [],
  ), [filteredPosts, selection]);

  const imageRetryPostIds = repairOnly ? filteredPosts.filter((post) =>
    repairMedia?.retryablePostIds.has(post.id) && (!selectedIds.size || selectedIds.has(post.id)),
  ).map((post) => post.id) : [];

  const startImageRetry = async () => {
    if (!imageRetryPostIds.length || imageRetryController.current) return;
    const controller = new AbortController();
    imageRetryController.current = controller;
    setImageRetryState('running');
    setImageRetry(null);
    try {
      await retryMissingImages(db, imageRetryPostIds, {
        signal: controller.signal, onProgress: setImageRetry,
      });
      setImageRetryState(controller.signal.aborted ? 'stopped' : 'completed');
    } catch {
      setImageRetryState('error');
    } finally {
      imageRetryController.current = null;
    }
  };

  // Unanalyzed post IDs in current filtered list
  const unanalyzedIds = useMemo(() => {
    if (!aiRows) return [];
    return filteredPosts
      .filter((p) => !isShortTextPost(p))
      .filter((p) => isPendingAnalysis(analysisStatus(p, aiMap[p.id])))
      .map((p) => p.id);
  }, [filteredPosts, aiMap, aiRows]);
  const failedIds = filteredPosts
    .filter((post) => aiMap[post.id]?.status === 'failed' && (!selectedIds.size || selectedIds.has(post.id)))
    .map((post) => post.id);

  // Paginated slice
  const totalPages = Math.max(1, Math.ceil(filteredPosts.length / pageSize));
  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);
  const paginatedPosts = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredPosts.slice(start, start + pageSize);
  }, [filteredPosts, currentPage, pageSize]);

  const selectClass =
    'lm-control px-2.5 py-1.5 text-sm';
  const extraFilters = [statusFilter, readingFilter, aiFilter, mediaFilter].filter((value) => value !== 'all').length;
  const hasFilters = Boolean(searchQuery || authorFilter || tagFilter || batchFilter || repairOnly ||
    topicFilter !== 'all' || sourceFilter !== 'all' || extraFilters);
  const clearLibraryFilters = () => {
    setSearchQuery('');
    setAuthorFilter('');
    setTagFilter('');
    setSourceFilter('all');
    setStatusFilter('all');
    setReadingFilter('all');
    setAiFilter('all');
    setMediaFilter('all');
    setBatchFilter('');
    setRepairOnly(false);
    setTopicFilter('all');
    clearSelection();
  };

  if (!metadata) {
    return <section role="status" className="lm-panel flex items-center gap-3 p-6 text-sm text-stone-600">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      正在读取文库摘要、标签和笔记…
    </section>;
  }

  if (metadata?.failed) {
    return <section role="alert" className="lm-panel space-y-3 p-6">
      <h1 className="text-lg font-semibold">无法读取文库整理资料</h1>
      <p className="text-sm text-stone-600">摘要、标签或笔记读取失败。请重试后再筛选和整理帖子。</p>
      <button type="button" className="lm-button-quiet px-4 py-2"
        onClick={() => setMetadataAttempt((attempt) => attempt + 1)}>重新读取整理资料</button>
    </section>;
  }

  return (
    <div className="lm-page lm-library space-y-5">
      <header className="lm-library-header">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="lm-library-mark"><LibraryMark className="h-6 w-6" /></div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-slate-950">文库</h1>
              <p className="mt-1 text-sm text-slate-600">本地收藏 · {posts.length.toLocaleString('zh-CN')} 篇帖子</p>
            </div>
          </div>
          <button type="button" className="flex shrink-0 items-center gap-2 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
            onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL(`local-library.html?profile=${encodeURIComponent(getPageProfileId())}`) })}>
            <ExternalLink size={16} aria-hidden="true" />打开本地文库
          </button>
        </div>
        <nav aria-label="文库视图" className="lm-library-nav">
          {([
            ['posts', '全部推文', BookOpen], ['topics', '主题汇总', Layers3], ['digests', '收录简报', Newspaper],
          ] as const).filter(([view]) => view !== 'digests' || syncRuns.length > 0).map(([view, label, Icon]) => (
            <button key={view} type="button" aria-pressed={subView === view} onClick={() => setSubView(view)}>
              <Icon size={16} aria-hidden="true" />{label}
            </button>
          ))}
        </nav>
      </header>

      {subView === 'posts' && (
        <div className="lm-library-workspace">
          <div className="lm-library-search relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#315b81]" aria-hidden="true" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索正文、作者、链接、标签、摘要或笔记…"
              aria-label="搜索文库"
              className="lm-control h-12 w-full pl-11 pr-16 text-sm"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded px-1 text-sm text-slate-600 hover:text-slate-950"
              >
                清空
              </button>
            )}
          </div>

          <aside className="lm-panel lm-library-filters" aria-label="文库筛选">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span>筛选</span>
            </div>

            {/* Topic category filter */}
            <select
              aria-label="主题分类"
              value={topicFilter}
              onChange={(e) => setTopicFilter(e.target.value)}
              className={selectClass}
            >
              <option value="all">主题：全部</option>
              {topicSummaries.map((ts) => (
                <option key={ts.topic} value={ts.topic}>
                  {ts.topic} ({ts.postCount})
                </option>
              ))}
            </select>

            <select
              aria-label="作者"
              value={authorFilter}
              onChange={(e) => { setAuthorFilter(e.target.value); clearSelection(); }}
              className={`${selectClass} max-w-full sm:max-w-56`}
            >
              <option value="">作者：全部</option>
              {authorFilter && !authorIndex.options.some(([key]) => key === authorFilter) &&
                <option value={authorFilter}>{authorFilter}（无匹配）</option>}
              {authorIndex.options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>

            <select
              aria-label="标签"
              value={tagFilter}
              onChange={(e) => { setTagFilter(e.target.value); clearSelection(); }}
              className={`${selectClass} max-w-full sm:max-w-56`}
            >
              <option value="">标签：全部</option>
              {tagFilter && !tagIndex.options.some(([key]) => key === tagFilter) &&
                <option value={tagFilter}>{tagFilter}（无匹配）</option>}
              {tagIndex.options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>

            <select
              aria-label="来源"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className={selectClass}
            >
              <option value="all">来源：全部</option>
              {Object.entries(SOURCE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              <option value="unknown">来源未知</option>
            </select>

            <select
              aria-label={repairObservedIds || changesOnly ? '采集批次' : '首次入库批次'}
              value={batchFilter}
              onChange={(e) => { setBatchFilter(e.target.value); clearSelection(); }}
              className={`${selectClass} max-w-full sm:max-w-72`}
            >
              <option value="">批次：全部</option>
              {batchOptions.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select>

            <details className="lm-library-more">
              <summary>更多筛选{extraFilters > 0 ? ` · ${extraFilters} 项` : ''}</summary>
              <div className="lm-library-more-options">
                <select
                  aria-label="全文"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as 'all' | 'complete' | 'partial')}
                  className={selectClass}
                >
                  <option value="all">全文：全部</option>
                  <option value="complete">全文完整</option>
                  <option value="partial">不全</option>
                </select>

                <select
                  aria-label="阅读状态"
                  value={readingFilter}
                  onChange={(e) => setReadingFilter(e.target.value as 'all' | ReadingStatus)}
                  className={selectClass}
                >
                  <option value="all">状态：全部</option>
                  <option value="to_read">待读</option>
                  <option value="to_practice">待做</option>
                  <option value="practiced">做过</option>
                  <option value="ignored">忽略</option>
                </select>

                <select
                  aria-label="整理状态"
                  value={aiFilter}
                  onChange={(e) => { setAiFilter(e.target.value as typeof aiFilter); clearSelection(); }}
                  className={selectClass}
                >
                  <option value="all">整理：全部</option>
                  <option value="complete">写过摘要</option>
                  <option value="unprocessed">还没整理</option>
                  <option value="processing">整理中</option>
                  <option value="failed">没写成</option>
                  <optgroup label="整理失败原因">
                    {Object.entries(AI_FAILURE_LABELS).map(([code, label]) => (
                      <option key={code} value={code}>{label}</option>
                    ))}
                  </optgroup>
                </select>

                <select
                  aria-label="图片"
                  value={mediaFilter}
                  onChange={(e) => setMediaFilter(e.target.value as 'all' | 'with_media' | 'no_media')}
                  className={selectClass}
                >
                  <option value="all">图片：全部</option>
                  <option value="with_media">有图</option>
                  <option value="no_media">没图</option>
                </select>
              </div>
            </details>

            <button
              type="button"
              aria-pressed={repairOnly}
              onClick={() => { setRepairOnly(!repairOnly); clearSelection(); }}
              className={`${selectClass} ${repairOnly ? 'bg-stone-900 text-white' : ''}`}
            >
              待修复
            </button>
            {hasFilters && (
              <button type="button" onClick={clearLibraryFilters}
                className="rounded-md px-2 py-1.5 text-sm font-medium text-[#24415c] hover:bg-[#e8eff6]">
                清除筛选
              </button>
            )}
          </aside>

          <section className="lm-library-content min-w-0 space-y-3" aria-label="文库结果">
            <div className="lm-library-results">
              <div>
                <h2 className="text-base font-semibold text-stone-900">帖子</h2>
                <p aria-live="polite" className="mt-0.5 text-sm text-stone-600">
                  {filteredPosts.length.toLocaleString('zh-CN')} 篇匹配 · 共 {posts.length.toLocaleString('zh-CN')} 篇
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="排序"
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value as 'observed_desc' | 'posted_desc')}
                  className={selectClass}
                >
                  <option value="observed_desc">最近收录</option>
                  <option value="posted_desc">发帖时间</option>
                </select>
                <div role="group" aria-label="显示方式" className="lm-library-view-switch">
                  <button
                    type="button"
                    onClick={() => handleSetDisplayMode('grid')}
                    className={`flex items-center gap-1 rounded-md px-2.5 py-1 transition-colors ${
                      displayMode === 'grid'
                        ? 'bg-[#e3edf8] font-semibold text-[#214566]'
                        : 'text-stone-600 hover:text-stone-900'
                    }`}
                    aria-pressed={displayMode === 'grid'}
                    title="平铺网格视图"
                  >
                    <LayoutGrid className="h-3.5 w-3.5" />
                    <span>平铺</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetDisplayMode('list')}
                    className={`flex items-center gap-1 rounded-md px-2.5 py-1 transition-colors ${
                      displayMode === 'list'
                        ? 'bg-[#e3edf8] font-semibold text-[#214566]'
                        : 'text-stone-600 hover:text-stone-900'
                    }`}
                    aria-pressed={displayMode === 'list'}
                    title="紧凑列表视图"
                  >
                    <ListIcon className="h-3.5 w-3.5" />
                    <span>列表</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="lm-library-actions" data-selected={selectedIds.size > 0}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={selectedIds.size === filteredPosts.length && filteredPosts.length > 0 ? clearSelection : selectAllFiltered}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-stone-700 hover:bg-stone-100"
                  >
                    {selectedIds.size === filteredPosts.length && filteredPosts.length > 0 ? (
                      <CheckSquare className="h-4 w-4 text-stone-900" />
                    ) : (
                      <Square className="h-4 w-4 text-stone-400" />
                    )}
                    <span>{selectedIds.size > 0 ? `已选 ${selectedIds.size} 篇` : '全选当前筛选'}</span>
                  </button>

                  {selectedIds.size > 0 && (
                    <button
                      type="button"
                      onClick={clearSelection}
                      className="rounded-md p-1 text-stone-500 hover:text-stone-900"
                      aria-label="清除选择"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {onExportFiltered && (
                    <button
                      type="button"
                      disabled={!filteredPosts.length}
                      onClick={() => onExportFiltered(filteredPosts)}
                      className="lm-button-quiet flex items-center gap-1.5 px-3 py-1.5 text-sm disabled:opacity-50"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>导出筛选结果</span>
                    </button>
                  )}
                  {failedIds.length > 0 && (
                    <button type="button" onClick={() => handleStartBatchAI(failedIds, true)}
                      disabled={!aiConfig || aiProgress?.stage === 'running'}
                      className="lm-button-quiet flex items-center gap-1.5 px-3 py-1.5 text-sm disabled:opacity-50">
                      <span>重试{selectedIds.size ? '已选' : '筛选结果中的'}失败项 ({failedIds.length})</span>
                    </button>
                  )}
                  {selectedIds.size > 0 ? (
                    <>
                      <button
                        type="button"
                        onClick={() => handleStartBatchAI(Array.from(selectedIds))}
                        disabled={!aiConfig || Boolean(aiProgress && aiProgress.stage === 'running')}
                        className="lm-button-primary flex items-center gap-1.5 px-3 py-1.5 text-sm disabled:opacity-50"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        <span>整理已选 {selectedIds.size}</span>
                      </button>

                      {([
                        ['to_read', '待读'], ['to_practice', '待做'], ['practiced', '做过'], ['ignored', '忽略'],
                      ] as const).map(([status, label]) => (
                        <button
                          key={status}
                          type="button"
                          onClick={() => handleBatchSetReadingStatus(status)}
                          className="lm-button-quiet px-2.5 py-1.5 text-stone-800"
                        >
                          标为{label}
                        </button>
                      ))}
                    </>
                  ) : (
                    unanalyzedIds.length > 0 && (
                      <button
                        type="button"
                        onClick={() => handleStartBatchAI(unanalyzedIds)}
                        disabled={!aiConfig || Boolean(aiProgress && aiProgress.stage === 'running')}
                        className="lm-button-quiet flex items-center gap-1.5 px-3 py-1.5 text-stone-800 disabled:opacity-50"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        <span>{changesOnly ? '仅整理本批新增或更新' : '整理未分析'} ({unanalyzedIds.length})</span>
                      </button>
                    )
                  )}
                </div>
              </div>
              <p className="mt-2 text-xs text-stone-500">
                {!aiConfig
                  ? '正在读取 AI 设置，设置未加载完成前不会发送内容。'
                  : `每批最多 ${normalizeAIBatchLimit(aiConfig.batchLimit)} 篇。${describeAITransfer(aiConfig)}`}
              </p>
            </div>

            {/* AI Progress */}
            {aiError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">{aiError}</div>
            )}
            {readingError && (
              <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
                {readingError}
              </p>
            )}

            {aiProgress && (
              <div className="lm-panel space-y-2 p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2 text-stone-900">
                  <div className="flex items-center gap-2 font-medium">
                    {aiProgress.stage === 'running' ? (
                      <Loader2 className="h-4 w-4 animate-spin text-stone-600" />
                    ) : (
                      <Sparkles className="h-4 w-4 text-stone-600" />
                    )}
                    <span>
                      {aiProgress.stage === 'running' ? '正在整理' : aiProgress.stage === 'cancelled' ? '已停止整理' : '本批整理结束'} ({aiProgress.current}/{aiProgress.total})
                    </span>
                  </div>
                  {aiProgress.stage === 'running' && (
                    <button
                      type="button"
                      onClick={handleStopBatchAI}
                      className="rounded border border-stone-300 px-2 py-0.5 text-xs text-stone-600 hover:bg-stone-50"
                    >
                      停止
                    </button>
                  )}
                </div>
                <p className="text-stone-600">
                  成功 {aiProgress.succeeded} 篇 · 失败 {aiProgress.failed} 篇 · 跳过 {aiProgress.skipped} 篇
                  {Boolean(aiProgress.deferred) && ` · ${aiProgress.deferred} 篇超出单批上限，留待下一批`}
                </p>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-200">
                  <div
                    className="h-1.5 bg-stone-900 transition-all duration-300"
                    style={{
                      width: `${Math.min(
                        100,
                        aiProgress.total > 0 ? (aiProgress.current / aiProgress.total) * 100 : 0
                      )}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {(repairOnly || imageRetryState !== 'idle') && (
              <div className="lm-panel space-y-2 p-4 text-sm">
                {repairOnly && (
                  <>
                    <p className="font-medium">待修复帖子</p>
                    {!repairMedia && <p className="text-stone-600">正在检查文库图片…</p>}
                    <p className="text-stone-600">
                      有图片地址的帖子可批量重试。正文不完整或没有图片地址时，打开帖子详情后重新载入原文。
                    </p>
                    <button
                      type="button"
                      disabled={imageRetryState === 'running' || !imageRetryPostIds.length}
                      onClick={() => void startImageRetry()}
                      className="rounded-lg border border-stone-300 px-3 py-1.5 disabled:opacity-50"
                    >
                      重试{selectedIds.size ? '选中' : '筛选结果中的'}图片（最多 {MEDIA_RETRY_BATCH_LIMIT} 张）
                    </button>
                  </>
                )}
                {imageRetryState === 'running' && (
                  <button type="button" className="rounded-lg border border-stone-300 px-3 py-1.5"
                    onClick={() => imageRetryController.current?.abort()}>
                    停止图片重试
                  </button>
                )}
                <p role="status" className="text-stone-600">
                  {imageRetryState === 'error' && '无法完成图片重试，请稍后再试。'}
                  {imageRetryState === 'running' && '正在重试。'}
                  {imageRetryState === 'stopped' && '已停止。'}
                  {imageRetryState === 'completed' && '本轮重试完成。'}
                  {imageRetry && `已处理 ${imageRetry.processed}/${imageRetry.total} 张，下载 ${imageRetry.downloaded} 张，失败 ${imageRetry.failed} 张，跳过 ${imageRetry.skipped} 张。`}
                  {imageRetry && imageRetry.remaining > 0 && `另有 ${imageRetry.remaining} 张未纳入本轮，可选中其他帖子重试。`}
                </p>
              </div>
            )}

            {/* Posts List / Grid Display */}
            {filteredPosts.length === 0 ? (
              posts.length === 0 ? (
                <div className="lm-empty-state px-6 py-16 text-center">
                  <BookOpen className="lm-library-empty-icon" size={24} aria-hidden="true" />
                  <h2 className="text-base font-medium text-stone-900">文库还是空的</h2>
                  <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-stone-600">
                    在 X 上打开点赞或收藏，用扩展开始读取。读进来的帖子会留在这台电脑上。
                  </p>
                </div>
              ) : (
                <div className="lm-empty-state px-6 py-16 text-center">
                  <Search className="lm-library-empty-icon" size={24} aria-hidden="true" />
                  <h2 className="text-base font-medium text-stone-900">没有对上的帖子</h2>
                  <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-stone-600">换个词，或放宽筛选条件。</p>
                  <button type="button" onClick={clearLibraryFilters} className="lm-button-quiet mt-4 px-4 py-2 text-sm">查看全部帖子</button>
                </div>
              )
            ) : (
              <>
                {/* Display: Grid (Tiles) */}
                {displayMode === 'grid' && (
                  <div className="lm-library-grid">
                    {paginatedPosts.map((post) => (
                      <PostCard
                        key={post.id}
                        post={post}
                        isSelected={selectedIds.has(post.id)}
                        onToggleSelect={toggleSelect}
                        onViewDetails={onViewPostDetails}
                        onDelete={onDeletePost}
                      />
                    ))}
                  </div>
                )}

                {/* Display: List */}
                {displayMode === 'list' && (
                  <div className="lm-library-list">
                    <div className="lm-library-list-heading" aria-hidden="true">
                      <span>作者</span><span>帖子内容</span><span>操作</span>
                    </div>
                    {paginatedPosts.map((post) => (
                      <PostListItem
                        key={post.id}
                        post={post}
                        isSelected={selectedIds.has(post.id)}
                        onToggleSelect={toggleSelect}
                        onViewDetails={onViewPostDetails}
                        onDelete={onDeletePost}
                      />
                    ))}
                  </div>
                )}

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="lm-panel flex items-center justify-between px-4 py-3 text-sm">
                    <span className="text-stone-600">
                      {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filteredPosts.length)} / {filteredPosts.length}
                    </span>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        aria-label="上一页"
                        onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                        className="rounded-lg border border-stone-300 p-1.5 text-stone-700 hover:bg-stone-50 disabled:opacity-40"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>

                      <span className="px-2 font-medium text-stone-800">
                        {currentPage} / {totalPages}
                      </span>

                      <button
                        type="button"
                        aria-label="下一页"
                        onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                        disabled={currentPage === totalPages}
                        className="rounded-lg border border-stone-300 p-1.5 text-stone-700 hover:bg-stone-50 disabled:opacity-40"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}

      {/* Incremental digests stay available after a sync run. */}
      {subView === 'topics' && (
        <TopicsPage posts={posts} summaries={topicSummaries} aiMap={topicAiMap}
          onOpenTopic={(topic) => {
            clearLibraryFilters();
            setTopicFilter(topic);
            setSubView('posts');
          }}
        />
      )}

      {subView === 'digests' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-stone-500">选择同步批次:</span>
            {syncRuns.map((run) => (
              <button
                key={run.id}
                onClick={() => setSelectedRunId(run.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-mono transition-colors ${
                  selectedRunId === run.id
                    ? 'bg-stone-900 text-white font-medium'
                    : 'border border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
                }`}
              >
                {new Date(run.startedAt).toLocaleDateString('zh-CN')} ({run.stats.added} 篇)
              </button>
            ))}
          </div>

          {currentDigest ? (
            <div className="lm-panel space-y-4 p-6">
              <div className="border-b border-stone-100 pb-3">
                <span className="text-xs font-semibold text-stone-500">增量简报</span>
                <h3 className="text-base font-bold text-stone-900 mt-1">
                  批次 {currentDigest.runId.slice(0, 16)} 概览 (新增 {currentDigest.newPostCount} 篇)
                </h3>
              </div>
              {currentDigest.newPostCount > 0 && (
                <>
                  <p className="text-sm text-stone-600">以下汇总来自本批首次收录的帖子。请对照原帖核实条件和步骤。</p>
                  <SynthesisPanels key={currentDigest.runId} synthesis={currentDigest.synthesis} postsById={digestPostsById} />
                </>
              )}
              <div className="space-y-2 pt-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-stone-500">
                  本批新增推文列表 ({currentDigest.posts.length})
                </h4>
                <div className="space-y-2">
                  {currentDigest.posts.map((p) => {
                    const post = digestPostsById.get(p.postId);
                    if (!post) {
                      return (
                        <div key={p.postId} className="p-3 bg-stone-50 rounded-lg border border-stone-200 text-xs">
                          <div className="font-medium text-stone-900">{p.title}</div>
                          <div className="text-stone-500 mt-0.5">{p.author}</div>
                        </div>
                      );
                    }
                    return displayMode === 'grid' ? (
                      <PostCard key={post.id} post={post} onViewDetails={onViewPostDetails} onDelete={onDeletePost} />
                    ) : (
                      <PostListItem key={post.id} post={post} onViewDetails={onViewPostDetails} onDelete={onDeletePost} />
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="lm-empty-state p-12 text-center text-sm text-stone-500">
              请选择一个有效的同步批次以查看简报。
            </div>
          )}
        </div>
      )}
    </div>
  );
};
