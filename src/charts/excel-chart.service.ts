import { Injectable, Logger } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { randomUUID } from 'crypto';
import {
  cellText,
  fetchAttachmentBuffer,
  isExcelAttachment,
} from '../models/attachment-text.js';
import type { Attachment } from '../models/model.types.js';
import {
  CHART_TYPES,
  type ChartArtifact,
  type ChartType,
  type ColumnInfo,
  type ResolvedChartType,
  type SheetAnalysis,
} from './chart.types.js';

/** 下载后允许解析的最大文件体积（xlsx 是 zip 包，必须整包读入） */
const MAX_EXCEL_BYTES = Number(
  process.env.CHART_MAX_EXCEL_BYTES || 20 * 1024 * 1024,
);

/** 单表最多参与分析的数据行数（不含表头） */
const MAX_DATA_ROWS = Number(process.env.CHART_MAX_DATA_ROWS || 5000);

/** 类目型图表（柱/饼/漏斗）最多展示的类目数，超出按数值取前 N */
const DEFAULT_TOP_N = 50;

/** 饼图/环形图最多展示的扇区数，超出的合并为「其他」 */
const MAX_PIE_SLICES = 12;

/** 雷达图最多叠加的行数（每行一条雷达线） */
const MAX_RADAR_ROWS = 6;

/** 类目数超过该值时给折线/柱状图挂上缩放条 */
const DATA_ZOOM_THRESHOLD = 30;

/** 类目数超过该值时折线图不再画数据点，避免连成一片实心线 */
const LINE_SYMBOL_THRESHOLD = 40;

/** 组合图里两组指标的量级差到这个倍数就给折线挂次坐标轴 */
const SECOND_AXIS_RATIO = 8;

/** 归一化后的单元格值 */
type CellValue = string | number | Date | null;

export interface ExcelChartRequest {
  /** 指定工作表名；缺省取第一个有内容的表 */
  sheetName?: string;
  /** 指定图表类型；auto / 缺省时由服务端推荐 */
  chartType?: ChartType;
  /** 图表标题；缺省用「工作表名 + 指标名」拼 */
  title?: string;
  /** 指定类目轴（x 轴）字段的表头名 */
  categoryField?: string;
  /** 指定数值系列字段的表头名列表 */
  valueFields?: string[];
  /** comboBarLine 专用：这些指标画成折线，其余画柱状；缺省取最后一个指标 */
  lineFields?: string[];
  /** 类目型图表最多展示的类目数 */
  topN?: number;
}

export interface ExcelChartResult {
  chart: ChartArtifact;
  analysis: SheetAnalysis;
  /** 选择该图表类型的依据，回灌给模型用于解读 */
  reason: string;
  /** 可选工作表名，便于模型换表重试 */
  sheetNames: string[];
}

/**
 * Excel → ECharts option。
 *
 * 完整流程：下载 xlsx → 取工作表 → 定位表头 → 逐列识别数据类型 →
 * 分析数据结构（类目/时间/数值列的组合）→ 判断适合的图表类型 → 生成 option。
 * 只做确定性计算，不依赖模型输出 option，避免大表场景下 JSON 被截断或算错。
 */
@Injectable()
export class ExcelChartService {
  private readonly logger = new Logger(ExcelChartService.name);

  /** 从本轮附件里挑出要解析的 Excel：优先按文件名匹配，否则取第一个 */
  pickExcel(
    attachments: Attachment[] | undefined,
    fileName?: string,
  ): Attachment | undefined {
    const excels = (attachments || []).filter(isExcelAttachment);
    if (!excels.length) return undefined;
    if (fileName) {
      const key = fileName.trim().toLowerCase();
      const hit = excels.find((a) => (a.name || '').toLowerCase() === key);
      if (hit) return hit;
      const fuzzy = excels.find((a) =>
        (a.name || '').toLowerCase().includes(key),
      );
      if (fuzzy) return fuzzy;
    }
    return excels[0];
  }

  async build(
    file: Attachment,
    req: ExcelChartRequest,
  ): Promise<ExcelChartResult> {
    const buf = await fetchAttachmentBuffer(file);
    return this.buildFromBuffer(buf, file.name, req);
  }

  /** 解析主流程；与下载解耦，便于单独验证解析与选型逻辑 */
  async buildFromBuffer(
    buf: Buffer,
    fileName: string,
    req: ExcelChartRequest,
  ): Promise<ExcelChartResult> {
    if (buf.length > MAX_EXCEL_BYTES) {
      throw new Error(
        `文件超过 ${Math.round(MAX_EXCEL_BYTES / 1024 / 1024)}MB，无法解析`,
      );
    }

    const workbook = new Workbook();
    // exceljs 的 d.ts 把参数声明成 `Buffer extends ArrayBuffer`，与 @types/node 的
    // Buffer 不兼容，运行时传 Node Buffer 才是正确用法，这里强转绕过类型冲突
    await workbook.xlsx.load(buf as unknown as ArrayBuffer);

    const sheetNames: string[] = [];
    workbook.eachSheet((s) => sheetNames.push(s.name));
    if (!sheetNames.length) throw new Error('工作簿没有工作表');

    const sheet = this.pickSheet(workbook, req.sheetName);
    if (!sheet) {
      throw new Error(
        `找不到工作表「${req.sheetName ?? ''}」，可选：${sheetNames.join('、')}`,
      );
    }

    const grid = this.readGrid(sheet);
    if (!grid.rows.length) throw new Error(`工作表「${sheet.name}」没有数据`);

    const { headerIndex, headers } = this.detectHeader(grid.rows);
    const dataRows = grid.rows.slice(headerIndex + 1);
    if (!dataRows.length) {
      throw new Error(`工作表「${sheet.name}」只有表头，没有数据行`);
    }

    const columns = this.inferColumns(headers, dataRows);
    const analysis: SheetAnalysis = {
      sheetName: sheet.name,
      headerRow: grid.rowNumbers[headerIndex] ?? headerIndex + 1,
      rowCount: dataRows.length,
      columns,
      truncated: grid.truncated,
    };

    const picked = this.pickFields(columns, req);
    const decided = this.decideChartType(req.chartType, picked, dataRows.length);

    const title =
      req.title?.trim() ||
      this.defaultTitle(sheet.name, picked.valueColumns, decided.type);

    const option = this.buildOption({
      type: decided.type,
      title,
      categoryColumn: picked.categoryColumn,
      valueColumns: picked.valueColumns,
      lineColumns: picked.lineColumns,
      dataRows,
      topN: Math.max(1, Math.min(req.topN || DEFAULT_TOP_N, 200)),
    });

    return {
      chart: {
        id: `chart_${randomUUID()}`,
        title,
        chartType: decided.type,
        sheetName: sheet.name,
        fileName,
        option,
      },
      analysis,
      reason: decided.reason,
      sheetNames,
    };
  }

  /* ------------------------------ 读取工作表 ------------------------------ */

  private pickSheet(workbook: Workbook, name?: string) {
    const sheets = workbook.worksheets;
    if (name) {
      const key = name.trim().toLowerCase();
      return sheets.find((s) => s.name.trim().toLowerCase() === key);
    }
    // 缺省取第一个有实际内容的表，避免命中空白的模板页
    return sheets.find((s) => s.actualRowCount > 0) || sheets[0];
  }

  /**
   * 把工作表读成二维数组。空行直接丢弃，同时记录原始行号，
   * 便于把表头行号如实告诉模型。
   */
  private readGrid(sheet: {
    eachRow: (
      opts: { includeEmpty: boolean },
      cb: (row: any, rowNumber: number) => void,
    ) => void;
  }): { rows: CellValue[][]; rowNumbers: number[]; truncated: boolean } {
    const rows: CellValue[][] = [];
    const rowNumbers: number[] = [];
    let truncated = false;

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      // 已经够多了：继续遍历只是浪费，标记截断即可（exceljs 不支持中断遍历）
      if (rows.length > MAX_DATA_ROWS) {
        truncated = true;
        return;
      }
      const cells: CellValue[] = [];
      row.eachCell({ includeEmpty: true }, (cell: any) => {
        cells.push(this.normalizeCell(cell.value));
      });
      while (cells.length && isBlank(cells[cells.length - 1])) cells.pop();
      if (cells.some((c) => !isBlank(c))) {
        rows.push(cells);
        rowNumbers.push(rowNumber);
      }
    });

    return { rows, rowNumbers, truncated };
  }

  /** exceljs 的富文本 / 公式 / 超链接单元格统一归一化成 string | number | Date */
  private normalizeCell(value: unknown): CellValue {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || value instanceof Date) return value;
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'object') {
      const v = value as { result?: unknown };
      // 公式单元格取计算结果，结果本身可能是数字或日期
      if (v.result !== undefined) return this.normalizeCell(v.result);
      const text = cellText(value).trim();
      return text || null;
    }
    const text = String(value).trim();
    return text || null;
  }

  /* ------------------------------ 表头与类型 ------------------------------ */

  /**
   * 定位表头行：跳过「大标题 / 说明」这类只有一两个单元格的前置行，
   * 取前 10 行里列数最多、且不以数值开头的那一行作为表头。
   * 找不到合适的表头就用 列1、列2… 兜底，第一行仍算数据。
   */
  private detectHeader(rows: CellValue[][]): {
    headerIndex: number;
    headers: string[];
  } {
    const scan = rows.slice(0, 10);
    const maxWidth = Math.max(...scan.map((r) => countFilled(r)));

    for (let i = 0; i < scan.length; i++) {
      const row = scan[i];
      if (countFilled(row) < maxWidth) continue;
      const filled = row.filter((c) => !isBlank(c));
      // 表头应当是文本；整行都是数字说明这张表没有表头
      const textual = filled.filter((c) => typeof c === 'string').length;
      if (textual >= Math.ceil(filled.length * 0.6)) {
        return { headerIndex: i, headers: buildHeaders(row) };
      }
      break;
    }

    const width = Math.max(...rows.map((r) => r.length));
    return {
      headerIndex: -1,
      headers: Array.from({ length: width }, (_, i) => `列${i + 1}`),
    };
  }

  /**
   * 逐列识别数据类型：先看日期，再看数值，其余归为类目。
   * 判定按「非空值中的占比」，容忍个别脏数据（备注、'-'、'暂无' 等）。
   */
  private inferColumns(headers: string[], dataRows: CellValue[][]): ColumnInfo[] {
    return headers.map((name, index) => {
      const values = dataRows
        .map((r) => r[index])
        .filter((v): v is Exclude<CellValue, null> => !isBlank(v));

      const dateCount = values.filter((v) => toDate(v) !== null).length;
      const numberCount = values.filter((v) => toNumber(v) !== null).length;
      const filled = values.length;

      let kind: ColumnInfo['kind'] = 'category';
      if (filled && dateCount / filled >= 0.8) kind = 'date';
      else if (filled && numberCount / filled >= 0.8) kind = 'number';

      return {
        name,
        index,
        kind,
        filled,
        distinct: new Set(values.map((v) => keyOf(v))).size,
      };
    });
  }

  /* ---------------------------- 结构分析与选型 ---------------------------- */

  /**
   * 选出类目轴与数值系列。
   * 显式指定的字段优先；否则时间列优先做 x 轴，其次取重复度最低的文本列。
   */
  private pickFields(
    columns: ColumnInfo[],
    req: ExcelChartRequest,
  ): {
    categoryColumn?: ColumnInfo;
    valueColumns: ColumnInfo[];
    lineColumns: ColumnInfo[];
  } {
    const byName = (name: string) =>
      columns.find(
        (c) => c.name.trim().toLowerCase() === name.trim().toLowerCase(),
      );

    let categoryColumn = req.categoryField ? byName(req.categoryField) : undefined;
    let valueColumns = (req.valueFields || [])
      .map(byName)
      .filter((c): c is ColumnInfo => !!c && c.kind === 'number');

    if (!categoryColumn) {
      const dateCol = columns.find((c) => c.kind === 'date' && c.filled > 0);
      const textCols = columns
        .filter((c) => c.kind === 'category' && c.filled > 0)
        // 取值越少越像维度（订单号这类唯一值列不适合做 x 轴）
        .sort((a, b) => a.distinct - b.distinct);
      categoryColumn = dateCol || textCols[0];
    }

    if (!valueColumns.length) {
      valueColumns = columns.filter(
        (c) => c.kind === 'number' && c.index !== categoryColumn?.index,
      );
    }

    if (!valueColumns.length) {
      throw new Error(
        `没有识别到可用于绘图的数值列（列：${columns.map((c) => `${c.name}[${c.kind}]`).join('、')}）`,
      );
    }

    // 系列过多时图会糊掉，只取前 8 个指标
    const kept = valueColumns.slice(0, 8);

    // 组合图里画成折线的那部分指标；显式指定优先，否则取最后一个
    // （表格里「增长率 / 占比 / 均价」这类派生指标通常排在原始值后面）
    const explicitLines = (req.lineFields || [])
      .map(byName)
      .filter((c): c is ColumnInfo => !!c && kept.some((k) => k.index === c.index));
    const lineColumns = explicitLines.length
      ? explicitLines
      : kept.length > 1
        ? [kept[kept.length - 1]]
        : [];

    return { categoryColumn, valueColumns: kept, lineColumns };
  }

  /**
   * 判断适合的图表类型：
   * - 时间轴 + 数值 → 折线（趋势）
   * - 类目 + 单指标：类目少且非负 → 饼图，否则柱状图（类目多则改横向）
   * - 类目 + 多指标 → 分组柱状图
   * - 无类目列、两列以上数值 → 散点图
   */
  private decideChartType(
    requested: ChartType | undefined,
    picked: {
      categoryColumn?: ColumnInfo;
      valueColumns: ColumnInfo[];
      lineColumns?: ColumnInfo[];
    },
    rowCount: number,
  ): { type: ResolvedChartType; reason: string } {
    const { categoryColumn, valueColumns } = picked;

    if (requested && requested !== 'auto') {
      if (!CHART_TYPES.includes(requested)) {
        throw new Error(`不支持的图表类型：${String(requested)}`);
      }
      if (requested === 'comboBarLine') {
        if (valueColumns.length < 2) {
          throw new Error(
            `柱线组合图至少需要 2 个数值列，当前只识别到「${valueColumns.map((c) => c.name).join('、')}」`,
          );
        }
        const lines = picked.lineColumns ?? [];
        const bars = valueColumns.filter(
          (c) => !lines.some((l) => l.index === c.index),
        );
        return {
          type: 'comboBarLine',
          reason: `柱状：${bars.map((c) => c.name).join('、') || '无'}；折线：${lines.map((c) => c.name).join('、') || '无'}，画在同一张图上`,
        };
      }
      return { type: requested, reason: `按调用方指定的类型 ${requested} 绘制` };
    }

    if (!categoryColumn) {
      if (valueColumns.length >= 2) {
        return {
          type: 'scatter',
          reason: '没有类目/时间列，两个数值列适合看相关性，选散点图',
        };
      }
      return { type: 'bar', reason: '只有单个数值列，按行序绘制柱状图' };
    }

    if (categoryColumn.kind === 'date') {
      return {
        type: 'line',
        reason: `「${categoryColumn.name}」是时间列，${valueColumns.length} 个指标随时间变化，选折线图看趋势`,
      };
    }

    if (valueColumns.length === 1) {
      if (rowCount <= 8) {
        return {
          type: 'pie',
          reason: `单指标 + ${rowCount} 个类目，适合看占比，选饼图`,
        };
      }
      if (rowCount > 15) {
        return {
          type: 'horizontalBar',
          reason: `单指标 + ${rowCount} 个类目，纵向标签会挤在一起，选横向柱状图`,
        };
      }
      return { type: 'bar', reason: '单指标 + 中等数量类目，选柱状图做对比' };
    }

    return {
      type: 'bar',
      reason: `${valueColumns.length} 个指标在同一批类目上对比，选分组柱状图`,
    };
  }

  private defaultTitle(
    sheetName: string,
    valueColumns: ColumnInfo[],
    type: ResolvedChartType,
  ): string {
    const names = valueColumns.map((c) => c.name).slice(0, 3).join('、');
    if (!names) return sheetName;
    const suffix =
      type === 'pie' || type === 'doughnut'
        ? '占比'
        : type === 'line' || type === 'area'
          ? '趋势'
          : '对比';
    // 指标名本身已经带了「占比 / 趋势 / 对比」时不再叠加，避免出现「占比占比」
    return names.endsWith(suffix) ? `${sheetName} · ${names}` : `${sheetName} · ${names}${suffix}`;
  }

  /* ------------------------------ option 生成 ------------------------------ */

  private buildOption(args: {
    type: ResolvedChartType;
    title: string;
    categoryColumn?: ColumnInfo;
    valueColumns: ColumnInfo[];
    lineColumns?: ColumnInfo[];
    dataRows: CellValue[][];
    topN: number;
  }): Record<string, unknown> {
    const {
      type,
      title,
      categoryColumn,
      valueColumns,
      lineColumns,
      dataRows,
      topN,
    } = args;

    if (type === 'scatter') {
      return this.buildScatter(title, valueColumns, dataRows);
    }
    if (type === 'radar') {
      return this.buildRadar(title, categoryColumn, valueColumns, dataRows);
    }

    const table = this.toSeriesTable({
      categoryColumn,
      valueColumns,
      dataRows,
      // 时间轴要保持原有顺序，其它类目按第一个指标降序取前 N
      sortDesc: categoryColumn?.kind !== 'date',
      topN,
    });

    if (type === 'pie' || type === 'doughnut') {
      return this.buildPie(title, table, type === 'doughnut');
    }
    if (type === 'funnel') {
      return this.buildFunnel(title, table);
    }

    // 组合图：把「哪些列画折线」换算成系列下标，series 与 valueColumns 顺序一致
    const lineIndexes =
      type === 'comboBarLine'
        ? new Set(
            valueColumns
              .map((c, i) =>
                (lineColumns || []).some((l) => l.index === c.index) ? i : -1,
              )
              .filter((i) => i >= 0),
          )
        : undefined;

    return this.buildCartesian(title, type, table, lineIndexes);
  }

  /** 把数据行整理成「类目 + 每个指标一条数值序列」，并做排序/截断 */
  private toSeriesTable(args: {
    categoryColumn?: ColumnInfo;
    valueColumns: ColumnInfo[];
    dataRows: CellValue[][];
    sortDesc: boolean;
    topN: number;
  }): { categories: string[]; series: { name: string; data: (number | null)[] }[] } {
    const { categoryColumn, valueColumns, dataRows, sortDesc, topN } = args;

    const items = dataRows
      .map((row, i) => ({
        category: categoryColumn
          ? labelOf(row[categoryColumn.index])
          : `第${i + 1}行`,
        values: valueColumns.map((c) => toNumber(row[c.index])),
      }))
      // 整行数值全空的多为小计/空行，直接丢掉
      .filter((it) => it.values.some((v) => v !== null));

    const sorted = sortDesc
      ? [...items].sort((a, b) => (b.values[0] ?? 0) - (a.values[0] ?? 0))
      : items;
    const limited = sorted.slice(0, topN);

    return {
      categories: limited.map((it) => it.category),
      series: valueColumns.map((c, ci) => ({
        name: c.name,
        data: limited.map((it) => it.values[ci]),
      })),
    };
  }

  /**
   * 公共外观：只放与数据/布局相关的配置，颜色一律不写。
   *
   * 配色交给前端注册的 echarts 主题（light / dark）：option 里显式写的颜色
   * 优先级高于主题，一旦在这里写死，同一份落库的 option 就锁死了一种配色，
   * 用户切到暗色主题时文字和网格线会看不见。
   *
   * tooltip 只保留行为：confine=true——图表卡片有 overflow 限制，
   * 不限制在容器内的话，靠边或靠顶的数据点 hover 出来的浮层会被裁掉一半。
   */
  private baseOption(
    title: string,
    trigger: 'axis' | 'item',
  ): Record<string, unknown> {
    return {
      title: { text: title, left: 'center', top: 6 },
      tooltip: buildTooltip(trigger),
      // 图表在会话里宽度有限，动画留着但时长短一点
      animationDuration: 400,
    };
  }

  /**
   * 单系列时图例没有信息量，隐藏后能把高度让给图形；
   * 多系列才显示，并按是否显示图例给 grid 留出不同的顶部间距。
   */
  private legendOf(count: number, position: 'top' | 'bottom') {
    if (count <= 1) return { show: false };
    return {
      show: true,
      type: 'scroll',
      icon: 'circle',
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 14,
      ...(position === 'top' ? { top: 30 } : { bottom: 4 }),
    };
  }

  /**
   * 组合图是否需要次坐标轴：比较柱组与折线组的最大绝对值，
   * 差到 SECOND_AXIS_RATIO 倍就分轴（典型场景：销量 vs 增长率）。
   */
  private needsSecondAxis(
    table: { series: { data: (number | null)[] }[] },
    lineIndexes?: Set<number>,
  ): boolean {
    if (!lineIndexes?.size || lineIndexes.size === table.series.length) {
      return false;
    }
    const peak = (indexes: number[]) =>
      Math.max(
        0,
        ...indexes.flatMap((i) =>
          table.series[i].data.map((v) => Math.abs(v ?? 0)),
        ),
      );
    const all = table.series.map((_, i) => i);
    const linePeak = peak(all.filter((i) => lineIndexes.has(i)));
    const barPeak = peak(all.filter((i) => !lineIndexes.has(i)));
    const [min, max] = linePeak < barPeak ? [linePeak, barPeak] : [barPeak, linePeak];
    if (min <= 0) return max > 0;
    return max / min >= SECOND_AXIS_RATIO;
  }

  private buildCartesian(
    title: string,
    type: ResolvedChartType,
    table: { categories: string[]; series: { name: string; data: (number | null)[] }[] },
    /** comboBarLine 专用：这些下标的系列画成折线，其余画柱状 */
    lineIndexes?: Set<number>,
  ): Record<string, unknown> {
    const combo = type === 'comboBarLine';
    const horizontal = type === 'horizontalBar';
    const stacked = type === 'stackedBar';
    const allLine = type === 'line' || type === 'area';
    const isLineAt = (i: number) =>
      combo ? !!lineIndexes?.has(i) : allLine;
    const multi = table.series.length > 1;
    const zoomed = table.categories.length > DATA_ZOOM_THRESHOLD;
    // 类目多且横排时把标签斜过来，避免文字相互重叠
    const rotate = !horizontal && table.categories.length > 8 ? 30 : 0;
    // 组合图里柱和折线共用一根值轴时，量级差太多会把小的那组压成一条平线，
    // 这时给折线挂一根右侧次坐标轴
    const secondAxis = combo && this.needsSecondAxis(table, lineIndexes);

    const categoryAxis = {
      type: 'category' as const,
      data: table.categories,
      // 不显示轴名：轴名只能挂在轴末端或轴中间，末端会挤占右侧、和最后一个标签抢位置，
      // 中间又会和斜排标签重叠；类目值本身（日期/城市）已经自明，标题里也有指标名
      axisTick: { show: false },
      axisLabel: {
        rotate,
        hideOverlap: true,
        // 首尾标签默认以刻度为中心，横排时末尾那个会有一半画到 grid 外面被容器裁掉；
        // 贴边对齐后就落回绘图区内。旋转时该配置不生效（改由 grid.right 让位），
        // 类目轴竖排（横向柱图）时标签本就右对齐贴着轴，强制首尾对齐反而会错位。
        ...(rotate || horizontal
          ? {}
          : { alignMinLabel: 'left', alignMaxLabel: 'right' }),
      },
      // 组合图里有柱子，类目要占一格宽度，不能贴轴
      boundaryGap: !allLine,
      // 横向柱状图的类目轴自下向上排，反转后数值最大的排在最上面
      inverse: horizontal,
    };
    const valueAxis = {
      type: 'value' as const,
      scale: !stacked,
      // 值轴只留网格线，轴线本身省掉，图形更突出
      axisLine: { show: false },
      axisTick: { show: false },
    };
    // 次轴不重复画网格线，否则两套横线交错很脏
    const secondValueAxis = {
      ...valueAxis,
      position: 'right' as const,
      splitLine: { show: false },
    };

    const option: Record<string, unknown> = {
      ...this.baseOption(title, 'axis'),
      legend: this.legendOf(table.series.length, 'top'),
      grid: {
        left: 8,
        // 右侧留白：缩放滑块（横向柱图在右侧）> 斜排标签的末端 > 常规
        // 次坐标轴的刻度由 containLabel 兜住，不用额外加
        right: zoomed && horizontal ? 44 : rotate ? 48 : 28,
        top: multi ? 62 : 42,
        bottom: zoomed && !horizontal ? 40 : 6,
        containLabel: true,
      },
      xAxis: horizontal ? valueAxis : categoryAxis,
      yAxis: horizontal
        ? categoryAxis
        : secondAxis
          ? [valueAxis, secondValueAxis]
          : valueAxis,
      series: table.series.map((s, i) => {
        const line = isLineAt(i);
        return {
          name: s.name,
          type: line ? 'line' : 'bar',
          data: s.data,
          ...(line
            ? {
                smooth: 0.3,
                symbol: 'circle',
                symbolSize: 6,
                // 点太密时只留线，否则连成一条实心带
                showSymbol: table.categories.length <= LINE_SYMBOL_THRESHOLD,
                lineStyle: { width: 2 },
                // 面积图用低透明度填充，多系列叠加时仍能看清彼此
                ...(type === 'area' ? { areaStyle: { opacity: 0.15 } } : {}),
                // 组合图里折线要压在柱子上层，否则会被柱体挡住
                ...(combo ? { z: 3 } : {}),
                ...(secondAxis ? { yAxisIndex: 1 } : {}),
              }
            : {
                barMaxWidth: 28,
                itemStyle: {
                  borderRadius: horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0],
                },
              }),
          stack: stacked ? 'total' : undefined,
          // 单系列柱图直接标数值，多系列会太挤
          label:
            !multi && !line
              ? {
                  show: true,
                  position: horizontal ? 'right' : 'top',
                  fontSize: 11,
                }
              : undefined,
        };
      }),
    };

    if (zoomed) {
      const axis = horizontal ? { yAxisIndex: 0 } : { xAxisIndex: 0 };
      // 横向柱图的类目在纵轴上，条数一多就压成细线，初始只放开一屏的量
      const window = horizontal
        ? Math.min(100, (DATA_ZOOM_THRESHOLD / table.categories.length) * 100)
        : 100;
      // 只给可见的滑块，不加 type: 'inside'——那个会劫持滚轮做缩放，
      // 鼠标划过图表时页面就滚不动了，图表反而被缩放。
      option.dataZoom = [
        {
          type: 'slider',
          start: 0,
          end: window,
          // 纵轴的滑块是竖着的，只能给宽度；横轴的才是横着的，给高度
          ...(horizontal
            ? { width: 14, right: 6 }
            : { height: 16, bottom: 8 }),
          ...axis,
        },
      ];
    }
    return option;
  }

  private buildPie(
    title: string,
    table: { categories: string[]; series: { name: string; data: (number | null)[] }[] },
    doughnut: boolean,
  ): Record<string, unknown> {
    const serie = table.series[0];
    const pairs = table.categories.map((name, i) => ({
      name,
      value: Math.abs(serie.data[i] ?? 0),
    }));
    // 扇区过多会挤成一团，尾部合并成「其他」
    const head = pairs.slice(0, MAX_PIE_SLICES);
    const tail = pairs.slice(MAX_PIE_SLICES);
    if (tail.length) {
      head.push({
        name: '其他',
        value: tail.reduce((sum, it) => sum + it.value, 0),
      });
    }

    return {
      ...this.baseOption(title, 'item'),
      tooltip: { ...buildTooltip('item'), formatter: '{b}<br/>{c}（{d}%）' },
      legend: {
        show: true,
        type: 'scroll',
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        bottom: 4,
      },
      series: [
        {
          name: serie.name,
          type: 'pie',
          radius: doughnut ? ['46%', '70%'] : ['0%', '64%'],
          center: ['50%', '50%'],
          data: head,
          label: { formatter: '{b} {d}%', fontSize: 12 },
          labelLine: { length: 8, length2: 8 },
          emphasis: { scale: true, scaleSize: 4 },
        },
      ],
    };
  }

  private buildFunnel(
    title: string,
    table: { categories: string[]; series: { name: string; data: (number | null)[] }[] },
  ): Record<string, unknown> {
    const serie = table.series[0];
    return {
      ...this.baseOption(title, 'item'),
      tooltip: { ...buildTooltip('item'), formatter: '{b}<br/>{c}' },
      legend: {
        show: true,
        type: 'scroll',
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        bottom: 4,
      },
      series: [
        {
          name: serie.name,
          type: 'funnel',
          top: 40,
          bottom: 34,
          left: '12%',
          width: '76%',
          gap: 2,
          data: table.categories.map((name, i) => ({
            name,
            value: serie.data[i] ?? 0,
          })),
          label: { position: 'inside', formatter: '{b} {c}', fontSize: 12 },
        },
      ],
    };
  }

  private buildScatter(
    title: string,
    valueColumns: ColumnInfo[],
    dataRows: CellValue[][],
  ): Record<string, unknown> {
    const [xCol, yCol] = valueColumns;
    if (!yCol) throw new Error('散点图需要两个数值列');

    const points = dataRows
      .map((row) => [toNumber(row[xCol.index]), toNumber(row[yCol.index])])
      .filter((p): p is [number, number] => p[0] !== null && p[1] !== null);

    const axis = {
      type: 'value' as const,
      scale: true,
      axisLine: { show: false },
      axisTick: { show: false },
      // 末尾刻度值贴边，避免一半画到绘图区外被裁
      axisLabel: { alignMinLabel: 'left', alignMaxLabel: 'right' },
    };

    return {
      ...this.baseOption(title, 'item'),
      // option 要经 JSON 下发给前端，formatter 只能用字符串模板，不能用函数
      tooltip: { ...buildTooltip('item'), formatter: '{a}<br/>{c}' },
      grid: { left: 8, right: 28, top: 42, bottom: 6, containLabel: true },
      // x 轴名放下方居中、y 轴名放顶端，都不挤占右侧（放末端会和最后一个刻度值抢位置）
      xAxis: { ...axis, name: xCol.name, nameLocation: 'middle', nameGap: 26 },
      yAxis: { ...axis, name: yCol.name, nameLocation: 'end' },
      series: [
        {
          name: `${yCol.name} / ${xCol.name}`,
          type: 'scatter',
          data: points,
          symbolSize: 9,
          itemStyle: { opacity: 0.75 },
        },
      ],
    };
  }

  private buildRadar(
    title: string,
    categoryColumn: ColumnInfo | undefined,
    valueColumns: ColumnInfo[],
    dataRows: CellValue[][],
  ): Record<string, unknown> {
    if (valueColumns.length < 3) {
      throw new Error('雷达图需要至少 3 个数值列作为维度');
    }
    const rows = dataRows
      .map((row, i) => ({
        name: categoryColumn ? labelOf(row[categoryColumn.index]) : `第${i + 1}行`,
        values: valueColumns.map((c) => toNumber(row[c.index]) ?? 0),
      }))
      .slice(0, MAX_RADAR_ROWS);

    const indicator = valueColumns.map((c, ci) => ({
      name: c.name,
      max: Math.max(...rows.map((r) => r.values[ci]), 0) * 1.1 || 1,
    }));

    return {
      ...this.baseOption(title, 'item'),
      legend: this.legendOf(rows.length, 'bottom'),
      // radar 组件的轴线/文字颜色由前端按主题补齐
      radar: { indicator, center: ['50%', '52%'], radius: '60%', splitNumber: 4 },
      series: [
        {
          type: 'radar',
          symbolSize: 4,
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.12 },
          data: rows.map((r) => ({ name: r.name, value: r.values })),
        },
      ],
    };
  }
}

/* --------------------------------- 工具函数 --------------------------------- */

/**
 * tooltip 只声明行为，外观（底色、文字色、指示线颜色）由前端主题决定。
 * confine 必须为 true——图表容器有 overflow 限制，浮层溢出后会被裁掉。
 * axis 触发用 cross 指示线，便于在多系列折线里对齐读数。
 */
function buildTooltip(trigger: 'axis' | 'item'): Record<string, unknown> {
  return {
    trigger,
    confine: true,
    ...(trigger === 'axis' ? { axisPointer: { type: 'cross' } } : {}),
  };
}

function isBlank(v: CellValue): boolean {
  return v === null || v === undefined || (typeof v === 'string' && !v.trim());
}

function countFilled(row: CellValue[]): number {
  return row.filter((c) => !isBlank(c)).length;
}

/** 表头去空、去重复（同名列补后缀，避免系列名撞车） */
function buildHeaders(row: CellValue[]): string[] {
  const used = new Map<string, number>();
  return row.map((cell, i) => {
    const raw = isBlank(cell) ? `列${i + 1}` : labelOf(cell);
    const seen = used.get(raw) ?? 0;
    used.set(raw, seen + 1);
    return seen ? `${raw}_${seen + 1}` : raw;
  });
}

function labelOf(v: CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return formatDate(v);
  return String(v).replace(/\s*\n\s*/g, ' ').trim();
}

function keyOf(v: Exclude<CellValue, null>): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function formatDate(d: Date): string {
  const iso = d.toISOString();
  // 零点整的值当日期看，带时分的保留到分钟
  return iso.endsWith('T00:00:00.000Z')
    ? iso.slice(0, 10)
    : iso.slice(0, 16).replace('T', ' ');
}

/**
 * 文本转数值：容忍千分位、货币符号、百分号与括号负数（会计写法 (123) 表示 -123）。
 * 百分号按字面值保留（12% → 12），避免和原表口径不一致。
 */
function toNumber(v: CellValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let text = v.trim();
  if (!text) return null;
  const negative = /^\((.*)\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  text = text.replace(/[,，\s¥￥$%]/g, '');
  if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** 文本转日期：只认常见的年月日写法，避免把 "2024" 这类纯数字误判成日期 */
function toDate(v: CellValue): Date | null {
  if (v instanceof Date) return v;
  if (typeof v !== 'string') return null;
  const text = v.trim();
  if (
    !/^\d{4}[-/年]\d{1,2}([-/月]\d{1,2}日?)?/.test(text) &&
    !/^\d{1,2}[-/]\d{1,2}([-/]\d{2,4})?$/.test(text)
  ) {
    return null;
  }
  const normalized = text
    .replace(/年|月/g, '-')
    .replace(/日/g, '')
    .replace(/\//g, '-')
    .replace(/-$/, '');
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}
