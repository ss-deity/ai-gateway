import { Module } from '@nestjs/common';
import { FlowchartService } from './flowchart.service.js';

@Module({
  providers: [FlowchartService],
  exports: [FlowchartService],
})
export class FlowchartsModule {}
