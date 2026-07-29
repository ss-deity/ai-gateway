import { Controller, Post, Body } from '@nestjs/common';
import { ImageService } from './image.service.js';

/**
 * 即梦AI 图片生成接口。
 * POST /image/generate
 * body: { prompt: string, params?: object }
 *   - prompt：文本描述（必填）
 *   - params：透传给即梦接口的其它参数（width/height/scale/seed 等，以 4.6 文档为准）
 * 返回: { code, message, data: { urls: string[] } }
 */
@Controller('image')
export class ImageController {
  constructor(private readonly imageService: ImageService) {}

  @Post('generate')
  async generate(
    @Body() body: { prompt?: string; params?: Record<string, unknown> },
  ) {
    if (!body?.prompt) {
      return { code: -1, message: 'prompt 不能为空', data: null };
    }
    try {
      const urls = await this.imageService.generate(
        body.prompt,
        body.params ?? {},
      );
      return { code: 0, message: 'success', data: { urls } };
    } catch (e) {
      return { code: -1, message: (e as Error).message, data: null };
    }
  }
}
