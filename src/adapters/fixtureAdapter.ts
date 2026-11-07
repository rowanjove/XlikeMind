import type { CaptureAdapter, CaptureOptions, CaptureResult, RawCapturedItem } from './types';

// Sample 1x1 transparent PNG blob helper for offline media simulation
export function createMockImageBlob(_color = '#0284c7'): Blob {
  // A tiny valid 1x1 PNG representation
  const pngHeader = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0,
    0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 96, 0, 0, 0, 2, 0, 1,
    229, 39, 188, 167, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
  ]);
  return new Blob([pngHeader], { type: 'image/png' });
}

export const BASE_FIXTURES: RawCapturedItem[] = [
  {
    postId: '1851234567890123001',
    url: 'https://x.com/tech_guru/status/1851234567890123001',
    authorHandle: 'tech_guru',
    authorDisplayName: 'Tech Guru 🚀',
    authorAvatarUrl: 'https://pbs.twimg.com/profile_images/1/guru.jpg',
    text: '分享一个超好用的 CLI 工具，使用 TypeScript + Vite 构建快速前端工程！\n\n```bash\nnpx create-likemind-app\n```\n非常轻量高效。项目主页：https://github.com/example/likemind',
    postedAt: '2026-10-15T10:20:00.000Z',
    externalLinks: ['https://github.com/example/likemind'],
    mediaUrls: ['https://pbs.twimg.com/media/mock_preview_01.jpg'],
    isPartial: false,
  },
  {
    postId: '1851234567890123002',
    url: 'https://x.com/design_daily/status/1851234567890123002',
    authorHandle: 'design_daily',
    authorDisplayName: 'Design System Daily',
    text: '4 种现代卡片设计的排版对比：从扁平化到微阴影，保持极简视觉层级。大家更喜欢第几款？👇',
    postedAt: '2026-10-18T14:30:00.000Z',
    externalLinks: [],
    // 4 images in strict order
    mediaUrls: [
      'https://pbs.twimg.com/media/design_card_1.png',
      'https://pbs.twimg.com/media/design_card_2.png',
      'https://pbs.twimg.com/media/design_card_3.png',
      'https://pbs.twimg.com/media/design_card_4.png',
    ],
    isPartial: false,
  },
  {
    postId: '1851234567890123003',
    url: 'https://x.com/agent_builder/status/1851234567890123003',
    authorHandle: 'agent_builder',
    authorDisplayName: 'Autonomous Agent Lab',
    text: '转推 @deepmind: Multi-agent systems with shared memory and reactive checkpoints perform 3x better on long horizon coding benchmarks. 详见论文：https://arxiv.org/abs/2601.12345',
    postedAt: '2026-10-20T08:15:00.000Z',
    externalLinks: ['https://arxiv.org/abs/2601.12345'],
    mediaUrls: [],
    isPartial: false,
  },
  {
    postId: '1851234567890123004',
    url: 'https://x.com/anonymous/status/1851234567890123004',
    // Missing author and postedAt to test robustness
    authorHandle: undefined,
    authorDisplayName: undefined,
    text: '这是一条缺少作者和发布时间的匿名/受限推文样本，系统必须能安全保存并正确标记缺失字段。',
    postedAt: null,
    externalLinks: [],
    mediaUrls: [],
    isPartial: false,
    missingFields: ['author', 'postedAt'],
  },
  {
    postId: '1658000000000000005',
    url: 'https://x.com/retro_coder/status/1658000000000000005',
    authorHandle: 'retro_coder',
    authorDisplayName: 'Retro Coder 💾',
    text: '这是 2023 年发布的经典教程：《深入理解 SQLite B-Tree 原理》。今天被新点赞！系统绝不能因为它是旧帖子或 ID 较小而漏采。',
    postedAt: '2023-05-15T08:00:00.000Z', // Old post!
    externalLinks: ['https://sqlite.org/b-tree'],
    mediaUrls: ['https://pbs.twimg.com/media/btree.png'],
    isPartial: false,
  },
  {
    postId: '1851234567890123006',
    url: 'https://x.com/security_audit/status/1851234567890123006',
    authorHandle: 'sec_research',
    authorDisplayName: 'Security Researcher',
    // Malicious XSS, YAML injection and path traversal test
    text: '安全测试样本：\n<script>alert("xss")</script>\n<img src=x onerror=alert(1)>\nYAML Break: ": true\nmalicious: true\nPath Traversal: ../../../../etc/passwd\nProtocol: javascript:void(0)',
    postedAt: '2026-10-25T11:00:00.000Z',
    externalLinks: ['javascript:void(0)', 'https://safe-security.org/audit'],
    mediaUrls: ['https://pbs.twimg.com/media/security.jpg'],
    isPartial: false,
  },
  {
    postId: '1851234567890123007',
    url: 'https://x.com/photo_bot/status/1851234567890123007',
    authorHandle: 'photo_bot',
    authorDisplayName: 'Photo Bot 📸',
    text: '该帖包含一张损坏的无效图片地址，用于测试图片下载失败时的容错机制与远程回退链接。',
    postedAt: '2026-10-26T16:45:00.000Z',
    externalLinks: [],
    mediaUrls: ['https://invalid-broken-domain-likemind.xyz/fail.jpg'],
    isPartial: false,
  },
  {
    postId: '1851234567890123008',
    url: 'https://x.com/story_teller/status/1851234567890123008',
    authorHandle: 'story_teller',
    authorDisplayName: 'Thread Writer',
    text: '这是一段长推文线程的开头（1/8），但由于网络截断，采集器只观察到了前两句，状态应被标记为 partial...',
    postedAt: '2026-10-28T19:00:00.000Z',
    externalLinks: [],
    mediaUrls: [],
    isPartial: true,
    missingFields: ['thread_continuation'],
  },
];

/**
 * Generate synthetic mock posts for stress testing (e.g. 1000 items)
 */
export function generateMockPosts(count: number, startIndex = 100): RawCapturedItem[] {
  const items: RawCapturedItem[] = [];
  const baseDate = new Date('2026-10-01T00:00:00Z').getTime();

  for (let i = 0; i < count; i++) {
    const idx = startIndex + i;
    const postDate = new Date(baseDate + idx * 3600000).toISOString();
    items.push({
      postId: `185990000000000${idx}`,
      url: `https://x.com/mock_user_${idx % 10}/status/185990000000000${idx}`,
      authorHandle: `mock_user_${idx % 10}`,
      authorDisplayName: `Developer ${idx % 10}`,
      authorAvatarUrl: `https://pbs.twimg.com/avatar_${idx % 10}.jpg`,
      text: `这是第 ${idx + 1} 条自动化模拟点赞内容。包含关键词 #AI #TypeScript #Coding。编号: ${idx}。\n项目文档参考: https://example.com/item/${idx}`,
      postedAt: postDate,
      externalLinks: [`https://example.com/item/${idx}`],
      mediaUrls: idx % 3 === 0 ? [`https://pbs.twimg.com/media/mock_${idx}.jpg`] : [],
      isPartial: false,
    });
  }
  return items;
}

export class FixtureCaptureAdapter implements CaptureAdapter {
  readonly name = 'fixture';
  private items: RawCapturedItem[];

  constructor(customItems?: RawCapturedItem[]) {
    this.items = customItems || BASE_FIXTURES;
  }

  async captureBatch(options: CaptureOptions): Promise<CaptureResult> {
    const { limit, cursor, signal, onProgress } = options;

    if (signal?.aborted) {
      return {
        items: [],
        hasMore: false,
        status: 'failed',
        error: 'Sync operation cancelled by user',
      };
    }

    const startIndex = cursor ? parseInt(cursor, 10) || 0 : 0;
    const endIndex = Math.min(startIndex + limit, this.items.length);
    const slice = this.items.slice(startIndex, endIndex);

    onProgress?.(slice.length);

    const hasMore = endIndex < this.items.length;
    const nextCursor = hasMore ? endIndex.toString() : undefined;

    return {
      items: slice,
      hasMore,
      cursor: nextCursor,
      status: 'complete',
    };
  }
}
