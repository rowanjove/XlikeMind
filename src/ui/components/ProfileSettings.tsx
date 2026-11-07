import { useEffect, useState } from 'react';
import { getPageProfileId, getProfile, updateProfile } from '../../storage/profiles';

export function ProfileSettings({ busy = false }: { busy?: boolean }) {
  const id = getPageProfileId();
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    void getProfile(id).then((profile) => {
      if (!active || !profile) return;
      setName(profile.name);
      setHandle(profile.xHandle ? `@${profile.xHandle}` : '');
      if (profile.bindingConflict) setMessage('旧账号同时绑定了多个文库。请确认此文库的用户名并保存后再同步。');
      setReady(true);
    }).catch(() => { if (active) setMessage('无法读取档案设置。'); });
    return () => { active = false; };
  }, [id]);

  const save = async () => {
    setSaving(true);
    setMessage('');
    try {
      await updateProfile(id, name, handle);
      setMessage('档案设置已保存。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存档案设置失败。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}
      className="space-y-4 rounded-xl border border-stone-300 bg-white p-5">
      <div><h2 className="font-semibold">当前档案</h2>
        <p className="mt-1 text-sm text-stone-600">改名后仍使用原有资料和保存目录。绑定用户名后，同步前会核对当前登录账号。</p></div>
      <fieldset disabled={!ready || saving || busy} className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">档案名称<input required maxLength={48} value={name} onChange={(e) => setName(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2" /></label>
        <label className="text-sm">绑定 X 用户名（可选）<input value={handle} onChange={(e) => setHandle(e.target.value)}
          placeholder="@sample_name" autoComplete="off" spellCheck={false}
          className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2" /></label>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={!ready || saving || busy} className="rounded-lg border border-stone-300 px-3 py-2 text-sm disabled:opacity-50">保存档案</button>
        <span role="status" className="text-sm text-stone-600">{busy ? '同步期间可在任务结束后修改。' : message}</span>
      </div>
    </form>
  );
}
