import { useEffect, useState } from 'react';
import { getCompletionBehavior, saveCompletionBehavior, type CompletionBehavior } from '../../storage/capturePreferences';
import { getPageProfileId } from '../../storage/profileScope';

export function CompletionSettings({ profileId = getPageProfileId() }: { profileId?: string }) {
  const [value, setValue] = useState<CompletionBehavior>();
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    setValue(undefined);
    void getCompletionBehavior(profileId).then((next) => { if (active) setValue(next); })
      .catch(() => { if (active) setMessage('无法读取完成后操作，请重新打开设置。'); });
    return () => { active = false; };
  }, [profileId]);
  return <div className="space-y-2 rounded-xl border border-stone-200 bg-white p-4">
    <label className="grid gap-2 text-sm font-medium">
      同步结束后
      <select value={value ?? 'notice'} disabled={value === undefined || saving} className="lm-control px-2 py-2"
        onChange={async (event) => {
          const next = event.target.value as CompletionBehavior;
          setSaving(true);
          setMessage('');
          try {
            await saveCompletionBehavior(next, profileId);
            setValue(next);
            setMessage('已保存');
          } catch { setMessage('保存失败，请重试。'); }
          finally { setSaving(false); }
        }}>
        <option value="notice">在 X 页面显示结果提示</option>
        <option value="library">打开当前文库</option>
        <option value="none">留在当前页面，不提示</option>
      </select>
    </label>
    <p className="text-xs leading-5 text-stone-600">适用于从 X 页面采集。暂停或主动停止时保持当前页面；达到上限也会显示本次结果。</p>
    {message && <p role="status" className="text-xs text-stone-600">{message}</p>}
  </div>;
}
