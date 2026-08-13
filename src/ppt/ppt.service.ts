import { Injectable, Logger } from '@nestjs/common';
import PptxGenJS from 'pptxgenjs';
import { UploadService } from '../upload/upload.service.js';
import {
  addAgendaSlide,
  addBulletsSlide,
  addCardsSlide,
  addComparisonSlide,
  addCoverSlide,
  addEndingSlide,
  addMetricsSlide,
  addQuoteSlide,
  addSectionSlide,
  addTimelineSlide,
  type SlideContext,
} from './ppt.layouts.js';
import { THEMES } from './ppt.theme.js';
import type {
  PptColumn,
  PptMetric,
  PptResult,
  PptSlideLayout,
  PptSlideSpec,
  PptSpec,
} from './ppt.types.js';

export type {
  PptColumn,
  PptMetric,
  PptResult,
  PptSlideLayout,
  PptSlideSpec,
  PptSpec,
} from './ppt.types.js';

/** 单份 PPT 的内容页上限：超出会被截断，避免模型一次要求几百页 */
const MAX_SLIDES = 30;

/** 单页要点条数上限 */
const MAX_BULLETS_PER_SLIDE = 6;

/** 单条要点的字数上限 */
const MAX_BULLET_LENGTH = 120;

/** 内容页达到这个数量才插入目录页（三五页的 PPT 加目录反而啰嗦） */
const AGENDA_MIN_SLIDES = 4;

/** 生成的 PPT 在用户文件管理中的落地目录 */
const PPT_DIR = 'PPT';

/** 命中这些词的页面适合画成时间轴 */
const TIMELINE_HINT = /步骤|流程|阶段|路线|节奏|计划|roadmap|timeline|phase/i;

/**
 * PPT 生成：把模型规划好的结构（PptSpec）渲染成 .pptx，并上传到用户 BOS 目录。
 *
 * 分工：模型负责「想内容」——每页讲什么、要点、关键数字、分栏、结论；
 * 排版（版式选择、配色、字号、装饰元素、目录页与结尾页）全部由服务端决定，
 * 所以 create_ppt 的入参里没有任何坐标、字号之类的实现细节。
 *
 * 版式由 `layout` 指定，缺省时按内容形态推断（见 pickLayout），
 * 目的是同一份 PPT 里自然出现列表页、卡片页、数据页、对比页、时间轴、观点页，
 * 而不是几十页长得一模一样。
 */
@Injectable()
export class PptService {
  private readonly logger = new Logger(PptService.name);

  constructor(private readonly uploadService: UploadService) {}

  /** 校验模型给出的结构，返回错误文案（无错误返回 undefined） */
  validate(spec: Partial<PptSpec> | undefined): string | undefined {
    if (!spec) return 'PPT 参数为空';
    if (!spec.title || !String(spec.title).trim()) return 'title 不能为空';
    if (!spec.theme || !THEMES[spec.theme]) {
      return `theme 必须是 ${Object.keys(THEMES).join(' / ')} 之一`;
    }
    if (!Array.isArray(spec.slides) || spec.slides.length === 0) {
      return 'slides 不能为空，需要给出每一页的 title 和 content';
    }
    const bad = spec.slides.findIndex(
      (s) =>
        !s ||
        !s.title?.trim() ||
        !(s.content?.trim() || s.bullets?.some((b) => b?.trim())),
    );
    if (bad >= 0) {
      return `第 ${bad + 1} 页缺少 title 或正文（content / bullets 至少给一个）`;
    }
    return undefined;
  }

  /**
   * 生成 pptx 并上传，返回下载地址。
   * @param userId 用户数字 id（决定文件落在哪个用户目录）
   */
  async create(spec: PptSpec, userId: number): Promise<PptResult> {
    const theme = THEMES[spec.theme];
    const language = spec.language === 'en-US' ? 'en-US' : 'zh-CN';
    const slides = spec.slides.slice(0, MAX_SLIDES);

    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_16x9';
    pptx.title = spec.title;
    pptx.author = 'AI Gateway';

    addCoverSlide(
      pptx,
      theme,
      language,
      spec.title,
      spec.subtitle,
      slides.length,
    );

    let pageCount = 1;
    if (slides.length >= AGENDA_MIN_SLIDES) {
      addAgendaSlide(
        pptx,
        theme,
        language,
        slides.map((s) => s.title),
      );
      pageCount++;
    }

    slides.forEach((slide, i) => {
      const ctx: SlideContext = {
        pptx,
        theme,
        language,
        docTitle: spec.title,
        index: i + 1,
        total: slides.length,
      };
      this.renderSlide(ctx, slide, i);
      pageCount++;
    });

    addEndingSlide(pptx, theme, language, spec.title);
    pageCount++;

    const buffer = Buffer.from(
      (await pptx.write({ outputType: 'nodebuffer' })) as ArrayBuffer,
    );

    const entry = await this.uploadService.uploadBuffer(
      userId,
      buffer,
      `${this.safeStem(spec.title)}.pptx`,
      PPT_DIR,
    );

    this.logger.log(
      `已生成 PPT《${spec.title}》共 ${pageCount} 页 -> ${entry.path}`,
    );

    return {
      fileName: entry.name,
      path: entry.path,
      downloadUrl: entry.url!,
      size: entry.size,
      slideCount: pageCount,
    };
  }

  /** 按版式把一页交给对应的渲染函数 */
  private renderSlide(
    ctx: SlideContext,
    spec: PptSlideSpec,
    order: number,
  ): void {
    const bullets = this.toBullets(spec);
    const metrics = this.cleanMetrics(spec.metrics);
    const columns = this.cleanColumns(spec.columns);
    const layout = this.pickLayout(spec, bullets, metrics, columns, order);

    switch (layout) {
      case 'section':
        addSectionSlide(ctx, spec);
        break;
      case 'metrics':
        addMetricsSlide(ctx, spec, metrics, bullets);
        break;
      case 'comparison':
        addComparisonSlide(ctx, spec, columns);
        break;
      case 'timeline':
        addTimelineSlide(ctx, spec, bullets);
        break;
      case 'quote':
        addQuoteSlide(ctx, spec, bullets);
        break;
      case 'cards':
        addCardsSlide(ctx, spec, bullets);
        break;
      default:
        addBulletsSlide(ctx, spec, bullets);
    }
  }

  /**
   * 选版式：模型显式指定就照做（但数据不够时降级），否则按内容形态推断。
   * 最后一条规则是「隔几页换成卡片」，纯为了打破连续列表页的单调感。
   */
  private pickLayout(
    spec: PptSlideSpec,
    bullets: string[],
    metrics: PptMetric[],
    columns: PptColumn[],
    order: number,
  ): PptSlideLayout {
    const wanted =
      spec.layout && spec.layout !== 'auto' ? spec.layout : undefined;
    if (wanted === 'metrics' && metrics.length) return 'metrics';
    if (wanted === 'comparison' && columns.length >= 2) return 'comparison';
    if (wanted && wanted !== 'metrics' && wanted !== 'comparison')
      return wanted;

    if (metrics.length >= 2) return 'metrics';
    if (columns.length >= 2) return 'comparison';
    if (bullets.length === 1) return 'quote';
    if (
      TIMELINE_HINT.test(spec.title) &&
      bullets.length >= 3 &&
      bullets.length <= 5
    ) {
      return 'timeline';
    }

    const allShort = bullets.every((b) => b.length <= 28);
    if (bullets.length >= 3 && allShort) return 'cards';
    // 每三页强插一页卡片，避免通篇都是编号列表
    if (bullets.length >= 2 && bullets.length <= 4 && order % 3 === 2) {
      return 'cards';
    }
    return 'bullets';
  }

  /**
   * 取本页要点：优先用模型给的 bullets，没有则从 content 拆。
   * content 可能是多行（每行一条）或一整段话，后者按句末标点切分，
   * 避免一页塞一大坨文字。
   */
  private toBullets(spec: PptSlideSpec): string[] {
    const fromModel = (spec.bullets ?? [])
      .filter((b) => typeof b === 'string' && b.trim())
      .map((b) => this.stripMarker(b));
    if (fromModel.length) return this.capBullets(fromModel);

    const lines = (spec.content || '')
      .split(/\r?\n/)
      .map((line) => this.stripMarker(line))
      .filter(Boolean);

    const parts =
      lines.length > 1
        ? lines
        : (lines[0] ?? '')
            .split(/(?<=[。！？;；.!?])/)
            .map((s) => s.trim())
            .filter(Boolean);

    return this.capBullets(parts);
  }

  /** 去掉行首的 `- ` `1. ` `• ` 等列表符号 */
  private stripMarker(line: string): string {
    return line.replace(/^\s*(?:[-*•·]|\d+[.、)])\s*/, '').trim();
  }

  private capBullets(items: string[]): string[] {
    return items
      .slice(0, MAX_BULLETS_PER_SLIDE)
      .map((s) => s.slice(0, MAX_BULLET_LENGTH));
  }

  /** 过滤掉缺 value / label 的脏数据 */
  private cleanMetrics(metrics?: PptMetric[]): PptMetric[] {
    return (metrics ?? [])
      .filter((m) => m?.value?.toString().trim() && m?.label?.trim())
      .slice(0, 4)
      .map((m) => ({
        value: String(m.value).trim().slice(0, 12),
        label: m.label.trim().slice(0, 40),
      }));
  }

  /** 过滤掉缺标题或要点的分栏 */
  private cleanColumns(columns?: PptColumn[]): PptColumn[] {
    return (columns ?? [])
      .filter((c) => c?.title?.trim() && c.bullets?.some((b) => b?.trim()))
      .slice(0, 3)
      .map((c) => ({
        title: c.title.trim().slice(0, 24),
        bullets: c.bullets
          .filter((b) => b?.trim())
          .map((b) => this.stripMarker(b).slice(0, MAX_BULLET_LENGTH))
          .slice(0, 6),
      }));
  }

  /** 用 PPT 标题做文件名主干：去掉路径非法字符并限长 */
  private safeStem(title: string): string {
    const stem = title
      .replace(/[\\/<>|*?:"]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    return stem || 'AI生成PPT';
  }
}
