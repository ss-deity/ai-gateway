import { Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';

/**
 * 火山引擎「即梦AI-图片生成」接入（视觉智能 CV 服务，AK/SK V4 签名）。
 *
 * 文档：https://docs.volcengine.com/docs/85621/2275082 （即梦AI-图片生成4.6-接口文档）
 * - Host:     visual.volcengineapi.com
 * - Service:  cv        Region: cn-north-1     Version: 2022-08-31
 * - 提交任务:  Action=CVSync2AsyncSubmitTask
 * - 查询结果:  Action=CVSync2AsyncGetResult
 *
 * 说明：即梦为异步接口——先提交任务拿 task_id，再轮询查询直到 status=done。
 * req_key 区分模型版本（4.0 为 jimeng_t2i_v40）；4.6 的取值以官方接口文档为准，
 * 已通过环境变量 JIMENG_REQ_KEY 配置，默认 jimeng_t2i_v46，可随时覆盖而无需改代码。
 */

const AK = process.env.JIMENG_ACCESS_KEY || '';
const SK = process.env.JIMENG_SECRET_KEY || '';
const HOST = process.env.JIMENG_HOST || 'visual.volcengineapi.com';
const REGION = process.env.JIMENG_REGION || 'cn-north-1';
const SERVICE = 'cv';
const VERSION = process.env.JIMENG_VERSION || '2022-08-31';
// req_key 支持配置多个候选（逗号分隔），提交时依次尝试，遇到 "not supported" 自动切换下一个，
// 以适配不同账号已开通的模型（如 jimeng_t2i_v40 / high_aes_general_v30 等）。
const REQ_KEY_CANDIDATES = (process.env.JIMENG_REQ_KEY || 'jimeng_t2i_v40')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

interface VisualResponse<T = Record<string, unknown>> {
  code?: number;
  message?: string;
  request_id?: string;
  status?: number;
  data?: T;
}

@Injectable()
export class ImageService {
  private readonly logger = new Logger(ImageService.name);

  private hmac(key: Buffer | string, data: string): Buffer {
    return createHmac('sha256', key).update(data, 'utf8').digest();
  }

  private sha256hex(data: string): string {
    return createHash('sha256').update(data, 'utf8').digest('hex');
  }

  /** RFC3986 编码（用于规范化 Query） */
  private enc(s: string): string {
    return encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
    );
  }

  /** 生成 X-Date：UTC 的 YYYYMMDDT HHMMSSZ */
  private xDate(now: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return (
      `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
      `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`
    );
  }

  /**
   * 以 Volcengine V4 签名发起一次 POST 请求。
   */
  private async signedRequest<T>(
    action: string,
    body: Record<string, unknown>,
  ): Promise<VisualResponse<T>> {
    if (!AK || !SK) {
      throw new Error('未配置 JIMENG_ACCESS_KEY / JIMENG_SECRET_KEY');
    }

    const bodyStr = JSON.stringify(body);
    const now = new Date();
    const xDate = this.xDate(now);
    const shortDate = xDate.slice(0, 8);
    const contentSha = this.sha256hex(bodyStr);

    // Query 需按 key 字典序排列：Action < Version
    const query = `Action=${this.enc(action)}&Version=${this.enc(VERSION)}`;

    const canonicalHeaders =
      `content-type:application/json\n` +
      `host:${HOST}\n` +
      `x-content-sha256:${contentSha}\n` +
      `x-date:${xDate}\n`;
    const signedHeaders = 'content-type;host;x-content-sha256;x-date';

    const canonicalRequest = [
      'POST',
      '/',
      query,
      canonicalHeaders,
      signedHeaders,
      contentSha,
    ].join('\n');

    const credentialScope = `${shortDate}/${REGION}/${SERVICE}/request`;
    const stringToSign = [
      'HMAC-SHA256',
      xDate,
      credentialScope,
      this.sha256hex(canonicalRequest),
    ].join('\n');

    // 派生签名密钥（注意：火山引擎直接以 SecretKey 作为初始 key，不加 "AWS4" 前缀）
    const kDate = this.hmac(SK, shortDate);
    const kRegion = this.hmac(kDate, REGION);
    const kService = this.hmac(kRegion, SERVICE);
    const kSigning = this.hmac(kService, 'request');
    const signature = createHmac('sha256', kSigning)
      .update(stringToSign, 'utf8')
      .digest('hex');

    const authorization =
      `HMAC-SHA256 Credential=${AK}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(`https://${HOST}/?${query}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: HOST,
        'X-Date': xDate,
        'X-Content-Sha256': contentSha,
        Authorization: authorization,
      },
      body: bodyStr,
    });

    // 先取原始文本再解析，保证即使非 JSON / 空响应也能打印出原始返回值
    const rawText = await res.text();
    this.logger.log(
      `即梦原始返回 [${action}] http=${res.status} body=${rawText}`,
    );

    let json: VisualResponse<T>;
    try {
      json = rawText ? (JSON.parse(rawText) as VisualResponse<T>) : {};
    } catch {
      throw new Error(
        `即梦返回非 JSON [${action}] http=${res.status}: ${rawText.slice(0, 500)}`,
      );
    }

    if (!res.ok || (json.code !== undefined && json.code !== 10000)) {
      throw new Error(
        `即梦接口错误 [${action}] code=${json.code} status=${res.status} msg=${json.message}`,
      );
    }
    return json;
  }

  /**
   * 提交文生图任务：依次尝试候选 req_key，返回 task_id 与实际生效的 req_key。
   * @param prompt 文本描述
   * @param params 透传给接口的其它参数（width/height/scale/seed/use_pre_llm 等）
   */
  private async submitTask(
    prompt: string,
    params: Record<string, unknown>,
  ): Promise<{ taskId: string; reqKey: string }> {
    let lastErr: Error | null = null;
    for (const reqKey of REQ_KEY_CANDIDATES) {
      try {
        const json = await this.signedRequest<{ task_id: string }>(
          'CVSync2AsyncSubmitTask',
          { req_key: reqKey, prompt, ...params },
        );
        const taskId = json.data?.task_id;
        if (!taskId) throw new Error('提交任务未返回 task_id');
        this.logger.log(`即梦提交成功 req_key=${reqKey} task_id=${taskId}`);
        return { taskId, reqKey };
      } catch (e) {
        const msg = (e as Error).message || '';
        lastErr = e as Error;
        // req_key 不被支持则尝试下一个候选；其它错误直接抛出
        if (/not supported|req_key/i.test(msg)) {
          this.logger.warn(`req_key=${reqKey} 不可用，尝试下一个候选：${msg}`);
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error('没有可用的 req_key');
  }

  /**
   * 查询任务结果。返回 status、图片 URL 列表（return_url=true）以及 base64 兜底。
   */
  private async getResult(
    taskId: string,
    reqKey: string,
  ): Promise<{
    status?: string;
    imageUrls: string[];
    binaryBase64: string[];
    raw: unknown;
  }> {
    const json = await this.signedRequest<{
      status?: string;
      image_urls?: string[];
      binary_data_base64?: string[];
    }>('CVSync2AsyncGetResult', {
      req_key: reqKey,
      task_id: taskId,
      req_json: JSON.stringify({ return_url: true }),
    });
    return {
      status: json.data?.status,
      imageUrls: json.data?.image_urls ?? [],
      binaryBase64: json.data?.binary_data_base64 ?? [],
      raw: json.data,
    };
  }

  /**
   * 文生图完整流程：提交任务并轮询直到完成，返回图片地址（URL 或 base64 data URI）列表。
   */
  async generate(
    prompt: string,
    params: Record<string, unknown> = {},
  ): Promise<string[]> {
    this.logger.log(
      `即梦 generate 开始 req_key候选=[${REQ_KEY_CANDIDATES.join(', ')}] hasAK=${!!AK} hasSK=${!!SK} host=${HOST} 参考图=${Array.isArray(params.image_urls) ? params.image_urls.length : 0} prompt=${prompt.slice(0, 60)}`,
    );
    const { taskId, reqKey } = await this.submitTask(prompt, params);

    const timeoutMs = 120_000;
    const intervalMs = 3_000; // 即梦 QPS=1，轮询间隔 >=1s
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      await this.delay(intervalMs);
      const { status, imageUrls, binaryBase64, raw } = await this.getResult(
        taskId,
        reqKey,
      );
      this.logger.log(
        `即梦轮询 task_id=${taskId} status=${status} urls=${imageUrls.length} b64=${binaryBase64.length}`,
      );

      // 优先返回 URL；无 URL 时用 base64 兜底转成 data URI
      if (imageUrls.length > 0) return imageUrls;
      if (binaryBase64.length > 0) {
        return binaryBase64.map((b) => `data:image/png;base64,${b}`);
      }

      // 任务完成但没有任何图片，说明返回结构与预期不符，抛错并打印原始数据便于排查
      if (status === 'done' || status === 'success') {
        this.logger.warn(
          `即梦任务完成但未取到图片，原始返回：${JSON.stringify(raw)}`,
        );
        throw new Error(
          `即梦生成完成但未返回图片（status=${status}），请核对 req_key 与返回字段`,
        );
      }
      if (status === 'not_found' || status === 'expired') {
        throw new Error(`即梦任务失败 status=${status}`);
      }
      // in_queue / generating：继续轮询
    }
    throw new Error('即梦生成超时，请稍后重试');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
