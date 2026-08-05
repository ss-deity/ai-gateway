/**
 * 上传对象的 Content-Type 归一化。
 *
 * BOS 会把 putObject 时声明的 Content-Type 原样回给浏览器：
 * 文本类若不带 charset，浏览器会按本地默认编码猜（中文环境常猜成 GBK），
 * UTF-8 的 txt 直接在网页里就是乱码。因此文本类一律补 `; charset=utf-8`。
 *
 * 客户端给的 mimetype 经常缺失或错标（Windows 上 .txt 可能是空、
 * .xlsx 可能被标成 application/octet-stream），所以优先按扩展名判定。
 */

/** 扩展名 -> Content-Type（文本类已带 charset） */
const EXT_CONTENT_TYPE: Record<string, string> = {
  // 文本
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  // 文档
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // 图片
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  // 音视频
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  // 压缩包
  zip: 'application/zip',
};

/** 需要补 charset 的 MIME（扩展名兜底失败、只能信 mimetype 时用） */
const NEEDS_CHARSET = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
]);

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** 取小写扩展名（无扩展名返回空串） */
function extOf(fileName: string): string {
  const name = fileName || '';
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
}

/**
 * 给 mimetype 补 charset：text/* 与少量 application/* 需要，其余原样返回。
 * 已带 charset 的不重复追加。
 */
function withCharset(mime: string): string {
  if (mime.includes('charset=')) return mime;
  const base = mime.split(';')[0].trim();
  if (base.startsWith('text/') || NEEDS_CHARSET.has(base)) {
    return `${base}; charset=utf-8`;
  }
  return base;
}

/**
 * 推导落库到 BOS 的 Content-Type。
 * @param fileName 原始文件名（用于取扩展名）
 * @param mimetype 客户端/上游声明的 MIME，可缺失
 */
export function resolveContentType(fileName: string, mimetype?: string): string {
  const byExt = EXT_CONTENT_TYPE[extOf(fileName)];
  if (byExt) return byExt;

  const mime = (mimetype || '').trim().toLowerCase();
  if (mime && mime !== DEFAULT_CONTENT_TYPE) return withCharset(mime);

  return DEFAULT_CONTENT_TYPE;
}
