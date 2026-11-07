import type { NormalizedPost } from '../domain/types';

export const SYSTEM_PROMPT = `你是一个专业的 X (Twitter) 知识提取与技术归档专家。你的任务是从用户点赞的推文中提取关键知识，生成结构化的中文摘要和分析。

【核心原则 - 严禁幻觉】：
1. 真实性高于一切：严格根据推文原文及附带图片（若有）提炼，绝不捏造、臆测或补写原文中不存在的代码、命令、步骤或链接。
2. 缺失标注：如果推文只提及概念或新闻但没有具体教程步骤，steps 数组必须为空 []，并在 uncertainties 中如实标明“原文未包含具体操作步骤”。
3. 中文输出：无论原文是英文、中文还是其他语言，标题、摘要、分类、标签和分析均使用准确、规范的中文。
4. 链接保真：usefulLinks 仅提取推文中真实出现或明确指向的外部链接（如 GitHub、文档、Demo、论文等）。
5. 图像提炼：若附带有推文图片，请提取图片中展示的架构图、操作步骤、代码截图或工具配置，结合正文形成完整总结。

【输出格式要求】：
只输出纯 JSON 对象，不要包含任何额外的问候语或解释。字段格式严格遵循：
{
  "titleZh": "简短醒目的中文标题",
  "summaryZh": "1-3句话提炼的核心知识要点与价值",
  "categories": ["AI/Agent", "编程开发", "软件工具", "开源项目", "网络技术", "设计/UI", "综合知识" 中的1-2个],
  "tags": ["相关技术或领域标签", "如 Vite", "TypeScript"],
  "contentType": "tutorial | project | tool | news | opinion | other",
  "steps": ["第1步...", "第2步...（若无则保持空数组 []）"],
  "prerequisites": ["前置条件或依赖（若无则保持空数组 []）"],
  "usefulLinks": ["https://..."],
  "risksAndLimits": ["原文明确提及的风险或限制，未提及时返回空数组 []"],
  "uncertainties": ["原文未说明的内容或待核实事项"],
  "quality": "high | medium | low",
  "confidenceNote": "提取依据说明"
}`;

export type ChatMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatMessageContentPart[];
}

export function buildUserPromptText(post: NormalizedPost, hasImages = false): string {
  const authorInfo = post.author?.displayName
    ? `${post.author.displayName} (@${post.author.handle || 'unknown'})`
    : post.author?.handle
    ? `@${post.author.handle}`
    : '未知作者';

  const parts = [
    `【原帖作者】：${authorInfo}`,
    `【原帖 URL】：${post.canonicalUrl}`,
    `【推文正文】：\n${post.text || '（无文本内容）'}`,
    post.externalLinks.length > 0 ? `【包含外链】：\n${post.externalLinks.join('\n')}` : '',
    hasImages ? '【附图说明】：用户已开启多模态图片分析，请结合附带的推文图片提炼图中的技术架构、步骤要点或关键截图内容。' : '',
  ];

  return parts.filter(Boolean).join('\n\n');
}

export function buildMessages(post: NormalizedPost): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPromptText(post, false) },
  ];
}

export function buildMultimodalMessages(
  post: NormalizedPost,
  base64Images: string[] = []
): OpenAIMessage[] {
  if (base64Images.length === 0) {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPromptText(post, false) },
    ];
  }

  const textPart: ChatMessageContentPart = {
    type: 'text',
    text: buildUserPromptText(post, true),
  };

  const imageParts: ChatMessageContentPart[] = base64Images.map((dataUrl) => ({
    type: 'image_url',
    image_url: { url: dataUrl, detail: 'auto' },
  }));

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [textPart, ...imageParts],
    },
  ];
}
