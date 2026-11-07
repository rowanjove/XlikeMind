import { useState } from 'react';
import type { NormalizedPost, TopicSynthesis } from '../../domain/types';
import { SafeExternalLink } from './SafeExternalLink';

const PREVIEW_LIMIT = 8;

export function SynthesisPanels({ synthesis, postsById }: {
  synthesis: TopicSynthesis;
  postsById: ReadonlyMap<string, NormalizedPost>;
}) {
  const [pages, setPages] = useState({ commonPatterns: 0, differences: 0, actionableList: 0 });
  const pageFor = (key: keyof typeof pages) =>
    Math.min(pages[key], Math.max(0, Math.ceil(synthesis[key].length / PREVIEW_LIMIT) - 1));
  const controls = (key: keyof typeof pages, label: string) => {
    const total = synthesis[key].length;
    if (total <= PREVIEW_LIMIT) return null;
    const page = pageFor(key);
    const changePage = (next: number) => setPages((current) => ({ ...current, [key]: next }));
    return <nav aria-label={label + '分页'} className="flex flex-wrap items-center gap-2 text-sm">
      <button type="button" aria-label={label + '上一页'} disabled={page === 0}
        onClick={() => changePage(page - 1)} className="lm-button-quiet px-2 py-1 disabled:opacity-40">上一页</button>
      <span role="status">{page * PREVIEW_LIMIT + 1}–{Math.min((page + 1) * PREVIEW_LIMIT, total)} / {total}</span>
      <button type="button" aria-label={label + '下一页'} disabled={(page + 1) * PREVIEW_LIMIT >= total}
        onClick={() => changePage(page + 1)} className="lm-button-quiet px-2 py-1 disabled:opacity-40">下一页</button>
    </nav>;
  };
  const sources = (ids: string[]) => (
    <details className="mt-1 text-sm text-stone-600">
      <summary className="cursor-pointer">原帖出处（{ids.length}）</summary>
      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {ids.map((id) => {
          const post = postsById.get(id);
          return post && <li key={id}><SafeExternalLink href={post.canonicalUrl} className="text-[#315846] underline">
            {post.author?.handle ? '@' + post.author.handle + ' · ' : ''}原帖 {post.postId}
          </SafeExternalLink></li>;
        })}
      </ul>
    </details>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="lm-panel min-w-0 space-y-3 p-4">
        <h3 className="font-semibold">共性</h3>
        {synthesis.commonPatterns.length === 0 && <p className="text-sm text-stone-600">暂无多篇帖子共同提到的条目。</p>}
        <ul className="space-y-3 text-sm">
          {synthesis.commonPatterns.slice(pageFor('commonPatterns') * PREVIEW_LIMIT, (pageFor('commonPatterns') + 1) * PREVIEW_LIMIT).map((item) => (
            <li key={item.title + ':' + item.description} className="break-words">
              <strong>{item.title}</strong><p className="whitespace-pre-wrap">{item.description}</p>{sources(item.sourcePostIds)}
            </li>
          ))}
        </ul>
        {controls('commonPatterns', '共性')}
      </section>
      <section className="lm-panel min-w-0 space-y-3 p-4">
        <h3 className="font-semibold">差异</h3>
        {synthesis.differences.length === 0 && <p className="text-sm text-stone-600">暂无可对照的条件、限制或资源。</p>}
        <ul className="space-y-3 text-sm">
          {synthesis.differences.slice(pageFor('differences') * PREVIEW_LIMIT, (pageFor('differences') + 1) * PREVIEW_LIMIT).map((item) => (
            <li key={item.aspect + ':' + item.description} className="break-words">
              <strong>{item.aspect}</strong><p className="whitespace-pre-wrap">{item.description}</p>{sources(item.sourcePostIds)}
            </li>
          ))}
        </ul>
        {controls('differences', '差异')}
      </section>
      <section className="lm-panel min-w-0 space-y-3 p-4">
        <h3 className="font-semibold">可尝试的实践项</h3>
        {synthesis.actionableList.length === 0 && <p className="text-sm text-stone-600">暂无已提炼的具体步骤，可先查看主题帖子。</p>}
        <ul className="space-y-3 text-sm">
          {synthesis.actionableList.slice(pageFor('actionableList') * PREVIEW_LIMIT, (pageFor('actionableList') + 1) * PREVIEW_LIMIT).map((item) => (
            <li key={item.task} className="break-words">
              <p className="whitespace-pre-wrap">{item.task}</p>{sources(item.sourcePostIds)}
            </li>
          ))}
        </ul>
        {controls('actionableList', '实践项')}
      </section>
    </div>
  );
}
