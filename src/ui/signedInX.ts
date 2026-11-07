import { normalizeXHandle } from '../adapters/xAccount';

export type OpenXAccount =
  | { status: 'known'; handle: string }
  | { status: 'closed' }
  | { status: 'unknown' }
  | { status: 'conflict' };

interface AccountPing {
  status?: string;
  xHandle?: string;
}

function isXUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const page = new URL(url);
    return page.protocol === 'https:' && (page.hostname === 'x.com' || page.hostname === 'twitter.com');
  } catch {
    return false;
  }
}

async function pingHandle(tabId: number): Promise<string | null | undefined> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type: 'PING' })) as AccountPing | undefined;
    if (!res || res.status !== 'ok') return undefined;
    if (typeof res.xHandle !== 'string') return null;
    return normalizeXHandle(res.xHandle) ?? null;
  } catch {
    return undefined;
  }
}

/** Read the signed-in username from open X tabs. Conflicting accounts stay unnamed. */
export async function readOpenXAccount(): Promise<OpenXAccount> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query || !chrome.tabs.sendMessage) return { status: 'unknown' };
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  const open = Array.isArray(tabs) ? tabs.filter((tab) => typeof tab.id === 'number') : [];
  if (open.length === 0) return { status: 'closed' };

  const [active] = chrome.tabs.query ? await chrome.tabs.query({ active: true, currentWindow: true }) : [];
  const activeTab = active && isXUrl(active.url) && typeof active.id === 'number'
    ? open.find((tab) => tab.id === active.id)
    : undefined;
  if (activeTab?.id) {
    const activeHandle = await pingHandle(activeTab.id);
    if (activeHandle) return { status: 'known', handle: activeHandle };
  }

  const handles = new Set<string>();
  for (const tab of open) {
    if (tab.id === activeTab?.id || typeof tab.id !== 'number') continue;
    const handle = await pingHandle(tab.id);
    if (handle) handles.add(handle);
  }
  if (handles.size > 1) return { status: 'conflict' };
  const only = handles.values().next().value;
  if (handles.size === 1 && only) return { status: 'known', handle: only };
  return { status: 'unknown' };
}
