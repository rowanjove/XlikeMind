import { useMemo, useState } from 'react';
import type { AIAnalysis, NormalizedPost, TopicSummary } from '../../domain/types';
import { generateTopicSynthesis } from '../../domain/topics';
import { SynthesisPanels } from '../components/SynthesisPanels';

interface TopicsPageProps {
  posts: NormalizedPost[];
  summaries: TopicSummary[];
  aiMap: Map<string, AIAnalysis>;
  onOpenTopic: (topic: string) => void;
}

export function TopicsPage({ posts, summaries, aiMap, onOpenTopic }: TopicsPageProps) {
  const [topic, setTopic] = useState('');
  const available = summaries.filter((summary) => summary.postCount > 0);
  const active = available.find((summary) => summary.topic === topic) ?? available[0];
  const postsById = useMemo(() => new Map(posts.map((post) => [post.id, post])), [posts]);
  const synthesis = useMemo(() => {
    if (!active) return;
    const topicPosts = active.postIds.flatMap((id) => {
      const post = postsById.get(id);
      return post ? [post] : [];
    });
    return generateTopicSynthesis(active.topic, topicPosts, aiMap);
  }, [active, postsById, aiMap]);

  if (!active || !synthesis) {
    return <section className="lm-panel p-5 text-sm text-stone-600">收录帖子后，这里会按主题展示已有资料。</section>;
  }

  return (
    <section className="space-y-4" aria-label="主题汇总">
      <header className="lm-panel flex flex-wrap items-end justify-between gap-3 p-4">
        <label className="grid gap-1 text-sm text-stone-700">
          查看主题
          <select className="lm-control max-w-full px-3 py-2" value={active.topic} onChange={(event) => setTopic(event.target.value)}>
            {available.map((summary) => <option key={summary.topic} value={summary.topic}>{summary.topic}（{summary.postCount}）</option>)}
          </select>
        </label>
        <button type="button" className="lm-button-quiet px-3 py-2 text-sm" onClick={() => onOpenTopic(active.topic)}>查看主题帖子</button>
        <p className="w-full text-sm text-stone-600">待实践 {active.toPracticeCount} 篇 · 已实践 {active.practicedCount} 篇。请对照原帖核实条件和步骤。</p>
      </header>

      <SynthesisPanels key={active.topic} synthesis={synthesis} postsById={postsById} />
    </section>
  );
}
