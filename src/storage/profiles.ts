import Dexie, { type Table } from 'dexie';
import { DEFAULT_PROFILE_ID, getPageProfileId, profileStorageKey } from './profileScope';
import { deleteProfileDatabase, getProfileDatabase } from './db';
import { FRESH_CAPTURE_MS, LIVE_SYNC_KEY } from '../sync/liveSync';
import { normalizeXHandle } from '../adapters/xAccount';
export { DEFAULT_PROFILE_ID, getPageProfileId, profileStorageKey };

export interface LocalProfile {
  id: string;
  name: string;
  xHandle?: string;
  bindingConflict?: true;
}
const DEFAULT_PROFILE: LocalProfile = { id: DEFAULT_PROFILE_ID, name: '我的文库' };

class ProfileRegistry extends Dexie {
  profiles!: Table<LocalProfile, string>;
  settings!: Table<{ key: string; value: string }, string>;

  constructor() {
    super('LikeMindProfileRegistry');
    this.version(1).stores({ profiles: 'id', settings: 'key' });
    // Resolve ambiguous legacy rows before adding the unique index.
    this.version(2).stores({ profiles: 'id' }).upgrade(async (transaction) => {
      const profiles = transaction.table<LocalProfile, string>('profiles');
      const rows = await profiles.toArray();
      const counts = new Map<string, number>();
      for (const { xHandle } of rows) {
        if (xHandle) counts.set(xHandle, (counts.get(xHandle) ?? 0) + 1);
      }
      const conflicts = rows.filter(({ xHandle }) => xHandle && (counts.get(xHandle) ?? 0) > 1);
      await profiles.bulkPut(conflicts.map(({ id, name }) => ({ id, name, bindingConflict: true })));
    });
    this.version(3).stores({ profiles: 'id, &xHandle' });
  }
}

let registry: ProfileRegistry | undefined;
function getRegistry() {
  return registry ??= new ProfileRegistry();
}

export async function getProfiles(): Promise<LocalProfile[]> {
  const rows = await getRegistry().profiles.toArray();
  return [rows.find((row) => row.id === DEFAULT_PROFILE_ID) ?? DEFAULT_PROFILE, ...rows.filter((row) => row.id !== DEFAULT_PROFILE_ID)];
}

export async function getProfile(id: string): Promise<LocalProfile | undefined> {
  return await getRegistry().profiles.get(id) ?? (id === DEFAULT_PROFILE_ID ? DEFAULT_PROFILE : undefined);
}

function validateName(name: string): string {
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > 48) throw new Error('档案名称需要 1–48 个字符。');
  return cleanName;
}

function resolveHandle(handle: string): string | undefined {
  const xHandle = normalizeXHandle(handle);
  if (handle.trim() && !xHandle) throw new Error('请输入有效的 X 用户名，例如 @sample_name。');
  return xHandle;
}

async function assertHandleFree(xHandle: string | undefined, exceptId?: string): Promise<void> {
  if (!xHandle) return;
  const taken = await getRegistry().profiles.where('xHandle').equals(xHandle).first();
  if (taken && taken.id !== exceptId) throw new Error(`@${xHandle} 已经绑定「${taken.name}」。`);
}

export async function createProfile(name: string, handle = ''): Promise<LocalProfile> {
  const xHandle = resolveHandle(handle);
  const profile: LocalProfile = { id: crypto.randomUUID(), name: validateName(name), ...(xHandle ? { xHandle } : {}) };
  const database = getRegistry();
  await database.transaction('rw', database.profiles, async () => {
    await assertHandleFree(xHandle);
    await database.profiles.add(profile);
  });
  return profile;
}

export async function updateProfile(id: string, name: string, handle: string): Promise<void> {
  const cleanName = validateName(name);
  const xHandle = resolveHandle(handle);
  const database = getRegistry();
  await database.transaction('rw', database.profiles, async () => {
    if (!await getProfile(id)) throw new Error('找不到该档案。');
    await assertHandleFree(xHandle, id);
    await database.profiles.put({ id, name: cleanName, xHandle });
  });
}

export interface XLibraryMatch {
  handle?: string;
  profileId: string | null;
  profileName: string;
  kind: 'matched' | 'unbound' | 'missing' | 'unknown';
}

/** Pick the library that belongs to the signed-in X account. Never fall through to another bound account. */
export async function matchLibraryForXHandle(handle: string | undefined, pageProfileId = getPageProfileId()): Promise<XLibraryMatch> {
  const profiles = await getProfiles();
  const page: LocalProfile = profiles.find((profile) => profile.id === pageProfileId) ?? {
    id: pageProfileId,
    name: pageProfileId === DEFAULT_PROFILE_ID ? '我的文库' : '用户文库',
  };
  const normalized = handle ? normalizeXHandle(handle) : undefined;
  if (!normalized) return { profileId: page.id, profileName: page.name, kind: 'unknown' };
  const matched = profiles.find((profile) => profile.xHandle === normalized);
  if (matched) return { handle: normalized, profileId: matched.id, profileName: matched.name, kind: 'matched' };
  if (!page.xHandle) return { handle: normalized, profileId: page.id, profileName: page.name, kind: 'unbound' };
  return { handle: normalized, profileId: null, profileName: page.name, kind: 'missing' };
}

async function forgetScopedStorage(id: string): Promise<void> {
  if (id === DEFAULT_PROFILE_ID) return;
  const storage = chrome?.storage?.local;
  if (!storage?.get || !storage.remove) return;
  const all = await storage.get(null);
  const suffix = `:${id}`;
  const keys = Object.keys(all).filter((key) => key.endsWith(suffix));
  if (keys.length) await storage.remove(keys);
}

const RUNNING_CAPTURE_DELETE = '这份文库正在采集，结束后再删除。';
const PAUSED_CAPTURE_DELETE = '这份文库的采集已暂停，先结束或继续完成这次采集，再删除。';

function isFreshCapture(iso: string | undefined, now: number): boolean {
  const time = Date.parse(iso ?? '');
  return Number.isFinite(time) && now - time < FRESH_CAPTURE_MS;
}

/** A paused capture stays until the user ends or resumes it. A running one only blocks while its checkpoint is fresh. */
function captureDeleteError(status: string | undefined, iso: string | undefined, now: number): string | null {
  if (status === 'paused') return PAUSED_CAPTURE_DELETE;
  if (status === 'running' && isFreshCapture(iso, now)) return RUNNING_CAPTURE_DELETE;
  return null;
}

async function assertCaptureIdle(id: string): Promise<void> {
  const now = Date.now();
  const storage = chrome?.storage?.local;
  if (storage?.get) {
    const liveKey = profileStorageKey(LIVE_SYNC_KEY, id);
    const stored = await storage.get(liveKey);
    const live = stored[liveKey] as { status?: string; updatedAt?: string } | undefined;
    const liveError = captureDeleteError(live?.status, live?.updatedAt, now);
    if (liveError) throw new Error(liveError);
  }
  const runs = await getProfileDatabase(id).syncRuns.where('status').anyOf('running', 'paused').toArray();
  for (const run of runs) {
    const runError = captureDeleteError(run.status, run.lastCheckpointAt || run.startedAt, now);
    if (runError) throw new Error(runError);
  }
}

export async function deleteProfile(id: string): Promise<void> {
  if (id === getPageProfileId()) throw new Error('正在使用的文库不能删除。');
  const registry = getRegistry();
  const row = await registry.profiles.get(id);
  if (!row && id !== DEFAULT_PROFILE_ID) throw new Error('找不到该文库。');
  await assertCaptureIdle(id);
  await deleteProfileDatabase(id);
  await forgetScopedStorage(id);
  await registry.profiles.delete(id);
  const active = await registry.settings.get('active');
  if (active?.value === id) await registry.settings.put({ key: 'active', value: getPageProfileId() });
}

export async function switchProfile(id: string): Promise<void> {
  if (!await getProfile(id)) throw new Error('找不到该档案。');
  await getRegistry().settings.put({ key: 'active', value: id });
}

export async function prepareProfilePage(): Promise<void> {
  const url = new URL(location.href);
  const requested = url.searchParams.get('profile');
  const active = requested ?? (await getRegistry().settings.get('active'))?.value ?? DEFAULT_PROFILE_ID;
  const profile = await getProfile(active);
  url.searchParams.set('profile', profile?.id ?? DEFAULT_PROFILE_ID);
  history.replaceState(null, '', url);
}
