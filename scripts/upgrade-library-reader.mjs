import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2], 'Usage: node scripts/upgrade-library-reader.mjs <library-directory> [--apply]');
const apply = process.argv.includes('--apply');
const filename = path.join(root, 'index.html');
const original = await readFile(filename, 'utf8');
const old = new JSDOM(original).window.document;
if (old.querySelector('#entries > template')) {
  console.log('Already uses the current reader layout; no files written.');
  process.exit(0);
}
const cards = [...old.querySelectorAll('#posts > details')];
assert.ok(cards.length, 'Unsupported legacy reader; no files written.');
const references = [...original.matchAll(/snapshots\/(LikeMind-[^/"<> ]+)/g)].map(match => match[1]);
assert.ok(references.length, 'No snapshot reference; no files written.');
const snapshot = references[0];
assert.equal(path.basename(snapshot), snapshot);
const catalog = JSON.parse(await readFile(path.join(root, 'snapshots', snapshot, 'catalog.json'), 'utf8'));
assert.equal(catalog.schemaVersion, 1);
assert.equal(cards.length, catalog.posts.length, 'Catalog/card counts differ; no files written.');
const byUrl = new Map(cards.map(card => {
  const originalLink = [...card.querySelectorAll('a[href]')].find(a => /^https?:/.test(a.getAttribute('href')));
  return [originalLink?.getAttribute('href'), card];
}));
const bundled = await build({ entryPoints: ['src/export/reader.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { generateArchiveReader } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const posts = catalog.posts.map(post => ({ ...post, platform: 'x', postId: post.id.replace(/^x:/, ''),
  mediaIds: [], missingFields: [], sourceRunId: '', contentHash: '', externalLinks: [], schemaVersion: 1 }));
const overrides = new Map(catalog.posts.map(post => [post.id, { ...post.overrides,
  customCategories: post.overrides?.customCategories ?? post.analysis?.categories ?? [],
  customTags: post.overrides?.customTags ?? post.analysis?.tags ?? [],
}]));
const html = generateArchiveReader(posts, new Map(), overrides, new Map(), {
  snapshotPath: 'snapshots/' + snapshot, exportedAt: catalog.exportedAt,
});
const document = new JSDOM(html).window.document;
const postById = new Map(catalog.posts.map(post => [post.id, post]));
let imageCount = 0;
for (const template of document.querySelectorAll('#entries > template')) {
  const entry = JSON.parse(template.dataset.entry);
  const post = postById.get(entry.id);
  const card = byUrl.get(post.canonicalUrl);
  assert.ok(card, 'Original card missing; no files written.');
  const section = card.querySelector('section');
  assert.ok(section);
  entry.title = card.querySelector('summary strong').textContent;
  entry.metadata = card.querySelector('summary small')?.textContent || entry.metadata;
  entry.preview = (post.analysis?.summaryZh || post.text).trim().slice(0, 180);
  entry.thumbnail = section.querySelector('img')?.getAttribute('src') || '';
  entry.hasImage = Boolean(post.media?.length || entry.thumbnail);
  template.dataset.entry = JSON.stringify(entry);
  template.content.replaceChildren();
  const title = document.createElement('h2'); title.className = 'article-title'; title.textContent = entry.title;
  const metadata = document.createElement('p'); metadata.className = 'muted'; metadata.textContent = entry.metadata;
  template.content.append(title, metadata, document.importNode(section, true));
  imageCount += section.querySelectorAll('img').length;
}
// Correct the media count from catalog records; never infer absent files as archived.
const missing = catalog.posts.filter(post => post.media.some(media => !media.path)).length;
const publication = document.querySelector('.masthead time').parentElement;
publication.lastChild.textContent = ` · ${posts.length} 篇 · ${missing} 篇有未归档媒体`;
for (const node of document.querySelectorAll('[href], [src]')) {
  const relative = node.getAttribute('href') || node.getAttribute('src');
  if (!relative || /^(https?:|#|data:)/.test(relative)) continue;
  const target = path.resolve(root, decodeURIComponent(relative));
  assert.ok(target.startsWith(root + path.sep));
  await stat(target);
}
for (const template of document.querySelectorAll('template')) {
  for (const node of template.content.querySelectorAll('img[src], a[href]')) {
    const relative = node.getAttribute('src') || node.getAttribute('href');
    if (/^(https?:|#)/.test(relative)) continue;
    const target = path.resolve(root, decodeURIComponent(relative));
    assert.ok(target.startsWith(root + path.sep));
    await stat(target);
  }
}
const output = '<!doctype html>\n' + document.documentElement.outerHTML;
if (apply) {
  const backup = filename + '.before-reader-upgrade.bak';
  await copyFile(filename, backup, 1); // COPYFILE_EXCL: never overwrite an existing backup.
  await writeFile(filename, output, 'utf8');
}
console.log(JSON.stringify({ applied: apply, posts: posts.length, images: imageCount, snapshot, bytes: Buffer.byteLength(output) }));
