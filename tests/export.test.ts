import { PROMPT_VERSION } from '../src/domain/analysis';
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  generatePostMarkdown,
  getPostRelativePath,
  getMediaArchivePaths,
} from '../src/export/markdown';
import { buildExportZip } from '../src/export/zip';
import { EXPORT_MEDIA_BYTES_LIMIT } from '../src/export/batches';
import { generateArchiveReader } from '../src/export/reader';
import type { NormalizedPost, MediaAsset } from '../src/domain/types';

describe('Markdown & ZIP Export Engine', () => {
  const samplePost: NormalizedPost = {
    id: 'x:1851234567890123002',
    platform: 'x',
    postId: '1851234567890123002',
    canonicalUrl: 'https://x.com/design_daily/status/1851234567890123002',
    author: {
      handle: 'design_daily',
      displayName: 'Design Daily 🎨',
      avatarUrl: 'https://example.com/avatar.jpg',
    },
    text: '4 种现代卡片设计的排版对比：保持极简视觉层级。',
    postedAt: '2026-10-18T14:30:00.000Z',
    likedAt: null, // Strictly null
    firstObservedAt: '2026-10-31T01:00:00.000Z',
    lastObservedAt: '2026-10-31T01:00:00.000Z',
    captureStatus: 'complete',
    missingFields: [],
    externalLinks: ['https://example.com/design-spec'],
    mediaIds: ['media_0', 'media_1'],
    contentHash: 'content_hash_xyz',
    sourceAdapter: 'fixture',
    sourceRunId: 'run_101',
    schemaVersion: 1,
  };

  const sampleMedia: MediaAsset[] = [
    {
      id: 'media_0',
      postId: samplePost.id,
      position: 0,
      kind: 'image',
      sourceUrl: 'https://pbs.twimg.com/media/pic1.png',
      status: 'downloaded',
      mime: 'image/png',
      blob: new Blob(['png data 1'], { type: 'image/png' }),
    },
    {
      id: 'media_1',
      postId: samplePost.id,
      position: 1,
      kind: 'image',
      sourceUrl: 'https://pbs.twimg.com/media/pic2.jpg',
      status: 'failed',
      failureReason: 'HTTP 404: Not Found',
    },
  ];

  it('opens stable post links, pages a thousand entries and combines offline filters', () => {
    const posts = Array.from({ length: 1000 }, (_, index): NormalizedPost => ({
      ...samplePost,
      id: `x:${index}`,
      postId: String(index),
      sourceRunId: index === 999 ? 'run_latest' : 'run_older',
      firstObservedAt: index === 999 ? '2026-11-01T00:00:00Z' : '2026-10-01T00:00:00Z',
      text: index === 999 ? 'Playwright 离线教程' : `普通帖子 ${index}`,
      sources: index === 999 ? ['x_bookmarks', 'x_likes'] : ['x_likes'],
      mediaIds: index === 999 ? [sampleMedia[0].id] : [],
    }));
    const target = posts[999];
    const html = generateArchiveReader(
      posts,
      new Map([[target.id, [sampleMedia[0], { ...sampleMedia[0], id: 'second', position: 1, altText: '第二张' }]]]),
      new Map([[target.id, { postId: target.id, updatedAt: 'now', readingStatus: 'to_practice',
        customCategories: ['工具'], customTags: ['测试'], notes: '下次检查截图尺寸' }]]),
      new Map(),
      {
        snapshotPath: 'snapshots/current', runId: target.sourceRunId, exportedAt: '2026-11-04T00:00:00Z',
        history: [
          { name: 'old', exportedAt: '2026-11-03T00:00:00Z', postCount: 999 },
          { name: 'older', exportedAt: '2026-11-02T00:00:00Z', postCount: 998 },
          { name: 'unavailable', exportedAt: '2026-11-01T00:00:00Z', postCount: 997 },
        ],
        comparisons: [
          { previousName: 'old', previousExportedAt: '2026-11-03T00:00:00Z',
            added: [target.id], resolved: [], newlyMissing: [], previousMissing: 1, currentMissing: 1 },
          { previousName: 'older', previousExportedAt: '2026-11-02T00:00:00Z',
            added: [target.id, posts[0].id], resolved: [], newlyMissing: [], previousMissing: 2, currentMissing: 1 },
        ],
      }
    );
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    document.body.replaceChildren(...parsed.body.children);
    const originalMatchMedia = window.matchMedia;
    const originalUrl = location.href;
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    window.matchMedia = () => ({ matches: false }) as MediaQueryList;
    Element.prototype.scrollIntoView = () => {};
    try {
      history.replaceState(null, '', '#post=x%3A30');
      new Function(document.querySelector('script')?.textContent ?? '')();
      expect(document.getElementById('article')?.textContent).toContain('普通帖子 30');
      expect(document.getElementById('page')?.textContent).toBe('2 / 34');
      const select = (id: string, value: string) => {
        const control = document.getElementById(id) as HTMLSelectElement;
        control.value = value;
        control.dispatchEvent(new Event('change'));
      };
      const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)?.click();
      click('#previous');
      expect(document.querySelectorAll('#posts .result')).toHaveLength(30);
      click('#posts .result:last-child');
      const turn = (key: string) => document.getElementById('article')?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      expect(document.getElementById('read-position')?.textContent).toBe('30 / 1000 篇');
      turn('j');
      expect(document.getElementById('read-position')?.textContent).toBe('31 / 1000 篇');
      expect(location.hash).toContain('#post=');
      expect(document.getElementById('page')?.textContent).toBe('2 / 34');
      expect(document.querySelector('#posts .result:first-child')?.getAttribute('aria-current')).toBe('true');
      turn('k');
      expect(document.getElementById('page')?.textContent).toBe('1 / 34');
      click('#next');
      expect(document.getElementById('page')?.textContent).toBe('2 / 34');
      for (const view of ['to_practice', 'recent', 'batch']) {
        click(`#quick button[data-view="${view}"]`);
        expect(document.getElementById('count')?.textContent).toBe('1 / 1000 篇');
      }
      click('#reset');
      click('#comparison-views [data-view="added"]');
      expect(document.getElementById('count')?.textContent).toBe('1 / 1000 篇');
      const baseline = document.getElementById('comparison-base') as HTMLSelectElement;
      baseline.selectedIndex = 1;
      baseline.dispatchEvent(new Event('change'));
      expect(document.getElementById('count')?.textContent).toBe('2 / 1000 篇');
      expect(document.querySelector('#comparison-link')?.getAttribute('href')).toBe('snapshots/older/index.html');
      expect(document.getElementById('comparison-summary')?.textContent).toContain('2 → 1 篇');
      baseline.selectedIndex = 2;
      baseline.dispatchEvent(new Event('change'));
      expect(document.getElementById('comparison-views')?.hidden).toBe(true);
      expect(document.getElementById('count')?.textContent).toBe('1000 / 1000 篇');
      click('#reset');
      expect(document.getElementById('count')?.textContent).toBe('1000 / 1000 篇');
      const search = document.getElementById('search') as HTMLInputElement;
      search.value = 'Playwright 教程 截图尺寸';
      search.dispatchEvent(new Event('input'));
      select('source', 'x_bookmarks');
      select('topic', '工具');
      select('tag', '测试');
      select('status', 'to_practice');
      select('image', 'yes');
      expect(document.getElementById('count')?.textContent).toBe('1 / 1000 篇');
      click('#posts .result');
      expect(document.querySelector('#article img')?.getAttribute('src')).toBe('snapshots/current/assets/999/01.png');
      expect(document.querySelector('#article')?.textContent).toContain('Playwright 离线教程');
      expect(document.querySelector<HTMLButtonElement>('#read-next')?.disabled).toBe(true);
      expect(document.querySelector<HTMLButtonElement>('#read-previous')?.disabled).toBe(true);
      const dialog = document.getElementById('gallery') as HTMLDialogElement;
      dialog.showModal = () => { dialog.open = true; };
      dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event('close')); };
      const opener = document.querySelector<HTMLAnchorElement>('#article .photos a')!;
      opener.click();
      expect(dialog.open).toBe(true);
      expect(document.getElementById('gallery-count')?.textContent).toBe('1 / 2 张');
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      expect(document.getElementById('gallery-image')?.getAttribute('alt')).toBe('第二张');
      expect(document.querySelector<HTMLButtonElement>('#gallery-next')?.disabled).toBe(true);
      click('#gallery-zoom');
      expect(document.getElementById('gallery-stage')?.dataset.actual).toBe('true');
      click('#gallery-close');
      expect(document.activeElement).toBe(opener);
      select('source', 'x_archive');
      expect(document.querySelector('#posts')?.textContent).toContain('没有匹配的帖子');
      expect(document.getElementById('read-nav')?.hidden).toBe(true);
      history.replaceState(null, '', '#post=x%3Aabsent');
      window.dispatchEvent(new Event('hashchange'));
      expect(document.getElementById('link-warning')?.hidden).toBe(false);
    } finally {
      history.replaceState(null, '', originalUrl);
      window.matchMedia = originalMatchMedia;
      Element.prototype.scrollIntoView = originalScrollIntoView;
      document.body.replaceChildren();
    }
  });

  describe('Path & Relative Link Calculation', () => {
    it('calculates post relative path correctly based on postedAt date', () => {
      const { dir, filename, fullPath } = getPostRelativePath(samplePost);
      expect(dir).toBe('posts/2026/10');
      expect(filename).toBe('1851234567890123002.md');
      expect(fullPath).toBe('posts/2026/10/1851234567890123002.md');
    });

    it('calculates relative markdown path to assets strictly 3 levels up', () => {
      const paths = getMediaArchivePaths(sampleMedia[0], samplePost);
      // In archive: assets/<post_id>/01.png
      expect(paths.archivePath).toBe('assets/1851234567890123002/01.png');
      // From posts/2026/10/1851234567890123002.md: ../../../assets/...
      expect(paths.relativeMarkdownPath).toBe('../../../assets/1851234567890123002/01.png');
    });
  });

  describe('generatePostMarkdown', () => {
    it('keeps distinct image provenance without copying arbitrary query parameters', () => {
      const md = generatePostMarkdown({
        post: samplePost, exportedAt: samplePost.firstObservedAt,
        media: [{ ...sampleMedia[0],
          sourceUrl: 'https://pbs.twimg.com/media/fixture.png?name=orig&token=private-fixture',
          downloadedFromUrl: 'https://pbs.twimg.com/media/fixture.png?name=large&token=private-fixture',
        }],
      });
      expect(md).toContain('[采集地址](https://pbs.twimg.com/media/fixture.png?name=orig)');
      expect(md).toContain('[下载版本](https://pbs.twimg.com/media/fixture.png?name=large)');
      expect(md).not.toContain('private-fixture');
    });
    it('renders untrusted post, AI and personal note markup as text', () => {
      const injected = '<img src=x onerror=alert(1)> [click](javascript:alert(1))';
      const md = generatePostMarkdown({
        post: { ...samplePost, text: injected },
        media: [],
        overrides: {
          postId: samplePost.id, updatedAt: samplePost.firstObservedAt,
          notes: '保留这行\n<iframe src="https://fixture.invalid"></iframe> [note](javascript:alert(1))',
        },
        ai: {
          postId: samplePost.id, sourceHash: samplePost.contentHash, model: 'mock',
          promptVersion: PROMPT_VERSION, status: 'complete', categories: [], tags: [], summaryZh: injected,
        },
        exportedAt: '2026-10-31T02:00:00.000Z',
      });
      expect(md).not.toContain('<img');
      expect(md).toContain('&lt;img');
      expect(md).toContain('\\[click\\](javascript:alert(1))');
      expect(md).not.toContain('<iframe');
      expect(md).toContain('## 个人笔记\n\n保留这行\n&lt;iframe');
      expect(md).toContain('\\[note\\](javascript:alert(1))');
      expect(md).toContain('缺少 2 项媒体记录');
    });

    it('produces valid frontmatter and distinguishes postedAt from likedAt', () => {
      const md = generatePostMarkdown({
        post: samplePost,
        media: sampleMedia,
        exportedAt: '2026-10-31T02:00:00.000Z',
      });

      expect(md).toContain('---');
      expect(md).toContain('posted_at: "2026-10-18T14:30:00.000Z"');
      expect(md).toContain('liked_at: null'); // Must be unquoted null
      expect(md).toContain('first_observed_at: "2026-10-31T01:00:00.000Z"');
      expect(md).toContain('id: "x:1851234567890123002"');

      // Check text section
      expect(md).toContain('## 帖子原文');
      expect(md).toContain(samplePost.text);

      // Check media section: downloaded media has relative link
      expect(md).toContain('![图片 1](../../../assets/1851234567890123002/01.png)');

      // Check failed media: has explicit failure reason and remote fallback
      expect(md).toContain('⚠️ [未离线归档: HTTP 404]');
      expect(md).toContain('https://pbs.twimg.com/media/pic2.jpg');
    });
  });

  describe('buildExportZip & Unpack Verification', () => {
    it('checks the actual media size again before preparing a ZIP', async () => {
      const blob = new Blob();
      Object.defineProperty(blob, 'size', { value: EXPORT_MEDIA_BYTES_LIMIT + 1 });
      await expect(buildExportZip({
        posts: [samplePost], mediaMap: new Map([[samplePost.id, [{ ...sampleMedia[0], blob }]]]),
      })).rejects.toThrow('已归档媒体超过 64 MiB');
    });

    it('keeps provider and download diagnostics out of all ZIP files', async () => {
      const privateError = 'Authorization: Bearer TEST_PRIVATE_TOKEN; Cookie: TEST_PRIVATE_COOKIE; API Key TEST_PRIVATE_KEY';
      const { blob } = await buildExportZip({
        posts: [samplePost],
        mediaMap: new Map([[samplePost.id, [{ ...sampleMedia[1], failureReason: `HTTP 404: ${privateError}`,
          sourceUrl: 'https://pbs.twimg.com/media/pic2.jpg?name=large&token=TEST_PRIVATE_TOKEN#TEST_PRIVATE_KEY',
        }]]]),
        aiMap: new Map([[samplePost.id, {
          postId: samplePost.id, sourceHash: samplePost.contentHash, model: 'fixture', promptVersion: PROMPT_VERSION,
          status: 'failed', categories: [], tags: [], failureReason: privateError,
        }]]),
      });
      const zip = await JSZip.loadAsync(blob);
      const text = (await Promise.all(Object.values(zip.files)
        .filter((file) => !file.dir).map((file) => file.async('string')))).join('\n');
      expect(text).not.toMatch(/TEST_PRIVATE_(TOKEN|COOKIE|KEY)|Authorization: Bearer/);
      expect(text).toContain('AI 提炼失败');
      expect(text).toContain('HTTP 404');
      expect(text).toContain('https://pbs.twimg.com/media/pic2.jpg?name=large');
      expect(text).toContain(samplePost.text);
    });
    it('stops compression on cancellation and can package the same data again', async () => {
      const controller = new AbortController();
      const stages: string[] = [];
      await expect(buildExportZip({
        posts: [samplePost], mediaMap: new Map([[samplePost.id, sampleMedia]]), signal: controller.signal,
        onProgress: ({ stage, current }) => {
          stages.push(stage);
          if (stage === 'compressing' && current > 0) controller.abort();
        },
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(stages.at(-1)).toBe('compressing');
      expect(stages).not.toContain('done');
      const { blob } = await buildExportZip({ posts: [samplePost], mediaMap: new Map([[samplePost.id, sampleMedia]]) });
      const zip = await JSZip.loadAsync(blob, { checkCRC32: true });
      expect(await zip.file(`assets/${samplePost.postId}/01.png`)?.async('string')).toBe('png data 1');
    });

    it('keeps topics whose names collide on Windows in separate files', async () => {
      const { blob } = await buildExportZip({
        posts: [samplePost],
        mediaMap: new Map(),
        overridesMap: new Map([[samplePost.id, {
          postId: samplePost.id,
          updatedAt: samplePost.firstObservedAt,
          customCategories: ['A/B', 'A:B', 'a_b'],
          readingStatus: 'to_read',
        }]]),
      });
      const zip = await JSZip.loadAsync(blob);
      const files = Object.keys(zip.files).filter((name) => name.startsWith('topics/') && !zip.files[name].dir);
      expect(new Set(files.map((name) => name.toLowerCase())).size).toBe(3);
    });

    it('reports incomplete capture and deliberately remote media in the manifest', async () => {
      const { manifest, blob } = await buildExportZip({
        posts: [{ ...samplePost, captureStatus: 'partial',
          missingFields: ['quoted_post_media', 'quoted_post_media', 'private-fixture-token'] }],
        mediaMap: new Map([[samplePost.id, [{ ...sampleMedia[0], status: 'remote_only', blob: undefined }]]]),
      });
      expect(manifest.status).toBe('partial');
      expect(manifest.failuresCount).toBe(3);
      expect(manifest.assetsCount).toBe(0);
      expect(manifest.failures[0]).toMatchObject({ kind: 'capture', missingFields: ['quoted_post_media'] });
      expect(manifest.failures.slice(1).map(({ kind }) => kind)).toEqual(['media', 'media']);
      const zip = await JSZip.loadAsync(blob);
      expect(await zip.file('manifest.json')!.async('string')).not.toContain('private-fixture-token');
      const [markdown] = zip.file(/^posts\/.*\.md$/);
      expect(await markdown.async('string')).not.toContain('private-fixture-token');
    });

    it('records the package group in the ZIP and rejects colliding image paths', async () => {
      const packageInfo = { exportId: 'test-export', part: 2, totalParts: 3, totalPosts: 5, linksOnly: false };
      const image = { ...sampleMedia[0], blob: new Blob(['one'], { type: 'image/png' }) };
      const post = { ...samplePost, mediaIds: [image.id] };
      const options = { posts: [post], mediaMap: new Map([[post.id, [image]]]), packageInfo };
      const { blob } = await buildExportZip(options);
      const zip = await JSZip.loadAsync(blob, { checkCRC32: true });
      expect(JSON.parse(await zip.file('manifest.json')!.async('string'))).toMatchObject({
        packageInfo, postCount: 1, assetsCount: 1,
      });
      options.mediaMap.set(post.id, [image, { ...image, id: 'duplicate-position' }]);
      await expect(buildExportZip(options)).rejects.toThrow('媒体导出路径重复');
    });

    it('keeps four distinct image payloads in original order when stored records arrive out of order', async () => {
      const images = Array.from({ length: 4 }, (_, position): MediaAsset => ({
        ...sampleMedia[0],
        id: `four-image-${position}`,
        position,
        sourceUrl: `https://pbs.twimg.com/media/four-image-${position}.png`,
        blob: new Blob([String(position)], { type: 'image/png' }),
      }));
      const post = { ...samplePost, mediaIds: images.map(({ id }) => id) };
      const { blob, manifest } = await buildExportZip({
        posts: [post],
        mediaMap: new Map([[post.id, [images[2], images[0], images[3], images[1]]]]),
      });
      const zip = await JSZip.loadAsync(blob, { checkCRC32: true });
      const markdown = await zip.file(getPostRelativePath(post).fullPath)!.async('string');
      const paths = [...markdown.matchAll(/\.\.\/\.\.\/\.\.\/(assets\/\d+\/\d+\.png)/g)].map((match) => match[1]);
      expect(paths).toEqual(['01', '02', '03', '04'].map((number) => `assets/${post.postId}/${number}.png`));
      expect(await Promise.all(paths.map((path) => zip.file(path)!.async('string')))).toEqual(['0', '1', '2', '3']);
      expect(manifest.assetsCount).toBe(4);
    });

    it('marks a zero-byte local image as unarchived and keeps its remote link', async () => {
      const asset = { ...sampleMedia[0], blob: new Blob([], { type: 'image/png' }) };
      const post = { ...samplePost, mediaIds: [asset.id] };
      const { blob, manifest } = await buildExportZip({ posts: [post], mediaMap: new Map([[post.id, [asset]]]) });
      const zip = await JSZip.loadAsync(blob, { checkCRC32: true });
      const md = await zip.file(getPostRelativePath(post).fullPath)!.async('string');
      const reader = await zip.file('index.html')!.async('string');
      expect(manifest).toMatchObject({ status: 'partial', assetsCount: 0, failuresCount: 1 });
      expect(zip.file(`assets/${post.postId}/01.png`)).toBeNull();
      expect(md).toContain('未离线归档');
      expect(md).toContain(asset.sourceUrl);
      expect(reader).toContain('1 项媒体未离线归档');
    });

    it('builds a valid zip with files accessible at exact relative paths', async () => {
      const mediaMap = new Map<string, MediaAsset[]>([[samplePost.id, sampleMedia]]);

      const { blob, manifest } = await buildExportZip({
        posts: [samplePost],
        mediaMap,
      });

      expect(blob.size).toBeGreaterThan(0);
      expect(manifest.postCount).toBe(1);
      expect(manifest.assetsCount).toBe(1); // 1 downloaded asset
      expect(manifest.failuresCount).toBe(1); // 1 failed asset recorded

      // Unpack and verify structure with JSZip
      const unzipped = await JSZip.loadAsync(blob);
      const reader = await unzipped.file('index.html')!.async('string');
      expect(reader).toContain('搜索文库');
      expect(reader).toContain(samplePost.text);
      expect(reader).toContain('src="assets/1851234567890123002/01.png"');
      expect(reader).toContain('href="posts/2026/10/1851234567890123002.md"');
      expect(reader).toContain('1 项媒体未离线归档');

      // 1. Markdown file exists at posts/2026/10/1851234567890123002.md
      const mdFile = unzipped.file('posts/2026/10/1851234567890123002.md');
      expect(mdFile).not.toBeNull();
      const mdText = await mdFile!.async('string');
      expect(mdText).toContain(samplePost.text);

      // 2. Asset file exists at assets/1851234567890123002/01.png
      const assetFile = unzipped.file('assets/1851234567890123002/01.png');
      expect(assetFile).not.toBeNull();
      const assetData = await assetFile!.async('string');
      expect(assetData).toBe('png data 1');

      // 3. manifest.json exists and contains no leaked credentials
      const manifestFile = unzipped.file('manifest.json');
      expect(manifestFile).not.toBeNull();
      const manifestJson = JSON.parse(await manifestFile!.async('string'));
      expect(manifestJson.appName).toBe('LikeMind');
      expect(manifestJson.postCount).toBe(1);
      expect(manifestJson).not.toHaveProperty('apiKey');
      expect(manifestJson).not.toHaveProperty('cookies');
      expect(manifestJson).not.toHaveProperty('authToken');
    });
  });
});
