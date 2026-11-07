import { describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from '../src/ui/App';
import { DashboardPage } from '../src/ui/pages/DashboardPage';
import { db } from '../src/storage/db';
import { SyncService } from '../src/sync/syncService';
import { PROMPT_VERSION } from '../src/domain/analysis';
import { aiService } from '../src/ai/aiService';
import { SettingsPage } from '../src/ui/pages/SettingsPage';

describe('Dashboard UI smoke', () => {
  it('distinguishes a failed library read from an empty library and lets the user retry', async () => {
    const read = vi.spyOn(db.posts, 'toArray').mockRejectedValueOnce(new Error('fixture read failed'));
    window.location.hash = '#library';
    try {
      render(<App />);
      expect(screen.getByText('正在读取本地文库…')).toBeTruthy();
      expect(await screen.findByText('无法读取本地文库。')).toBeTruthy();
      expect(screen.queryByText('文库还是空的')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '重试读取' }));
      expect(await screen.findByText('文库还是空的')).toBeTruthy();
    } finally {
      cleanup();
      read.mockRestore();
      window.location.hash = '';
    }
  });
  it('blocks settings actions while the saved AI configuration is unavailable', async () => {
    const read = vi.spyOn(aiService, 'getConfig').mockRejectedValueOnce(new Error('fixture read failure'));
    const save = vi.spyOn(aiService, 'saveConfig');
    try {
      render(<SettingsPage onOpenDiagnostics={() => {}} />);
      expect((screen.getByRole('group', { name: '模型与整理' }) as HTMLFieldSetElement).disabled).toBe(true);
      expect((await screen.findByRole('alert')).textContent).toContain('无法读取 AI 设置');
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      expect(save).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      save.mockRestore();
    }
  });

  it('keeps the draft AI connection and reports a rejected settings write', async () => {
    const before = await aiService.getConfig();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
    ));
    vi.stubGlobal('fetch', fetchMock);
    const save = vi.spyOn(aiService, 'saveConfig').mockRejectedValueOnce(new Error('private fixture details'));
    try {
      render(<SettingsPage onOpenDiagnostics={() => {}} />);
      const model = await screen.findByLabelText('模型名称');
      await act(async () => { await Promise.resolve(); });
      fireEvent.change(screen.getByLabelText(/接口地址/), { target: { value: 'http://localhost:11434/v1' } });
      fireEvent.change(model, { target: { value: 'unsaved-fixture-model' } });
      fireEvent.click(screen.getByRole('button', { name: '试一下连接' }));
      await screen.findByText(/连接成功/);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ model: 'unsaved-fixture-model' });
      expect(await aiService.getConfig()).toEqual(before);
      expect(save).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      expect((await screen.findByRole('alert')).textContent).toBe('AI 设置未能保存，请重试。');
      expect(screen.queryByRole('button', { name: '已保存' })).toBeNull();
      expect((model as HTMLInputElement).value).toBe('unsaved-fixture-model');
    } finally {
      save.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it('distinguishes pending AI work from current summaries and failed records', async () => {
    const service = new SyncService();
    const [stale, failed, complete] = await Promise.all(['9011', '9012', '9013'].map(async (postId) =>
      (await service.normalizeItem({ postId, text: 'A sufficiently long fixture article' }, 'fixture', 'fixture')).post,
    ));
    const analyses = [stale, failed, complete].map((post) => ({
      postId: post.id, sourceHash: post === stale ? 'old-source' : post.contentHash,
      status: post === failed ? 'failed' as const : 'complete' as const,
      model: 'fixture', promptVersion: PROMPT_VERSION, categories: [], tags: [],
    }));
    const image = { id: 'dashboard-failed-image', postId: failed.id, position: 0, kind: 'image' as const,
      status: 'failed' as const, sourceUrl: 'https://pbs.twimg.com/media/fixture.png' };
    try {
      await db.aiAnalysis.bulkPut(analyses);
      await db.media.put(image);
      render(<DashboardPage posts={[stale, failed, complete]} latestRun={null}
        onNavigateTab={() => undefined} onViewPostDetails={() => undefined} onDeletePost={() => undefined} />);
      await screen.findByText('图片 1 · AI 1 · 最近同步 0');
      expect(screen.getByText('待 AI 分析').closest('.lm-metric-card')?.textContent).toContain('待 AI 分析1');
      expect(screen.getByText('失败项').closest('.lm-metric-card')?.textContent).toContain('失败项2');
    } finally {
      cleanup();
      await db.aiAnalysis.bulkDelete(analyses.map(({ postId }) => postId));
      await db.media.delete(image.id);
    }
  });

  it('renders the library and explains real capture and AI limits', async () => {
    window.location.hash = '';
    render(<App />);

    expect(screen.queryByRole('button', { name: /载入示例/ })).toBeNull();
    expect(screen.queryByText(/示例/)).toBeNull();
    expect(await screen.findByRole('button', { name: '打开文库' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '打开文库' }));
    expect(await screen.findByRole('heading', { name: '文库' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '切换用户文库' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '主题归纳' })).toBeNull();
    expect(screen.getByRole('heading', { name: '文库还是空的' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: '示例' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '同步' }));
    expect(screen.getByText(/不代表点赞都收齐了/)).toBeTruthy();
    expect(screen.queryByText(/示例/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(screen.getByText(/图片不会上传/)).toBeTruthy();
    expect(screen.getByText(/离线整理，不连网/)).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    window.location.hash = '';
  });

  it('opens settings when the address hash is settings', async () => {
    window.location.hash = '#settings';
    render(<App />);
    expect(screen.getByText(/图片不会上传/)).toBeTruthy();
    window.location.hash = '';
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  });
});
