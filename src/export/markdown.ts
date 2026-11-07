import { hasArchivedMedia } from '../domain/media';
import type { NormalizedPost, MediaAsset, UserOverrides, AIAnalysis } from '../domain/types';
import { analysisStatus, currentAnalysis, sourceGroundedLinks } from '../domain/analysis';
import { getCaptureNotices, POST_REFERENCE_LABELS } from '../domain/postReferences';
import { archiveMissingFields } from './archiveFailures';
import { describePostSources, getPostSources } from '../domain/sources';
import { escapeYamlString, markdownDestination, markdownText, sanitizeFilename } from '../domain/sanitize';

export interface PostExportContext {
  post: NormalizedPost;
  media: MediaAsset[];
  overrides?: UserOverrides;
  ai?: AIAnalysis;
  exportedAt: string;
}

function exportImageLink(raw: string | undefined, allowExternal = false): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const isPhotoCdn = url.origin === 'https://pbs.twimg.com';
    if ((!isPhotoCdn && !allowExternal) || url.username || url.password) return '';
    const clean = new URL(url.pathname, url.origin);
    if (clean.origin !== url.origin) return '';
    const format = url.searchParams.get('format') ?? '';
    const size = url.searchParams.get('name') ?? '';
    if (isPhotoCdn && /^(jpg|jpeg|png|gif|webp|avif)$/.test(format)) clean.searchParams.set('format', format);
    if (isPhotoCdn && /^(orig|large|medium|small|thumb|\d{1,4}x\d{1,4})$/.test(size)) clean.searchParams.set('name', size);
    return markdownDestination(clean.toString());
  } catch {
    return '';
  }
}

/**
 * Determine the relative directory and filename for a post markdown file.
 * Structure: posts/YYYY/MM/<safe_post_id>.md
 */
export function getPostRelativePath(post: NormalizedPost): {
  dir: string;
  filename: string;
  fullPath: string;
} {
  const dateStr = post.postedAt || post.firstObservedAt;
  let year = 'unknown';
  let month = '00';

  if (dateStr) {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      year = d.getUTCFullYear().toString();
      month = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    }
  }

  const safePostId = sanitizeFilename(post.postId || post.id);
  const dir = `posts/${year}/${month}`;
  const filename = `${safePostId}.md`;
  return {
    dir,
    filename,
    fullPath: `${dir}/${filename}`,
  };
}

/**
 * Get media file extension based on mime type or URL extension
 */
export function getMediaExtension(media: MediaAsset): string {
  if (media.mime) {
    if (media.mime.includes('png')) return 'png';
    if (media.mime.includes('gif')) return 'gif';
    if (media.mime.includes('webp')) return 'webp';
    if (media.mime.includes('jpeg') || media.mime.includes('jpg')) return 'jpg';
  }
  const match = media.sourceUrl.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i);
  if (match) return match[1].toLowerCase();
  return 'jpg';
}

/**
 * Get the relative asset path in the ZIP archive:
 * Archive location: assets/<post_id>/<position>.<ext>
 * From posts/YYYY/MM/<post_id>.md to assets/<post_id>/<filename>:
 * Exactly 3 levels up: ../../../assets/<post_id>/<filename>
 */
export function getMediaArchivePaths(media: MediaAsset, post: NormalizedPost): {
  archivePath: string; // inside zip root
  relativeMarkdownPath: string; // from posts/YYYY/MM/*.md
} {
  const safePostId = sanitizeFilename(post.postId || post.id);
  const ext = getMediaExtension(media);
  const fileIndex = (media.position + 1).toString().padStart(2, '0');
  const filename = `${fileIndex}.${ext}`;

  const archivePath = `assets/${safePostId}/${filename}`;
  const relativeMarkdownPath = `../../../assets/${safePostId}/${filename}`;

  return { archivePath, relativeMarkdownPath };
}

/**
 * Generate formatted, offline-readable Markdown content with YAML frontmatter.
 */
export function generatePostMarkdown(context: PostExportContext): string {
  const { post, media, overrides, ai, exportedAt } = context;
  const currentAi = currentAnalysis(post, ai);

  const displayName = markdownText((post.author?.displayName || '').replace(/\s+/g, ' '));
  const postUrl =
    markdownDestination(post.canonicalUrl) ||
    `https://x.com/i/web/status/${encodeURIComponent(post.postId)}`;
  const tags = overrides?.customTags || currentAi?.tags || [];
  const categories = overrides?.customCategories || currentAi?.categories || [];
  const aiStatus = analysisStatus(post, ai);

  // Frontmatter
  const lines: string[] = [
    '---',
    `id: ${escapeYamlString(post.id)}`,
    `platform: "x"`,
    `post_id: ${escapeYamlString(post.postId)}`,
    `canonical_url: ${escapeYamlString(postUrl)}`,
    'author:',
    `  handle: ${escapeYamlString(post.author?.handle || '')}`,
    `  display_name: ${escapeYamlString(post.author?.displayName || '')}`,
    `posted_at: ${post.postedAt ? escapeYamlString(post.postedAt) : 'null'}`,
    `liked_at: ${post.likedAt ? escapeYamlString(post.likedAt) : 'null'}`,
    `first_observed_at: ${escapeYamlString(post.firstObservedAt)}`,
    `last_observed_at: ${escapeYamlString(post.lastObservedAt)}`,
    `capture_status: ${escapeYamlString(post.captureStatus)}`,
    `ai_status: ${escapeYamlString(aiStatus)}`,
    `content_type: ${escapeYamlString(currentAi?.contentType)}`,
    `reading_status: ${escapeYamlString(overrides?.readingStatus || 'to_read')}`,
    `content_hash: ${escapeYamlString(post.contentHash)}`,
    `source_adapter: ${escapeYamlString(post.sourceAdapter)}`,
    `sources: ${JSON.stringify(getPostSources(post))}`,
    `exported_at: ${escapeYamlString(exportedAt)}`,
    'categories:',
  ];

  if (categories.length === 0) {
    lines.push('  - "未分类"');
  } else {
    for (const c of categories) {
      lines.push(`  - ${escapeYamlString(c)}`);
    }
  }

  lines.push('tags:');
  if (tags.length === 0) {
    lines.push('  - "x-like"');
  } else {
    for (const t of tags) {
      lines.push(`  - ${escapeYamlString(t)}`);
    }
  }

  lines.push('---');
  lines.push('');

  // Title / Header
  const rawTitle = overrides?.customTitle || currentAi?.titleZh || (post.author?.displayName ? `${post.author.displayName} 的 X 帖子` : `帖子 ${post.postId}`);
  const title = markdownText(rawTitle.replace(/\s+/g, ' ').trim());
  lines.push(`# ${title}`);
  lines.push('');

  // Meta bar
  lines.push(`> 原帖链接: [${markdownText(postUrl)}](${postUrl})  `);
  lines.push(`> 收录来源：${describePostSources(post)}  `);
  if (post.author?.handle) {
    lines.push(`> 作者: **${displayName}** (@${markdownText(post.author.handle)})  `);
  }
  lines.push(`> 发布时间: ${markdownText(post.postedAt || '未知')} | 首次记录: ${markdownText(post.firstObservedAt)}  `);
  lines.push(`> 状态: 采集 [${post.captureStatus}] | AI分析 [${aiStatus}]`);
  lines.push('');

  // Original content
  lines.push('## 帖子原文');
  lines.push('');
  for (const notice of getCaptureNotices(post.missingFields)) lines.push(notice, '');
  // Render sanitized text, preserving line breaks
  lines.push(post.text ? markdownText(post.text) : '*(此帖子未获取到文本内容)*');
  lines.push('');

  // Media
  const presentIds = new Set(media.map((asset) => asset.id));
  const missingMediaCount = post.mediaIds.filter((id) => !presentIds.has(id)).length;
  if (media.length > 0 || missingMediaCount > 0) {
    lines.push('## 媒体资源');
    lines.push('');
    // Sort media by position
    const sorted = [...media].sort((a, b) => a.position - b.position);
    for (const m of sorted) {
      const { relativeMarkdownPath } = getMediaArchivePaths(m, post);
      const alt = markdownText((m.altText || `图片 ${m.position + 1}`).replace(/\s+/g, ' '));
      if (hasArchivedMedia(m)) {
        lines.push(`![${alt}](${relativeMarkdownPath})`);
        const source = exportImageLink(m.sourceUrl);
        const downloaded = exportImageLink(m.downloadedFromUrl);
        const provenance = [
          source && `[采集地址](${source})`,
          downloaded && downloaded !== source && `[下载版本](${downloaded})`,
          `${m.blob.size} 字节`,
        ].filter(Boolean);
        lines.push('', provenance.join(' · '));
      } else {
        const httpStatus = /^HTTP [1-5]\d{2}\b/.exec(m.failureReason ?? '')?.[0];
        const reason = m.status === 'remote_only' ? '仅保留原图链接' : httpStatus || '未离线下载';
        const remote = exportImageLink(m.sourceUrl, true);
        if (m.altText) lines.push(`- 图片说明：${alt}`);
        lines.push(
          remote
            ? `- ⚠️ [未离线归档: ${markdownText(reason)}] 原图链接: [${markdownText(remote)}](${remote})`
            : `- ⚠️ [未离线归档: ${markdownText(reason)}] 原图链接不可用`
        );
      }
      lines.push('');
    }
    if (missingMediaCount > 0) {
      lines.push(`- ⚠️ [未离线归档: 缺少 ${missingMediaCount} 项媒体记录]`, '');
    }
  }

  if (post.references?.length) {
    lines.push('## 关联原文', '');
    for (const reference of post.references) {
      const url = markdownDestination(reference.url);
      if (url) lines.push(`- [${POST_REFERENCE_LABELS[reference.kind]}](${url})`);
    }
    lines.push('');
  }
  // External links
  if (post.externalLinks && post.externalLinks.length > 0) {
    lines.push('## 外部链接');
    lines.push('');
    for (const link of post.externalLinks) {
      const safe = markdownDestination(link);
      if (safe) {
        lines.push(`- [${markdownText(safe)}](${safe})`);
      }
    }
    lines.push('');
  }

  // AI Knowledge Summary section
  lines.push('## AI 知识提炼');
  lines.push('');
  if (ai && currentAi) {
    if (ai.summaryZh) {
      lines.push(`**摘要**: ${markdownText(ai.summaryZh)}`);
      lines.push('');
    }
    if (ai.contentType) lines.push(`**内容类型**: ${markdownText(ai.contentType)}`, '');
    if (ai.quality) lines.push(`**价值评级**: ${markdownText(ai.quality)}`, '');
    if (ai.confidenceNote) lines.push(`**置信说明**: ${markdownText(ai.confidenceNote)}`, '');
    if (ai.steps && ai.steps.length > 0) {
      lines.push('### 步骤 / 要点');
      for (const step of ai.steps) {
        lines.push(`- ${markdownText(step)}`);
      }
      lines.push('');
    }
    if (ai.prerequisites && ai.prerequisites.length > 0) {
      lines.push('### 前置要求');
      for (const pre of ai.prerequisites) {
        lines.push(`- ${markdownText(pre)}`);
      }
      lines.push('');
    }
    const links = sourceGroundedLinks(post, ai.usefulLinks);
    if (links.length) {
      lines.push('### 相关项目 / 资源');
      for (const ul of links) {
        const safe = markdownDestination(ul);
        if (safe) {
          lines.push(`- [${markdownText(safe)}](${safe})`);
        }
      }
      lines.push('');
    }
    if (ai.risksAndLimits?.length) {
      lines.push('### 风险与限制', ...ai.risksAndLimits.map((item) => `- ${markdownText(item)}`), '');
    }
    if (ai.uncertainties && ai.uncertainties.length > 0) {
      lines.push('### 待核实 / 信息缺失');
      for (const unc of ai.uncertainties) {
        lines.push(`- ⚠️ ${markdownText(unc)}`);
      }
      lines.push('');
    }
  } else if (aiStatus === 'stale') {
    lines.push('*(原文或整理规则已更新，等待重新整理)*', '');
  } else if (ai && ai.status === 'failed') {
    lines.push('*(AI 提炼失败。可在本地文库查看处理状态并重试。)*');
    lines.push('');
  } else if (ai && ai.status === 'processing') {
    lines.push('*(AI 分析处理中...)*');
    lines.push('');
  } else {
    lines.push('*(暂未进行 AI 分析；可直接使用离线原文与媒体)*');
    lines.push('');
  }

  // User notes
  if (overrides?.notes) {
    lines.push('## 个人笔记');
    lines.push('');
    lines.push(markdownText(overrides.notes));
    lines.push('');
  }

  // Diagnostics / Missing fields
  const missingFields = archiveMissingFields(post);
  if (missingFields.length > 0) {
    lines.push('## 采集完整性说明');
    lines.push('');
    lines.push(`- 缺失字段: ${markdownText(missingFields.join(', '))}`);
    lines.push('');
  }

  return lines.join('\n');
}
