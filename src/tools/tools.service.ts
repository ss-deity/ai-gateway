import { Injectable, Logger } from '@nestjs/common';
import { CreatePptTool } from './create-ppt.tool.js';
import type { AgentTool, ToolContext, ToolDefinition } from './tool.types.js';

/**
 * 工具注册表：向模型下发工具声明，并按名字分发执行。
 * 工具执行失败不抛给上层，而是把错误文案回灌给模型，让模型自己决定重试或告知用户。
 */
@Injectable()
export class ToolsService {
  private readonly logger = new Logger(ToolsService.name);
  private readonly tools = new Map<string, AgentTool>();

  constructor(createPpt: CreatePptTool) {
    this.register(createPpt);
  }

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  /** 随请求下发给模型的工具声明 */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  /**
   * 执行一个工具调用，返回结构化结果（始终可 JSON 序列化）。
   * 未知工具名或执行异常都转成 `{ ok: false, error }`，作为 tool 消息回灌模型。
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<Record<string, unknown>> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `未知工具：${name}` };
    }
    try {
      return await tool.execute(args, ctx);
    } catch (e) {
      const error = (e as Error).message || String(e);
      this.logger.warn(`工具 ${name} 执行失败：${error}`);
      return { ok: false, error };
    }
  }
}
