import React, { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, ChevronDown, Plus } from 'lucide-react';
import {
  createProfile,
  deleteProfile,
  getPageProfileId,
  getProfiles,
  switchProfile,
  updateProfile,
  type LocalProfile,
} from '../../storage/profiles';

interface ProfileSwitcherProps {
  busy?: boolean;
  blocked?: boolean;
}

export const ProfileSwitcher: React.FC<ProfileSwitcherProps> = ({ busy = false, blocked = false }) => {
  const activeProfileId = getPageProfileId();
  const profiles = useLiveQuery(getProfiles, []) ?? [];
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [profileHandle, setProfileHandle] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editHandle, setEditHandle] = useState('');
  const [savingBinding, setSavingBinding] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [profileError, setProfileError] = useState('');
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? {
    id: activeProfileId,
    name: '我的文库',
    xHandle: undefined,
  };
  const visibleProfiles = profiles.length > 0 ? profiles : [activeProfile];
  const locked = busy || blocked;

  useEffect(() => {
    if (!profileMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) setProfileMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProfileMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [profileMenuOpen]);

  const navigateToProfile = (id: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('profile', id);
    window.location.assign(`${url.pathname}${url.search}${url.hash}`);
  };

  const handleSwitchProfile = async (id: string) => {
    if (id === activeProfileId) {
      setProfileMenuOpen(false);
      return;
    }
    if (locked) {
      setProfileError('当前任务正在进行，请完成后再切换文库。');
      return;
    }
    setProfileError('');
    try {
      await switchProfile(id);
      navigateToProfile(id);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : '切换文库失败。');
    }
  };

  const beginDelete = (profile: LocalProfile) => {
    if (profile.id === activeProfileId) {
      setProfileError('正在使用的文库不能删除。');
      return;
    }
    if (locked || deleting) {
      setProfileError('当前任务正在进行，请完成后再删除文库。');
      return;
    }
    setCreatingProfile(false);
    setEditingId(null);
    setProfileError('');
    setConfirmingDeleteId(profile.id);
  };

  const confirmDelete = async (profile: LocalProfile) => {
    if (deleting) return;
    if (profile.id === activeProfileId) {
      setProfileError('正在使用的文库不能删除。');
      return;
    }
    if (locked) {
      setProfileError('当前任务正在进行，请完成后再删除文库。');
      return;
    }
    setProfileError('');
    setDeleting(true);
    try {
      await deleteProfile(profile.id);
      setConfirmingDeleteId(null);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : '删除文库失败。');
    } finally {
      setDeleting(false);
    }
  };

  const beginEdit = (profile: LocalProfile) => {
    if (locked) {
      setProfileError('当前任务正在进行，请完成后再修改文库。');
      return;
    }
    setCreatingProfile(false);
    setConfirmingDeleteId(null);
    setProfileError('');
    setEditingId(profile.id);
    setEditName(profile.name);
    setEditHandle(profile.xHandle ? `@${profile.xHandle}` : '');
  };

  const handleSaveBinding = async (event: React.FormEvent<HTMLFormElement>, profile: LocalProfile) => {
    event.preventDefault();
    if (savingBinding) return;
    if (locked) {
      setProfileError('当前任务正在进行，请完成后再修改文库。');
      return;
    }
    setProfileError('');
    setSavingBinding(true);
    try {
      await updateProfile(profile.id, editName, editHandle);
      setEditingId(null);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : '修改文库失败。');
    } finally {
      setSavingBinding(false);
    }
  };

  const handleCreateProfile = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (locked) {
      setProfileError('当前任务正在进行，请完成后再创建文库。');
      return;
    }
    setProfileError('');
    try {
      const profile = await createProfile(profileName, profileHandle);
      await switchProfile(profile.id);
      navigateToProfile(profile.id);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : '创建文库失败。');
    }
  };

  return (
    <div ref={profileMenuRef} className="relative shrink-0">
      <button
        type="button"
        aria-label="切换用户文库"
        aria-haspopup="menu"
        aria-expanded={profileMenuOpen}
        disabled={locked}
        title={locked ? '当前任务进行中，暂不能切换文库' : activeProfile.xHandle ? `${activeProfile.name} @${activeProfile.xHandle}` : `${activeProfile.name}，未绑定 X 账号`}
        onClick={() => {
          setProfileError('');
          setCreatingProfile(false);
          setEditingId(null);
          setConfirmingDeleteId(null);
          setProfileMenuOpen((open) => !open);
        }}
        className="flex max-w-64 items-center gap-1.5 rounded-md border border-stone-300/80 bg-[#fffdf8] px-2.5 py-2 text-xs font-medium text-stone-700 shadow-sm transition-colors hover:border-stone-400 hover:text-stone-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="min-w-0 truncate">{activeProfile.name}</span>
        <span className={`shrink-0 font-normal ${activeProfile.xHandle ? 'text-stone-500' : 'text-stone-400'}`}>
          {activeProfile.xHandle ? `@${activeProfile.xHandle}` : '未绑定'}
        </span>
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      </button>

      {profileMenuOpen && (
        <div role="menu" aria-label="用户文库" className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-72 rounded-xl border border-stone-200 bg-[#fffdf8] p-2 shadow-[0_18px_40px_rgba(62,52,36,0.16)]">
          <p className="px-2 py-1 text-[11px] font-semibold tracking-wide text-stone-500">用户文库</p>
          <div className="space-y-0.5">
            {visibleProfiles.map((profile) => (
              confirmingDeleteId === profile.id ? (
                <div key={profile.id} className="space-y-2 rounded-lg bg-rose-50 px-2.5 py-2">
                  <p className="text-xs leading-5 text-stone-800">删除「{profile.name}」？这台电脑上的帖子、笔记和目录绑定会去掉。文件夹里已经写好的快照还在。</p>
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setConfirmingDeleteId(null)} className="rounded-lg px-2.5 py-1.5 text-xs text-stone-600 hover:bg-white">取消</button>
                    <button type="button" disabled={deleting} onClick={() => void confirmDelete(profile)} className="rounded-lg bg-rose-700 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-rose-800 disabled:opacity-50">确认删除</button>
                  </div>
                </div>
              ) : editingId === profile.id ? (
                <form key={profile.id} onSubmit={(event) => void handleSaveBinding(event, profile)} className="space-y-2 rounded-lg bg-stone-50 px-2.5 py-2">
                  <label htmlFor="edit-profile-name" className="block text-xs font-medium text-stone-700">文库名称</label>
                  <input
                    id="edit-profile-name"
                    autoFocus
                    value={editName}
                    maxLength={48}
                    onChange={(event) => setEditName(event.target.value)}
                    className="h-9 w-full rounded-lg border border-stone-300 bg-white px-2.5 text-sm text-stone-900 outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200"
                  />
                  <label htmlFor="edit-profile-handle" className="block text-xs font-medium text-stone-700">绑定 X 用户名（可选）</label>
                  <input
                    id="edit-profile-handle"
                    autoFocus
                    value={editHandle}
                    onChange={(event) => setEditHandle(event.target.value)}
                    placeholder="@sample_name"
                    autoComplete="off"
                    spellCheck={false}
                    className="h-9 w-full rounded-lg border border-stone-300 bg-white px-2.5 text-sm text-stone-900 outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200"
                  />
                  <p className="text-[11px] leading-4 text-stone-500">改名只改显示。用户名留空则解除绑定，里面的内容不动。</p>
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setEditingId(null)} className="rounded-lg px-2.5 py-1.5 text-xs text-stone-600 hover:bg-stone-100">取消</button>
                    <button type="submit" disabled={savingBinding} className="rounded-lg bg-stone-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-stone-800 disabled:opacity-50">保存</button>
                  </div>
                </form>
              ) : (
                <div key={profile.id} className="flex items-center gap-1 rounded-lg pr-1 hover:bg-stone-100">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={profile.id === activeProfileId}
                    onClick={() => void handleSwitchProfile(profile.id)}
                    className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-stone-900"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{profile.name}</span>
                      <span className="block truncate text-xs text-stone-500">
                        {profile.xHandle ? `@${profile.xHandle}` : profile.bindingConflict ? '账号绑定冲突' : '未绑定 X 账号'}
                      </span>
                    </span>
                    {profile.id === activeProfileId && <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-[#315846]" />}
                  </button>
                  <button
                    type="button"
                    aria-label={`修改「${profile.name}」`}
                    onClick={() => beginEdit(profile)}
                    className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-stone-600 hover:bg-white hover:text-stone-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-stone-900"
                  >
                    修改
                  </button>
                  {profile.id !== activeProfileId && (
                    <button
                      type="button"
                      aria-label={`删除「${profile.name}」`}
                      onClick={() => beginDelete(profile)}
                      className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-rose-700 hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-stone-900"
                    >
                      删除
                    </button>
                  )}
                </div>
              )
            ))}
          </div>
          <div className="my-1.5 border-t border-stone-200" />
          {creatingProfile ? (
            <form onSubmit={(event) => void handleCreateProfile(event)} className="space-y-2 px-1">
              <label htmlFor="new-profile-name" className="block text-xs font-medium text-stone-700">文库名称</label>
              <input
                id="new-profile-name"
                autoFocus
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                maxLength={48}
                placeholder="例如：研究资料"
                className="h-9 w-full rounded-lg border border-stone-300 bg-white px-2.5 text-sm text-stone-900 outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200"
              />
              <label htmlFor="new-profile-handle" className="block text-xs font-medium text-stone-700">绑定 X 用户名（可选）</label>
              <input
                id="new-profile-handle"
                value={profileHandle}
                onChange={(event) => setProfileHandle(event.target.value)}
                placeholder="@sample_name"
                autoComplete="off"
                spellCheck={false}
                className="h-9 w-full rounded-lg border border-stone-300 bg-white px-2.5 text-sm text-stone-900 outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200"
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setCreatingProfile(false)} className="rounded-lg px-2.5 py-1.5 text-xs text-stone-600 hover:bg-stone-100">取消</button>
                <button type="submit" className="rounded-lg bg-stone-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-stone-800">创建文库</button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setEditingId(null); setConfirmingDeleteId(null); setProfileName(''); setProfileHandle(''); setProfileError(''); setCreatingProfile(true); }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-stone-700 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-stone-900"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              <span>新建用户文库</span>
            </button>
          )}
          {profileError && <p role="alert" className="mt-2 px-2 text-xs leading-5 text-rose-700">{profileError}</p>}
        </div>
      )}
    </div>
  );
};
