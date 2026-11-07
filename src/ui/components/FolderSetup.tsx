import type { ReactNode } from 'react';
import { FolderOpen } from 'lucide-react';

interface FolderSetupProps {
  folderName?: string;
  managedName?: string;
  ready?: boolean;
  message: string;
  busy: boolean;
  supported: boolean;
  onChoose: () => void;
  actions?: ReactNode;
}

export function FolderSetup({ folderName, managedName, ready, message, busy, supported, onChoose, actions }: FolderSetupProps) {
  return (
    <section className="overflow-hidden rounded-xl border border-stone-300 bg-[#fffefa]">
      <div className="border-b border-stone-200 px-6 py-5">
        <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-emerald-900">
          <FolderOpen className="size-4" aria-hidden="true" /> 保存位置
        </div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">{folderName || '选择本地文库文件夹'}</h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-stone-600">
          同步结束后，帖子和图片会写入绑定的目录。用浏览器打开文库入口，就能在扩展外搜索和阅读。
          {folderName && '「检查授权与入口」只检查现有文件，不重新写入归档。'}
        </p>
      </div>
      <div className="space-y-3 px-6 py-5">
        {folderName && managedName && (
          <p className="break-all text-sm text-stone-700">
            {ready ? '文库入口' : '写入后的入口'} <code className="rounded bg-stone-100 px-2 py-1">{folderName}/{managedName}/index.html</code>
          </p>
        )}
        {!supported && <p className="text-sm text-stone-700">当前浏览器无法选择目录。可以在设置中下载 ZIP。</p>}
        {message && <p role="status" className="text-sm text-stone-700">{message}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy || !supported} onClick={onChoose}
            className="rounded-lg bg-emerald-950 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-900 disabled:opacity-50">
            {folderName ? '更换文件夹' : '选择文件夹'}
          </button>
          {actions}
        </div>
      </div>
    </section>
  );
}
