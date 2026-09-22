import { Injectable, Logger } from '@nestjs/common';
import type { AgentTool, ToolContext, ToolDefinition } from './tool.types.js';

/**
 * fetch_us_sectors：拉取美股「各大板块」的最新涨跌幅。
 *
 * 模型没有实时行情，所以数据由这里向 Yahoo Finance 取。用 11 只 SPDR 行业 ETF
 * 代表 GICS 十一大板块（XLK 科技、XLF 金融……），涨跌幅 = (最新价 - 昨收) / 昨收。
 * 走 v8/finance/chart 接口：单只 ETF 一个请求、无需 API key / crumb，逐只并行抓取，
 * 个别失败不影响整体，只要有一只成功就返回。
 *
 * 返回值只是一组结构化行情，表格由模型按 skill 要求渲染成 Markdown —— 表格本身是
 * 纯文本，不需要像图表/流程图那样走 SSE 产物通道。
 */

/** GICS 十一大板块 → 对应的 SPDR 行业 ETF */
const SECTORS: ReadonlyArray<{ symbol: string; sector: string; en: string }> = [
  { symbol: 'XLK', sector: '信息技术', en: 'Technology' },
  { symbol: 'XLF', sector: '金融', en: 'Financials' },
  { symbol: 'XLV', sector: '医疗保健', en: 'Health Care' },
  { symbol: 'XLY', sector: '可选消费', en: 'Consumer Discretionary' },
  { symbol: 'XLP', sector: '必需消费', en: 'Consumer Staples' },
  { symbol: 'XLC', sector: '通信服务', en: 'Communication Services' },
  { symbol: 'XLI', sector: '工业', en: 'Industrials' },
  { symbol: 'XLE', sector: '能源', en: 'Energy' },
  { symbol: 'XLB', sector: '材料', en: 'Materials' },
  { symbol: 'XLRE', sector: '房地产', en: 'Real Estate' },
  { symbol: 'XLU', sector: '公用事业', en: 'Utilities' },
];

const CHART_API = 'https://query1.finance.yahoo.com/v8/finance/chart';

interface SectorQuote {
  sector: string;
  en: string;
  symbol: string;
  price: number;
  previousClose: number;
  /** 涨跌幅，百分比数值（如 1.23 表示 +1.23%） */
  changePercent: number;
  /** 该 ETF 的行情时间（Yahoo 返回的 regularMarketTime，ISO 字符串） */
  marketTime?: string;
}

interface YahooChartMeta {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketTime?: number;
  currency?: string;
}

@Injectable()
export class FetchUsSectorsTool implements AgentTool {
  private readonly logger = new Logger(FetchUsSectorsTool.name);

  readonly name = 'fetch_us_sectors';

  readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'fetch_us_sectors',
      description: [
        '拉取美股各大板块（GICS 十一大行业）的最新涨跌幅实时行情，用于把板块表现整理成表格。',
        '当用户想看美股板块涨跌幅、行业轮动、哪些板块领涨/领跌、美股大盘各行业表现时调用。',
        '数据由服务端从行情接口获取，你没有实时行情，不要自己编造价格或涨跌幅。',
        '无需任何参数，一次调用即可拿到全部板块；不要因为用户没给参数就反问。',
        '工具返回后按 sectors 数组整理成 Markdown 表格给用户，不要另外去查或杜撰数字。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  };

  async execute(
    _args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<Record<string, unknown>> {
    const settled = await Promise.all(
      SECTORS.map((s) => this.fetchOne(s, ctx.signal)),
    );

    if (ctx.signal.aborted) return { ok: false, error: '用户已取消' };

    const sectors = settled.filter((v): v is SectorQuote => v !== null);
    const failed = SECTORS.filter(
      (s) => !sectors.some((q) => q.symbol === s.symbol),
    ).map((s) => s.symbol);

    if (sectors.length === 0) {
      return {
        ok: false,
        error: '行情接口暂时不可用，未能获取任何板块数据，请稍后重试',
      };
    }

    // 按涨跌幅从高到低排，方便模型直接呈现领涨→领跌
    sectors.sort((a, b) => b.changePercent - a.changePercent);

    return {
      ok: true,
      source: 'Yahoo Finance（SPDR 行业 ETF 代表 GICS 十一大板块）',
      currency: 'USD',
      asOf: new Date().toISOString(),
      count: sectors.length,
      failedSymbols: failed.length ? failed : undefined,
      sectors: sectors.map((s) => ({
        sector: s.sector,
        symbol: s.symbol,
        price: round(s.price, 2),
        previousClose: round(s.previousClose, 2),
        changePercent: round(s.changePercent, 2),
        marketTime: s.marketTime,
      })),
      instruction: [
        '把 sectors 整理成一个 Markdown 表格返回给用户，列建议为：板块 | 代表 ETF | 最新价 | 涨跌幅。',
        '数组已按涨跌幅从高到低排好，直接保留该顺序即可。',
        'changePercent 是百分比数值，展示时补上 % 和正负号（如 +1.23% / -0.80%）。',
        '表格上方用一句话点出领涨/领跌板块，下方注明数据来源与 asOf 时间（美股行情，USD）。',
        failed.length
          ? `有 ${failed.length} 个板块（${failed.join('、')}）本次未取到，如实说明缺失，不要编造。`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  /** 抓单只 ETF；失败返回 null，由上层聚合时过滤 */
  private async fetchOne(
    def: (typeof SECTORS)[number],
    signal: AbortSignal,
  ): Promise<SectorQuote | null> {
    try {
      const res = await fetch(`${CHART_API}/${def.symbol}`, {
        signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = (await res.json()) as {
        chart?: { result?: Array<{ meta?: YahooChartMeta }> };
      };
      const meta = json.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const prevClose = meta?.chartPreviousClose ?? meta?.previousClose;

      if (
        typeof price !== 'number' ||
        typeof prevClose !== 'number' ||
        prevClose === 0
      ) {
        throw new Error('行情字段缺失');
      }

      return {
        sector: def.sector,
        en: def.en,
        symbol: def.symbol,
        price,
        previousClose: prevClose,
        changePercent: ((price - prevClose) / prevClose) * 100,
        marketTime: meta?.regularMarketTime
          ? new Date(meta.regularMarketTime * 1000).toISOString()
          : undefined,
      };
    } catch (e) {
      if (signal.aborted) return null;
      this.logger.warn(
        `拉取 ${def.symbol} 行情失败：${(e as Error).message || String(e)}`,
      );
      return null;
    }
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
