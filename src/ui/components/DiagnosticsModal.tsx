import React, { useState, useEffect, useRef } from 'react';
import { X, ShieldAlert, Download, Copy, Check, CheckCircle2, AlertTriangle, AlertCircle, RefreshCw } from 'lucide-react';
import { performHealthCheck, generateDiagnosticReport, type HealthCheckResult } from '../diagnosticsService';
import { useDialogFocus } from './useDialogFocus';

interface DiagnosticsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DiagnosticsModal: React.FC<DiagnosticsModalProps> = ({ isOpen, onClose }) => {
  const [health, setHealth] = useState<HealthCheckResult | null>(null);
  const [report, setReport] = useState<string>('正在收集…');
  const [loading, setLoading] = useState<boolean>(true);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [reportReady, setReportReady] = useState(false);
  const generation = useRef(0);
  const [activeTab, setActiveTab] = useState<'overview' | 'raw'>('overview');
  const dialogRef = useDialogFocus(isOpen, onClose);

  const runCheck = async () => {
    const version = ++generation.current;
    setLoading(true);
    setReportReady(false);
    setCopied(false);
    setCopyError('');
    setHealth(null);
    try {
      const result = await performHealthCheck();
      const rawReport = await generateDiagnosticReport(result);
      if (version !== generation.current) return;
      setHealth(result);
      setReport(rawReport);
      setReportReady(true);
    } catch {
      if (version !== generation.current) return;
      setReport('生成诊断报告失败，请重试。');
    } finally {
      if (version === generation.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    runCheck();
    return () => { generation.current++; };
  }, [isOpen]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!isOpen) return null;

  const handleCopy = async () => {
    if (!reportReady || loading) return;
    setCopied(false);
    setCopyError('');
    const version = generation.current;
    try {
      await navigator.clipboard.writeText(report);
      if (version === generation.current) setCopied(true);
    } catch {
      if (version === generation.current) setCopyError('复制失败，请下载报告，或在 JSON 页手动复制。');
    }
  };

  const handleDownload = () => {
    if (!reportReady || loading) return;
    const blob = new Blob([report], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `likemind-diagnostic-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-stone-900/40 p-4">
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="运行自检与诊断"
        className="bg-white rounded-2xl max-w-2xl w-full shadow-2xl flex flex-col overflow-hidden border border-stone-200">
        {/* Header */}
        <div className="px-6 py-4 border-b border-stone-200 flex justify-between items-center bg-stone-50">
          <div className="flex items-center space-x-2.5">
            <ShieldAlert className="w-5 h-5 text-sky-600" />
            <div>
              <h2 className="text-sm font-semibold text-stone-900">运行自检与诊断</h2>
              <p className="text-[11px] text-stone-500">检测 X 点赞页连通性、本地存储与接口配置状态</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={runCheck}
              disabled={loading}
              className="p-1.5 rounded-lg text-stone-500 hover:text-stone-800 hover:bg-stone-200/50 transition-colors"
              title="重新检测"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button type="button" aria-label="关闭诊断" onClick={onClose} className="p-1.5 rounded-lg text-stone-400 hover:text-stone-700">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tab switch */}
        <div className="flex border-b border-stone-200 px-6 bg-stone-50/50">
          <button
            onClick={() => setActiveTab('overview')}
            className={`py-2 px-3 text-xs font-medium border-b-2 -mb-px transition-colors ${
              activeTab === 'overview'
                ? 'border-stone-900 text-stone-900'
                : 'border-transparent text-stone-500 hover:text-stone-800'
            }`}
          >
            健康自检概览
          </button>
          <button
            onClick={() => setActiveTab('raw')}
            className={`py-2 px-3 text-xs font-medium border-b-2 -mb-px transition-colors ${
              activeTab === 'raw'
                ? 'border-stone-900 text-stone-900'
                : 'border-transparent text-stone-500 hover:text-stone-800'
            }`}
          >
            脱敏诊断报告 (JSON)
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
          {activeTab === 'overview' ? (
            <div className="space-y-4 text-xs">
              {/* Overall status banner */}
              {health && (
                <div
                  className={`p-3.5 rounded-xl border flex items-start gap-3 ${
                    health.overallStatus === 'healthy'
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      : health.overallStatus === 'warning'
                      ? 'bg-amber-50 border-amber-200 text-amber-900'
                      : 'bg-rose-50 border-rose-200 text-rose-900'
                  }`}
                >
                  {health.overallStatus === 'healthy' ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                  )}
                  <div>
                    <div className="font-semibold text-sm">
                      {health.overallStatus === 'healthy'
                        ? '系统就绪，各项功能状态良好'
                        : health.overallStatus === 'warning'
                        ? '存在需要关注的配置或连接提醒'
                        : '核心组件存在异常'}
                    </div>
                    <div className="mt-0.5 text-[11px] opacity-90">
                      诊断时间: {new Date(health.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              )}

              {/* Items grid */}
              {health && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Item 1: X Tab */}
                  <div className="p-3.5 rounded-xl border border-stone-200 bg-stone-50/60 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-stone-800">X 点赞页面连接</span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          health.checks.xTab.status === 'pass'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {health.checks.xTab.status === 'pass' ? '正常' : '需注意'}
                      </span>
                    </div>
                    <p className="text-[11px] text-stone-600 leading-relaxed">
                      {health.checks.xTab.guidance}
                    </p>
                    {health.checks.xTab.url && (
                      <div className="text-[10px] text-stone-400 truncate font-mono">
                        {health.checks.xTab.url}
                      </div>
                    )}
                  </div>

                  {/* Item 2: Database */}
                  <div className="p-3.5 rounded-xl border border-stone-200 bg-stone-50/60 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-stone-800">本地存储 (IndexedDB)</span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          health.checks.storage.status === 'pass'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-rose-100 text-rose-800'
                        }`}
                      >
                        {health.checks.storage.status === 'pass' ? '健康' : '异常'}
                      </span>
                    </div>
                    <p className="text-[11px] text-stone-600 leading-relaxed">
                      已保存 {health.checks.storage.totalPosts} 篇推文，{health.checks.storage.downloadedMedia} 张离线图片。
                    </p>
                    {health.checks.storage.captureQuality && <p className="text-[11px] leading-relaxed text-stone-600">
                      采集状态：完整 {health.checks.storage.captureQuality.statuses.complete} 篇 · 不完整 {health.checks.storage.captureQuality.statuses.partial} 篇 · 失败 {health.checks.storage.captureQuality.statuses.failed} 篇 · 未知 {health.checks.storage.captureQuality.statuses.unknown} 篇。缺失字段计数见 JSON 报告。
                    </p>}
                  </div>

                  {/* Item 3: AI Config */}
                  <div className="p-3.5 rounded-xl border border-stone-200 bg-stone-50/60 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-stone-800">AI 知识提炼配置</span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          health.checks.ai.status === 'pass'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-stone-200 text-stone-700'
                        }`}
                      >
                        {health.checks.ai.mode === 'mock'
                          ? 'Mock 模拟'
                          : health.checks.ai.mode === 'openai_compatible'
                          ? '已配置'
                          : '未开启'}
                      </span>
                    </div>
                    <p className="text-[11px] text-stone-600 leading-relaxed">
                      {health.checks.ai.details}
                    </p>
                  </div>

                  {/* Item 4: Environment */}
                  <div className="p-3.5 rounded-xl border border-stone-200 bg-stone-50/60 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-stone-800">扩展环境</span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-800">
                        MV3 v{health.checks.extension.version}
                      </span>
                    </div>
                    <p className="text-[11px] text-stone-600 leading-relaxed">
                      运行于 Google Chrome 环境，后台生命周期检查点已激活。
                    </p>
                  </div>
                </div>
              )}

              {/* Recommendations list */}
              {health && health.recommendations.length > 0 && (
                <div className="p-3.5 rounded-xl border border-amber-200 bg-amber-50/60 space-y-2">
                  <div className="font-medium text-amber-900 flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4 text-amber-700" />
                    <span>排查建议与操作指引</span>
                  </div>
                  <ul className="space-y-1 pl-4 list-disc text-[11px] text-amber-900/90 leading-relaxed">
                    {health.recommendations.map((rec, i) => (
                      <li key={i}>{rec}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3 text-xs">
              <p className="text-stone-500">
                本报告符合 PRD F09 隐私规范：严格排除用户密码、Token、Cookies、推文正文与 API 密钥。可安全提供给开发者排查问题。
              </p>
              <pre className="bg-stone-900 text-stone-100 p-4 rounded-xl overflow-x-auto max-h-72 font-mono text-[11px] leading-relaxed">
                {report}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        {copyError && <p role="alert" className="px-6 py-2 text-sm text-rose-700">{copyError}</p>}
        {!loading && !reportReady && <p role="alert" className="px-6 py-2 text-sm text-rose-700">生成诊断报告失败，请点击「重新检测」。</p>}
        <div className="px-6 py-3 border-t border-stone-200 bg-stone-50 flex justify-between items-center">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-stone-200 hover:bg-stone-300 text-stone-800 text-xs font-medium rounded-lg transition-colors"
          >
            关闭
          </button>

          <div className="flex space-x-2">
            <button
              onClick={handleCopy}
              disabled={loading || !reportReady}
              className="flex items-center space-x-1.5 px-3.5 py-2 border border-stone-300 hover:bg-stone-100 text-stone-700 text-xs font-medium rounded-lg transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? '已复制' : '复制诊断内容'}</span>
            </button>

            <button
              onClick={handleDownload}
              disabled={loading || !reportReady}
              className="flex items-center space-x-1.5 px-4 py-2 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>下载报告 (JSON)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
