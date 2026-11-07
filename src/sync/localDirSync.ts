import { logDiagnosticError } from '../domain/diagnosticFrames';
import { db } from '../storage/db';
import type { NormalizedPost, SyncStats } from '../domain/types';
import { calculateContentHash } from '../domain/hash';
import { mergeNormalizedPost } from '../domain/merge';
import { sanitizeUrl } from '../domain/sanitize';

export interface LocalSyncOptions {
  incrementalOnly?: boolean;
  onProgress?: (stats: SyncStats, currentItem?: string) => void;
  signal?: AbortSignal;
}

export interface LocalSyncResult {
  success: boolean;
  stats: SyncStats;
  message: string;
  sourceDirectory?: string;
}

export interface LocalPostRecord {
  id?: string;
  postId: string;
  authorHandle: string;
  authorDisplayName?: string;
  authorAvatarUrl?: string;
  text: string;
  postedAt?: string | null;
  canonicalUrl?: string;
  mediaUrls?: string[];
  externalLinks?: string[];
}

/**
 * Standard interface for syncing posts from local directories/files into Dexie DB.
 * Reserved for native filesystem integration or File System Access API.
 */
export interface LocalDirectorySyncInterface {
  syncFromLocalDirectory(
    source: FileSystemDirectoryHandle | FileList | File[] | LocalPostRecord[],
    options?: LocalSyncOptions
  ): Promise<LocalSyncResult>;

  testDirectoryAccess?(pathOrHandle: unknown): Promise<boolean>;
}

export class LocalDirectorySyncService implements LocalDirectorySyncInterface {
  /**
   * Ingest raw post records from local directory / files into IndexedDB incrementally.
   * Skips records that already exist with the same contentHash.
   */
  async ingestLocalRecords(
    records: LocalPostRecord[],
    options?: LocalSyncOptions
  ): Promise<LocalSyncResult> {
    const stats: SyncStats = {
      scanned: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    };

    const nowIso = new Date().toISOString();
    const runId = `local_sync_${Date.now()}`;

    for (const raw of records) {
      if (options?.signal?.aborted) {
        break;
      }

      stats.scanned++;
      const cleanPostId = (raw.postId || '').trim();
      if (!/^[\w-]{1,40}$/.test(cleanPostId)) {
        stats.failed++;
        continue;
      }

      try {
        const id = `x:${cleanPostId}`;
        const text = raw.text || '';
        const mediaUrls = (raw.mediaUrls || []).map((u) => sanitizeUrl(u)).filter(Boolean);
        const externalLinks = (raw.externalLinks || []).map((u) => sanitizeUrl(u)).filter(Boolean);
        const contentHash = await calculateContentHash({
          text,
          authorHandle: raw.authorHandle || '',
          mediaUrls,
        });
        const author =
          raw.authorHandle || raw.authorDisplayName
            ? {
                handle: raw.authorHandle || undefined,
                displayName: raw.authorDisplayName || undefined,
                avatarUrl: raw.authorAvatarUrl ? sanitizeUrl(raw.authorAvatarUrl) || undefined : undefined,
              }
            : undefined;

        const post: NormalizedPost = {
          id,
          platform: 'x',
          postId: cleanPostId,
          canonicalUrl:
            sanitizeUrl(raw.canonicalUrl || '') ||
            `https://x.com/i/web/status/${encodeURIComponent(cleanPostId)}`,
          author,
          text,
          postedAt: raw.postedAt || null,
          likedAt: null,
          firstObservedAt: nowIso,
          lastObservedAt: nowIso,
          captureStatus: text.trim() ? 'complete' : 'partial',
          missingFields: text.trim() ? [] : ['text'],
          externalLinks,
          mediaIds: mediaUrls.map((_, i) => `${cleanPostId}_media_${i}`),
          contentHash,
          sourceAdapter: 'local_directory',
          sourceRunId: runId,
          schemaVersion: 1,
        };

        const existing = await db.posts.get(post.id);
        if (!existing) {
          await db.posts.put(post);
          stats.added++;
        } else {
          const { merged, isUpdated } = mergeNormalizedPost(existing, post);
          if (isUpdated) {
            await db.posts.put(merged);
            stats.updated++;
          } else {
            // Already synced and content unchanged: skip
            stats.skipped++;
          }
        }

        options?.onProgress?.(stats, post.id);
      } catch (err) {
        logDiagnosticError('import_local_record', err);
        stats.failed++;
      }
    }

    return {
      success: stats.failed === 0 || stats.added > 0 || stats.skipped > 0,
      stats,
      message: `本地同步完成：扫描 ${stats.scanned} 篇，新增 ${stats.added} 篇，跳过已有 ${stats.skipped} 篇，更新 ${stats.updated} 篇。`,
    };
  }

  /**
   * Main entry point to sync from local directory or files.
   * Parses JSON / metadata from directory or file list and writes incrementally into DB.
   */
  async syncFromLocalDirectory(
    source: FileSystemDirectoryHandle | FileList | File[] | LocalPostRecord[],
    options?: LocalSyncOptions
  ): Promise<LocalSyncResult> {
    // If already normalized objects
    if (Array.isArray(source) && source.length > 0 && typeof (source[0] as LocalPostRecord).postId === 'string') {
      return this.ingestLocalRecords(source as LocalPostRecord[], options);
    }

    // If array of Files or FileList
    const files: File[] =
      source instanceof FileList
        ? Array.from(source)
        : Array.isArray(source) && source[0] instanceof File
        ? (source as File[])
        : [];

    if (files.length > 0) {
      const records: LocalPostRecord[] = [];
      for (const file of files) {
        if (file.name.endsWith('.json')) {
          try {
            const content = await file.text();
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
              records.push(...parsed);
            } else if (parsed && typeof parsed.postId === 'string') {
              records.push(parsed);
            }
          } catch (err) {
            logDiagnosticError('parse_local_file', err, 'warn');
          }
        }
      }
      return this.ingestLocalRecords(records, options);
    }

    // If FileSystemDirectoryHandle (HTML5 File System Access API)
    if (typeof source === 'object' && source !== null && 'values' in source) {
      const records: LocalPostRecord[] = [];
      try {
        const handle = source as unknown as { values(): AsyncIterable<{ kind: string; name: string; getFile(): Promise<File> }> };
        for await (const entry of handle.values()) {
          if (entry.kind === 'file' && entry.name.endsWith('.json')) {
            const file = await entry.getFile();
            const content = await file.text();
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
              records.push(...parsed);
            } else if (parsed && typeof parsed.postId === 'string') {
              records.push(parsed);
            }
          }
        }
        return this.ingestLocalRecords(records, options);
      } catch (err) {
        return {
          success: false,
          stats: { scanned: 0, added: 0, updated: 0, skipped: 0, failed: 1 },
          message: `读取本地目录失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return {
      success: true,
      stats: { scanned: 0, added: 0, updated: 0, skipped: 0, failed: 0 },
      message: '本地目录接口已就绪，未找到待导入的推文文件。',
    };
  }
}

export const localDirectorySync = new LocalDirectorySyncService();
