import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UploadController } from './upload.controller.js';
import { UploadService } from './upload.service.js';
import { User } from '../entities/user.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    MulterModule.register({
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    }),
  ],
  controllers: [UploadController],
  providers: [UploadService],
})
export class UploadModule {}
