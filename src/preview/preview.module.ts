import { Module } from '@nestjs/common';
import { PreviewService } from './preview.service.js';

@Module({
  providers: [PreviewService],
  exports: [PreviewService],
})
export class PreviewModule {}
