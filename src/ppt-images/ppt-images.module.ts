import { Module } from '@nestjs/common';
import { UploadModule } from '../upload/upload.module.js';
import { PptImagesController } from './ppt-images.controller.js';
import { PptImagesService } from './ppt-images.service.js';

@Module({
  imports: [UploadModule],
  controllers: [PptImagesController],
  providers: [PptImagesService],
})
export class PptImagesModule {}
