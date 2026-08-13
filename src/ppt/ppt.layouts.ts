import type PptxGenJS from 'pptxgenjs';
import { fontOf, paletteAt, type ThemeStyle } from './ppt.theme.js';
import type { PptLanguage, PptMetric, PptSlideSpec } from './ppt.types.js';

/* 16:9 画布尺寸（英寸）与统一的留白 */
const SLIDE_W = 10;
const SLIDE_H = 5.625;
const MARGIN_X = 0.6;
const CONTENT_W = SLIDE_W - MARGIN_X * 2;
const FOOTER_Y = 5.08;
const BODY_BOTTOM = 4.92;

/** 渲染一页所需的公共上下文 */
export interface SlideContext {
  pptx: PptxGenJS;
  theme: ThemeStyle;
  language: PptLanguage;
  /** 整份 PPT 的标题，作为页脚 */
  docTitle: string;
  /** 当前内容页序号（从 1 开始） */
  index: number;
  /** 内容页总数 */
  total: number;
}

/** 语言相关的固定文案 */
const TEXT: Record<PptLanguage, Record<string, string>> = {
  'zh-CN': {
    agenda: '目录',
    thanks: '谢谢观看',
    thanksSub: '欢迎交流与提问',
    takeaway: '结论',
  },
  'en-US': {
    agenda: 'Agenda',
    thanks: 'Thank You',
    thanksSub: 'Questions & Discussion',
    takeaway: 'Takeaway',
  },
};

function t(language: PptLanguage, key: string): string {
  return TEXT[language][key] ?? key;
}

/** 无边框填充：几乎每个装饰形状都要，抽出来少写几行 */
function fill(color: string, transparency?: number) {
  return {
    fill: { color, transparency },
    line: { color, width: 0 },
  } as const;
}

/** 内容页的背景装饰：只保留左侧竖色条（边角的装饰圆按需求去掉了） */
function decorate(slide: PptxGenJS.Slide, theme: ThemeStyle): void {
  slide.addShape('rect', {
    x: 0,
    y: 0,
    w: 0.1,
    h: SLIDE_H,
    ...fill(theme.accent),
  });
}

/**
 * 页眉（标题 + 强调短线 + 可选导语）与页脚（文档名 + 页码），
 * 返回正文可用的起始 y。
 */
function frame(
  slide: PptxGenJS.Slide,
  ctx: SlideContext,
  spec: PptSlideSpec,
): number {
  const { theme, language, docTitle, index, total } = ctx;
  const font = fontOf(language);

  slide.addText(spec.title, {
    x: MARGIN_X,
    y: 0.34,
    w: CONTENT_W - 0.6,
    h: 0.6,
    fontSize: 24,
    bold: true,
    color: theme.title,
    fontFace: font,
    valign: 'middle',
  });
  slide.addShape('rect', {
    x: MARGIN_X + 0.02,
    y: 1.0,
    w: 0.7,
    h: 0.06,
    ...fill(theme.accent),
  });

  let bodyTop = 1.32;
  if (spec.subtitle) {
    slide.addText(spec.subtitle, {
      x: MARGIN_X,
      y: 1.12,
      w: CONTENT_W,
      h: 0.34,
      fontSize: 13,
      color: theme.muted,
      fontFace: font,
    });
    bodyTop = 1.6;
  }

  // 页脚：一条细分隔线 + 左侧文档名 + 右侧页码
  slide.addShape('rect', {
    x: MARGIN_X,
    y: FOOTER_Y - 0.06,
    w: CONTENT_W,
    h: 0.012,
    ...fill(theme.line),
  });
  slide.addText(docTitle, {
    x: MARGIN_X,
    y: FOOTER_Y,
    w: 6,
    h: 0.3,
    fontSize: 9,
    color: theme.muted,
    fontFace: font,
  });
  slide.addText(`${index} / ${total}`, {
    x: SLIDE_W - MARGIN_X - 1,
    y: FOOTER_Y,
    w: 1,
    h: 0.3,
    fontSize: 9,
    color: theme.muted,
    fontFace: font,
    align: 'right',
  });

  return bodyTop;
}

/** 底部结论条：浅底色块 + 「结论」标签 + 一句话 */
function takeawayBar(
  slide: PptxGenJS.Slide,
  ctx: SlideContext,
  text: string,
): number {
  const { theme, language } = ctx;
  const font = fontOf(language);
  const y = BODY_BOTTOM - 0.62;

  slide.addShape('roundRect', {
    x: MARGIN_X,
    y,
    w: CONTENT_W,
    h: 0.56,
    rectRadius: 0.06,
    ...fill(theme.surface),
  });
  slide.addShape('rect', {
    x: MARGIN_X,
    y,
    w: 0.06,
    h: 0.56,
    ...fill(theme.accent),
  });
  slide.addText(
    [
      {
        text: `${t(language, 'takeaway')}\u3000`,
        options: { bold: true, color: theme.accent },
      },
      { text, options: { color: theme.text } },
    ],
    {
      x: MARGIN_X + 0.2,
      y,
      w: CONTENT_W - 0.4,
      h: 0.56,
      fontSize: 13,
      fontFace: font,
      valign: 'middle',
    },
  );

  return y - 0.2;
}

/** 讲者备注：模型给了 notes 就用它，否则把要点拼起来兜底 */
function addNotes(
  slide: PptxGenJS.Slide,
  spec: PptSlideSpec,
  bullets: string[],
): void {
  const notes = spec.notes?.trim() || bullets.join('\n');
  if (notes) slide.addNotes(notes);
}

/** 建一页内容页：底色 + 装饰 + 页眉页脚，返回正文区域 */
function newContentSlide(
  ctx: SlideContext,
  spec: PptSlideSpec,
): { slide: PptxGenJS.Slide; top: number; bottom: number } {
  const slide = ctx.pptx.addSlide();
  slide.background = { color: ctx.theme.bg };
  decorate(slide, ctx.theme);
  const top = frame(slide, ctx, spec);
  const bottom = spec.takeaway
    ? takeawayBar(slide, ctx, spec.takeaway)
    : BODY_BOTTOM;
  return { slide, top, bottom };
}

/* ============================ 各版式 ============================ */

/** 编号要点列表：左侧序号色块 + 右侧文案 + 细分隔线 */
export function addBulletsSlide(
  ctx: SlideContext,
  spec: PptSlideSpec,
  bullets: string[],
): void {
  const { theme, language } = ctx;
  const font = fontOf(language);
  const { slide, top, bottom } = newContentSlide(ctx, spec);

  const items = bullets.slice(0, 6);
  const gap = 0.12;
  const rowH = Math.min(
    0.78,
    (bottom - top - gap * (items.length - 1)) / items.length,
  );
  const chip = Math.min(0.36, rowH - 0.06);

  items.forEach((text, i) => {
    const y = top + i * (rowH + gap);
    slide.addShape('roundRect', {
      x: MARGIN_X + 0.05,
      y: y + (rowH - chip) / 2,
      w: chip,
      h: chip,
      rectRadius: 0.05,
      ...fill(paletteAt(theme, i)),
    });
    slide.addText(String(i + 1), {
      x: MARGIN_X + 0.05,
      y: y + (rowH - chip) / 2,
      w: chip,
      h: chip,
      fontSize: 13,
      bold: true,
      color: 'FFFFFF',
      fontFace: font,
      align: 'center',
      valign: 'middle',
    });
    slide.addText(text, {
      x: MARGIN_X + 0.62,
      y,
      w: CONTENT_W - 0.7,
      h: rowH,
      fontSize: items.length > 4 ? 14 : 16,
      color: theme.text,
      fontFace: font,
      valign: 'middle',
      lineSpacingMultiple: 1.2,
    });
    if (i < items.length - 1) {
      slide.addShape('rect', {
        x: MARGIN_X + 0.62,
        y: y + rowH + gap / 2,
        w: CONTENT_W - 0.7,
        h: 0.01,
        ...fill(theme.line),
      });
    }
  });

  addNotes(slide, spec, items);
}

/** 卡片网格：短要点并排，支持「小标题：说明」写法 */
export function addCardsSlide(
  ctx: SlideContext,
  spec: PptSlideSpec,
  bullets: string[],
): void {
  const { theme, language } = ctx;
  const font = fontOf(language);
  const { slide, top, bottom } = newContentSlide(ctx, spec);

  const items = bullets.slice(0, 6);
  const cols = items.length <= 2 ? items.length : items.length <= 4 ? 2 : 3;
  const rows = Math.ceil(items.length / cols);
  const gapX = 0.26;
  const gapY = 0.24;
  const cardW = (CONTENT_W - gapX * (cols - 1)) / cols;
  const cardH = (bottom - top - gapY * (rows - 1)) / rows;

  items.forEach((raw, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = MARGIN_X + col * (cardW + gapX);
    const y = top + row * (cardH + gapY);
    const color = paletteAt(theme, i);

    slide.addShape('roundRect', {
      x,
      y,
      w: cardW,
      h: cardH,
      rectRadius: 0.08,
      fill: { color: theme.surface },
      line: { color: theme.line, width: 1 },
    });
    slide.addShape('rect', {
      x: x + 0.22,
      y: y + 0.24,
      w: 0.34,
      h: 0.07,
      ...fill(color),
    });

    // 「标题：说明」拆成卡片标题与正文，纯一句话时整体作为正文
    const split = raw.split(/[：:]/);
    const head = split.length > 1 ? split[0].trim() : '';
    const body = split.length > 1 ? split.slice(1).join('：').trim() : raw;

    if (head) {
      slide.addText(head, {
        x: x + 0.22,
        y: y + 0.42,
        w: cardW - 0.44,
        h: 0.34,
        fontSize: 15,
        bold: true,
        color: theme.title,
        fontFace: font,
      });
    }
    slide.addText(body, {
      x: x + 0.22,
      y: head ? y + 0.78 : y + 0.5,
      w: cardW - 0.44,
      h: cardH - (head ? 1.0 : 0.72),
      fontSize: 13,
      color: theme.text,
      fontFace: font,
      lineSpacingMultiple: 1.2,
      valign: 'top',
    });
  });

  addNotes(slide, spec, items);
}

/** 数据看板：几个大数字 + 说明，余下要点作为小字列在下方 */
export function addMetricsSlide(
  ctx: SlideContext,
  spec: PptSlideSpec,
  metrics: PptMetric[],
  bullets: string[],
): void {
  const { theme, language } = ctx;
  const font = fontOf(language);
  const { slide, top, bottom } = newContentSlide(ctx, spec);

  const items = metrics.slice(0, 4);
  const gap = 0.26;
  const cardW = (CONTENT_W - gap * (items.length - 1)) / items.length;
  const cardH = 1.65;

  items.forEach((metric, i) => {
    const x = MARGIN_X + i * (cardW + gap);
    const color = paletteAt(theme, i);
    slide.addShape('roundRect', {
      x,
      y: top,
      w: cardW,
      h: cardH,
      rectRadius: 0.08,
      fill: { color: theme.surface },
      line: { color: theme.line, width: 1 },
    });
    slide.addText(metric.value, {
      x,
      y: top + 0.24,
      w: cardW,
      h: 0.8,
      fontSize: 32,
      bold: true,
      color,
      fontFace: font,
      align: 'center',
      valign: 'middle',
    });
    slide.addText(metric.label, {
      x: x + 0.14,
      y: top + 1.02,
      w: cardW - 0.28,
      h: 0.5,
      fontSize: 12,
      color: theme.muted,
      fontFace: font,
      align: 'center',
      valign: 'top',
    });
  });

  const restTop = top + cardH + 0.28;
  const rest = bullets.slice(0, 3);
  if (rest.length && restTop < bottom - 0.3) {
    slide.addText(
      rest.map((text) => ({
        text,
        options: { breakLine: true, bullet: { code: '25AA' } },
      })),
      {
        x: MARGIN_X + 0.1,
        y: restTop,
        w: CONTENT_W - 0.2,
        h: bottom - restTop,
        fontSize: 13,
        color: theme.text,
        fontFace: font,
        lineSpacingMultiple: 1.3,
        valign: 'top',
      },
    );
  }

  addNotes(slide, spec, [
    ...items.map((m) => `${m.value} ${m.label}`),
    ...rest,
  ]);
}

/** 分栏对比：每栏一个标题条 + 要点 */
export function addComparisonSlide(
  ctx: SlideContext,
  spec: PptSlideSpec,
  columns: { title: string; bullets: string[] }[],
): void {
  const { theme, language } = ctx;
  const font = fontOf(language);
  const { slide, top, bottom } = newContentSlide(ctx, spec);

  const cols = columns.slice(0, 3);
  const gap = 0.28;
  const panelW = (CONTENT_W - gap * (cols.length - 1)) / cols.length;
  const panelH = bottom - top;

  cols.forEach((column, i) => {
    const x = MARGIN_X + i * (panelW + gap);
    const color = paletteAt(theme, i);

    slide.addShape('roundRect', {
      x,
      y: top,
      w: panelW,
      h: panelH,
      rectRadius: 0.08,
      fill: { color: theme.surface },
      line: { color: theme.line, width: 1 },
    });
    slide.addShape('roundRect', {
      x,
      y: top,
      w: panelW,
      h: 0.52,
      rectRadius: 0.08,
      ...fill(color),
    });
    slide.addText(column.title, {
      x: x + 0.16,
      y: top,
      w: panelW - 0.32,
      h: 0.52,
      fontSize: 14,
      bold: true,
      color: 'FFFFFF',
      fontFace: font,
      valign: 'middle',
    });
    slide.addText(
      column.bullets.slice(0, 6).map((text) => ({
        text,
        options: { breakLine: true, bullet: { code: '25AA' } },
      })),
      {
        x: x + 0.22,
        y: top + 0.68,
        w: panelW - 0.44,
        h: panelH - 0.86,
        fontSize: 13,
        color: theme.text,
        fontFace: font,
        lineSpacingMultiple: 1.25,
        valign: 'top',
      },
    );
  });

  addNotes(
    slide,
    spec,
    cols.map((c) => `${c.title}: ${c.bullets.join('；')}`),
  );
}

/** 时间轴 / 步骤：一条横线串起编号节点，文案上下交错 */
export function addTimelineSlide(
  ctx: SlideContext,
  spec: PptSlideSpec,
  bullets: string[],
): void {
  const { theme, language } = ctx;
  const font = fontOf(language);
  const { slide, top, bottom } = newContentSlide(ctx, spec);

  const items = bullets.slice(0, 5);
  const midY = (top + bottom) / 2;
  const colW = CONTENT_W / items.length;
  const dot = 0.34;

  slide.addShape('rect', {
    x: MARGIN_X + colW / 2,
    y: midY - 0.015,
    w: CONTENT_W - colW,
    h: 0.03,
    ...fill(theme.line),
  });

  items.forEach((text, i) => {
    const cx = MARGIN_X + colW * (i + 0.5);
    const color = paletteAt(theme, i);
    slide.addShape('ellipse', {
      x: cx - dot / 2,
      y: midY - dot / 2,
      w: dot,
      h: dot,
      ...fill(color),
    });
    slide.addText(String(i + 1), {
      x: cx - dot / 2,
      y: midY - dot / 2,
      w: dot,
      h: dot,
      fontSize: 12,
      bold: true,
      color: 'FFFFFF',
      fontFace: font,
      align: 'center',
      valign: 'middle',
    });

    const above = i % 2 === 0;
    slide.addText(text, {
      x: cx - colW / 2 + 0.08,
      y: above ? midY - 1.36 : midY + 0.34,
      w: colW - 0.16,
      h: 1.0,
      fontSize: 13,
      color: theme.text,
      fontFace: font,
      align: 'center',
      valign: above ? 'bottom' : 'top',
      lineSpacingMultiple: 1.2,
    });
  });

  addNotes(slide, spec, items);
}

/** 大字观点页：引号装饰 + 一句话结论 */
export function addQuoteSlide(
  ctx: SlideContext,
  spec: PptSlideSpec,
  bullets: string[],
): void {
  const { theme, language } = ctx;
  const font = fontOf(language);
  const { slide, top, bottom } = newContentSlide(ctx, spec);

  slide.addText('“', {
    x: MARGIN_X + 0.1,
    y: top - 0.2,
    w: 1.2,
    h: 1.2,
    fontSize: 72,
    bold: true,
    color: theme.accent,
    fontFace: font,
    transparency: 70,
  });
  slide.addText(bullets[0] ?? spec.content, {
    x: MARGIN_X + 0.8,
    y: top + 0.1,
    w: CONTENT_W - 1.6,
    h: bottom - top - 0.6,
    fontSize: 24,
    bold: true,
    color: theme.title,
    fontFace: font,
    align: 'center',
    valign: 'middle',
    lineSpacingMultiple: 1.3,
  });
  if (bullets.length > 1) {
    slide.addText(bullets.slice(1, 3).join('\u3000|\u3000'), {
      x: MARGIN_X + 0.8,
      y: bottom - 0.5,
      w: CONTENT_W - 1.6,
      h: 0.4,
      fontSize: 12,
      color: theme.muted,
      fontFace: font,
      align: 'center',
    });
  }

  addNotes(slide, spec, bullets);
}

/** 章节分隔页：深色满版 + 大号章节序号 */
export function addSectionSlide(ctx: SlideContext, spec: PptSlideSpec): void {
  const { theme, language, index, total } = ctx;
  const font = fontOf(language);
  const slide = ctx.pptx.addSlide();
  slide.background = { color: theme.deepBg };

  slide.addText(String(index).padStart(2, '0'), {
    x: MARGIN_X,
    y: 1.5,
    w: 2,
    h: 1.4,
    fontSize: 72,
    bold: true,
    color: theme.onDeep,
    fontFace: font,
    transparency: 62,
  });
  slide.addShape('rect', {
    x: MARGIN_X + 0.04,
    y: 2.92,
    w: 0.8,
    h: 0.07,
    ...fill(theme.accent),
  });
  slide.addText(spec.title, {
    x: MARGIN_X,
    y: 3.06,
    w: CONTENT_W,
    h: 0.8,
    fontSize: 30,
    bold: true,
    color: theme.onDeep,
    fontFace: font,
  });
  if (spec.subtitle || spec.content) {
    slide.addText(spec.subtitle || spec.content.split(/\r?\n/)[0], {
      x: MARGIN_X,
      y: 3.9,
      w: CONTENT_W,
      h: 0.5,
      fontSize: 14,
      color: theme.onDeep,
      fontFace: font,
      transparency: 30,
    });
  }
  slide.addText(`${index} / ${total}`, {
    x: SLIDE_W - MARGIN_X - 1,
    y: FOOTER_Y,
    w: 1,
    h: 0.3,
    fontSize: 9,
    color: theme.onDeep,
    fontFace: font,
    align: 'right',
    transparency: 40,
  });

  addNotes(slide, spec, []);
}

/* ==================== 首页 / 目录 / 结尾 ==================== */

/** 封面：深色满版 + 主标题 + 副标题 + 装饰圆 */
export function addCoverSlide(
  pptx: PptxGenJS,
  theme: ThemeStyle,
  language: PptLanguage,
  title: string,
  subtitle: string | undefined,
  sectionCount: number,
): void {
  const font = fontOf(language);
  const slide = pptx.addSlide();
  slide.background = { color: theme.deepBg };

  slide.addShape('rect', {
    x: MARGIN_X + 0.04,
    y: 1.86,
    w: 0.9,
    h: 0.08,
    ...fill(theme.accent),
  });
  slide.addText(title, {
    x: MARGIN_X,
    y: 2.06,
    w: CONTENT_W - 1.2,
    h: 1.2,
    fontSize: 38,
    bold: true,
    color: theme.onDeep,
    fontFace: font,
    valign: 'middle',
  });
  if (subtitle) {
    slide.addText(subtitle, {
      x: MARGIN_X,
      y: 3.28,
      w: CONTENT_W - 1.2,
      h: 0.5,
      fontSize: 16,
      color: theme.onDeep,
      fontFace: font,
      transparency: 25,
    });
  }
  slide.addText(
    language === 'en-US'
      ? `${sectionCount} sections`
      : `共 ${sectionCount} 个部分`,
    {
      x: MARGIN_X,
      y: 4.6,
      w: 4,
      h: 0.4,
      fontSize: 12,
      color: theme.onDeep,
      fontFace: font,
      transparency: 45,
    },
  );
}

/** 目录页：两列编号标题 */
export function addAgendaSlide(
  pptx: PptxGenJS,
  theme: ThemeStyle,
  language: PptLanguage,
  titles: string[],
): void {
  const font = fontOf(language);
  const slide = pptx.addSlide();
  slide.background = { color: theme.bg };
  decorate(slide, theme);

  slide.addText(t(language, 'agenda'), {
    x: MARGIN_X,
    y: 0.34,
    w: CONTENT_W,
    h: 0.6,
    fontSize: 24,
    bold: true,
    color: theme.title,
    fontFace: font,
    valign: 'middle',
  });
  slide.addShape('rect', {
    x: MARGIN_X + 0.02,
    y: 1.0,
    w: 0.7,
    h: 0.06,
    ...fill(theme.accent),
  });

  const items = titles.slice(0, 12);
  const perCol = Math.ceil(items.length / 2);
  const rowH = Math.min(0.62, (BODY_BOTTOM - 1.3) / perCol);

  items.forEach((title, i) => {
    const col = Math.floor(i / perCol);
    const row = i % perCol;
    const x = MARGIN_X + col * (CONTENT_W / 2);
    const y = 1.3 + row * rowH;
    slide.addText(String(i + 1).padStart(2, '0'), {
      x,
      y,
      w: 0.5,
      h: rowH,
      fontSize: 16,
      bold: true,
      color: paletteAt(theme, i),
      fontFace: font,
      valign: 'middle',
    });
    slide.addText(title, {
      x: x + 0.5,
      y,
      w: CONTENT_W / 2 - 0.7,
      h: rowH,
      fontSize: 14,
      color: theme.text,
      fontFace: font,
      valign: 'middle',
    });
    slide.addShape('rect', {
      x: x + 0.5,
      y: y + rowH - 0.02,
      w: CONTENT_W / 2 - 0.7,
      h: 0.01,
      ...fill(theme.line),
    });
  });
}

/** 结尾页 */
export function addEndingSlide(
  pptx: PptxGenJS,
  theme: ThemeStyle,
  language: PptLanguage,
  docTitle: string,
): void {
  const font = fontOf(language);
  const slide = pptx.addSlide();
  slide.background = { color: theme.deepBg };

  slide.addText(t(language, 'thanks'), {
    x: 0,
    y: 2.1,
    w: SLIDE_W,
    h: 0.9,
    fontSize: 40,
    bold: true,
    color: theme.onDeep,
    fontFace: font,
    align: 'center',
  });
  slide.addText(t(language, 'thanksSub'), {
    x: 0,
    y: 3.0,
    w: SLIDE_W,
    h: 0.5,
    fontSize: 14,
    color: theme.onDeep,
    fontFace: font,
    align: 'center',
    transparency: 35,
  });
  slide.addText(docTitle, {
    x: 0,
    y: 4.7,
    w: SLIDE_W,
    h: 0.4,
    fontSize: 10,
    color: theme.onDeep,
    fontFace: font,
    align: 'center',
    transparency: 55,
  });
}
