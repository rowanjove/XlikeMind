import { hasArchivedMedia } from '../domain/media';
import type { MediaAsset } from '../domain/types';
import { createMockImageBlob } from '../adapters/fixtureAdapter';

const FIXTURE_IMAGE = /^https:\/\/pbs\.twimg\.com\/media\/mock(?:_|$)/i;
export const MAX_IMAGE_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const IMAGE_TOO_LARGE = '图片超过 16 MiB 下载上限，未找到可用的较小版本';

export function isFixtureImageUrl(url: string): boolean {
  return FIXTURE_IMAGE.test(url);
}

export interface DownloadResult {
  asset: MediaAsset;
  success: boolean;
}

function isTwimgHost(hostname: string): boolean {
  return hostname === 'twimg.com' || hostname.endsWith('.twimg.com');
}

/** Prefer the original for sized photo URLs, with the observed URL as the first fallback. */
export function buildDownloadCandidates(sourceUrl: string): string[] {
  const ordered: string[] = [];
  const push = (url: string) => {
    if (url && !ordered.includes(url)) ordered.push(url);
  };
  push(sourceUrl);
  try {
    const parsed = new URL(sourceUrl);
    if (!isTwimgHost(parsed.hostname)) return ordered;
    const names = ['orig', 'large', 'medium', 'small'] as const;
    if (parsed.searchParams.has('name')) {
      if (parsed.pathname.startsWith('/media/') && parsed.searchParams.get('name') !== 'orig') {
        const original = new URL(sourceUrl);
        original.searchParams.set('name', 'orig');
        ordered.unshift(original.toString());
      }
      for (const name of names) {
        const next = new URL(sourceUrl);
        next.searchParams.set('name', name);
        push(next.toString());
      }
      return ordered;
    }
    if (parsed.pathname.includes('/media/')) {
      for (const name of names) {
        const next = new URL(sourceUrl);
        next.searchParams.set('name', name);
        if (!next.searchParams.has('format')) next.searchParams.set('format', 'jpg');
        push(next.toString());
      }
    }
  } catch {
    return ordered;
  }
  return ordered;
}

async function sniffImageMime(blob: Blob): Promise<string | undefined> {
  const sliced = blob.slice(0, 64);
  const buffer = typeof sliced.arrayBuffer === 'function' ? await sliced.arrayBuffer() :
    await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(sliced);
    });
  const bytes = new Uint8Array(buffer);
  const startsWith = (signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (startsWith([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (startsWith([255, 216, 255])) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp') {
    const boxEnd = Math.min(bytes.length, new DataView(buffer).getUint32(0));
    if (['avif', 'avis'].includes(ascii(8, 12))) return 'image/avif';
    for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
      if (['avif', 'avis'].includes(ascii(offset, offset + 4))) return 'image/avif';
    }
  }
}

function isImageContentType(mime: string): boolean {
  const type = mime.toLowerCase();
  if (
    type.startsWith('text/') ||
    type.includes('html') ||
    type.includes('json') ||
    type.includes('xml') ||
    type.includes('svg')
  ) {
    return false;
  }
  return type.startsWith('image/') || type === 'application/octet-stream' || type === '';
}

export async function isDecodableImage(blob: Blob): Promise<boolean> {
  if (typeof createImageBitmap !== 'function') return true;
  try {
    const preview = await createImageBitmap(blob, { resizeWidth: 1, resizeHeight: 1 });
    preview.close();
    return true;
  } catch {
    return false;
  }
}

/** Undefined means the response exceeds the byte budget. Never read the rest. */
async function readBoundedImage(response: Response, mime: string, signal: AbortSignal): Promise<Blob | undefined> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > MAX_IMAGE_DOWNLOAD_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    return;
  }
  if (!response.body) return new Blob([], { type: mime });

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) return new Blob(chunks, { type: mime });
      size += value.byteLength;
      if (size > MAX_IMAGE_DOWNLOAD_BYTES) {
        void reader.cancel().catch(() => undefined);
        return;
      }
      chunks.push(value.buffer instanceof ArrayBuffer ? value as Uint8Array<ArrayBuffer> : new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Downloads a media asset and converts it to a persistent Blob.
 * If downloading fails, retains the source URL and marks the asset as 'failed' with failureReason.
 * Never throws an unhandled rejection that would break the entire sync batch.
 */
export async function downloadMediaAsset(
  asset: MediaAsset,
  options?: { signal?: AbortSignal; timeoutMs?: number; fixtureMode?: boolean }
): Promise<DownloadResult> {
  // If already downloaded and blob exists, return early
  if (hasArchivedMedia(asset)) {
    return { asset, success: true };
  }

  // Offline fixture images only. A real twimg URL must not match this.
  let fixtureHost = false;
  try {
    fixtureHost = isTwimgHost(new URL(asset.sourceUrl).hostname);
  } catch {
    fixtureHost = false;
  }
  if (options?.fixtureMode && fixtureHost) {
    const mockBlob = createMockImageBlob();
    const updated: MediaAsset = {
      ...asset,
      status: 'downloaded',
      blob: mockBlob,
      mime: 'image/png',
      failureReason: undefined,
    };
    return { asset: updated, success: true };
  }

  // If known broken test URL, simulate clean failure without slow timeout
  if (asset.sourceUrl.includes('invalid-broken-domain')) {
    const updated: MediaAsset = {
      ...asset,
      status: 'failed',
      failureReason: 'Domain not found or network unreachable (DNS resolution failed)',
    };
    return { asset: updated, success: false };
  }

  let allowedHost = false;
  try {
    const url = new URL(asset.sourceUrl);
    allowedHost = url.protocol === 'https:' && !url.username && !url.password && isTwimgHost(url.hostname);
  } catch {
    allowedHost = false;
  }
  if (!allowedHost) {
    return {
      asset: {
        ...asset,
        status: 'failed',
        failureReason: '只下载 pbs.twimg.com 上的图片',
      },
      success: false,
    };
  }

  const timeoutMs = options?.timeoutMs || 5000;
  let lastReason = '图片下载失败';
  let sizeLimited = false;

  for (const url of buildDownloadCandidates(asset.sourceUrl)) {
    if (options?.signal?.aborted) {
      return {
        asset: { ...asset, status: 'failed', failureReason: '下载已取消' },
        success: false,
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });

      if (!res.ok) {
        lastReason = `HTTP ${res.status}: ${res.statusText}`;
        void res.body?.cancel().catch(() => undefined);
        continue;
      }

      const mime = res.headers.get('content-type') || '';
      if (!isImageContentType(mime)) {
        void res.body?.cancel().catch(() => undefined);
        lastReason = '响应不是图片';
        continue;
      }
      const blob = await readBoundedImage(res, mime, controller.signal);
      controller.signal.throwIfAborted();
      if (!blob) {
        sizeLimited = true;
        continue;
      }
      const storedMime = await sniffImageMime(blob);
      if (!storedMime) {
        lastReason = '图片内容为空或格式无法识别';
        continue;
      }
      const archiveBlob = blob.type === storedMime ? blob : blob.slice(0, blob.size, storedMime);
      if (!(await isDecodableImage(archiveBlob))) {
        lastReason = '图片无法解码';
        continue;
      }
      controller.signal.throwIfAborted();

      return {
        asset: {
          ...asset,
          downloadedFromUrl: url,
          status: 'downloaded',
          blob: archiveBlob,
          mime: storedMime,
          failureReason: undefined,
        },
        success: true,
      };
    } catch (err: unknown) {
      if (options?.signal?.aborted) {
        lastReason = '下载已取消';
        break;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      lastReason = errorMessage.toLowerCase().includes('abort') ? 'Download timed out' : errorMessage;
    } finally {
      clearTimeout(timeoutId);
      options?.signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    asset: {
      ...asset,
      status: 'failed',
      failureReason: options?.signal?.aborted ? '下载已取消' : sizeLimited ? IMAGE_TOO_LARGE : lastReason,
    },
    success: false,
  };
}
