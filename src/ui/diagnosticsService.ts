import { db } from '../storage/db';
import { isArchiveUrl } from '../adapters/findLikesTab';
import { aiService } from '../ai/aiService';
import { isLocalEndpoint } from '../ai/openaiClient';
import { describePageProbe, type PageProbe } from './pageProbe';
import { isCaptureFailureCode, isXAuthenticationUrl } from '../adapters/captureFailure';
import { hasArchivedMedia } from '../domain/media';
import { safeDiagnosticFrames } from '../domain/diagnosticFrames';
import { emptyCaptureQuality, countCaptureQuality, safeCaptureQuality, type CaptureQuality } from '../domain/captureQuality';

const TASK_FAILURE_CODES = new Set(['paused', 'cancelled', 'capture_failed', 'limit_reached', 'range_unknown', 'interrupted', 'import_failed']);
const SYNC_ADAPTERS = new Set(['fixture', 'x_dom', 'x_archive']);
const SYNC_STATUSES = new Set(['idle', 'running', 'paused', 'partial', 'completed', 'failed', 'cancelled']);
const EXPORT_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled']);

function browserEnvironment(userAgent: string): string {
  const browser = Array.from(userAgent.matchAll(/\b(?:Headless)?(Edg|Chrome|Chromium|Firefox)\/(\d{1,6})(?:[.\s]|$)/g)).at(-1);
  const os = /Windows NT/.test(userAgent) ? 'Windows'
    : /Android/.test(userAgent) ? 'Android'
    : /Macintosh/.test(userAgent) ? 'macOS'
    : /Linux/.test(userAgent) ? 'Linux' : '未知系统';
  return `${browser ? `${browser[1]} ${browser[2]}` : '未知浏览器'} · ${os}`;
}

function redactTabUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.hostname === 'x.com' || parsed.hostname.endsWith('.x.com') || parsed.hostname.includes('twitter.com')) {
      return `${parsed.origin}/[redacted]`;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function redactOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return '[invalid-origin]';
  }
}

export interface HealthCheckResult {
  overallStatus: 'healthy' | 'warning' | 'error';
  timestamp: string;
  checks: {
    extension: {
      status: 'pass' | 'fail';
      version: string;
      environment: string;
    };
    storage: {
      status: 'pass' | 'warning' | 'fail';
      totalPosts: number;
      totalMedia: number;
      downloadedMedia: number;
      failedMedia: number;
      captureQuality?: CaptureQuality;
      details: string;
    };
    xTab: {
      status: 'pass' | 'warning' | 'fail';
      tabFound: boolean;
      url?: string;
      isLikesOrBookmarks: boolean;
      contentScriptResponding: boolean;
      visibleArticlesCount: number;
      failureCode?: PageProbe['failureCode'];
      guidance: string;
    };
    ai: {
      status: 'pass' | 'warning' | 'info';
      mode: 'mock' | 'openai_compatible' | 'unconfigured';
      modelName: string;
      permissionGranted: boolean;
      details: string;
    };
  };
  recommendations: string[];
}

/**
 * Perform a comprehensive runtime self-test and diagnosis.
 * Strictly adheres to PRD F09: never exposes auth tokens, cookies, or raw post contents.
 */
export async function performHealthCheck(): Promise<HealthCheckResult> {
  const recommendations: string[] = [];
  const now = new Date().toISOString();

  // 1. Extension runtime check
  const hasChrome = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  const extStatus: 'pass' | 'fail' = hasChrome ? 'pass' : 'fail';
  if (!hasChrome) {
    recommendations.push('未检测到 Chrome 扩展环境，部分页面通信与标签页查询功能受限。');
  }

  // 2. Storage health check
  let totalPosts = 0;
  let totalMedia = 0;
  let downloadedMedia = 0;
  let failedMedia = 0;
  let captureQuality: CaptureQuality | undefined;
  let storageStatus: 'pass' | 'warning' | 'fail' = 'pass';
  let storageDetails = 'IndexedDB 数据库工作正常。';

  try {
    const summary = emptyCaptureQuality();
    await db.posts.each(post => { totalPosts++; countCaptureQuality(summary, post); });
    captureQuality = summary;
    totalMedia = await db.media.count();
    const savedMedia = await db.media.where('status').equals('downloaded').count();
    downloadedMedia = await db.media.where('status').equals('downloaded').filter(hasArchivedMedia).count();
    failedMedia = await db.media.where('status').equals('failed').count() + Math.max(0, savedMedia - downloadedMedia);

    if (totalMedia > 0 && failedMedia > totalMedia * 0.5) {
      storageStatus = 'warning';
      storageDetails = `有 ${failedMedia}/${totalMedia} 项媒体下载失败或本地文件缺失。可在文库详情中按需重试。`;
      recommendations.push('图片离线下载失败较多，可检查网络是否可正常访问 pbs.twimg.com，或在推文详情中按需重试。');
    }
  } catch {
    storageStatus = 'fail';
    storageDetails = '数据库访问异常。请检查浏览器存储配额或在设置页重置数据库。';
    recommendations.push('IndexedDB 读写失败，请检查浏览器存储配额或在设置页重置数据库。');
  }

  // 3. X Tab connection check
  let xStatus: 'pass' | 'warning' | 'fail' = 'warning';
  let tabFound = false;
  let tabUrl: string | undefined;
  let isArchive = false;
  let scriptResponding = false;
  let visibleArticles = 0;
  let xFailureCode: PageProbe['failureCode'];
  let xGuidance = '未检测到打开的 X (Twitter) 标签页。';

  if (hasChrome && chrome.tabs?.query) {
    try {
      const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
      if (tabs.length > 0) {
        tabFound = true;
        // Prefer archive tab
        const archiveTab = tabs.find((t) => t.url && isArchiveUrl(t.url));
        const authTab = tabs.find((t) => t.url && isXAuthenticationUrl(t.url));
        const activeTab = archiveTab ?? authTab ?? tabs[0];
        tabUrl = redactTabUrl(activeTab.url);
        isArchive = Boolean(activeTab.url && isArchiveUrl(activeTab.url));

        if (activeTab.url && isXAuthenticationUrl(activeTab.url)) {
          const blocked = describePageProbe({ ok: true, failureCode: 'login_required' });
          xFailureCode = blocked.failureCode;
          xGuidance = blocked.detail;
        } else if (activeTab.id) {
          try {
            const res = (await chrome.tabs.sendMessage(activeTab.id, { type: 'PING' })) as
              | { status?: string; articlesCount?: number; reading?: boolean; isLikesPage?: boolean; failureCode?: unknown }
              | undefined;

            if (res && res.status === 'ok') {
              scriptResponding = true;
              visibleArticles = typeof res.articlesCount === 'number' && Number.isSafeInteger(res.articlesCount)
                ? Math.max(0, res.articlesCount) : 0;
              const blocked = describePageProbe({ ok: true, failureCode: res.failureCode });

              if (blocked.failureCode) {
                xFailureCode = blocked.failureCode;
                xGuidance = blocked.detail;
              } else if (isArchive && visibleArticles > 0) {
                xStatus = 'pass';
                xGuidance = `已成功连接点赞页，当前可见 ${visibleArticles} 条推文，就绪可随时开始采集。`;
              } else if (isArchive && visibleArticles === 0) {
                xStatus = 'warning';
                xGuidance = '已连接点赞页，但未扫描到可见推文。请确认该账号已在 X 登录且页面未处于加载卡顿中。';
                recommendations.push('X 点赞页未出现推文卡片：请切换至该标签页并按 F5 刷新，确认是否处于登录状态。');
              } else {
                xStatus = 'warning';
                xGuidance = '当前打开的是普通的 X 页面，请导航至「点赞」或「收藏」页面以开始归档。';
                recommendations.push('当前 X 标签页非点赞页：请打开 https://x.com/i/history/likes。');
              }
            } else {
              xStatus = 'warning';
              xGuidance = '点赞页面未响应插件通信，请刷新该标签页重试。';
              recommendations.push('X 页面通信中断：请在 X 标签页按 F5 刷新重新注入内容脚本。');
            }
          } catch {
            xStatus = 'warning';
            xGuidance = '未能与 X 页面内容脚本握手，通常只需在点赞页按 F5 刷新即可恢复。';
            recommendations.push('无法连接内容脚本：请在已打开的 X 标签页按 F5 重新载入。');
          }
        }
      } else {
        recommendations.push('未找到任何打开的 X 标签页：请先在 Chrome 中打开 https://x.com/i/history/likes。');
      }
    } catch {
      // Chrome tabs query error
    }
  }

  // 4. AI config & permissions check
  let aiStatus: 'pass' | 'warning' | 'info' = 'info';
  let aiMode: 'mock' | 'openai_compatible' | 'unconfigured' = 'unconfigured';
  let modelName = '未配置';
  let permissionGranted = false;
  let aiDetails = '未配置 AI API，当前处于纯离线归档模式（不影响原文保存与 Markdown 导出）。';

  try {
    const aiConfig = await aiService.getConfig();
    if (aiConfig.useMock) {
      aiStatus = 'pass';
      aiMode = 'mock';
      modelName = '离线 Mock 模拟器';
      permissionGranted = true;
      aiDetails = '已启用本地离线 Mock 模式，无需 API 密钥即可测试知识提炼与分类。';
    } else if (isLocalEndpoint(aiConfig.baseUrl)) {
      aiMode = 'openai_compatible';
      modelName = aiConfig.modelName || 'gpt-4o-mini';
      aiStatus = 'pass';
      permissionGranted = true;
      aiDetails = `配置了本地模型服务 (${modelName})，地址: ${redactOrigin(aiConfig.baseUrl)}。`;
    } else if (aiConfig.apiKey.trim()) {
      aiMode = 'openai_compatible';
      modelName = aiConfig.modelName || 'gpt-4o-mini';
      if (typeof chrome !== 'undefined' && chrome.permissions?.contains) {
        try {
          const originPattern = `${new URL(aiConfig.baseUrl).origin}/*`;
          permissionGranted = await chrome.permissions.contains({ origins: [originPattern] });
          if (permissionGranted) {
            aiStatus = 'pass';
            aiDetails = `已配置云端模型 (${modelName})，且已获得接口地址访问权限。`;
          } else {
            aiStatus = 'warning';
            aiDetails = `已配置云端模型 (${modelName})，但尚未授权访问接口域名。请在设置页点击「测试连接」以授权。`;
            recommendations.push('AI 接口权限待授予：请前往「设置」页点击「测试连接」，并在弹窗中允许访问。');
          }
        } catch {
          aiDetails = `已配置云端模型 (${modelName})。`;
        }
      }
    }
  } catch {
    // Config read error
  }

  // Compute overall status
  const overallStatus: HealthCheckResult['overallStatus'] =
    storageStatus === 'fail'
      ? 'error'
      : xStatus === 'warning' || storageStatus === 'warning' || aiStatus === 'warning'
      ? 'warning'
      : 'healthy';

  return {
    overallStatus,
    timestamp: now,
    checks: {
      extension: {
        status: extStatus,
        version: typeof chrome !== 'undefined' ? chrome.runtime?.getManifest?.().version ?? '0.1.0' : '0.1.0',
        environment: typeof navigator !== 'undefined' ? navigator.userAgent : 'Node.js',
      },
      storage: {
        status: storageStatus,
        totalPosts,
        totalMedia,
        downloadedMedia,
        failedMedia,
        captureQuality,
        details: storageDetails,
      },
      xTab: {
        status: xStatus,
        tabFound,
        url: tabUrl,
        isLikesOrBookmarks: isArchive,
        contentScriptResponding: scriptResponding,
        visibleArticlesCount: visibleArticles,
        failureCode: xFailureCode,
        guidance: xGuidance,
      },
      ai: {
        status: aiStatus,
        mode: aiMode,
        modelName,
        permissionGranted,
        details: aiDetails,
      },
    },
    recommendations,
  };
}

/**
 * Generate sanitized diagnostic report JSON string.
 */
export async function generateDiagnosticReport(result?: HealthCheckResult): Promise<string> {
  const check = result ?? await performHealthCheck();
  const aiFailures = { request: 0, response_format: 0, storage: 0, interrupted: 0, unknown: 0 };
  const [syncRuns, exportJobs] = await Promise.all([
    db.syncRuns.orderBy('startedAt').reverse().limit(5).toArray(),
    db.exportJobs.orderBy('startedAt').reverse().limit(5).toArray(),
    db.aiAnalysis.where('status').equals('failed').each(({ failureCode }) => {
      switch (failureCode) {
        case 'request':
        case 'response_format':
        case 'storage':
        case 'interrupted':
          aiFailures[failureCode]++;
          break;
        default:
          aiFailures.unknown++;
      }
    }),
  ]);
  const failedAnalyses = Object.values(aiFailures).reduce((sum, count) => sum + count, 0);
  const { extension, storage, xTab, ai } = check.checks;

  const data = {
    appName: 'LikeMind',
    version: check.checks.extension.version,
    generatedAt: check.timestamp,
    overallHealth: check.overallStatus,
    checks: {
      extension: { status: extension.status, environment: browserEnvironment(extension.environment) },
      storage: {
        status: storage.status, totalPosts: storage.totalPosts, totalMedia: storage.totalMedia,
        downloadedMedia: storage.downloadedMedia, failedMedia: storage.failedMedia,
        captureQuality: storage.captureQuality ? safeCaptureQuality(storage.captureQuality) : undefined,
      },
      xTab: {
        status: xTab.status, tabFound: xTab.tabFound, isLikesOrBookmarks: xTab.isLikesOrBookmarks,
        contentScriptResponding: xTab.contentScriptResponding, visibleArticlesCount: xTab.visibleArticlesCount,
        failureCode: describePageProbe({ ok: true, failureCode: xTab.failureCode }).failureCode,
      },
      ai: { status: ai.status, mode: ai.mode, permissionGranted: ai.permissionGranted, failedAnalyses, failuresByCode: aiFailures },
    },
    recentRuns: syncRuns.map((r) => ({
      status: SYNC_STATUSES.has(r.status) ? r.status : 'unknown',
      adapter: SYNC_ADAPTERS.has(r.adapterType) ? r.adapterType : 'unknown',
      stats: {
        scanned: r.stats.scanned, added: r.stats.added, updated: r.stats.updated,
        skipped: r.stats.skipped, failed: r.stats.failed,
      },
      repairStats: r.repairStats && {
        textAttempts: r.repairStats.textAttempts, textRecovered: r.repairStats.textRecovered,
        imageAttempts: r.repairStats.imageAttempts, imagesRecovered: r.repairStats.imagesRecovered,
        remainingPosts: r.repairStats.remainingPosts, remainingImages: r.repairStats.remainingImages,
      },
      failureCode: isCaptureFailureCode(r.failureCode) || (r.failureCode && TASK_FAILURE_CODES.has(r.failureCode))
        ? r.failureCode : undefined,
      diagnosticFrames: safeDiagnosticFrames(r.diagnosticFrames),
    })),
    recentZipExports: exportJobs.map((job) => ({
      status: EXPORT_STATUSES.has(job.status) ? job.status : 'unknown',
      plannedPackages: job.totalPackages,
      submittedPackages: job.submittedFiles.length,
      failedPackage: job.failedPackage,
      diagnosticFrames: safeDiagnosticFrames(job.diagnosticFrames),
    })),
    privacyCompliance: {
      credentialsExcluded: true,
      rawPostContentsExcluded: true,
    },
  };

  return JSON.stringify(data, null, 2);
}
