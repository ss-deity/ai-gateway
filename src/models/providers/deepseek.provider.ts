import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
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
    // OpenAI SDK 类型未覆盖 DeepSeek 的 thinking 扩展参数，需通过局部 any 透传
    const params: any = {
      model: thinking ? this.thinkingModel : this.model,
      messages: [{ role: 'user', content: ctx.message }],
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
