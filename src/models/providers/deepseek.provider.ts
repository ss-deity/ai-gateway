import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type {
  ChatContext,
  ModelProvider,
  ProviderCallbacks,
} from '../model.types.js';

/**
 * DeepSeek-V4 文本对话（OpenAI 兼容流式接口）。
 */
@Injectable()
export class DeepseekProvider implements ModelProvider {
  readonly type = 'deepseek-v4';

  private readonly client = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  });

  private readonly model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

  async run(
    ctx: ChatContext,
    cb: ProviderCallbacks,
  ): Promise<{ text: string; images: string[] }> {
    let text = '';
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: [{ role: 'user', content: ctx.message }],
        stream: true,
      },
      { signal: ctx.signal },
    );

    for await (const chunk of stream) {
      if (ctx.signal.aborted) break;
      const content = chunk.choices[0]?.delta?.content;
      if (!content) continue;
      text += content;
      // await：允许上层在暂停时阻塞，实现背压/暂停
      await cb.onDelta({ content });
    }

    return { text, images: [] };
  }
}
