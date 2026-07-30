import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
} from '@nestjs/common';
import { UploadService } from './upload.service.js';

/**
 * 文件管理接口：列表 / 新建文件夹 / 删除 / 重命名。
 * 全部基于用户在 BOS 的独立根目录 users/<uid>/ 展开，仅限本人使用。
 */
@Controller('files')
export class FilesController {
  constructor(private readonly uploadService: UploadService) {}

  /**
   * 列出目录下的直接子项
   * GET /files?userId=<id>&dir=<相对路径，缺省为根目录>
   */
  @Get()
  async list(@Query('userId') userId?: string, @Query('dir') dir?: string) {
    if (!userId) {
      return { code: -1, message: '缺少 userId', data: null };
    }
    try {
      const list = await this.uploadService.listFiles(Number(userId), dir);
      return { code: 0, message: 'success', data: list };
    } catch (e) {
      return { code: -1, message: (e as Error).message, data: null };
    }
  }

  /**
   * 新建文件夹
   * POST /files/folder { userId, dir?, name }
   */
  @Post('folder')
  async createFolder(
    @Body() body: { userId?: number; dir?: string; name?: string },
  ) {
    if (!body.userId) {
      return { code: -1, message: '缺少 userId', data: null };
    }
    if (!body.name) {
      return { code: -1, message: '文件夹名称不能为空', data: null };
    }
    try {
      const folder = await this.uploadService.createFolder(
        Number(body.userId),
        body.dir,
        body.name,
      );
      return { code: 0, message: 'success', data: folder };
    } catch (e) {
      return { code: -1, message: (e as Error).message, data: null };
    }
  }

  /**
   * 删除文件或文件夹
   * DELETE /files { userId, path, isDir }
   */
  @Delete()
  async remove(
    @Body() body: { userId?: number; path?: string; isDir?: boolean },
  ) {
    if (!body.userId || !body.path) {
      return { code: -1, message: '缺少 userId 或 path', data: null };
    }
    try {
      await this.uploadService.deleteEntry(
        Number(body.userId),
        body.path,
        Boolean(body.isDir),
      );
      return { code: 0, message: 'success', data: null };
    } catch (e) {
      return { code: -1, message: (e as Error).message, data: null };
    }
  }

  /**
   * 重命名文件或文件夹
   * POST /files/rename { userId, path, newName, isDir }
   */
  @Post('rename')
  async rename(
    @Body()
    body: {
      userId?: number;
      path?: string;
      newName?: string;
      isDir?: boolean;
    },
  ) {
    if (!body.userId || !body.path) {
      return { code: -1, message: '缺少 userId 或 path', data: null };
    }
    if (!body.newName) {
      return { code: -1, message: '新名称不能为空', data: null };
    }
    try {
      const entry = await this.uploadService.renameEntry(
        Number(body.userId),
        body.path,
        body.newName,
        Boolean(body.isDir),
      );
      return { code: 0, message: 'success', data: entry };
    } catch (e) {
      return { code: -1, message: (e as Error).message, data: null };
    }
  }

  /**
   * 转存会话图片到「文件管理」
   * POST /files/save-image { userId, url, dir?, name? }
   * url 支持第三方 http(s) 图片地址与 base64 data URI；服务端下载后写入 BOS。
   */
  @Post('save-image')
  async saveImage(
    @Body()
    body: { userId?: number; url?: string; dir?: string; name?: string },
  ) {
    if (!body.userId || !body.url) {
      return { code: -1, message: '缺少 userId 或 url', data: null };
    }
    try {
      const entry = await this.uploadService.saveImageFromUrl(
        Number(body.userId),
        body.url,
        body.dir,
        body.name,
      );
      return { code: 0, message: 'success', data: entry };
    } catch (e) {
      return { code: -1, message: (e as Error).message, data: null };
    }
  }
}
