import { CompletionSettings } from '../components/CompletionSettings';
import React, { useState, useEffect } from 'react';
import { Database, Trash2, KeyRound, Check, RefreshCw, AlertCircle, Loader2, Cpu } from 'lucide-react';
import { db } from '../../storage/db';
import { aiService, DEFAULT_AI_CONFIG, MAX_AI_BATCH_LIMIT, normalizeAIBatchLimit } from '../../ai/aiService';
import { requestApiAccess } from '../../ai/permissions';
import { isLocalEndpoint } from '../../ai/openaiClient';
import type { AIConfig } from '../../domain/types';
import { ProfileSettings } from '../components/ProfileSettings';
import { DEFAULT_LIKES_URL } from '../../adapters/findLikesTab';
import { getLikesEntry, saveLikesEntry } from '../../storage/capturePreferences';

interface SettingsPageProps {
  folderSettings?: React.ReactNode;
  onOpenExport?: () => void;
  canExport?: boolean;
  profileBusy?: boolean;
  onOpenDiagnostics: () => void;
  onDatabaseReset?: () => void;
}

const PRESET_MODELS = [
  {
    name: '本地 Ollama',
    baseUrl: 'http://localhost:11434/v1',
    modelName: 'qwen2.5:7b',
    isLocal: true,
  },
  {
    name: '本地 LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    modelName: 'local-model',
    isLocal: true,
  },
  {
    name: 'OpenAI 兼容云端',
    baseUrl: 'https://api.openai.com/v1',
    modelName: 'gpt-4o-mini',
    isLocal: false,
  },
];

export const SettingsPage: React.FC<SettingsPageProps> = ({
  folderSettings, onOpenExport, canExport, profileBusy,
  onOpenDiagnostics,
  onDatabaseReset,
}) => {
  const [config, setConfig] = useState<AIConfig>(DEFAULT_AI_CONFIG);
  const [configStatus, setConfigStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [savingAiConfig, setSavingAiConfig] = useState(false);
  const [aiSaveError, setAiSaveError] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [dbStats, setDbStats] = useState({ posts: 0, media: 0, runs: 0, ai: 0 });
  const [likesEntry, setLikesEntry] = useState<string>();
  const [entrySaving, setEntrySaving] = useState(false);
  const [entryNotice, setEntryNotice] = useState<{ success: boolean; text: string }>();

  useEffect(() => {
    let active = true;
    void getLikesEntry().then((entry) => { if (active) setLikesEntry(entry); });
    // Load config from aiService
    aiService.getConfig(undefined, { strict: true }).then((cfg) => {
      if (!active) return;
      setConfig(cfg);
      setConfigStatus('ready');
    }).catch(() => {
      if (active) setConfigStatus('failed');
    });

    // Load DB counts
    Promise.all([
      db.posts.count(),
      db.media.count(),
      db.syncRuns.count(),
      db.aiAnalysis.count(),
    ]).then(([posts, media, runs, ai]) => {
      if (!active) return;
      setDbStats({ posts, media, runs, ai });
    });
    return () => {
      active = false;
    };
  }, []);

  const handleSaveAiConfig = async () => {
    if (savingAiConfig || configStatus !== 'ready') return;
    setSavingAiConfig(true);
    setSavedSuccess(false);
    setAiSaveError('');
    try {
      await aiService.saveConfig(config);
      setSavedSuccess(true);
    } catch {
      setAiSaveError('AI 设置未能保存，请重试。');
    } finally {
      setSavingAiConfig(false);
    }
  };

  useEffect(() => {
    if (!savedSuccess) return;
    const timer = window.setTimeout(() => setSavedSuccess(false), 2500);
    return () => window.clearTimeout(timer);
  }, [savedSuccess]);

  const isLocal = isLocalEndpoint(config.baseUrl);

  const handleTestConnection = async () => {
    if (configStatus !== 'ready') return;
    setIsTesting(true);
    setTestResult(null);
    if (!config.useMock) {
      const gate = await requestApiAccess(config.baseUrl);
      if (!gate.ok) {
        setIsTesting(false);
        setTestResult({ success: false, message: gate.message });
        return;
      }
    }
    try {
      const res = await aiService.testConnection({ config });
      setTestResult(res);
    } catch (err) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleApplyPreset = (preset: (typeof PRESET_MODELS)[number]) => {
    setConfig((prev) => ({
      ...prev,
      baseUrl: preset.baseUrl,
      modelName: preset.modelName,
      useMock: false,
    }));
  };

  const handleResetDatabase = async () => {
    if (
      window.confirm(
        '清空这台电脑上的帖子、图片和整理结果？清空后无法恢复。'
      )
    ) {
      await db.posts.clear();
      await db.media.clear();
      await db.syncRuns.clear();
      await db.userOverrides.clear();
      await db.aiAnalysis.clear();
      setDbStats({ posts: 0, media: 0, runs: 0, ai: 0 });
      alert('已经清空。');
      onDatabaseReset?.();
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <header className="border-b border-stone-300 pb-4">
        <h1 className="text-3xl font-semibold tracking-tight">设置</h1>
        <p className="mt-1 text-sm text-stone-600">管理本地文库、导出和整理接口。</p>
      </header>
      {folderSettings}
      <ProfileSettings busy={profileBusy} />
      <CompletionSettings />
      <form className="space-y-3 rounded-xl border border-stone-300 bg-white p-5" onSubmit={async (event) => {
        event.preventDefault();
        if (likesEntry === undefined || entrySaving) return;
        setEntrySaving(true);
        try {
          setLikesEntry(await saveLikesEntry(likesEntry));
          setEntryNotice({ success: true, text: '已保存点赞入口。' });
        } catch (error) {
          setEntryNotice({ success: false, text: error instanceof Error ? error.message : '保存失败，请重试。' });
        } finally {
          setEntrySaving(false);
        }
      }}>
        <div>
          <h2 className="font-semibold">采集入口</h2>
          <p className="mt-1 text-sm text-stone-600">用于弹窗和同步页打开 X 点赞列表。每份文库单独保存。</p>
        </div>
        <label htmlFor="likes-entry" className="block text-sm text-stone-700">点赞页地址</label>
        <div className="flex flex-wrap gap-2">
          <input id="likes-entry" type="url" required disabled={likesEntry === undefined || entrySaving}
            value={likesEntry ?? ''} placeholder={DEFAULT_LIKES_URL}
            onChange={(event) => { setLikesEntry(event.target.value); setEntryNotice(undefined); }}
            className="min-w-52 flex-1 rounded-lg border border-stone-300 px-3 py-2 text-sm" />
          <button type="submit" disabled={likesEntry === undefined || entrySaving}
            className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium disabled:opacity-50">
            {entrySaving ? '正在保存' : '保存入口'}
          </button>
        </div>
        {entryNotice && <p role={entryNotice.success ? 'status' : 'alert'} className="text-sm text-stone-700">{entryNotice.text}</p>}
      </form>
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-stone-300 bg-white p-5">
        <div><h2 className="font-semibold">导出资料</h2><p className="mt-1 text-sm text-stone-600">将当前文库另存为离线 ZIP 或独立目录快照。</p></div>
        <button type="button" disabled={!canExport} onClick={onOpenExport}
          className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium hover:bg-stone-50 disabled:opacity-50">导出文库</button>
      </section>
      {/* AI Settings */}
      <fieldset disabled={configStatus !== 'ready'} aria-label="模型与整理"
        className="space-y-4 rounded-xl border border-stone-200 bg-white p-5">
        {configStatus === 'loading' && <p role="status" className="text-sm text-stone-600">正在读取 AI 设置…</p>}
        {configStatus === 'failed' && <p role="alert" className="text-sm text-rose-700">无法读取 AI 设置，请重新打开设置页后重试。</p>}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-stone-900">模型与整理</h2>
            <p className="mt-1 text-sm text-stone-600">
              可选本地模型或兼容接口。点击整理时，界面会说明发送地址和内容范围。
            </p>
          </div>

          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-stone-200 px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={config.useMock}
              onChange={(e) => setConfig({ ...config, useMock: e.target.checked })}
            />
            <span>离线整理，不连网</span>
          </label>
        </div>

        {/* Model Presets */}
        <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
          <span className="text-stone-500 flex items-center gap-1 font-medium">
            <Cpu className="w-3.5 h-3.5" /> 快捷预设:
          </span>
          {PRESET_MODELS.map((preset) => (
            <button
              key={preset.name}
              type="button"
              onClick={() => handleApplyPreset(preset)}
              className="rounded-md border border-stone-300 bg-stone-50 px-2.5 py-1 text-stone-700 hover:bg-white hover:border-stone-400"
            >
              {preset.name}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="ai-endpoint" className="text-stone-700">接口地址</label>
              {isLocal && (
                <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">
                  已识别为本地模型
                </span>
              )}
            </div>
            <input
              type="text"
              id="ai-endpoint"
              disabled={config.useMock}
              value={config.baseUrl}
              onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })}
              placeholder="http://localhost:11434/v1 或 https://api.openai.com/v1"
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-stone-900 disabled:bg-stone-100 disabled:text-stone-400"
            />
          </div>

          <div>
            <label htmlFor="ai-model" className="mb-1 block text-stone-700">模型名称</label>
            <input
              type="text"
              id="ai-model"
              disabled={config.useMock}
              value={config.modelName}
              onChange={(e) => setConfig({ ...config, modelName: e.target.value })}
              placeholder="qwen2.5:7b, llama3.2, 或 gpt-4o-mini"
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-stone-900 disabled:bg-stone-100 disabled:text-stone-400"
            />
          </div>

          <div className="md:col-span-2">
            <div className="mb-1 flex items-center justify-between gap-3">
              <label className="text-stone-700">
                密钥 {isLocal ? <span className="text-xs text-stone-500 font-normal">（本地模型可不填）</span> : null}
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-stone-500">
                <input
                  type="checkbox"
                  disabled={config.useMock}
                  checked={config.sessionOnlyKey}
                  onChange={(e) => setConfig({ ...config, sessionOnlyKey: e.target.checked })}
                />
                <span>关掉浏览器就忘掉</span>
              </label>
            </div>
            <div className="relative">
              <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                disabled={config.useMock}
                value={config.apiKey}
                onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
                placeholder={isLocal ? "本地模型无需填写密钥" : "sk-..."}
                className="w-full rounded-lg border border-stone-300 bg-white py-2 pl-9 pr-3 font-mono focus:outline-none focus:ring-2 focus:ring-stone-900 disabled:bg-stone-100 disabled:text-stone-400"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-stone-700">超时（秒）</label>
            <input
              type="number"
              min={5}
              max={180}
              value={config.timeoutSec}
              onChange={(e) => setConfig({ ...config, timeoutSec: parseInt(e.target.value, 10) || 30 })}
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-stone-900"
            />
          </div>

          <div>
            <label className="mb-1 block text-stone-700">同时处理几篇</label>
            <input
              type="number"
              min={1}
              max={5}
              value={config.concurrencyLimit}
              onChange={(e) =>
                setConfig({ ...config, concurrencyLimit: Math.max(1, Math.min(5, parseInt(e.target.value, 10) || 2)) })
              }
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-stone-900"
            />
          </div>

          <div>
            <label htmlFor="ai-batch-limit" className="mb-1 block text-stone-700">每批最多整理几篇</label>
            <input
              id="ai-batch-limit"
              type="number"
              min={1}
              max={MAX_AI_BATCH_LIMIT}
              value={config.batchLimit}
              onChange={(e) => setConfig({ ...config, batchLimit: normalizeAIBatchLimit(e.target.valueAsNumber) })}
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-stone-900"
            />
            <p className="mt-1 text-xs text-stone-600">超出上限的帖子留到下一批，由你再次启动。</p>
          </div>

          <div className="pt-1 md:col-span-2 space-y-2">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-stone-200 p-3 bg-stone-50/50 hover:bg-stone-50">
              <input
                type="checkbox"
                checked={config.allowSendImages}
                onChange={(e) => setConfig({ ...config, allowSendImages: e.target.checked })}
                className="mt-0.5"
              />
              <div className="text-sm">
                <span className="font-medium text-stone-900">允许向 AI 发送推文图片 (多模态 Vision 提炼)</span>
                <p className="mt-0.5 text-xs text-stone-500 leading-relaxed">
                  默认关闭，图片不会上传，仅发送正文与链接。开启后，若推文包含架构图、操作步骤截图或代码长图，将连同已下载的原图发送给多模态模型（如 GPT-4o、Claude 3.5 Sonnet 等）进行深度提取。
                </p>
              </div>
            </label>
          </div>
        </div>

        {/* Test Connection Banner */}
        {testResult && (
          <div
            className={`p-3.5 rounded-xl border text-xs flex items-start space-x-2 ${
              testResult.success
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-rose-50 border-rose-200 text-rose-900'
            }`}
          >
            {testResult.success ? (
              <Check className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-rose-600 mt-0.5 flex-shrink-0" />
            )}
            <div className="leading-relaxed">{testResult.message}</div>
          </div>
        )}

        <div className="pt-2 flex justify-between items-center border-t border-slate-100">
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={isTesting || (!config.useMock && !isLocal && !config.apiKey)}
            className="flex items-center gap-1.5 rounded-lg border border-stone-300 px-3.5 py-2 text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50"
          >
            {isTesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            <span>{isTesting ? '正在试…' : '试一下连接'}</span>
          </button>

          <button
            type="button"
            onClick={handleSaveAiConfig}
            disabled={savingAiConfig}
            className="flex items-center gap-1.5 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
          >
            {savedSuccess ? <Check className="h-3.5 w-3.5" /> : null}
            <span>{savingAiConfig ? '正在保存…' : savedSuccess ? '已保存' : '保存'}</span>
          </button>
        </div>
        {aiSaveError && <p role="alert" className="text-sm text-rose-700">{aiSaveError}</p>}
        <p className="text-xs text-stone-500">试连接使用当前表单，只发送一条测试消息。点击「保存」才会保存设置。</p>
      </fieldset>

      {/* Security & Architecture Guarantees */}
      <div className="rounded-xl border border-stone-200 bg-white p-5 text-sm">
        <h2 className="text-base font-medium text-stone-900">关于整理</h2>
        <ul className="mt-3 space-y-1.5 leading-6 text-stone-600">
          <li>同一篇内容不会重复计费。</li>
          <li>你改过的标题、标签和笔记会留下来。</li>
          <li>密钥不会写进导出的文件。</li>
          <li>原文里没有的步骤，不会编出来。</li>
        </ul>
        <button
          onClick={onOpenDiagnostics}
          className="mt-4 rounded-lg border border-stone-300 px-3.5 py-2 text-sm text-stone-700 hover:bg-stone-50"
        >
          查看诊断
        </button>
      </div>

      <div className="space-y-3 rounded-xl border border-stone-200 bg-white p-5 text-sm">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-stone-500" />
          <h2 className="text-base font-medium text-stone-900">数据</h2>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-1 text-stone-600">
          <div>帖子 {dbStats.posts}</div>
          <div>图片 {dbStats.media}</div>
          <div>同步 {dbStats.runs}</div>
          <div>整理 {dbStats.ai}</div>
        </div>

        <div className="flex items-center justify-between border-t border-stone-100 pt-3">
          <span className="text-stone-500">清空后无法恢复。</span>
          <button
            onClick={handleResetDatabase}
            className="flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-sm text-rose-700 hover:bg-rose-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>清空</span>
          </button>
        </div>
      </div>
    </div>
  );
};
