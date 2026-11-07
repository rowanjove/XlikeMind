import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfileSwitcher } from '../src/ui/components/ProfileSwitcher';
import { createProfile, DEFAULT_PROFILE_ID, deleteProfile, getProfile, getProfiles, profileStorageKey, updateProfile } from '../src/storage/profiles';
import { LIVE_SYNC_KEY } from '../src/sync/liveSync';

describe('ProfileSwitcher create form', () => {
  it('shows the bound username on the switcher button', async () => {
    await updateProfile(DEFAULT_PROFILE_ID, '我的文库', '@button_user');
    try {
      render(<ProfileSwitcher />);
      const button = screen.getByRole('button', { name: '切换用户文库' });
      expect(await screen.findByText('@button_user')).toBeTruthy();
      expect(button.textContent).toContain('我的文库');
      expect(button.textContent).toContain('@button_user');
    } finally {
      await updateProfile(DEFAULT_PROFILE_ID, '我的文库', '');
    }
  });

  it('shows that the current library has no X username', () => {
    render(<ProfileSwitcher />);
    const button = screen.getByRole('button', { name: '切换用户文库' });
    expect(button.textContent).toContain('未绑定');
  });

  it('creates a library bound to the entered X username', async () => {
    const assign = vi.fn();
    const current = window.location.href;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: current, assign },
    });
    render(<ProfileSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: '切换用户文库' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '新建用户文库' }));
    fireEvent.change(screen.getByLabelText('文库名称'), { target: { value: '研究资料' } });
    fireEvent.change(screen.getByLabelText('绑定 X 用户名（可选）'), { target: { value: '@delta_user' } });
    fireEvent.click(screen.getByRole('button', { name: '创建文库' }));

    await waitFor(() => expect(assign).toHaveBeenCalled());
    const created = (await getProfiles()).find((profile) => profile.name === '研究资料');
    expect(created?.xHandle).toBe('delta_user');
    expect(String(assign.mock.calls[0]?.[0])).toContain(`profile=${created?.id}`);
  });

  it('keeps the form open when the username is already bound', async () => {
    await createProfile('已占用', '@delta_taken');
    render(<ProfileSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: '切换用户文库' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '新建用户文库' }));
    fireEvent.change(screen.getByLabelText('文库名称'), { target: { value: '重复文库' } });
    fireEvent.change(screen.getByLabelText('绑定 X 用户名（可选）'), { target: { value: 'Delta_Taken' } });
    fireEvent.click(screen.getByRole('button', { name: '创建文库' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/已经绑定「已占用」/);
    expect((await getProfiles()).some((profile) => profile.name === '重复文库')).toBe(false);
  });

  it('changes a bound username in the menu and stays on the same library', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: window.location.href, assign },
    });
    const profile = await createProfile('绑定试验', '@edit_old');
    render(<ProfileSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: '切换用户文库' }));
    fireEvent.click(await screen.findByRole('button', { name: '修改「绑定试验」' }));
    const input = screen.getByLabelText('绑定 X 用户名（可选）') as HTMLInputElement;
    expect(input.value).toBe('@edit_old');
    fireEvent.change(input, { target: { value: '@Edit_New' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('@edit_new')).toBeTruthy();
    expect((await getProfile(profile.id))?.xHandle).toBe('edit_new');
    expect((await getProfile(profile.id))?.name).toBe('绑定试验');
    expect(assign).not.toHaveBeenCalled();
  });

  it('keeps the previous username when the new one is already bound', async () => {
    await createProfile('占用库', '@edit_taken');
    const profile = await createProfile('待改库', '@edit_keep');
    render(<ProfileSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: '切换用户文库' }));
    fireEvent.click(await screen.findByRole('button', { name: '修改「待改库」' }));
    fireEvent.change(screen.getByLabelText('绑定 X 用户名（可选）'), { target: { value: 'edit_taken' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/已经绑定「占用库」/);
    expect((await getProfile(profile.id))?.xHandle).toBe('edit_keep');
    expect(screen.getByLabelText('绑定 X 用户名（可选）')).toBeTruthy();
  });

  it('clears the binding when the username is emptied', async () => {
    const profile = await createProfile('可解绑', '@edit_clear');
    render(<ProfileSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: '切换用户文库' }));
    fireEvent.click(await screen.findByRole('button', { name: '修改「可解绑」' }));
    fireEvent.change(screen.getByLabelText('绑定 X 用户名（可选）'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      expect((await getProfile(profile.id))?.xHandle).toBeUndefined();
    });
    expect(screen.queryByText('@edit_clear')).toBeNull();
  });

  it('renames the current library from the menu and stays on it', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: window.location.href, assign },
    });
    await updateProfile(DEFAULT_PROFILE_ID, '我的文库', '@rename_keep');
    try {
      render(<ProfileSwitcher />);
      fireEvent.click(screen.getByRole('button', { name: '切换用户文库' }));
      fireEvent.click(await screen.findByRole('button', { name: '修改「我的文库」' }));
      const name = screen.getByLabelText('文库名称') as HTMLInputElement;
      expect(name.value).toBe('我的文库');
      fireEvent.change(name, { target: { value: '  阅读资料  ' } });
      fireEvent.click(screen.getByRole('button', { name: '保存' }));

      await waitFor(async () => {
        expect((await getProfile(DEFAULT_PROFILE_ID))?.name).toBe('阅读资料');
        expect(screen.getByRole('button', { name: '切换用户文库' }).textContent).toContain('阅读资料');
      });
      expect((await getProfile(DEFAULT_PROFILE_ID))?.xHandle).toBe('rename_keep');
      expect(assign).not.toHaveBeenCalled();
    } finally {
      await updateProfile(DEFAULT_PROFILE_ID, '我的文库', '');
    }
  });

  it('keeps the previous name when the new name is empty', async () => {
    await updateProfile(DEFAULT_PROFILE_ID, '我的文库', '');
    render(<ProfileSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: '切换用户文库' }));
    fireEvent.click(await screen.findByRole('button', { name: '修改「我的文库」' }));
    fireEvent.change(screen.getByLabelText('文库名称'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/1–48/);
    expect((await getProfile(DEFAULT_PROFILE_ID))?.name).toBe('我的文库');
    expect(screen.getByLabelText('文库名称')).toBeTruthy();
  });

  it('asks before deleting an unused library and keeps the open one', async () => {
    const profile = await createProfile('菜单可删');
    render(<ProfileSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: '切换用户文库' }));

    expect(screen.queryByRole('button', { name: '删除「我的文库」' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: '删除「菜单可删」' }));
    expect(await screen.findByText(/帖子、笔记和目录绑定会去掉/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(await getProfile(profile.id)).toMatchObject({ name: '菜单可删' });

    fireEvent.click(screen.getByRole('button', { name: '删除「菜单可删」' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(async () => {
      expect(await getProfile(profile.id)).toBeUndefined();
    });
    expect(screen.queryByRole('button', { name: '删除「菜单可删」' })).toBeNull();
    expect(screen.getByRole('button', { name: '切换用户文库' }).textContent).toContain('我的文库');
  });

  it('explains and keeps the library when its capture is paused', async () => {
    const profile = await createProfile('菜单已暂停');
    const key = profileStorageKey(LIVE_SYNC_KEY, profile.id);
    await chrome.storage.local.set({
      [key]: { status: 'paused', updatedAt: new Date(Date.now() - 3_600_000).toISOString() },
    });
    try {
      render(<ProfileSwitcher />);
      fireEvent.click(screen.getByRole('button', { name: '切换用户文库' }));
      fireEvent.click(await screen.findByRole('button', { name: '删除「菜单已暂停」' }));
      fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

      expect((await screen.findByRole('alert')).textContent).toMatch(/已暂停/);
      expect(screen.getByRole('alert').textContent).toMatch(/结束或继续完成/);
      expect(await getProfile(profile.id)).toMatchObject({ name: '菜单已暂停' });
      expect(screen.getByRole('button', { name: '确认删除' })).toBeTruthy();
    } finally {
      await chrome.storage.local.set({ [key]: { status: 'completed', updatedAt: new Date().toISOString() } });
      if (await getProfile(profile.id)) await deleteProfile(profile.id);
    }
  });

  it('explains and keeps the library when its capture is still running', async () => {
    const profile = await createProfile('菜单采集中');
    const key = profileStorageKey(LIVE_SYNC_KEY, profile.id);
    await chrome.storage.local.set({
      [key]: { status: 'running', updatedAt: new Date().toISOString() },
    });
    try {
      render(<ProfileSwitcher />);
      fireEvent.click(screen.getByRole('button', { name: '切换用户文库' }));
      fireEvent.click(await screen.findByRole('button', { name: '删除「菜单采集中」' }));
      fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

      expect((await screen.findByRole('alert')).textContent).toMatch(/正在采集/);
      expect(await getProfile(profile.id)).toMatchObject({ name: '菜单采集中' });
      expect(screen.getByRole('button', { name: '确认删除' })).toBeTruthy();
    } finally {
      await chrome.storage.local.set({ [key]: { status: 'completed', updatedAt: new Date().toISOString() } });
      if (await getProfile(profile.id)) await deleteProfile(profile.id);
    }
  });
});
