import { Controller, Post, UploadedFile, UseInterceptors, Param } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service.js';

const AVATAR_ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);
const AVATAR_ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'webp'];

@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  /**
   * 上传文件到百度 BOS
   * POST /upload
   * Content-Type: multipart/form-data
   * field: file
   */
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      return { code: -1, message: '请选择文件', data: null };
    }

    const url = await this.uploadService.uploadToBos(file);
    return {
      code: 0,
      message: 'success',
      data: { url },
    };
  }

  /**
   * 上传头像并更新用户信息
   * POST /upload/avatar/:userId
   * 限制：jpg / jpeg / png / webp，≤ 5MB
   */
  @Post('avatar/:userId')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAvatar(
    @UploadedFile() file: Express.Multer.File,
    @Param('userId') userId: string,
  ) {
    if (!file) {
      return { code: -1, message: '请选择文件', data: null };
    }

    const mime = (file.mimetype || '').toLowerCase();
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    const mimeOk = AVATAR_ALLOWED_MIME.has(mime);
    const extOk = AVATAR_ALLOWED_EXT.includes(ext);
    if (!mimeOk && !extOk) {
      return {
        code: -1,
        message: '仅支持 jpg / jpeg / png / webp 格式',
        data: null,
      };
    }

    const url = await this.uploadService.uploadAvatar(file, Number(userId));
    return {
      code: 0,
      message: 'success',
      data: { url },
    };
  }
}
