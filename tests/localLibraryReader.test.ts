import { describe, expect, it, vi } from 'vitest';
import { libraryReaderLayout, prepareLibraryDocument, readLibraryFile, resolveLibraryPath } from '../src/export/localLibraryReader';

describe('local library file reader', () => {
  it('distinguishes the legacy folding reader from a current or incomplete document', () => {
    expect(libraryReaderLayout('<div id="posts"><details><summary>旧版</summary>正文</details></div>')).toBe('legacy');
    expect(libraryReaderLayout('<main id="workspace"><input id="search"><div id="entries"></div></main>')).toBe('current');
    expect(libraryReaderLayout('<h1>写入中断</h1>')).toBe('unknown');
  });
  it('resolves snapshot assets while rejecting escape and external paths', () => {
    expect(resolveLibraryPath('../assets/a.png', 'snapshots/latest/index.html')).toBe('snapshots/assets/a.png');
    expect(resolveLibraryPath('snapshots/a%20b/index.html')).toBe('snapshots/a b/index.html');
    for (const path of ['../outside', '%2e%2e/outside', '/absolute', 'C:/secret', 'https://x.com/a', '//host/a', '..\\secret', '%00secret']) {
      expect(() => resolveLibraryPath(path)).toThrow();
    }
  });

  it('reads without creating or writing files', async () => {
    const file = new File(['local index'], 'index.html');
    const getFileHandle = vi.fn().mockResolvedValue({ getFile: async () => file });
    const getDirectoryHandle = vi.fn().mockResolvedValue({ getFileHandle });
    expect(await readLibraryFile({ getDirectoryHandle } as unknown as FileSystemDirectoryHandle, 'snapshots/index.html')).toBe(file);
    expect(getDirectoryHandle).toHaveBeenCalledExactlyOnceWith('snapshots');
    expect(getFileHandle).toHaveBeenCalledExactlyOnceWith('index.html');
    await expect(readLibraryFile({} as FileSystemDirectoryHandle, '../secret')).rejects.toThrow();
  });

  it('keeps archive markup but removes disk scripts, handlers and active embeds', () => {
    const html = prepareLibraryDocument(`<html><body onload="bad()"><script>bad()</script><base href="https://bad.test"><iframe srcdoc="bad"></iframe>
      <template data-entry="{}"><h2>原文</h2><img src="assets/a.png" onerror="bad()"></template>
      <a href="javascript:bad()">bad</a><area href="java&#10;script:bad()"><svg><a xlink:href="javascript:bad()">bad</a></svg><math><mtext>bad</mtext></math>
      <img src="assets/b.png" onerror="bad()"><p>保留正文</p></body></html>`);
    expect(html).not.toMatch(/<script|<iframe|<base|<svg|<math|onload|onerror|javascript:|xlink:/i);
    expect(html).toContain('保留正文');
    expect(html).toContain('data-local-src="assets/b.png"');
  });
});
