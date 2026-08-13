import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import OpenAI from 'openai';
import { Conversation } from '../entities/conversation.entity.js';
import { Message } from '../entities/message.entity.js';
import type { ChatHistoryMessage } from '../models/model.types.js';

/** 一个会话的长期记忆（存在 conversations.memory 里） */
export interface ConversationMemory {
  /** 前情摘要：已经被折叠掉的那部分对话讲了什么 */
  summary: string;
  /** 稳定事实：用户身份、偏好、约束、已确定的结论等 */
  facts: string[];
  /** 当前任务：用户这一阶段想达成什么 */
  currentTask: string;
  /** 已折叠进 summary 的消息条数，用于判断何时该刷新 */
  foldedCount: number;
}

/** 原样带进 prompt 的最近消息条数（约等于 5 轮问答） */
const RECENT_MESSAGES = 10;

/** 每新增多少条消息刷新一次记忆 */
const REFRESH_EVERY = 6;

/** 单条历史消息带进 prompt 的最大字符数（长回答只留开头） */
const MAX_HISTORY_CHARS = 1500;

/** 摘要 / 事实 / 当前任务的长度上限，避免记忆无限膨胀 */
const MAX_SUMMARY_CHARS = 500;
const MAX_FACTS = 20;
const MAX_FACT_CHARS = 100;
const MAX_TASK_CHARS = 120;

/** 生成记忆时喂给模型的对话文本上限 */
const MAX_FOLD_CHARS = 12_000;

/** 单次刷新最多读取多少条新增消息 */
const MAX_FOLD_MESSAGES = 60;

/**
 * 会话记忆（Session Memory）。
 *
 * 结构：Summary（前情摘要）+ Facts（稳定事实）+ Current Task（当前任务）+ 最近 N 条原文。
 * 最近 N 条原文按 user/assistant 消息原样进 prompt，更早的内容由模型压成 Summary/Facts，
 * 这样上下文长度有上界，又不会把早期的关键信息丢掉。
 *
 * 记忆刷新是「事后、尽力而为」的：每轮结束后如果新消息攒够 REFRESH_EVERY 条，
 * 就用一次便宜的非流式调用重写记忆；失败只记日志，绝不影响正常对话。
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  /** 记忆总开关：MEMORY_ENABLED=0 时完全退回无记忆的单轮对话 */
  private readonly enabled = process.env.MEMORY_ENABLED !== '0';

  /**
   * 压缩记忆用的模型，默认复用 DeepSeek 配置（挑便宜的那个）。
   * client 懒加载：没配 key 时不实例化（OpenAI SDK 构造时缺 key 会直接抛错），
   * 记忆功能自动降级为「只带最近 N 条消息」，不影响服务启动与正常对话。
   */
  private readonly apiKey =
    process.env.MEMORY_API_KEY || process.env.DEEPSEEK_API_KEY || '';

  private readonly baseURL =
    process.env.MEMORY_BASE_URL ||
    process.env.DEEPSEEK_BASE_URL ||
    'https://api.deepseek.com';

  private client?: OpenAI;

  private readonly model =
    process.env.MEMORY_MODEL ||
    process.env.DEEPSEEK_MODEL ||
    'deepseek-v4-flash';

  private getClient(): OpenAI | undefined {
    if (!this.apiKey) return undefined;
    this.client ??= new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL });
    return this.client;
  }

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
  ) {}

  /**
   * 取一次对话所需的记忆上下文。
   * 必须在保存本次用户消息之前调用，否则最近消息里会混进当前这条提问。
   */
  async load(
    conversationId: number,
  ): Promise<{ memory?: string; history: ChatHistoryMessage[] }> {
    if (!this.enabled) return { history: [] };

    const [conversation, recent] = await Promise.all([
      this.conversationRepo.findOne({ where: { id: conversationId } }),
      this.messageRepo.find({
        where: { conversationId },
        order: { id: 'DESC' },
        take: RECENT_MESSAGES,
      }),
    ]);

    const history: ChatHistoryMessage[] = recent
      .reverse()
      // 纯图片消息 content 为空，带进 prompt 只会干扰模型
      .filter((m) => m.content?.trim())
      .map((m) => ({
        role: m.role,
        content: m.content.slice(0, MAX_HISTORY_CHARS),
      }));

    return {
      memory: this.buildMemoryPrompt(conversation?.memory),
      history,
    };
  }

  /** 把记忆渲染成一段 prompt（没有记忆时返回 undefined） */
  buildMemoryPrompt(memory?: ConversationMemory): string | undefined {
    if (!memory) return undefined;
    const lines: string[] = [
      '【会话记忆】以下是本次会话更早之前的信息，供你保持上下文一致：',
    ];
    if (memory.summary) lines.push(`前情摘要：${memory.summary}`);
    if (memory.facts?.length) {
      lines.push('已确认事实：');
      lines.push(...memory.facts.map((f) => `- ${f}`));
    }
    if (memory.currentTask) lines.push(`当前任务：${memory.currentTask}`);
    if (lines.length === 1) return undefined;
    lines.push('记忆仅作背景参考；与用户最新消息冲突时以最新消息为准。');
    return lines.join('\n');
  }

  /**
   * 一轮对话结束后按需刷新记忆。内部吞掉所有异常（记忆是增强项，不能拖累对话）。
   */
  async refresh(conversationId: number): Promise<void> {
    if (!this.enabled) return;
    try {
      const conversation = await this.conversationRepo.findOne({
        where: { id: conversationId },
      });
      if (!conversation) return;

      const total = await this.messageRepo.count({ where: { conversationId } });
      const previous = conversation.memory;
      const folded = previous?.foldedCount ?? 0;
      if (total - folded < REFRESH_EVERY) return;

      // 只把「上次折叠之后的新增消息」交给模型，配合旧记忆做增量更新
      // （take 是必须的：MySQL 不接受只有 OFFSET 没有 LIMIT 的查询）
      const fresh = await this.messageRepo.find({
        where: { conversationId },
        order: { id: 'ASC' },
        skip: folded,
        take: MAX_FOLD_MESSAGES,
      });
      const transcript = this.toTranscript(fresh);
      if (!transcript) return;

      const next = await this.summarize(previous, transcript);
      if (!next) return;

      conversation.memory = { ...next, foldedCount: folded + fresh.length };
      await this.conversationRepo.save(conversation);
      this.logger.log(
        `会话 ${conversationId} 记忆已更新（已折叠 ${folded + fresh.length} 条消息，事实 ${next.facts.length} 条）`,
      );
    } catch (e) {
      this.logger.warn(
        `刷新会话 ${conversationId} 记忆失败：${(e as Error).message}`,
      );
    }
  }

  /** 把消息列表拼成「用户：… / 助手：…」的纯文本，并限制总长度 */
  private toTranscript(messages: Message[]): string {
    const text = messages
      .filter((m) => m.content?.trim())
      .map(
        (m) =>
          `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, MAX_HISTORY_CHARS)}`,
      )
      .join('\n');
    // 超长时保留最后一段（越近的内容对当前任务越重要）
    return text.length > MAX_FOLD_CHARS ? text.slice(-MAX_FOLD_CHARS) : text;
  }

  /** 调模型把「旧记忆 + 新增对话」压成新的记忆 */
  private async summarize(
    previous: ConversationMemory | undefined,
    transcript: string,
  ): Promise<Omit<ConversationMemory, 'foldedCount'> | undefined> {
    const client = this.getClient();
    if (!client) return undefined;

    const previousBlock = previous
      ? [
          '已有记忆：',
          `summary: ${previous.summary}`,
          `facts: ${previous.facts.join(' | ')}`,
          `currentTask: ${previous.currentTask}`,
        ].join('\n')
      : '已有记忆：无';

    const response = await client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: [
            '你是对话记忆维护器。基于「已有记忆」和「新增对话」输出更新后的记忆。',
            '只输出 JSON，不要代码块、不要解释，格式：',
            '{"summary":"...","facts":["..."],"currentTask":"..."}',
            `summary：不超过 ${MAX_SUMMARY_CHARS} 字的前情摘要，覆盖已有摘要中仍然有效的内容。`,
            `facts：最多 ${MAX_FACTS} 条稳定事实（用户身份/偏好/技术栈/已定结论/明确约束），每条不超过 ${MAX_FACT_CHARS} 字，不要写寒暄和一次性内容。`,
            'currentTask：一句话说明用户当前想完成什么，没有明确任务则为空字符串。',
            '事实之间冲突时以新增对话为准；不要编造对话中没有出现的信息。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `${previousBlock}\n\n新增对话：\n${transcript}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    });

    const raw = response.choices?.[0]?.message?.content;
    return raw ? this.parseMemory(raw) : undefined;
  }

  /** 解析模型返回的 JSON 记忆，并按上限裁剪；解析失败返回 undefined */
  private parseMemory(
    raw: string,
  ): Omit<ConversationMemory, 'foldedCount'> | undefined {
    // 模型偶尔会裹一层 ```json，宽松地取出最外层大括号
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;

    let parsed: { summary?: unknown; facts?: unknown; currentTask?: unknown };
    try {
      parsed = JSON.parse(raw.slice(start, end + 1)) as typeof parsed;
    } catch {
      return undefined;
    }

    const summary =
      typeof parsed.summary === 'string'
        ? parsed.summary.trim().slice(0, MAX_SUMMARY_CHARS)
        : '';
    const facts = Array.isArray(parsed.facts)
      ? parsed.facts
          .filter((f): f is string => typeof f === 'string' && !!f.trim())
          .map((f) => f.trim().slice(0, MAX_FACT_CHARS))
          .slice(0, MAX_FACTS)
      : [];
    const currentTask =
      typeof parsed.currentTask === 'string'
        ? parsed.currentTask.trim().slice(0, MAX_TASK_CHARS)
        : '';

    if (!summary && !facts.length && !currentTask) return undefined;
    return { summary, facts, currentTask };
  }
}
