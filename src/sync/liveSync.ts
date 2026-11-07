import type { SyncRun, SyncStatus } from '../domain/types';
import { DEFAULT_PROFILE_ID, profileStorageKey } from '../storage/profileScope';

export const LIVE_SYNC_KEY = 'likemind_live_sync';
export const FRESH_CAPTURE_MS = 90_000;

export type SyncPhase = 'reading' | 'saving' | 'repairing' | 'finishing';

/** Popup progress only. Never store post text, cookies, or media bytes. */
export interface LiveSyncSnapshot {
  runId: string;
  status: SyncStatus;
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
  failed: number;
  targetLimit: number;
  failureCode?: string;
  phase?: SyncPhase;
  message?: string;
  updatedAt: string;
}

export function hasFixedResumeLimit(run?: Pick<SyncRun, 'status' | 'failureCode'> | null): boolean {
  return run?.status === 'paused' && (run.failureCode === 'interrupted' || run.failureCode === 'save_interrupted');
}

export function snapshotFromRun(run: SyncRun, phase?: SyncPhase): LiveSyncSnapshot {
  return {
    runId: run.id,
    status: run.status,
    scanned: run.stats.scanned,
    added: run.stats.added,
    updated: run.stats.updated,
    skipped: run.stats.skipped,
    failed: run.stats.failed,
    targetLimit: run.targetLimit,
    failureCode: run.failureCode,
    phase,
    message: run.failureMessage,
    updatedAt: new Date().toISOString(),
  };
}

export async function publishLiveSnapshot(
  snapshot: LiveSyncSnapshot,
  profileId = DEFAULT_PROFILE_ID
): Promise<void> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local?.set) return;
    await chrome.storage.local.set({ [profileStorageKey(LIVE_SYNC_KEY, profileId)]: { ...snapshot } });
  } catch {
    // The popup can fall back to a fresh probe. Saving posts must not depend on this.
  }
}
