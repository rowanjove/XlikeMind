import { currentAnalysis } from './analysis';
import type {
  NormalizedPost,
  UserOverrides,
  AIAnalysis,
  TopicSummary,
  TopicSynthesis,
} from './types';
import { DEFAULT_TOPICS } from './types';
import { escapeYamlString, markdownLink, markdownText, sanitizeUrl } from './sanitize';

/** A few characters and no image. The reader can filter these and deal with them. */
export const SHORT_TEXT_LIMIT = 8;

export function isShortTextPost(post: NormalizedPost): boolean {
  const text = (post.text || '').replace(/\s+/g, '');
  const hasMedia = (post.mediaIds?.length || 0) > 0;
  if (!text) return !hasMedia;
  if (hasMedia) return false;
  return [...text].length <= SHORT_TEXT_LIMIT;
}

/**
 * User categories win. Very short text-only posts stay in 杂项
 * so a later AI pass does not scatter them into real topics.
 */
export function getPostTopics(
  post: NormalizedPost,
  overrides?: UserOverrides,
  ai?: AIAnalysis
): string[] {
  if (overrides?.customCategories && overrides.customCategories.length > 0) {
    return [...new Set(overrides.customCategories)];
  }
  if (isShortTextPost(post)) {
    return ['杂项'];
  }
  const analysis = currentAnalysis(post, ai);
  if (analysis?.categories.length) {
    return [...new Set(analysis.categories)];
  }
  return ['综合知识'];
}

/**
 * Groups all posts into topic summaries with reading status metrics.
 */
export function buildTopicSummaries(
  posts: NormalizedPost[],
  overridesMap: Map<string, UserOverrides>,
  aiMap: Map<string, AIAnalysis>
): TopicSummary[] {
  const topicMap = new Map<string, TopicSummary>();

  // Initialize default topics
  for (const dt of DEFAULT_TOPICS) {
    topicMap.set(dt, {
      topic: dt,
      postCount: 0,
      toReadCount: 0,
      toPracticeCount: 0,
      practicedCount: 0,
      ignoredCount: 0,
      postIds: [],
    });
  }

  for (const post of posts) {
    const overrides = overridesMap.get(post.id);
    const ai = currentAnalysis(post, aiMap.get(post.id));
    const topics = getPostTopics(post, overrides, ai);
    const status = overrides?.readingStatus || 'to_read';

    for (const t of topics) {
      if (!topicMap.has(t)) {
        topicMap.set(t, {
          topic: t,
          postCount: 0,
          toReadCount: 0,
          toPracticeCount: 0,
          practicedCount: 0,
          ignoredCount: 0,
          postIds: [],
        });
      }

      const summary = topicMap.get(t)!;
      summary.postCount++;
      summary.postIds.push(post.id);

      if (status === 'to_read') summary.toReadCount++;
      else if (status === 'to_practice') summary.toPracticeCount++;
      else if (status === 'practiced') summary.practicedCount++;
      else if (status === 'ignored') summary.ignoredCount++;
    }
  }

  return Array.from(topicMap.values()).sort((a, b) => b.postCount - a.postCount);
}

/**
 * Synthesizes cross-post insights for a specific topic:
 * - Common patterns / Shared concepts
 * - Key differences & alternatives
 * - Actionable checklist ("值得实践清单")
 * Strictly attributes all insights to the source post URL.
 */
export function generateTopicSynthesis(
  topic: string,
  topicPosts: NormalizedPost[],
  aiMap: Map<string, AIAnalysis>
): TopicSynthesis {
  const commonPatterns: TopicSynthesis['commonPatterns'] = [];
  const differences: TopicSynthesis['differences'] = [];
  const actionableList: TopicSynthesis['actionableList'] = [];

  const evidence = new Map<string, Map<string, Set<string>>>();
  const record = (aspect: string, value: string, postId: string) => {
    const text = value.trim();
    if (!text) return;
    const entries = evidence.get(aspect) ?? new Map<string, Set<string>>();
    const ids = entries.get(text) ?? new Set<string>();
    ids.add(postId);
    entries.set(text, ids);
    evidence.set(aspect, entries);
  };

  for (const post of topicPosts) {
    const ai = currentAnalysis(post, aiMap.get(post.id));
    for (const step of ai?.steps?.slice(0, 3) ?? []) record('操作步骤', step, post.id);

    for (const item of ai?.prerequisites ?? []) record('前置条件', item, post.id);
    for (const item of ai?.risksAndLimits ?? []) record('风险与限制', item, post.id);
    for (const link of post.externalLinks) record('提到的资源', sanitizeUrl(link), post.id);
  }

  for (const [aspect, entries] of evidence) {
    const sources = new Set([...entries.values()].flatMap((ids) => [...ids]));
    for (const [description, ids] of entries) {
      const sourcePostIds = [...ids];
      if (aspect === '操作步骤') actionableList.push({ task: description, sourcePostIds });
      if (ids.size > 1) commonPatterns.push({ title: aspect, description, sourcePostIds });
      if (aspect !== '操作步骤' && entries.size > 1 && ids.size < sources.size) {
        differences.push({ aspect, description, sourcePostIds });
      }
    }
  }

  return {
    topic,
    generatedAt: new Date().toISOString(),
    postCount: topicPosts.length,
    commonPatterns,
    differences,
    actionableList,
  };
}

/**
 * Generates an offline Markdown document for a topic synthesis.
 * File location: topics/<topic_safe_name>.md
 */
export function generateTopicMarkdown(
  synthesis: TopicSynthesis,
  topicPosts: NormalizedPost[],
  overridesMap: Map<string, UserOverrides>,
  aiMap: Map<string, AIAnalysis>
): string {
  const postById = new Map(topicPosts.map((post) => [post.id, post]));
  const citations = (ids: string[]) => ids.flatMap((id) => {
    const post = postById.get(id);
    return post ? [markdownLink(`原帖 ${post.postId}`, post.canonicalUrl)] : [];
  }).join(' · ');
  const lines: string[] = [
    '---',
    `topic: ${escapeYamlString(synthesis.topic)}`,
    `post_count: ${synthesis.postCount}`,
    `generated_at: ${escapeYamlString(synthesis.generatedAt)}`,
    'type: "topic_summary"',
    '---',
    '',
    `# 主题知识汇总：${markdownText(synthesis.topic)}`,
    '',
    `> 本主题共收录 **${synthesis.postCount}** 篇帖子。所列步骤与条件请对照原帖核实。`,
    '',
    '## 核心共性与技术聚焦',
    '',
  ];

  if (synthesis.commonPatterns.length === 0) {
    lines.push('*(暂无明显共性聚合)*');
  } else {
    for (const cp of synthesis.commonPatterns) {
      lines.push(`### ${markdownText(cp.title)}`);
      lines.push(markdownText(cp.description));
      lines.push(citations(cp.sourcePostIds));
      lines.push('');
    }
  }

  lines.push('', '## 差异与各自出处', '');
  if (synthesis.differences.length === 0) lines.push('*(暂无可对照的条件、限制或资源)*');
  for (const item of synthesis.differences) {
    lines.push(`- **${markdownText(item.aspect)}** · ${markdownText(item.description)} — ${citations(item.sourcePostIds)}`);
  }
  lines.push('');

  lines.push('## 值得实践清单 (Actionable Checklist)');
  lines.push('');
  if (synthesis.actionableList.length === 0) {
    lines.push('*(暂无提取出的具体执行步骤)*');
  } else {
    for (const act of synthesis.actionableList) {
      lines.push(`- [ ] ${markdownText(act.task.replace(/\r?\n/g, ' '))} — ${citations(act.sourcePostIds)}`);
    }
  }
  lines.push('');

  lines.push('## 收录推文索引');
  lines.push('');
  for (const p of topicPosts) {
    const overrides = overridesMap.get(p.id);
    const ai = currentAnalysis(p, aiMap.get(p.id));
    const title = overrides?.customTitle || ai?.titleZh || (p.author?.displayName ? `${p.author.displayName} 的推文` : p.postId);
    const status = overrides?.readingStatus || 'to_read';
    const statusZh = {
      to_read: '待读',
      to_practice: '待实践',
      practiced: '已实践',
      ignored: '忽略',
    }[status];

    lines.push(`- **${markdownLink(title, p.canonicalUrl)}** [${statusZh}] — 作者: @${markdownText(p.author?.handle || '未知')} (首次收录: ${markdownText(p.firstObservedAt)})`);
    if (ai?.summaryZh) {
      lines.push(`  > ${markdownText(ai.summaryZh)}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
