import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { buildDocumentBlock } from '../attachment-text.js';
import type {
  ChatContext,
  ModelProvider,
  ProviderCallbacks,
} from '../model.types.js';

/**
 * openApi：内部 OneAPI 网关（OpenAI 兼容协议）。
 *
 * 与 DeepSeek Provider 的差异：
 *   - baseURL / key / 具体模型都由环境变量决定，网关背后可切换任意模型
 *     （GET /v1/models 可查当前可用列表，如 gpt-5.5 / DeepSeek-V4-Pro / GLM-5 等）
 *   - 不下发 thinking 参数：聚合网关对该扩展参数的支持不确定，
 *     但若上游模型自己返回 reasoning_content，这里照样透传
 *
 * prompt 结构与 DeepSeek Provider 保持一致：system → 附件正文 → 用户问题，
 * 稳定内容在前，便于上游命中各家的前缀缓存。
 */
@Injectable()
export class OpenApiProvider implements ModelProvider {
  readonly type = 'openapi';

  private readonly logger = new Logger(OpenApiProvider.name);

  private readonly client = new OpenAI({
    apiKey: process.env.OPENAPI_API_KEY || '',
    baseURL:
      process.env.OPENAPI_BASE_URL || 'https://oneapi-comate.baidu-int.com/v1',
  });

  /** 实际请求的模型名，需与网关 /v1/models 返回的 id 一致 */
  private readonly model = process.env.OPENAPI_MODEL || 'gpt-5.5';

  async run(
    ctx: ChatContext,
    cb: ProviderCallbacks,
  ): Promise<{ text: string; images: string[] }> {
    let text = '';

    // 附件处理与 DeepSeek 一致：图片走 vision 块，文本/表格正文由网关内联进 prompt
    const attachments = ctx.attachments || [];
    const imageAttachments = attachments.filter((a) =>
      (a.type || '').startsWith('image/'),
    );
    const docAttachments = attachments.filter(
      (a) => !(a.type || '').startsWith('image/'),
    );

    const docBlock = await buildDocumentBlock(docAttachments);
    const textWithDocs = docBlock
      ? `${docBlock.trim()}\n\n${ctx.message}`
      : ctx.message;

    let userContent: any = textWithDocs;
    if (imageAttachments.length) {
      userContent = [
        { type: 'text', text: textWithDocs },
        ...imageAttachments.map((a) => ({
          type: 'image_url',
          image_url: { url: a.url },
        })),
      ];
    }

    const messages: any[] = [];
    if (ctx.system) {
      messages.push({ role: 'system', content: ctx.system });
    }
    messages.push({ role: 'user', content: userContent });

    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        stream: true,
      } as any,
      { signal: ctx.signal },
    );

    for await (const chunk of stream as any) {
      if (ctx.signal.aborted) break;
      const delta = chunk.choices?.[0]?.delta;
      // 部分上游模型（如 DeepSeek-V4-Pro）会带思考流，透传以便前端展示
      const reasoning: string | undefined = delta?.reasoning_content;
      if (reasoning) {
        text += reasoning;
        await cb.onDelta({ content: reasoning });
      }
      const content: string | undefined = delta?.content;
      if (content) {
        text += content;
        // await：允许上层在暂停时阻塞，实现背压/暂停
        await cb.onDelta({ content });
      }
    }

    if (!text) {
      this.logger.warn(`模型 ${this.model} 未返回任何内容`);
    }
    return { text, images: [] };
  }
}
