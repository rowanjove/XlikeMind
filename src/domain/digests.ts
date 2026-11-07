import { currentAnalysis } from './analysis';
import type {
  SyncRun,
  NormalizedPost,
  UserOverrides,
  AIAnalysis,
  IncrementalDigest,
} from './types';
import { generateTopicSynthesis, getPostTopics } from './topics';
import { escapeYamlString, markdownLink, markdownText } from './sanitize';

/**
 * Builds an incremental digest summary for a specific sync batch.
 * Strictly calculates based on first observed items in this run.
 */
export function buildIncrementalDigest(
  run: SyncRun,
  allPosts: NormalizedPost[],
  overridesMap: Map<string, UserOverrides>,
  aiMap: Map<string, AIAnalysis>
): IncrementalDigest {
  // Filter posts that were newly added in this run
  const runPosts = allPosts.filter((p) => p.sourceRunId === run.id);

  const topicCounts = new Map<string, number>();
  const postSummaries: IncrementalDigest['posts'] = [];

  for (const p of runPosts) {
    const overrides = overridesMap.get(p.id);
    const ai = currentAnalysis(p, aiMap.get(p.id));
    const topics = getPostTopics(p, overrides, ai);
    const title = overrides?.customTitle || ai?.titleZh || p.author?.displayName || p.postId;
    const readingStatus = overrides?.readingStatus || 'to_read';

    for (const t of topics) {
      topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
    }

    postSummaries.push({
      postId: p.id,
      title,
      author: p.author?.displayName ? `${p.author.displayName} (@${p.author.handle || 'unknown'})` : `@${p.author?.handle || 'unknown'}`,
      canonicalUrl: p.canonicalUrl,
      categories: topics,
      readingStatus,
    });
  }

  return {
    runId: run.id,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    adapterType: run.adapterType,
    newPostCount: runPosts.length,
    posts: postSummaries,
    summaryByTopic: Object.fromEntries(topicCounts),
    synthesis: generateTopicSynthesis('本批新增帖子', runPosts, aiMap),
  };
}

/** Label a sync run without calling an official archive an offline fixture. */
export function describeSyncSource(run: { id: string; adapterType: string }): string {
  if (run.adapterType === 'x_archive' || run.id.startsWith('archive_import_')) return '官方归档';
  if (run.adapterType === 'fixture') return '离线样本';
  return '网页增量';
}

/**
 * Generates an offline Markdown document for an incremental digest.
 * File location: digests/<run_id>.md
 */
export function generateDigestMarkdown(digest: IncrementalDigest): string {
  const lines: string[] = [
    '---',
    `run_id: ${escapeYamlString(digest.runId)}`,
    `started_at: ${escapeYamlString(digest.startedAt)}`,
    `ended_at: ${digest.endedAt ? escapeYamlString(digest.endedAt) : 'null'}`,
    `adapter_type: ${escapeYamlString(digest.adapterType)}`,
    `new_posts_count: ${digest.newPostCount}`,
    'type: "incremental_digest"',
    '---',
    '',
    `# 本次增量同步简报 (${markdownText(digest.runId)})`,
    '',
    `> 同步启动时间: ${markdownText(digest.startedAt)} | 来源: ${describeSyncSource({ id: digest.runId, adapterType: digest.adapterType })}  `,
    `> 本导出包包含本批次首次收录的推文 **${digest.newPostCount}** 篇（点赞时间未知时保持 null，绝不伪称当天点赞）`,
    '',
    '## 主题分布统计',
    '',
  ];

  const topics = Object.entries(digest.summaryByTopic);
  if (topics.length === 0) {
    lines.push('*(本批次无新增推文)*');
  } else {
    for (const [topic, count] of topics) {
      lines.push(`- **${markdownText(topic)}**: ${count} 篇`);
    }
  }
  lines.push('');

  const postsById = new Map(digest.posts.map((post) => [post.postId, post]));
  const citations = (ids: string[]) => ids.flatMap((id) => {
    const post = postsById.get(id);
    return post ? [markdownLink(post.title, post.canonicalUrl)] : [];
  }).join(' · ');
  const sections = [
    ['共性', digest.synthesis.commonPatterns.map((item) =>
      `**${markdownText(item.title)}** · ${markdownText(item.description)} — ${citations(item.sourcePostIds)}`)],
    ['差异', digest.synthesis.differences.map((item) =>
      `**${markdownText(item.aspect)}** · ${markdownText(item.description)} — ${citations(item.sourcePostIds)}`)],
    ['可尝试的实践项', digest.synthesis.actionableList.map((item) =>
      `${markdownText(item.task)} — ${citations(item.sourcePostIds)}`)],
  ] as const;
  lines.push('> 请对照原帖核实条件和步骤。', '');
  for (const [heading, entries] of sections) {
    lines.push(`## ${heading}`, '', ...(entries.length ? entries.map((entry) => `- ${entry}`) : ['暂无可汇总条目。']), '');
  }

  lines.push('## 本次收录条目清单');
  lines.push('');
  if (digest.posts.length === 0) {
    lines.push('*(无收录项目)*');
  } else {
    for (const item of digest.posts) {
      const statusZh = {
        to_read: '待读',
        to_practice: '待实践',
        practiced: '已实践',
        ignored: '忽略',
      }[item.readingStatus];
      lines.push(`- **${markdownLink(item.title, item.canonicalUrl)}** [${statusZh}] — 作者: ${markdownText(item.author)} (${markdownText(item.categories.join(', '))})`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
