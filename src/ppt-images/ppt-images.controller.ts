import { Controller, Get, Query } from '@nestjs/common';
import { PptImagesService } from './ppt-images.service.js';

/**
 * PPT 图片预览接口。
 * GET /api/ppt/pages?url=<BOS pptx url>
 * 返回：{ code: 0, data: { pages: string[], total: number }, message: 'success' }
 */
@Controller('ppt')
export class PptImagesController {
  constructor(private readonly service: PptImagesService) {}

  @Get('pages')
  async pages(@Query('url') url?: string) {
    if (!url) {
      return { code: -1, message: '缺少 url', data: null };
    }
    try {
      const data = await this.service.getPages(url);
      return { code: 0, message: 'success', data };
    } catch (e) {
      return { code: -1, message: (e as Error).message, data: null };
    }
  }
}
