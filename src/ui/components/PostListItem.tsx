import React from 'react';
import type { NormalizedPost } from '../../domain/types';
import { Image as ImageIcon, Trash2, ExternalLink } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../storage/db';
import { SafeExternalLink } from './SafeExternalLink';
import { safeImageSrc } from '../../domain/sanitize';
import { getPostTopics } from '../../domain/topics';
import { currentAnalysis } from '../../domain/analysis';

interface PostListItemProps {
  post: NormalizedPost;
  isSelected?: boolean;
  onToggleSelect?: (postId: string) => void;
  onViewDetails?: (post: NormalizedPost) => void;
  onDelete?: (postId: string) => void;
}

export const PostListItem: React.FC<PostListItemProps> = ({
  post,
  isSelected = false,
  onToggleSelect,
  onViewDetails,
  onDelete,
}) => {
  const analysis = useLiveQuery(() => db.aiAnalysis.get(post.id), [post.id]);
  const ai = currentAnalysis(post, analysis);
  const overrides = useLiveQuery(() => db.userOverrides.get(post.id), [post.id]);

  const readingStatus = overrides?.readingStatus || 'to_read';
  const effectiveTags = overrides?.customTags || ai?.tags || [];
  const primaryTopic = getPostTopics(post, overrides, ai)[0];

  const authorDisplayName = post.author?.displayName || '未知作者';
  const authorHandle = post.author?.handle || 'unknown';
  const avatarUrl = safeImageSrc(post.author?.avatarUrl);

  const displayTime = post.postedAt
    ? new Date(post.postedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
    : '未知时间';

  const summary = ai?.titleZh || ai?.summaryZh || post.text || '无文字推文';

  return (
    <div
      onClick={() => onViewDetails?.(post)}
      className={`lm-list-item group cursor-pointer ${
        isSelected ? 'border-[#315846] bg-[#f5f8f4]' : ''
      }`}
    >
      {/* Checkbox and Author */}
      <div className="flex min-w-0 items-center gap-3">
        <input
          type="checkbox"
          aria-label={`选择 ${authorDisplayName} 的帖子 ${post.postId}`}
          checked={isSelected}
          onChange={(e) => {
            e.stopPropagation();
            onToggleSelect?.(post.id);
          }}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900"
        />

        <div className="flex items-center gap-2 overflow-hidden">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              className="h-7 w-7 rounded-full object-cover flex-shrink-0 bg-stone-100"
              onError={(e) => {
                (e.currentTarget as HTMLElement).style.display = 'none';
              }}
            />
          ) : (
            <div className="h-7 w-7 rounded-full bg-stone-200 flex items-center justify-center text-xs font-medium text-stone-600 flex-shrink-0">
              {authorDisplayName.charAt(0) || '@'}
            </div>
          )}

          <div className="truncate">
            <div className="text-sm font-medium text-stone-900 truncate">
              {authorDisplayName}
            </div>
            <div className="text-xs text-stone-500 font-mono truncate">
              @{authorHandle}
            </div>
          </div>
        </div>
      </div>

      {/* Post Text & AI Summary */}
      <div className="lm-list-copy min-w-0">
        {onViewDetails ? (
          <button type="button" className="lm-list-title line-clamp-2 break-words text-left text-sm font-semibold leading-6"
            onClick={(event) => { event.stopPropagation(); onViewDetails(post); }}>
            {summary}
          </button>
        ) : <p className="line-clamp-2 text-sm font-semibold">{summary}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span>{displayTime}</span>
          {post.mediaIds.length > 0 && (
            <span className="inline-flex items-center gap-0.5 text-stone-600">
              <ImageIcon className="w-3 h-3" />
              <span>{post.mediaIds.length}</span>
            </span>
          )}
          {primaryTopic && (
            <span className="rounded bg-stone-100 px-1.5 py-0.2 text-[11px] text-stone-700">
              {primaryTopic}
            </span>
          )}
          {effectiveTags.slice(0, 2).map((t: string) => (
            <span key={t} className="text-[11px] text-stone-500">
              #{t}
            </span>
          ))}
        </div>
      </div>

      {/* Badges & Actions */}
      <div className="lm-list-actions flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
        {readingStatus === 'to_practice' && (
          <span className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-xs text-amber-700">
            待做
          </span>
        )}
        {readingStatus === 'practiced' && (
          <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-xs text-emerald-700">
            做过
          </span>
        )}
        {readingStatus === 'ignored' && (
          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-500">
            已忽略
          </span>
        )}

        <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100">
          {post.canonicalUrl && (
            <SafeExternalLink
              href={post.canonicalUrl}
              aria-label="打开原帖"
              className="p-1 text-stone-400 hover:text-stone-700 rounded inline-flex items-center"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </SafeExternalLink>
          )}

          {onDelete && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm('确定从本地删除这篇帖子吗？')) {
                  onDelete(post.id);
                }
              }}
              className="p-1 text-stone-400 hover:text-rose-600 rounded"
              title="删除本地记录"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
