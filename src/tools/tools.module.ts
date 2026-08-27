import { Module } from '@nestjs/common';
import { ChartsModule } from '../charts/charts.module.js';
import { FlowchartsModule } from '../flowcharts/flowcharts.module.js';
import { ImageModule } from '../image/image.module.js';
import { PptModule } from '../ppt/ppt.module.js';
import { CreatePptTool } from './create-ppt.tool.js';
import { ExcelToEchartsTool } from './excel-to-echarts.tool.js';
import { GenerateFlowchartTool } from './generate-flowchart.tool.js';
import { GenerateImageTool } from './generate-image.tool.js';
import { ToolsService } from './tools.service.js';

@Module({
  imports: [PptModule, ChartsModule, ImageModule, FlowchartsModule],
  providers: [
    ToolsService,
    CreatePptTool,
    ExcelToEchartsTool,
    GenerateImageTool,
    GenerateFlowchartTool,
  ],
  exports: [ToolsService],
})
export class ToolsModule {}
