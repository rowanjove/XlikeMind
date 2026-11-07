import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiagnosticsModal } from '../src/ui/components/DiagnosticsModal';
import { performHealthCheck, generateDiagnosticReport } from '../src/ui/diagnosticsService';

vi.mock('../src/ui/diagnosticsService', () => ({ performHealthCheck: vi.fn(), generateDiagnosticReport: vi.fn() }));
const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const writeText = vi.fn();
beforeEach(() => {
  vi.mocked(performHealthCheck).mockResolvedValue({ overallStatus: 'healthy', timestamp: 'fixture', recommendations: [], checks: {
    extension: { status: 'pass', version: 'fixture', environment: 'fixture' },
    storage: { status: 'pass', totalPosts: 0, totalMedia: 0, downloadedMedia: 0, failedMedia: 0, details: '' },
    xTab: { status: 'warning', tabFound: false, isLikesOrBookmarks: false, contentScriptResponding: false, visibleArticlesCount: 0, guidance: '' },
    ai: { status: 'info', mode: 'unconfigured', modelName: '', permissionGranted: false, details: '' },
  } });
  vi.mocked(generateDiagnosticReport).mockResolvedValue('{"fixture":true}');
  writeText.mockReset();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});
afterEach(() => {
  cleanup();
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

it('shows success only after the clipboard resolves, and lets a rejected copy retry', async () => {
  writeText.mockRejectedValueOnce(new Error('permission denied')).mockResolvedValue(undefined);
  render(<DiagnosticsModal isOpen onClose={() => {}} />);
  const copy = screen.getByRole('button', { name: '复制诊断内容' }) as HTMLButtonElement;
  expect(copy.disabled).toBe(true);
  await waitFor(() => expect(copy.disabled).toBe(false));
  fireEvent.click(copy);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '复制失败，请下载报告，或在 JSON 页手动复制。');
  expect(screen.queryByText('已复制')).toBeNull();
  fireEvent.click(copy);
  expect(await screen.findByText('已复制')).toBeTruthy();
  expect(writeText).toHaveBeenLastCalledWith('{"fixture":true}');
});

it('does not allow copying or downloading a failed report and can recover', async () => {
  vi.mocked(performHealthCheck).mockRejectedValueOnce(new Error('fixture failure'));
  render(<DiagnosticsModal isOpen onClose={() => {}} />);
  await screen.findByText('生成诊断报告失败，请点击「重新检测」。');
  expect((screen.getByRole('button', { name: '复制诊断内容' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: '下载报告 (JSON)' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByTitle('重新检测'));
  await waitFor(() => expect((screen.getByRole('button', { name: '下载报告 (JSON)' }) as HTMLButtonElement).disabled).toBe(false));
});
