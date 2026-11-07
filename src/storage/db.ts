import Dexie, { type Table } from 'dexie';
import { DEFAULT_PROFILE_ID, getPageProfileId } from './profileScope';
import type {
  NormalizedPost,
  MediaAsset,
  SyncRun,
  UserOverrides,
  AIAnalysis,
  ExportJob,
} from '../domain/types';

export class LikeMindDB extends Dexie {
  posts!: Table<NormalizedPost, string>;
  media!: Table<MediaAsset, string>;
  syncRuns!: Table<SyncRun, string>;
  userOverrides!: Table<UserOverrides, string>;
  aiAnalysis!: Table<AIAnalysis, string>;
  exportJobs!: Table<ExportJob, string>;
  folders!: Table<{
    id: string;
    handle: FileSystemDirectoryHandle;
    boundAt?: string;
    managedName?: string;
    publishedRunId?: string;
    latestSnapshot?: string;
    publishedSignature?: string;
  }, string>;

  constructor(databaseName = 'LikeMindDatabase') {
    super(databaseName);

    this.version(1).stores({
      posts: 'id, postId, postedAt, firstObservedAt, lastObservedAt, captureStatus, sourceRunId, contentHash',
      media: 'id, postId, position, status, kind',
      syncRuns: 'id, startedAt, lastCheckpointAt, status',
      userOverrides: 'postId, updatedAt, readingStatus',
      aiAnalysis: 'postId, sourceHash, status, model',
    });
    this.version(2).stores({ folders: 'id' });
    this.version(3).stores({ exportJobs: 'id, startedAt' });
  }
}

const databases = new Map<string, LikeMindDB>();

export function getProfileDatabase(profileId: string): LikeMindDB {
  const existing = databases.get(profileId);
  if (existing) return existing;
  const database = new LikeMindDB(profileId === DEFAULT_PROFILE_ID ? 'LikeMindDatabase' : `LikeMindProfile-${profileId}`);
  databases.set(profileId, database);
  return database;
}

export async function deleteProfileDatabase(profileId: string): Promise<void> {
  const database = getProfileDatabase(profileId);
  databases.delete(profileId);
  await database.delete();
}

export const db = getProfileDatabase(getPageProfileId());
