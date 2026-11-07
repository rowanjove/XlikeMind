import { hasArchivedMedia } from '../../domain/media';
import React, { useEffect, useState } from 'react';
import type { NormalizedPost } from '../../domain/types';
import { analysisStatus, currentAnalysis } from '../../domain/analysis';
import { ExternalLink, Image as ImageIcon, Calendar, Clock, Trash2, Eye, Sparkles, AlertCircle, Loader2 } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../storage/db';
import { SafeExternalLink } from './SafeExternalLink';
import { safeImageSrc } from '../../domain/sanitize';
import { getPostTopics } from '../../domain/topics';

interface PostCardProps {
  post: NormalizedPost;
  isSelected?: boolean;
  onToggleSelect?: (postId: string) => void;
  onViewDetails: (post: NormalizedPost) => void;
  onDelete: (postId: string) => void;
}

export const PostCard: React.FC<PostCardProps> = ({
  post,
  isSelected,
  onToggleSelect,
  onViewDetails,
  onDelete,
}) => {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const analysis = useLiveQuery(() => db.aiAnalysis.get(post.id), [post.id]);
  const ai = currentAnalysis(post, analysis);
  const mediaId = post.mediaIds[0];
  const firstMedia = useLiveQuery(() => mediaId ? db.media.get(mediaId) : undefined, [mediaId]);
  const overrides = useLiveQuery(() => db.userOverrides.get(post.id), [post.id]);
  const primaryTopic = getPostTopics(post, overrides, ai || undefined)[0];

  useEffect(() => {
    const objectUrl = firstMedia && hasArchivedMedia(firstMedia) ? URL.createObjectURL(firstMedia.blob) : null;
    setThumbUrl(objectUrl ?? firstMedia?.sourceUrl ?? null);
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [firstMedia]);

  const authorName = post.author?.displayName || '未知作者';
  const authorHandle = post.author?.handle ? `@${post.author.handle}` : '';

  const postedDate = post.postedAt ? new Date(post.postedAt).toLocaleDateString('zh-CN') : '未知时间';
  const observedDate = new Date(post.firstObservedAt).toLocaleDateString('zh-CN');

  return (
    <div
      onClick={() => onViewDetails(post)}
      className={`lm-post-card flex min-w-0 cursor-pointer flex-col justify-between p-4 ${
        isSelected ? 'border-[#315b81] ring-2 ring-[#315b81]/15' : ''
      }`}
    >
      <div>
        {/* Header: Author & Date & Selection */}
        <div className="flex justify-between items-start gap-3">
          <div className="flex items-center space-x-3 min-w-0">
            {onToggleSelect && (
              <input
                type="checkbox"
                aria-label={`选择 ${authorName} 的帖子 ${post.postId}`}
                checked={Boolean(isSelected)}
                onClick={(event) => event.stopPropagation()}
                onChange={() => onToggleSelect(post.id)}
                className="h-4 w-4 cursor-pointer rounded border-stone-300 text-[#315846] focus:ring-[#315846]"
              />
            )}
            {safeImageSrc(post.author?.avatarUrl) ? (
              <img
                src={safeImageSrc(post.author?.avatarUrl)}
                alt={authorName}
                className="h-9 w-9 shrink-0 rounded-full border border-slate-200 object-cover"
              />
            ) : (
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e7eff8] text-sm font-semibold text-[#315b81]">
                {authorName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-stone-900">{authorName}</div>
              <div className="truncate text-xs text-stone-500">{authorHandle}</div>
            </div>
          </div>

          <div className="flex flex-col items-end space-y-1 flex-shrink-0">
            <span
              className={`text-xs px-2 py-0.5 rounded-full border font-medium ${
                post.captureStatus === 'complete'
                  ? 'border-[#cbdccf] bg-[#e6eee8] text-[#315846]'
                  : 'border-[#ead8bc] bg-[#fbf3e6] text-[#8b5b2f]'
              }`}
            >
              {post.captureStatus === 'complete' ? '全文' : '不全'}
            </span>

            {/* AI Status Badge */}
            {ai?.status === 'complete' && (
              <span className="flex items-center space-x-1 rounded-full border border-[#ead8bc] bg-[#fbf3e6] px-2 py-0.5 text-[11px] font-medium text-[#8b5b2f]">
                <Sparkles className="h-3 w-3 text-[#ad7440]" />
                <span>已整理</span>
              </span>
            )}
            {analysis?.status === 'processing' && (
              <span className="flex items-center space-x-1 rounded-full border border-[#d3dfd7] bg-[#eef4ef] px-2 py-0.5 text-[11px] font-medium text-[#315846]">
                <Loader2 className="h-3 w-3 animate-spin text-[#315846]" />
                <span>整理中</span>
              </span>
            )}
            {analysis?.status === 'failed' && (
              <span className="flex items-center space-x-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">
                <AlertCircle className="h-3 w-3 text-rose-500" />
                <span>没写成</span>
              </span>
            )}
            {analysisStatus(post, analysis) === 'stale' && (
              <span className="text-[11px] px-2 py-0.5 rounded-full border bg-stone-100 text-stone-700 border-stone-200 font-medium">
                摘要待更新
              </span>
            )}
          </div>
        </div>

        {/* AI Extracted Title if available */}
        {(overrides?.customTitle || ai?.titleZh) && (
          <h3 className="mt-3 line-clamp-2 text-base font-semibold leading-snug text-[#172e43]">
            {overrides?.customTitle || ai?.titleZh}
          </h3>
        )}

        {/* Text body */}
        <div className="mt-3 line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">
          {post.text || <span className="italic text-stone-400">（无文本内容）</span>}
        </div>

        {/* Thumbnail Preview if any */}
        {thumbUrl && (
          <div className="relative mt-3 flex aspect-[2/1] items-center justify-center overflow-hidden rounded-lg bg-[#e8edf2]">
            <img
              src={thumbUrl}
              alt={firstMedia?.altText || '帖子配图'}
              loading="lazy"
              className="h-full w-full object-cover"
              onError={() => setThumbUrl(null)}
            />
            {post.mediaIds.length > 1 && (
              <span className="absolute bottom-2 right-2 flex items-center space-x-1 rounded-md bg-stone-900/80 px-2 py-0.5 text-xs font-medium text-white">
                <ImageIcon className="w-3 h-3" />
                <span>+{post.mediaIds.length} 张图</span>
              </span>
            )}
          </div>
        )}

        {/* Badges and metadata */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-stone-500">
          <span className="flex items-center space-x-1 rounded border border-[#e5e2d9] bg-[#f5f3ed] px-2 py-1">
            <Calendar className="h-3.5 w-3.5 text-stone-400" />
            <span>发帖 {postedDate}</span>
          </span>

          <span className="flex items-center space-x-1 rounded border border-[#e5e2d9] bg-[#f5f3ed] px-2 py-1">
            <Clock className="h-3.5 w-3.5 text-stone-400" />
            <span>收录 {observedDate}</span>
          </span>

          {post.mediaIds.length > 0 && (
            <span className="flex items-center space-x-1 rounded border border-[#d3dfd7] bg-[#eef4ef] px-2 py-1 font-medium text-[#315846]">
              <ImageIcon className="h-3.5 w-3.5 text-[#315846]" />
              <span>
                {post.mediaIds.length} 图 {firstMedia && hasArchivedMedia(firstMedia) ? '(已下载)' : ''}
              </span>
            </span>
          )}

          {post.externalLinks.length > 0 && (
            <span className="flex items-center space-x-1 rounded border border-[#e5e2d9] bg-[#f5f3ed] px-2 py-1 text-stone-600">
              <ExternalLink className="h-3.5 w-3.5 text-stone-400" />
              <span>{post.externalLinks.length} 外链</span>
            </span>
          )}

          {primaryTopic && (
            <span className="rounded border border-[#ead8bc] bg-[#fbf3e6] px-2 py-0.5 text-[11px] font-medium text-[#8b5b2f]">
              {primaryTopic}
            </span>
          )}
        </div>
      </div>

      {/* Footer Actions */}
      <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-3 text-xs">
        <span onClick={(event) => event.stopPropagation()}>
        <SafeExternalLink
          href={post.canonicalUrl}
          className="flex items-center space-x-1 font-medium text-[#315b81] hover:text-slate-950"
        >
          <span>原帖</span>
          <ExternalLink className="w-3 h-3" />
        </SafeExternalLink>
        </span>

        <div className="flex items-center space-x-2">
          <button
            onClick={(event) => { event.stopPropagation(); onViewDetails(post); }}
            className="flex items-center space-x-1 rounded-md bg-[#e7eff8] px-2.5 py-1.5 font-semibold text-[#244b73] transition-colors hover:bg-[#d7e6f5]"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>打开</span>
          </button>

          <button
            onClick={(event) => {
              event.stopPropagation();
              if (window.confirm('确认删除本地保存的这条记录吗？这不会影响 X 上的点赞。')) {
                onDelete(post.id);
              }
            }}
            title="删除此本地记录"
            className="rounded-md p-1.5 text-stone-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
