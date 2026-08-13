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
 * DeepSeek-V4 文本对话（OpenAI 兼容流式接口）。
 *
 * 对话主循环（含工具调用）在 `runOpenAiChat` 中，这里只负责 DeepSeek 特有的参数。
 *
 * 深度思考（reasoning）：
 *   - 若前端开启 thinking，则携带 `thinking: { type: 'enabled' }` 参数（DeepSeek V3.2 起支持）
 *   - 若配置了 DEEPSEEK_THINKING_MODEL 环境变量，同时将模型切换为该模型（如 deepseek-reasoner）
 *
 * 上下文硬盘缓存（省钱关键，按官方文档「上下文硬盘缓存」实现）：
 *   - 缓存对所有用户默认开启，没有 cache_control 之类的开关参数，能做的只有「把请求拼对」
 *   - 只有从第 0 个 token 开始完全相同的前缀才算命中，中间开始的重复不算
 *   - 以 64 tokens 为一个存储单元，不足 64 tokens 的内容不会被缓存
 *   - 命中部分按缓存价计费（远低于未命中价），是「尽力而为」，不保证命中
 *   因此消息拼装遵循「稳定内容在前、变化内容在后」：
 *     system（技能指令）→ 附件正文（长文档）→ 用户本次的问题
 *   并且不在前缀里放时间戳 / 随机 id / 会话 id 等每次都变的内容，否则命中率会直接归零。
 */
@Injectable()
export class DeepseekProvider implements ModelProvider {
  readonly type = 'deepseek-v4';

  private readonly logger = new Logger(DeepseekProvider.name);

  private readonly client = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  });

  private readonly model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  private readonly thinkingModel =
    process.env.DEEPSEEK_THINKING_MODEL || this.model;

  /** 单次回复的最大 token 数（控制输出费用上限），不配置则用服务端默认 */
  private readonly maxTokens = Number(process.env.DEEPSEEK_MAX_TOKENS || 0);
  /**
   * 未开启深度思考时是否显式关闭思考链。
   * 部分模型默认就会输出 reasoning_content，而思考 token 也按输出计费，
   * 显式关闭可以省下这部分开销；但该参数需模型支持，故默认不发，
   * 确认线上模型支持后设 DEEPSEEK_DISABLE_THINKING=1 开启。
   */
  private readonly disableThinking =
    process.env.DEEPSEEK_DISABLE_THINKING === '1';
  /**
   * 是否让流式响应带回 usage（`stream_options.include_usage`）。
   * 官方在 usage 中给出 prompt_cache_hit_tokens / prompt_cache_miss_tokens，
   * 是唯一能观测缓存命中情况的手段；若上游网关不支持该参数可设 0 关闭。
   */
  private readonly includeUsage = process.env.DEEPSEEK_LOG_USAGE !== '0';

  constructor(private readonly tools: ToolsService) {}

  async run(
    ctx: ChatContext,
    cb: ProviderCallbacks,
  ): Promise<{ text: string; images: string[] }> {
    const thinking = ctx.thinking === true;

    // OpenAI SDK 类型未覆盖 DeepSeek 的 thinking 扩展参数，需通过 extraParams 透传
    const extraParams: Record<string, unknown> = {};
    if (this.includeUsage) {
      // 流式默认不返回 usage，需显式开启才能拿到缓存命中/未命中的 token 数
      extraParams.stream_options = { include_usage: true };
    }
    if (thinking) {
      extraParams.thinking = { type: 'enabled' };
    } else if (this.disableThinking) {
      // 思考 token 按输出计费，不需要时显式关闭以省钱
      extraParams.thinking = { type: 'disabled' };
    }
    if (this.maxTokens > 0) {
      extraParams.max_tokens = this.maxTokens;
    }

    return runOpenAiChat({
      client: this.client,
      model: thinking ? this.thinkingModel : this.model,
      ctx,
      cb,
      tools: this.tools,
      logger: this.logger,
      extraParams,
      onUsage: (usage) => this.logUsage(usage),
    });
  }

  /**
   * 打印本次调用的 token 用量与缓存命中情况。
   * 命中率长期为 0 通常意味着前缀不稳定（prompt 前部有变化内容），
   * 或重复前缀不足 64 tokens。
   */
  private logUsage(usage: any): void {
    const hit = Number(usage.prompt_cache_hit_tokens ?? 0);
    const miss = Number(
      usage.prompt_cache_miss_tokens ?? usage.prompt_tokens ?? 0,
    );
    const input = Number(usage.prompt_tokens ?? hit + miss);
    const output = Number(usage.completion_tokens ?? 0);
    const rate =
      hit + miss > 0 ? ((hit / (hit + miss)) * 100).toFixed(1) : '0.0';
    this.logger.log(
      `token 用量：输入 ${input}（缓存命中 ${hit} / 未命中 ${miss}，命中率 ${rate}%），输出 ${output}`,
    );
  }
}
