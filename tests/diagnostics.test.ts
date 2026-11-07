import { describe, it, expect, beforeEach, vi } from 'vitest';
import { performHealthCheck, generateDiagnosticReport } from '../src/ui/diagnosticsService';
import { db } from '../src/storage/db';
import { captureDiagnosticFrames, logDiagnosticError } from '../src/domain/diagnosticFrames';
import type { NormalizedPost } from '../src/domain/types';

describe('Diagnostics Service & Health Check', () => {
  it('includes capture status and missing-field counts without post identifiers or content', async () => {
    const base: NormalizedPost = { id: 'private-post-id', platform: 'x', postId: '1', canonicalUrl: 'https://x.com/private-author/status/1',
      text: 'private-post-text', postedAt: null, likedAt: null, firstObservedAt: '2026-11-07T00:00:00Z', lastObservedAt: '2026-11-07T00:00:00Z',
      captureStatus: 'partial', missingFields: ['text', 'text', 'private-gap'], externalLinks: [], mediaIds: [], contentHash: 'private-hash',
      sourceAdapter: 'fixture', sourceRunId: 'private-run', schemaVersion: 1 };
    await db.posts.bulkPut([base, { ...base, id: 'private-second-id', captureStatus: 'complete', missingFields: [] }]);
    const health = await performHealthCheck();
    expect(health.checks.storage.captureQuality?.statuses).toEqual({ complete: 1, partial: 1, failed: 0, unknown: 0 });
    const raw = await generateDiagnosticReport(health);
    const quality = JSON.parse(raw).checks.storage.captureQuality;
    expect(quality.missingFields).toMatchObject({ text: 1, unknown: 1 });
    expect(raw).not.toMatch(/private-(?:post|author|hash|run|gap|second)/);
  });
  beforeEach(async () => {
    await db.posts.clear();
    await db.media.clear();
    await db.syncRuns.clear();
    await db.exportJobs.clear();
    await db.aiAnalysis.clear();
  });

  it('performs health check and reports storage and environment correctly', async () => {
    const health = await performHealthCheck();

    expect(health.timestamp).toBeTruthy();
    expect(health.checks.storage.status).toBe('pass');
    expect(health.checks.storage.totalPosts).toBe(0);
    expect(health.checks.extension.version).toBe('0.1.0');
    expect(health.recommendations).toBeInstanceOf(Array);
  });

  it.each([
    ['https://x.com/i/flow/login?token=private-fixture', 'login_required', '完成登录'],
    ['https://x.com/i/history/likes', 'access_restricted', '恢复访问'],
  ])('reports a blocked X tab without exporting its URL or treating old cards as ready', async (url, failureCode, guidance) => {
    const previousRuntimeId = chrome.runtime.id;
    chrome.runtime.id = 'test-extension';
    const query = vi.spyOn(chrome.tabs, 'query').mockResolvedValue([{ id: 4, url } as chrome.tabs.Tab]);
    const ping = vi.spyOn(chrome.tabs, 'sendMessage').mockResolvedValue({ status: 'ok', articlesCount: 4, failureCode });
    try {
      const health = await performHealthCheck();
      expect(health.checks.xTab).toMatchObject({ status: 'warning', failureCode, guidance: expect.stringContaining(guidance) });
      const raw = await generateDiagnosticReport(health);
      expect(JSON.parse(raw).checks.xTab).toMatchObject({ status: 'warning', failureCode });
      expect(raw).not.toContain('private-fixture');
      expect(raw).not.toContain(url);
    } finally {
      query.mockRestore();
      ping.mockRestore();
      chrome.runtime.id = previousRuntimeId;
    }
  });

  it('generates sanitized diagnostic report without leaking credentials', async () => {
    // Add mock sync run
    await db.syncRuns.put({
      id: 'test_run_1',
      startedAt: new Date().toISOString(),
      lastCheckpointAt: new Date().toISOString(),
      status: 'completed',
      stats: { scanned: 5, added: 5, updated: 0, skipped: 0, failed: 0 },
      targetLimit: 10,
      downloadMedia: true,
      adapterType: 'fixture',
      failureCode: 'range_unknown',
      failureMessage: 'private-report-note',
    });

    await db.exportJobs.bulkPut([
      { id: 'private-zip-id', startedAt: '2026-11-05T00:00:00Z', status: 'cancelled',
        totalPackages: 2, submittedFiles: ['private-name.zip'] },
      { id: 'private-failed-zip-id', startedAt: '2026-11-06T00:00:00Z', status: 'failed',
        totalPackages: 3, submittedFiles: ['private-name.zip'], failedPackage: 2, failureMessage: 'private-zip-error' },
    ]);
    await db.media.put({
      id: 'private-media-id', postId: 'private-ai-post', position: 0, kind: 'image', status: 'downloaded',
      sourceUrl: 'https://pbs.twimg.com/media/private-image-path.png',
    });
    await db.aiAnalysis.put({
      postId: 'private-ai-post', sourceHash: 'fixture', status: 'failed', model: 'private-model',
      promptVersion: 'fixture', categories: [], tags: [], failureReason: 'private-ai-error',
    });
    const reportJson = await generateDiagnosticReport();
    const parsed = JSON.parse(reportJson);

    expect(parsed.appName).toBe('LikeMind');
    expect(parsed.version).toBe('0.1.0');
    expect(parsed.recentRuns.length).toBe(1);
    expect(parsed.recentRuns[0]).toMatchObject({ failureCode: 'range_unknown', stats: { scanned: 5 } });
    expect(parsed.recentZipExports).toEqual([
      { status: 'failed', plannedPackages: 3, submittedPackages: 1, failedPackage: 2 },
      { status: 'cancelled', plannedPackages: 2, submittedPackages: 1 },
    ]);
    expect(parsed.checks.storage).toMatchObject({ downloadedMedia: 0, failedMedia: 1 });
    expect(parsed.checks.ai.failedAnalyses).toBe(1);
    expect(parsed.checks.ai.failuresByCode).toMatchObject({ unknown: 1, request: 0 });
    expect(reportJson).not.toMatch(/private-(?:media-id|ai-post|image-path|model|ai-error)/);
    expect(reportJson).not.toMatch(/private-(?:zip-id|failed-zip-id|name|zip-error)/);
    expect(reportJson).not.toContain('test_run_1');
    expect(reportJson).not.toContain('private-report-note');
    expect(parsed.privacyCompliance.credentialsExcluded).toBe(true);

    // Verify no secret leak
    expect(parsed).not.toHaveProperty('apiKey');
    expect(parsed).not.toHaveProperty('token');
    expect(parsed).not.toHaveProperty('cookie');
    expect(parsed.checks.ai).not.toHaveProperty('apiKey');
  });

  it('exports only recognized runtime labels and browser metadata', async () => {
    const health = await performHealthCheck();
    health.checks.extension.environment = 'Mozilla/5.0 (Windows NT 10.0) Chrome/153.0.0.0 Edg/153.0.1 private-user-agent';
    await db.syncRuns.put({
      id: 'fixture', startedAt: health.timestamp, lastCheckpointAt: health.timestamp,
      status: 'failed', adapterType: 'private-adapter' as 'fixture', failureCode: 'private-code',
      stats: { scanned: 0, added: 0, updated: 0, skipped: 0, failed: 0 },
      targetLimit: 1, downloadMedia: false,
    });
    const raw = await generateDiagnosticReport(health);
    const report = JSON.parse(raw);
    expect(report.checks.extension.environment).toBe('Edg 153 · Windows');
    expect(report.recentRuns[0]).toMatchObject({ adapter: 'unknown', status: 'failed' });
    expect(raw).not.toContain('private-');
  });

  it('logs event codes without arbitrary exception text or object fields', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      logDiagnosticError('import_archive', { message: 'private-post', apiKey: 'private-key' });
      logDiagnosticError('parse_local_file', new Error('private-file'), 'warn');
      expect(error).toHaveBeenCalledWith('[LikeMind]', 'import_archive', []);
      expect(warn).toHaveBeenCalledWith('[LikeMind]', 'parse_local_file', []);
      expect(JSON.stringify([error.mock.calls, warn.mock.calls])).not.toContain('private-');
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('keeps only packaged stack locations, including when reading stored diagnostics', async () => {
    const root = chrome.runtime.getURL('');
    const error = new Error('private message');
    error.stack = [
      'Error: private message',
      `    at privateName (${root}assets/App-Abcd1234.js:17:42)`,
      `    at ${root}content.js:1:2`,
      `    at ${root}assets/useDialogFocus-Lpf95_ik.js:3:19`,
      `    at ${root}background.js?key=private:1:2`,
      '    at https://x.com/private-user/status/12:5:6',
      '    at chrome-extension://other-extension/content.js:2:3',
    ].join('\n');
    const frames = captureDiagnosticFrames(error);
    expect(frames).toEqual(['assets/App-Abcd1234.js:17:42', 'content.js:1:2', 'assets/useDialogFocus-Lpf95_ik.js:3:19']);
    await db.exportJobs.put({
      id: 'fixture', startedAt: new Date().toISOString(), status: 'failed',
      totalPackages: 1, submittedFiles: [],
      diagnosticFrames: [...(frames ?? []), 'private persisted frame'],
    });
    const raw = await generateDiagnosticReport();
    expect(JSON.parse(raw).recentZipExports[0].diagnosticFrames).toEqual(frames);
    expect(raw).not.toContain('private');
  });

  it('redacts account paths and query strings from the diagnostic report', async () => {
    const runtime = chrome.runtime as typeof chrome.runtime & { id?: string };
    const previousRuntimeId = runtime.id;
    runtime.id = 'test-extension';
    const query = vi.spyOn(chrome.tabs, 'query').mockResolvedValue([
      { id: 4, url: 'https://x.com/private-user/likes?token=fixture-secret#top' } as chrome.tabs.Tab,
    ]);
    const get = vi.spyOn(chrome.storage.local, 'get').mockImplementation(((_keys: unknown, callback?: (items: Record<string, unknown>) => void) => {
      callback?.({
        ai_config: {
          baseUrl: 'http://127.0.0.1:11434/v1?token=local-secret',
          apiKey: 'should-not-appear',
          modelName: 'private-model-alias',
          timeoutSec: 30,
          concurrencyLimit: 1,
          allowSendImages: false,
          sessionOnlyKey: false,
          useMock: false,
        },
      });
      return Promise.resolve({});
    }) as typeof chrome.storage.local.get);
    try {
      const report = JSON.parse(await generateDiagnosticReport());
      expect(report.checks.xTab).not.toHaveProperty('url');
      expect(report.checks.ai).not.toHaveProperty('modelName');
      expect(report.checks.ai.mode).toBe('openai_compatible');
      expect(JSON.stringify(report)).not.toContain('private-user');
      expect(JSON.stringify(report)).not.toContain('fixture-secret');
      expect(JSON.stringify(report)).not.toContain('local-secret');
      expect(JSON.stringify(report)).not.toContain('should-not-appear');
      expect(JSON.stringify(report)).not.toContain('private-model-alias');
      expect(JSON.stringify(report)).not.toContain('127.0.0.1');
    } finally {
      query.mockRestore();
      get.mockRestore();
      runtime.id = previousRuntimeId;
    }
  });
});
