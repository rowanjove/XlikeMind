import { describe, expect, it, vi } from 'vitest';
import { handleSyncMessage } from '../src/background/syncChannel';
import { createSyncClient, explainSaveError, type SyncPort } from '../src/messaging/syncClient';
import { db, getProfileDatabase } from '../src/storage/db';
import { createProfile, updateProfile } from '../src/storage/profiles';

describe('sync save channel', () => {
  it('starts a save run and returns its id', async () => {
    const reply = await handleSyncMessage({ type: 'BEGIN_X_SYNC', targetLimit: 12, downloadMedia: false });
    expect(reply?.success).toBe(true);
    expect(reply?.runId).toMatch(/^run_/);
    if (typeof reply?.runId === 'string') await db.syncRuns.delete(reply.runId);
  });

  it('pauses a run and continues that same run', async () => {
    const started = await handleSyncMessage({ type: 'BEGIN_X_SYNC', targetLimit: 12, downloadMedia: false });
    const runId = started?.runId;
    expect(typeof runId).toBe('string');
    if (typeof runId !== 'string') return;
    try {
      const paused = await handleSyncMessage({
        type: 'FINISH_X_SYNC',
        runId,
        hasMore: true,
        terminalStatus: 'partial',
        paused: true,
      });
      expect(paused).toMatchObject({ success: true, status: 'paused' });
      const resumed = await handleSyncMessage({ type: 'BEGIN_X_SYNC', targetLimit: 30, downloadMedia: false });
      expect(resumed).toMatchObject({ success: true, runId });
    } finally {
      await db.syncRuns.delete(runId);
    }
  });

  it('rejects a batch that has no run id', async () => {
    const reply = await handleSyncMessage({ type: 'INGEST_X_BATCH', items: [] });
    expect(reply).toEqual({ success: false, error: '缺少读取任务编号' });
  });

  it('ignores messages owned by another channel', async () => {
    expect(await handleSyncMessage({ type: 'OPEN_DASHBOARD' })).toBeNull();
  });

  it('keeps the same post isolated when two profile channels ingest it', async () => {
    const first = await createProfile('频道一');
    const second = await createProfile('频道二');
    const postId = `profile-isolation-${Date.now()}`;
    const item = {
      postId,
      url: `https://x.com/example/status/${postId}`,
      authorHandle: 'example',
      authorDisplayName: 'Example',
      text: '同一条帖子在不同档案中应各自保存',
    };
    const runIds: string[] = [];
    try {
      for (const profileId of [first.id, second.id]) {
        const started = await handleSyncMessage({ type: 'BEGIN_X_SYNC', profileId, downloadMedia: false }, { tabId: 101 });
        expect(started?.success).toBe(true);
        const runId = started?.runId;
        expect(runId).toEqual(expect.any(String));
        if (typeof runId !== 'string') throw new Error('profile run was not created');
        runIds.push(runId);
        const batch = { type: 'INGEST_X_BATCH', profileId, runId, items: [item] };
        expect(await handleSyncMessage(batch, { tabId: 202 })).toMatchObject({ success: false });
        expect(await handleSyncMessage({ ...batch, profileId: 'default' }, { tabId: 101 })).toMatchObject({ success: false });
        const ingested = await handleSyncMessage(batch, { tabId: 101 });
        expect(ingested).toMatchObject({ success: true, stats: { scanned: 1, added: 1 } });
        const finished = await handleSyncMessage({
          type: 'FINISH_X_SYNC', profileId, runId, hasMore: false, terminalStatus: 'complete',
        }, { tabId: 101 });
        expect(finished).toMatchObject({ success: true, status: 'completed' });
      }

      expect(await getProfileDatabase(first.id).posts.get(`x:${postId}`)).toMatchObject({ postId });
      expect(await getProfileDatabase(second.id).posts.get(`x:${postId}`)).toMatchObject({ postId });
      expect(await db.posts.get(`x:${postId}`)).toBeUndefined();
    } finally {
      await getProfileDatabase(first.id).delete();
      await getProfileDatabase(second.id).delete();
      await Promise.all(runIds.map(async (runId) => {
        await db.syncRuns.delete(runId);
      }));
    }
  });

  it('requires account evidence for a bound profile and rejects changed accounts mid-run', async () => {
    const profile = await createProfile('账号测试');
    await updateProfile(profile.id, profile.name, '@Fixture_User');
    const begin = { type: 'BEGIN_X_SYNC', profileId: profile.id, downloadMedia: false };
    const context = { tabId: 42 };
    expect(await handleSyncMessage(begin, context)).toMatchObject({ success: false, error: expect.stringContaining('无法确认') });
    expect(await handleSyncMessage({ ...begin, xHandle: 'another' }, context)).toMatchObject({ success: false, error: expect.stringContaining('不符') });
    const started = await handleSyncMessage({ ...begin, xHandle: 'FIXTURE_USER' }, context);
    expect(started).toMatchObject({ success: true });
    const batch = { type: 'INGEST_X_BATCH', profileId: profile.id, runId: started?.runId, items: [{ postId: '99001', text: 'sample' }] };
    expect(await handleSyncMessage({ ...batch, xHandle: 'another' }, context)).toMatchObject({ success: false });
    expect(await handleSyncMessage({ ...batch, xHandle: 'fixture_user' }, context)).toMatchObject({ success: true, stats: { added: 1 } });
    await updateProfile(profile.id, '已改名', '');
    expect(await handleSyncMessage(batch, context)).toMatchObject({ success: false });
    expect(await getProfileDatabase(profile.id).posts.count()).toBe(1);
    await getProfileDatabase(profile.id).delete();
  });

  it('rejects a different account or source on resume without moving the paused run', async () => {
    const profile = await createProfile('暂停来源测试', 'pause_alice');
    const begin = { type: 'BEGIN_X_SYNC', profileId: profile.id, source: 'x_likes', downloadMedia: false };
    const oldTab = { tabId: 51 };
    const newTab = { tabId: 52 };
    const started = await handleSyncMessage({ ...begin, xHandle: 'pause_alice' }, oldTab);
    const runId = started?.runId as string;
    const database = getProfileDatabase(profile.id);
    try {
      await handleSyncMessage({
        type: 'FINISH_X_SYNC', profileId: profile.id, runId, terminalStatus: 'partial', paused: true,
      }, oldTab);
      await updateProfile(profile.id, profile.name, 'pause_bob');
      expect(await handleSyncMessage({ ...begin, xHandle: 'pause_bob' }, newTab)).toMatchObject({
        success: false, error: expect.stringContaining('账号'),
      });
      await updateProfile(profile.id, profile.name, 'pause_alice');
      expect(await handleSyncMessage({ ...begin, xHandle: 'pause_alice', source: 'x_bookmarks' }, newTab)).toMatchObject({
        success: false, error: expect.stringContaining('来源'),
      });
      expect(await database.syncRuns.toArray()).toEqual([
        expect.objectContaining({ id: runId, status: 'paused', source: 'x_likes', sourceTabId: 51 }),
      ]);
      expect(await handleSyncMessage({ ...begin, xHandle: 'pause_alice' }, newTab)).toMatchObject({ success: true, runId });
      expect(await database.syncRuns.get(runId)).toMatchObject({ status: 'running', sourceTabId: 52 });
      const batch = { type: 'INGEST_X_BATCH', profileId: profile.id, runId, xHandle: 'pause_alice', items: [{ postId: '122', text: '原来源' }] };
      expect(await handleSyncMessage(batch, oldTab)).toMatchObject({ success: false });
      expect(await handleSyncMessage(batch, newTab)).toMatchObject({ success: true });
      expect(await database.posts.get('x:122')).toMatchObject({ sources: ['x_likes'] });
    } finally {
      await database.delete();
    }
  });
});

describe('sync port client', () => {
  it('reads the run id from the worker reply', async () => {
    let deliver: (message: unknown) => void = () => undefined;
    const port: SyncPort = {
      postMessage(message) {
        const requestId = (message as { requestId: number }).requestId;
        deliver({ requestId, success: true, runId: 'run_port' });
      },
      onMessage: { addListener(listener) { deliver = listener; } },
      onDisconnect: { addListener() { /* idle */ } },
    };
    const client = createSyncClient(() => port, () => undefined);
    const reply = await client.request({ type: 'BEGIN_X_SYNC', targetLimit: 50 });
    expect(reply).toMatchObject({ success: true, runId: 'run_port' });
  });

  it('turns a dropped connection into a readable error', async () => {
    let disconnect: () => void = () => undefined;
    const port: SyncPort = {
      postMessage() { /* worker never replies */ },
      onMessage: { addListener() { /* idle */ } },
      onDisconnect: { addListener(listener) { disconnect = listener; } },
    };
    const client = createSyncClient(() => port, () => 'The message port closed before a response was received.');
    const pending = client.request({ type: 'BEGIN_X_SYNC' });
    disconnect();
    const reply = await pending;
    expect(reply.success).toBe(false);
    expect(reply.error).toContain('连接断了');
  });

  it('explains a missing background page', () => {
    expect(explainSaveError('Could not establish connection. Receiving end does not exist.')).toContain('重新加载');
    expect(explainSaveError('')).toContain('没有开始这次保存');
  });

  it('ignores late replies and disconnects from the replaced port', async () => {
    let oldDisconnect = () => {};
    let oldReply = (_message: unknown) => {};
    let newReply = (_message: unknown) => {};
    let requestId = 0;
    const oldPort: SyncPort = {
      postMessage() { throw new Error('Port disconnected'); },
      onMessage: { addListener(listener) { oldReply = listener; } },
      onDisconnect: { addListener(listener) { oldDisconnect = listener; } },
    };
    const newPort: SyncPort = {
      postMessage(message) { requestId = (message as { requestId: number }).requestId; },
      onMessage: { addListener(listener) { newReply = listener; } },
      onDisconnect: { addListener() {} },
    };
    const client = createSyncClient(vi.fn().mockReturnValueOnce(oldPort).mockReturnValueOnce(newPort), () => undefined);
    const pending = client.request({ type: 'INGEST_X_BATCH' });
    oldReply({ requestId, success: false });
    oldDisconnect();
    newReply({ requestId, success: true, stats: { scanned: 1 } });
    expect(await pending).toMatchObject({ success: true, scanned: 1 });
  });
});
