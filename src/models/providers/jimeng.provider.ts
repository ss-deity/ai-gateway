import { Injectable } from '@nestjs/common';
import { ImageService } from '../../image/image.service.js';
import type {
  ChatContext,
  ModelProvider,
  ProviderCallbacks,
} from '../model.types.js';

/**
 * 即梦AI-图片生成 4.6（文生图）。把用户消息当作 prompt，生成图片 URL 列表，
 * 以统一的 images 增量回传。
 */
@Injectable()
export class JimengProvider implements ModelProvider {
  readonly type = 'jimeng-v4.6';

  constructor(private readonly imageService: ImageService) {}

  async run(
    ctx: ChatContext,
    cb: ProviderCallbacks,
  ): Promise<{ text: string; images: string[] }> {
    const images = await this.imageService.generate(ctx.message);
    if (ctx.signal.aborted) return { text: '', images: [] };
    await cb.onDelta({ images });
    return { text: '', images };
  }
}
