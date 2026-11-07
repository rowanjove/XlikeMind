import { describe, expect, it } from 'vitest';
import { readSignedInXHandle } from '../src/adapters/xAccount';

describe('visible X account evidence', () => {
  const page = 'https://x.com/another_account/likes';
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

  it('uses the self-profile link and ignores the page owner and article author', () => {
    const document = parse('<nav><a data-testid="AppTabBar_Profile_Link" href="/My_Account">Profile</a></nav><article><a href="/author">Author</a></article>');
    expect(readSignedInXHandle(document, page)).toBe('my_account');
  });

  it('reads the account switcher and a profile link that sits outside nav', () => {
    const switcher = parse('<button data-testid="SideNav_AccountSwitcher_Button"><span>Ada</span><span>@My_Account</span></button><article>@author</article>');
    expect(readSignedInXHandle(switcher, page)).toBe('my_account');
    const outside = parse('<div><a data-testid="AppTabBar_Profile_Link" href="/Outside_Nav">Profile</a></div>');
    expect(readSignedInXHandle(outside, page)).toBe('outside_nav');
  });

  it('fails closed when the profile link and account switcher name different people', () => {
    const conflict = parse('<a data-testid="AppTabBar_Profile_Link" href="/one"></a><button data-testid="SideNav_AccountSwitcher_Button">@two</button>');
    expect(readSignedInXHandle(conflict, page)).toBeUndefined();
  });

  it('fails closed on missing, foreign or contradictory account evidence', () => {
    const document = parse('<article><a href="/author">Author</a></article>');
    expect(readSignedInXHandle(document, page)).toBeUndefined();
    const foreign = parse('<nav><a data-testid="AppTabBar_Profile_Link" href="https://example.com/owner">Profile</a></nav>');
    expect(readSignedInXHandle(foreign, page)).toBeUndefined();
    const ambiguous = parse('<nav><a data-testid="AppTabBar_Profile_Link" href="/one"></a><a data-testid="AppTabBar_Profile_Link" href="/two"></a></nav>');
    expect(readSignedInXHandle(ambiguous, page)).toBeUndefined();
  });
});
