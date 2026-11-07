import { getLibraryFolder } from './export/libraryFolder';
import { ARCHIVE_READER_SCRIPT } from './export/reader';
import { libraryReaderLayout, prepareLibraryDocument, readLibraryFile, resolveLibraryPath } from './export/localLibraryReader';
import { getPageProfileId } from './storage/profiles';
import './index.css';

const container = document.getElementById('root')!;
container.innerHTML = `<main class="p-5"><p id="status" role="status">正在读取当前文库的 index.html…</p><button id="retry" class="mt-3 rounded-lg border px-4 py-2" hidden>重新读取 / 授权</button></main><iframe title="本地文库 index.html" class="fixed inset-0 h-full w-full border-0" hidden></iframe>`;
const status = document.getElementById('status')!;
const retry = document.getElementById('retry') as HTMLButtonElement;
const frame = container.querySelector('iframe')!;
const settings = document.createElement('a');
settings.textContent = '打开当前文库设置';
settings.href = chrome.runtime.getURL(`dashboard.html?profile=${encodeURIComponent(getPageProfileId())}#settings`);
settings.className = 'ml-3 text-sm underline';
settings.hidden = true;
retry.after(settings);
const legacyNotice = document.createElement('aside');
legacyNotice.className = 'fixed inset-x-0 top-0 z-10 border-b bg-amber-50 px-4 py-3 text-sm';
legacyNotice.textContent = '这是旧版文库，仍可展开阅读。要使用搜索和新版界面，请到设置中写入本地文库。';
const legacySettings = settings.cloneNode(true) as HTMLAnchorElement;
legacySettings.hidden = false;
legacyNotice.append(legacySettings);
legacyNotice.hidden = true;
container.append(legacyNotice);
let readerLayout: ReturnType<typeof libraryReaderLayout> = 'unknown';
function sizeReader() {
  const offset = legacyNotice.hidden ? 0 : legacyNotice.getBoundingClientRect().height;
  frame.style.top = `${offset}px`;
  frame.style.height = `calc(100% - ${offset}px)`;
}
window.addEventListener('resize', sizeReader);
let token = crypto.randomUUID();
let awaitingReady = false;
let root: FileSystemDirectoryHandle | undefined;
let current = 'index.html';
let prepared = '';
let generation = 0;
const images = new Map<string, Promise<string>>();
const imagePath = /\.(png|jpe?g|gif|webp|avif)$/i;

function showError(error: unknown) {
  status.textContent = error instanceof Error ? error.message : '无法读取本地文库。';
  retry.hidden = false;
  settings.hidden = false;
  legacyNotice.hidden = true;
  frame.hidden = true;
}

async function load(path = 'index.html', hash = '') {
  const version = ++generation;
  awaitingReady = false;
  token = crypto.randomUUID();
  if (!root) throw new Error('请先在设置中绑定本地文库文件夹。');
  const file = await readLibraryFile(root, path);
  const text = imagePath.test(path) ? '' : await file.text();
  if (version !== generation) return;
  current = path;
  readerLayout = /\.html$/i.test(path) ? libraryReaderLayout(text) : 'unknown';
  if (/\.html$/i.test(path) && readerLayout === 'unknown') {
    throw new Error('这个 HTML 不是可识别的文库入口，可能尚未写入完成。请到当前文库设置重新写入。');
  }
  legacyNotice.hidden = readerLayout !== 'legacy';
  sizeReader();
  prepared = imagePath.test(path)
    ? prepareLibraryDocument(`<html><body><img style="max-width:100%;height:auto" src="${encodeURIComponent(path.split('/').pop()!)}" alt="本地图片"></body></html>`)
    : /\.html$/i.test(path) ? prepareLibraryDocument(text) : '';
  if (!prepared) {
    frame.hidden = true;
    status.textContent = text;
    status.className = 'whitespace-pre-wrap break-words font-mono text-sm';
    retry.hidden = false;
    settings.hidden = false;
    return;
  }
  frame.hidden = true;
  awaitingReady = true;
  frame.src = chrome.runtime.getURL('archive-sandbox.html') + hash;
}

async function start(requestPermission = false) {
  try {
    retry.hidden = true;
    settings.hidden = true;
    images.clear();
    const binding = await getLibraryFolder();
    if (!binding?.managedName) throw new Error('当前文库还没有本地入口。请在设置中绑定文件夹并写入本地文库。');
    const handle = binding.handle as FileSystemDirectoryHandle & {
      queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
      requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
    };
    const permission = await handle.queryPermission({ mode: 'read' });
    if (permission !== 'granted' && (!requestPermission || await handle.requestPermission({ mode: 'read' }) !== 'granted')) {
      throw new Error('需要读取当前文库目录的权限。点击下方按钮授权后重试。');
    }
    root = await handle.getDirectoryHandle(binding.managedName);
    await load(new URL(location.href).searchParams.get('file') || 'index.html', location.hash);
  } catch (error) {
    showError(error instanceof DOMException && error.name === 'NotFoundError'
      ? new Error('未找到当前文库的 index.html。请先在设置中写入本地文库，目录移动后需重新绑定。') : error);
  }
}

window.addEventListener('message', async (event: MessageEvent) => {
  if (event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') return;
  const message = event.data;
  if (message.type === 'library-ready') {
    if (!awaitingReady) return;
    awaitingReady = false;
    const readerUrl = new URL(location.href);
    readerUrl.searchParams.set('file', current);
    const runtime = readerLayout === 'current'
      ? `window.archiveReaderUrl = ${JSON.stringify(readerUrl.href)};\n${ARCHIVE_READER_SCRIPT}` : '';
    frame.contentWindow!.postMessage({ type: 'library-document', html: prepared, runtime, token }, '*');
    frame.hidden = false;
    return;
  }
  if (message.token !== token || typeof message.path !== 'string' || !Number.isSafeInteger(message.id)) return;
  const version = generation;
  try {
    if (message.type === 'library-link' && /^https?:\/\//i.test(message.path)) {
      await chrome.tabs.create({ url: message.path });
      return;
    }
    const path = resolveLibraryPath(message.path, current);
    if (message.type === 'library-link') {
      await load(path);
    } else if (message.type === 'library-image' && imagePath.test(path)) {
      // Keep the browser viewer bounded even when the archive contains many photos.
      if (images.size >= 20 && !images.has(path)) images.delete(images.keys().next().value!);
      if (!images.has(path)) images.set(path, readLibraryFile(root!, path).then(file => new Promise<string>((resolve, reject) => {
        if (file.size > 20 * 1024 * 1024) { reject(new Error('图片超过本地阅读上限 20 MB。')); return; }
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      })).catch(error => {
        images.delete(path);
        throw error;
      }));
      const url = await images.get(path)!;
      if (version === generation) frame.contentWindow!.postMessage({ id: message.id, token, url }, '*');
    }
  } catch (error) {
    if (version !== generation) return;
    if (message.type === 'library-image') frame.contentWindow!.postMessage({ id: message.id, token, error: '文件缺失或目录权限已失效。' }, '*');
    else showError(error);
  }
});

retry.addEventListener('click', () => void start(true));
void start();
