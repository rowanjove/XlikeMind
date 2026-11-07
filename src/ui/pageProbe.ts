export type ReadinessLamp = 'checking' | 'ready' | 'wait' | 'blocked' | 'reading';

export interface ProbeInput {
  ok: boolean;
  isLikesPage?: boolean;
  articlesCount?: number;
  failureCode?: unknown;
  reading?: boolean;
  error?: string;
  url?: string;
}

export interface PageProbe {
  lamp: ReadinessLamp;
  title: string;
  detail: string;
  canStart: boolean;
  needsReload: boolean;
  pageBlocked?: boolean;
  failureCode?: keyof typeof PAGE_BLOCKS;
}

const PAGE_BLOCKS = {
  login_required: ['X 需要登录或验证', '请在 X 完成登录或账号验证，再回到原列表。'],
  access_restricted: ['X 请求频率受限', '请等待 X 恢复访问，再手动检测。'],
  page_error: ['X 列表加载失败', '请检查网络，刷新 X 列表后再试。'],
} as const;

const SCRIPT_MISSING = /Receiving end does not exist|Could not establish connection|message port closed/i;

/**
 * Decide the popup lamp from one content-script ping.
 * Ready only when the likes page is connected and at least one post is visible.
 */
export function describePageProbe(ping: ProbeInput | null): PageProbe {
  if (!ping) {
    return {
      lamp: 'checking',
      title: '看一下点赞页',
      detail: '稍等。',
      canStart: false,
      needsReload: false,
    };
  }

  if (!ping.ok) {
    const error = ping.error || '连不上点赞页。';
    if (SCRIPT_MISSING.test(error)) {
      return {
        lamp: 'blocked',
        title: '还没连上',
        detail: '点「刷新」，让点赞页重新载入。',
        canStart: false,
        needsReload: true,
      };
    }
    if (/没有找到/.test(error)) {
      return {
        lamp: 'wait',
        title: '先打开列表',
        detail: '打开 x.com 的点赞或收藏，登录后再来。',
        canStart: false,
        needsReload: false,
      };
    }
    return {
      lamp: 'blocked',
      title: '还不能读',
      detail: error,
      canStart: false,
      needsReload: false,
    };
  }

  if (ping.reading) {
    return {
      lamp: 'reading',
      title: '正在读取',
      detail: '可以关掉这个窗口。',
      canStart: false,
      needsReload: false,
    };
  }

  const code = ping.failureCode;
  if (code === 'login_required' || code === 'access_restricted' || code === 'page_error') {
    const [title, detail] = PAGE_BLOCKS[code];
    return { lamp: 'blocked', title, detail, canStart: false, needsReload: code === 'page_error', pageBlocked: true, failureCode: code };
  }

  if (!ping.isLikesPage) {
    return {
      lamp: 'wait',
      title: '这不是点赞或收藏页',
      detail: '打开点赞，或点下面的「打开X收藏」。',
      canStart: false,
      needsReload: false,
    };
  }

  if (!ping.articlesCount) {
    return {
      lamp: 'wait',
      title: '列表还是空的',
      detail: '等它加载，或点「刷新」。没登录的话这里不会有帖子。',
      canStart: false,
      needsReload: true,
    };
  }

  return {
    lamp: 'ready',
    title: '可以开始读取',
    detail: `已看到 ${ping.articlesCount} 条。往下滚，数字会继续增加。`,
    canStart: true,
    needsReload: false,
  };
}
