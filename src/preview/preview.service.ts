import { Injectable, Logger } from '@nestjs/common';
import JSZip from 'jszip';
import { assertPublicHttpUrl } from '../common/url-guard.js';
import { resolveContentType } from '../common/content-type.js';
import { decodeText, trimTruncatedTail } from '../models/attachment-text.js';

/** 纯文本预览 */
export interface TextPreview {
  kind: 'text';
  name: string;
  content: string;
  truncated: boolean;
}

/** PPT 预览：逐页的标题与文本 */
export interface SlidesPreview {
  kind: 'slides';
  name: string;
  slides: { index: number; title: string; lines: string[] }[];
}

/** 不支持在线预览的类型（前端只显示下载） */
export interface UnsupportedPreview {
  kind: 'unsupported';
  name: string;
  message: string;
}

export type FilePreviewData = TextPreview | SlidesPreview | UnsupportedPreview;

/** 可按纯文本预览的扩展名 */
const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'log',
  'csv',
  'json',
  'xml',
  'yml',
  'yaml',
  'html',
  'css',
  'js',
  'ts',
  'sql',
]);

/** 可解析出页面文字的演示文稿扩展名（老的二进制 .ppt 不是 zip，解析不了） */
const SLIDE_EXTS = new Set(['pptx']);

const FETCH_TIMEOUT_MS = 30_000;

/** 预览允许下载的最大文件体积 */
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

/** 文本预览最多返回的字节 / 字符数 */
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_TEXT_CHARS = 200_000;

/** 单页最多提取的文本行数，避免超长页面把响应撑大 */
const MAX_LINES_PER_SLIDE = 40;

/**
 * 会话内文件预览：由网关代取 BOS 对象并转成可预览的数据。
 *
 * 为什么不让前端直接 fetch BOS：BOS 对象虽然是 public-read，但没有配跨域响应头，
 * 浏览器 fetch 会被 CORS 拦掉（只有 <img> 这类标签能直接用）。走网关转发既绕开跨域，
 * 也顺带做了 SSRF 防护与体积限制。
 *
 * pptx 是 zip 包，这里解析出每页的文字（标题 + 正文行）做「大纲级」预览，
 * 不做像素级还原——那需要 LibreOffice 之类的转换服务。
 */
@Injectable()
export class PreviewService {
  private readonly logger = new Logger(PreviewService.name);

  /** 只允许代取 BOS 上的对象，避免网关变成任意 URL 的代理 */
  private async assertAllowed(rawUrl: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('文件地址不是合法的 URL');
    }
    if (!/(^|\.)bcebos\.com$/i.test(url.hostname)) {
      throw new Error('只支持预览本系统存储（BOS）中的文件');
    }
    await assertPublicHttpUrl(rawUrl, '文件地址');
    return url;
  }

  /** 从 URL 推断文件名（BOS key 是 percent-encoding 过的） */
  private nameOf(url: URL): string {
    const last = url.pathname.split('/').pop() || '';
    try {
      return decodeURIComponent(last) || 'file';
    } catch {
      return last || 'file';
    }
  }

  private extOf(name: string): string {
    return name.split('.').pop()?.toLowerCase() || '';
  }

  /** 代取整个对象（带体积上限） */
  private async fetchObject(
    rawUrl: string,
  ): Promise<{ buffer: Buffer; name: string; contentType: string }> {
    const url = await this.assertAllowed(rawUrl);
    const res = await fetch(url.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      if (res.status === 403 || res.status === 404) {
        throw new Error('文件不存在或无法访问');
      }
      throw new Error(`读取文件失败：HTTP ${res.status}`);
    }

    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_PREVIEW_BYTES) {
      throw new Error('文件超过 20MB，请下载后查看');
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_PREVIEW_BYTES) {
      throw new Error('文件超过 20MB，请下载后查看');
    }

    const name = this.nameOf(url);
    return {
      buffer,
      name,
      contentType: resolveContentType(
        name,
        res.headers.get('content-type') || '',
      ),
    };
  }

  /** 供下载代理使用：返回整个对象内容 */
  async load(
    rawUrl: string,
  ): Promise<{ buffer: Buffer; name: string; contentType: string }> {
    return this.fetchObject(rawUrl);
  }

  /** 生成预览数据 */
  async preview(rawUrl: string): Promise<FilePreviewData> {
    const url = await this.assertAllowed(rawUrl);
    const name = this.nameOf(url);
    const ext = this.extOf(name);

    if (!TEXT_EXTS.has(ext) && !SLIDE_EXTS.has(ext)) {
      return {
        kind: 'unsupported',
        name,
        message: '该格式暂不支持在线预览，可下载后查看',
      };
    }

    const { buffer } = await this.fetchObject(rawUrl);

    if (TEXT_EXTS.has(ext)) {
      const truncatedByBytes = buffer.length > MAX_TEXT_BYTES;
      const sliced = truncatedByBytes
        ? trimTruncatedTail(buffer.subarray(0, MAX_TEXT_BYTES))
        : buffer;
      let content = decodeText(sliced);
      const truncatedByChars = content.length > MAX_TEXT_CHARS;
      if (truncatedByChars) content = content.slice(0, MAX_TEXT_CHARS);
      const truncated = truncatedByBytes || truncatedByChars;
      if (truncated) content = content.replace(/\uFFFD+$/, '');
      return { kind: 'text', name, content, truncated };
    }

    return { kind: 'slides', name, slides: await this.parseSlides(buffer) };
  }

  /**
   * 解析 pptx：按 ppt/slides/slideN.xml 顺序取出每页的 <a:t> 文本，
   * 第一段作为该页标题，其余作为正文行。
   */
  private async parseSlides(buffer: Buffer): Promise<SlidesPreview['slides']> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch {
      throw new Error('文件不是有效的 pptx，无法预览');
    }

    const files = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => this.slideNo(a) - this.slideNo(b));

    const slides: SlidesPreview['slides'] = [];
    for (const [i, path] of files.entries()) {
      const xml = await zip.files[path].async('string');
      // 同一段落里的多个 <a:r> 会被切成多个 <a:t>，按段落（<a:p>）合并才不会一句话拆成几行
      const paragraphs = xml.split('</a:p>');
      const lines: string[] = [];
      for (const p of paragraphs) {
        const text = [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
          .map((m) => this.unescapeXml(m[1]))
          .join('')
          .trim();
        if (text) lines.push(text);
        if (lines.length >= MAX_LINES_PER_SLIDE) break;
      }
      slides.push({
        index: i + 1,
        title: lines[0] ?? '',
        lines: lines.slice(1),
      });
    }

    if (!slides.length) throw new Error('未从该文件中解析出任何页面');
    return slides;
  }

  private slideNo(path: string): number {
    return Number(path.match(/(\d+)\.xml$/)?.[1] ?? 0);
  }

  private unescapeXml(text: string): string {
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }
}
