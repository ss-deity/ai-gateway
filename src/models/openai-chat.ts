import type { Logger } from '@nestjs/common';
import type OpenAI from 'openai';
import { buildDocumentBlock } from './attachment-text.js';
import type { ChatContext, ProviderCallbacks } from './model.types.js';
import type { ToolsService } from '../tools/tools.service.js';

/** 工具调用的最大轮次：超过则不再执行工具，直接把模型当轮输出返回 */
const MAX_TOOL_ROUNDS = 3;

/** 累积中的一次 tool_call（流式返回时 name / arguments 会被切成多个片段） */
interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

export interface OpenAiChatOptions {
  client: OpenAI;
  /** 请求的模型名 */
  model: string;
  ctx: ChatContext;
  cb: ProviderCallbacks;
  /** 工具注册表；definitions() 为空时等价于普通对话 */
  tools: ToolsService;
  logger: Logger;
  /** Provider 自家的扩展参数（如 DeepSeek 的 thinking、stream_options） */
  extraParams?: Record<string, unknown>;
  /** 流式 usage 回调（开启 include_usage 时最后一个 chunk 携带） */
  onUsage?: (usage: any) => void;
}

/**
 * 按「稳定内容在前」的顺序拼装消息：
 *   system（技能指令）→ 最近 N 条历史 → system（会话记忆）→ 附件正文 + 用户问题
 *
 * 会话记忆放在历史之后、当前提问之前：记忆每隔几轮就会被重写，若放在最前面，
 * 一变就会让后面整条历史的前缀缓存全部失效；放在末尾则历史部分的前缀保持稳定。
 * 图片附件走 OpenAI vision 的数组 content，文本/表格附件由网关下载正文内联进 prompt
 * （模型不会主动访问 URL，只贴链接读不到内容）。
 */
export async function buildInitialMessages(ctx: ChatContext): Promise<any[]> {
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
  for (const item of ctx.history ?? []) {
    messages.push({ role: item.role, content: item.content });
  }
  if (ctx.memory) {
    messages.push({ role: 'system', content: ctx.memory });
  }
  messages.push({ role: 'user', content: userContent });
  return messages;
}

/**
 * OpenAI 兼容协议下的「流式对话 + 工具调用」主循环，DeepSeek 与 openApi 网关共用。
 *
 * 一轮的流程：请求流 → 边收边把文本增量透传给前端 → 收完检查是否有 tool_calls：
 *   - 没有：本轮就是最终回答，结束
 *   - 有：把 assistant(tool_calls) 与各工具的执行结果追加进 messages，进入下一轮，
 *     由模型基于工具结果（如 PPT 下载地址）继续把话说完
 * 工具执行失败不中断对话，错误文案照样回灌给模型，让它自行重试或如实告知用户。
 */
export async function runOpenAiChat(
  opts: OpenAiChatOptions,
): Promise<{ text: string; images: string[] }> {
  const { client, model, ctx, cb, tools, logger, extraParams, onUsage } = opts;
  const messages = await buildInitialMessages(ctx);
  const toolDefinitions = tools.definitions();
  let text = '';

  /** 把一段文本同时计入落库文本与前端增量 */
  const emit = async (chunk: string) => {
    text += chunk;
    await cb.onDelta({ content: chunk });
  };

  /** 已经向前端报过「正在执行」的 tool_call id，避免重复推同一帧 */
  const announced = new Set<string>();

  for (let round = 0; ; round++) {
    const params: any = { model, messages, stream: true, ...extraParams };
    if (toolDefinitions.length) {
      params.tools = toolDefinitions;
      params.tool_choice = 'auto';
    }

    const stream = await client.chat.completions.create(params, {
      signal: ctx.signal,
    });

    let roundText = '';
    const pending = new Map<number, PendingToolCall>();

    for await (const chunk of stream as any) {
      if (ctx.signal.aborted) break;
      if (chunk.usage) onUsage?.(chunk.usage);
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // 思考流：部分模型会单独给 reasoning_content，透传以便前端展示
      const reasoning: string | undefined = delta.reasoning_content;
      if (reasoning) await emit(reasoning);

      const content: string | undefined = delta.content;
      if (content) {
        roundText += content;
        await emit(content);
      }

      for (const call of delta.tool_calls ?? []) {
        const index: number = call.index ?? 0;
        const cur = pending.get(index) ?? { id: '', name: '', args: '' };
        if (call.id) cur.id = call.id;
        if (call.function?.name) cur.name += call.function.name;
        if (call.function?.arguments) cur.args += call.function.arguments;
        pending.set(index, cur);

        // 工具名一到手就先把「正在执行」推给前端。
        // 模型接下来要把整份参数（如 PPT 的所有页面内容）流式吐完才会进入执行阶段，
        // 这段时间可能长达十几秒且没有任何文本增量，不先报状态前端就是一片空白。
        if (cur.name && cur.id && !announced.has(cur.id)) {
          announced.add(cur.id);
          await cb.onDelta({
            tool: { id: cur.id, name: cur.name, status: 'running' },
          });
        }
      }
    }

    // 没有工具调用（或已被用户中止）：本轮输出即最终回答
    if (ctx.signal.aborted || pending.size === 0) break;

    const calls = [...pending.values()].filter((c) => c.name);
    if (!calls.length) break;

    if (round >= MAX_TOOL_ROUNDS) {
      logger.warn(`工具调用超过 ${MAX_TOOL_ROUNDS} 轮，停止继续调用`);
      await emit('\n\n> 工具调用轮次过多，已停止。请补充信息后重试。\n\n');
      break;
    }

    messages.push({
      role: 'assistant',
      content: roundText,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args },
      })),
    });

    for (const call of calls) {
      const args = parseArgs(call.args);
      if (!args) {
        // 参数不合法时也要把状态收尾，否则前端的「正在执行」会一直转
        if (announced.has(call.id)) {
          await cb.onDelta({
            tool: { id: call.id, name: call.name, status: 'done' },
          });
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            ok: false,
            error: '参数不是合法 JSON，请重新调用',
          }),
        });
        continue;
      }

      // 参数流式阶段通常已经报过 running 了，这里只兜底补一帧
      if (!announced.has(call.id)) {
        announced.add(call.id);
        await cb.onDelta({
          tool: { id: call.id, name: call.name, status: 'running' },
        });
      }

      const startedAt = Date.now();
      logger.log(`调用工具 ${call.name}`);
      const result = await tools.execute(call.name, args, {
        userId: ctx.userId,
        signal: ctx.signal,
        // 工具可能要直接读原始附件（如把 Excel 解析成图表）
        attachments: ctx.attachments,
        // 图表产物直接推给前端渲染，不塞回模型上下文
        onChart: (chart) => cb.onDelta({ charts: [chart] }),
        // 流程图同理：只把结构下发给前端布局渲染
        onFlowchart: (flowchart) => cb.onDelta({ flowcharts: [flowchart] }),
        // 图片同理：走统一的 images 增量，前端与直连图片模型时的渲染逻辑一致
        onImage: (urls) => cb.onDelta({ images: urls }),
      });
      logger.log(`工具 ${call.name} 执行完成，耗时 ${Date.now() - startedAt}ms`);

      await cb.onDelta({
        tool: { id: call.id, name: call.name, status: 'done' },
      });

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return { text, images: [] };
}

/** 解析模型拼出的 arguments 字符串，失败返回 undefined */
function parseArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}
