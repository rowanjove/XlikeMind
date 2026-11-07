import { describe, expect, it } from 'vitest';
import { buildUserOverrides, normalizeLabelList } from '../src/domain/overrides';
import { getPostTopics } from '../src/domain/topics';
import { PROMPT_VERSION } from '../src/domain/analysis';
import type { AIAnalysis, NormalizedPost, UserOverrides } from '../src/domain/types';

const post = {
  id: 'x:1',
  text: '这是一篇足够长的说明，用来确认没有手工分类时仍使用整理结果。',
  mediaIds: [],
  contentHash: 'hash',
} as unknown as NormalizedPost;

const ai: AIAnalysis = {
  postId: 'x:1',
  sourceHash: 'hash',
  model: 'mock',
  promptVersion: PROMPT_VERSION,
  status: 'complete',
  categories: ['编程开发'],
  tags: ['Vite'],
};

describe('manual category overrides', () => {
  it('trims labels, splits both comma styles, and drops duplicates', () => {
    expect(normalizeLabelList(['  编程开发 ', '编程开发', '', 'a'.repeat(50)])).toEqual([
      '编程开发',
      'a'.repeat(40),
    ]);

    const row = buildUserOverrides({
      postId: 'x:1',
      customTitle: '  我的标题 ',
      customTags: '前端, 前端，Vite',
      categories: ['设计/UI', ' 设计/UI '],
      notes: ' 留给自己 ',
      readingStatus: 'to_practice',
      updatedAt: '2026-10-31T00:00:00.000Z',
    });

    expect(row.customTitle).toBe('我的标题');
    expect(row.customTags).toEqual(['前端', 'Vite']);
    expect(row.customCategories).toEqual(['设计/UI']);
    expect(row.notes).toBe('留给自己');
    expect(row.readingStatus).toBe('to_practice');
  });

  it('omits an empty category list so the AI categories apply again', () => {
    const row = buildUserOverrides({
      postId: 'x:1',
      customTitle: '   ',
      customTags: ' , ， ',
      categories: [' ', ''],
      notes: '',
      readingStatus: 'to_read',
      updatedAt: '2026-10-31T00:00:00.000Z',
    });

    expect(row.customCategories).toBeUndefined();
    expect(row.customTags).toBeUndefined();
    expect(row.customTitle).toBeUndefined();

    const topics = getPostTopics(post, row, ai);
    expect(topics).toEqual(['编程开发']);
  });

  it('keeps a saved category ahead of a later AI category', () => {
    const saved: UserOverrides = {
      postId: 'x:1',
      customCategories: ['设计/UI'],
      updatedAt: '2026-10-31T00:00:00.000Z',
    };
    expect(getPostTopics(post, saved, ai)).toEqual(['设计/UI']);
  });
});
