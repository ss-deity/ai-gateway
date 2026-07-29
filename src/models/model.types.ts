/**
 * 模型统一抽象层：不同模型（DeepSeek 文本、即梦图片…）都实现 ModelProvider，
 * 通过 ModelsService 注册表按 type 选中，并以统一的 UniformDelta 流式回传，
 * 使上层（控制器/前端）无需感知各家原始返回格式。新增模型只需实现一个 Provider 并注册。
 */

/** 统一增量数据：文本增量 content 或图片结果 images */
export interface UniformDelta {
  content?: string;
  images?: string[];
}

export interface ProviderCallbacks {
  /** 每产生一份增量就回调；返回 Promise 时 Provider 应 await（用于暂停/背压） */
  onDelta: (delta: UniformDelta) => void | Promise<void>;
}

export interface ChatContext {
  message: string;
  /** 中止信号，用于终止生成 */
  signal: AbortSignal;
  /** 深度思考（reasoning）开关，各 Provider 自行决定如何生效 */
  thinking?: boolean;
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

/** 默认模型 type */
export const DEFAULT_MODEL_TYPE = 'deepseek-v4';
