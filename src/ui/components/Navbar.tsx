import React from 'react';
import { LayoutDashboard, RefreshCw, Settings } from 'lucide-react';
import { BrandMark, LibraryMark } from './BrandMark';
import { ProfileSwitcher } from './ProfileSwitcher';
import { SignedInAccount } from './SignedInAccount';

export type NavTab = 'dashboard' | 'sync' | 'library' | 'settings';

interface NavbarProps {
  currentTab: NavTab;
  onChangeTab: (tab: NavTab) => void;
  postCount: number;
  /** Prevent profile navigation while a sync or local-folder publish is writing. */
  busy?: boolean;
  blocked?: boolean;
}

interface TabItem {
  id: NavTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const TABS: TabItem[] = [
  { id: 'dashboard', label: '总览', icon: LayoutDashboard },
  { id: 'sync', label: '同步', icon: RefreshCw },
  { id: 'library', label: '文库', icon: LibraryMark },
  { id: 'settings', label: '设置', icon: Settings },
];

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onChangeTab,
  postCount,
  busy = false,
  blocked = false,
}) => {
  return (
    <header className="sticky top-0 z-30 border-b border-[#ddd9cf] bg-[#f4f1ea]">
      <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-4 px-4 py-2 sm:px-6 lg:py-0">
        <div className="flex shrink-0 items-center gap-2.5 text-[15px] font-semibold tracking-tight text-stone-900">
          <BrandMark />
          <div className="leading-tight">
            <span className="block">XlikeMind</span>
            <span className="mt-0.5 block text-[10px] font-medium tracking-[0.12em] text-stone-500">本地知识库</span>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-3">
          <nav aria-label="主导航" className="order-last flex w-full items-center justify-end gap-0.5 overflow-x-auto lg:order-none lg:w-auto">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const selected = currentTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onChangeTab(tab.id)}
                  aria-current={selected ? 'page' : undefined}
                  className={`lm-nav-button relative flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
                    selected
                      ? 'bg-[#fffdf8] font-semibold text-stone-900 shadow-sm'
                      : 'text-stone-500 hover:bg-stone-200/50 hover:text-stone-900'
                  }`}
                >
                  <Icon aria-hidden="true" className={`h-4 w-4 ${selected ? 'text-[#315846]' : 'text-stone-500'}`} />
                  <span>{tab.label}</span>
                  {tab.id === 'library' && postCount > 0 && (
                    <span aria-label={`${postCount} 篇`} className="rounded-full bg-[#e6eee8] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-[#315846]">
                      {postCount}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
          <SignedInAccount busy={busy || blocked} />
          <ProfileSwitcher busy={busy} blocked={blocked} />
        </div>
      </div>
    </header>
  );
};
