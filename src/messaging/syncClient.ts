export const SYNC_PORT_NAME = 'xlike-sync';

export interface SyncPort {
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface SyncReply {
  success: boolean;
  transportError?: 'disconnected' | 'timeout';
  runId?: string;
  status?: string;
  error?: string;
  added?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
  scanned?: number;
  targetLimit?: number;
  seenPostIds?: string[];
  resumePostIds?: string[];
}

interface PendingReply {
  port?: SyncPort;
  resolve: (value: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function explainSaveError(raw: string | undefined): string {
  const text = raw?.trim() || '';
  if (!text) return '扩展后台没有开始这次保存';
  if (/Receiving end does not exist|Could not establish connection|Extension context invalidated/i.test(text)) {
    return '扩展后台没连上。请在 chrome://extensions 重新加载 XlikeMind，再刷新这个页面。';
  }
  if (/message port closed|disconnected/i.test(text)) {
    return '和扩展后台的连接断了。请重新加载扩展后再读一次。';
  }
  return text;
}

/**
 * Content scripts talk to the service worker through a port.
 * One-shot sendMessage can resolve to null on current Chrome when another
 * listener answers first, which showed up as "无法开始保存".
 */
export function createSyncClient(connect: () => SyncPort, disconnectReason: () => string | undefined) {
  let port: SyncPort | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingReply>();

  function bind(next: SyncPort): void {
    next.onMessage.addListener((message: unknown) => {
      const record = asRecord(message);
      const requestId = record.requestId;
      if (typeof requestId !== 'number') return;
      const item = pending.get(requestId);
      if (item?.port !== next) return;
      clearTimeout(item.timer);
      pending.delete(requestId);
      item.resolve(record);
    });
    next.onDisconnect.addListener(() => {
      if (port === next) port = null;
      const error = disconnectReason() || '和扩展后台的连接断了';
      for (const [requestId, item] of pending) {
        if (item.port !== next) continue;
        clearTimeout(item.timer);
        pending.delete(requestId);
        item.resolve({ success: false, error, transportError: 'disconnected' });
      }
    });
  }

  function ensurePort(): SyncPort {
    if (port) return port;
    const next = connect();
    bind(next);
    port = next;
    return next;
  }

  function request(payload: Record<string, unknown>, timeoutMs = 20000): Promise<SyncReply> {
    const requestId = nextId++;
    return new Promise((resolve) => {
      const finish = (record: Record<string, unknown>) => {
        const stats = asRecord(record.stats);
        resolve({
          success: Boolean(record.success),
          status: typeof record.status === 'string' ? record.status : undefined,
          transportError: record.transportError === 'timeout' || record.transportError === 'disconnected'
            ? record.transportError : undefined,
          runId: typeof record.runId === 'string' ? record.runId : undefined,
          error: typeof record.error === 'string' ? explainSaveError(record.error) : undefined,
          added: typeof stats.added === 'number' ? stats.added : undefined,
          updated: typeof stats.updated === 'number' ? stats.updated : undefined,
          skipped: typeof stats.skipped === 'number' ? stats.skipped : undefined,
          failed: typeof stats.failed === 'number' ? stats.failed : undefined,
          scanned: typeof stats.scanned === 'number' ? stats.scanned : undefined,
          targetLimit: typeof record.targetLimit === 'number' ? record.targetLimit : undefined,
          seenPostIds: Array.isArray(record.seenPostIds)
            ? record.seenPostIds.filter((id): id is string => typeof id === 'string' && /^\d{1,25}$/.test(id)).slice(-2000)
            : undefined,
          resumePostIds: Array.isArray(record.resumePostIds)
            ? record.resumePostIds.filter((id): id is string => typeof id === 'string' && /^\d{1,25}$/.test(id)).slice(0, 8)
            : undefined,
        });
      };

      const timer = setTimeout(() => {
        pending.delete(requestId);
        finish({ success: false, error: '等待扩展后台应答超时', transportError: 'timeout' });
      }, timeoutMs);
      const pendingReply: PendingReply = { resolve: finish, timer };
      pending.set(requestId, pendingReply);

      const send = () => {
        const next = ensurePort();
        pendingReply.port = next;
        next.postMessage({ ...payload, requestId });
      };
      try {
        send();
      } catch {
        port = null;
        try {
          send();
        } catch (err) {
          clearTimeout(timer);
          pending.delete(requestId);
          finish({ success: false, error: err instanceof Error ? err.message : String(err), transportError: 'disconnected' });
        }
      }
    });
  }

  return { request };
}
