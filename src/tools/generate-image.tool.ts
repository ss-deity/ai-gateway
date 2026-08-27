import { Injectable } from '@nestjs/common';
import {
  buildJimengRequest,
  IMAGE_ASPECT_RATIOS,
  normalizeAspectRatio,
} from '../image/image-prompt.js';
import { ImageService, CHAT_IMAGE_DIR } from '../image/image.service.js';
import type { Attachment } from '../models/model.types.js';
import type { AgentTool, ToolContext, ToolDefinition } from './tool.types.js';

/**
 * generate_image：文本模型（DeepSeek / openApi）里统一的出图入口，底层走即梦。
 *
 * 有了它用户就不必先把模型切到 JiMeng：文本模型推理出「这是个出图需求」后直接调用，
 * 图片经 SSE 的 images 通道推给前端渲染，与直连图片模型的展示完全一致。
 * 模型只负责把需求写成一段画面描述，尺寸、参考图、画质参数由服务端确定性处理。
 */
@Injectable()
export class GenerateImageTool implements AgentTool {
  readonly name = 'generate_image';

  readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'generate_image',
      description: [
        '用即梦 AI 生成图片，或以用户上传的图片为参考图做改图/风格化，图片会直接渲染在会话中。',
        '当用户要求生成/画/设计图片、插画、海报、logo、头像、配图，或要求把已上传的图片改成某种风格、换背景、扩展画面时调用。',
        '所有图片生成与改图需求都走这个工具，不要让用户自己去切换图片模型，也不要说自己没有生图能力。',
        'prompt 必须是一段中文画面描述，不是对话指令：',
        '  · 按「主体 + 主体细节 + 环境/背景 + 构图视角 + 风格 + 光线 + 画质」组织，40-120 字；',
        '  · 用户描述很简略时由你补全合理细节（材质、色调、氛围、镜头），但不要改变用户明确指定的元素；',
        '  · 不要写「生成一张」「帮我画」这类指令词，也不要写否定句（如"没有文字"），即梦对否定不敏感；',
        '  · 画面里需要文字时用引号标出文字内容，如：招牌上写着"星河咖啡"。',
        '改图时 prompt 只描述改完之后的画面效果，并把 useUploadedImages 传 true。',
        '一次调用出一张图；用户要多个不同方案时可在同一轮并行多次调用，每次给不同的画面描述。',
        '工具返回后不要输出图片链接、Markdown 图片语法或"图片已生成"之外的假信息，用一句话说明画面要点即可。',
      ].join('\n'),
      parameters: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: {
            type: 'string',
            description:
              '中文画面描述（主体、细节、背景、构图、风格、光线、画质），40-120 字，不含指令词',
          },
          aspectRatio: {
            type: 'string',
            enum: [...IMAGE_ASPECT_RATIOS],
            description:
              '画面比例：1:1 头像/图标，16:9 或 3:2 横向banner/壁纸，9:16 或 2:3 竖版海报/手机壁纸，4:3 与 3:4 常规插画；省略按 1:1',
          },
          useUploadedImages: {
            type: 'boolean',
            description:
              '是否把本轮上传的图片当参考图（图生图）。用户要求改图、换风格、以图生图时传 true；全新创作传 false 或省略',
          },
          referenceImages: {
            type: 'array',
            items: { type: 'string' },
            description:
              '指定参考图的附件文件名（上传了多张、只想用其中几张时给出）；省略则按 useUploadedImages 取本轮全部图片',
          },
        },
      },
    },
  };

  constructor(private readonly imageService: ImageService) {}

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<Record<string, unknown>> {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) {
      return { ok: false, error: 'prompt 不能为空，请给出一段中文画面描述' };
    }

    const names = Array.isArray(args.referenceImages)
      ? args.referenceImages.filter((v): v is string => typeof v === 'string')
      : [];
    const referenceImages = this.pickReferenceImages(
      ctx.attachments,
      names,
      args.useUploadedImages === true,
    );

    const req = buildJimengRequest({
      prompt,
      aspectRatio: args.aspectRatio as string,
      referenceImages,
    });
    // 生成后立刻转存到文件管理的 chat 目录，会话里展示的是 BOS 永久地址
    const { images, files } = await this.imageService.generateAndSave(
      req.prompt,
      req.params,
      { userId: ctx.userId, nameStem: req.prompt },
    );
    if (ctx.signal.aborted) return { ok: false, error: '用户已取消生成' };

    // 图片本体直接推给前端渲染
    await ctx.onImage?.(images);

    return {
      ok: true,
      rendered: true,
      count: images.length,
      mode: referenceImages.length ? 'image2image' : 'text2image',
      aspectRatio: normalizeAspectRatio(args.aspectRatio as string),
      finalPrompt: req.prompt,
      savedFiles: files.map((f) => f.path),
      instruction: [
        '图片已经渲染在用户界面上，不要输出图片链接或 Markdown 图片语法。',
        files.length
          ? `图片已自动保存到「文件管理 / ${CHAT_IMAGE_DIR}」，可以顺带告诉用户一句。`
          : '图片未能保存到文件管理（用户可能未登录），不要声称已保存。',
        '用 1-2 句话说明画面要点（主体、风格、比例），并告诉用户可以提出修改方向让你重新生成。',
      ].join('\n'),
    };
  }

  /**
   * 挑参考图：显式给了文件名就按名字取，否则仅在模型明确要求图生图时取本轮全部图片。
   * 默认不取，避免用户「传了张图 + 让画个别的」时把无关图片当成参考图。
   */
  private pickReferenceImages(
    attachments: Attachment[] | undefined,
    names: string[],
    useUploaded: boolean,
  ): string[] {
    const images = (attachments ?? []).filter(
      (a) => (a.type || '').startsWith('image/') && a.url,
    );
    if (names.length) {
      const matched = images.filter((a) => names.includes(a.name));
      return (matched.length ? matched : images).map((a) => a.url);
    }
    return useUploaded ? images.map((a) => a.url) : [];
  }
}
