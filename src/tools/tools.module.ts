import { Module } from '@nestjs/common';
import { PptModule } from '../ppt/ppt.module.js';
import { CreatePptTool } from './create-ppt.tool.js';
import { ToolsService } from './tools.service.js';

@Module({
  imports: [PptModule],
  providers: [ToolsService, CreatePptTool],
  exports: [ToolsService],
})
export class ToolsModule {}
