import { hasArchivedMedia } from '../domain/media';
import { currentAnalysis, sourceGroundedLinks } from '../domain/analysis';
import { getCaptureNotices, POST_REFERENCE_LABELS } from '../domain/postReferences';
import { LIBRARY_BOOKMARK, LIBRARY_PAGES } from '../domain/libraryMark';
import { describePostSources, getPostSources } from '../domain/sources';
import { escapeHtml, sanitizeUrl } from '../domain/sanitize';
import type { AIAnalysis, MediaAsset, NormalizedPost, SyncRun, UserOverrides } from '../domain/types';
import { getMediaArchivePaths, getPostRelativePath } from './markdown';
import type { SnapshotComparison } from './snapshotComparison';

function archiveLink(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function analysisDetails(post: NormalizedPost, ai: AIAnalysis): string {
  const sections = [
    ai.contentType && `<p>内容类型：${escapeHtml(ai.contentType)}</p>`,
    ai.quality && `<p>价值评级：${escapeHtml(ai.quality)}</p>`,
    ai.confidenceNote && `<p class="text">置信说明：${escapeHtml(ai.confidenceNote)}</p>`,
  ];
  const links = sourceGroundedLinks(post, ai.usefulLinks).map((link) =>
    `<li><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link)}</a></li>`);
  for (const [label, items] of [
    ['步骤 / 要点', ai.steps],
    ['前置要求', ai.prerequisites],
    ['风险与限制', ai.risksAndLimits],
    ['待核实 / 信息缺失', ai.uncertainties],
  ] as const) {
    if (items?.length) sections.push(`<h3>${label}</h3><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`);
  }
  if (links.length) sections.push(`<h3>相关项目 / 资源</h3><ul>${links.join('')}</ul>`);
  const content = sections.filter(Boolean).join('');
  return content ? `<details><summary>查看 AI 整理详情</summary>${content}</details>` : '';
}

interface ArchiveReaderOptions {
  snapshotPath?: string;
  exportedAt?: string;
  syncRuns?: SyncRun[];
  runId?: string;
  history?: { name: string; exportedAt: string; postCount: number }[];
  comparisons?: SnapshotComparison[];
}

export function generateArchiveReader(
  posts: NormalizedPost[],
  mediaMap: Map<string, MediaAsset[]>,
  overridesMap: Map<string, UserOverrides>,
  aiMap: Map<string, AIAnalysis>,
  { snapshotPath, exportedAt = new Date().toISOString(), syncRuns = [], runId, history = [], comparisons = [] }: ArchiveReaderOptions = {},
): string {
  const prefix = snapshotPath ? `${snapshotPath}/` : '';
  const batch = runId ?? syncRuns.filter((run) => run.endedAt)
    .sort((a, b) => b.endedAt!.localeCompare(a.endedAt!))[0]?.id;
  const publishedAt = Date.parse(exportedAt);
  const recentSince = publishedAt - 7 * 24 * 60 * 60 * 1000;
  let missingMediaPosts = 0;
  const comparisonsByName = new Map(comparisons.map((comparison) => [comparison.previousName, comparison]));
  const cards = [...posts].sort((a, b) => b.firstObservedAt.localeCompare(a.firstObservedAt)).map((post) => {
    const override = overridesMap.get(post.id);
    const ai = currentAnalysis(post, aiMap.get(post.id));
    const title = override?.customTitle || ai?.titleZh || post.text.trim().split(/\r?\n/, 1)[0].slice(0, 100) || `帖子 ${post.postId}`;
    const metadata = [post.author?.displayName, post.author?.handle && `@${post.author.handle}`,
      `收录 · ${describePostSources(post)}`,
      post.postedAt ? `发帖 ${post.postedAt.slice(0, 10)}` : '', post.captureStatus !== 'complete' && '原文采集不完整'].filter(Boolean).join(' · ');
    const labels = [...(override?.customCategories ?? ai?.categories ?? []), ...(override?.customTags ?? ai?.tags ?? [])];
    const assets = mediaMap.get(post.id) ?? [];
    const local = assets.filter(hasArchivedMedia).sort((a, b) => a.position - b.position);
    const present = new Set(assets.map((asset) => asset.id));
    const missing = assets.length - local.length + post.mediaIds.filter((id) => !present.has(id)).length;
    if (missing) missingMediaPosts++;
    const original = sanitizeUrl(post.canonicalUrl);
    const references = (post.references ?? []).flatMap((reference) => {
      const url = sanitizeUrl(reference.url);
      return url ? [`<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${POST_REFERENCE_LABELS[reference.kind]}</a></li>`] : [];
    });
    const observedAt = Date.parse(post.firstObservedAt);
    const entry = {
      id: post.id,
      title, metadata, preview: (ai?.summaryZh || post.text).trim().slice(0, 180),
      topics: override?.customCategories ?? ai?.categories ?? [],
      tags: override?.customTags ?? ai?.tags ?? [],
      author: post.author?.handle ? `@${post.author.handle}` : post.author?.displayName ?? '',
      sources: getPostSources(post),
      status: override?.readingStatus ?? 'to_read',
      hasImage: assets.some((asset) => asset.kind === 'image') || post.mediaIds.length > 0,
      thumbnail: local.length ? archiveLink(prefix + getMediaArchivePaths(local[0], post).archivePath) : '',
      postedAt: post.postedAt ?? '', observedAt: post.firstObservedAt,
      recent: observedAt >= recentSince && observedAt <= publishedAt,
      newInBatch: Boolean(batch && post.sourceRunId === batch),
    };
    return `<template data-entry="${escapeHtml(JSON.stringify(entry))}">
      <h2 class="article-title">${escapeHtml(title)}</h2><p class="muted">${escapeHtml(metadata)}</p>
      <section>
        ${labels.length ? `<p class="tags">${labels.map((label) => `<span>${escapeHtml(label)}</span>`).join('')}</p>` : ''}
        ${ai?.summaryZh ? `<h2>AI 摘要</h2><p class="text">${escapeHtml(ai.summaryZh)}</p>` : ''}
        ${ai ? analysisDetails(post, ai) : ''}
        <h2>帖子原文</h2>
        ${getCaptureNotices(post.missingFields).map((notice) => `<p class="muted">${escapeHtml(notice)}</p>`).join('')}
        <p class="text">${escapeHtml(post.text || '没有采集到文字。')}</p>
        ${local.length ? `<div class="photos">${local.map((asset) => {
          const path = archiveLink(prefix + getMediaArchivePaths(asset, post).archivePath);
          return `<a href="${path}" aria-haspopup="dialog"><img loading="lazy" src="${path}" alt="${escapeHtml(asset.altText || `图片 ${asset.position + 1}`)}"></a>`;
        }).join('')}</div>` : ''}
        ${missing ? `<p class="muted">${missing} 项媒体未离线归档</p>` : ''}
        ${references.length ? `<h2>关联原文</h2><ul>${references.join('')}</ul>` : ''}
        ${override?.notes ? `<h2>个人笔记</h2><p class="text">${escapeHtml(override.notes)}</p>` : ''}
        <footer><a href="${archiveLink(prefix + getPostRelativePath(post).fullPath)}">打开 Markdown</a>
        ${original ? `<a href="${escapeHtml(original)}" target="_blank" rel="noopener noreferrer">访问 X 原帖</a>` : ''}</footer>
      </section>
    </template>`;
  }).join('\n');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>LikeMind 离线文库</title>
<style>
:root{color-scheme:light;background:#f2f0e9;color:#222922;font:16px/1.6 system-ui,sans-serif;--line:#dbddd2;--green:#2d5947}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0}a{color:var(--green)}
.masthead{padding:1rem clamp(1rem,3vw,2.75rem);display:flex;flex-wrap:wrap;gap:1rem 2rem;align-items:center;border-bottom:1px solid var(--line)}
.brand{display:flex;gap:.75rem;align-items:center}.brand h1{font-size:1.35rem;margin:0;line-height:1.25}
.kicker{font-size:.75rem;letter-spacing:.12em;text-transform:uppercase;color:var(--green)}
.search{flex:1 1 19rem;max-width:36rem}.search label{display:block;font-size:.8rem}.masthead p{margin:0;font-size:.85rem}
input,select,button{font:inherit;color:inherit}input,select{width:100%;min-width:0;padding:.5rem .65rem;background:#fff;border:1px solid #a5aea1;border-radius:.45rem}
button{cursor:pointer;background:#fff;border:1px solid var(--line);border-radius:.45rem;padding:.4rem .65rem}
button:hover{background:#edf3ec}button:disabled{cursor:default;opacity:.45}:focus-visible{outline:3px solid var(--green);outline-offset:2px}
.workspace{display:grid;grid-template-columns:minmax(10rem,.6fr) minmax(17rem,1.1fr) minmax(23rem,2fr);max-width:108rem;margin:auto;min-height:calc(100vh - 7rem)}
.filters,.results,.reading{padding:clamp(.8rem,2vw,1.65rem);min-width:0}.filters,.results{border-right:1px solid var(--line)}
.filters h2,.results h2{margin:0;font-size:1rem}.filters label{display:block;font-size:.84rem;margin-top:.8rem}
.filters button{margin-top:.8rem}.result-tools{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.4rem;margin:.8rem 0}.result-tools select{width:auto;max-width:100%}
.quick{display:flex;flex-wrap:wrap;gap:.35rem;margin:.65rem 0 1.1rem}.quick button{margin:0;font-size:.83rem}.quick button[aria-pressed="true"]{color:#fff;background:var(--green)}
.history{margin-top:1.4rem;font-size:.85rem}.history li{margin:.3rem 0}.history ul{padding-left:1.2rem}
.comparison{margin:.85rem 0 1.2rem;padding:.65rem;border:1px solid var(--line);border-radius:.5rem;background:#fffdf8;font-size:.83rem}
.comparison p{margin:.35rem 0}.comparison .quick{margin-bottom:0}
.results-list{display:grid;gap:.5rem}.result{display:flex;gap:.65rem;text-align:left;width:100%;padding:.7rem;align-items:flex-start;overflow-wrap:anywhere}
.result[aria-current="true"]{background:#e8f0e8;border-color:#799885}.result-copy{min-width:0;flex:1}
.result strong,.preview{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.preview,small,.muted{color:#505c53}small{display:block;font-size:.77rem;margin:.2rem 0}.preview{font-size:.84rem}
.thumb{width:3.25rem;height:3.25rem;border-radius:.3rem;object-fit:cover;background:#eceee7}
.pager{display:flex;justify-content:space-between;align-items:center;gap:.4rem;margin-top:1rem;font-size:.82rem}
.reading{background:#fffdf8;overflow-wrap:anywhere}.reading article{max-width:49rem;margin:auto}.article-title{font-size:clamp(1.4rem,2.6vw,2.2rem);line-height:1.25;margin:.25rem 0}
.reading section h2{font-size:1rem;margin:1.25rem 0 .3rem}.text{white-space:pre-wrap;margin:.3rem 0}.tags{display:flex;flex-wrap:wrap;gap:.4rem}.tags span{background:#e9f1e8;border-radius:1rem;padding:.05rem .55rem;font-size:.85rem}
.photos{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:.75rem}.photos img{display:block;width:100%;max-height:32rem;object-fit:contain}
.photos a{cursor:zoom-in;border:1px solid var(--line);border-radius:.4rem;background:#f5f4ee}
.gallery{padding:0;border:1px solid #555e55;border-radius:.7rem;width:min(94vw,78rem);max-height:94dvh;background:#19201d;color:#fff;overflow:hidden}
.gallery::backdrop{background:#101612db}.gallery a{color:#e4f2e8}
.gallery-bar{display:flex;align-items:center;flex-wrap:wrap;gap:.45rem;padding:.65rem .85rem;background:#232d27}
.gallery-bar h2{font-size:1rem;margin:0 auto 0 0}.gallery-bar button{color:#222922}.gallery-bar a{padding:.25rem}
.gallery-stage{height:min(68dvh,52rem);overflow:auto;padding:.5rem}
.gallery-stage img{display:block;width:100%;height:100%;object-fit:contain}
.gallery-stage[data-actual="true"] img{width:auto;height:auto;max-width:none;max-height:none}
.gallery-error{padding:1rem}
@media(max-width:600px){.gallery-stage{height:60dvh}.gallery-bar h2{flex-basis:100%}}
footer{display:flex;flex-wrap:wrap;gap:1rem;margin-top:1rem}
.back{margin-bottom:.75rem}
.read-nav{display:flex;flex-wrap:wrap;align-items:center;gap:.45rem;margin-bottom:1rem;padding-bottom:.75rem;border-bottom:1px solid var(--line)}
.read-nav .muted{font-size:.82rem}.read-nav .read-position{margin-inline:auto}kbd{font:inherit;font-weight:600}
.link-tools{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:.75rem 0;font-size:.85rem}
.link-tools input{flex-basis:100%}.link-warning{margin:.75rem clamp(1rem,3vw,2.75rem);color:#69471f}
@media(min-width:901px){.back{display:none}.results,.reading{max-height:calc(100dvh - 6.5rem);overflow:auto}.filters{overflow:auto;max-height:calc(100dvh - 6.5rem)}}
@media(max-width:900px){.workspace{grid-template-columns:minmax(0,1fr)}.filters,.results{border-right:0;border-bottom:1px solid var(--line)}.filter-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:0 .75rem}.workspace[data-view="detail"] .filters,.workspace[data-view="detail"] .results,.workspace:not([data-view="detail"]) .reading{display:none}}
</style></head><body><main>
<header class="masthead">
  <div class="brand"><svg viewBox="0 0 32 32" width="38" height="38" aria-hidden="true"><path fill="#24415c" d="${LIBRARY_PAGES}"/><path fill="#c06f49" d="${LIBRARY_BOOKMARK}"/></svg><div><div class="kicker">LikeMind</div><h1>离线文库</h1></div></div>
  <div class="search"><label for="search">搜索文库</label><input id="search" type="search" placeholder="搜索正文、作者、标签或笔记"></div>
  <p class="muted">发布于 <time datetime="${escapeHtml(exportedAt)}">${escapeHtml(exportedAt.slice(0, 10))}</time> · ${posts.length} 篇 · ${missingMediaPosts} 篇有未归档媒体</p>
  ${snapshotPath ? `<p><a href="${archiveLink(prefix + 'index.html')}">本期快照</a> · <a href="${archiveLink(prefix + 'catalog.json')}">资料目录</a></p>` : ''}
</header>
<p class="link-warning" id="link-warning" role="status" hidden></p>
<div class="workspace" id="workspace">
  <aside class="filters" aria-labelledby="filters-title">
    <h2>快捷视图</h2>
    <div class="quick" id="quick" role="group" aria-label="快捷视图">
      <button type="button" data-view="all" aria-pressed="true">全部</button>
      <button type="button" data-view="to_read" aria-pressed="false">待读</button>
      <button type="button" data-view="to_practice" aria-pressed="false">待实践</button>
      <button type="button" data-view="recent" aria-pressed="false" title="截至发布时近 7 天首次收录">最近收录</button>
      ${batch ? '<button type="button" data-view="batch" aria-pressed="false">本次新增</button>' : ''}
    </div>
    ${history.length ? `<section class="comparison" aria-labelledby="comparison-title">
      <h2 id="comparison-title">快照对比</h2>
      <label>对比基准<select id="comparison-base">${history.map((item) => {
        const comparison = comparisonsByName.get(item.name);
        return `<option data-link="${archiveLink('snapshots/' + item.name + '/index.html')}"${comparison
          ? ` data-delta="${escapeHtml(JSON.stringify(comparison))}"` : ''}>${escapeHtml(item.exportedAt.slice(0, 19).replace('T', ' '))} UTC · ${item.postCount} 篇</option>`;
      }).join('')}</select></label>
      <p><a id="comparison-link">打开基准快照</a></p>
      <p id="comparison-summary" role="status"></p>
      <div class="quick" id="comparison-views" role="group" aria-label="快照变化" hidden>
        <button type="button" data-view="added" aria-pressed="false"></button>
        <button type="button" data-view="resolved" aria-pressed="false"></button>
        <button type="button" data-view="newlyMissing" aria-pressed="false"></button>
      </div>
    </section>` : ''}
    <h2 id="filters-title">筛选文库</h2>
    <div class="filter-grid">
      <label>主题<select id="topic"><option value="">全部主题</option></select></label>
      <label>标签<select id="tag"><option value="">全部标签</option></select></label>
      <label>作者<select id="author"><option value="">全部作者</option></select></label>
      <label>来源<select id="source"><option value="">全部来源</option><option value="x_likes">X 点赞</option><option value="x_bookmarks">X 收藏</option><option value="x_archive">X 官方归档</option><option value="unknown">来源未知</option></select></label>
      <label>阅读状态<select id="status"><option value="">全部状态</option><option value="to_read">待读</option><option value="to_practice">待实践</option><option value="practiced">已实践</option><option value="ignored">忽略</option></select></label>
      <label>图片<select id="image"><option value="">全部帖子</option><option value="yes">有图</option><option value="no">无图</option></select></label>
    </div>
    <button id="reset" type="button">清除筛选</button>
    ${history.length ? `<details class="history"><summary>历史快照（${history.length}）</summary><ul>${history.map((item) =>
      `<li><a href="${archiveLink('snapshots/' + item.name + '/index.html')}">${escapeHtml(item.exportedAt.slice(0, 19).replace('T', ' '))} UTC · ${item.postCount} 篇</a></li>`).join('')}</ul></details>` : ''}
  </aside>
  <section class="results" id="results" aria-labelledby="results-title">
    <h2 id="results-title">帖子</h2>
    <div class="result-tools"><span id="count" class="muted" role="status"></span><select id="order" aria-label="排序"><option value="observedAt">最近收录</option><option value="postedAt">最新发帖</option></select></div>
    <div id="posts" class="results-list"></div>
    <nav class="pager" aria-label="结果分页" id="pager"><button id="previous" type="button">上一页</button><span id="page"></span><button id="next" type="button">下一页</button></nav>
  </section>
  <section class="reading" id="reading" aria-label="帖子详情">
    <button class="back" id="back" type="button" hidden>返回结果</button>
    <nav class="read-nav" id="read-nav" aria-label="帖子翻阅" hidden>
      <button id="read-previous" type="button" aria-keyshortcuts="K">上一篇</button>
      <span id="read-position" class="muted read-position" role="status"></span>
      <button id="read-next" type="button" aria-keyshortcuts="J">下一篇</button>
      <span class="muted"><kbd>K</kbd> 上一篇 · <kbd>J</kbd> 下一篇</span>
    </nav>
    <div class="link-tools" id="link-tools" hidden>
      <button id="copy-link" type="button">复制离线链接</button><span id="copy-feedback" class="muted" role="status"></span>
      <input id="link-value" aria-label="帖子离线链接" readonly hidden>
    </div>
    <article id="article" tabindex="-1"><p class="muted">从列表选择一篇帖子。访问 X 原帖需要联网。</p></article>
  </section>
</div>
<dialog id="gallery" class="gallery" aria-labelledby="gallery-title">
  <div class="gallery-bar">
    <h2 id="gallery-title">查看图片</h2><span id="gallery-count" role="status"></span>
    <button id="gallery-previous" type="button">上一张</button><button id="gallery-next" type="button">下一张</button>
    <button id="gallery-zoom" type="button" aria-pressed="false">原始尺寸</button>
    <a id="gallery-file" target="_blank" rel="noopener noreferrer">打开图片文件</a>
    <button id="gallery-close" type="button" autofocus>关闭</button>
  </div>
  <div id="gallery-stage" class="gallery-stage" tabindex="0" aria-label="图片浏览区域">
    <img id="gallery-image" alt=""><p id="gallery-error" class="gallery-error" role="status" hidden>无法读取图片。文件可能已移动或损坏。</p>
  </div>
</dialog>
<noscript><p>请启用 JavaScript 浏览离线文库，也可直接打开导出目录中的 Markdown 文件。</p></noscript>
<div id="entries" hidden>${cards}</div>
<script>
${ARCHIVE_READER_SCRIPT}
</script></main></body></html>`;
}

// Shared with the isolated viewer; never execute scripts read from disk.
export const ARCHIVE_READER_SCRIPT = `const element = id => document.getElementById(id);
const entries = Array.from(document.querySelectorAll('#entries > template'), template => {
  const data = JSON.parse(template.dataset.entry);
  return { ...data, template, searchable: (template.content.textContent + ' ' + data.author).toLowerCase() };
});
const filters = ['topic', 'tag', 'author', 'source', 'status', 'image'].map(element);
for (const [id, values] of [
  ['topic', entries.flatMap(entry => entry.topics)],
  ['tag', entries.flatMap(entry => entry.tags)],
  ['author', entries.map(entry => entry.author)],
]) {
  for (const value of [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
    element(id).add(new Option(value, value));
  }
}
const search = element('search');
const order = element('order');
const workspace = element('workspace');
const results = element('results');
const reading = element('reading');
const article = element('article');
const list = element('posts');
const gallery = element('gallery');
const galleryStage = element('gallery-stage');
const galleryImage = element('gallery-image');
const galleryZoom = element('gallery-zoom');
let galleryLinks = [];
let galleryIndex = 0;
let galleryOpener;

function setImageSize(actual) {
  galleryStage.dataset.actual = String(actual);
  galleryZoom.setAttribute('aria-pressed', String(actual));
  galleryZoom.textContent = actual ? '适应窗口' : '原始尺寸';
  galleryStage.scrollTop = 0;
  galleryStage.scrollLeft = 0;
}

function showImage(index) {
  if (index < 0 || index >= galleryLinks.length) return;
  galleryIndex = index;
  const link = galleryLinks[index];
  galleryImage.alt = link.querySelector('img').alt;
  galleryImage.hidden = false;
  element('gallery-error').hidden = true;
  element('gallery-file').href = link.href;
  element('gallery-count').textContent = (index + 1) + ' / ' + galleryLinks.length + ' 张';
  element('gallery-previous').disabled = index === 0;
  element('gallery-next').disabled = index === galleryLinks.length - 1;
  galleryZoom.disabled = false;
  setImageSize(false);
  galleryImage.src = link.getAttribute('href');
}

article.addEventListener('click', event => {
  const link = event.target.closest('.photos a');
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !gallery.showModal) return;
  event.preventDefault();
  galleryLinks = Array.from(article.querySelectorAll('.photos a'));
  galleryOpener = link;
  showImage(galleryLinks.indexOf(link));
  gallery.showModal();
});
element('gallery-close').addEventListener('click', () => gallery.close());
element('gallery-previous').addEventListener('click', () => showImage(galleryIndex - 1));
element('gallery-next').addEventListener('click', () => showImage(galleryIndex + 1));
galleryZoom.addEventListener('click', () => setImageSize(galleryStage.dataset.actual !== 'true'));
galleryImage.addEventListener('error', () => {
  if (!gallery.open) return;
  galleryImage.hidden = true;
  element('gallery-error').hidden = false;
  galleryZoom.disabled = true;
});
gallery.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey ||
    (event.target === galleryStage && galleryStage.dataset.actual === 'true')) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  showImage(galleryIndex + (event.key === 'ArrowLeft' ? -1 : 1));
});
gallery.addEventListener('close', () => {
  galleryImage.removeAttribute('src');
  galleryOpener?.focus({ preventScroll: true });
  galleryOpener = undefined;
  galleryLinks = [];
});
const pageSize = 30;
let page = 0;
let selected;
let selectedButton;
let listScroll = 0;
let followSelection = false;
let matches = [];
let view = 'all';
const quickButtons = Array.from(document.querySelectorAll('#quick button, #comparison-views button'));
const comparisonBase = element('comparison-base');
const comparisonLabels = { added: '新增', resolved: '不再标记缺失', newlyMissing: '新出现缺失' };
let comparisonChanges = new Map();

function updateComparison() {
  if (!comparisonBase) return;
  const option = comparisonBase.options[comparisonBase.selectedIndex];
  const delta = option.dataset.delta ? JSON.parse(option.dataset.delta) : null;
  element('comparison-link').href = option.dataset.link;
  element('comparison-summary').textContent = delta
    ? '有未归档媒体的帖子：' + delta.previousMissing + ' → ' + delta.currentMissing + ' 篇'
    : '这份快照的清单不足以生成对比。';
  element('comparison-views').hidden = !delta;
  comparisonChanges = new Map();
  for (const [kind, label] of Object.entries(comparisonLabels)) {
    const ids = delta?.[kind] ?? [];
    for (const id of ids) comparisonChanges.set(id, kind);
    element('comparison-views').querySelector('[data-view="' + kind + '"]').textContent = label + ' ' + ids.length;
  }
  if (!delta && Object.hasOwn(comparisonLabels, view)) setView('all');
}

function setView(next) {
  view = next;
  for (const button of quickButtons) button.setAttribute('aria-pressed', String(button.dataset.view === view));
}

function addText(parent, tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function updateReadingNavigation() {
  const index = matches.indexOf(selected);
  element('read-nav').hidden = index < 0 || workspace.dataset.view !== 'detail';
  element('link-tools').hidden = element('read-nav').hidden;
  element('read-position').textContent = index >= 0 ? (index + 1) + ' / ' + matches.length + ' 篇' : '';
  element('read-previous').disabled = index <= 0;
  element('read-next').disabled = index < 0 || index + 1 >= matches.length;
}

function setPostLink(entry) {
  const hash = entry ? '#post=' + encodeURIComponent(entry.id) : '';
  if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
}

function openEntry(entry, button, fromList = true) {
  selectedButton?.removeAttribute('aria-current');
  selected = entry;
  selectedButton = button;
  button.setAttribute('aria-current', 'true');
  if (fromList) listScroll = window.scrollY;
  followSelection = !fromList;
  article.replaceChildren(entry.template.content.cloneNode(true));
  workspace.dataset.view = 'detail';
  element('back').hidden = false;
  element('link-warning').hidden = true;
  element('link-value').hidden = true;
  element('copy-feedback').textContent = '';
  setPostLink(entry);
  updateReadingNavigation();
  reading.scrollTop = 0;
  if (matchMedia('(max-width:900px)').matches) reading.scrollIntoView();
  article.focus({ preventScroll: true });
}

element('copy-link').addEventListener('click', async () => {
  const entry = selected;
  if (!entry) return;
  const url = new URL(window.archiveReaderUrl || location.href);
  url.hash = 'post=' + encodeURIComponent(entry.id);
  const feedback = element('copy-feedback');
  try {
    await navigator.clipboard.writeText(url.href);
    if (selected === entry) feedback.textContent = '已复制';
  } catch {
    if (selected !== entry) return;
    const field = element('link-value');
    field.value = url.href;
    field.hidden = false;
    field.select();
    feedback.textContent = '请手动复制已选中的链接。';
  }
});

function moveEntry(direction) {
  const index = matches.indexOf(selected);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= matches.length) return false;
  const nextPage = Math.floor(next / pageSize);
  if (page !== nextPage) {
    page = nextPage;
    render();
  }
  const button = list.children[next % pageSize];
  openEntry(matches[next], button, false);
  if (!matchMedia('(max-width:900px)').matches) button.scrollIntoView({ block: 'nearest' });
  return true;
}

element('read-previous').addEventListener('click', () => moveEntry(-1));
element('read-next').addEventListener('click', () => moveEntry(1));
reading.addEventListener('keydown', event => {
  if (gallery.open || event.ctrlKey || event.metaKey || event.altKey || event.isComposing ||
    workspace.dataset.view !== 'detail') return;
  const key = event.key.toLowerCase();
  if (key === 'j' || key === 'k') {
    if (moveEntry(key === 'j' ? 1 : -1)) event.preventDefault();
  }
});

function render() {
  const terms = search.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
  const [topic, tag, author, source, status, image] = filters.map(control => control.value);
  matches = entries.filter(entry =>
    (view === 'all' || (view === 'recent' ? entry.recent : view === 'batch' ? entry.newInBatch :
      entry.status === view || comparisonChanges.get(entry.id) === view)) &&
    terms.every(term => entry.searchable.includes(term)) &&
    (!topic || entry.topics.includes(topic)) && (!tag || entry.tags.includes(tag)) &&
    (!author || entry.author === author) &&
    (!source || (source === 'unknown' ? entry.sources.length === 0 : entry.sources.includes(source))) &&
    (!status || entry.status === status) && (!image || entry.hasImage === (image === 'yes'))
  );
  const date = order.value;
  matches.sort((a, b) => b[date].localeCompare(a[date]) || b.observedAt.localeCompare(a.observedAt));
  if (selected && !matches.includes(selected)) {
    selected = undefined;
    setPostLink();
    delete workspace.dataset.view;
    element('back').hidden = true;
    article.replaceChildren();
    addText(article, 'p', '从当前结果选择一篇帖子。', 'muted');
  }
  const totalPages = Math.ceil(matches.length / pageSize);
  list.replaceChildren();
  selectedButton = undefined;
  for (const entry of matches.slice(page * pageSize, (page + 1) * pageSize)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'result';
    if (entry === selected) {
      button.setAttribute('aria-current', 'true');
      selectedButton = button;
    }
    button.addEventListener('click', () => openEntry(entry, button));
    if (entry.thumbnail) {
      const thumbnail = document.createElement('img');
      thumbnail.src = entry.thumbnail;
      thumbnail.alt = '';
      thumbnail.loading = 'lazy';
      thumbnail.className = 'thumb';
      button.append(thumbnail);
    }
    const copy = document.createElement('span');
    copy.className = 'result-copy';
    addText(copy, 'strong', entry.title);
    addText(copy, 'small', entry.metadata);
    if (entry.preview) addText(copy, 'span', entry.preview, 'preview');
    button.append(copy);
    list.append(button);
  }
  element('count').textContent = matches.length + ' / ' + entries.length + ' 篇';
  if (!matches.length) addText(list, 'p', entries.length ? '没有匹配的帖子。可以清除筛选后再试。' : '此快照没有帖子。', 'muted');
  element('pager').hidden = totalPages <= 1;
  element('page').textContent = (page + 1) + ' / ' + totalPages;
  element('previous').disabled = page === 0;
  element('next').disabled = page + 1 >= totalPages;
  updateReadingNavigation();
}

function refresh() {
  page = 0;
  render();
  results.scrollTop = 0;
}

search.addEventListener('input', refresh);
for (const control of [...filters, order]) control.addEventListener('change', () => {
  if (control.id === 'status' && (view === 'to_read' || view === 'to_practice')) setView('all');
  refresh();
});
for (const button of quickButtons) button.addEventListener('click', () => {
  setView(button.dataset.view);
  if (view === 'to_read' || view === 'to_practice') element('status').value = '';
  if (view === 'recent') order.value = 'observedAt';
  refresh();
});
function clearFilters() {
  search.value = '';
  setView('all');
  for (const control of filters) control.value = '';
}
element('reset').addEventListener('click', () => { clearFilters(); refresh(); });
element('previous').addEventListener('click', () => { page--; render(); results.scrollTop = 0; });
element('next').addEventListener('click', () => { page++; render(); results.scrollTop = 0; });
function returnToResults() {
  delete workspace.dataset.view;
  updateReadingNavigation();
  if (followSelection && selectedButton) selectedButton.scrollIntoView({ block: 'nearest' });
  else window.scrollTo(0, listScroll);
  (selectedButton ?? search).focus({ preventScroll: true });
}
element('back').addEventListener('click', () => {
  setPostLink();
  returnToResults();
});

function openPostLink() {
  const warning = element('link-warning');
  warning.hidden = true;
  if (!location.hash.startsWith('#post=')) {
    if (workspace.dataset.view === 'detail') returnToResults();
    return;
  }
  const id = new URLSearchParams(location.hash.slice(1)).get('post');
  const entry = entries.find(item => item.id === id);
  if (!entry) {
    if (workspace.dataset.view === 'detail') returnToResults();
    warning.textContent = '此快照中找不到链接指向的帖子。';
    warning.hidden = false;
    return;
  }
  if (!matches.includes(entry)) {
    clearFilters();
    refresh();
  }
  const index = matches.indexOf(entry);
  page = Math.floor(index / pageSize);
  render();
  const button = list.children[index % pageSize];
  openEntry(entry, button, false);
  if (!matchMedia('(max-width:900px)').matches) button.scrollIntoView({ block: 'nearest' });
}

comparisonBase?.addEventListener('change', () => { updateComparison(); refresh(); });
updateComparison();
render();
openPostLink();
window.addEventListener('hashchange', openPostLink);`;
