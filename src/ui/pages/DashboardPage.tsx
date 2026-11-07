import { hasArchivedMedia } from '../../domain/media';
import React from 'react';
import type { NormalizedPost, SyncRun } from '../../domain/types';
import { MetricCard } from '../components/MetricCard';
import { Database, Image as ImageIcon, Sparkles, RefreshCw, ArrowRight, AlertCircle } from 'lucide-react';
import { PostCard } from '../components/PostCard';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../storage/db';
import { analysisStatus, isPendingAnalysis } from '../../domain/analysis';
import { isShortTextPost } from '../../domain/topics';

interface DashboardPageProps {
  posts: NormalizedPost[];
  latestRun: SyncRun | null;
  onNavigateTab: (tab: 'dashboard' | 'sync' | 'library' | 'settings') => void;
  onViewPostDetails: (post: NormalizedPost) => void;
  onDeletePost: (postId: string) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  posts,
  latestRun,
  onNavigateTab,
  onViewPostDetails,
  onDeletePost,
}) => {
  const recentPosts = posts.slice(0, 4);
  const analyses = useLiveQuery(() => db.aiAnalysis.toArray(), []);
  const imageCounts = useLiveQuery(() => Promise.all(
    (['downloaded', 'failed'] as const).map((status) =>
      db.media.where('status').equals(status).filter((asset) => asset.kind === 'image' && (status === 'failed' || hasArchivedMedia(asset))).count()),
  ), []);
  const [savedImages, failedImages] = imageCounts ?? [0, 0];
  const analysisByPost = new Map(analyses?.map((analysis) => [analysis.postId, analysis]));
  let pendingAI = 0;
  let failedAI = 0;
  for (const post of posts) {
    const status = analysisStatus(post, analysisByPost.get(post.id));
    if (status === 'failed') failedAI++;
    if (isPendingAnalysis(status) && !isShortTextPost(post)) pendingAI++;
  }
  const syncFailures = latestRun?.stats.failed ?? 0;

  return (
    <div className="lm-page space-y-8">
      {/* Page Title */}
      <div className="lm-page-header">
        <div>
          <p className="lm-eyebrow">本地文库</p>
          <h1 className="lm-display mt-2 text-3xl font-semibold text-stone-900">总览</h1>
          <p className="mt-2 text-sm text-stone-600">这里放着你的收录进度，以及最近留下的几篇内容。</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onNavigateTab('library')}
            className="lm-button-primary px-3.5 py-2 text-sm"
          >
            打开文库
          </button>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <MetricCard
          title="帖子"
          value={posts.length}
          subtitle="在这台电脑上"
          icon={Database}
        />

        <MetricCard
          title="已归档图片"
          value={imageCounts ? savedImages : '…'}
          subtitle="已下载到本机"
          icon={ImageIcon}
        />

        <MetricCard
          title="待 AI 分析"
          value={analyses ? pendingAI : '…'}
          subtitle="尚未整理或摘要待更新"
          icon={Sparkles}
        />

        <MetricCard
          title="最近同步"
          value={
            !latestRun
              ? '还没有'
              : latestRun.status === 'completed'
              ? '完成'
              : latestRun.status === 'partial'
              ? '部分'
              : latestRun.status === 'failed'
              ? '失败'
              : latestRun.status === 'running'
              ? '进行中'
              : latestRun.status === 'paused'
              ? '已暂停'
              : latestRun.status === 'cancelled'
              ? '已停'
              : latestRun.status
          }
          subtitle={
            latestRun
              ? `看过 ${latestRun.stats.scanned} · 新的 ${latestRun.stats.added}`
              : '从工具栏或同步页开始'
          }
          icon={RefreshCw}
        />
        <MetricCard
          title="失败项"
          value={analyses && imageCounts ? failedImages + failedAI + syncFailures : '…'}
          subtitle={`图片 ${failedImages} · AI ${failedAI} · 最近同步 ${syncFailures}`}
          icon={AlertCircle}
        />
      </div>

      {/* Recent Posts Section */}
      <div>
        <div className="mb-4 flex items-end justify-between border-b border-[#ddd9cf] pb-2">
          <div>
            <p className="lm-eyebrow">最新收录</p>
            <h2 className="lm-display mt-1 text-xl font-semibold text-stone-900">最近收录</h2>
          </div>
          <button
            onClick={() => onNavigateTab('library')}
            className="flex items-center gap-1 text-sm font-medium text-stone-500 transition-colors hover:text-[#315846]"
          >
            <span>全部</span>
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>

        {recentPosts.length === 0 ? (
          <div className="lm-empty-state px-6 py-12 text-center">
            <h3 className="text-sm font-medium text-stone-800">还没有帖子</h3>
            <p className="mx-auto mt-1 max-w-sm text-sm text-stone-500">在 X 上打开点赞或收藏，用扩展开始读取。</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {recentPosts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                onViewDetails={onViewPostDetails}
                onDelete={onDeletePost}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
