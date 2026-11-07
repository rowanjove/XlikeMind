const MAX_FRAMES = 4;
const FRAME = /^(?:(?:assets\/(?:App|Popup|dashboard|popup|index|profiles|libraryFolder|syncService|useDialogFocus)-[\w-]{8})|background|content)\.js:\d{1,8}:\d{1,8}$/;

export function safeDiagnosticFrames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return;
  const frames = [...new Set(value.filter((frame): frame is string => typeof frame === 'string' && FRAME.test(frame)))]
    .slice(0, MAX_FRAMES);
  return frames.length ? frames : undefined;
}

export function captureDiagnosticFrames(error: unknown): string[] | undefined {
  if (!(error instanceof Error) || typeof error.stack !== 'string' || typeof chrome === 'undefined') return;
  const root = chrome.runtime?.getURL?.('');
  if (!root?.startsWith('chrome-extension://') || !root.endsWith('/')) return;
  const frames = error.stack.split(/\r?\n/).slice(1).flatMap((line) => {
    const location = /^\s*at (?:.+? \()?([^\s()]+)\)?$/.exec(line)?.[1];
    return location?.startsWith(root) ? [location.slice(root.length)] : [];
  });
  return safeDiagnosticFrames(frames);
}

/** Runtime logs keep event codes and packaged stack locations only. */
export function logDiagnosticError(
  event: 'parse_post' | 'import_archive' | 'import_local_record' | 'parse_local_file' |
    'sync_item' | 'popup_recovery' | 'install_recovery' | 'startup_recovery' | 'stale_recovery',
  error: unknown,
  level: 'warn' | 'error' = 'error',
): void {
  console[level]('[LikeMind]', event, captureDiagnosticFrames(error) ?? []);
}
