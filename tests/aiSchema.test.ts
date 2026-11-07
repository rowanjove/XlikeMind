import { describe, it, expect } from 'vitest';
import { parseAndValidateAIResponse, AIAnalysisSchema } from '../src/ai/schema';

describe('AI Schema & Response Parsing', () => {
  it('parses pure valid JSON correctly', () => {
    const raw = JSON.stringify({
      titleZh: 'TypeScript + Vite 极速开发指南',
      summaryZh: '介绍了使用现代化脚手架构建快速前端工程的要点。',
      categories: ['编程开发'],
      tags: ['TypeScript', 'Vite'],
      contentType: 'tutorial',
      steps: ['npm install', 'npm run dev'],
      prerequisites: ['Node.js >= 18'],
      usefulLinks: ['https://vite.dev'],
      uncertainties: [],
      quality: 'high',
      confidenceNote: '根据原文提取',
    });

    const parsed = parseAndValidateAIResponse(raw);
    expect(parsed.titleZh).toBe('TypeScript + Vite 极速开发指南');
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.contentType).toBe('tutorial');
    expect(parsed.quality).toBe('high');
  });

  it('strips markdown code fences (```json ... ```)', () => {
    const raw = `
这里是分析结果：
\`\`\`json
{
  "titleZh": "带代码块的回复",
  "summaryZh": "能够自动剥离外层的 Markdown 标记。",
  "categories": ["软件工具"],
  "tags": ["CLI"],
  "contentType": "tool",
  "steps": [],
  "prerequisites": [],
  "usefulLinks": [],
  "uncertainties": ["原文未包含步骤"],
  "quality": "medium"
}
\`\`\`
希望对您有帮助！
`;

    const parsed = parseAndValidateAIResponse(raw);
    expect(parsed.titleZh).toBe('带代码块的回复');
    expect(parsed.steps).toHaveLength(0);
    expect(parsed.uncertainties).toContain('原文未包含步骤');
  });

  it('throws descriptive error on malformed JSON', () => {
    const raw = '{ titleZh: "Missing quotes", summaryZh: 123';
    expect(() => parseAndValidateAIResponse(raw)).toThrow(/无法解析为合法 JSON/);
  });

  it('throws descriptive error on schema validation failure', () => {
    // Missing required summaryZh
    const raw = JSON.stringify({
      titleZh: '只有标题没有摘要',
      categories: ['未分类'],
    });

    expect(() => parseAndValidateAIResponse(raw)).toThrow(/未通过 Schema 校验/);
  });

  it('enforces schema defaults for optional array fields', () => {
    const minimal = {
      titleZh: '最小结构',
      summaryZh: '具备基本字段',
      categories: ['综合知识'],
    };

    const validated = AIAnalysisSchema.parse(minimal);
    expect(validated.tags).toEqual([]);
    expect(validated.steps).toEqual([]);
    expect(validated.prerequisites).toEqual([]);
    expect(validated.usefulLinks).toEqual([]);
    expect(validated.uncertainties).toEqual([]);
    expect(validated.quality).toBe('medium');
    expect(validated.contentType).toBe('other');
  });
});
