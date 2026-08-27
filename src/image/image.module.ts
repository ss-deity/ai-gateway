import { Module } from '@nestjs/common';
import { UploadModule } from '../upload/upload.module.js';
import { ImageController } from './image.controller.js';
import { ImageService } from './image.service.js';

@Module({
  imports: [UploadModule],
  controllers: [ImageController],
  providers: [ImageService],
  exports: [ImageService],
})
export class ImageModule {}
