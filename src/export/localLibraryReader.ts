/** Resolve only relative archive paths, without allowing escape from the bound root. */
export function resolveLibraryPath(relative: string, current = 'index.html'): string {
  const raw = decodeURIComponent(relative.split('#')[0].split('?')[0]);
  if (!raw || /[\\\u0000-\u001f]/.test(raw) || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(raw)) {
    throw new Error('无效的文库相对路径。');
  }
  const parts = current.split('/').slice(0, -1);
  for (const segment of raw.split('/')) {
    if (segment === '..') {
      if (!parts.length) throw new Error('不能读取文库目录之外的文件。');
      parts.pop();
    } else if (segment && segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

export async function readLibraryFile(root: FileSystemDirectoryHandle, path: string): Promise<File> {
  // Paths here are already decoded by resolveLibraryPath. Do not decode '%' twice.
  const parts = path.split('/');
  if (/[\\:\u0000-\u001f]/.test(path) || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('无效的文库相对路径。');
  }
  let folder = root;
  for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part);
  return (await folder.getFileHandle(parts[parts.length - 1])).getFile();
}

/** Only the bundled reader runtime is executed, never scripts or event handlers from disk. */
export function libraryReaderLayout(html: string): 'current' | 'legacy' | 'unknown' {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (doc.querySelector('#workspace') && doc.querySelector('#entries') && doc.querySelector('#search')) return 'current';
  if (doc.querySelector('#posts > details')) return 'legacy';
  return 'unknown';
}

export function prepareLibraryDocument(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (doc.querySelector('#posts > details')) {
    doc.querySelectorAll('input, select, button').forEach(control => {
      control.setAttribute('disabled', '');
      control.setAttribute('title', '旧版文库的搜索需更新入口后使用。');
    });
  }
  function clean(scope: ParentNode) {
    scope.querySelectorAll('script, iframe, object, embed, base, meta[http-equiv], link, form, svg, math').forEach((node) => node.remove());
    scope.querySelectorAll('*').forEach((element) => {
      if (element instanceof HTMLTemplateElement) clean(element.content);
      for (const attr of [...element.attributes]) {
        if (attr.namespaceURI || /^on/i.test(attr.name) || ['srcdoc', 'srcset', 'formaction', 'action', 'autofocus'].includes(attr.name)) element.removeAttribute(attr.name);
      }
      if (element.hasAttribute('href')) {
        const href = element.getAttribute('href')!.trim();
        if (element.tagName !== 'A' || /[\u0000-\u001f\u007f]/.test(href) || /^(?!https?:)[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) element.removeAttribute('href');
      }
      if (element.tagName === 'IMG' && element.hasAttribute('src')) {
        element.setAttribute('data-local-src', element.getAttribute('src')!);
        element.removeAttribute('src');
      } else if (element.hasAttribute('src')) element.removeAttribute('src');
    });
  }
  clean(doc);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
