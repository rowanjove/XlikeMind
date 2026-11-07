import { logDiagnosticError } from '../domain/diagnosticFrames';
import { SYNC_PORT_NAME } from '../messaging/syncClient';
import { handleSyncMessage, isSyncMessage, recoverProfileRuns } from './syncChannel';

console.log('[LikeMind] Background Service Worker initialized');

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[LikeMind] Extension installed or updated');
  try {
    await recoverProfileRuns();
  } catch (err) {
    logDiagnosticError('install_recovery', err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[LikeMind] Browser startup - checking recovery');
  try {
    await recoverProfileRuns();
  } catch (err) {
    logDiagnosticError('startup_recovery', err);
  }
});

function deliverSyncMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: Record<string, unknown>) => void
): boolean {
  if (!isSyncMessage(message)) return false;
  void handleSyncMessage(message, { tabId: sender.tab?.id, documentId: sender.documentId }).then(
    (response) => {
      sendResponse(response ?? { success: false, error: '没有处理这个请求' });
    },
    (err) => {
      sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  );
  // Literal true keeps the reply channel open until sendResponse runs.
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OPEN_DASHBOARD') {
    const profileId = typeof message.profileId === 'string' ? message.profileId : 'default';
    const baseUrl = chrome.runtime.getURL('dashboard.html');
    const dashboardUrl = new URL(baseUrl);
    dashboardUrl.searchParams.set('profile', profileId);
    dashboardUrl.hash = message.view === 'library' ? 'library' : '';
    void (async () => {
      const tabs = await chrome.tabs.query({ url: baseUrl + '*' });
      const existing = tabs.find((tab) => {
        if (!tab.url) return false;
        const url = new URL(tab.url);
        return (url.searchParams.get('profile') ?? 'default') === profileId;
      });
      if (existing?.id) {
        await chrome.tabs.update(existing.id, { active: true, url: dashboardUrl.toString() });
      } else {
        await chrome.tabs.create({ url: dashboardUrl.toString() });
      }
      sendResponse({ status: 'ok' });
    })().catch(() => sendResponse({ status: 'error' }));
    return true;
  }

  if (deliverSyncMessage(message, sender, sendResponse)) return true;
  // Do not return false. On current Chrome that can count as an empty reply
  // and cancel the service worker's real response.
  return undefined;
});

void recoverProfileRuns(90_000).catch((err) => {
  logDiagnosticError('stale_recovery', err);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SYNC_PORT_NAME) return;
  port.onMessage.addListener((message: unknown) => {
    const requestId =
      message && typeof message === 'object' ? (message as { requestId?: unknown }).requestId : undefined;
    const reply = (response: Record<string, unknown>) => {
      try {
        port.postMessage({ ...response, requestId });
      } catch {
        // The page can reconnect and replay its saved batch when the reply is lost.
      }
    };
    void handleSyncMessage(message, { tabId: port.sender?.tab?.id, documentId: port.sender?.documentId }).then(
      (response) => reply(response ?? { success: false, error: '没有处理这个请求' }),
      (err) => reply({ success: false, error: err instanceof Error ? err.message : String(err) }),
    );
  });
});
