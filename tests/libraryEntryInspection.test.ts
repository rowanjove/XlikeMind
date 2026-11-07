import { describe, expect, it, vi } from 'vitest';
import { inspectLibraryEntry } from '../src/export/libraryFolder';

function fixture(size = 32) {
  const getFile = vi.fn().mockResolvedValue({ size, lastModified: 1000 });
  const getFileHandle = vi.fn().mockResolvedValue({ getFile });
  const getDirectoryHandle = vi.fn().mockResolvedValue({ getFileHandle });
  const requestPermission = vi.fn().mockResolvedValue('granted');
  const handle = { requestPermission, getDirectoryHandle } as unknown as FileSystemDirectoryHandle;
  return { handle, requestPermission, getDirectoryHandle, getFileHandle, getFile };
}

describe('bound library permission and entry inspection', () => {
  it('requests permission and reads only the existing entry metadata', async () => {
    const f = fixture();
    expect(await inspectLibraryEntry(f.handle, 'LikeMind-current')).toEqual({ status: 'ready', bytes: 32, modifiedAt: 1000 });
    expect(f.requestPermission).toHaveBeenCalledExactlyOnceWith({ mode: 'readwrite' });
    expect(f.getDirectoryHandle).toHaveBeenCalledExactlyOnceWith('LikeMind-current');
    expect(f.getFileHandle).toHaveBeenCalledExactlyOnceWith('index.html');
    expect(f.getFile).toHaveBeenCalledTimes(1);
  });

  it('does not access files after permission is denied', async () => {
    const f = fixture();
    f.requestPermission.mockResolvedValue('denied');
    await expect(inspectLibraryEntry(f.handle, 'LikeMind-current')).rejects.toThrow('需要目录写入权限');
    expect(f.getDirectoryHandle).not.toHaveBeenCalled();
  });

  it('reports an empty entry without repairing or rewriting it', async () => {
    const f = fixture(0);
    expect(await inspectLibraryEntry(f.handle, 'LikeMind-current')).toEqual({ status: 'empty', bytes: 0, modifiedAt: 1000 });
  });

  it('reports missing entries and uninitialized namespaces without creating directories', async () => {
    const f = fixture();
    expect(await inspectLibraryEntry(f.handle)).toEqual({ status: 'missing' });
    expect(f.getDirectoryHandle).not.toHaveBeenCalled();
    f.getFileHandle.mockRejectedValue(new DOMException('missing', 'NotFoundError'));
    expect(await inspectLibraryEntry(f.handle, 'LikeMind-current')).toEqual({ status: 'missing' });
    expect(f.getDirectoryHandle).toHaveBeenCalledExactlyOnceWith('LikeMind-current');
  });

  it('keeps other read errors distinct from a missing entry', async () => {
    const f = fixture();
    f.getFile.mockRejectedValue(new DOMException('read failed', 'NotReadableError'));
    await expect(inspectLibraryEntry(f.handle, 'LikeMind-current')).rejects.toThrow('read failed');
  });
});
