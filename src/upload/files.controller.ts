import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
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
   * 递归检索用户全部图片文件（输入框 @ 选图用）
   * GET /files/images?userId=<id>&keyword=<文件名关键字>
   */
  @Get('images')
  async listImages(
    @Query('userId') userId?: string,
    @Query('keyword') keyword?: string,
  ) {
    if (!userId) {
      return { code: -1, message: '缺少 userId', data: null };
    }
    try {
      const list = await this.uploadService.searchImages(
        Number(userId),
        keyword,
      );
      return { code: 0, message: 'success', data: list };
    } catch (e) {
      return { code: -1, message: (e as Error).message, data: null };
    }
  }

  /**
   * 下载文件（网关转发 BOS 流，同源返回，便于前端统计下载进度）
   * GET /files/download?userId=<id>&path=<相对路径>
   */
  @Get('download')
  async download(
    @Res() res: Response,
    @Query('userId') userId?: string,
    @Query('path') path?: string,
  ) {
    if (!userId || !path) {
      res.status(400).json({ code: -1, message: '缺少 userId 或 path' });
      return;
    }
    try {
      const { stream, size, contentType, name } =
        await this.uploadService.openFileStream(Number(userId), path);

      // 文件名可能含中文/空格，真实名称用 RFC 5987 的 filename* 传递；
      // 响应头只能放 latin1 字符，因此 ASCII 兜底名要把非 ASCII 与引号换行一并替换掉
      const fallbackName =
        // eslint-disable-next-line no-control-regex
        name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'download';
      res.setHeader('Content-Type', contentType);
      if (size > 0) res.setHeader('Content-Length', String(size));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      // 前端要读 Content-Length 算进度，跨端口开发时需显式放行该响应头
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length');

      // 客户端中断（取消下载）时及时断开上游流，避免继续占用连接
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (e) {
      res.status(500).json({ code: -1, message: (e as Error).message });
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
