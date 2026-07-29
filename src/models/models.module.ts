import { Module } from '@nestjs/common';
import { ImageModule } from '../image/image.module.js';
import { ModelsService } from './models.service.js';
import { DeepseekProvider } from './providers/deepseek.provider.js';
import { JimengProvider } from './providers/jimeng.provider.js';

@Module({
  imports: [ImageModule],
  providers: [ModelsService, DeepseekProvider, JimengProvider],
  exports: [ModelsService],
})
export class ModelsModule {}
