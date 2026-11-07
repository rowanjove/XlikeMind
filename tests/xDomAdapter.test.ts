import { describe, it, expect } from 'vitest';
import { rememberVisiblePostIds, XDomCaptureAdapter } from '../src/adapters/xDomAdapter';
import { detectCaptureFailure } from '../src/adapters/captureFailure';

describe('XDomCaptureAdapter in DOM Environment', () => {
  it('reparses an approved incomplete card during replay without spending the new-post limit', async () => {
    document.body.innerHTML = [51, 52, 53].map((id) => `
      <article data-testid="tweet"><a href="/user/status/${id}"></a>
      <div data-testid="tweetText">Post ${id}</div></article>
    `).join('');
    const adapter = new XDomCaptureAdapter(0);
    adapter.restoreSeenPostIds(['51', '52']);
    const result = await adapter.captureBatch({ limit: 1, cursor: 'continue', repairPostIds: ['52'] });
    expect(result.repairs?.map(({ postId }) => postId)).toEqual(['52']);
    expect(result.items.map(({ postId }) => postId)).toEqual(['53']);
    const next = await adapter.captureBatch({ limit: 1, cursor: result.cursor, repairPostIds: ['52'] });
    expect(next.repairs).toEqual([]);
  });

  it('distinguishes an explicit platform restriction from post text and hidden notices', async () => {
    document.body.innerHTML = '<div role="alert">Rate limit exceeded</div>';
    expect(await new XDomCaptureAdapter(0).captureBatch({ limit: 5 })).toMatchObject({
      status: 'failed', failureCode: 'access_restricted', items: [],
    });
    document.body.innerHTML = '<article data-testid="tweet"><a href="/user/status/15"></a><div data-testid="tweetText"><span role="alert">Rate limit exceeded</span></div></article><div role="alert" hidden>请登录</div>';
    expect(await new XDomCaptureAdapter(0).captureBatch({ limit: 1 })).toMatchObject({
      items: [{ postId: '15' }], status: 'partial',
    });
    expect(detectCaptureFailure(document, 'https://x.com/i/flow/login')).toMatchObject({ failureCode: 'login_required' });
    document.body.innerHTML = '<div data-testid="error-detail">Something went wrong</div>';
    expect(detectCaptureFailure(document, 'https://x.com/i/history/likes')).toMatchObject({ failureCode: 'page_error' });
  });

  it('keeps counting posts after earlier cards leave the page', () => {
    const seen = new Set<string>();
    document.body.innerHTML = `
      <article data-testid="tweet"><a href="/user/status/11"></a></article>
      <article data-testid="tweet"><a href="/user/status/12"></a></article>
    `;
    expect(rememberVisiblePostIds(seen)).toBe(2);

    document.body.innerHTML = `
      <article data-testid="tweet"><a href="/user/status/13"></a></article>
    `;
    expect(rememberVisiblePostIds(seen)).toBe(3);
  });

  it('returns diagnostics failure if page has no tweet elements', async () => {
    document.body.innerHTML = '<div>Not on x.com likes page</div>';
    const adapter = new XDomCaptureAdapter();

    const result = await adapter.captureBatch({ limit: 10 });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('未检测到推文元素');
    expect(result.items).toHaveLength(0);
  });

  it('scrapes visible tweets from DOM and respects limit', async () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <a href="/user1/status/10001"><time datetime="2026-10-01T00:00:00Z"></time></a>
        <div data-testid="User-Name"><span>User 1</span><span>@user1</span></div>
        <div data-testid="tweetText">First tweet content</div>
      </article>
      <article data-testid="tweet">
        <a href="/user2/status/10002"><time datetime="2026-10-02T00:00:00Z"></time></a>
        <div data-testid="User-Name"><span>User 2</span><span>@user2</span></div>
        <div data-testid="tweetText">Second tweet content</div>
      </article>
    `;

    const adapter = new XDomCaptureAdapter();
    const result = await adapter.captureBatch({ limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.items[0].postId).toBe('10001');
    expect(result.items[1].postId).toBe('10002');
  });

  it('respects abort signal and marks partial', async () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <a href="/user/status/20001"><time datetime="2026-10-01T00:00:00Z"></time></a>
        <div data-testid="tweetText">Tweet 1</div>
      </article>
    `;

    const controller = new AbortController();
    controller.abort();

    const adapter = new XDomCaptureAdapter();
    const result = await adapter.captureBatch({ limit: 10, signal: controller.signal });
    expect(result.status).toBe('partial');
    expect(result.error).toContain('cancelled');
  });

  it('does not claim the likes history is complete when scrolling stops', async () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <a href="/user/status/30001"><time datetime="2026-10-01T00:00:00Z"></time></a>
        <div data-testid="tweetText">Only visible tweet</div>
      </article>
    `;

    const adapter = new XDomCaptureAdapter(0);
    const result = await adapter.captureBatch({ limit: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.status).toBe('partial');
    expect(result.hasMore).toBe(false);
    expect(result.error).toContain('不代表历史点赞已全部采集');
  });

  it('reports unreadable cards alongside readable posts instead of ordinary timeline exhaustion', async () => {
    document.body.innerHTML = `
      <article data-testid="tweet"><a href="/user/status/30001"></a>
      <div data-testid="tweetText">Readable post</div></article>
      <article data-testid="tweet"><div data-testid="tweetText">Card without an ID</div></article>
    `;
    expect(await new XDomCaptureAdapter(0).captureBatch({ limit: 10 })).toMatchObject({
      items: [{ postId: '30001' }], status: 'failed', failureCode: 'parse_failed', hasMore: false,
    });
  });

  it('continues from the previous cursor instead of returning the same posts', async () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <a href="/user/status/40001"><time datetime="2026-10-01T00:00:00Z"></time></a>
        <div data-testid="tweetText">First</div>
      </article>
      <article data-testid="tweet">
        <a href="/user/status/40002"><time datetime="2026-10-02T00:00:00Z"></time></a>
        <div data-testid="tweetText">Second</div>
      </article>
    `;

    const adapter = new XDomCaptureAdapter(0);
    const first = await adapter.captureBatch({ limit: 1 });
    const second = await adapter.captureBatch({ limit: 1, cursor: first.cursor });

    expect(first.items.map((item) => item.postId)).toEqual(['40001']);
    expect(first.hasMore).toBe(true);
    expect(second.items.map((item) => item.postId)).toEqual(['40002']);
  });


  it('clicks show more and keeps the expanded text', async () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <a href="/user/status/50001"><time datetime="2026-10-01T00:00:00.000Z"></time></a>
        <div data-testid="tweetText" id="body">只有摘要</div>
        <button type="button" data-testid="tweet-text-show-more-link" id="more">显示更多</button>
      </article>
    `;
    document.getElementById('more')?.addEventListener('click', () => {
      const body = document.getElementById('body');
      if (body) body.textContent = '只有摘要。这里是展开后的全文，不应被截断。';
      document.getElementById('more')?.remove();
    });

    const adapter = new XDomCaptureAdapter(0);
    const result = await adapter.captureBatch({ limit: 1 });
    expect(result.items[0]?.text).toContain('展开后的全文');
    expect(result.items[0]?.isPartial).toBe(false);
  });

  it('does not click a show-more link that would leave the likes page', async () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <a href="/user/status/50002"><time datetime="2026-10-01T00:00:00.000Z"></time></a>
        <div data-testid="tweetText" id="short">只有摘要</div>
        <a href="/user/status/50002" data-testid="tweet-text-show-more-link" id="leave">Show more</a>
      </article>
    `;
    let clicked = false;
    document.getElementById('leave')?.addEventListener('click', () => {
      clicked = true;
    });

    const adapter = new XDomCaptureAdapter(0);
    const result = await adapter.captureBatch({ limit: 1 });
    expect(clicked).toBe(false);
    expect(result.items[0]?.text).toContain('只有摘要');
    expect(result.items[0]?.isPartial).toBe(true);
  });

  it('reads article role cards when tweet test ids are absent', async () => {
    document.body.innerHTML = `
      <article role="article">
        <a href="/user/status/60001"><time datetime="2026-01-01T00:00:00.000Z"></time></a>
        <div data-testid="tweetText">角色文章</div>
      </article>
    `;

    const adapter = new XDomCaptureAdapter(0);
    const result = await adapter.captureBatch({ limit: 1 });
    expect(result.items.map((item) => item.postId)).toEqual(['60001']);
    expect(result.items[0]?.text).toContain('角色文章');
  });
});
