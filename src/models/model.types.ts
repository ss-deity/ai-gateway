/**
 * 模型统一抽象层：不同模型（DeepSeek 文本、即梦图片…）都实现 ModelProvider，
 * 通过 ModelsService 注册表按 type 选中，并以统一的 UniformDelta 流式回传，
 * 使上层（控制器/前端）无需感知各家原始返回格式。新增模型只需实现一个 Provider 并注册。
 */

import type { ChartArtifact } from '../charts/chart.types.js';
import type { FlowchartArtifact } from '../flowcharts/flowchart.types.js';

/** 一次工具调用的展示状态：running=正在执行，done=执行完成 */
export interface ToolCallFrame {
  /** 模型给出的 tool_call id，前端按它做增量更新 */
  id: string;
  /** 工具名，前端渲染成「工具调用：<name>」 */
  name: string;
  status: 'running' | 'done';
}

/**
 * 统一增量数据：文本增量 content、图片结果 images、工具调用状态 tool、
 * 图表产物 charts、流程图产物 flowcharts
 */
export interface UniformDelta {
  content?: string;
  images?: string[];
  tool?: ToolCallFrame;
  /** 工具产出的 ECharts 图表，前端直接渲染（不经模型复述） */
  charts?: ChartArtifact[];
  /** 工具产出的流程图结构，前端用 G6 布局渲染（不经模型复述） */
  flowcharts?: FlowchartArtifact[];
}

export interface ProviderCallbacks {
  /** 每产生一份增量就回调；返回 Promise 时 Provider 应 await（用于暂停/背压） */
  onDelta: (delta: UniformDelta) => void | Promise<void>;
}

export interface Attachment {
  url: string;
  name: string;
  type: string;
  size: number;
}

/** 会话历史中的一条消息（只保留模型需要的角色与文本） */
export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatContext {
  message: string;
  /** 中止信号，用于终止生成 */
  signal: AbortSignal;
  /** 深度思考（reasoning）开关，各 Provider 自行决定如何生效 */
  thinking?: boolean;
  /** 用户随本条消息上传的附件（图片 / 文档等） */
  attachments?: Attachment[];
  /** 系统提示词（如技能指令），支持 system 角色的 Provider 应作为首条消息下发 */
  system?: string;
  /** 最近 N 条历史消息（不含本次提问），支持多轮的 Provider 原样下发 */
  history?: ChatHistoryMessage[];
  /** 会话记忆（摘要 + 事实 + 当前任务），紧贴本次用户消息之前下发 */
  memory?: string;
  /** 当前用户数字 id：工具产物（如 PPT 文件）需要落到该用户目录 */
  userId?: number;
}

export interface ModelProvider {
  /** 模型类型标识，与前端下发的 type 一致 */
  readonly type: string;
  /** 执行一次对话/生成，产出统一增量；返回汇总结果用于落库 */
  run(
    ctx: ChatContext,
    cb: ProviderCallbacks,
  ): Promise<{ text: string; images: string[] }>;
}

/** 默认模型 type（与前端 chatAI/src/config/models.ts 的 DEFAULT_MODEL_TYPE 保持一致） */
export const DEFAULT_MODEL_TYPE = 'openapi';
