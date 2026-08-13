/**
 * Agent Tool 抽象层。
 *
 * 模型侧只负责「思考、规划、决定调用哪个工具」，真正的副作用（生成文件、上传）
 * 由这里的 Tool 实现。新增工具只需实现 AgentTool 并在 ToolsModule 中注册。
 */

/** 工具执行时的上下文（由 chat 链路透传） */
export interface ToolContext {
  /** 当前用户数字 id：产物要落到该用户的文件目录 */
  userId?: number;
  /** 中止信号：用户取消生成时同步中止工具 */
  signal: AbortSignal;
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
