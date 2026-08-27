import { Injectable } from '@nestjs/common';
import { CHART_TYPES } from '../charts/chart.types.js';
import {
  ExcelChartService,
  type ExcelChartRequest,
} from '../charts/excel-chart.service.js';
import type { AgentTool, ToolContext, ToolDefinition } from './tool.types.js';

/**
 * excel_to_echarts：把用户上传的 Excel 解析成 ECharts 图表并直接渲染到会话里。
 *
 * 解析、类型识别、选型与 option 生成全部在服务端确定性完成，模型只负责
 * 「用哪张表、拿哪几列、画哪种图」这类决策，以及拿到分析结论后写解读文字。
 * option 不回灌给模型，避免几 KB 的 JSON 挤占上下文或被截断。
 */
@Injectable()
export class ExcelToEchartsTool implements AgentTool {
  readonly name = 'excel_to_echarts';

  readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'excel_to_echarts',
      description: [
        '把用户上传的 Excel（.xlsx/.xlsm）解析成 ECharts 图表，并直接渲染在当前会话中。',
        '当用户上传表格并要求出图、可视化、看趋势/占比/对比时调用。',
        '服务端会自己定位表头、识别列的数据类型并推荐图表类型，因此参数全部可选：',
        '不确定画什么就不要传 chartType，让服务端按数据结构推荐。',
        '需要多张图（例如既看趋势又看占比、或多个工作表）时，在同一轮里并行发起多次调用。',
        '但用户要求「柱状图和折线图合并/画在一个图里/双轴图」时，只调用一次并传 chartType=comboBarLine，不要拆成两次调用。',
        '图表由前端渲染，你不要输出 ECharts option 或图片链接，只需在工具返回后解读数据。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          fileName: {
            type: 'string',
            description:
              '要解析的 Excel 文件名，与用户上传的附件名一致；只有一个表格文件时可省略',
          },
          sheetName: {
            type: 'string',
            description: '工作表名，省略则取第一个有数据的工作表',
          },
          chartType: {
            type: 'string',
            enum: [...CHART_TYPES],
            description:
              '图表类型：line=折线(趋势)，area=面积，bar=柱状(对比)，stackedBar=堆叠柱，horizontalBar=横向柱(类目多或名称长)，comboBarLine=柱线组合图(柱状与折线画在同一张图，用户要「合并图/双轴图/柱状+折线」时用它，需≥2个数值列，量级差大时自动加次坐标轴)，pie=饼图(占比)，doughnut=环形，scatter=散点(相关性)，radar=雷达(多维度，需≥3个数值列)，funnel=漏斗(转化)，auto=由服务端推荐',
          },
          lineFields: {
            type: 'array',
            items: { type: 'string' },
            description:
              'comboBarLine 专用：画成折线的指标表头名，其余数值列画柱状；省略则取最后一个指标（通常是增长率/占比这类派生指标）',
          },
          title: {
            type: 'string',
            description: '图表标题，省略则由服务端按工作表与指标名生成',
          },
          categoryField: {
            type: 'string',
            description:
              '类目轴（x 轴）字段的表头名，如「月份」「城市」；省略则自动选时间列或维度列',
          },
          valueFields: {
            type: 'array',
            items: { type: 'string' },
            description:
              '数值系列字段的表头名列表，如 ["销售额","利润"]；省略则使用全部数值列',
          },
          topN: {
            type: 'number',
            description: '类目型图表最多展示的类目数，按第一个指标降序取前 N，默认 50',
          },
        },
      },
    },
  };

  constructor(private readonly excelChartService: ExcelChartService) {}

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<Record<string, unknown>> {
    const fileName =
      typeof args.fileName === 'string' ? args.fileName : undefined;
    const file = this.excelChartService.pickExcel(ctx.attachments, fileName);
    if (!file) {
      return {
        ok: false,
        error:
          '本轮没有可解析的 Excel 附件，请提示用户上传 .xlsx 文件后重试（.xls 旧格式不支持）',
      };
    }

    const req: ExcelChartRequest = {
      sheetName: typeof args.sheetName === 'string' ? args.sheetName : undefined,
      chartType: args.chartType as ExcelChartRequest['chartType'],
      title: typeof args.title === 'string' ? args.title : undefined,
      categoryField:
        typeof args.categoryField === 'string' ? args.categoryField : undefined,
      valueFields: Array.isArray(args.valueFields)
        ? args.valueFields.filter((v): v is string => typeof v === 'string')
        : undefined,
      lineFields: Array.isArray(args.lineFields)
        ? args.lineFields.filter((v): v is string => typeof v === 'string')
        : undefined,
      topN: typeof args.topN === 'number' ? args.topN : undefined,
    };

    const { chart, analysis, reason, sheetNames } =
      await this.excelChartService.build(file, req);

    // 图表本体直接推给前端渲染
    await ctx.onChart?.(chart);

    return {
      ok: true,
      rendered: true,
      fileName: file.name,
      sheetName: analysis.sheetName,
      availableSheets: sheetNames,
      chartType: chart.chartType,
      title: chart.title,
      chartTypeReason: reason,
      headerRow: analysis.headerRow,
      rowCount: analysis.rowCount,
      truncated: analysis.truncated,
      columns: analysis.columns.map((c) => ({
        name: c.name,
        kind: c.kind,
        distinct: c.distinct,
      })),
      instruction: [
        '图表已经渲染在用户界面上，不要再输出 option、代码块或图片链接，也不要说「无法生成图表」。',
        '请用 2-4 句话说明这张图用了哪个工作表的哪些字段、为什么用这种图型，并指出数据中的关键结论（最值、趋势、异常）。',
        'truncated 为 true 时要提醒用户数据行过多已截断。',
      ].join('\n'),
    };
  }
}
