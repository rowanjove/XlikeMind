import { describe, it, expect } from 'vitest';
import { parseTweetArticle } from '../src/adapters/xDomParser';
import { visibleTweetArticles } from '../src/adapters/xDomAdapter';

describe('X DOM Parser', () => {
  it('keeps literal expansion words, blank lines, code indentation and emoji in the body', () => {
    const article = document.createElement('article');
    article.innerHTML = '<a href="/fixture/status/910">Post</a>' +
      '<div data-testid="tweetText"><pre>  const 文本 = 1;\n\n\n    return 文本;</pre>😄<br>显示更多' +
      '<button data-testid="tweet-text-show-more-link">Show more</button></div>';
    const parsed = parseTweetArticle(article);
    expect(parsed?.text).toBe('  const 文本 = 1;\n\n\n    return 文本;\n😄\n显示更多');
    expect(parsed?.missingFields).toContain('truncated_text');
  });

  it('parses a standard tweet article DOM node correctly', () => {
    const article = document.createElement('article');
    article.setAttribute('data-testid', 'tweet');
    article.innerHTML = `
      <div data-testid="User-Name">
        <span>Tech Guru 🚀</span>
        <div><a href="/tech_guru">@tech_guru</a></div>
      </div>
      <img src="https://pbs.twimg.com/profile_images/1/guru.jpg" />
      <a href="/tech_guru/status/1851234567890123001">
        <time datetime="2026-10-15T10:20:00.000Z">Oct 15</time>
      </a>
      <div data-testid="tweetText">
        分享一个超好用的 CLI 工具，使用 TypeScript 构建！
      </div>
      <div data-testid="tweetPhoto">
        <img src="https://pbs.twimg.com/media/preview.jpg?format=jpg&name=small" />
      </div>
      <a href="https://github.com/example/likemind">github.com</a>
    `;

    const parsed = parseTweetArticle(article);
    expect(parsed).not.toBeNull();
    expect(parsed?.postId).toBe('1851234567890123001');
    expect(parsed?.authorHandle).toBe('tech_guru');
    expect(parsed?.authorDisplayName).toBe('Tech Guru 🚀');
    expect(parsed?.postedAt).toBe('2026-10-15T10:20:00.000Z');
    expect(parsed?.text).toContain('分享一个超好用的 CLI 工具');
    // High res URL upgraded to name=large
    expect(parsed?.mediaUrls).toContain('https://pbs.twimg.com/media/preview.jpg?format=jpg&name=large');
    expect(parsed?.externalLinks).toContain('https://github.com/example/likemind');
    expect(parsed?.isPartial).toBe(false);
  });

  it('handles tweet with multiple photos in order', () => {
    const article = document.createElement('article');
    article.setAttribute('data-testid', 'tweet');
    article.innerHTML = `
      <a href="/user/status/999888777"><time datetime="2026-10-20T00:00:00Z"></time></a>
      <div data-testid="User-Name"><span>Artist</span><span>@artist</span></div>
      <div data-testid="tweetText">Four artwork photos</div>
      <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/1.jpg" /></div>
      <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/2.jpg" /></div>
      <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/3.jpg" /></div>
      <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/4.jpg" /></div>
    `;

    const parsed = parseTweetArticle(article);
    expect(parsed?.postId).toBe('999888777');
    expect(parsed?.mediaUrls?.map((url) => new URL(url).pathname)).toEqual([
      '/media/1.jpg', '/media/2.jpg', '/media/3.jpg', '/media/4.jpg',
    ]);
  });

  it('uses the outer card status when a quoted card appears first', () => {
    const article = document.createElement('article');
    article.innerHTML = `
      <blockquote><article data-testid="tweet">
        <a href="/quoted/status/111"><time datetime="2021-01-01T00:00:00Z">Nested quote</time></a>
        <div data-testid="User-Name"><span>Quoted</span> @quoted</div>
        <img src="https://pbs.twimg.com/profile_images/1/quoted.png">
      </article></blockquote>
      <div data-testid="User-Name"><span>Outer</span> @author</div>
      <img src="https://pbs.twimg.com/profile_images/2/outer.png">
      <a href="/author/status/222"><time datetime="2026-10-20T00:00:00Z"></time></a>
      <div data-testid="tweetText">Outer body</div>
    `;

    const parsed = parseTweetArticle(article);
    expect(parsed).toMatchObject({
      postId: '222',
      authorHandle: 'author',
      authorDisplayName: 'Outer',
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/2/outer.png',
      postedAt: '2026-10-20T00:00:00.000Z',
    });
    expect(parsed?.text).toContain('Outer body');
    expect(parsed?.references).toEqual([{ kind: 'quote', id: '111', url: 'https://x.com/quoted/status/111' }]);
    expect(parsed?.missingFields).toContain('quoted_post_body');
  });

  it('preserves explicit relationships and image alt text without mixing media from the quote', () => {
    const feed = document.createElement('main');
    feed.innerHTML = `<article data-testid="tweet">
      <a href="/ada/status/200"><time datetime="2026-10-20T00:00:00Z"></time></a>
      <div data-testid="replyContext"><a href="/bob/status/100?s=20">回复的帖子</a><a href="/bob">@bob</a></div>
      <div data-testid="tweetText">正文 <a href="/i/article/300">文章</a> <a href="/carol/status/999">普通链接</a></div>
      <picture><source srcset="https://pbs.twimg.com/media/a.jpg?name=orig 800w"><img
        src="https://pbs.twimg.com/media/a.jpg?name=small" alt="图表说明：中文和符号 [X]"></picture>
      <blockquote><article data-testid="tweet">
        <a href="/carol/status/400">引用帖</a><div data-testid="tweetText">引用正文</div>
        <img src="https://pbs.twimg.com/media/quoted.jpg" alt="引用图">
        <a href="https://outside.invalid/carol/status/500">非 X 地址</a>
      </article></blockquote>
    </article>`;
    const [card] = visibleTweetArticles(feed);
    expect(visibleTweetArticles(feed)).toHaveLength(1);
    const parsed = parseTweetArticle(card);
    expect(parsed?.references).toEqual([
      { kind: 'reply', id: '100', url: 'https://x.com/bob/status/100' },
      { kind: 'article', id: '300', url: 'https://x.com/i/article/300' },
      { kind: 'quote', id: '400', url: 'https://x.com/carol/status/400' },
    ]);
    expect(parsed?.mediaUrls).toEqual(['https://pbs.twimg.com/media/a.jpg?name=orig']);
    expect(parsed?.mediaAltTexts).toEqual({ 'https://pbs.twimg.com/media/a.jpg?name=orig': '图表说明：中文和符号 [X]' });
    expect(parsed?.text).toContain('引用正文');
    expect(parsed?.missingFields).toContain('article_body');
    expect(parsed?.missingFields).toContain('quoted_post_media');
    expect(parsed?.isPartial).toBe(true);
  });

  it('marks a truncated quote without treating the enclosing post text as truncated', () => {
    const article = document.createElement('article');
    article.innerHTML = `
      <a href="/author/status/100">原帖</a>
      <div data-testid="tweetText">外层完整正文</div>
      <blockquote>
        <a href="/quoted/status/200">引用帖</a>
        <div data-testid="tweetText">引用预览 <button>Show more</button></div>
      </blockquote>
    `;
    const parsed = parseTweetArticle(article);
    expect(parsed?.isPartial).toBe(true);
    expect(parsed?.missingFields).toContain('quoted_post_body');
    expect(parsed?.missingFields).not.toContain('truncated_text');
    expect(parsed?.text).toBe('外层完整正文\n\n引用：\n引用预览 ');
    article.querySelector('button')?.remove();
    expect(parseTweetArticle(article)?.isPartial).toBe(false);
  });

  it('marks a post with a visible photo and an unresolved photo slot as partial', () => {
    const article = document.createElement('article');
    article.innerHTML = `
      <a href="/user/status/777">Post</a>
      <div data-testid="tweetText">Media gallery</div>
      <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/visible.jpg"></div>
      <div data-testid="tweetPhoto">
        <img src="https://example.invalid/?redirect=https://pbs.twimg.com/media/fake.jpg">
        <blockquote><img src="https://pbs.twimg.com/media/quoted.jpg"></blockquote>
      </div>
    `;
    expect(parseTweetArticle(article)).toMatchObject({
      isPartial: true,
      missingFields: expect.arrayContaining(['media']),
      mediaUrls: ['https://pbs.twimg.com/media/visible.jpg'],
    });
  });

  it('keeps the card ID and marks an explicit thread continuation as missing', () => {
    const article = document.createElement('article');
    article.innerHTML = `
      <a href="/author/status/999">Show this thread</a>
      <a href="/author/status/777">Permalink</a>
      <div data-testid="tweetText">已加载的部分 <a href="/author/status/888">Show this thread</a></div>
    `;
    expect(parseTweetArticle(article)).toMatchObject({
      postId: '777',
      isPartial: true,
      missingFields: expect.arrayContaining(['thread_continuation']),
      references: [{ kind: 'thread', id: '999', url: 'https://x.com/author/status/999' }],
    });
    article.querySelector('a')?.remove();
    expect(parseTweetArticle(article)).toMatchObject({ isPartial: false, references: [] });
  });

  it('prefers the status link carrying the publication timestamp', () => {
    const article = document.createElement('article');
    article.innerHTML = `
      <a href="/quoted/status/333">Quoted</a>
      <a href="/author/status/444"><time datetime="2026-10-20T00:00:00Z"></time></a>
      <div data-testid="tweetText">Outer body</div>
    `;

    expect(parseTweetArticle(article)?.postId).toBe('444');
  });

  it('records missing author and time without marking a readable body as partial', () => {
    const article = document.createElement('article');
    article.setAttribute('data-testid', 'tweet');
    article.innerHTML = `
      <a href="/unknown/status/12345678">Link</a>
      <div data-testid="tweetText">Anonymous tweet with no time</div>
    `;

    const parsed = parseTweetArticle(article);
    expect(parsed).not.toBeNull();
    expect(parsed?.postId).toBe('12345678');
    expect(parsed?.isPartial).toBe(false);
    expect(parsed?.missingFields).toContain('authorHandle');
    expect(parsed?.missingFields).toContain('postedAt');
  });

  it('marks truncated text as partial and drops unsafe media urls', () => {
    const article = document.createElement('article');
    article.setAttribute('data-testid', 'tweet');
    article.innerHTML = `
      <a href="/user/status/555?s=20"><time datetime="2026-10-01T00:00:00.000Z"></time></a>
      <div data-testid="User-Name"><span>User</span><span>@user</span></div>
      <div data-testid="tweetText">Long post</div>
      <div data-testid="tweet-text-show-more-link">Show more</div>
      <div data-testid="tweetPhoto"><img src="javascript:alert(1)" /></div>
      <a href="javascript:alert(1)">bad</a>
    `;

    const parsed = parseTweetArticle(article);
    expect(parsed?.isPartial).toBe(true);
    expect(parsed?.missingFields).toContain('truncated_text');
    expect(parsed?.url).toBe('https://x.com/user/status/555');
    expect(parsed?.mediaUrls).toEqual([]);
    expect(parsed?.externalLinks).toEqual([]);
  });

  it('keeps clamped text and collects srcset, posters and background images', () => {
    const article = document.createElement('article');
    article.innerHTML = `
      <a href="/user/status/1850000000000000099"><time datetime="2026-03-01T00:00:00.000Z"></time></a>
      <div data-testid="User-Name"><span>作者</span><span>@author</span></div>
      <img src="https://pbs.twimg.com/profile_images/1/avatar.jpg" />
      <img src="https://abs.twimg.com/emoji/v2/svg/1.svg" alt="rocket" />
      <div data-testid="tweetText">
        <span>第一行完整内容</span>
        <br />
        <span style="display:none">第二行也在 DOM 里，不应被截断</span>
      </div>
      <div style="background-image: url(&quot;https://pbs.twimg.com/media/bg.jpg?format=jpg&amp;name=small&quot;)"></div>
      <img srcset="https://pbs.twimg.com/media/abc.jpg?format=jpg&amp;name=small 360w, https://pbs.twimg.com/media/abc.jpg?format=jpg&amp;name=large 900w" />
      <video poster="https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/thumb.jpg"></video>
    `;

    const parsed = parseTweetArticle(article);
    expect(parsed?.text).toContain('第一行完整内容');
    expect(parsed?.text).toContain('第二行也在 DOM 里');
    expect(parsed?.mediaUrls?.map((url) => new URL(url).pathname.split('/').at(-1))).toEqual(['bg.jpg', 'abc.jpg', 'thumb.jpg']);
    expect(parsed?.mediaUrls?.[0]).toContain('name=large');
    expect(parsed?.mediaUrls?.some((url) => url.includes('name=small'))).toBe(false);
    expect(parsed?.mediaUrls?.some((url) => url.includes('ext_tw_video_thumb'))).toBe(true);
    expect(parsed?.mediaUrls?.some((url) => url.includes('bg.jpg'))).toBe(true);
    expect(parsed?.mediaUrls?.some((url) => url.includes('profile_images') || url.includes('emoji'))).toBe(false);
  });

  it('returns null if status ID cannot be located in the element', () => {
    const nonTweet = document.createElement('div');
    nonTweet.innerHTML = '<p>Just a random banner</p>';
    const parsed = parseTweetArticle(nonTweet);
    expect(parsed).toBeNull();
  });
});
