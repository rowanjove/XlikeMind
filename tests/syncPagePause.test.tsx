import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LIVE_SYNC_KEY } from '../src/sync/liveSync';
import { db } from '../src/storage/db';
import { getPageProfileId, profileStorageKey } from '../src/storage/profileScope';
import { SyncPage } from '../src/ui/pages/SyncPage';
import { getLikesEntry, saveLikesEntry } from '../src/storage/capturePreferences';

const pausedRun = {
  id: 'run-page-paused',
  startedAt: '2026-11-05T00:00:00.000Z',
  lastCheckpointAt: '2026-11-05T00:02:00.000Z',
  status: 'paused' as const,
  stats: { scanned: 4, added: 3, updated: 0, skipped: 1, failed: 0 },
  failureMessage: '采集已暂停，检查点还在。可以继续，也可以结束这次采集。',
  targetLimit: 50,
  downloadMedia: true,
  adapterType: 'x_dom' as const,
  cursor: 'continue',
};

afterEach(async () => {
  cleanup();
  await db.syncRuns.delete(pausedRun.id);
  await chrome.storage.local.set({
    [profileStorageKey(LIVE_SYNC_KEY, getPageProfileId())]: { status: 'completed', updatedAt: new Date().toISOString() },
  });
});

it('opens the configured likes entry and defaults to 100 posts for a new run', async () => {
  const original = await getLikesEntry();
  await saveLikesEntry('https://x.com/fixture/likes');
  try {
    render(<SyncPage folderName="文库" />);
    fireEvent.click(screen.getByRole('button', { name: '打开 X 点赞' }));
    await waitFor(() => expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://x.com/fixture/likes' }));
    expect(screen.getByRole('option', { name: '100 条（默认）' })).toHaveProperty('selected', true);
  } finally {
    await saveLikesEntry(original);
  }
});

it('resumes bookmarks from the bookmarks tab when a likes tab is listed first', async () => {
  await db.syncRuns.put({ ...pausedRun, source: 'x_bookmarks' });
  vi.mocked(chrome.tabs.query).mockResolvedValueOnce([
    { id: 41, url: 'https://x.com/i/history/likes' },
    { id: 42, url: 'https://x.com/i/bookmarks' },
  ] as chrome.tabs.Tab[]);
  vi.mocked(chrome.tabs.sendMessage).mockResolvedValueOnce({
    status: 'ok', isLikesPage: true, articlesCount: 4, url: 'https://x.com/i/bookmarks',
  }).mockResolvedValueOnce({ started: true });
  render(<SyncPage folderName="文库" />);
  const button = await screen.findByRole('button', { name: '继续这次采集' });
  await waitFor(() => expect(button).toHaveProperty('disabled', false));
  fireEvent.click(button);
  await waitFor(() => expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, expect.objectContaining({
    type: 'START_READING', limit: 50,
  })));
});

it('locks the scan limit to the saved quota when resuming an interrupted run', async () => {
  await db.syncRuns.put({ ...pausedRun, targetLimit: 17, failureCode: 'interrupted' });
  render(<SyncPage folderName="文库" />);
  expect(await screen.findByText('恢复中断任务时沿用原上限 17 条。')).toBeTruthy();
  expect(screen.getByLabelText('本次最大扫描条数')).toHaveProperty('disabled', true);
  expect(screen.getByLabelText('本次最大扫描条数')).toHaveProperty('value', '17');
});

it('allows a custom scan limit and blocks values outside the supported range', async () => {
  const url = 'https://x.com/i/history/likes';
  vi.mocked(chrome.tabs.query).mockResolvedValueOnce([{ id: 77, url }] as chrome.tabs.Tab[]);
  vi.mocked(chrome.tabs.sendMessage).mockResolvedValueOnce({
    status: 'ok', isLikesPage: true, articlesCount: 4, url,
  }).mockResolvedValueOnce({ started: true });
  render(<SyncPage folderName="文库" />);
  const start = screen.getByRole('button', { name: '开始增量同步' }) as HTMLButtonElement;
  await waitFor(() => expect(start.disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('本次最大扫描条数'), { target: { value: 'custom' } });
  const input = screen.getByRole('spinbutton', { name: '自定义扫描条数' });
  fireEvent.change(input, { target: { value: '2001' } });
  expect(start.disabled).toBe(true);
  fireEvent.change(input, { target: { value: '17' } });
  fireEvent.click(start);
  await waitFor(() => expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(77,
    expect.objectContaining({ type: 'START_READING', limit: 17 })));
});

it('shows continue for a paused capture and ends it without deleting posts', async () => {
  await db.syncRuns.put({
    ...pausedRun,
    failureCode: 'interrupted',
    repairStats: { textAttempts: 2, textRecovered: 1, imageAttempts: 1, imagesRecovered: 1, remainingPosts: 1, remainingImages: 2 },
  });
  render(<SyncPage folderName="文库" />);

  expect(await screen.findByRole('button', { name: '继续这次采集' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '结束这次采集' })).toBeTruthy();
  expect(screen.getByText('已暂停')).toBeTruthy();
  expect(screen.getByText('补抓正文 1/2 篇 · 恢复图片 1/1 张')).toBeTruthy();
  expect(screen.getByText(/不完整帖子 1 篇 · 未归档图片记录 2 张/)).toBeTruthy();
  const diagnostics = within(screen.getByLabelText('当前任务诊断'));
  expect(await diagnostics.findByText('等待继续')).toBeTruthy();
  expect(await diagnostics.findByText('2 分 0 秒')).toBeTruthy();
  expect(diagnostics.getByText('正文 2 次 · 图片 1 次')).toBeTruthy();
  expect(diagnostics.getByText('interrupted')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: '结束这次采集' }));
  expect(await screen.findByRole('button', { name: '开始增量同步' })).toBeTruthy();
  await waitFor(async () => {
    expect((await db.syncRuns.get(pausedRun.id))?.status).toBe('cancelled');
  });
  expect((await db.syncRuns.get(pausedRun.id))?.cursor).toBe('continue');
});

it('keeps a paused capture when the likes page does not answer continue', async () => {
  await db.syncRuns.put(pausedRun);
  vi.mocked(chrome.tabs.sendMessage).mockImplementation((async (_tabId: unknown, message: unknown) => {
    const type = (message as { type?: string } | undefined)?.type;
    if (type === 'PING') {
      return { status: 'ok', isLikesPage: true, articlesCount: 4, reading: false, url: 'https://x.com/i/history/likes' };
    }
    if (type === 'START_READING') {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    }
    return { status: 'ok' };
  }) as typeof chrome.tabs.sendMessage);
  try {
    render(<SyncPage folderName="文库" />);
    await screen.findByRole('button', { name: '继续这次采集' });
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '继续这次采集' }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: '继续这次采集' }));
    expect(await screen.findByText('点赞页没有响应。这次采集仍暂停，请先刷新点赞页。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '继续这次采集' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '开始增量同步' })).toBeNull();
    expect(screen.getByText('已暂停')).toBeTruthy();
    expect((await db.syncRuns.get(pausedRun.id))?.status).toBe('paused');
    expect((await db.syncRuns.get(pausedRun.id))?.cursor).toBe('continue');
  } finally {
    vi.mocked(chrome.tabs.sendMessage).mockReset();
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ status: 'ok' });
  }
});

it('tells the user to open the likes page when a paused refresh is not on that page', async () => {
  await db.syncRuns.put(pausedRun);
  const reload = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockResolvedValue({ id: 1, status: 'complete' });
  chrome.tabs.reload = reload as typeof chrome.tabs.reload;
  chrome.tabs.get = get as typeof chrome.tabs.get;
  try {
    render(<SyncPage folderName="文库" />);
    await screen.findByRole('button', { name: '刷新点赞页' });
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '刷新点赞页' }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: '刷新点赞页' }));
    await waitFor(() => {
      expect(reload).toHaveBeenCalledWith(1);
    });
    expect(await screen.findByText('这不是点赞或收藏页。这次采集仍暂停，请先打开点赞页。', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText('打开点赞，或点下面的「打开X收藏」。')).toBeTruthy();
    expect(screen.queryByText('点赞页已重新载入。这次采集仍暂停。')).toBeNull();
    expect((screen.getByRole('button', { name: '继续这次采集' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('已暂停')).toBeTruthy();
    expect((await db.syncRuns.get(pausedRun.id))?.status).toBe('paused');
    expect((await db.syncRuns.get(pausedRun.id))?.cursor).toBe('continue');
  } finally {
    delete (chrome.tabs as { reload?: unknown }).reload;
    delete (chrome.tabs as { get?: unknown }).get;
  }
});

it('keeps the paused checkpoint when the original list redirects to login', async () => {
  await db.syncRuns.put({ ...pausedRun, source: 'x_bookmarks' });
  vi.mocked(chrome.tabs.query).mockResolvedValueOnce([
    { id: 1, url: 'https://x.com/i/flow/login' },
    { id: 2, url: 'https://x.com/i/history/likes' },
  ] as chrome.tabs.Tab[]);

  render(<SyncPage folderName="文库" />);
  expect(await screen.findByText('X 需要登录或验证')).toBeTruthy();
  expect((await screen.findByRole('button', { name: '继续这次采集' }) as HTMLButtonElement).disabled).toBe(true);
  expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(1, expect.objectContaining({ type: 'START_READING' }));
  expect(await db.syncRuns.get(pausedRun.id)).toMatchObject({ status: 'paused', cursor: 'continue' });
});

it('lets the user continue after a paused refresh already shows posts', async () => {
  await db.syncRuns.put(pausedRun);
  const reload = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockResolvedValue({ id: 1, status: 'complete' });
  chrome.tabs.reload = reload as typeof chrome.tabs.reload;
  chrome.tabs.get = get as typeof chrome.tabs.get;
  vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({
    status: 'ok',
    isLikesPage: true,
    articlesCount: 4,
    reading: false,
    url: 'https://x.com/i/history/likes',
  });
  try {
    render(<SyncPage folderName="文库" />);
    await screen.findByRole('button', { name: '刷新点赞页' });
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '刷新点赞页' }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: '刷新点赞页' }));
    await waitFor(() => {
      expect(reload).toHaveBeenCalledWith(1);
    });
    const status = await screen.findByText('点赞页已重新载入。这次采集仍暂停，可以继续。', {}, { timeout: 3000 });
    expect(status.textContent).toContain('可以继续');
    expect(status.textContent).toContain('这次采集仍暂停');
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '继续这次采集' }) as HTMLButtonElement).disabled).toBe(false);
    });
    const types = vi.mocked(chrome.tabs.sendMessage).mock.calls.map((call) => (call[1] as { type?: string } | undefined)?.type);
    expect(types).not.toContain('START_READING');
    expect(types).not.toContain('STOP_READING');
    expect(screen.getByText('已暂停')).toBeTruthy();
    expect((await db.syncRuns.get(pausedRun.id))?.status).toBe('paused');
    expect((await db.syncRuns.get(pausedRun.id))?.cursor).toBe('continue');
  } finally {
    delete (chrome.tabs as { reload?: unknown }).reload;
    delete (chrome.tabs as { get?: unknown }).get;
    vi.mocked(chrome.tabs.sendMessage).mockReset();
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ status: 'ok' });
  }
});

it('says the list is still empty after refreshing a paused capture', async () => {
  await db.syncRuns.put(pausedRun);
  const reload = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockResolvedValue({ id: 1, status: 'complete' });
  chrome.tabs.reload = reload as typeof chrome.tabs.reload;
  chrome.tabs.get = get as typeof chrome.tabs.get;
  vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({
    status: 'ok',
    isLikesPage: true,
    articlesCount: 0,
    reading: false,
    url: 'https://x.com/i/history/likes',
  });
  try {
    render(<SyncPage folderName="文库" />);
    await screen.findByRole('button', { name: '刷新点赞页' });
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '刷新点赞页' }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: '刷新点赞页' }));
    await waitFor(() => {
      expect(reload).toHaveBeenCalledWith(1);
    });
    expect(await screen.findByText('列表还是空的。这次采集仍暂停。', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText('列表还是空的。可以再点一次「刷新点赞页」。没登录的话这里不会有帖子。')).toBeTruthy();
    expect(screen.queryByText('点赞页已重新载入。这次采集仍暂停。')).toBeNull();
    expect((screen.getByRole('button', { name: '继续这次采集' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('已暂停')).toBeTruthy();
    expect((await db.syncRuns.get(pausedRun.id))?.status).toBe('paused');
    expect((await db.syncRuns.get(pausedRun.id))?.cursor).toBe('continue');
  } finally {
    delete (chrome.tabs as { reload?: unknown }).reload;
    delete (chrome.tabs as { get?: unknown }).get;
    vi.mocked(chrome.tabs.sendMessage).mockReset();
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ status: 'ok' });
  }
});

it('keeps the pause when a refreshed likes page still has no content script', async () => {
  await db.syncRuns.put(pausedRun);
  const reload = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockResolvedValue({ id: 1, status: 'complete' });
  chrome.tabs.reload = reload as typeof chrome.tabs.reload;
  chrome.tabs.get = get as typeof chrome.tabs.get;
  vi.mocked(chrome.tabs.sendMessage).mockRejectedValue(
    new Error('Could not establish connection. Receiving end does not exist.')
  );
  try {
    render(<SyncPage folderName="文库" />);
    await screen.findByRole('button', { name: '刷新点赞页' });
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '刷新点赞页' }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: '刷新点赞页' }));
    await waitFor(() => {
      expect(reload).toHaveBeenCalledWith(1);
    });
    expect(await screen.findByText(
      '内容脚本还没接上。这次采集仍暂停，可以再点一次「刷新点赞页」。',
      {},
      { timeout: 3000 }
    )).toBeTruthy();
    expect(screen.getByText('内容脚本还没接上。可以再点一次「刷新点赞页」。')).toBeTruthy();
    expect(screen.queryByText(/F5/)).toBeNull();
    expect(screen.getByRole('button', { name: '刷新点赞页' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '继续这次采集' })).toBeTruthy();
    expect(screen.getByText('已暂停')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '开始增量同步' })).toBeNull();
    expect((await db.syncRuns.get(pausedRun.id))?.status).toBe('paused');
    expect((await db.syncRuns.get(pausedRun.id))?.cursor).toBe('continue');
  } finally {
    delete (chrome.tabs as { reload?: unknown }).reload;
    delete (chrome.tabs as { get?: unknown }).get;
    vi.mocked(chrome.tabs.sendMessage).mockReset();
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ status: 'ok' });
  }
});

it('shows 刷新点赞页 in the detection text while a paused capture has no content script', async () => {
  await db.syncRuns.put(pausedRun);
  vi.mocked(chrome.tabs.sendMessage).mockRejectedValue(
    new Error('Could not establish connection. Receiving end does not exist.')
  );
  try {
    render(<SyncPage folderName="文库" />);
    expect(await screen.findByText('内容脚本还没接上。可以再点一次「刷新点赞页」。')).toBeTruthy();
    expect(screen.queryByText(/F5/)).toBeNull();
    expect(screen.getByRole('button', { name: '继续这次采集' })).toBeTruthy();
    expect((await db.syncRuns.get(pausedRun.id))?.status).toBe('paused');
  } finally {
    vi.mocked(chrome.tabs.sendMessage).mockReset();
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ status: 'ok' });
  }
});

it('replaces the generic retry hint while a paused capture gets no script answer', async () => {
  await db.syncRuns.put(pausedRun);
  vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ status: 'no' });
  try {
    render(<SyncPage folderName="文库" />);
    expect(await screen.findByText('内容脚本还没接上。可以再点一次「刷新点赞页」。')).toBeTruthy();
    expect(screen.queryByText(/请刷新该标签页重试/)).toBeNull();
    expect((await db.syncRuns.get(pausedRun.id))?.status).toBe('paused');
  } finally {
    vi.mocked(chrome.tabs.sendMessage).mockReset();
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ status: 'ok' });
  }
});

it('keeps the F5 hint when the content script is missing and no capture is paused', async () => {
  vi.mocked(chrome.tabs.sendMessage).mockRejectedValue(
    new Error('Could not establish connection. Receiving end does not exist.')
  );
  try {
    render(<SyncPage folderName="文库" />);
    expect(await screen.findByText(/按 F5 刷新/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '刷新点赞页' })).toBeNull();
  } finally {
    vi.mocked(chrome.tabs.sendMessage).mockReset();
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ status: 'ok' });
  }
});

it('updates the paused status line when 检测状态 reaches the content script', async () => {
  await db.syncRuns.put(pausedRun);
  let connected = false;
  vi.mocked(chrome.tabs.sendMessage).mockImplementation((async () => {
    if (!connected) {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    }
    return {
      status: 'ok',
      isLikesPage: true,
      articlesCount: 4,
      reading: false,
      url: 'https://x.com/i/history/likes',
    };
  }) as typeof chrome.tabs.sendMessage);
  try {
    render(<SyncPage folderName="文库" />);
    expect(await screen.findByRole('button', { name: '继续这次采集' })).toBeTruthy();
    const checkButton = () => screen.getByRole('button', { name: '检测状态' }) as HTMLButtonElement;
    await waitFor(() => expect(checkButton().disabled).toBe(false));
    fireEvent.click(checkButton());
    expect(await screen.findByText('内容脚本还没接上。这次采集仍暂停，可以再点一次「刷新点赞页」。')).toBeTruthy();
    connected = true;
    await waitFor(() => expect(checkButton().disabled).toBe(false));
    fireEvent.click(checkButton());
    expect(await screen.findByText('内容脚本已接上。这次采集仍暂停，可以继续。')).toBeTruthy();
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '继续这次采集' }) as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByText(/还没接上/)).toBeNull();
    expect(screen.queryByRole('button', { name: '开始增量同步' })).toBeNull();
    expect(screen.getByText('已暂停')).toBeTruthy();
    expect((await db.syncRuns.get(pausedRun.id))?.status).toBe('paused');
    expect((await db.syncRuns.get(pausedRun.id))?.cursor).toBe('continue');
  } finally {
    vi.mocked(chrome.tabs.sendMessage).mockReset();
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ status: 'ok' });
  }
});

it('keeps continue disabled when a paused capture sees an empty likes list', async () => {
  await db.syncRuns.put(pausedRun);
  vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({
    status: 'ok',
    isLikesPage: true,
    articlesCount: 0,
    reading: false,
    url: 'https://x.com/i/history/likes',
  });
  try {
    render(<SyncPage folderName="文库" />);
    expect(await screen.findByRole('button', { name: '继续这次采集' })).toBeTruthy();
    const checkButton = () => screen.getByRole('button', { name: '检测状态' }) as HTMLButtonElement;
    await waitFor(() => expect(checkButton().disabled).toBe(false));
    fireEvent.click(checkButton());
    expect(await screen.findByText('内容脚本已接上。这次采集仍暂停。')).toBeTruthy();
    expect(screen.queryByText('内容脚本已接上。这次采集仍暂停，可以继续。')).toBeNull();
    expect(screen.getByText('列表还是空的')).toBeTruthy();
    expect(screen.getByText('列表还是空的。可以再点一次「刷新点赞页」。没登录的话这里不会有帖子。')).toBeTruthy();
    expect(screen.queryByText(/或点「刷新」/)).toBeNull();
    expect((screen.getByRole('button', { name: '继续这次采集' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '开始增量同步' })).toBeNull();
    expect(screen.getByText('已暂停')).toBeTruthy();
    expect((await db.syncRuns.get(pausedRun.id))?.status).toBe('paused');
    expect((await db.syncRuns.get(pausedRun.id))?.cursor).toBe('continue');
  } finally {
    vi.mocked(chrome.tabs.sendMessage).mockReset();
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ status: 'ok' });
  }
});

it('keeps the shared empty-list hint when no capture is paused', async () => {
  vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({
    status: 'ok',
    isLikesPage: true,
    articlesCount: 0,
    reading: false,
    url: 'https://x.com/i/history/likes',
  });
  try {
    render(<SyncPage folderName="文库" />);
    expect(await screen.findByText(/或点「刷新」/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '刷新点赞页' })).toBeNull();
  } finally {
    vi.mocked(chrome.tabs.sendMessage).mockReset();
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ status: 'ok' });
  }
});

it('offers pause while a capture is running', async () => {
  await chrome.storage.local.set({
    [profileStorageKey(LIVE_SYNC_KEY, getPageProfileId())]: {
      runId: 'run-live',
      status: 'running',
      scanned: 2,
      added: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
      targetLimit: 50,
      updatedAt: new Date().toISOString(),
    },
  });
  render(<SyncPage folderName="文库" />);

  expect(await screen.findByRole('button', { name: '暂停' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '刷新点赞页' })).toBeNull();
  expect(await screen.findByText('这不是点赞或收藏页')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '暂停' }));
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
    expect.any(Number),
    expect.objectContaining({ type: 'PAUSE_READING' })
  );
  expect(await screen.findByText(/正在暂停/)).toBeTruthy();
});
