import { Module } from '@nestjs/common';
import { UploadModule } from '../upload/upload.module.js';
import { PptService } from './ppt.service.js';

@Module({
  imports: [UploadModule],
  providers: [PptService],
  exports: [PptService],
})
export class PptModule {}
