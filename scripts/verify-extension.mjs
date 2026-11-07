import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIKEMIND_PLAYWRIGHT_MODULE || 'playwright-core');
const dist = fileURLToPath(new URL('../dist', import.meta.url));
async function captureDocumentation(page, filename) {
  const directory = process.env.LIKEMIND_SCREENSHOTS_DIR;
  if (!directory) return;
  if (filename === 'library.png') await page.getByRole('heading', { name: '文库', exact: true }).waitFor();
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, filename), animations: 'disabled' });
}
const manifest = JSON.parse(await readFile(new URL('../dist/manifest.json', import.meta.url), 'utf8'));
assert.equal(manifest.manifest_version, 3);
const likesUrl = 'https://x.com/i/history/likes';
const postedAt = { 901: '2026-11-05T00:00:00Z', 902: '2020-02-03T04:05:06Z', 903: '2019-01-01T00:00:00Z' };
const missingImageUrl = 'https://pbs.twimg.com/media/likemind-missing.png';
const imageWidths = [16, 32, 48, 128];
const images = await Promise.all(imageWidths.map(async (width, index) => ({
  url: `https://pbs.twimg.com/media/likemind-fixture-${index + 1}.png${index === 0 ? '?name=large' : ''}`,
  bytes: await readFile(new URL(`../public/icons/icon${width}.png`, import.meta.url)),
})));

const loadViaCDP = process.env.LIKEMIND_EXTENSION_CDP === '1';
const context = await chromium.launchPersistentContext('', {
  executablePath: process.env.LIKEMIND_CHROMIUM,
  channel: 'chromium',
  headless: true,
  ignoreDefaultArgs: loadViaCDP ? ['--disable-extensions'] : [],
  args: [...(loadViaCDP ? ['--enable-unsafe-extension-debugging']
    : ['--disable-extensions-except=' + dist, '--load-extension=' + dist]), '--disable-background-networking'],
});
context.setDefaultTimeout(10_000);

function tweet(id) {
  return `<article data-testid="tweet">
    <div data-testid="User-Name"><span>Fixture</span><span>@fixture</span></div>
    <a href="/fixture/status/${id}"><time datetime="${postedAt[id]}">${postedAt[id].slice(0, 10)}</time></a>
    <div data-testid="tweetText">Offline fixture ${id}${id === 902
      ? '<br><br><pre>  const value = `例子 😄`;</pre><br>&lt;img data-fixture-injected src=x onerror=alert(1)&gt;<br>[链接](javascript:alert(1)) ../../fixture-escape'
      : ''}</div>
    ${id === 902 ? '<a href="/fixture/status/902?s=20">Show this thread</a>' : ''}
    ${id === 902 ? '<blockquote><a href="/quoted/status/904">Quoted post</a><div data-testid="tweetText">Visible quote preview</div><div data-testid="tweetPhoto"></div></blockquote>' : ''}
    ${id === 901 ? images.map(({ url }, index) =>
      index === 0
        ? `<div data-testid="tweetPhoto" style="background-image: url('${url}')"></div>`
        : `<div data-testid="tweetPhoto"><img src="${url}" alt="Fixture image ${index + 1}"></div>`).join('')
      : id === 902 ? `<div data-testid="tweetPhoto"><img src="${missingImageUrl}" alt="Missing fixture image"></div><video></video><div data-testid="tweetPhoto"></div>` : ''}
  </article>`;
}

try {
  if (loadViaCDP) {
    const browserSession = await context.browser().newBrowserCDPSession();
    await browserSession.send('Extensions.loadUnpacked', { path: dist });
    await browserSession.detach();
  }
  let ids = [901];
  await context.route(/^https?:\/\//, (route) => route.abort());
  for (const { url, bytes } of images) {
    await context.route(url, (route) => route.fulfill({ contentType: 'image/png', body: bytes }));
  }
  let originalImageRequests = 0;
  await context.route(images[0].url.replace('name=large', 'name=orig'), (route) => {
    originalImageRequests++;
    return route.fulfill({ contentType: 'image/png', body: images[0].bytes.subarray(0, 8) });
  });
  await context.route(/^https:\/\/pbs\.twimg\.com\/media\/likemind-missing(?:[.?/:]|$)/,
    (route) => route.fulfill({ status: 404 }));
  await context.route(likesUrl, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<main data-testid="primaryColumn"><a data-testid="AppTabBar_Profile_Link" href="/fixture">Profile</a>${ids.map(tweet).join('')}</main>`,
  }));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const origin = worker.url().split('/').slice(0, 3).join('/');
  const extensions = await context.newPage();
  await extensions.goto('chrome://extensions/');
  const card = extensions.locator('extensions-item').filter({ hasText: manifest.name });
  await card.waitFor();
  const cdp = await context.newCDPSession(extensions);
  const { product } = await cdp.send('Browser.getVersion');
  assert.equal(await card.locator('#errors-button').isVisible(), false);
  let dashboard = await context.newPage();
  await dashboard.goto(origin + '/dashboard.html#sync');
  const installed = await dashboard.evaluate(() => chrome.runtime.getManifest());
  assert.equal(installed.name, manifest.name);
  assert.equal(installed.version, manifest.version);
  assert.equal(installed.manifest_version, manifest.manifest_version);
  console.log(`PASS: ${product}, ${installed.name} ${installed.version} loaded in chrome://extensions`);
  let source = await context.newPage();
  await source.goto(likesUrl);

  const sendCaptureMessage = (payload) => dashboard.evaluate(async ({ url, payload }) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.tabs.sendMessage(tab.id, payload);
  }, { url: likesUrl, payload });
  async function waitForRun(matches) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const reply = await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_QUICK_STATS' }));
      if (reply.success && matches(reply.stats)) return reply.stats.latestRun;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Fixture run did not reach its expected state');
  }
  const start = { type: 'START_READING', limit: 2, downloadMedia: true };
  assert.equal((await sendCaptureMessage({ type: 'PING' })).status, 'ok');
  assert.equal((await sendCaptureMessage(start)).started, true);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await sendCaptureMessage({ type: 'PAUSE_READING' });
  const paused = await waitForRun((stats) => stats.latestRun?.status === 'paused' && stats.totalPosts === 1);
  const workerSession = await context.newCDPSession(dashboard);
  let workerVersion;
  workerSession.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
    const extensionVersion = versions.find((version) => version.scriptURL === worker.url());
    if (extensionVersion) workerVersion = extensionVersion;
  });
  await workerSession.send('ServiceWorker.enable');
  async function waitForWorkerStatus(status) {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (workerVersion?.runningStatus === status) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Expected extension worker status ${status}, got ${workerVersion?.runningStatus}`);
  }
  await waitForWorkerStatus('running');
  await workerSession.send('ServiceWorker.stopWorker', { versionId: workerVersion.versionId });
  await waitForWorkerStatus('stopped');
  const recovered = await waitForRun((stats) => stats.latestRun?.status === 'paused' && stats.totalPosts === 1);
  await waitForWorkerStatus('running');
  assert.equal(recovered.id, paused.id);
  assert.deepEqual(recovered.stats, paused.stats);
  console.log('PASS: service worker stopped and restarted with the saved pause checkpoint');
  const loginUrl = 'https://x.com/i/flow/login';
  await context.route(loginUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Offline login fixture</h1>' }));
  await source.goto(loginUrl);
  await dashboard.getByRole('button', { name: '先浏览' }).click();
  await dashboard.getByRole('button', { name: '检测状态' }).click();
  await dashboard.getByText('X 需要登录或验证', { exact: true }).waitFor();
  assert.equal(await dashboard.getByRole('button', { name: '继续这次采集' }).isDisabled(), true);
  const loginBlocked = await waitForRun((stats) => stats.latestRun?.status === 'paused' && stats.totalPosts === 1);
  assert.equal(loginBlocked.id, paused.id);
  assert.deepEqual(loginBlocked.stats, paused.stats);
  console.log('PASS: login redirect blocks resume and preserves the paused checkpoint');
  await dashboard.close();
  await source.close();

  ids = [901, 902];
  source = await context.newPage();
  await source.goto(likesUrl);
  dashboard = await context.newPage();
  await dashboard.goto(origin + '/dashboard.html#sync');
  await dashboard.getByText('已暂停', { exact: true }).first().waitFor();
  assert.equal((await sendCaptureMessage(start)).started, true);
  const finished = await waitForRun((stats) => stats.latestRun?.status === 'partial' && stats.totalPosts === 2);
  assert.equal(finished.id, paused.id);
  assert.deepEqual(finished.stats, { scanned: 2, added: 2, updated: 0, skipped: 0, failed: 0 });

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(origin + '/popup.html');
  await popup.getByRole('button', { name: '设置', exact: true }).click();
  await popup.getByRole('checkbox', { name: '保存图片' }).waitFor();
  assert.equal(await popup.getByRole('button', { name: '返回' }).evaluate((button) => button === document.activeElement), true);
  await popup.keyboard.press('Shift+Tab');
  assert.equal(await popup.getByRole('button', { name: '打开完整设置' }).evaluate((button) => button === document.activeElement), true);
  await popup.keyboard.press('Tab');
  assert.equal(await popup.getByRole('button', { name: '返回' }).evaluate((button) => button === document.activeElement), true);
  assert.equal(await popup.getByRole('button', { name: '打开文库' }).count(), 0);
  await popup.keyboard.press('Escape');
  await captureDocumentation(popup, 'popup.png');
  assert.equal(await popup.getByRole('button', { name: '设置', exact: true }).evaluate((button) => button === document.activeElement), true);
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth), 380);
  const libraryPage = context.waitForEvent('page');
  await popup.getByRole('button', { name: '打开文库' }).click();
  await dashboard.close();
  dashboard = await libraryPage;
  await dashboard.waitForURL('**/dashboard.html?profile=*#library');
  await popup.close();
  await dashboard.setViewportSize({ width: 1280, height: 800 });
  await dashboard.getByRole('button', { name: '先浏览' }).click();
  const navPositions = async () => {
    const nav = dashboard.getByRole('navigation', { name: '主导航' });
    return Promise.all(['总览', '文库'].map(async (label) => {
      const box = await nav.getByRole('button', { name: label }).boundingBox();
      return { x: box.x, y: box.y };
    }));
  };
  const libraryNavPositions = await navPositions();
  const switcher = dashboard.getByRole('button', { name: '切换用户文库' });
  const librarySwitcherPosition = await switcher.boundingBox();
  assert.equal(await switcher.count(), 1);
  await dashboard.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '总览' }).click();
  await dashboard.getByRole('button', { name: '打开文库', exact: true }).waitFor();
  assert.deepEqual(await navPositions(), libraryNavPositions);
  const overviewSwitcherPosition = await switcher.boundingBox();
  assert.equal(overviewSwitcherPosition.x, librarySwitcherPosition.x);
  assert.equal(overviewSwitcherPosition.y, librarySwitcherPosition.y);
  await dashboard.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '文库' }).click();
  await captureDocumentation(dashboard, 'library.png');
  const search = dashboard.getByLabel('搜索文库');
  const filters = dashboard.getByRole('complementary', { name: '文库筛选' });
  assert.ok((await filters.boundingBox()).x < (await search.boundingBox()).x);
  await dashboard.setViewportSize({ width: 640, height: 800 });
  assert.ok((await filters.boundingBox()).y > (await search.boundingBox()).y);
  assert.equal(await dashboard.evaluate(() => document.documentElement.scrollWidth), 640);
  await dashboard.setViewportSize({ width: 1280, height: 800 });
  await dashboard.getByRole('button', { name: '列表', exact: true }).click();
  await dashboard.getByRole('button', { name: '全选当前筛选' }).click();
  await dashboard.getByText('已选 2 篇').waitFor();
  await dashboard.getByLabel('搜索文库').fill('ＦＩＸＴＵＲＥ　９０１');
  await dashboard.getByText('已选 1 篇').waitFor();
  await dashboard.getByRole('button', { name: '标为待做' }).click();
  const visiblePost = dashboard.locator('.lm-list-item');
  await visiblePost.getByText('待做', { exact: true }).waitFor();
  await dashboard.getByRole('button', { name: '全选当前筛选' }).click();
  await dashboard.getByRole('button', { name: '标为待读' }).click();
  await visiblePost.getByText('待做', { exact: true }).waitFor({ state: 'hidden' });
  await dashboard.getByRole('button', { name: 'Offline fixture 901', exact: true }).press('Enter');
  const original = dashboard.getByRole('link', { name: '访问原帖', exact: true });
  await original.waitFor();
  assert.equal(await original.getAttribute('href'), 'https://x.com/fixture/status/901');
  await dashboard.keyboard.press('Escape');
  await search.fill('fixture 902');
  await dashboard.getByRole('button', { name: /^Offline fixture 902/ }).press('Enter');
  await dashboard.getByText('这里只保存了可见内容。请前往 X 查看串帖其余部分。').waitFor();
  assert.equal(await dashboard.getByRole('link', { name: '在 X 查看串帖' }).getAttribute('href'),
    'https://x.com/fixture/status/902');
  await dashboard.getByText(/引用帖只保存了可见预览/).waitFor();
  await dashboard.getByText(/视频内容未归档/).waitFor();
  await dashboard.getByText(/有媒体未能从原帖识别/).waitFor();
  assert.equal(await dashboard.getByRole('link', { name: '引用帖', exact: true }).getAttribute('href'),
    'https://x.com/quoted/status/904');
  await dashboard.keyboard.press('Escape');
  await search.fill('fixture 901');
  await dashboard.getByRole('button', { name: '平铺', exact: true }).click();
  await dashboard.locator('.lm-post-card').waitFor();
  console.log('PASS: popup settings and library shortcut, responsive filters, list keyboard and card view');
  await dashboard.getByRole('button', { name: '收录简报' }).click();
  await dashboard.getByRole('heading', { name: '共性', exact: true }).waitFor();
  await dashboard.getByRole('heading', { name: '差异', exact: true }).waitFor();
  await dashboard.getByRole('heading', { name: '可尝试的实践项', exact: true }).waitFor();
  await dashboard.getByRole('button', { name: '全部推文' }).click();
  await dashboard.getByLabel('搜索文库').fill('Offline fixture');
  await dashboard.getByRole('button', { name: '导出筛选结果' }).click();
  const download = dashboard.waitForEvent('download');
  await dashboard.getByRole('button', { name: '导出 2 篇' }).click();
  const zip = await JSZip.loadAsync(await readFile(await (await download).path()), { checkCRC32: true });
  assert.equal(originalImageRequests, 1);
  console.log('PASS: a truncated PNG with a valid signature falls back to a decodable photo');
  await dashboard.getByRole('button', { name: '完成', exact: true }).click();
  await dashboard.getByRole('button', { name: '导出筛选结果' }).click();
  await dashboard.evaluate(() => {
    const createObjectURL = URL.createObjectURL;
    URL.createObjectURL = () => {
      URL.createObjectURL = createObjectURL;
      throw new Error('fixture-private-stack-message https://x.com/private-account?token=fixture-private');
    };
  });
  await dashboard.getByRole('button', { name: '导出 2 篇' }).click();
  await dashboard.getByText('第 1 包导出失败。', { exact: true }).first().waitFor();
  await dashboard.getByRole('button', { name: '关闭导出' }).click();
  await dashboard.getByRole('button', { name: '导出筛选结果' }).click();
  await dashboard.getByRole('checkbox', { name: '仅导出文字与图片链接' }).check();
  const linksDownload = dashboard.waitForEvent('download');
  await dashboard.getByRole('button', { name: '导出 2 篇' }).click();
  const linksZip = await JSZip.loadAsync(await readFile(await (await linksDownload).path()), { checkCRC32: true });
  assert.equal(linksZip.file(/^assets\//).length, 0);
  const linksMarkdown = await linksZip.file('posts/2026/11/901.md').async('string');
  assert.match(linksMarkdown, /仅保留原图链接/);
  assert.ok(linksMarkdown.includes(images[0].url));
  const linksManifest = JSON.parse(await linksZip.file('manifest.json').async('string'));
  assert.equal(linksManifest.postCount, 2);
  assert.match(linksManifest.packageInfo.exportId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual({ ...linksManifest.packageInfo, exportId: undefined },
    { exportId: undefined, part: 1, totalParts: 1, totalPosts: 2, linksOnly: true });
  assert.equal(linksManifest.assetsCount, 0);
  assert.equal(linksManifest.status, 'partial');
  await dashboard.getByRole('button', { name: '完成', exact: true }).click();
  console.log('PASS: link-only ZIP keeps both posts and remote image links without embedding image bytes');
  await dashboard.getByRole('button', { name: '导出筛选结果' }).click();
  await dashboard.getByText('已发起下载 1 / 1 包').waitFor();
  await dashboard.getByText(/· 已保存/).waitFor();
  await dashboard.getByRole('button', { name: '关闭导出' }).click();
  console.log('PASS: reopened ZIP history checks the browser download record');
  const digestFile = zip.file(/^digests\/[^/]+\.md$/);
  assert.equal(digestFile.length, 1);
  const digest = await digestFile[0].async('string');
  assert.match(digest, /new_posts_count: 2/);
  assert.match(digest, /## 共性[\s\S]*## 差异[\s\S]*## 可尝试的实践项/);
  console.log('PASS: incremental synthesis sections are visible in the library and exported in the batch Markdown');
  const markdown = await zip.file('posts/2026/11/901.md').async('string');
  assert.ok(markdown.includes(`[采集地址](${images[0].url})`));
  assert.ok(markdown.includes('Offline fixture 901'));
  const references = [...markdown.matchAll(/!\[[^\]]*\]\(\.\.\/\.\.\/\.\.\/(assets\/901\/\d+\.png)\)/g)]
    .map((match) => match[1]);
  assert.deepEqual(references, ['01', '02', '03', '04'].map((number) => `assets/901/${number}.png`));
  for (const [index, reference] of references.entries()) {
    assert.deepEqual(await zip.file(reference).async('nodebuffer'), images[index].bytes);
  }
  const missingMarkdown = await zip.file('posts/2020/02/902.md').async('string');
  assert.match(missingMarkdown, /^capture_status: "partial"$/m);
  assert.ok(missingMarkdown.includes('[在 X 查看串帖](https://x.com/fixture/status/902)'));
  assert.ok(missingMarkdown.includes('这里只保存了可见内容'));
  assert.ok(missingMarkdown.includes('Visible quote preview'));
  assert.ok(missingMarkdown.includes('[引用帖](https://x.com/quoted/status/904)'));
  assert.ok(missingMarkdown.includes('quoted_post_media'));
  assert.ok(missingMarkdown.includes('视频内容未归档'));
  assert.ok(missingMarkdown.includes('有媒体未能从原帖识别'));
  for (const [id, content] of [[901, markdown], [902, missingMarkdown]]) {
    const frontmatter = content.split('\n---\n', 1)[0];
    const exportedPostTime = frontmatter.match(/^posted_at: "([^"]+)"$/m)?.[1];
    const observedTime = frontmatter.match(/^first_observed_at: "([^"]+)"$/m)?.[1];
    assert.equal(Date.parse(exportedPostTime), Date.parse(postedAt[id]));
    assert.ok(Date.parse(observedTime) >= Date.parse(finished.startedAt));
    assert.ok(Date.parse(observedTime) <= Date.parse(finished.endedAt));
    assert.match(frontmatter, /^liked_at: null$/m);
  }
  assert.ok(missingMarkdown.includes('Offline fixture 902'));
  assert.ok(missingMarkdown.includes('Offline fixture 902\n\n  const value = `例子 😄`;'));
  assert.ok(missingMarkdown.includes('&lt;img data-fixture-injected src=x onerror=alert(1)>'));
  assert.ok(missingMarkdown.includes('\\[链接\\](javascript:alert(1))'));
  assert.ok(missingMarkdown.includes('../../fixture-escape'));
  assert.ok(Object.values(zip.files).every((file) =>
    !(file.unsafeOriginalName ?? file.name).split('/').includes('..')));
  assert.ok(missingMarkdown.includes('未离线归档: HTTP 404'));
  assert.ok(missingMarkdown.includes(missingImageUrl));
  assert.equal(zip.file('assets/902/01.png'), null);
  const exportManifest = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(exportManifest.status, 'partial');
  assert.equal(exportManifest.postCount, 2);
  assert.equal(exportManifest.assetsCount, 4);
  assert.ok(exportManifest.failures.some((failure) => failure.postId === 'x:902' &&
    failure.kind === 'media' && failure.reason === 'Media 902_media_0: failed'));
  const captureGap = exportManifest.failures.find((failure) => failure.postId === 'x:902' && failure.kind === 'capture');
  assert.ok(captureGap?.missingFields.includes('thread_continuation'));
  assert.ok(captureGap.missingFields.includes('quoted_post_media'));

  const reader = await context.newPage();
  await reader.route('http://offline.fixture/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice(1);
    const file = zip.file(path);
    if (!file) return route.abort();
    return route.fulfill({
      contentType: path.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8',
      body: await file.async('nodebuffer'),
    });
  });
  await reader.goto('http://offline.fixture/index.html#post=x%3A901');
  const articleImages = reader.locator('#article img[src^="assets/901/"]');
  await articleImages.last().waitFor();
  assert.deepEqual(await articleImages.evaluateAll(async (elements) => Promise.all(elements.map(async (element) => {
    element.loading = 'eager';
    await element.decode();
    return element.naturalWidth;
  }))), imageWidths);
  await reader.goto('http://offline.fixture/index.html#post=x%3A902');
  const article = reader.locator('#article');
  await article.getByText(/const value =/).waitFor();
  const threadLink = article.getByRole('link', { name: '在 X 查看串帖' });
  assert.equal(await threadLink.getAttribute('href'), 'https://x.com/fixture/status/902');
  await article.getByText('这里只保存了可见内容。请前往 X 查看串帖其余部分。').waitFor();
  await article.getByText(/视频内容未归档/).waitFor();
  await article.getByText(/有媒体未能从原帖识别/).waitFor();
  await article.getByText(/引用帖只保存了可见预览/).waitFor();
  console.log('PASS: explicit thread continuation remains partial with its original link in Markdown and the offline reader');
  assert.ok((await article.textContent()).includes('<img data-fixture-injected src=x onerror=alert(1)>'));
  assert.equal(await article.locator('[data-fixture-injected]').count(), 0);
  assert.equal(await card.locator('#errors-button').isVisible(), false);
  console.log('PASS: installed MV3 capture, pause, resume, library detail, and four offline images in source order');
  console.log('PASS: HTTP 404 media keeps the post and remote link and marks the ZIP partial');
  console.log('PASS: multiline code, Unicode and untrusted markup survive the export safely');
  console.log('PASS: earlier post is added on resume; posted and observed times stay distinct and liked_at stays null');

  ids = [903];
  await source.evaluate(() => { history.scrollRestoration = 'manual'; });
  await source.reload();
  await source.evaluate(async () => {
    // Let navigation and layout settle before counting collector scroll events.
    document.body.style.minHeight = '300vh';
    window.scrollTo(0, 0);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.addEventListener('scroll', () => {
      const notice = document.createElement('p');
      notice.setAttribute('role', 'alert');
      notice.textContent = 'Rate limit exceeded';
      document.querySelector('main').prepend(notice);
    }, { once: true });
  });
  const limitedStart = await sendCaptureMessage(start);
  assert.equal(limitedStart.started, true, limitedStart.reason);
  const nextRun = await waitForRun((stats) => stats.latestRun?.id !== finished.id &&
    stats.latestRun?.status === 'partial' && stats.totalPosts === 3);
  assert.equal(nextRun.failureCode, 'access_restricted');
  assert.deepEqual(nextRun.stats, { scanned: 1, added: 1, updated: 0, skipped: 0, failed: 0 });
  await dashboard.goto(origin + '/dashboard.html#sync');
  await dashboard.getByRole('button', { name: '先浏览' }).click();
  await dashboard.getByRole('button', { name: '检测状态' }).click();
  await dashboard.getByText('X 请求频率受限', { exact: true }).waitFor();
  const blockedStart = await sendCaptureMessage(start);
  assert.equal(blockedStart.started, false);
  assert.match(blockedStart.reason, /请求频率受限/);
  const restrictedRun = dashboard.getByRole('row').filter({ hasText: 'access_restricted' });
  await restrictedRun.getByText('部分', { exact: true }).waitFor();
  await restrictedRun.getByText(/请求频率受限/).waitFor();
  await source.locator('[role="alert"]').filter({ hasText: 'Rate limit exceeded' }).evaluate((notice) => notice.remove());
  await dashboard.getByRole('button', { name: '检测状态' }).click();
  await dashboard.getByText('可以开始读取', { exact: true }).waitFor();
  await dashboard.goto(origin + '/dashboard.html#library');
  await dashboard.getByRole('button', { name: '先浏览' }).click();
  for (const id of [901, 902, 903]) {
    await dashboard.getByLabel('搜索文库').fill(`fixture ${id}`);
    await dashboard.getByText(new RegExp(`^Offline fixture ${id}`)).first().waitFor();
  }
  console.log('PASS: scroll-triggered rate limit shows a partial run and all three posts remain in the library');

  await source.reload();
  await source.evaluate(() => {
    const card = document.createElement('article');
    card.dataset.testid = 'tweet';
    card.textContent = 'Card without an identifiable post';
    document.querySelector('main').append(card);
  });
  assert.equal((await sendCaptureMessage(start)).started, true);
  const parseRun = await waitForRun((stats) => stats.latestRun?.id !== nextRun.id &&
    stats.latestRun?.status === 'partial' && stats.latestRun?.failureCode === 'parse_failed' && stats.totalPosts === 3);
  assert.deepEqual(parseRun.stats, { scanned: 1, added: 0, updated: 0, skipped: 1, failed: 0 });
  await dashboard.goto(origin + '/dashboard.html#sync');
  const parseRow = dashboard.getByRole('row').filter({ hasText: 'parse_failed' });
  await parseRow.getByText('部分', { exact: true }).waitFor();
  await parseRow.getByText(/卡片无法解析/).waitFor();
  assert.equal(await parseRow.getByText('本次扫描未发现新帖。').count(), 0);
  console.log('PASS: unreadable card is reported separately from zero new posts');

  await source.reload();
  assert.equal((await sendCaptureMessage(start)).started, true);
  const unchanged = await waitForRun((stats) => stats.latestRun?.id !== parseRun.id &&
    stats.latestRun?.status === 'partial' && stats.latestRun?.failureCode === 'range_unknown' && stats.totalPosts === 3);
  assert.deepEqual(unchanged.stats, parseRun.stats);
  const noNewRow = dashboard.getByRole('row').filter({ hasText: 'range_unknown' });
  await noNewRow.getByText('本次扫描未发现新帖。', { exact: true }).waitFor();
  await noNewRow.getByText(/不代表历史点赞已全部采集/).waitFor();
  console.log('PASS: a clean scan of an archived post says no new posts within this scan');

  await dashboard.getByRole('button', { name: '先浏览' }).click();
  await dashboard.getByRole('button', { name: '自检排查' }).click();
  const diagnostics = dashboard.getByRole('dialog', { name: '运行自检与诊断' });
  await diagnostics.getByText(/采集状态：完整/).waitFor();
  await diagnostics.getByRole('button', { name: '脱敏诊断报告 (JSON)' }).click();
  await diagnostics.locator('pre').filter({ hasText: /"recentRuns"/ }).waitFor();
  const diagnosticDownload = dashboard.waitForEvent('download');
  await diagnostics.getByRole('button', { name: '下载报告 (JSON)' }).click();
  const diagnosticJson = await readFile(await (await diagnosticDownload).path(), 'utf8');
  const report = JSON.parse(diagnosticJson);
  assert.equal(report.version, installed.version);
  const captureQuality = report.checks.storage.captureQuality;
  assert.equal(Object.values(captureQuality.statuses).reduce((sum, value) => sum + value, 0), report.checks.storage.totalPosts);
  assert.ok(captureQuality.statuses.partial >= 1);
  assert.deepEqual(Object.keys(captureQuality.missingFields).sort(), ['authorHandle', 'postedAt', 'text', 'truncated_text', 'media', 'article_body', 'thread_continuation', 'quoted_post_body', 'quoted_post_media', 'video_body', 'unknown'].sort());
  assert.match(report.checks.extension.environment, /^Chrome \d+ · (Windows|macOS|Linux)$/);
  assert.ok(report.recentRuns.some((run) => run.failureCode === 'parse_failed'));
  const failedZip = report.recentZipExports.find((job) => job.status === 'failed');
  assert.ok(failedZip?.diagnosticFrames?.some((frame) => /^assets\/App-/.test(frame)));
  assert.doesNotMatch(diagnosticJson, /fixture-private|chrome-extension:\/\//);
  assert.doesNotMatch(diagnosticJson, /x\.com|Offline fixture 90|failureMessage|UserAgent|Mozilla\//);
  console.log('PASS: downloaded diagnostics report contains runtime metadata and known codes without post content or URLs');

  // The loopback endpoint is intercepted. No provider or real API key is used.
  const apiBase = 'http://127.0.0.1:41414/v1';
  const requests = [];
  let releaseFirstRequest;
  const firstRequestGate = new Promise((resolve) => { releaseFirstRequest = resolve; });
  await context.route(apiBase + '/chat/completions', async (route) => {
    if (route.request().method() !== 'POST') return route.abort();
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      await firstRequestGate;
      return route.fulfill({ status: 500, body: 'Offline endpoint fixture failure' });
    }
    const content = requests.length === 2 ? '{invalid json' :
      JSON.stringify({ titleZh: '本地接口样本标题', summaryZh: '本地接口样本摘要', categories: ['编程开发'],
        prerequisites: Array.from({ length: 9 }, (_, index) => `样本前置条件 ${index + 1}`) });
    return route.fulfill({ json: { choices: [{ message: { content } }] } });
  });
  await dashboard.evaluate((baseUrl) => chrome.storage.local.set({
    ai_config: { baseUrl, modelName: 'fixture-model', allowSendImages: false, useMock: false, timeoutSec: 20 },
  }), apiBase);

  async function openAIReader() {
    const page = await context.newPage();
    await page.goto(origin + '/dashboard.html#library');
    await page.getByRole('button', { name: '先浏览' }).click();
    await page.getByLabel('搜索文库').fill('fixture 901');
    await page.getByText('Offline fixture 901', { exact: true }).click();
    return page;
  }
  const firstReader = await openAIReader();
  const secondReader = await openAIReader();
  const firstAnalyze = firstReader.getByRole('button', { name: '写摘要' });
  const secondAnalyze = secondReader.getByRole('button', { name: '写摘要' });

  firstReader.once('dialog', (dialog) => dialog.dismiss());
  await firstAnalyze.click();
  await firstAnalyze.waitFor();
  assert.equal(requests.length, 0);
  try {
    firstReader.once('dialog', (dialog) => dialog.accept());
    await firstAnalyze.click();
    await firstReader.waitForFunction(async () =>
      (await navigator.locks.query()).held.some((lock) => lock.name.endsWith(':x:901')));
    secondReader.once('dialog', (dialog) => dialog.accept());
    await secondAnalyze.click();
    await secondReader.waitForFunction(async () =>
      (await navigator.locks.query()).pending.some((lock) => lock.name.endsWith(':x:901')));
  } finally {
    releaseFirstRequest();
  }
  await firstReader.getByText(/HTTP 500/).waitFor();
  await secondReader.getByText(/请检查结果后手动重试/).waitFor();
  assert.equal(requests.length, 1);

  secondReader.once('dialog', (dialog) => dialog.accept());
  await secondAnalyze.click();
  await secondReader.getByText(/本地接口样本摘要/).waitFor();
  assert.equal(requests.length, 3);
  assert.equal(requests[0].model, 'fixture-model');
  assert.match(JSON.stringify(requests[0].messages), /Offline fixture 901/);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /data:image|image_url/);
  assert.match(requests[2].messages.at(-1).content, /结构校验/);
  await secondReader.getByRole('button', { name: '检查更新' }).click();
  await secondReader.getByText('已使用现有摘要。').waitFor();
  assert.equal(requests.length, 3);
  console.log('PASS: two extension windows confirm transfer, avoid duplicate failed requests, repair invalid JSON, and reuse the summary');
  await secondReader.keyboard.press('Escape');
  await secondReader.getByLabel('搜索文库').fill('fixture 902');
  await secondReader.getByText(/^Offline fixture 902/).first().click();
  secondReader.once('dialog', (dialog) => dialog.accept());
  await secondReader.getByRole('button', { name: '写摘要' }).click();
  await secondReader.getByText(/本地接口样本摘要/).waitFor();
  assert.equal(requests.length, 4);
  await secondReader.keyboard.press('Escape');
  await secondReader.getByRole('button', { name: '主题汇总', exact: true }).click();
  await secondReader.getByLabel('查看主题').selectOption('编程开发');
  const commonPanel = secondReader.getByRole('heading', { name: '共性', exact: true }).locator('..');
  await commonPanel.getByText('样本前置条件 8', { exact: true }).waitFor();
  assert.equal(await commonPanel.getByText('样本前置条件 9', { exact: true }).count(), 0);
  await commonPanel.getByRole('button', { name: '共性下一页' }).press('Enter');
  await commonPanel.getByText('样本前置条件 9', { exact: true }).waitFor();
  await commonPanel.getByText('原帖出处（2）', { exact: true }).click();
  assert.deepEqual((await commonPanel.getByRole('link').evaluateAll((links) =>
    links.map((link) => link.getAttribute('href')))).sort(),
    ['https://x.com/fixture/status/901', 'https://x.com/fixture/status/902']);
  await commonPanel.getByRole('button', { name: '共性上一页' }).press('Enter');
  await commonPanel.getByText('样本前置条件 1', { exact: true }).waitFor();
  console.log('PASS: installed topic summary pages through nine shared conditions and preserves both source links');
  await secondReader.getByRole('button', { name: '全部推文', exact: true }).click();
  await secondReader.getByLabel('搜索文库').fill('fixture 901');
  await secondReader.getByText('Offline fixture 901', { exact: true }).click();
  await secondReader.getByRole('button', { name: '写笔记', exact: true }).first().click();
  assert.equal(await secondReader.getByRole('dialog', { name: '编辑笔记与标注', exact: true }).evaluate(node => node.contains(document.activeElement)), true);
  await secondReader.getByPlaceholder('给这篇推文起个便于检索的标题').fill('人工修订样本标题');
  await secondReader.getByPlaceholder('前端, Vite, 工具...').fill('人工标签');
  await secondReader.getByPlaceholder('写下你的想法、要点或总结...').fill('人工笔记样本');
  await secondReader.getByRole('button', { name: '保存笔记', exact: true }).click();
  await secondReader.getByRole('heading', { name: '人工修订样本标题', exact: true }).waitFor();
  await secondReader.evaluate(async () => {
    const stored = await chrome.storage.local.get('ai_config');
    await chrome.storage.local.set({ ai_config: { ...stored.ai_config, modelName: 'fixture-model-updated' } });
  });
  await secondReader.reload();
  await secondReader.getByRole('button', { name: '先浏览' }).click();
  await secondReader.getByLabel('搜索文库').fill('人工标签 人工笔记样本');
  await secondReader.getByText('人工修订样本标题', { exact: true }).click();
  secondReader.once('dialog', (dialog) => dialog.accept());
  await secondReader.getByRole('button', { name: '检查更新' }).click();
  await secondReader.getByText(/本地接口样本摘要/).waitFor();
  await secondReader.getByRole('button', { name: '检查更新' }).waitFor();
  assert.equal(requests.length, 5);
  assert.equal(requests[4].model, 'fixture-model-updated');
  await secondReader.keyboard.press('Escape');
  await secondReader.getByRole('button', { name: '导出筛选结果' }).click();
  const correctedDownload = secondReader.waitForEvent('download');
  await secondReader.getByRole('button', { name: '导出 1 篇', exact: true }).click();
  const correctedZip = await JSZip.loadAsync(await readFile(await (await correctedDownload).path()), { checkCRC32: true });
  const correctedMarkdown = await correctedZip.file('posts/2026/11/901.md').async('string');
  assert.match(correctedMarkdown, /^# 人工修订样本标题$/m);
  assert.match(correctedMarkdown, /人工标签/);
  assert.match(correctedMarkdown, /人工笔记样本/);
  assert.match(correctedMarkdown, /本地接口样本摘要/);
  assert.equal(correctedZip.file(/^posts\/.*\.md$/).length, 1);
  console.log('PASS: manual title, tags and notes survive a new model analysis and remain in the filtered ZIP');
  await source.reload();
  // Bind a tiny browser-private directory through the normal persisted handle shape.
  await secondReader.evaluate(async () => {
    const handle = await (await navigator.storage.getDirectory()).getDirectoryHandle('popup-fixture', { create: true });
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('LikeMindDatabase');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const tx = database.transaction('folders', 'readwrite');
        tx.objectStore('folders').put({ id: 'knowledge-library', handle, boundAt: new Date().toISOString(), managedName: 'fixture-popup' });
        tx.oncomplete = () => { database.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  // Use only the tiny existing ZIP fixture, never the user's local archive.
  const localFiles = await Promise.all(Object.values(correctedZip.files).filter(file => !file.dir)
    .map(async file => ({ path: file.name, bytes: [...await file.async('uint8array')] })));
  await secondReader.evaluate(async files => {
    const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle('popup-fixture');
    const root = await parent.getDirectoryHandle('fixture-popup', { create: true });
    for (const { path, bytes } of files) {
      const parts = path.split('/');
      let folder = root;
      for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create: true });
      const writer = await (await folder.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await writer.write(new Uint8Array(bytes));
      await writer.close();
    }
  }, localFiles);
  await secondReader.keyboard.press('Escape');
  const openedLocal = context.waitForEvent('page');
  await secondReader.getByRole('button', { name: '打开本地文库', exact: true }).click();
  const localReader = await openedLocal;
  await localReader.waitForLoadState();
  localReader.on('console', message => { if (message.type() === 'error') console.error('local-reader:', message.text()); });
  localReader.on('pageerror', error => console.error('local-reader:', error.message));
  const offline = localReader.frameLocator('iframe');
  await offline.getByText('人工修订样本标题', { exact: true }).first().waitFor();
  await offline.locator('#search').fill('人工笔记样本');
  await offline.getByText('人工修订样本标题', { exact: true }).first().click();
  await offline.locator('#article').getByText('人工笔记样本', { exact: true }).waitFor();
  await offline.locator('#copy-link').click();
  const localPostLink = await offline.locator('#link-value').inputValue();
  assert.ok(localPostLink.startsWith(origin + '/local-library.html?profile=default&file=index.html#post='));
  await offline.locator('#article .photos img').first().waitFor();
  await offline.locator('#article .photos img').first().evaluate(img => new Promise((resolve, reject) => {
    if (img.complete && img.naturalWidth) return resolve();
    const timeout = setTimeout(() => reject(new Error('local reader image did not load')), 5000);
    img.addEventListener('load', () => { clearTimeout(timeout); resolve(); }, { once: true });
  }));
  await offline.locator('#article .photos a').first().click();
  await offline.locator('#gallery[open]').waitFor();
  await offline.locator('#gallery-close').click();
  await offline.getByRole('link', { name: '打开 Markdown', exact: true }).click();
  await localReader.locator('#status').getByText(/# 人工修订样本标题/).waitFor();
  await localReader.getByRole('button', { name: '重新读取 / 授权', exact: true }).click();
  await offline.getByText('人工修订样本标题', { exact: true }).first().waitFor();
  const unboundLocal = await context.newPage();
  await unboundLocal.goto(origin + '/local-library.html?profile=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  await unboundLocal.getByText(/当前文库还没有本地入口/).waitFor();
  await unboundLocal.close();
  await secondReader.evaluate(async () => {
    const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle('popup-fixture');
    const root = await parent.getDirectoryHandle('fixture-popup');
    const writer = await (await root.getFileHandle('index.html')).createWritable();
    await writer.write('<html><body><input id="search"><div id="posts"><details><summary>旧版样本</summary><section>保留的旧版正文</section></details></div><script>throw Error("disk script must not execute")</script></body></html>');
    await writer.close();
  });
  await localReader.reload();
  await localReader.getByText(/这是旧版文库/).waitFor();
  await offline.locator('#posts summary').click();
  await offline.getByText('保留的旧版正文').waitFor();
  assert.equal(await offline.locator('#search').isDisabled(), true);
  assert.match(await localReader.locator('aside a').getAttribute('href'), /profile=default#settings$/);
  await localReader.close();
  console.log('PASS: legacy local HTML keeps native folding, disables unsupported search and offers settings recovery');
  console.log('PASS: library header opens the bound index.html, search and local images work, and another profile cannot read this library');
  const directPopup = await context.newPage();
  await directPopup.goto(origin + '/popup.html');
  await directPopup.getByLabel('本次扫描上限').selectOption('20');
  await directPopup.getByRole('button', { name: '开始同步', exact: true }).click();
  await directPopup.getByRole('button', { name: '查看同步进度', exact: true }).waitFor();
  await directPopup.close();
  await source.locator('#likemind-completion-notice').waitFor();
  const popupRun = await waitForRun((stats) => stats.latestRun?.id !== unchanged.id && stats.latestRun?.status === 'partial');
  assert.equal(popupRun.targetLimit, 20);
  assert.equal(popupRun.stats.added, 0);
  const settingsPopup = await context.newPage();
  await settingsPopup.goto(origin + '/popup.html');
  await settingsPopup.getByRole('button', { name: '设置', exact: true }).click();
  await settingsPopup.getByLabel('同步结束后').selectOption('library');
  await settingsPopup.getByText('已保存', { exact: true }).waitFor();
  await settingsPopup.close();
  await source.reload();
  const matchingLibrary = context.pages().find((page) => page.url().startsWith(origin + '/dashboard.html'));
  const beforePages = context.pages().length;
  const returned = matchingLibrary.waitForURL('**/dashboard.html?profile=default#library');
  assert.equal((await sendCaptureMessage({ ...start, limit: 20 })).started, true);
  await returned;
  await waitForRun((stats) => stats.latestRun?.id !== popupRun.id && stats.latestRun?.status === 'partial');
  assert.equal(context.pages().length, beforePages);
  console.log('PASS: popup starts capture directly, closed popup still yields an X-page notice, and saved preference opens the matching library');
  await matchingLibrary.goto(origin + '/dashboard.html?profile=default#sync');
  await matchingLibrary.getByRole('heading', { name: '同步历史', exact: true }).waitFor();
  assert.equal(await matchingLibrary.getByRole('button', { name: '打开 X 收藏', exact: true }).count(), 0);
  for (const width of [1280, 640]) {
    await matchingLibrary.setViewportSize({ width, height: 800 });
    assert.equal(await matchingLibrary.evaluate(() => document.documentElement.scrollWidth), width);
    const badges = await matchingLibrary.locator('tbody tr td:nth-child(3) span').evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent.trim(), height: node.getBoundingClientRect().height, whiteSpace: getComputedStyle(node).whiteSpace,
    })));
    assert.ok(badges.length > 0);
    assert.ok(badges.every(item => item.whiteSpace === 'nowrap' && item.height < 30), JSON.stringify(badges));
  }
  console.log('PASS: sync history status badges stay on one line at 1280px and 640px without overflowing the page; bookmark shortcut removed');
  await matchingLibrary.goto(origin + '/dashboard.html?profile=default#library');
  await matchingLibrary.reload(); // Native fixture IDB writes do not emit Dexie live-query notifications.
  await matchingLibrary.getByText('扩展内容没有新的待写入更改。', { exact: true }).waitFor();
  await matchingLibrary.getByLabel('搜索文库').fill('人工修订样本标题');
  await matchingLibrary.getByText('人工修订样本标题', { exact: true }).first().click();
  await matchingLibrary.getByRole('button', { name: /^(写|编辑)笔记$/ }).first().click();
  await matchingLibrary.getByPlaceholder('写下你的想法、要点或总结...').fill('发布后修改的 fixture 笔记');
  await matchingLibrary.getByRole('button', { name: '保存笔记', exact: true }).click();
  await matchingLibrary.getByPlaceholder('写下你的想法、要点或总结...').waitFor({ state: 'hidden' });
  await matchingLibrary.getByRole('button', { name: '关闭', exact: true }).click();
  await matchingLibrary.getByText('有未写入的更改。本地 index.html 仍是上次写入的版本。', { exact: true }).waitFor();
  await matchingLibrary.getByRole('button', { name: '管理本地写入', exact: true }).click();
  await matchingLibrary.getByRole('button', { name: '立即写入文库', exact: true }).waitFor();
  console.log('PASS: published library becomes dirty after a manual edit within the same sync batch and offers explicit writing');
  const fixtureEntryState = () => matchingLibrary.evaluate(async () => {
    const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle('popup-fixture');
    const root = await parent.getDirectoryHandle('fixture-popup');
    const file = await (await root.getFileHandle('index.html')).getFile();
    const snapshots = await root.getDirectoryHandle('snapshots');
    let count = 0;
    for await (const entry of snapshots.values()) if (entry.kind === 'directory') count++;
    return { bytes: file.size, modifiedAt: file.lastModified, count,
      hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))] };
  });
  const entryBefore = await fixtureEntryState();
  await matchingLibrary.getByRole('button', { name: '检查授权与入口', exact: true }).click();
  await matchingLibrary.getByText(/^目录已授权。index.html 为/).waitFor();
  assert.deepEqual(await fixtureEntryState(), entryBefore);
  console.log('PASS: permission and entry inspection reports metadata without changing the index or creating another snapshot');



} finally {
  await context.close();
}
