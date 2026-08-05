/**
 * 客户端传入的 URL 统一走这里做 SSRF 防护：只允许 http/https，且解析出的 IP
 * 不能落在内网 / 回环 / 链路本地网段。
 *
 * 图片转存（UploadService）与附件文本读取（AttachmentText）共用同一份实现，
 * 避免两处各写一遍安全校验导致其中一处漏改。
 */
import { lookup } from 'dns/promises';
import { isIP } from 'net';

/** 判断 IP 是否属于内网 / 回环 / 链路本地 / 未指定地址 */
export function isPrivateAddress(address: string): boolean {
  const addr = address.toLowerCase();
  if (isIP(addr) === 6) {
    // 去掉 IPv4-mapped 前缀后按 IPv4 规则再判一次
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      addr === '::' ||
      addr === '::1' ||
      addr.startsWith('fe80:') ||
      addr.startsWith('fc') ||
      addr.startsWith('fd')
    );
  }
  const p = addr.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/**
 * 校验 URL 可以安全地由服务端发起请求。
 * @param subject 错误信息里的主体描述，如「图片地址」「附件地址」
 */
export async function assertPublicHttpUrl(
  rawUrl: string,
  subject = '地址',
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${subject}不是合法的 URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${subject}仅支持 http / https`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0) {
    throw new Error(`${subject}无法解析`);
  }
  if (addresses.some((addr) => isPrivateAddress(addr))) {
    throw new Error(`不允许访问内网${subject}`);
  }
}
