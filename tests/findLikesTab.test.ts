import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_LIKES_URL, findXLikesTab, isArchiveUrl, isBookmarksUrl, normalizeLikesEntry } from '../src/adapters/findLikesTab';
import { getLikesEntry, saveLikesEntry } from '../src/storage/capturePreferences';

describe('findXLikesTab', () => {
  it('returns an open likes tab and ignores the home timeline', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValueOnce([
      { id: 4, url: 'https://x.com/home' },
      { id: 9, url: 'https://x.com/someone/likes' },
    ] as chrome.tabs.Tab[]);

    const tab = await findXLikesTab();
    expect(tab).toEqual({ id: 9, url: 'https://x.com/someone/likes' });
  });

  it('fails clearly when no likes tab is open', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValueOnce([
      { id: 4, url: 'https://x.com/home' },
    ] as chrome.tabs.Tab[]);

    await expect(findXLikesTab()).rejects.toThrow(/点赞页/);
  });

  it('treats bookmarks as a page the reader can open', () => {
    expect(isBookmarksUrl('https://x.com/i/bookmarks')).toBe(true);
    expect(isArchiveUrl('https://x.com/i/bookmarks')).toBe(true);
    expect(isArchiveUrl('https://x.com/someone/likes')).toBe(true);
    expect(isArchiveUrl('https://x.com/home')).toBe(false);
  });

  it('saves a validated entry per library and strips query and fragment data', async () => {
    const profileId = 'entry-fixture';
    expect(await getLikesEntry(profileId)).toBe(DEFAULT_LIKES_URL);
    expect(await saveLikesEntry(' https://x.com/ada/likes/?token=test#fragment ', profileId)).toBe('https://x.com/ada/likes');
    expect(await getLikesEntry(profileId)).toBe('https://x.com/ada/likes');
    expect(await getLikesEntry('another-fixture')).toBe(DEFAULT_LIKES_URL);
    for (const invalid of ['https://x.com/home', 'https://x.com/i/history/likes/elsewhere',
      'https://x.com.example.test/ada/likes', 'https://user@x.com/ada/likes', 'http://x.com/ada/likes']) {
      expect(normalizeLikesEntry(invalid)).toBeUndefined();
      await expect(saveLikesEntry(invalid, profileId)).rejects.toThrow('HTTPS 点赞页');
    }
    expect(await getLikesEntry(profileId)).toBe('https://x.com/ada/likes');
  });
});
