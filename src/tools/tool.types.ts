/**
 * Agent Tool 抽象层。
 *
 * 模型侧只负责「思考、规划、决定调用哪个工具」，真正的副作用（生成文件、上传）
 * 由这里的 Tool 实现。新增工具只需实现 AgentTool 并在 ToolsModule 中注册。
 */

import type { ChartArtifact } from '../charts/chart.types.js';
import type { Attachment } from '../models/model.types.js';

/** 工具执行时的上下文（由 chat 链路透传） */
export interface ToolContext {
  /** 当前用户数字 id：产物要落到该用户的文件目录 */
  userId?: number;
  /** 中止信号：用户取消生成时同步中止工具 */
  signal: AbortSignal;
  /** 本轮用户上传的附件：工具需要直接读原文件时用（如 Excel 转图表） */
  attachments?: Attachment[];
  /**
   * 推送图表产物给前端。
   * ECharts option 动辄几 KB，让模型复述一遍既费上下文又容易截断，
   * 因此图表直接走 SSE 下发，模型只拿到一份精简的分析结论。
   */
  onChart?: (chart: ChartArtifact) => void | Promise<void>;
  /**
   * 推送图片产物给前端（与图片模型直连时同一条 images 增量通道）。
   * 图片地址很长且模型无需复述，因此只把地址推给前端渲染并落库，不回灌上下文。
   */
  onImage?: (images: string[]) => void | Promise<void>;
}

/** OpenAI 兼容的 function tool 声明 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentTool {
  /** 工具名，需与 definition.function.name 一致 */
  readonly name: string;
  /** 下发给模型的声明 */
  readonly definition: ToolDefinition;
  /** 执行工具，返回值会 JSON 序列化后作为 tool 消息回灌给模型 */
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<Record<string, unknown>>;
}
