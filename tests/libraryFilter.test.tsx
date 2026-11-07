import Dexie from 'dexie';
import { PROMPT_VERSION } from '../src/domain/analysis';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import JSZip from 'jszip';
import { Blob as NodeBlob } from 'node:buffer';
import type { AIAnalysis, NormalizedPost } from '../src/domain/types';
import { LibraryPage } from '../src/ui/pages/LibraryPage';
import { db } from '../src/storage/db';
import { App } from '../src/ui/App';
import { aiService, DEFAULT_AI_CONFIG } from '../src/ai/aiService';
import * as aiPermissions from '../src/ai/permissions';

function post(id: string, text: string): NormalizedPost {
  return {
    id,
    platform: 'x',
    postId: id.slice(2),
    canonicalUrl: `https://x.com/i/web/status/${id.slice(2)}`,
    author: { handle: 'ada', displayName: 'Ada' },
    text,
    postedAt: null,
    likedAt: null,
    firstObservedAt: '2026-10-31T00:00:00.000Z',
    lastObservedAt: '2026-10-31T00:00:00.000Z',
    captureStatus: 'complete',
    missingFields: [],
    externalLinks: [],
    mediaIds: [],
    contentHash: id,
    sourceAdapter: 'x_dom',
    sourceRunId: 'run_1',
    schemaVersion: 1,
  };
}

describe('Library filters', () => {
  beforeEach(async () => {
    await db.posts.clear();
    await db.aiAnalysis.clear();
    await db.userOverrides.clear();
    await db.media.clear();
  });

  it('reports a metadata read failure and recovers without treating saved notes as absent', async () => {
    const target = post('x:714', '正文仍存在');
    await db.userOverrides.put({ postId: target.id, notes: '人工笔记样本', updatedAt: target.firstObservedAt });
    const read = vi.spyOn(db.userOverrides, 'toArray').mockRejectedValueOnce(new Error('Read failed'));
    try {
      render(<LibraryPage posts={[target]} onViewPostDetails={vi.fn()} onDeletePost={vi.fn()} />);
      await screen.findByText('无法读取文库整理资料');
      expect(screen.queryByRole('button', { name: '全选当前筛选' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '重新读取整理资料' }));
      const search = await screen.findByLabelText('搜索文库');
      fireEvent.change(search, { target: { value: '人工笔记样本' } });
      expect(screen.getByText(target.text)).toBeTruthy();
    } finally {
      read.mockRestore();
    }
  });

  it('waits for notes to load before displaying search results', async () => {
    const target = post('x:715', '加载状态样本');
    let finishRead: (rows: []) => void = () => {};
    const pending = new Promise<[]>((resolve) => { finishRead = resolve; });
    const read = vi.spyOn(db.userOverrides, 'toArray').mockReturnValueOnce(Dexie.Promise.resolve(pending));
    try {
      render(<LibraryPage posts={[target]} onViewPostDetails={vi.fn()} onDeletePost={vi.fn()} />);
      expect(screen.getByRole('status').textContent).toContain('正在读取文库');
      expect(screen.queryByLabelText('搜索文库')).toBeNull();
      finishRead([]);
      expect(await screen.findByText(target.text)).toBeTruthy();
    } finally {
      finishRead([]);
      read.mockRestore();
    }
  });

  it('paginates 1000 posts and finds a result outside the mounted page', async () => {
    const posts = Array.from({ length: 1000 }, (_, index) => post(`x:${index + 1}`,
      index === 999 ? '千条样本中的唯一词 needle-1000' : `普通样本 ${index + 1}`));
    render(<LibraryPage posts={posts} onViewPostDetails={vi.fn()} onDeletePost={vi.fn()} />);
    await screen.findByLabelText('搜索文库');
    fireEvent.click(screen.getByRole('button', { name: '列表' }));
    const selectionBoxes = () => screen.getAllByRole('checkbox', { name: /^选择 Ada 的帖子/ });
    expect(selectionBoxes()).toHaveLength(30);
    expect(screen.queryByText(/needle-1000/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByText('31–60 / 1000')).toBeTruthy();
    expect(selectionBoxes()).toHaveLength(30);
    fireEvent.change(screen.getByLabelText('搜索文库'), { target: { value: 'needle-1000' } });
    expect(screen.getByText(/needle-1000/)).toBeTruthy();
    expect(selectionBoxes()).toHaveLength(1);
  });

  it('matches mixed-width terms across archived fields within the selected author', async () => {
    const target = { ...post('x:711', '离线 ＡＰＩ 样本'),
      references: [{ kind: 'quote' as const, id: '901', url: 'https://x.com/source/status/901' }] };
    const other = { ...post('x:712', '离线 API 对照样本'), author: { handle: 'bob', displayName: 'Bob' },
      references: target.references };
    const exportFiltered = vi.fn();
    render(<LibraryPage posts={[target, other]} onViewPostDetails={vi.fn()} onDeletePost={vi.fn()}
      onExportFiltered={exportFiltered} />);
    await screen.findByLabelText('搜索文库');
    fireEvent.change(screen.getByLabelText('搜索文库'), { target: { value: 'API　ｓｏｕｒｃｅ/status/901' } });
    expect(screen.getByText(target.text)).toBeTruthy();
    expect(screen.getByText(other.text)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('作者'), { target: { value: '@ada' } });
    fireEvent.click(screen.getByRole('button', { name: '导出筛选结果' }));
    expect(exportFiltered).toHaveBeenCalledWith([target]);
  });

  it('restricts selected bulk changes to posts matching the current search', async () => {
    const visible = post('x:701', '筛选可见样本');
    const hidden = post('x:702', '另一个样本');
    await db.posts.bulkPut([visible, hidden]);
    render(<LibraryPage posts={[visible, hidden]} onViewPostDetails={vi.fn()} onDeletePost={vi.fn()} />);
    await screen.findByLabelText('搜索文库');
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Ada 的帖子 701' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Ada 的帖子 702' }));
    fireEvent.change(screen.getByLabelText('搜索文库'), { target: { value: '筛选可见' } });
    expect(screen.getByText('已选 1 篇')).toBeTruthy();
    await db.userOverrides.put({ postId: visible.id, updatedAt: visible.firstObservedAt,
      notes: '其他窗口刚保存的笔记', customTags: ['手动标签'], customCategories: ['编程开发'] });
    fireEvent.click(screen.getByRole('button', { name: '标为待做' }));
    await waitFor(async () => expect((await db.userOverrides.get(visible.id))?.readingStatus).toBe('to_practice'));
    expect(await db.userOverrides.get(hidden.id)).toBeUndefined();
    expect(await db.userOverrides.get(visible.id)).toMatchObject({
      notes: '其他窗口刚保存的笔记', customTags: ['手动标签'], customCategories: ['编程开发'],
    });
    await screen.findByRole('button', { name: '全选当前筛选' });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Ada 的帖子 701' }));
    fireEvent.click(screen.getByRole('button', { name: '标为待读' }));
    await waitFor(async () => expect(await db.userOverrides.get(visible.id)).toMatchObject({
      readingStatus: 'to_read', notes: '其他窗口刚保存的笔记',
    }));
    expect(await db.userOverrides.get(hidden.id)).toBeUndefined();
  });

  it('requires batch transfer confirmation after the API permission was granted', async () => {
    const target = post('x:713', '待整理的本地帖子');
    await db.posts.put(target);
    const baseUrl = 'https://fixture.example/v1';
    const config = vi.spyOn(aiService, 'getConfig').mockResolvedValue({
      ...DEFAULT_AI_CONFIG, useMock: false, baseUrl, allowSendImages: true,
    });
    const access = vi.spyOn(aiPermissions, 'requestApiAccess').mockResolvedValue({ ok: true, message: '' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const analyze = vi.spyOn(aiService, 'analyzeBatch');
    try {
      render(<LibraryPage posts={[target]} onViewPostDetails={vi.fn()} onDeletePost={vi.fn()} />);
    await screen.findByLabelText('搜索文库');
      fireEvent.click(screen.getByRole('checkbox', { name: '选择 Ada 的帖子 713' }));
      const run = screen.getByRole('button', { name: '整理已选 1' });
      await waitFor(() => expect(run).toHaveProperty('disabled', false));
      fireEvent.click(run);
      await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringContaining('https://fixture.example')));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('最多附带两张已下载图片'));
      expect(access).toHaveBeenCalledWith(baseUrl);
      expect(analyze).not.toHaveBeenCalled();
      expect(await db.aiAnalysis.get(target.id)).toBeUndefined();
    } finally {
      analyze.mockRestore();
      confirm.mockRestore();
      access.mockRestore();
      config.mockRestore();
    }
  });

  it('retries only selected failures when a selection exists', async () => {
    const selectedFailure = post('x:501', '选中且整理失败的帖子');
    const otherFailure = post('x:502', '没有选中且整理失败的帖子');
    const selectedNew = post('x:503', '选中但尚未整理的帖子');
    const posts = [selectedFailure, otherFailure, selectedNew];
    await db.posts.bulkPut(posts);
    await db.aiAnalysis.bulkPut([selectedFailure, otherFailure].map((entry) => ({
      postId: entry.id, sourceHash: entry.contentHash, model: 'mock_ai', promptVersion: PROMPT_VERSION,
      status: 'failed', categories: [], tags: [],
      failureCode: entry.id === selectedFailure.id ? 'request' : 'response_format',
    })));
    const config = vi.spyOn(aiService, 'getConfig').mockResolvedValue({ ...DEFAULT_AI_CONFIG, useMock: true });
    try {
      render(<LibraryPage posts={posts} onViewPostDetails={vi.fn()} onDeletePost={vi.fn()} />);
    await screen.findByLabelText('搜索文库');
      await screen.findByRole('button', { name: '重试筛选结果中的失败项 (2)' });
      fireEvent.click(screen.getByRole('checkbox', { name: '选择 Ada 的帖子 503' }));
      expect(screen.queryByRole('button', { name: /重试.*失败项/ })).toBeNull();
      fireEvent.change(screen.getByLabelText('整理状态'), { target: { value: 'request' } });
      expect(screen.getByText(selectedFailure.text)).toBeTruthy();
      expect(screen.queryByText(otherFailure.text)).toBeNull();
      expect(screen.getByRole('button', { name: '重试筛选结果中的失败项 (1)' })).toBeTruthy();
      fireEvent.click(screen.getByRole('checkbox', { name: '选择 Ada 的帖子 501' }));
      fireEvent.click(screen.getByRole('button', { name: '重试已选失败项 (1)' }));
      await waitFor(async () => expect((await db.aiAnalysis.get(selectedFailure.id))?.status).toBe('complete'));
      expect((await db.aiAnalysis.get(otherFailure.id))?.status).toBe('failed');
      expect(await db.aiAnalysis.get(selectedNew.id)).toBeUndefined();
    } finally {
      config.mockRestore();
    }
  });

  it('requires confirmation and rolls back all local records if a post deletion fails', async () => {
    const target = { ...post('x:401', '单篇删除事务样本'), mediaIds: ['remove-image'] };
    await db.posts.put(target);
    await db.media.put({ id: 'remove-image', postId: target.id, position: 0, kind: 'image',
      status: 'remote_only', sourceUrl: 'https://pbs.twimg.com/media/remove-fixture.png' });
    await db.userOverrides.put({ postId: target.id, updatedAt: target.firstObservedAt, notes: '保留笔记' });
    await db.aiAnalysis.put({ postId: target.id, sourceHash: target.contentHash, model: 'mock', promptVersion: PROMPT_VERSION,
      status: 'failed', categories: [], tags: [] });
    const originalUrl = location.href;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    const failDelete = () => { throw new Error('fixture deletion failure'); };
    history.replaceState(null, '', '#library');
    try {
      render(<App />);
      await screen.findByText(target.text);
      fireEvent.click(screen.getByRole('button', { name: '列表' }));
      const remove = screen.getByTitle('删除本地记录');
      fireEvent.click(remove);
      expect(await db.posts.get(target.id)).toBeDefined();
      db.userOverrides.hook('deleting', failDelete);
      fireEvent.click(remove);
      expect(await screen.findByText(/删除失败，这篇帖子的本地资料仍保留/)).toBeTruthy();
      expect(await db.posts.get(target.id)).toBeDefined();
      expect(await db.media.get('remove-image')).toBeDefined();
      expect(await db.userOverrides.get(target.id)).toBeDefined();
      expect(await db.aiAnalysis.get(target.id)).toBeDefined();
      db.userOverrides.hook('deleting').unsubscribe(failDelete);
      fireEvent.click(remove);
      await waitFor(() => expect(screen.queryByText(target.text)).toBeNull());
      expect(await db.posts.get(target.id)).toBeUndefined();
      expect(await db.media.get('remove-image')).toBeUndefined();
      expect(await db.userOverrides.get(target.id)).toBeUndefined();
      expect(await db.aiAnalysis.get(target.id)).toBeUndefined();
    } finally {
      db.userOverrides.hook('deleting').unsubscribe(failDelete);
      confirm.mockRestore();
      localStorage.removeItem('likemind_library_view_mode');
      history.replaceState(null, '', originalUrl);
    }
  });

  it('opens the topics route, links shared evidence, and returns to the matching library posts', async () => {
    const first = post('x:301', '主题内的第一篇工具教程');
    const second = post('x:302', '主题内的第二篇工具教程');
    const unrelated = post('x:303', '另外一个主题的图形设计教程');
    await db.posts.bulkPut([first, second, unrelated]);
    await db.userOverrides.bulkPut([first, second, unrelated].map((entry) => ({
      postId: entry.id, updatedAt: entry.firstObservedAt, customCategories: [entry === unrelated ? '设计/UI' : '软件工具'],
    })));
    await db.aiAnalysis.bulkPut([first, second].map((entry) => ({
      postId: entry.id, sourceHash: entry.contentHash, model: 'mock', promptVersion: PROMPT_VERSION,
      status: 'complete', categories: [], tags: [], prerequisites: ['终端', entry === first ? 'Node.js' : 'Rust'],
      steps: ['检查版本'],
    })));
    const originalUrl = location.href;
    history.replaceState(null, '', '#topics');
    try {
      render(<App />);
      const topicView = within(await screen.findByRole('region', { name: '主题汇总' }));
      fireEvent.change(topicView.getByLabelText('查看主题'), { target: { value: '软件工具' } });
      expect(topicView.getByText('终端')).toBeTruthy();
      expect(topicView.getByText('Rust')).toBeTruthy();
      expect(topicView.getAllByText('检查版本', { exact: false })).toHaveLength(2);
      for (const summary of topicView.getAllByText(/^原帖出处/)) fireEvent.click(summary);
      expect(topicView.getAllByRole('link', { name: /原帖 302/ })[0].getAttribute('href')).toBe(second.canonicalUrl);
      fireEvent.click(topicView.getByRole('button', { name: '查看主题帖子' }));
      expect((screen.getByLabelText('主题分类') as HTMLSelectElement).value).toBe('软件工具');
      expect(await screen.findByText(first.text)).toBeTruthy();
      expect(screen.queryByText(unrelated.text)).toBeNull();
    } finally {
      history.replaceState(null, '', originalUrl);
    }
  });

  it('combines author, effective tags, batch and repair filters and exports the matching post', async () => {
    const matching = { ...post('x:201', '筛选后唯一应导出的帖子'), author: { handle: '@ADA', displayName: 'Ada' },
      captureStatus: 'partial' as const };
    const otherAuthor = { ...matching, id: 'x:202', postId: '202', text: '同名的另一个作者',
      author: { handle: 'other', displayName: 'Ada' }, mediaIds: [] };
    const otherTag = { ...matching, id: 'x:203', postId: '203', text: '标签只有前缀相同', mediaIds: [] };
    const otherBatch = { ...matching, id: 'x:204', postId: '204', text: '来自另一个批次', sourceRunId: 'run_2', mediaIds: [] };
    const complete = { ...post('x:205', '正文已经完整'), mediaIds: [] };
    await db.posts.bulkPut([matching, otherAuthor, otherTag, otherBatch, complete]);
    await db.userOverrides.bulkPut([matching, otherAuthor, otherTag, otherBatch, complete].map((p) => ({
      postId: p.id, updatedAt: '2026-11-05T00:00:00Z', customTags: [p === otherTag ? 'DevOps' : 'Dev'],
    })));
    await db.aiAnalysis.put({ postId: matching.id, sourceHash: matching.contentHash, model: 'mock',
      promptVersion: PROMPT_VERSION, status: 'complete', categories: [], tags: ['已被人工标签替换'] });

    const originalUrl = location.href;
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:filter-test');
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL: vi.fn() }));
    history.replaceState(null, '', '#library');
    try {
      render(<App />);
      await screen.findByRole('option', { name: 'Dev' });
      expect(screen.queryByRole('option', { name: '已被人工标签替换' })).toBeNull();
      fireEvent.change(screen.getByLabelText('作者'), { target: { value: '@ada' } });
      fireEvent.change(screen.getByLabelText('标签'), { target: { value: 'dev' } });
      fireEvent.change(screen.getByLabelText('首次入库批次'), { target: { value: 'run_1' } });
      fireEvent.click(screen.getByRole('button', { name: '待修复' }));
      expect(await screen.findByText(matching.text)).toBeTruthy();
      for (const excluded of [otherAuthor, otherTag, otherBatch, complete]) {
        expect(screen.queryByText(excluded.text)).toBeNull();
      }

      fireEvent.click(screen.getByRole('button', { name: '导出筛选结果' }));
      const dialog = within(screen.getByRole('dialog', { name: '导出' }));
      fireEvent.click(dialog.getByRole('button', { name: '导出 1 篇' }));
      expect(await dialog.findByText('已发起下载 1 个压缩包。')).toBeTruthy();
      const zipBlob = createObjectURL.mock.calls[0][0];
      const zip = await JSZip.loadAsync(zipBlob);
      const markdownPaths = Object.keys(zip.files).filter((name) => name.startsWith('posts/') && name.endsWith('.md'));
      expect(markdownPaths).toEqual([expect.stringMatching(/\/201\.md$/)]);
      expect(await zip.file(markdownPaths[0])?.async('string')).toContain(matching.text);
    } finally {
      cleanup();
      history.replaceState(null, '', originalUrl);
      vi.unstubAllGlobals();
    }
  });

  it('opens matching repair and incremental AI scopes from sync history', async () => {
    const runId = 'run_history_filter';
    const incomplete = { ...post('x:111', '本批待补正文'), captureStatus: 'partial' as const, sourceRunId: runId };
    const complete = { ...post('x:112', '本批完整帖子'), sourceRunId: runId };
    const unrelated = { ...post('x:113', '旧批待补正文'), captureStatus: 'partial' as const };
    const revisited = { ...post('x:114', '本批再次观察的待补帖子'), captureStatus: 'partial' as const };
    await db.posts.bulkPut([incomplete, complete, unrelated, revisited]);
    await db.syncRuns.put({
      id: runId, startedAt: '2026-11-05T00:00:00Z', lastCheckpointAt: '2026-11-05T00:00:00Z',
      status: 'completed', stats: { scanned: 3, added: 2, updated: 0, skipped: 1, failed: 0 },
      seenPostIds: ['111', '112', '114'],
      changedPostIds: [revisited.id],
      targetLimit: 20, downloadMedia: false, adapterType: 'x_dom',
    });
    const previousUrl = location.href;
    const config = vi.spyOn(aiService, 'getConfig').mockResolvedValue({ ...DEFAULT_AI_CONFIG, useMock: true });
    history.replaceState(null, '', '#sync');
    try {
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: '查看本批待修复' }));
      expect(await screen.findByText('本批待补正文')).toBeTruthy();
      expect(screen.getByText(revisited.text)).toBeTruthy();
      expect(screen.queryByText('本批完整帖子')).toBeNull();
      expect(screen.queryByText('旧批待补正文')).toBeNull();
      expect((screen.getByLabelText('采集批次') as HTMLSelectElement).value).toBe(runId);
      fireEvent.click(screen.getByRole('button', { name: /^待修复$/ }));
      expect(screen.getByText('本批完整帖子')).toBeTruthy();
      expect(screen.queryByText('旧批待补正文')).toBeNull();
      expect(screen.queryByText(revisited.text)).toBeNull();
      fireEvent.change(screen.getByLabelText('首次入库批次'), { target: { value: '' } });
      expect(screen.getByText('旧批待补正文')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '同步' }));
      fireEvent.click(await screen.findByRole('button', { name: '查看本批待整理' }));
      expect(await screen.findByText(revisited.text)).toBeTruthy();
      expect(screen.getByText(incomplete.text)).toBeTruthy();
      expect(screen.queryByText(unrelated.text)).toBeNull();
      const organize = await screen.findByRole('button', { name: '仅整理本批新增或更新 (1)' });
      await waitFor(() => expect((organize as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(organize);
      await waitFor(async () => expect((await db.aiAnalysis.get(revisited.id))?.status).toBe('complete'));
      expect(await db.aiAnalysis.get(unrelated.id)).toBeUndefined();
    } finally {
      config.mockRestore();
      history.replaceState(null, '', previousUrl);
      await db.syncRuns.delete(runId);
    }
  });

  it('finds posts needing repair and removes a recovered image post from the list', async () => {
    const imagePost = { ...post('x:41', '待修复图片帖'), mediaIds: ['retry-image'] };
    const partial = { ...post('x:42', '正文缺失帖子'), captureStatus: 'partial' as const };
    const missingRecord = { ...post('x:43', '缺少图片记录的帖子'), mediaIds: ['unavailable'] };
    const imageFetch = vi.fn().mockResolvedValue(new Response(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', imageFetch);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      await db.media.put({
        id: 'retry-image', postId: imagePost.id, position: 0, kind: 'image',
        sourceUrl: 'https://pbs.twimg.com/media/repair.png', status: 'downloaded', blob: new Blob([]),
      });
      render(<LibraryPage posts={[imagePost, partial, missingRecord, post('x:44', '完整的文字帖子')]}
        onViewPostDetails={() => {}} onDeletePost={() => {}} />);
    await screen.findByLabelText('搜索文库');
      fireEvent.click(screen.getByRole('button', { name: '列表' }));
      fireEvent.click(screen.getByRole('button', { name: '待修复' }));
      expect(await screen.findByText('待修复图片帖')).toBeTruthy();
      expect(screen.getByText('正文缺失帖子')).toBeTruthy();
      expect(screen.getByText('缺少图片记录的帖子')).toBeTruthy();
      expect(screen.queryByText('完整的文字帖子')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /重试筛选结果中的图片/ }));
      expect(await screen.findByText(/下载 1 张/)).toBeTruthy();
      await waitFor(() => expect(screen.queryByText('待修复图片帖')).toBeNull());
      expect(screen.getByText('正文缺失帖子')).toBeTruthy();
      expect(imageFetch).toHaveBeenCalledOnce();
    } finally {
      localStorage.removeItem('likemind_library_view_mode');
      vi.unstubAllGlobals();
    }
  });

  it('matches a later category and separates active and failed analyses from pending work', async () => {
    const design = post('x:1', '这篇讲 Vite 和界面布局，正文足够长，不应该进杂项。');
    design.sources = ['x_likes', 'x_bookmarks'];
    const failed = post('x:2', '这篇整理失败了，正文也足够长，用来检查筛选。');
    const processing = post('x:3', '这篇正在其他标签页整理，用来检查筛选。');
    await db.userOverrides.put({ postId: design.id, notes: '下次检查截图尺寸', updatedAt: design.firstObservedAt });
    const analysis: AIAnalysis[] = [
      {
        postId: 'x:1',
        sourceHash: 'x:1',
        model: 'mock',
        promptVersion: PROMPT_VERSION,
        status: 'complete',
        titleZh: '构建工具笔记',
        categories: ['编程开发', '设计/UI'],
        tags: ['vite-tag'],
      },
      {
        postId: 'x:2',
        sourceHash: 'x:2',
        model: 'mock',
        promptVersion: PROMPT_VERSION,
        status: 'failed',
        categories: [],
        tags: [],
        failureReason: 'timeout',
      },
      {
        postId: processing.id, sourceHash: processing.contentHash, model: 'mock',
        promptVersion: PROMPT_VERSION, status: 'processing', categories: [], tags: [],
      },
    ];
    await db.aiAnalysis.bulkPut(analysis);

    render(
      <LibraryPage
        posts={[design, failed, processing]}
        onViewPostDetails={() => undefined}
        onDeletePost={() => undefined}
      />
    );
    await screen.findByLabelText('搜索文库');

    await waitFor(() => {
      expect(screen.getByRole('option', { name: '设计/UI (1)' })).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /整理未分析/ })).toBeNull();

    for (const source of ['x_likes', 'x_bookmarks']) {
      fireEvent.change(screen.getByLabelText('来源'), { target: { value: source } });
      expect(screen.getByText(/这篇讲 Vite/)).toBeTruthy();
      expect(screen.queryByText(/这篇整理失败了/)).toBeNull();
    }
    fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'unknown' } });
    expect(screen.getByText(/这篇整理失败了/)).toBeTruthy();
    expect(screen.queryByText(/这篇讲 Vite/)).toBeNull();
    fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'all' } });

    fireEvent.change(screen.getByLabelText('主题分类'), { target: { value: '设计/UI' } });
    expect(screen.getByText(/这篇讲 Vite/)).toBeTruthy();
    expect(screen.queryByText(/这篇整理失败了/)).toBeNull();

    fireEvent.change(screen.getByLabelText('主题分类'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('搜索文库'), { target: { value: 'vite-tag' } });
    expect(screen.getByText(/这篇讲 Vite/)).toBeTruthy();
    expect(screen.queryByText(/这篇整理失败了/)).toBeNull();

    fireEvent.change(screen.getByLabelText('搜索文库'), { target: { value: '  @ADA　Vite 构建工具 截图尺寸  ' } });
    expect(screen.getByText(/这篇讲 Vite/)).toBeTruthy();
    expect(screen.queryByText(failed.text)).toBeNull();
    fireEvent.change(screen.getByLabelText('搜索文库'), { target: { value: 'Vite 不存在的关键词' } });
    expect(screen.getByRole('heading', { name: '没有对上的帖子' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('搜索文库'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('整理状态'), { target: { value: 'failed' } });
    expect(screen.getByText(/这篇整理失败了/)).toBeTruthy();
    expect(screen.queryByText(/这篇讲 Vite/)).toBeNull();

    fireEvent.change(screen.getByLabelText('整理状态'), { target: { value: 'unprocessed' } });
    expect(screen.getByRole('heading', { name: '没有对上的帖子' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('整理状态'), { target: { value: 'processing' } });
    expect(screen.getByText(processing.text)).toBeTruthy();
    expect(screen.queryByText(failed.text)).toBeNull();
  });
});
