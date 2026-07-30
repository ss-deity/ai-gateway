import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UploadController } from './upload.controller.js';
import { FilesController } from './files.controller.js';
import { UploadService } from './upload.service.js';
import { User } from '../entities/user.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    MulterModule.register({
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
      // multer/busboy 默认按 latin1 解析 multipart 头里的 filename，
      // 中文文件名会变成乱码（"我的图片.png" -> "æçå¾ç.png"）。
      // 浏览器 FormData 发出的就是 UTF-8，这里显式指定即可。
      defParamCharset: 'utf8',
    }),
  ],
  controllers: [UploadController, FilesController],
  providers: [UploadService],
  exports: [UploadService],
})
export class UploadModule {}
