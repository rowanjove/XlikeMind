import { getCompletionBehavior } from '../storage/capturePreferences';
import type { SyncStats } from '../domain/types';

export async function completeCapture(profileId: string, status: string, stats: SyncStats): Promise<void> {
  const behavior = await getCompletionBehavior(profileId).catch(() => 'notice');
  if (behavior === 'none') return;
  const openLibrary = () => chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', profileId, view: 'library' });
  if (behavior === 'library') {
    await openLibrary();
    return;
  }
  document.getElementById('likemind-completion-notice')?.remove();
  const host = document.createElement('div');
  host.id = 'likemind-completion-notice';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = ':host{all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;font:14px/1.6 system-ui;color:#183247}section{width:300px;max-width:80vw;padding:18px;border:1px solid #cad8e5;border-radius:14px;background:white;box-shadow:0 8px 32px #0003}p{margin:8px 0}button{font:inherit;padding:6px 12px;border:1px solid #cad8e5;border-radius:7px;background:#edf4fa;color:#183247;cursor:pointer;margin-right:8px}';
  const panel = document.createElement('section');
  panel.setAttribute('role', 'status');
  const title = document.createElement('strong');
  title.textContent = status === 'completed' ? 'LikeMind · 本次同步完成' : status === 'failed' ? 'LikeMind · 本次采集失败' : 'LikeMind · 本次采集结束（部分完成）';
  const detail = document.createElement('p');
  detail.textContent = `扫描 ${stats.scanned} · 新增 ${stats.added} · 更新 ${stats.updated} · 失败 ${stats.failed}。已采集结果保存在本地。`;
  const open = document.createElement('button');
  open.textContent = '打开文库';
  open.onclick = () => { void openLibrary(); };
  const close = document.createElement('button');
  close.textContent = '关闭';
  close.onclick = () => host.remove();
  panel.append(title, detail, open, close);
  root.append(style, panel);
  document.body.append(host);
}
