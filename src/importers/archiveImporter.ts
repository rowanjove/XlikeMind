import { logDiagnosticError } from '../domain/diagnosticFrames';
import JSZip from 'jszip';
import Dexie from 'dexie';
import { db, type LikeMindDB } from '../storage/db';
import type { NormalizedPost, SyncStats, MediaAsset } from '../domain/types';
import { calculateContentHash, calculateMergedContentHash } from '../domain/hash';
import { mergeNormalizedPost } from '../domain/merge';
import { isOwnStatusPermalink, sanitizeUrl } from '../domain/sanitize';

const LIKE_ENTRY = /(^|\/)(like|likes)(-part\d+)?\.(js|json)$/i;
const TWEET_ENTRY = /(^|\/)tweets(-part\d+)?\.(js|json)$/i;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_PART_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ITEMS = 500_000;

function readArchivePart(entry: JSZip.JSZipObject, countBytes: (bytes: number) => void): Promise<string> {
  // JSZip exposes the decoded stream at runtime. Count bytes before retaining chunks.
  const stream = (entry as JSZip.JSZipObject & {
    internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
  }).internalStream('uint8array');
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    stream.on('data', (chunk) => {
      try {
        bytes += chunk.byteLength;
        if (bytes > MAX_PART_BYTES) throw new Error('单个归档分卷超过 32 MiB，请拆分后导入。');
        countBytes(chunk.byteLength);
        chunks.push(decoder.decode(chunk, { stream: true }));
      } catch (error) {
        stream.pause();
        reject(error);
      }
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(chunks.join('') + decoder.decode()));
    stream.resume();
  });
}

function numericPostId(value: unknown): string {
  const id = String(value ?? '').trim();
  return /^\d{1,25}$/.test(id) ? id : '';
}

function partOrder(path: string): number {
  const match = path.match(/-part(\d+)\.(?:js|json)$/i);
  return match ? Number(match[1]) : 0;
}

function permalinkFor(postId: string, candidate?: string): string {
  const safe = candidate ? sanitizeUrl(candidate) : '';
  if (safe && isOwnStatusPermalink(safe, postId)) return safe;
  return `https://x.com/i/web/status/${postId}`;
}

function outboundLinks(postId: string, urls: unknown[]): string[] {
  const links: string[] = [];
  for (const url of urls) {
    if (typeof url !== 'string') continue;
    const safe = sanitizeUrl(url);
    if (!safe || isOwnStatusPermalink(safe, postId) || links.includes(safe)) continue;
    links.push(safe);
  }
  return links;
}

export interface RawArchiveItem {
  postId: string;
  text: string;
  authorHandle?: string;
  authorDisplayName?: string;
  canonicalUrl?: string;
  postedAt?: string | null;
  externalLinks?: string[];
  mediaUrls?: string[];
}

export interface ArchiveImportResult {
  success: boolean;
  status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
  stats: SyncStats;
  message: string;
}

/**
 * Safely parse JavaScript archive text containing window.YTD.* = [...]
 * Strictly avoids eval(), strips prefix using regex, and safely parses JSON.
 */
export function parseArchiveJsText(rawText: string): unknown[] {
  if (!rawText || !rawText.trim()) return [];

  let jsonStr = rawText.trim();
  // Strip window.YTD.like.part0 = or window.YTD.tweets.part0 = or similar assignments
  const assignMatch = jsonStr.match(/^[a-zA-Z0-9_$.]+\s*=\s*(\[[\s\S]*\]);?\s*$/);
  if (assignMatch && assignMatch[1]) {
    jsonStr = assignMatch[1];
  } else {
    // Look for outermost square brackets
    const firstBracket = jsonStr.indexOf('[');
    const lastBracket = jsonStr.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      jsonStr = jsonStr.substring(firstBracket, lastBracket + 1);
    }
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    throw new Error(`无法解析 X 归档数据，文件非合法 JSON/JS 数据: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Parse date strings like "Sun Oct 18 14:30:00 +0000 2026" or ISO strings to ISO 8601.
 */
export function parseTwitterDate(dateStr?: string | null): string | null {
  if (!dateStr || !dateStr.trim()) return null;
  try {
    const d = new Date(dateStr);
    return !isNaN(d.getTime()) ? d.toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * Transform parsed objects (like.js or tweets.js format) to RawArchiveItem array.
 */
export function extractArchiveItems(rawItems: unknown[]): RawArchiveItem[] {
  const result: RawArchiveItem[] = [];

  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;

    // Case 1: like.js -> { like: { tweetId, fullText, expandedUrl } }
    if (record.like && typeof record.like === 'object') {
      const l = record.like as Record<string, unknown>;
      const postId = numericPostId(l.tweetId);
      if (!postId) continue;

      const expandedUrl = typeof l.expandedUrl === 'string' ? l.expandedUrl : '';
      const text = typeof l.fullText === 'string' ? l.fullText : '';

      result.push({
        postId,
        text,
        canonicalUrl: permalinkFor(postId, expandedUrl),
        postedAt: null, // likes archive usually does not have reliable post creation time
        externalLinks: outboundLinks(postId, expandedUrl ? [expandedUrl] : []),
        mediaUrls: [],
      });
      continue;
    }

    // Case 2: tweets.js -> { tweet: { id_str, full_text, created_at, entities } }
    if (record.tweet && typeof record.tweet === 'object') {
      const t = record.tweet as Record<string, unknown>;
      const postId = numericPostId(t.id_str || t.id);
      if (!postId) continue;

      const text = typeof t.full_text === 'string' ? t.full_text : '';
      const postedAt = parseTwitterDate(typeof t.created_at === 'string' ? t.created_at : null);

      // Extract external links and media from entities
      const externalLinks: string[] = [];
      const mediaUrls: string[] = [];
      const entities = (t.entities && typeof t.entities === 'object' ? t.entities : {}) as Record<string, unknown>;

      if (Array.isArray(entities.urls)) {
        for (const u of entities.urls) {
          const exp = (u as Record<string, unknown>)?.expanded_url;
          if (typeof exp === 'string') {
            const safe = sanitizeUrl(exp);
            if (safe && !externalLinks.includes(safe)) externalLinks.push(safe);
          }
        }
      }

      if (Array.isArray(entities.media)) {
        for (const m of entities.media) {
          const mediaUrl = (m as Record<string, unknown>)?.media_url_https || (m as Record<string, unknown>)?.media_url;
          if (typeof mediaUrl === 'string') {
            const safe = sanitizeUrl(mediaUrl);
            if (safe && !mediaUrls.includes(safe)) mediaUrls.push(safe);
          }
        }
      }

      result.push({
        postId,
        text,
        canonicalUrl: permalinkFor(postId),
        postedAt,
        externalLinks: outboundLinks(postId, externalLinks),
        mediaUrls,
      });
      continue;
    }

    // Case 3: Flat object with postId/id and text
    const flatId = numericPostId(record.tweetId || record.postId || record.id);
    if (flatId) {
      const flatText = typeof record.text === 'string' ? record.text : typeof record.fullText === 'string' ? record.fullText : '';
      const flatPostedAt = parseTwitterDate(typeof record.postedAt === 'string' ? record.postedAt : typeof record.created_at === 'string' ? record.created_at : null);
      result.push({
        postId: flatId,
        text: flatText,
        canonicalUrl: permalinkFor(
          flatId,
          typeof record.canonicalUrl === 'string' ? record.canonicalUrl : undefined
        ),
        postedAt: flatPostedAt,
        externalLinks: outboundLinks(
          flatId,
          Array.isArray(record.externalLinks) ? record.externalLinks : []
        ),
        mediaUrls: Array.isArray(record.mediaUrls)
          ? record.mediaUrls.filter((url): url is string => typeof url === 'string').map(sanitizeUrl).filter(Boolean)
          : [],
      });
    }
  }

  return result;
}

/**
 * Reads an uploaded X Archive ZIP or single JS/JSON file and returns RawArchiveItem list.
 */
export async function parseArchiveFile(file: File | Blob): Promise<RawArchiveItem[]> {
  const fileName = 'name' in file && typeof file.name === 'string' ? file.name : '';
  const isZip = file.type.includes('zip') || fileName.toLowerCase().endsWith('.zip');
  if (file.size > (isZip ? MAX_ARCHIVE_BYTES : MAX_PART_BYTES)) {
    throw new Error('归档文件过大，请拆分后导入。');
  }

  if (isZip) {
    const zip = await JSZip.loadAsync(file);
    const found: Array<{ path: string; kind: 'like' | 'tweet' }> = [];
    for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) continue;
      const normalized = relativePath.replace(/\\/g, '/');
      if (LIKE_ENTRY.test(normalized)) found.push({ path: relativePath, kind: 'like' });
      else if (TWEET_ENTRY.test(normalized)) found.push({ path: relativePath, kind: 'tweet' });
    }

    const likes = found.filter((entry) => entry.kind === 'like');
    const chosen = (likes.length > 0 ? likes : found).sort(
      (a, b) => partOrder(a.path) - partOrder(b.path) || a.path.localeCompare(b.path)
    );
    if (chosen.length === 0) {
      throw new Error('未在 ZIP 压缩包中找到 data/like.js 或 data/tweets.js，请确认这是官方导出的 Twitter 数据包。');
    }

    const items: RawArchiveItem[] = [];
    let expandedBytes = 0;
    for (const entry of chosen) {
      const zipEntry = zip.file(entry.path);
      if (!zipEntry) continue;
      const text = await readArchivePart(zipEntry, (bytes) => {
        expandedBytes += bytes;
        if (expandedBytes > MAX_ARCHIVE_BYTES) throw new Error('解压后的归档数据超过 128 MiB，请拆分后导入。');
      });
      for (const item of extractArchiveItems(parseArchiveJsText(text))) {
        if (items.length >= MAX_ARCHIVE_ITEMS) throw new Error('归档超过 50 万条，请拆分后导入。');
        items.push(item);
      }
    }
    return items;
  }

  // Single .js or .json file
  const text = await (file as Blob).text();
  const rawObjects = parseArchiveJsText(text);
  const items = extractArchiveItems(rawObjects);
  if (items.length > MAX_ARCHIVE_ITEMS) throw new Error('归档超过 50 万条，请拆分后导入。');
  return items;
}

async function markAnalysisStale(database: LikeMindDB, postId: string, contentHash: string): Promise<void> {
  const existing = await database.aiAnalysis.get(postId);
  if (!existing || existing.sourceHash === contentHash) return;
  if (existing.status !== 'complete' && existing.status !== 'failed') return;
  await database.aiAnalysis.put({
    ...existing,
    status: 'stale',
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Ingests extracted archive items into IndexedDB with idempotency,
 * field-level merging, and checkpointing.
 */
export async function importArchiveItems(
  items: RawArchiveItem[],
  options?: {
    database?: LikeMindDB;
    signal?: AbortSignal;
    onProgress?: (stats: SyncStats, currentId?: string) => void;
  }
): Promise<ArchiveImportResult> {
  const database = options?.database || db;
  const stats: SyncStats = {
    scanned: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  const nowIso = new Date().toISOString();
  const runId = `archive_import_${crypto.randomUUID()}`;

  // Create sync run record
  await database.syncRuns.put({
    id: runId,
    startedAt: nowIso,
    lastCheckpointAt: nowIso,
    status: 'running',
    stats: { ...stats },
    targetLimit: items.length,
    downloadMedia: false,
    adapterType: 'x_archive',
  });

  const checkpoint = async (outcome: Exclude<keyof SyncStats, 'scanned'>, changedId?: string) => {
    const next = { ...stats, scanned: stats.scanned + 1, [outcome]: stats[outcome] + 1 };
    const updated = await database.syncRuns.where('id').equals(runId).filter((run) => run.status === 'running').modify((run) => {
      run.stats = next;
      run.lastCheckpointAt = new Date().toISOString();
      if (changedId && !run.changedPostIds?.includes(changedId)) (run.changedPostIds ??= []).push(changedId);
    });
    return updated ? next : undefined;
  };

  let aborted = false;
  let interrupted = false;
  for (const raw of items) {
    if (options?.signal?.aborted) {
      aborted = true;
      break;
    }
    const cleanId = numericPostId(raw.postId);
    if (!cleanId) {
      const saved = await checkpoint('failed');
      if (!saved) {
        interrupted = true;
        break;
      }
      Object.assign(stats, saved);
      options?.onProgress?.(stats);
      continue;
    }

    let committed: SyncStats | undefined;
    try {
      const id = `x:${cleanId}`;
      const mediaUrls = (raw.mediaUrls || []).map((url) => sanitizeUrl(url)).filter((url) => url.length > 0);
      const externalLinks = raw.externalLinks || [];
      const sourceLinks = outboundLinks(cleanId, externalLinks);
      const contentHash = await calculateContentHash({
        text: raw.text,
        authorHandle: raw.authorHandle || '',
        mediaUrls,
        externalLinks: sourceLinks,
      });

      const post: NormalizedPost = {
        id,
        platform: 'x',
        postId: cleanId,
        canonicalUrl: permalinkFor(cleanId, raw.canonicalUrl),
        author: {
          handle: raw.authorHandle,
          displayName: raw.authorDisplayName,
        },
        text: raw.text,
        postedAt: raw.postedAt || null,
        likedAt: null, // Cannot guess liked time; strictly null
        firstObservedAt: nowIso,
        lastObservedAt: nowIso,
        captureStatus: raw.text.trim() ? 'complete' : 'partial',
        missingFields: raw.text.trim() ? [] : ['text'],
        externalLinks: sourceLinks,
        mediaIds: mediaUrls.map((_, i) => `${cleanId}_media_${i}`),
        contentHash,
        sourceAdapter: 'x_archive',
        sources: ['x_archive'],
        sourceRunId: runId,
        schemaVersion: 1,
      };

      committed = await database.transaction('rw', [database.posts, database.media, database.aiAnalysis, database.syncRuns], async () => {
        if ((await database.syncRuns.get(runId))?.status !== 'running') return undefined;
        if (options?.signal?.aborted) return undefined;
        const existing = await database.posts.get(post.id);
        // A text archive cannot establish that its attachment sequence supersedes a live capture.
        const incoming = existing?.mediaIds.length ? { ...post, mediaIds: existing.mediaIds } : post;
        const { merged, isUpdated } = existing
          ? mergeNormalizedPost(existing, incoming, { replaceCompleteEdits: false })
          : { merged: post, isUpdated: true };
        let savedMediaUrls = mediaUrls;
        if (!existing?.mediaIds.length) {
          const assets: MediaAsset[] = mediaUrls.map((sourceUrl, position) => ({
            id: post.mediaIds[position],
            postId: post.id,
            position,
            kind: 'image',
            sourceUrl,
            status: 'remote_only',
          }));
          for (const asset of assets) {
            const saved = await database.media.get(asset.id);
            if (saved?.sourceUrl !== asset.sourceUrl) await database.media.put(asset);
          }
        } else {
          const saved = await database.media.where('postId').equals(post.id).sortBy('position');
          savedMediaUrls = saved.map((asset) => asset.sourceUrl);
        }

        merged.contentHash = await Dexie.waitFor(calculateMergedContentHash(
          merged, savedMediaUrls, post, mediaUrls,
          existing ? { post: existing, mediaUrls: existing.mediaIds.length ? savedMediaUrls : [] } : undefined,
        ));
        const hashChanged = existing && merged.contentHash !== existing.contentHash;
        await database.posts.put(merged);
        if (hashChanged) await markAnalysisStale(database, post.id, merged.contentHash);
        const outcome = existing ? (isUpdated || hashChanged ? 'updated' : 'skipped') : 'added';
        return checkpoint(outcome, hashChanged ? post.id : undefined);
      });
    } catch (err) {
      if (options?.signal?.aborted) {
        aborted = true;
        break;
      }
      logDiagnosticError('import_archive', err);
      committed = await checkpoint('failed');
    }
    if (!committed) {
      aborted = options?.signal?.aborted === true;
      interrupted = !aborted;
      break;
    }
    Object.assign(stats, committed);
    options?.onProgress?.(stats, cleanId);
  }

  // Update sync run
  const status = aborted ? 'cancelled' : stats.failed === 0 ? 'completed'
    : stats.scanned === stats.failed ? 'failed' : 'partial';
  const endIso = new Date().toISOString();
  const finalized = await database.syncRuns.where('id').equals(runId).filter((run) => run.status === 'running').modify({
    lastCheckpointAt: endIso,
    endedAt: endIso,
    status,
    stats: { ...stats },
    failureCode: aborted ? 'cancelled' : stats.failed > 0 ? 'import_failed' : undefined,
    failureMessage: aborted ? '导入已取消，已经写入的条目都还在。'
      : stats.failed > 0 ? `${stats.failed} 篇归档条目无法保存。` : undefined,
  });
  interrupted ||= finalized === 0;

  const resultStatus = interrupted ? 'interrupted' : status;
  const summary = `扫描 ${stats.scanned} 篇，新增 ${stats.added} 篇，更新 ${stats.updated} 篇，跳过已有 ${stats.skipped} 篇，失败 ${stats.failed} 篇。`;
  const message = resultStatus === 'interrupted'
    ? '导入已中断，已写入的帖子仍在文库。可重新选择同一归档，已存在的内容会去重。'
    : resultStatus === 'cancelled'
    ? `导入已取消：新增 ${stats.added} 篇，更新 ${stats.updated} 篇。已经写入的条目都还在。`
    : `归档导入${resultStatus === 'completed' ? '完成' : resultStatus === 'partial' ? '部分完成' : '失败'}：${summary}`;

  return {
    success: resultStatus === 'completed' || resultStatus === 'partial',
    status: resultStatus,
    stats,
    message,
  };
}
