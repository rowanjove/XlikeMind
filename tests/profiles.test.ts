import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { db, getProfileDatabase } from '../src/storage/db';
import { createProfile, DEFAULT_PROFILE_ID, deleteProfile, getProfile, getProfiles, matchLibraryForXHandle, prepareProfilePage, profileStorageKey, switchProfile, updateProfile } from '../src/storage/profiles';
import { LIVE_SYNC_KEY } from '../src/sync/liveSync';

describe('local profile storage', () => {
  it('keeps all legacy libraries and requires a new binding for each conflicting account', async () => {
    const legacy = new Dexie('LikeMindProfileRegistry');
    legacy.version(1).stores({ profiles: 'id', settings: 'key' });
    await legacy.table('profiles').bulkAdd([
      { id: 'legacy-alpha', name: '旧文库甲', xHandle: 'legacy_dupe' },
      { id: 'legacy-beta', name: '旧文库乙', xHandle: 'legacy_dupe' },
      { id: 'legacy-other', name: '旧文库丙', xHandle: 'legacy_unique' },
    ]);
    const library = getProfileDatabase('legacy-alpha');
    await library.userOverrides.put({ postId: 'x:legacy', notes: '保留笔记', updatedAt: 'now', readingStatus: 'to_read' });
    legacy.close();
    expect(await getProfile('legacy-alpha')).toEqual({ id: 'legacy-alpha', name: '旧文库甲', bindingConflict: true });
    expect(await getProfile('legacy-beta')).toEqual({ id: 'legacy-beta', name: '旧文库乙', bindingConflict: true });
    expect(await getProfile('legacy-other')).toMatchObject({ xHandle: 'legacy_unique' });
    expect(await library.userOverrides.get('x:legacy')).toMatchObject({ notes: '保留笔记' });
    await updateProfile('legacy-alpha', '旧文库甲', 'legacy_dupe');
    expect(await getProfile('legacy-alpha')).toEqual({ id: 'legacy-alpha', name: '旧文库甲', xHandle: 'legacy_dupe' });
  });

  it('serializes competing creates and updates for the same normalized handle', async () => {
    const results = await Promise.allSettled([
      createProfile('并发创建甲', 'Race_Create'),
      createProfile('并发创建乙', '@race_create'),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect((await getProfiles()).filter(({ xHandle }) => xHandle === 'race_create')).toHaveLength(1);

    const first = await createProfile('并发修改甲', 'race_previous_a');
    const second = await createProfile('并发修改乙', 'race_previous_b');
    const updates = await Promise.allSettled([
      updateProfile(first.id, '并发修改甲', 'Race_Update'),
      updateProfile(second.id, '并发修改乙', '@race_update'),
    ]);
    expect(updates.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const handles = [(await getProfile(first.id))?.xHandle, (await getProfile(second.id))?.xHandle];
    expect(handles).toContain('race_update');
    expect(handles).toContain(updates[0].status === 'rejected' ? 'race_previous_a' : 'race_previous_b');
  });

  it('keeps the legacy database and isolates the same key in a new profile', async () => {
    expect(getProfileDatabase(DEFAULT_PROFILE_ID)).toBe(db);
    expect(db.name).toBe('LikeMindDatabase');
    const profile = await createProfile(' 工作文库 ');
    const second = getProfileDatabase(profile.id);
    expect(await getProfile(profile.id)).toMatchObject({ name: '工作文库' });
    const postId = 'x:profiles-test';
    try {
      await db.userOverrides.put({ postId, notes: '默认档案', updatedAt: 'now', readingStatus: 'to_read' });
      expect(await second.userOverrides.get(postId)).toBeUndefined();
      await second.userOverrides.put({ postId, notes: '工作档案', updatedAt: 'now', readingStatus: 'to_read' });
      expect((await db.userOverrides.get(postId))?.notes).toBe('默认档案');
      expect((await second.userOverrides.get(postId))?.notes).toBe('工作档案');
      expect(profileStorageKey('ai_config')).toBe('ai_config');
      expect(profileStorageKey('ai_config', profile.id)).not.toBe('ai_config');
    } finally {
      await db.userOverrides.delete(postId);
      await second.delete();
    }
  });

  it('opens new pages in the active profile while preserving an explicitly pinned page', async () => {
    const initial = window.location.href;
    const profile = await createProfile('第二档案');
    try {
      await switchProfile(profile.id);
      history.replaceState(null, '', '/#library');
      await prepareProfilePage();
      expect(new URL(location.href).searchParams.get('profile')).toBe(profile.id);
      expect(location.hash).toBe('#library');

      history.replaceState(null, '', '/?profile=default#settings');
      await prepareProfilePage();
      expect(new URL(location.href).searchParams.get('profile')).toBe(DEFAULT_PROFILE_ID);
      expect(location.hash).toBe('#settings');
    } finally {
      await switchProfile(DEFAULT_PROFILE_ID);
      history.replaceState(null, '', initial);
    }
  });

  it('binds one X account to one library and does not fall through to another account', async () => {
    const first = await createProfile('甲');
    const second = await createProfile('乙');
    await updateProfile(first.id, '甲', '@alpha_user');
    await expect(updateProfile(second.id, '乙', '@Alpha_User')).rejects.toThrow(/已经绑定/);
    await expect(matchLibraryForXHandle('alpha_user', DEFAULT_PROFILE_ID)).resolves.toMatchObject({
      kind: 'matched',
      profileId: first.id,
      profileName: '甲',
    });
    await expect(matchLibraryForXHandle('@beta_name', first.id)).resolves.toMatchObject({
      kind: 'missing',
      profileId: null,
    });
    await expect(matchLibraryForXHandle('beta_name', DEFAULT_PROFILE_ID)).resolves.toMatchObject({
      kind: 'unbound',
      profileId: DEFAULT_PROFILE_ID,
      profileName: '我的文库',
    });
    await expect(matchLibraryForXHandle(undefined, second.id)).resolves.toMatchObject({
      kind: 'unknown',
      profileId: second.id,
      profileName: '乙',
    });
  });

  it('binds a username while creating and leaves no library when the username is taken', async () => {
    const profile = await createProfile('研究资料', ' @Gamma_User ');
    expect(await getProfile(profile.id)).toMatchObject({ name: '研究资料', xHandle: 'gamma_user' });
    const count = (await getProfiles()).length;
    await expect(createProfile('另一份', '@gamma_user')).rejects.toThrow(/已经绑定「研究资料」/);
    await expect(createProfile('坏用户名', 'not a handle')).rejects.toThrow(/有效的 X 用户名/);
    expect((await getProfiles()).length).toBe(count);
    const plain = await createProfile('不绑定', '   ');
    expect((await getProfile(plain.id))?.xHandle).toBeUndefined();
  });

  it('deletes an unused library and refuses the one open on this page', async () => {
    const initial = window.location.href;
    const profile = await createProfile('可删文库', '@delete_me');
    const database = getProfileDatabase(profile.id);
    await database.userOverrides.put({ postId: 'x:delete-me', notes: '会去掉', updatedAt: 'now', readingStatus: 'to_read' });
    try {
      await switchProfile(profile.id);
      await expect(deleteProfile(DEFAULT_PROFILE_ID)).rejects.toThrow(/正在使用/);
      expect(await database.userOverrides.get('x:delete-me')).toMatchObject({ notes: '会去掉' });
      await deleteProfile(profile.id);
      expect(await getProfile(profile.id)).toBeUndefined();
      expect(await getProfileDatabase(profile.id).userOverrides.get('x:delete-me')).toBeUndefined();
      history.replaceState(null, '', '/#library');
      await prepareProfilePage();
      expect(new URL(location.href).searchParams.get('profile')).toBe(DEFAULT_PROFILE_ID);
    } finally {
      await switchProfile(DEFAULT_PROFILE_ID);
      history.replaceState(null, '', initial);
      if (await getProfile(profile.id)) await deleteProfile(profile.id);
    }
  });

  it('keeps a library whose capture is still running', async () => {
    const profile = await createProfile('采集中文库');
    const database = getProfileDatabase(profile.id);
    const run = {
      id: 'run-active',
      startedAt: new Date().toISOString(),
      lastCheckpointAt: new Date().toISOString(),
      status: 'running' as const,
      stats: { scanned: 1, added: 1, updated: 0, skipped: 0, failed: 0 },
      targetLimit: 20,
      downloadMedia: true,
      adapterType: 'x_dom' as const,
    };
    await database.syncRuns.put(run);
    try {
      await expect(deleteProfile(profile.id)).rejects.toThrow(/正在采集/);
      expect(await getProfile(profile.id)).toMatchObject({ name: '采集中文库' });
      expect(await database.syncRuns.get(run.id)).toMatchObject({ status: 'running' });

      await database.syncRuns.update(run.id, { lastCheckpointAt: new Date(Date.now() - 120_000).toISOString() });
      await deleteProfile(profile.id);
      expect(await getProfile(profile.id)).toBeUndefined();
    } finally {
      if (await getProfile(profile.id)) await deleteProfile(profile.id);
    }
  });

  it('keeps a library whose capture is paused', async () => {
    const profile = await createProfile('暂停文库');
    const database = getProfileDatabase(profile.id);
    const run = {
      id: 'run-paused',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      lastCheckpointAt: new Date(Date.now() - 3_600_000).toISOString(),
      status: 'paused' as const,
      stats: { scanned: 2, added: 2, updated: 0, skipped: 0, failed: 0 },
      targetLimit: 20,
      downloadMedia: true,
      adapterType: 'x_dom' as const,
    };
    await database.syncRuns.put(run);
    try {
      await expect(deleteProfile(profile.id)).rejects.toThrow(/已暂停/);
      expect(await getProfile(profile.id)).toMatchObject({ name: '暂停文库' });
      expect(await database.syncRuns.get(run.id)).toMatchObject({ status: 'paused' });

      await database.syncRuns.update(run.id, { status: 'cancelled' });
      await deleteProfile(profile.id);
      expect(await getProfile(profile.id)).toBeUndefined();
    } finally {
      if (await getProfile(profile.id)) {
        await database.syncRuns.update(run.id, { status: 'cancelled' });
        await deleteProfile(profile.id);
      }
    }
  });

  it('keeps a library while another window shows its capture as paused', async () => {
    const profile = await createProfile('窗口暂停');
    const key = profileStorageKey(LIVE_SYNC_KEY, profile.id);
    await chrome.storage.local.set({
      [key]: { status: 'paused', updatedAt: new Date(Date.now() - 3_600_000).toISOString() },
    });
    try {
      await expect(deleteProfile(profile.id)).rejects.toThrow(/已暂停/);
      expect(await getProfile(profile.id)).toMatchObject({ name: '窗口暂停' });
    } finally {
      await chrome.storage.local.set({ [key]: { status: 'completed', updatedAt: new Date().toISOString() } });
      if (await getProfile(profile.id)) await deleteProfile(profile.id);
    }
  });

  it('keeps a library while another window is publishing its capture progress', async () => {
    const profile = await createProfile('窗口采集');
    const key = profileStorageKey(LIVE_SYNC_KEY, profile.id);
    await chrome.storage.local.set({
      [key]: { status: 'running', updatedAt: new Date().toISOString() },
    });
    try {
      await expect(deleteProfile(profile.id)).rejects.toThrow(/正在采集/);
      expect(await getProfile(profile.id)).toMatchObject({ name: '窗口采集' });
    } finally {
      await chrome.storage.local.set({ [key]: { status: 'completed', updatedAt: new Date().toISOString() } });
      if (await getProfile(profile.id)) await deleteProfile(profile.id);
    }
  });
});
