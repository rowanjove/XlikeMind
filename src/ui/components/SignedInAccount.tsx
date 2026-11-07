import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getPageProfileId, getProfiles, switchProfile } from '../../storage/profiles';
import { readOpenXAccount, type OpenXAccount } from '../signedInX';

function navigateToProfile(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('profile', id);
  window.location.assign(`${url.pathname}${url.search}${url.hash}`);
}

function useOpenXAccount(): OpenXAccount | { status: 'checking' } {
  const [account, setAccount] = useState<OpenXAccount | { status: 'checking' }>({ status: 'checking' });

  useEffect(() => {
    let active = true;
    const read = async () => {
      const next = await readOpenXAccount();
      if (active) setAccount(next);
    };
    void read();
    const timer = window.setInterval(() => void read(), 8000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return account;
}

export function SignedInAccount({ busy = false }: { busy?: boolean }) {
  const account = useOpenXAccount();
  const profiles = useLiveQuery(getProfiles, []) ?? [];
  const active = profiles.find((profile) => profile.id === getPageProfileId());
  const handle = account.status === 'known' ? account.handle : null;
  const matched = handle ? profiles.find((profile) => profile.xHandle === handle) : undefined;
  const mismatch = Boolean(handle && active?.xHandle && active.xHandle !== handle);
  const username = account.status === 'checking'
    ? '正在确认'
    : handle
      ? `@${handle}`
      : account.status === 'closed'
        ? '未打开 X'
        : account.status === 'conflict'
          ? '有多个账号'
          : '还没读到用户名';

  const openMatched = async () => {
    if (!matched || busy) return;
    await switchProfile(matched.id);
    navigateToProfile(matched.id);
  };

  return (
    <div className="max-w-52 shrink rounded-md border border-stone-300/80 bg-white px-2.5 py-1.5 text-right leading-tight" aria-live="polite">
      <p className="text-[10px] font-medium tracking-wide text-stone-500">当前 X 账号</p>
      <p className={`truncate text-sm font-semibold ${mismatch ? 'text-rose-700' : 'text-stone-950'}`}>{username}</p>
      {mismatch && matched && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void openMatched()}
          className="text-[11px] font-medium text-[#315846] underline-offset-2 hover:underline disabled:opacity-50"
        >
          打开此账号的文库
        </button>
      )}
      {mismatch && !matched && active?.xHandle && (
        <p className="text-[11px] text-stone-500">正在看 @{active.xHandle} 的文库</p>
      )}
    </div>
  );
}
