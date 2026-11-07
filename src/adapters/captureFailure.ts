export const CAPTURE_FAILURE_CODES = [
  'login_required', 'access_restricted', 'page_error', 'page_not_ready', 'parse_failed', 'time_limit', 'save_interrupted',
] as const;

export type CaptureFailureCode = typeof CAPTURE_FAILURE_CODES[number];

export function isCaptureFailureCode(value: unknown): value is CaptureFailureCode {
  return CAPTURE_FAILURE_CODES.some((code) => code === value);
}

export const CAPTURE_TIME_LIMIT_MS = 5 * 60 * 1000;
export const CAPTURE_TIME_LIMIT_MESSAGE = '本轮连续采集已达到 5 分钟，已自动暂停。检查点已保留，可以继续采集。';

export function isXAuthenticationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['x.com', 'twitter.com'].includes(url.host) &&
      /^\/(?:login|i\/flow\/login|account\/access)(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

/** Inspect explicit page notices only. Post text cannot establish an access failure. */
export function detectCaptureFailure(root: Document, pageUrl: string): {
  failureCode: CaptureFailureCode;
  error: string;
} | undefined {
  if (isXAuthenticationUrl(pageUrl)) {
    return { failureCode: 'login_required', error: 'X 需要登录或账号验证。请在 X 页面完成后再继续。' };
  }
  const notices = Array.from(root.querySelectorAll('[role="alert"], [data-testid="error-detail"], [data-testid="emptyState"]'))
    .filter((node) => !node.closest('article, [hidden], [aria-hidden="true"]') &&
      getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden');
  const text = notices.map((node) => {
    const notice = node.cloneNode(true) as Element;
    notice.querySelectorAll('article').forEach((post) => post.remove());
    return notice.textContent ?? '';
  }).join('\n');
  if (/rate limit exceeded|too many requests|请求过于频繁|超过.{0,8}(?:请求|频率)限制|访问次数.{0,8}限制/i.test(text)) {
    return { failureCode: 'access_restricted', error: 'X 页面提示请求频率受限。采集已停止，请稍后手动重试。' };
  }
  if (/log in to continue|sign in to continue|请.{0,4}登录|登录后.{0,6}(?:查看|继续)/i.test(text)) {
    return { failureCode: 'login_required', error: 'X 页面提示需要登录。请登录并刷新列表后再继续。' };
  }
  if (/something went wrong|failed to load|出错了|加载失败|出了点问题/i.test(text)) {
    return { failureCode: 'page_error', error: 'X 页面提示加载失败。已停止读取，请检查网络并刷新列表后重试。' };
  }
}
