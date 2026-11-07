import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaAsset } from '../src/domain/types';
import { buildDownloadCandidates, downloadMediaAsset, isFixtureImageUrl, MAX_IMAGE_DOWNLOAD_BYTES } from '../src/sync/mediaDownloader';

function asset(sourceUrl: string): MediaAsset {
  return {
    id: '1_media_0',
    postId: 'x:1',
    position: 0,
    kind: 'image',
    sourceUrl,
    status: 'pending',
  };
}

describe('media download fallbacks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefers the original before the observed size and smaller fallbacks', () => {
    const urls = buildDownloadCandidates('https://pbs.twimg.com/media/abc.jpg?format=jpg&name=large');
    expect(urls[0]).toContain('name=orig');
    expect(urls[1]).toContain('name=large');
    expect(urls.filter((url) => url.includes('name=large'))).toHaveLength(1);
    expect(urls.some((url) => url.includes('name=medium'))).toBe(true);
    expect(urls.some((url) => url.includes('name=small'))).toBe(true);
  });

  it('does not fetch fixture images', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await downloadMediaAsset(asset('https://pbs.twimg.com/media/mock_card.png'), { fixtureMode: true });
    expect(result.success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not treat arbitrary production-looking names as fixture images', () => {
    expect(isFixtureImageUrl('https://pbs.twimg.com/media/securityAnyRealName.jpg')).toBe(false);
    expect(isFixtureImageUrl('https://pbs.twimg.com/media/mock_card.png')).toBe(true);
  });

  it('skips html responses and keeps the next image size', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        urls.push(String(input));
        if (String(input).includes('name=large') || String(input).includes('name=orig')) {
          return new Response('<!doctype html><title>missing</title>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      })
    );

    const result = await downloadMediaAsset(asset('https://pbs.twimg.com/media/abc.jpg?format=jpg&name=large'));
    expect(result.success).toBe(true);
    expect(result.asset.mime).toContain('image/jpeg');
    expect(result.asset.sourceUrl).toContain('name=large');
    expect(result.asset.downloadedFromUrl).toContain('name=medium');
    expect(urls.some((url) => url.includes('name=orig'))).toBe(true);
  });

  it('does not fetch images outside pbs.twimg.com', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await downloadMediaAsset(asset('https://example.com/tracker.jpg'));
    expect(result.success).toBe(false);
    expect(result.asset.failureReason).toContain('pbs.twimg.com');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects plain error text with an image header and uses the signature of the fallback', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Access denied', { headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(new Response(Uint8Array.of(255, 216, 255, 217), {
        headers: { 'content-type': 'application/octet-stream' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await downloadMediaAsset(asset('https://pbs.twimg.com/media/incorrect.png?name=large'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.asset).toMatchObject({ status: 'downloaded', mime: 'image/jpeg' });
    expect(result.asset.blob?.type).toBe('image/jpeg');
  });

  it('fails when every candidate is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    );
    const result = await downloadMediaAsset(asset('https://pbs.twimg.com/media/empty.jpg?name=large'));
    expect(result.success).toBe(false);
    expect(result.asset.status).toBe('failed');
  });

  it('cancels an oversized response from its headers and tries a smaller image', async () => {
    const cancel = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), {
        headers: { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_DOWNLOAD_BYTES + 1) },
      }))
      .mockResolvedValueOnce(new Response(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9), {
        headers: { 'content-type': 'image/jpeg' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await downloadMediaAsset(asset('https://pbs.twimg.com/media/oversized.jpg?name=orig'));
    expect(cancel).toHaveBeenCalledOnce();
    expect(result.asset.sourceUrl).toContain('name=orig');
    expect(result.asset.downloadedFromUrl).toContain('name=large');
    expect(result.asset.blob?.size).toBe(4);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
  });

  it('enforces the stream budget without a Content-Length header and retains the source link', async () => {
    const cancel = vi.fn();
    const chunk = Uint8Array.of(0xff);
    Object.defineProperty(chunk, 'byteLength', { value: MAX_IMAGE_DOWNLOAD_BYTES + 1 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ start: (controller) => controller.enqueue(chunk), cancel }), {
        headers: { 'content-type': 'image/jpeg' },
      }))
      .mockImplementation(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const sourceUrl = 'https://pbs.twimg.com/media/stream.jpg?name=orig';
    const result = await downloadMediaAsset(asset(sourceUrl));
    expect(cancel).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: false, asset: { sourceUrl, status: 'failed' } });
    expect(result.asset.blob).toBeUndefined();
    expect(result.asset.failureReason).toContain('16 MiB');
  });
});
