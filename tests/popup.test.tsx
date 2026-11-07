import * as libraryFolder from '../src/export/libraryFolder';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Popup } from '../src/ui/Popup';
import { LIVE_SYNC_KEY } from '../src/sync/liveSync';
import { db, getProfileDatabase } from '../src/storage/db';
import { createProfile, DEFAULT_PROFILE_ID, getProfile, profileStorageKey, updateProfile } from '../src/storage/profiles';
import type { NormalizedPost } from '../src/domain/types';

function samplePost(id: string): NormalizedPost {
  return {
    id: `x:${id}`,
    platform: 'x',
    postId: id,
    canonicalUrl: `https://x.com/user/status/${id}`,
    text: id,
    postedAt: null,
    likedAt: null,
    firstObservedAt: '2026-10-01T00:00:00.000Z',
    lastObservedAt: '2026-10-01T00:00:00.000Z',
    captureStatus: 'complete',
    missingFields: [],
    externalLinks: [],
    mediaIds: [],
    contentHash: id,
    sourceAdapter: 'x_dom',
    sourceRunId: 'popup-test',
    schemaVersion: 1,
  };
}

describe('Popup reading controls', () => {
  it('shows the lamp, local-folder guidance and opens the sync console', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://x.com/i/history/likes' },
    ] as chrome.tabs.Tab[]);
    vi.mocked(chrome.tabs.sendMessage).mockImplementation((async (...args: unknown[]) => {
      const message = args[1] as { type?: string } | undefined;
      if (message?.type === 'PING') {
        return {
          status: 'ok',
          isLikesPage: true,
          articlesCount: 4,
          reading: false,
          url: 'https://x.com/i/history/likes',
        };
      }
      return { status: 'ok' };
    }) as typeof chrome.tabs.sendMessage);

    render(<Popup />);

    expect(await screen.findByText('可以开始读取')).toBeTruthy();
    expect((screen.getByLabelText('本次扫描上限') as HTMLSelectElement).value).toBe('100');
    expect(await screen.findByRole('button', { name: '未绑定' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '同步详情与历史' }));
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://mock-extension-id/dashboard.html?profile=default#sync',
    });
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const saveImages = screen.getByRole('checkbox', { name: '保存图片' }) as HTMLInputElement;
    expect(saveImages.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '打开完整设置' }));
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://mock-extension-id/dashboard.html?profile=default#settings',
    });

    expect(screen.queryByRole('button', { name: '开始读取' })).toBeNull();
    expect(screen.getByText('还没读到用户名')).toBeTruthy();
  });

  it('starts a fresh capture directly from the popup with the selected quota', async () => {
    mockSignedIn('');
    const folder = vi.spyOn(libraryFolder, 'getLibraryFolder').mockResolvedValue({
      id: 'fixture-folder', handle: { name: '文库', queryPermission: async () => 'granted' } as unknown as FileSystemDirectoryHandle,
    });
    try {
      render(<Popup />);
      const start = await screen.findByRole('button', { name: '开始同步' });
      await waitFor(() => expect(start).toHaveProperty('disabled', false));
      fireEvent.change(screen.getByLabelText('本次扫描上限'), { target: { value: 'custom' } });
      fireEvent.change(screen.getByLabelText('自定义条数'), { target: { value: '0' } });
      const messagesBeforeInvalid = vi.mocked(chrome.tabs.sendMessage).mock.calls.length;
      fireEvent.click(start);
      await screen.findByText(/整数扫描上限/);
      expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.slice(messagesBeforeInvalid)
        .some(([, message]) => (message as { type?: string }).type === 'START_READING')).toBe(false);
      fireEvent.change(screen.getByLabelText('本次扫描上限'), { target: { value: '20' } });
      const opened = vi.mocked(chrome.tabs.create).mock.calls.length;
      fireEvent.click(start);
      await waitFor(() => expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
        type: 'START_READING', limit: 20, profileId: 'default',
      })));
      expect(chrome.tabs.create).toHaveBeenCalledTimes(opened);
    } finally {
      folder.mockRestore();
    }
  });

  it('distinguishes unreadable counts from an empty library and recovers on the next poll', async () => {
    await db.posts.put(samplePost('summary'));
    const readCount = vi.spyOn(db.posts, 'count').mockRejectedValueOnce(new Error('IndexedDB read failed'));
    try {
      render(<Popup />);
      expect(await screen.findByText(/无法读取文库概况/)).toBeTruthy();
      expect(screen.getAllByText('—', { selector: 'dd' })).toHaveLength(2);
      expect(await screen.findByText('1', { selector: 'dd' }, { timeout: 3000 })).toBeTruthy();
    } finally {
      readCount.mockRestore();
      await db.posts.delete('x:summary');
    }
  });

  it('shows the signed-in account library instead of the page library', async () => {
    const profile = await createProfile('Bob 的文库');
    await updateProfile(profile.id, 'Bob 的文库', '@bob_user');
    const database = getProfileDatabase(profile.id);
    await database.posts.bulkPut([samplePost('bob-1'), samplePost('bob-2'), samplePost('bob-3')]);
    await database.folders.put({
      id: profileStorageKey('knowledge-library', profile.id),
      handle: { name: 'Bob 文件夹' } as FileSystemDirectoryHandle,
      boundAt: '2026-10-01T00:00:00.000Z',
    });
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://x.com/i/history/likes' },
    ] as chrome.tabs.Tab[]);
    vi.mocked(chrome.tabs.sendMessage).mockImplementation((async (...args: unknown[]) => {
      const message = args[1] as { type?: string } | undefined;
      if (message?.type === 'PING') {
        return { status: 'ok', isLikesPage: true, articlesCount: 1, reading: false, xHandle: 'Bob_User', url: 'https://x.com/bob_user' };
      }
      return { status: 'ok' };
    }) as typeof chrome.tabs.sendMessage);

    try {
      render(<Popup />);
      expect(await screen.findByText('@bob_user')).toBeTruthy();
      expect(await screen.findByText('已绑定')).toBeTruthy();
      expect(await screen.findByText('3', { selector: 'dd' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '打开文库' }));
      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: `chrome-extension://mock-extension-id/dashboard.html?profile=${profile.id}#library`,
      });
    } finally {
      await database.delete();
    }
  });

  it('does not show another account library when the signed-in user has none', async () => {
    await updateProfile(DEFAULT_PROFILE_ID, '我的文库', '@alice_user');
    await db.posts.put(samplePost('alice-only'));
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://x.com/i/history/likes' },
    ] as chrome.tabs.Tab[]);
    vi.mocked(chrome.tabs.sendMessage).mockImplementation((async (...args: unknown[]) => {
      const message = args[1] as { type?: string } | undefined;
      if (message?.type === 'PING') {
        return { status: 'ok', isLikesPage: true, articlesCount: 1, reading: false, xHandle: 'carol_user', url: 'https://x.com/carol_user' };
      }
      return { status: 'ok' };
    }) as typeof chrome.tabs.sendMessage);

    try {
      render(<Popup />);
      expect(await screen.findByText('@carol_user')).toBeTruthy();
      expect(screen.getByRole('button', { name: '新建文库' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /修改「/ })).toBeNull();
      expect(screen.getByRole('button', { name: '未绑定' })).toBeTruthy();
      expect(screen.getAllByText('0', { selector: 'dd' })).toHaveLength(2);
      expect((screen.getByRole('button', { name: '打开文库' }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('button', { name: '同步详情与历史' }) as HTMLButtonElement).disabled).toBe(true);
    } finally {
      await db.posts.delete('x:alice-only');
      await updateProfile(DEFAULT_PROFILE_ID, '我的文库', '');
    }
  });

  function mockSignedIn(handle: string) {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://x.com/i/history/likes' },
    ] as chrome.tabs.Tab[]);
    vi.mocked(chrome.tabs.sendMessage).mockImplementation((async (...args: unknown[]) => {
      const message = args[1] as { type?: string } | undefined;
      if (message?.type === 'PING') {
        return { status: 'ok', isLikesPage: true, articlesCount: 1, reading: false, xHandle: handle, url: `https://x.com/${handle}` };
      }
      return { status: 'ok' };
    }) as typeof chrome.tabs.sendMessage);
  }

  it('changes the shown library username from the account row', async () => {
    const profile = await createProfile('弹出改绑', '@popup_edit');
    mockSignedIn('popup_edit');
    render(<Popup />);

    expect(await screen.findByText('@popup_edit')).toBeTruthy();
    const editBinding = screen.getByRole('button', { name: '修改「弹出改绑」' });
    expect(editBinding.textContent).toContain('弹出改绑');
    fireEvent.click(editBinding);
    const name = await screen.findByLabelText('文库名称') as HTMLInputElement;
    expect(name.value).toBe('弹出改绑');
    const input = screen.getByLabelText('绑定 X 用户名（可选）') as HTMLInputElement;
    expect(input.value).toBe('@popup_edit');
    fireEvent.change(input, { target: { value: '@Popup_Next' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      expect((await getProfile(profile.id))?.xHandle).toBe('popup_next');
      expect(screen.getByText('「弹出改绑」已绑定 @popup_next')).toBeTruthy();
    });
    expect((await getProfile(profile.id))?.name).toBe('弹出改绑');
  });

  it('keeps the popup binding when the username is already used', async () => {
    await createProfile('已占用弹出', '@popup_taken');
    const profile = await createProfile('待改弹出', '@popup_keep');
    mockSignedIn('popup_keep');
    render(<Popup />);

    expect(await screen.findByText('@popup_keep')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '修改「待改弹出」' }));
    fireEvent.change(await screen.findByLabelText('绑定 X 用户名（可选）'), { target: { value: 'popup_taken' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/已经绑定「已占用弹出」/)).toBeTruthy();
    expect((await getProfile(profile.id))?.xHandle).toBe('popup_keep');
    expect(screen.getByLabelText('绑定 X 用户名（可选）')).toBeTruthy();
  });

  it('clears the popup library binding when the username is emptied', async () => {
    const profile = await createProfile('可清空弹出', '@popup_clear');
    mockSignedIn('popup_clear');
    render(<Popup />);

    expect(await screen.findByText('@popup_clear')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '修改「可清空弹出」' }));
    fireEvent.change(await screen.findByLabelText('绑定 X 用户名（可选）'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      expect((await getProfile(profile.id))?.xHandle).toBeUndefined();
      expect(screen.getByText('已解除「可清空弹出」的绑定')).toBeTruthy();
    });
  });

  it('renames the shown library from the account row', async () => {
    const profile = await createProfile('弹出旧名', '@popup_rename');
    mockSignedIn('popup_rename');
    render(<Popup />);

    expect(await screen.findByText('@popup_rename')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '修改「弹出旧名」' }));
    const name = await screen.findByLabelText('文库名称') as HTMLInputElement;
    expect(name.value).toBe('弹出旧名');
    fireEvent.change(name, { target: { value: '  弹出新名  ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      expect((await getProfile(profile.id))?.name).toBe('弹出新名');
      expect(screen.getByText('「弹出新名」已绑定 @popup_rename')).toBeTruthy();
    });
    expect((await getProfile(profile.id))?.xHandle).toBe('popup_rename');
  });

  it('keeps the popup library name when the new name is empty', async () => {
    const profile = await createProfile('弹出保留名', '@popup_blank');
    mockSignedIn('popup_blank');
    render(<Popup />);

    expect(await screen.findByText('@popup_blank')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '修改「弹出保留名」' }));
    fireEvent.change(await screen.findByLabelText('文库名称'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/1–48/)).toBeTruthy();
    expect((await getProfile(profile.id))?.name).toBe('弹出保留名');
    expect((await getProfile(profile.id))?.xHandle).toBe('popup_blank');
    expect(screen.getByLabelText('文库名称')).toBeTruthy();
  });

  it('pauses the capture that is already reading', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 7, url: 'https://x.com/i/history/likes' },
    ] as chrome.tabs.Tab[]);
    vi.mocked(chrome.tabs.sendMessage).mockImplementation((async (...args: unknown[]) => {
      const message = args[1] as { type?: string } | undefined;
      if (message?.type === 'PING') {
        return { status: 'ok', isLikesPage: true, articlesCount: 4, reading: true, url: 'https://x.com/i/history/likes' };
      }
      return { status: 'paused' };
    }) as typeof chrome.tabs.sendMessage);

    render(<Popup />);
    fireEvent.click(await screen.findByRole('button', { name: '暂停' }));
    await waitFor(() => {
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ type: 'PAUSE_READING' })
      );
    });
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull();
  });

  function pausedPopupRun() {
    return {
      id: 'run-popup-paused',
      startedAt: '2026-11-05T00:00:00.000Z',
      lastCheckpointAt: '2026-11-05T00:02:00.000Z',
      status: 'paused' as const,
      stats: { scanned: 4, added: 2, updated: 0, skipped: 0, failed: 0 },
      failureMessage: '采集已暂停，检查点还在。可以继续，也可以结束这次采集。',
      targetLimit: 50,
      downloadMedia: true,
      adapterType: 'x_dom' as const,
      cursor: 'continue',
    };
  }

  async function showPausedPopup(): Promise<void> {
    const run = pausedPopupRun();
    await db.syncRuns.put(run);
    await chrome.storage.local.set({
      [profileStorageKey(LIVE_SYNC_KEY, DEFAULT_PROFILE_ID)]: {
        runId: run.id,
        status: 'paused',
        scanned: 4,
        added: 2,
        updated: 0,
        skipped: 0,
        failed: 0,
        targetLimit: 50,
        message: run.failureMessage,
        updatedAt: '2026-11-05T00:02:00.000Z',
      },
    });
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 7, url: 'https://x.com/i/history/likes' },
    ] as chrome.tabs.Tab[]);
    vi.mocked(chrome.tabs.sendMessage).mockImplementation((async (...args: unknown[]) => {
      const message = args[1] as { type?: string } | undefined;
      if (message?.type === 'PING') {
        return { status: 'ok', isLikesPage: true, articlesCount: 4, reading: false, url: 'https://x.com/i/history/likes' };
      }
      return { started: true };
    }) as typeof chrome.tabs.sendMessage);
  }

  it('continues a paused bookmark capture from the popup even with the likes tab active', async () => {
    await showPausedPopup();
    await db.syncRuns.update('run-popup-paused', { source: 'x_bookmarks' });
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 7, url: 'https://x.com/i/history/likes' },
      { id: 8, url: 'https://x.com/i/bookmarks' },
    ] as chrome.tabs.Tab[]);
    try {
      render(<Popup />);
      expect(await screen.findByText('已暂停')).toBeTruthy();
      fireEvent.click(await screen.findByRole('button', { name: '继续采集' }));
      await waitFor(() => {
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
          8,
          expect.objectContaining({ type: 'START_READING', limit: 50, profileId: DEFAULT_PROFILE_ID })
        );
      });
      expect(await screen.findByRole('button', { name: '暂停' })).toBeTruthy();
      expect((await db.syncRuns.get('run-popup-paused'))?.status).toBe('paused');
    } finally {
      await db.syncRuns.delete('run-popup-paused');
      await chrome.storage.local.set({
        [profileStorageKey(LIVE_SYNC_KEY, DEFAULT_PROFILE_ID)]: { status: 'completed', updatedAt: '2026-11-05T00:03:00.000Z' },
      });
    }
  });

  it('keeps the paused capture when the likes page does not answer', async () => {
    await showPausedPopup();
    vi.mocked(chrome.tabs.sendMessage).mockImplementation((async (...args: unknown[]) => {
      const message = args[1] as { type?: string } | undefined;
      if (message?.type === 'PING') {
        return { status: 'ok', isLikesPage: true, articlesCount: 4, reading: false, url: 'https://x.com/i/history/likes' };
      }
      if (message?.type === 'START_READING') {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      return { started: true };
    }) as typeof chrome.tabs.sendMessage);
    try {
      render(<Popup />);
      fireEvent.click(await screen.findByRole('button', { name: '继续采集' }));
      expect(await screen.findByText('点赞页没有响应。这次采集仍暂停，可以先点「刷新」。')).toBeTruthy();
      expect(screen.getByText('已暂停')).toBeTruthy();
      expect(screen.getByRole('button', { name: '继续采集' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: '暂停' })).toBeNull();
      expect((await db.syncRuns.get('run-popup-paused'))?.status).toBe('paused');
      expect((await db.syncRuns.get('run-popup-paused'))?.cursor).toBe('continue');
    } finally {
      await db.syncRuns.delete('run-popup-paused');
      await chrome.storage.local.set({
        [profileStorageKey(LIVE_SYNC_KEY, DEFAULT_PROFILE_ID)]: { status: 'completed', updatedAt: '2026-11-05T00:03:00.000Z' },
      });
    }
  });

  it('does not reload an authentication page while a capture is paused', async () => {
    await showPausedPopup();
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 7, url: 'https://x.com/account/access' },
    ] as chrome.tabs.Tab[]);
    const reload = vi.fn();
    chrome.tabs.reload = reload as typeof chrome.tabs.reload;
    try {
      render(<Popup />);
      expect(await screen.findByText('请在 X 完成登录或账号验证，再回到原列表。')).toBeTruthy();
      expect((await screen.findByRole('button', { name: '继续采集' }) as HTMLButtonElement).disabled).toBe(true);
      const openedTabs = vi.mocked(chrome.tabs.create).mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: '刷新' }));
      await screen.findByRole('button', { name: '刷新' });
      expect(reload).not.toHaveBeenCalled();
      expect(chrome.tabs.create).toHaveBeenCalledTimes(openedTabs);
      expect(await db.syncRuns.get('run-popup-paused')).toMatchObject({ status: 'paused', cursor: 'continue' });
    } finally {
      delete (chrome.tabs as { reload?: unknown }).reload;
      await db.syncRuns.delete('run-popup-paused');
    }
  });

  it('reloads the likes page while paused without ending the capture', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue({ id: 7, status: 'complete' });
    chrome.tabs.reload = reload as typeof chrome.tabs.reload;
    chrome.tabs.get = get as typeof chrome.tabs.get;
    await showPausedPopup();
    try {
      render(<Popup />);
      expect(await screen.findByRole('button', { name: '继续采集' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '刷新' }));
      await waitFor(() => {
        expect(reload).toHaveBeenCalledWith(7);
      });
      expect(await screen.findByRole('button', { name: '刷新' }, { timeout: 3000 })).toBeTruthy();
      expect(screen.getByText('已暂停')).toBeTruthy();
      expect(screen.getByRole('button', { name: '继续采集' })).toBeTruthy();
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(
        7,
        expect.objectContaining({ type: 'STOP_READING' })
      );
      expect((await db.syncRuns.get('run-popup-paused'))?.status).toBe('paused');
      expect((await db.syncRuns.get('run-popup-paused'))?.cursor).toBe('continue');
    } finally {
      delete (chrome.tabs as { reload?: unknown }).reload;
      delete (chrome.tabs as { get?: unknown }).get;
      await db.syncRuns.delete('run-popup-paused');
      await chrome.storage.local.set({
        [profileStorageKey(LIVE_SYNC_KEY, DEFAULT_PROFILE_ID)]: { status: 'completed', updatedAt: '2026-11-05T00:03:00.000Z' },
      });
    }
  });

  it('ends a paused capture from the popup and keeps the checkpoint', async () => {
    await showPausedPopup();
    try {
      render(<Popup />);
      expect(await screen.findByRole('button', { name: '继续采集' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '停止' }));
      await waitFor(async () => {
        expect((await db.syncRuns.get('run-popup-paused'))?.status).toBe('cancelled');
      });
      expect((await db.syncRuns.get('run-popup-paused'))?.cursor).toBe('continue');
      expect(await screen.findByRole('button', { name: '刷新' })).toBeTruthy();
    } finally {
      await db.syncRuns.delete('run-popup-paused');
      await chrome.storage.local.set({
        [profileStorageKey(LIVE_SYNC_KEY, DEFAULT_PROFILE_ID)]: { status: 'completed', updatedAt: '2026-11-05T00:03:00.000Z' },
      });
    }
  });
});
