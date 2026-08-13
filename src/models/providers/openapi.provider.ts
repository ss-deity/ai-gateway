import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { runOpenAiChat } from '../openai-chat.js';
import type {
  ChatContext,
  ModelProvider,
  ProviderCallbacks,
} from '../model.types.js';
import { ToolsService } from '../../tools/tools.service.js';

/**
 * openApi：内部 OneAPI 网关（OpenAI 兼容协议）。
 *
 * 与 DeepSeek Provider 的差异：
 *   - baseURL / key / 具体模型都由环境变量决定，网关背后可切换任意模型
 *     （GET /v1/models 可查当前可用列表，如 gpt-5.5 / DeepSeek-V4-Pro / GLM-5 等）
 *   - 不下发 thinking 参数：聚合网关对该扩展参数的支持不确定，
 *     但若上游模型自己返回 reasoning_content，这里照样透传
 *
 * 对话主循环、附件拼装与工具调用都复用 `runOpenAiChat`，与 DeepSeek 完全一致：
 * system → 附件正文 → 用户问题，稳定内容在前，便于上游命中各家的前缀缓存。
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

  constructor(private readonly tools: ToolsService) {}

  async run(
    ctx: ChatContext,
    cb: ProviderCallbacks,
  ): Promise<{ text: string; images: string[] }> {
    const result = await runOpenAiChat({
      client: this.client,
      model: this.model,
      ctx,
      cb,
      tools: this.tools,
      logger: this.logger,
    });

    if (!result.text) {
      this.logger.warn(`模型 ${this.model} 未返回任何内容`);
    }
    return result;
  }
}
