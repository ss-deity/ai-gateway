import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { buildDocumentBlock } from '../attachment-text.js';
import type {
  ChatContext,
  ModelProvider,
  ProviderCallbacks,
} from '../model.types.js';

/**
 * DeepSeek-V4 文本对话（OpenAI 兼容流式接口）。
 * 深度思考（reasoning）：
 *   - 若前端开启 thinking，则携带 `thinking: { type: 'enabled' }` 参数（DeepSeek V3.2 起支持）
 *   - 若配置了 DEEPSEEK_THINKING_MODEL 环境变量，同时将模型切换为该模型（如 deepseek-reasoner）
 */
@Injectable()
export class DeepseekProvider implements ModelProvider {
  readonly type = 'deepseek-v4';

  private readonly client = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  });

  private readonly model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  private readonly thinkingModel =
    process.env.DEEPSEEK_THINKING_MODEL || this.model;

  async run(
    ctx: ChatContext,
    cb: ProviderCallbacks,
  ): Promise<{ text: string; images: string[] }> {
    let text = '';
    const thinking = ctx.thinking === true;

    // 拼装用户消息：
    //   - 图片附件：OpenAI vision 格式的数组 content（text + image_url）
    //   - 文本附件（txt / md 等）：网关侧下载正文并内联进 prompt
    //     （DeepSeek 不会主动访问 URL，只贴链接模型读不到内容）
    //   - 其它附件（如 pdf）：仅列出名称与链接
    const attachments = ctx.attachments || [];
    const imageAttachments = attachments.filter((a) =>
      (a.type || '').startsWith('image/'),
    );
    const docAttachments = attachments.filter(
      (a) => !(a.type || '').startsWith('image/'),
    );

    const docBlock = await buildDocumentBlock(docAttachments);
    const textWithDocs = docBlock ? `${ctx.message}${docBlock}` : ctx.message;

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

    // OpenAI SDK 类型未覆盖 DeepSeek 的 thinking 扩展参数，需通过局部 any 透传
    // 技能指令走 system 角色下发（优先级高于用户消息，模型会按其约束作答）
    const messages: any[] = [];
    if (ctx.system) {
      messages.push({ role: 'system', content: ctx.system });
    }
    messages.push({ role: 'user', content: userContent });

    const params: any = {
      model: thinking ? this.thinkingModel : this.model,
      messages,
      stream: true,
    };
    if (thinking) {
      params.thinking = { type: 'enabled' };
    }
    const stream = await this.client.chat.completions.create(params, {
      signal: ctx.signal,
    });

    for await (const chunk of stream as any) {
      if (ctx.signal.aborted) break;
      const delta = chunk.choices?.[0]?.delta;
      // 思考流：reasoning_content 优先透传（同样计入文本入库，便于历史回显）
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

    return { text, images: [] };
  }
}
