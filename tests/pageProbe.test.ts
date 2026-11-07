import { describe, expect, it } from 'vitest';
import { describePageProbe } from '../src/ui/pageProbe';

describe('describePageProbe', () => {
  it('starts as checking before a ping returns', () => {
    expect(describePageProbe(null).lamp).toBe('checking');
    expect(describePageProbe(null).canStart).toBe(false);
  });

  it('is ready only on a likes page that already shows posts', () => {
    const probe = describePageProbe({ ok: true, isLikesPage: true, articlesCount: 4, reading: false });
    expect(probe.lamp).toBe('ready');
    expect(probe.canStart).toBe(true);
    expect(probe.title).toBe('可以开始读取');
  });

  it('waits when the tab is not the likes page or the list is empty', () => {
    expect(describePageProbe({ ok: true, isLikesPage: false, articlesCount: 3 }).lamp).toBe('wait');
    const empty = describePageProbe({ ok: true, isLikesPage: true, articlesCount: 0 });
    expect(empty.lamp).toBe('wait');
    expect(empty.needsReload).toBe(true);
    expect(empty.canStart).toBe(false);
  });

  it('blocks and asks for a reload when the content script is missing', () => {
    const probe = describePageProbe({
      ok: false,
      error: 'Could not establish connection. Receiving end does not exist.',
    });
    expect(probe.lamp).toBe('blocked');
    expect(probe.needsReload).toBe(true);
    expect(probe.detail).toContain('刷新');
  });

  it('shows reading while the likes page is scrolling', () => {
    const probe = describePageProbe({ ok: true, isLikesPage: true, articlesCount: 2, reading: true });
    expect(probe.lamp).toBe('reading');
    expect(probe.canStart).toBe(false);
  });

  it.each([
    ['login_required', 'X 需要登录或验证'],
    ['access_restricted', 'X 请求频率受限'],
    ['page_error', 'X 列表加载失败'],
  ])('blocks %s even when previously loaded posts remain visible', (failureCode, title) => {
    expect(describePageProbe({ ok: true, isLikesPage: true, articlesCount: 4, failureCode }))
      .toMatchObject({ lamp: 'blocked', title, canStart: false, pageBlocked: true });
  });

  it('waits when no likes tab is open', () => {
    const probe = describePageProbe({ ok: false, error: '没有找到已打开的 X 点赞页。' });
    expect(probe.lamp).toBe('wait');
    expect(probe.needsReload).toBe(false);
  });
});
