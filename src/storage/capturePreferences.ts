import { DEFAULT_LIKES_URL, normalizeLikesEntry } from '../adapters/findLikesTab';
import { getPageProfileId, profileStorageKey } from './profileScope';

const LIKES_ENTRY_KEY = 'likemind_likes_entry';

export async function getLikesEntry(profileId = getPageProfileId()): Promise<string> {
  const key = profileStorageKey(LIKES_ENTRY_KEY, profileId);
  try {
    const values = typeof chrome === 'undefined' ? undefined : await chrome.storage?.local?.get?.(key);
    const value = values?.[key];
    return typeof value === 'string' ? normalizeLikesEntry(value) ?? DEFAULT_LIKES_URL : DEFAULT_LIKES_URL;
  } catch {
    return DEFAULT_LIKES_URL;
  }
}

export async function saveLikesEntry(value: string, profileId = getPageProfileId()): Promise<string> {
  const entry = normalizeLikesEntry(value);
  if (!entry) throw new Error('请输入 HTTPS 点赞页地址，例如 https://x.com/i/history/likes 或 https://x.com/用户名/likes（用户名请用实际账号）。');
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.set) throw new Error('请在扩展页面保存采集入口。');
  await chrome.storage.local.set({ [profileStorageKey(LIKES_ENTRY_KEY, profileId)]: entry });
  return entry;
}

export type CompletionBehavior = 'notice' | 'library' | 'none';

export async function getCompletionBehavior(profileId = getPageProfileId()): Promise<CompletionBehavior> {
  const key = profileStorageKey('likemind_sync_completion', profileId);
  const values = await chrome.storage.local.get(key);
  return values[key] === 'library' || values[key] === 'none' ? values[key] : 'notice';
}

export async function saveCompletionBehavior(value: CompletionBehavior, profileId = getPageProfileId()): Promise<void> {
  await chrome.storage.local.set({ [profileStorageKey('likemind_sync_completion', profileId)]: value });
}
