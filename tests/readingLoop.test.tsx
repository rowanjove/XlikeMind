import { SynthesisPanels } from '../src/ui/components/SynthesisPanels';
import { PROMPT_VERSION } from '../src/domain/analysis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExportModal } from '../src/ui/components/ExportModal';
import { PostCard } from '../src/ui/components/PostCard';
import { PostDetailModal } from '../src/ui/components/PostDetailModal';
import { db } from '../src/storage/db';
import type { NormalizedPost } from '../src/domain/types';
import * as zipModule from '../src/export/zip';
import { useState } from 'react';
import { Blob as NodeBlob } from 'node:buffer';
import { aiService, DEFAULT_AI_CONFIG } from '../src/ai/aiService';
import * as aiPermissions from '../src/ai/permissions';

const post: NormalizedPost = {
  id: 'x:reading1',
  platform: 'x',
  postId: 'reading1',
  canonicalUrl: 'https://x.com/dev/status/reading1',
  author: { handle: 'dev', displayName: 'Dev' },
  text: 'Playwright 截图要看实际页面。',
  postedAt: null,
  likedAt: null,
  firstObservedAt: '2026-10-31T00:00:00.000Z',
  lastObservedAt: '2026-10-31T00:00:00.000Z',
  captureStatus: 'partial',
  missingFields: [],
  externalLinks: [],
  mediaIds: ['x:reading1_media_0'],
  contentHash: 'hash-reading1',
  sourceAdapter: 'fixture',
  sourceRunId: 'run-reading',
  schemaVersion: 1,
};

describe('reading correction and export split', () => {
  it('traps detail and note focus separately and restores the opener after closing', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>打开样本详情</button>
        {open && <PostDetailModal post={post} onClose={() => setOpen(false)} />}</>;
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: '打开样本详情' });
    opener.focus();
    fireEvent.click(opener);
    const detail = await screen.findByRole('dialog', { name: '帖子详情' });
    expect(detail.contains(document.activeElement)).toBe(true);
    const close = within(detail).getByRole('button', { name: '关闭' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(detail.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(close);
    fireEvent.click(within(detail).getByRole('button', { name: '写笔记' }));
    const notes = screen.getByRole('dialog', { name: '编辑笔记与标注' });
    expect(notes.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑笔记与标注' })).toBeNull());
    expect(screen.getByRole('dialog', { name: '帖子详情' })).toBeTruthy();
    expect(detail.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '帖子详情' })).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
  beforeEach(async () => {
    URL.createObjectURL = () => 'blob:preview';
    URL.revokeObjectURL = () => {};
    await db.exportJobs.clear();
    await db.transaction('rw', db.posts, db.media, db.userOverrides, db.aiAnalysis, async () => {
      await db.posts.delete(post.id);
      await db.media.delete('x:reading1_media_0');
      await db.userOverrides.delete(post.id);
      await db.aiAnalysis.delete(post.id);
    });
  });

  it('lets the reader reach later synthesis items and their sources', () => {
    const items = Array.from({ length: 9 }, (_, index) => ({ task: `步骤 ${index + 1}`, sourcePostIds: [post.id] }));
    render(<SynthesisPanels synthesis={{ topic: '测试', generatedAt: post.firstObservedAt, postCount: 1,
      commonPatterns: [], differences: [], actionableList: items }} postsById={new Map([[post.id, post]])} />);
    expect(screen.queryByText('步骤 9')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '实践项下一页' }));
    expect(screen.getByText('步骤 9')).toBeTruthy();
    expect(screen.queryByText('步骤 1')).toBeNull();
    fireEvent.click(screen.getByText('原帖出处（1）'));
    expect(screen.getByRole('link', { name: new RegExp('原帖 ' + post.postId) }).getAttribute('href')).toBe(post.canonicalUrl);
    fireEvent.click(screen.getByRole('button', { name: '实践项上一页' }));
    expect(screen.getByText('步骤 1')).toBeTruthy();
  });

  it('opens the post when the card is clicked, and keeps the original link on the card', () => {
    const onViewDetails = vi.fn();
    render(<PostCard post={post} onViewDetails={onViewDetails} onDelete={() => {}} />);

    fireEvent.click(screen.getByText('原帖'));
    expect(onViewDetails).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(post.text));
    expect(onViewDetails).toHaveBeenCalledWith(post);
  });

  it('reuses the current AI summary when checking for updates from post detail', async () => {
    await db.posts.put(post);
    await db.aiAnalysis.put({
      postId: post.id, sourceHash: post.contentHash, model: DEFAULT_AI_CONFIG.modelName, promptVersion: PROMPT_VERSION,
      status: 'complete', categories: [], tags: [], summaryZh: '已保存的摘要', updatedAt: post.firstObservedAt,
    });
    const config = vi.spyOn(aiService, 'getConfig').mockResolvedValue({ ...DEFAULT_AI_CONFIG, useMock: false });
    const permission = vi.spyOn(aiPermissions, 'requestApiAccess').mockResolvedValue({ ok: false, message: '未授权' });
    const analyze = vi.spyOn(aiService, 'analyzePost');
    try {
      render(<PostDetailModal post={post} onClose={() => {}} />);
      const check = await screen.findByRole('button', { name: '检查更新' });
      await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
      for (let attempt = 0; attempt < 2; attempt++) {
        fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
        await screen.findByText('已使用现有摘要。');
      }
      expect((await db.aiAnalysis.get(post.id))?.summaryZh).toBe('已保存的摘要');
      expect((await db.aiAnalysis.get(post.id))?.updatedAt).toBe(post.firstObservedAt);
      expect(permission).not.toHaveBeenCalled();
      expect(analyze).not.toHaveBeenCalled();
    } finally {
      analyze.mockRestore();
      permission.mockRestore();
      config.mockRestore();
    }
  });

  it('warns before a large export is split into three zips', () => {
    render(
      <ExportModal isOpen onClose={() => {}} filteredPosts={[]} totalPostsCount={450} />
    );

    expect(screen.queryByText(/分成 3 个压缩包/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /全部/ }));
    expect(screen.getByText(/分成 3 个压缩包/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '分 3 批导出' })).toBeTruthy();
  });

  it('keeps keyboard focus in the export dialog and returns it to the trigger on Escape', () => {
    function ExportFixture() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>测试导出入口</button>
        <ExportModal isOpen={open} onClose={() => setOpen(false)} filteredPosts={[post]} totalPostsCount={1} />
      </>;
    }
    render(<ExportFixture />);
    const trigger = screen.getByRole('button', { name: '测试导出入口' });
    trigger.focus();
    fireEvent.click(trigger);
    const close = screen.getByRole('button', { name: '关闭导出' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    const exportButton = screen.getByRole('button', { name: '导出 1 篇' });
    expect(document.activeElement).toBe(exportButton);
    fireEvent.keyDown(exportButton, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '导出' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('does not count a rejected ZIP download or store raw error details', async () => {
    const download = vi.spyOn(chrome.downloads, 'download').mockRejectedValueOnce(new Error('private fixture details'));
    try {
      const props = { isOpen: true, onClose: () => {}, filteredPosts: [post], totalPostsCount: 1 };
      const view = render(<ExportModal {...props} />);
      fireEvent.click(screen.getByRole('button', { name: '导出 1 篇' }));
      expect((await screen.findByRole('alert')).textContent).toBe('第 1 包导出失败。');
      await waitFor(async () => expect(await db.exportJobs.orderBy('startedAt').last()).toMatchObject({
        status: 'failed', totalPackages: 1, submittedFiles: [], failureMessage: '第 1 包导出失败。', failedPackage: 1,
      }));
      view.unmount();
      render(<ExportModal {...props} />);
      expect(await screen.findByText('第 1 包导出失败。')).toBeTruthy();
      expect(screen.getByText('已发起下载 0 / 1 包')).toBeTruthy();
      expect(screen.queryByText(/private fixture details/)).toBeNull();
    } finally {
      download.mockRestore();
    }
  });

  it('stops before downloading an unfinished ZIP and keeps the first part available', async () => {
    const posts = Array.from({ length: 201 }, (_, index) => ({ ...post, id: `x:${index}`, postId: String(index) }));
    const build = vi.spyOn(zipModule, 'buildExportZip').mockImplementation(async (options) => {
      if (options.posts.length === 1) {
        return new Promise((_resolve, reject) => {
          const signal = options.signal!;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return { blob: new Blob(['fixture']), manifest: {
        manifestVersion: '1.0', appName: 'LikeMind', appVersion: '0.1.0', exportedAt: post.firstObservedAt,
        postCount: 200, assetsCount: 0, status: 'complete', failuresCount: 0, failures: [],
      } };
    });
    const download = vi.spyOn(chrome.downloads, 'download')
      .mockImplementationOnce((() => Promise.resolve(100)) as typeof chrome.downloads.download);
    try {
      const view = render(<ExportModal isOpen onClose={() => {}} filteredPosts={posts} totalPostsCount={posts.length} />);
      fireEvent.click(screen.getByRole('button', { name: '分 2 批导出' }));
      await waitFor(() => expect(build).toHaveBeenCalledTimes(2));
      const packages = build.mock.calls.map(([options]) => options.packageInfo);
      expect(packages[0]).toMatchObject({ part: 1, totalParts: 2, totalPosts: 201, linksOnly: false });
      expect(packages[1]).toEqual({ ...packages[0], part: 2 });
      fireEvent.click(screen.getByRole('button', { name: '停止 ZIP 导出' }));
      expect(await screen.findByText('已停止 ZIP 导出。已发起下载的 1 个压缩包可继续使用。')).toBeTruthy();
      expect(screen.getByRole('link', { name: '再次下载' })).toBeTruthy();
      expect(download).toHaveBeenCalledOnce();
      await waitFor(async () => expect(await db.exportJobs.orderBy('startedAt').last()).toMatchObject({
        status: 'cancelled', totalPackages: 2, submittedFiles: [expect.stringContaining('part-1-of-2')],
        downloadIds: expect.objectContaining({ [String(download.mock.calls[0][0].filename)]: 100 }),
      }));
      view.unmount();
      const search = vi.fn().mockResolvedValue([{ id: 100, state: 'interrupted', filename: 'private-path' }]);
      vi.stubGlobal('chrome', { ...chrome, downloads: { ...chrome.downloads, search } });
      render(<ExportModal isOpen onClose={() => {}} filteredPosts={posts} totalPostsCount={posts.length} />);
      expect(await screen.findByText('已发起下载 1 / 2 包')).toBeTruthy();
      expect(await screen.findByText(/下载中断/)).toBeTruthy();
      expect(search).toHaveBeenCalledWith({ id: 100 });
      expect(screen.queryByText(/private-path/)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      build.mockRestore();
      download.mockRestore();
    }
  });

  it('saves a manual category and retries an unreadable archived image', async () => {
    await db.posts.put(post);
    await db.media.put({
      id: 'x:reading1_media_0',
      postId: post.id,
      position: 0,
      kind: 'image',
      sourceUrl: 'https://pbs.twimg.com/media/mock_retry.jpg',
      status: 'downloaded',
      blob: new NodeBlob(['broken'], { type: 'image/png' }) as unknown as Blob,
    });
    await db.aiAnalysis.put({
      postId: post.id,
      sourceHash: post.contentHash,
      model: 'mock',
      promptVersion: PROMPT_VERSION,
      status: 'complete',
      categories: ['网络技术'],
      tags: [],
    });

    render(<PostDetailModal post={post} onClose={() => {}} />);

    // 验证原文重载按钮
    expect(screen.getByRole('button', { name: '重新载入原文' })).toBeTruthy();

    // 点击右上角“写笔记”打开笔记子模态
    fireEvent.click(screen.getByRole('button', { name: '写笔记' }));

    expect(await screen.findByText(/整理建议：网络技术/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '编程开发' }));
    await db.userOverrides.put({ postId: post.id, readingStatus: 'practiced', updatedAt: post.firstObservedAt });
    fireEvent.click(screen.getByRole('button', { name: '保存笔记' }));

    await waitFor(async () => {
      const saved = await db.userOverrides.get(post.id);
      expect(saved?.customCategories).toEqual(['编程开发']);
      expect(saved?.readingStatus).toBe('practiced');
    });

    // 验证图片点击放大预览 (Lightbox)
    const previewContainer = screen.getByTitle('点击放大查看图片');
    fireEvent.click(previewContainer);
    expect(screen.getByTitle('关闭预览 (Esc)')).toBeTruthy();
    fireEvent.click(screen.getByTitle('关闭预览 (Esc)'));
    expect(screen.queryByTitle('关闭预览 (Esc)')).toBeNull();
    fireEvent.click(previewContainer);
    const preview = screen.getByRole('dialog', { name: '图片预览' });
    expect(preview.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '图片预览' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '帖子详情' })).toBeTruthy();

    const fetchImage = vi.fn().mockResolvedValue(
      new Response(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), { headers: { 'Content-Type': 'image/png' } })
    );
    vi.stubGlobal('fetch', fetchImage);
    const closePreview = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValueOnce(new Error('invalid image')).mockResolvedValue({ close: closePreview }));
    try {
      fireEvent.error(await screen.findByRole('img', { name: '图片 1' }));
      expect(screen.getByText('本地图片打不开，可重新下载。')).toBeTruthy();
      fireEvent.click(await screen.findByRole('button', { name: '重新下载图片' }));
      expect(await screen.findByText(/新保存 1 张/)).toBeTruthy();
      const media = await db.media.get('x:reading1_media_0');
      expect(media?.status).toBe('downloaded');
      expect(fetchImage).toHaveBeenCalledOnce();
      expect(closePreview).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
