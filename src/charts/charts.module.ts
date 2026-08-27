import { Module } from '@nestjs/common';
import { ExcelChartService } from './excel-chart.service.js';

@Module({
  providers: [ExcelChartService],
  exports: [ExcelChartService],
})
export class ChartsModule {}
