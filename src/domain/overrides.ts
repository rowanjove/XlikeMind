import type { ReadingStatus, UserOverrides } from './types';

/** Trim, drop blanks, and keep the first copy of each name. */
export function normalizeLabelList(names: string[], maxLength = 40): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of names) {
    const name = raw.replace(/\s+/g, ' ').trim().slice(0, maxLength);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

/**
 * User edits win over AI. An empty category list means "no manual override",
 * so the next view falls back to the AI categories without deleting the note.
 */
export function buildUserOverrides(input: {
  postId: string;
  customTitle: string;
  customTags: string;
  categories: string[];
  notes: string;
  readingStatus: ReadingStatus;
  updatedAt?: string;
}): UserOverrides {
  const customTags = normalizeLabelList(input.customTags.split(/[,，]/));
  const customCategories = normalizeLabelList(input.categories);
  return {
    postId: input.postId,
    customTitle: input.customTitle.trim() || undefined,
    customTags: customTags.length > 0 ? customTags : undefined,
    customCategories: customCategories.length > 0 ? customCategories : undefined,
    notes: input.notes.trim() || undefined,
    readingStatus: input.readingStatus,
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}
