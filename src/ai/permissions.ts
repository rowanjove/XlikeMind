import { isLocalEndpoint } from './openaiClient';

export interface ApiAccess {
  ok: boolean;
  message: string;
}

function parsedOrigin(baseUrl: string): { parsed: URL } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    return { error: 'API Base URL 无效' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'API Base URL 只允许 http 或 https' };
  }
  if (parsed.protocol === 'http:' && !isLocalEndpoint(parsed.toString())) {
    return { error: '云端接口只允许 https。本地或局域网模型才可以使用 http。' };
  }
  return { parsed };
}

/** localhost 和 127.0.0.1 已在安装权限里，不必再弹一次授权。 */
export function manifestCoversApi(baseUrl: string): boolean {
  const origin = parsedOrigin(baseUrl);
  if ('error' in origin) return false;
  const host = origin.parsed.hostname;
  return origin.parsed.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1');
}

export function apiOriginPattern(baseUrl: string): string {
  const origin = parsedOrigin(baseUrl);
  if ('error' in origin) throw new Error(origin.error);
  return `${origin.parsed.origin}/*`;
}

/**
 * Ask Chrome for the one API origin the user just chose.
 * Call this directly from a click handler. permissions.request must run
 * before any other await, or Chrome drops the user gesture.
 */
export async function requestApiAccess(baseUrl: string): Promise<ApiAccess> {
  const origin = parsedOrigin(baseUrl);
  if ('error' in origin) return { ok: false, message: origin.error };
  if (manifestCoversApi(baseUrl)) return { ok: true, message: '' };
  if (typeof chrome === 'undefined' || !chrome.permissions?.request) return { ok: true, message: '' };

  try {
    const granted = await chrome.permissions.request({ origins: [apiOriginPattern(baseUrl)] });
    if (!granted) return { ok: false, message: '没有允许扩展访问这个 API 地址，整理已取消。' };
    return { ok: true, message: '' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : '无法申请 API 地址权限' };
  }
}

/** Reject a send when the extension still cannot reach the saved API origin. */
export async function assertApiAccess(baseUrl: string): Promise<void> {
  const origin = parsedOrigin(baseUrl);
  if ('error' in origin) throw new Error(origin.error);
  if (manifestCoversApi(baseUrl)) return;
  if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return;
  const allowed = await chrome.permissions.contains({ origins: [apiOriginPattern(baseUrl)] });
  if (!allowed) {
    throw new Error('扩展还不能访问这个 API 地址。请在设置里点一次测试连接，并允许访问。');
  }
}
