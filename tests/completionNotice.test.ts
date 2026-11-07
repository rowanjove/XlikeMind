import { afterEach, expect, it, vi } from 'vitest';
import { completeCapture } from '../src/content/completionNotice';
import { saveCompletionBehavior } from '../src/storage/capturePreferences';

const stats = { scanned: 20, added: 20, updated: 0, skipped: 0, failed: 0 };
afterEach(async () => {
  document.getElementById('likemind-completion-notice')?.remove();
  await saveCompletionBehavior('notice');
});
it('shows a result on the source page even without a popup', async () => {
  await saveCompletionBehavior('notice');
  await completeCapture('default', 'partial', stats);
  expect(document.getElementById('likemind-completion-notice')).not.toBeNull();
});
it('opens the matching library only when requested and can suppress the notice', async () => {
  await saveCompletionBehavior('library', 'other');
  const send = vi.spyOn(chrome.runtime, 'sendMessage').mockResolvedValue({});
  try {
    await completeCapture('other', 'partial', stats);
    expect(send).toHaveBeenCalledWith({ type: 'OPEN_DASHBOARD', profileId: 'other', view: 'library' });
    expect(document.getElementById('likemind-completion-notice')).toBeNull();
    send.mockClear();
    await saveCompletionBehavior('none');
    await completeCapture('default', 'completed', stats);
    expect(send).not.toHaveBeenCalled();
    expect(document.getElementById('likemind-completion-notice')).toBeNull();
  } finally { send.mockRestore(); }
});
