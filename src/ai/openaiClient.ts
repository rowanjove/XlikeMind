import type { AIClient } from './client';
import { sanitizeErrorMessage } from './client';
import type { NormalizedPost, MediaAsset, AIConfig } from '../domain/types';
import { buildMultimodalMessages } from './prompt';
import { AIResponseFormatError, parseAndValidateAIResponse, type AIAnalysisPayload } from './schema';
import { hasArchivedMedia } from '../domain/media';

export function selectVisionImages(media: MediaAsset[]): (MediaAsset & { blob: Blob })[] {
  return media.filter(hasArchivedMedia).filter((asset) => asset.kind === 'image' && asset.blob.size <= 3 * 1024 * 1024).slice(0, 2);
}

function createRequestSignal(external: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

function isPrivateLanHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  const parts = normalized.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first === 127 ||
    (first === 169 && second === 254)
  );
}

export function isLocalEndpoint(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      isPrivateLanHost(host) ||
      host.endsWith('.local')
    );
  } catch {
    return false;
  }
}

/**
 * Safely converts an image Blob to Base64 Data URL.
 * Works across Browser (FileReader) and Node / Vitest (Buffer) environments.
 */
export async function blobToBase64DataUrl(blob: Blob): Promise<string> {
  const mime = blob.type || 'image/jpeg';
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') resolve(reader.result);
        else reject(new Error('Failed to convert blob to base64'));
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Node.js / jsdom fallback
  const buffer = await blob.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return `data:${mime};base64,${base64}`;
}

export class OpenAIClient implements AIClient {
  readonly name = 'openai_compatible';
  private config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;
  }

  private isLocal(): boolean {
    return isLocalEndpoint(this.config.baseUrl);
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const key = this.config.apiKey.trim();
    if (key) {
      headers['Authorization'] = `Bearer ${key}`;
    } else if (this.isLocal()) {
      // Local models (Ollama, LM Studio) may not require key or accept dummy
      headers['Authorization'] = 'Bearer local';
    }
    return headers;
  }

  private getEndpointUrl(): string {
    const base = this.config.baseUrl.trim().replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      throw new Error('API Base URL 无效');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('API Base URL 只允许 http 或 https');
    }
    const normalized = parsed.toString().replace(/\/+$/, '');
    if (normalized.endsWith('/chat/completions')) {
      return normalized;
    }
    return `${normalized}/chat/completions`;
  }

  async testConnection(options?: { signal?: AbortSignal }): Promise<{ success: boolean; message: string }> {
    const isLocal = this.isLocal();
    if (!isLocal && !this.config.apiKey.trim()) {
      return { success: false, message: '未填写 API Key，云端模型请先配置密钥' };
    }

    let endpoint: string;
    try {
      endpoint = this.getEndpointUrl();
    } catch (err) {
      return { success: false, message: sanitizeErrorMessage(err, this.config.apiKey) };
    }
    const timeoutMs = (this.config.timeoutSec || 15) * 1000;
    const request = createRequestSignal(options?.signal, timeoutMs);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        headers: this.getHeaders(),
        body: JSON.stringify({
          model: this.config.modelName.trim(),
          messages: [{ role: 'user', content: 'Hello, reply with pong' }],
          max_tokens: 10,
        }),
        signal: request.signal,
      });

      if (!res.ok) {
        let errBody = '';
        try {
          errBody = await res.text();
        } catch {}
        const safeErr = sanitizeErrorMessage(
          `HTTP ${res.status} (${res.statusText}): ${errBody}`,
          this.config.apiKey
        );
        return { success: false, message: safeErr };
      }

      const data = await res.json().catch(() => null);
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        return { success: false, message: '接口已返回响应，但没有提供有效的模型消息。请检查接口地址和模型名称。' };
      }

      const prefix = isLocal ? '本地模型' : '云端模型';
      return { success: true, message: `连接成功！${prefix} [${this.config.modelName}] 响应正常。` };
    } catch (err) {
      const safeErr = sanitizeErrorMessage(err, this.config.apiKey);
      const hint = isLocal
        ? `。请确认本地模型服务（如 Ollama 或 LM Studio）已启动并在监听 ${endpoint}`
        : '';
      return { success: false, message: `请求失败: ${safeErr}${hint}` };
    } finally {
      request.cleanup();
    }
  }

  async analyzePost(options: {
    post: NormalizedPost;
    media?: MediaAsset[];
    signal?: AbortSignal;
  }): Promise<AIAnalysisPayload> {
    const { post, media = [], signal } = options;
    const isLocal = this.isLocal();

    if (!isLocal && !this.config.apiKey.trim()) {
      throw new Error('未配置 API Key，无法发起云端 AI 知识分析');
    }

    const endpoint = this.getEndpointUrl();
    const timeoutMs = (this.config.timeoutSec || 30) * 1000;
    const request = createRequestSignal(signal, timeoutMs);

    // Multimodal Vision conversion: only if user explicitly allowed and images are present
    const base64Images: string[] = [];
    if (this.config.allowSendImages && media.length > 0) {
      const downloadedMedia = selectVisionImages(media);

      for (const m of downloadedMedia) {
        if (m.blob) {
          try {
            const dataUrl = await blobToBase64DataUrl(m.blob);
            base64Images.push(dataUrl);
          } catch {
            // Graceful fallback to text
          }
        }
      }
    }

    const messages = buildMultimodalMessages(post, base64Images);

    const requestAnalysis = async (repair: boolean) => {
      request.signal.throwIfAborted();
      const res = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        headers: this.getHeaders(),
        body: JSON.stringify({
          model: this.config.modelName.trim(),
          messages: repair ? [...messages, {
            role: 'user',
            content: '上一次输出无法通过结构校验。请重新根据原文生成，只输出符合要求的 JSON 对象，不要编造缺失内容。',
          }] : messages,
          temperature: 0.2,
        }),
        signal: request.signal,
      });

      if (!res.ok) {
        let errBody = '';
        try {
          errBody = await res.text();
        } catch {}
        throw new Error(
          sanitizeErrorMessage(`HTTP ${res.status} (${res.statusText}): ${errBody}`, this.config.apiKey)
        );
      }

      const data = await res.json().catch((error) => {
        if (request.signal.aborted) throw error;
        throw new AIResponseFormatError('接口没有返回有效的 JSON 响应');
      });
      const choice = data?.choices?.[0];
      if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw new Error('模型拒绝处理或输出被过滤');
      const content = choice?.message?.content;
      if (typeof content !== 'string') throw new AIResponseFormatError('模型响应格式异常，未找到 choices[0].message.content');

      return parseAndValidateAIResponse(content);
    };

    try {
      try {
        return await requestAnalysis(false);
      } catch (error) {
        if (!(error instanceof AIResponseFormatError) || request.signal.aborted) throw error;
        try {
          return await requestAnalysis(true);
        } catch (repairError) {
          const message = `${error.message}。格式修复未成功：${sanitizeErrorMessage(repairError, this.config.apiKey)}`;
          throw repairError instanceof AIResponseFormatError ? new AIResponseFormatError(message) : new Error(message);
        }
      }
    } catch (err) {
      const message = sanitizeErrorMessage(err, this.config.apiKey);
      throw err instanceof AIResponseFormatError ? new AIResponseFormatError(message) : new Error(message);
    } finally {
      request.cleanup();
    }
  }
}
