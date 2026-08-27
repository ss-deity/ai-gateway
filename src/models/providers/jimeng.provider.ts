import { Injectable } from '@nestjs/common';
import { buildJimengRequest } from '../../image/image-prompt.js';
import { ImageService } from '../../image/image.service.js';
import type {
  ChatContext,
  ModelProvider,
  ProviderCallbacks,
} from '../model.types.js';

/**
 * 即梦AI-图片生成 4.6。把用户消息当作 prompt 生成图片 URL 列表，以统一的 images 增量回传。
 * 用户随消息带上的图片附件作为参考图（image_urls）透传给即梦，即走图生图。
 * 提示词与尺寸参数与 generate_image 工具共用同一套整理逻辑（image-prompt.ts）。
 */
@Injectable()
export class JimengProvider implements ModelProvider {
  readonly type = 'jimeng-v4.6';

  constructor(private readonly imageService: ImageService) {}

  async run(
    ctx: ChatContext,
    cb: ProviderCallbacks,
  ): Promise<{ text: string; images: string[] }> {
    // 参考图必须是公网可访问的 URL（文件管理里的 BOS 对象为 public-read，满足要求）
    const imageUrls = (ctx.attachments ?? [])
      .filter((a) => a.type.startsWith('image/') && a.url)
      .map((a) => a.url);
    const req = buildJimengRequest({
      prompt: ctx.message,
      referenceImages: imageUrls,
    });
    // 与 generate_image 工具一致：转存到文件管理的 chat 目录，回传 BOS 永久地址
    const { images } = await this.imageService.generateAndSave(
      req.prompt,
      req.params,
      { userId: ctx.userId, nameStem: req.prompt },
    );
    if (ctx.signal.aborted) return { text: '', images: [] };
    await cb.onDelta({ images });
    return { text: '', images };
  }
}
