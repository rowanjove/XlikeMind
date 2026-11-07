export function normalizeXHandle(value: string): string | undefined {
  const handle = value.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(handle) ? handle : undefined;
}

const PROFILE_LINK = 'a[data-testid="AppTabBar_Profile_Link"][href]';
const ACCOUNT_SWITCHER = '[data-testid="SideNav_AccountSwitcher_Button"]';

function handleFromHref(href: string | null, page: URL): string | undefined {
  try {
    const url = new URL(href ?? '', page);
    if (url.origin !== page.origin || url.search || url.hash) return;
    const match = /^\/([a-z0-9_]{1,15})\/?$/i.exec(url.pathname);
    return match ? match[1].toLowerCase() : undefined;
  } catch {
    return;
  }
}

function addProfileLinks(handles: Set<string>, root: ParentNode, page: URL): void {
  for (const link of root.querySelectorAll<HTMLAnchorElement>(PROFILE_LINK)) {
    const handle = handleFromHref(link.getAttribute('href'), page);
    if (handle) handles.add(handle);
  }
}

/** The account switcher belongs to the signed-in user, unlike names inside posts. */
function addAccountSwitcher(handles: Set<string>, root: ParentNode, page: URL): void {
  const button = root.querySelector(ACCOUNT_SWITCHER);
  if (!button) return;
  for (const link of button.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const handle = handleFromHref(link.getAttribute('href'), page);
    if (handle) handles.add(handle);
  }
  const text = button.textContent ?? '';
  for (const match of text.matchAll(/@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g)) {
    handles.add(match[1].toLowerCase());
  }
}

/** Use only X's own profile navigation, never authors or the archive page URL. */
export function readSignedInXHandle(root: Document, pageUrl: string): string | undefined {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return;
  }
  if (!['x.com', 'twitter.com'].includes(page.hostname) || page.protocol !== 'https:') return;
  const handles = new Set<string>();
  addProfileLinks(handles, root, page);
  addAccountSwitcher(handles, root, page);
  return handles.size === 1 ? handles.values().next().value : undefined;
}
