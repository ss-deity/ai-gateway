/**
 * 把用户上传的文本类附件（txt / md 等）真正读成文字，拼进 prompt。
 *
 * 背景：DeepSeek 的 chat 接口不会去访问 URL，之前只把附件链接贴在消息末尾，
 * 模型其实读不到内容。这里由网关侧下载并内联正文，模型才能理解 txt。
 */
import { Logger } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { assertPublicHttpUrl } from '../common/url-guard.js';
import type { Attachment } from './model.types.js';

const logger = new Logger('AttachmentText');

/** 下载超时 */
const FETCH_TIMEOUT_MS = 20_000;

/** 单个附件最多读取的字节数（超出即截断，避免把上下文撑爆） */
const MAX_DOC_BYTES = Number(process.env.ATTACHMENT_MAX_BYTES || 256 * 1024);

/** 单个附件内联进 prompt 的最大字符数 */
const MAX_DOC_CHARS = Number(process.env.ATTACHMENT_MAX_CHARS || 100_000);

/** xlsx 必须整包下载才能解析，这里限制文件本身大小 */
const MAX_EXCEL_BYTES = Number(
  process.env.ATTACHMENT_MAX_EXCEL_BYTES || 20 * 1024 * 1024,
);

/** 可以按纯文本内联的 MIME */
const TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

/** MIME 缺失/错标时按扩展名兜底 */
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'log']);

/** Excel（xlsx / xlsm）MIME —— 老的二进制 .xls 无法解析，不在此列 */
const EXCEL_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroenabled.12',
]);

const EXCEL_EXTS = new Set(['xlsx', 'xlsm']);

/** 单个工作表最多读取的行数 */
const MAX_SHEET_ROWS = Number(process.env.ATTACHMENT_MAX_SHEET_ROWS || 500);

/** 判断附件是否可以按纯文本读取 */
export function isTextAttachment(a: Attachment): boolean {
  const mime = (a.type || '').toLowerCase();
  if (TEXT_MIMES.has(mime)) return true;
  if (mime.startsWith('text/')) return true;
  const ext = extOf(a);
  return TEXT_EXTS.has(ext);
}

/** 判断附件是否为可解析的 Excel 工作簿 */
export function isExcelAttachment(a: Attachment): boolean {
  const mime = (a.type || '').toLowerCase();
  if (EXCEL_MIMES.has(mime)) return true;
  return EXCEL_EXTS.has(extOf(a));
}

function extOf(a: Attachment): string {
  return (a.name || '').split('.').pop()?.toLowerCase() || '';
}

/**
 * 按字节截断时，去掉尾部残缺的多字节 UTF-8 序列，
 * 否则最后一个汉字会被解码成替换字符混进正文。
 */
function trimTruncatedTail(buf: Buffer): Buffer {
  for (let i = buf.length - 1; i >= 0 && i > buf.length - 5; i--) {
    const b = buf[i];
    if ((b & 0xc0) === 0x80) continue; // 续接字节，继续往前找首字节
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > buf.length - i ? buf.subarray(0, i) : buf;
  }
  return buf;
}

/**
 * 解码正文：按 BOM 识别 UTF-16，其余优先 UTF-8，
 * 出现非法 UTF-8 序列时按 GB18030（兼容 GBK）兜底。
 * Windows 记事本另存的中文 txt 多为 GBK，硬按 UTF-8 读会整篇乱码，模型自然读不懂。
 */
function decodeText(buf: Buffer): string {
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(buf.subarray(2));
    }
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(buf.subarray(2));
    }
  }
  // UTF-8 BOM 去掉，否则会作为正文第一个字符进 prompt
  const body =
    buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
      ? buf.subarray(3)
      : buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextDecoder('gb18030').decode(body);
  }
}

/**
 * 下载附件二进制内容。URL 由客户端传入，统一走 SSRF 防护。
 */
async function fetchBuffer(a: Attachment): Promise<Buffer> {
  await assertPublicHttpUrl(a.url, '附件地址');
  const res = await fetch(a.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 下载并解码单个文本附件。
 * 失败不抛出，返回 null，由调用方决定降级方式（不能让读附件失败拖垮整轮对话）。
 */
async function readOne(a: Attachment): Promise<string | null> {
  try {
    const buf = await fetchBuffer(a);
    // 只取前 MAX_DOC_BYTES 字节，避免把上下文撑爆
    const truncatedByBytes = buf.length > MAX_DOC_BYTES;
    const sliced = truncatedByBytes
      ? trimTruncatedTail(buf.subarray(0, MAX_DOC_BYTES))
      : buf;

    let text = decodeText(sliced);
    const truncatedByChars = text.length > MAX_DOC_CHARS;
    if (truncatedByChars) text = text.slice(0, MAX_DOC_CHARS);
    if (truncatedByBytes || truncatedByChars) {
      // GBK 等变长编码被截断时尾部可能残留替换字符
      text = text.replace(/\uFFFD+$/, '') + '\n...（内容过长，已截断）';
    }
    if (!text.trim()) throw new Error('附件内容为空');
    return text;
  } catch (e) {
    logger.warn(`读取附件失败 name=${a.name} err=${(e as Error).message}`);
    return null;
  }
}

/** 单元格值转成一行里的文本：公式取计算结果，富文本取纯文本 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as {
      text?: unknown;
      result?: unknown;
      error?: unknown;
      richText?: { text: string }[];
      hyperlink?: string;
    };
    if (Array.isArray(v.richText)) {
      return v.richText.map((r) => r.text).join('');
    }
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return cellText(v.result);
    if (v.error !== undefined) return String(v.error);
    if (v.hyperlink) return String(v.hyperlink);
    return '';
  }
  return String(value);
}

/**
 * 把 xlsx 工作簿转成模型可读的文本：逐个工作表输出 `单元格 | 单元格` 的行。
 * xlsx 是 zip 包，必须完整下载才能解析，因此不能像文本那样按字节截断，
 * 改为限制文件大小与每表行数。
 */
async function readExcel(a: Attachment): Promise<string | null> {
  try {
    const buf = await fetchBuffer(a);
    if (buf.length > MAX_EXCEL_BYTES) {
      throw new Error(`超过 ${Math.round(MAX_EXCEL_BYTES / 1024 / 1024)}MB`);
    }

    const workbook = new Workbook();
    // exceljs 的 d.ts 把参数类型声明成 `Buffer extends ArrayBuffer`，与 @types/node
    // 的 Buffer 不兼容，运行时传 Node Buffer 是正确用法，这里只能强转绕过类型冲突
    await workbook.xlsx.load(buf as unknown as ArrayBuffer);

    const sheets: string[] = [];
    workbook.eachSheet((sheet) => {
      const lines: string[] = [];
      let truncated = false;
      sheet.eachRow({ includeEmpty: false }, (row) => {
        if (lines.length >= MAX_SHEET_ROWS) {
          truncated = true;
          return;
        }
        const cells: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell) => {
          cells.push(cellText(cell.value).replace(/\s*\n\s*/g, ' ').trim());
        });
        while (cells.length && !cells[cells.length - 1]) cells.pop();
        if (cells.length) lines.push(cells.join(' | '));
      });
      if (truncated) lines.push('...（行数过多，已截断）');
      if (lines.length) {
        sheets.push(`工作表「${sheet.name}」：\n${lines.join('\n')}`);
      }
    });

    if (!sheets.length) throw new Error('工作簿没有可读内容');
    let text = sheets.join('\n\n');
    if (text.length > MAX_DOC_CHARS) {
      text = text.slice(0, MAX_DOC_CHARS) + '\n...（内容过长，已截断）';
    }
    return text;
  } catch (e) {
    logger.warn(`解析表格附件失败 name=${a.name} err=${(e as Error).message}`);
    return null;
  }
}

/**
 * 把附件列表拼成追加到 prompt 末尾的文档块。
 * - 文本类附件（txt / md / csv / json）：内联正文
 * - Excel（xlsx）：解析成逐行文本后内联
 * - 其它（如 pdf）：只列名称与链接，并说明网关无法解析其正文
 *
 * 返回空串表示没有需要追加的内容。
 */
export async function buildDocumentBlock(
  attachments: Attachment[],
): Promise<string> {
  if (!attachments.length) return '';

  const textDocs = attachments.filter(isTextAttachment);
  const excelDocs = attachments.filter(
    (a) => !isTextAttachment(a) && isExcelAttachment(a),
  );
  const otherDocs = attachments.filter(
    (a) => !isTextAttachment(a) && !isExcelAttachment(a),
  );

  const sections: string[] = [];

  const readable = [
    ...textDocs.map((a) => ({ a, read: readOne(a) })),
    ...excelDocs.map((a) => ({ a, read: readExcel(a) })),
  ];
  const contents = await Promise.all(readable.map((it) => it.read));
  readable.forEach(({ a }, i) => {
    const body = contents[i];
    if (body === null) {
      sections.push(`文件《${a.name}》读取失败，无法获取其内容。`);
    } else {
      sections.push(`文件《${a.name}》的内容如下：\n\`\`\`\n${body}\n\`\`\``);
    }
  });

  if (otherDocs.length) {
    sections.push(
      '以下附件为非文本格式，无法直接读取其正文，仅提供链接：\n' +
        otherDocs.map((a) => `- ${a.name}: ${a.url}`).join('\n'),
    );
  }

  if (!sections.length) return '';
  return `\n\n以下是随本条消息上传的附件：\n\n${sections.join('\n\n')}`;
}
