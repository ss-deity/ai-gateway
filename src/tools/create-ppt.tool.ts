import { Injectable } from '@nestjs/common';
import { PptService } from '../ppt/ppt.service.js';
import type { PptSpec } from '../ppt/ppt.types.js';
import type { AgentTool, ToolContext, ToolDefinition } from './tool.types.js';

/**
 * create_ppt：把模型规划好的 PPT 结构渲染成 .pptx，上传 BOS 后返回下载地址。
 *
 * 模型只输出「标题 / 风格 / 语言 / 每页讲什么」，排版与上传都在服务端完成，
 * 所以参数里没有任何字号、坐标、配色之类的实现细节。
 */
@Injectable()
export class CreatePptTool implements AgentTool {
  readonly name = 'create_ppt';

  readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'create_ppt',
      description: [
        '根据用户提供的主题、页面结构和视觉风格生成 PowerPoint PPTX 文件，返回可下载的文件地址。',
        '当用户明确要求制作、生成、创建、导出 PPT / 演示文稿 / 幻灯片时调用。',
        '调用前必须先自己把每一页的标题和正文要点想清楚，slides 里不能出现占位符或空内容。',
        '封面、目录页、结尾页由服务端自动生成，slides 里只给正文页。',
        '版式（layout）请按内容性质轮换使用，不要整份 PPT 都是要点列表；有数据就给 metrics，有对比就给 columns。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'PPT 标题，同时作为封面标题与文件名',
          },
          subtitle: {
            type: 'string',
            description: '封面副标题，如汇报场景、部门、日期',
          },
          theme: {
            type: 'string',
            enum: ['business', 'technology', 'minimal', 'education', 'report'],
            description: 'PPT 视觉风格',
          },
          language: {
            type: 'string',
            enum: ['zh-CN', 'en-US'],
            description: 'PPT 正文语言',
          },
          slideCount: {
            type: 'number',
            description: '正文页数（不含封面/目录/结尾），建议 6-14，最多 30',
          },
          slides: {
            type: 'array',
            description: 'PPT 正文页结构，顺序即放映顺序',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '本页标题' },
                subtitle: {
                  type: 'string',
                  description: '本页导语，一句话说明这页要讲什么（可选）',
                },
                content: {
                  type: 'string',
                  description:
                    '本页正文。每行一条要点，不要写 Markdown 标记。给了 bullets 时可只写一句概述',
                },
                bullets: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    '要点列表，3-6 条，每条 15-40 字。写成「小标题：说明」时会渲染成卡片标题+正文',
                },
                metrics: {
                  type: 'array',
                  description:
                    '关键数字，2-4 个，用于 metrics 版式。只填有依据的数据，不要编造',
                  items: {
                    type: 'object',
                    properties: {
                      value: {
                        type: 'string',
                        description: '数字本身，如 38%、2.4 亿、TOP 3',
                      },
                      label: { type: 'string', description: '这个数字的含义' },
                    },
                    required: ['value', 'label'],
                  },
                },
                columns: {
                  type: 'array',
                  description: '分栏对比内容，2-3 栏，用于 comparison 版式',
                  items: {
                    type: 'object',
                    properties: {
                      title: { type: 'string', description: '本栏标题' },
                      bullets: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '本栏要点，2-5 条',
                      },
                    },
                    required: ['title', 'bullets'],
                  },
                },
                takeaway: {
                  type: 'string',
                  description: '本页结论，一句话，会渲染成页面底部的结论条',
                },
                notes: {
                  type: 'string',
                  description: '讲者备注，写进 PPT 备注栏，用于口头讲解',
                },
                layout: {
                  type: 'string',
                  enum: [
                    'auto',
                    'bullets',
                    'cards',
                    'metrics',
                    'comparison',
                    'timeline',
                    'quote',
                    'section',
                  ],
                  description:
                    '版式：bullets=编号要点，cards=卡片网格，metrics=数据看板，comparison=分栏对比，timeline=步骤时间轴，quote=大字观点页，section=章节分隔页，auto=由服务端按内容推断',
                },
              },
              required: ['title', 'content'],
            },
          },
        },
        required: ['title', 'theme', 'language', 'slideCount', 'slides'],
      },
    },
  };

  constructor(private readonly pptService: PptService) {}

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<Record<string, unknown>> {
    const spec = args as unknown as PptSpec;

    const invalid = this.pptService.validate(spec);
    if (invalid) {
      return { ok: false, error: `参数不合法：${invalid}，请修正后重新调用` };
    }
    if (!ctx.userId) {
      return { ok: false, error: '当前会话缺少用户信息，无法保存 PPT 文件' };
    }

    const result = await this.pptService.create(spec, ctx.userId);
    return {
      ok: true,
      ...result,
      // 明确告知模型该怎么把结果给用户，避免它再编一个假链接
      instruction:
        '请用一句话告知用户 PPT 已生成，并以 Markdown 链接形式给出 downloadUrl，同时简要列出 PPT 的章节结构。',
    };
  }
}
