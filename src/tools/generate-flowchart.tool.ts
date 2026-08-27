import { Injectable } from '@nestjs/common';
import { FlowchartService } from '../flowcharts/flowchart.service.js';
import {
  FLOW_DIRECTIONS,
  FLOW_NODE_TYPES,
  type FlowchartSpec,
} from '../flowcharts/flowchart.types.js';
import type { AgentTool, ToolContext, ToolDefinition } from './tool.types.js';

/**
 * generate_flowchart：把模型规划好的流程结构下发给前端，用 AntV G6 渲染成流程图。
 *
 * 模型只负责「有哪些步骤、判断分支怎么走」，坐标、连线路径、配色都由前端布局引擎算，
 * 所以参数里没有任何 x/y、宽高、颜色。产物走 SSE 直接给前端，不回灌上下文，
 * 因此工具返回值里只有一份规模摘要 + 让模型别再用文字重画流程图的指令。
 */
@Injectable()
export class GenerateFlowchartTool implements AgentTool {
  readonly name = 'generate_flowchart';

  readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'generate_flowchart',
      description: [
        '根据用户需求生成流程图结构，并直接渲染在当前会话中。',
        '当用户要求画流程图、步骤图、流程说明图、审批流、状态流转图，或要求把一段流程"图形化/可视化"时调用。',
        '调用前先自己把完整流程想清楚：每个步骤一个节点，判断点用 decision 节点并在连线上写清分支条件（如"是"/"否"）。',
        '节点 label 只写步骤本身，不要把分支条件写进节点名；分支条件写在 edges 的 label 上。',
        '流程图由前端渲染，你不要再输出 Mermaid、ASCII 图或节点清单，工具返回后只需用文字补充关键说明。',
        '需要多张流程图（如主流程 + 异常流程）时，在同一轮里并行发起多次调用。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: '流程图标题，如「用户注册流程」',
          },
          direction: {
            type: 'string',
            enum: [...FLOW_DIRECTIONS],
            description:
              '流程方向：TB=自上而下（默认，步骤多时用），LR=从左到右（步骤少或节点文案长时用）',
          },
          nodes: {
            type: 'array',
            description: '流程节点，2-60 个；顺序不影响布局，连线关系决定层级',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description: '节点唯一标识，供 edges 引用，建议用 n1/n2 这类短 id',
                },
                label: {
                  type: 'string',
                  description: '节点显示文案，一句话说清这一步做什么，尽量不超过 20 字',
                },
                type: {
                  type: 'string',
                  enum: [...FLOW_NODE_TYPES],
                  description:
                    '节点语义：start=开始，end=结束，process=普通处理步骤（默认），decision=判断分支（必须有 2 条及以上出边且带 label），io=输入/输出数据',
                },
                description: {
                  type: 'string',
                  description: '这一步的补充说明，用户 hover 节点时展示（可选）',
                },
              },
              required: ['id', 'label'],
            },
          },
          edges: {
            type: 'array',
            description:
              '节点间的流向，source/target 必须是上面已定义的节点 id；不能出现自环',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string', description: '起点节点 id' },
                target: { type: 'string', description: '终点节点 id' },
                label: {
                  type: 'string',
                  description:
                    '连线文案，判断分支必填（如「是」「否」「审批通过」），普通流转可省略',
                },
              },
              required: ['source', 'target'],
            },
          },
        },
        required: ['title', 'nodes', 'edges'],
      },
    },
  };

  constructor(private readonly flowchartService: FlowchartService) {}

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<Record<string, unknown>> {
    const result = this.flowchartService.build(args as FlowchartSpec);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    const { artifact, warnings } = result;
    await ctx.onFlowchart?.(artifact);

    return {
      ok: true,
      title: artifact.title,
      direction: artifact.direction,
      nodeCount: artifact.nodes.length,
      edgeCount: artifact.edges.length,
      // 被就地修掉的问题告诉模型，让它决定是否补一次更完整的调用
      warnings: warnings.length ? warnings : undefined,
      instruction:
        '流程图已渲染在会话中。不要再输出 Mermaid、ASCII 图或节点列表，只用两三句话说明流程要点与关键判断依据即可。',
    };
  }
}
