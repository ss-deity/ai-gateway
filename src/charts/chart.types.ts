/**
 * 图表产物类型：服务端把 Excel 解析成 ECharts option 后，
 * 经 SSE 的 charts 通道直接下发给前端渲染（不经过模型复述，避免大 JSON 占用上下文）。
 */

/** 支持的图表类型；auto 表示由服务端按数据结构推荐 */
export const CHART_TYPES = [
  'auto',
  'line',
  'area',
  'bar',
  'stackedBar',
  'horizontalBar',
  'comboBarLine',
  'pie',
  'doughnut',
  'scatter',
  'radar',
  'funnel',
] as const;

export type ChartType = (typeof CHART_TYPES)[number];

/** 实际产出的图表类型（不含 auto） */
export type ResolvedChartType = Exclude<ChartType, 'auto'>;

/** 单列的推断结果 */
export interface ColumnInfo {
  /** 表头文本 */
  name: string;
  /** 在表格中的列下标 */
  index: number;
  /** number=数值，date=日期/时间，category=文本枚举 */
  kind: 'number' | 'date' | 'category';
  /** 非空值数量 */
  filled: number;
  /** 去重后的取值数量 */
  distinct: number;
}

/** 一次 Excel 结构分析的结果，同时回灌给模型作为「我看懂了什么」 */
export interface SheetAnalysis {
  sheetName: string;
  /** 表头所在行号（1 基，取自 Excel 原始行号）；0 表示该表没有表头，列名为自动生成 */
  headerRow: number;
  rowCount: number;
  columns: ColumnInfo[];
  /** 被截断时为 true（数据行数超过上限） */
  truncated: boolean;
}

/** 下发给前端的一张图表 */
export interface ChartArtifact {
  /** 前端 key，服务端生成 */
  id: string;
  title: string;
  /** 最终采用的图表类型 */
  chartType: ResolvedChartType;
  /** 数据来源工作表 */
  sheetName: string;
  /** 源文件名 */
  fileName: string;
  /** 完整的 ECharts option，前端原样 setOption */
  option: Record<string, unknown>;
}
