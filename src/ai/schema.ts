import { z } from 'zod';

export const AIAnalysisSchema = z.object({
  titleZh: z
    .string()
    .min(1, '标题不能为空')
    .describe('简明扼要的中文标题'),
  summaryZh: z
    .string()
    .min(1, '摘要不能为空')
    .describe('1-3句话的核心中文知识提炼摘要'),
  categories: z
    .array(z.string())
    .min(1, '至少选择或归纳一个分类')
    .default(['综合知识'])
    .describe('一级或核心主题分类，如 AI/Agent, 前端开发, 开源项目, 软件工具 等'),
  tags: z
    .array(z.string())
    .default([])
    .describe('相关的技术或知识标签'),
  contentType: z
    .enum(['tutorial', 'project', 'tool', 'news', 'opinion', 'other'])
    .default('other')
    .describe('内容类型：教程、开源项目、工具、资讯、观点或其他'),
  steps: z
    .array(z.string())
    .default([])
    .describe('核心操作步骤或要点。若原文无具体步骤，必须为空数组，严禁凭空捏造！'),
  prerequisites: z
    .array(z.string())
    .default([])
    .describe('使用前置条件、依赖环境或工具需求'),
  usefulLinks: z
    .array(z.string())
    .default([])
    .describe('正文中提及或推导的 GitHub 仓库、在线演示或参考文档链接'),
  uncertainties: z
    .array(z.string())
    .default([])
    .describe('信息缺失说明或待核实事项，例如“原文未提供具体配置”、“步骤缺乏版本号说明”等'),
  risksAndLimits: z.array(z.string()).default([]).describe('原文明确提到的风险或限制'),
  quality: z
    .enum(['high', 'medium', 'low'])
    .default('medium')
    .describe('知识价值与实践性评级'),
  confidenceNote: z
    .string()
    .optional()
    .describe('置信度或事实依据说明'),
});

export type AIAnalysisPayload = z.infer<typeof AIAnalysisSchema>;

export class AIResponseFormatError extends Error {}

/**
 * Extracts and parses a JSON payload from an LLM response string,
 * tolerating markdown code fences (```json ... ```) or conversational preambles.
 */
export function parseAndValidateAIResponse(rawText: string): AIAnalysisPayload {
  if (!rawText || !rawText.trim()) {
    throw new AIResponseFormatError('AI 返回内容为空');
  }

  let text = rawText.trim();

  // Strip markdown code fences if present
  if (text.includes('```')) {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch && fenceMatch[1]) {
      text = fenceMatch[1].trim();
    }
  }

  // Find outermost JSON object bounds if there is extra text around it
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.substring(firstBrace, lastBrace + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AIResponseFormatError('AI 返回内容无法解析为合法 JSON');
  }

  const result = AIAnalysisSchema.safeParse(parsed);
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((e) => `${e.path.join('.') || '根对象'} (${e.code})`)
      .join('; ');
    throw new AIResponseFormatError(`AI 输出结构未通过 Schema 校验: ${errorDetails}`);
  }

  return result.data;
}
