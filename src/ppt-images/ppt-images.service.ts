import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { UploadService } from '../upload/upload.service.js';

/**
 * PPT → 页面图片 预览服务。
 *
 * 转换链路：BOS 上的 .pptx →（LibreOffice soffice）PDF →（pdftoppm）多张 PNG →
 * 逐张写回 BOS 缓存目录，并生成一份 manifest.json 记录页面 URL 列表。
 * 二次访问命中 manifest 直接返回，不再走一次转换。
 *
 * 依赖：宿主机需已安装 `soffice`（LibreOffice）与 `pdftoppm`（poppler-utils）。
 * 二进制位置优先取环境变量 SOFFICE_BIN / PDFTOPPM_BIN，否则在常见安装路径中探测
 * （macOS 上 LibreOffice.app 里的 soffice 默认不在 PATH）。
 * 缓存 key：users/<uid>/PPT/.preview/<pptSafeName>/{manifest.json, page-1.png, ...}
 */
@Injectable()
export class PptImagesService {
  private readonly logger = new Logger(PptImagesService.name);
  /** 单次转换整体超时（防止 LibreOffice 卡死拖累进程） */
  private readonly CONVERT_TIMEOUT_MS = 90_000;
  /** pdftoppm 输出 DPI，兼顾清晰度与体积（约每页 200–400KB） */
  private readonly RENDER_DPI = 120;
  /** 允许转换的 PPT 最大体积（20MB） */
  private readonly MAX_PPT_BYTES = 20 * 1024 * 1024;

  /** 外部二进制的候选安装位置（按顺序探测），探测结果做进程内缓存 */
  private readonly BIN_CANDIDATES: Record<string, string[]> = {
    soffice: [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/opt/homebrew/bin/soffice',
      '/usr/local/bin/soffice',
      '/usr/bin/soffice',
      '/usr/bin/libreoffice',
    ],
    pdftoppm: [
      '/opt/homebrew/bin/pdftoppm',
      '/usr/local/bin/pdftoppm',
      '/usr/bin/pdftoppm',
    ],
  };

  /** 安装指引，缺失时直接给到前端，避免只报一句「未安装」 */
  private readonly INSTALL_HINT: Record<string, string> = {
    soffice:
      'macOS：https://www.libreoffice.org/download 下载安装 LibreOffice；Linux：apt install libreoffice-impress。也可用环境变量 SOFFICE_BIN 指定可执行文件路径。',
    pdftoppm:
      'macOS：brew install poppler；Linux：apt install poppler-utils。也可用环境变量 PDFTOPPM_BIN 指定可执行文件路径。',
  };

  private readonly binCache = new Map<string, string>();

  constructor(private readonly uploadService: UploadService) {}

  /**
   * 拿到某个 PPT 的分页图片 URL 列表（命中缓存直接返回）
   */
  async getPages(pptBosUrl: string): Promise<{ pages: string[]; total: number }> {
    const key = this.uploadService.parseBosKey(pptBosUrl);
    if (!/\.pptx?$/i.test(key)) {
      throw new Error('仅支持 .ppt/.pptx 文件预览');
    }

    const previewPrefix = this.previewPrefixOf(key);
    const manifestKey = `${previewPrefix}manifest.json`;

    // 命中缓存
    const cached = await this.tryLoadManifest(manifestKey);
    if (cached && cached.pages.length > 0) {
      return { pages: cached.pages, total: cached.pages.length };
    }

    // 未命中：真正转换
    const pptBuffer = await this.uploadService.getObjectAsBuffer(key);
    if (pptBuffer.length > this.MAX_PPT_BYTES) {
      throw new Error('文件超过 20MB，无法在线转换预览');
    }

    const pageUrls = await this.convertAndUpload(pptBuffer, key, previewPrefix);

    // 写 manifest（不阻塞返回也可，这里为简单起见同步写）
    await this.uploadService.putObjectPublic(
      manifestKey,
      Buffer.from(JSON.stringify({ pages: pageUrls, createdAt: Date.now() })),
      'application/json',
    );

    return { pages: pageUrls, total: pageUrls.length };
  }

  private previewPrefixOf(pptKey: string): string {
    // pptKey: users/<uid>/PPT/<safeName>.pptx  →  users/<uid>/PPT/.preview/<safeName>/
    const lastSlash = pptKey.lastIndexOf('/');
    const dir = lastSlash === -1 ? '' : pptKey.slice(0, lastSlash + 1);
    const fileName = lastSlash === -1 ? pptKey : pptKey.slice(lastSlash + 1);
    const stem = fileName.replace(/\.pptx?$/i, '');
    return `${dir}.preview/${stem}/`;
  }

  private async tryLoadManifest(
    manifestKey: string,
  ): Promise<{ pages: string[] } | null> {
    if (!(await this.uploadService.objectExists(manifestKey))) return null;
    try {
      const buf = await this.uploadService.getObjectAsBuffer(manifestKey);
      const parsed = JSON.parse(buf.toString('utf8')) as { pages?: string[] };
      if (!Array.isArray(parsed.pages)) return null;
      return { pages: parsed.pages.filter((u) => typeof u === 'string') };
    } catch (e) {
      this.logger.warn(`读取缓存 manifest 失败：${(e as Error).message}`);
      return null;
    }
  }

  /**
   * 落盘 → soffice 转 PDF → pdftoppm 拆图 → 上传 BOS。
   * 使用 mkdtemp 隔离每次任务；结束后清理临时目录。
   */
  private async convertAndUpload(
    pptBuffer: Buffer,
    pptKey: string,
    previewPrefix: string,
  ): Promise<string[]> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ppt-preview-'));
    try {
      const pptPath = path.join(tmpDir, 'input.pptx');
      await fs.writeFile(pptPath, pptBuffer);

      // 1) PPT -> PDF
      // macOS/多实例下 LibreOffice 会因共享用户配置目录而拒绝启动，故给每次转换一个独立 profile
      await this.run(
        await this.resolveBin('soffice'),
        [
          `-env:UserInstallation=file://${path.join(tmpDir, 'lo-profile')}`,
          '--headless',
          '--convert-to',
          'pdf',
          '--outdir',
          tmpDir,
          pptPath,
        ],
        this.CONVERT_TIMEOUT_MS,
      );
      const pdfPath = path.join(tmpDir, 'input.pdf');
      if (!(await this.exists(pdfPath))) {
        throw new Error('LibreOffice 未生成 PDF，转换失败');
      }

      // 2) PDF -> PNG（pdftoppm 会生成 page-1.png, page-2.png ...）
      await this.run(
        await this.resolveBin('pdftoppm'),
        ['-png', '-r', String(this.RENDER_DPI), pdfPath, path.join(tmpDir, 'page')],
        this.CONVERT_TIMEOUT_MS,
      );

      const entries = await fs.readdir(tmpDir);
      const pngFiles = entries
        .filter((n) => /^page-\d+\.png$/.test(n))
        .sort((a, b) => this.pageNumOf(a) - this.pageNumOf(b));
      if (pngFiles.length === 0) {
        throw new Error('未生成任何页面图片');
      }

      // 3) 上传 PNG（并发上传，控制并发数）
      const pageUrls: string[] = [];
      const CONCURRENCY = 4;
      for (let i = 0; i < pngFiles.length; i += CONCURRENCY) {
        const chunk = pngFiles.slice(i, i + CONCURRENCY);
        const uploaded = await Promise.all(
          chunk.map(async (fileName) => {
            const idx = this.pageNumOf(fileName);
            const buf = await fs.readFile(path.join(tmpDir, fileName));
            const key = `${previewPrefix}page-${idx}.png`;
            return this.uploadService.putObjectPublic(key, buf, 'image/png');
          }),
        );
        pageUrls.push(...uploaded);
      }

      this.logger.log(
        `PPT 预览生成完成：${pptKey}，共 ${pageUrls.length} 页`,
      );
      return pageUrls;
    } finally {
      // 清理临时目录（不阻塞主流程）
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private pageNumOf(fileName: string): number {
    return Number(fileName.match(/page-(\d+)\.png$/)?.[1] || 0);
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 定位外部二进制：环境变量 > 常见安装路径 > 交给 PATH。
   * 都找不到时直接抛出带安装指引的错误，而不是等 spawn 报 ENOENT。
   */
  private async resolveBin(name: 'soffice' | 'pdftoppm'): Promise<string> {
    const cached = this.binCache.get(name);
    if (cached) return cached;

    const envVar = name === 'soffice' ? 'SOFFICE_BIN' : 'PDFTOPPM_BIN';
    const fromEnv = process.env[envVar]?.trim();
    const candidates = fromEnv
      ? [fromEnv, ...this.BIN_CANDIDATES[name]]
      : this.BIN_CANDIDATES[name];

    for (const c of candidates) {
      if (await this.exists(c)) {
        this.binCache.set(name, c);
        return c;
      }
    }

    // 兜底：可能装在 PATH 里的其他位置，交给 spawn 试一次
    if (await this.inPath(name)) {
      this.binCache.set(name, name);
      return name;
    }

    throw new Error(`宿主机未安装 ${name}。${this.INSTALL_HINT[name]}`);
  }

  /** 用 `command -v` 判断 PATH 中是否存在该命令 */
  private inPath(name: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('/bin/sh', ['-c', `command -v ${name}`], {
        stdio: 'ignore',
      });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  /**
   * spawn 一个外部命令并 promisify，捕获非零退出与超时。
   */
  private run(bin: string, args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      let stdout = '';
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try {
          proc.kill('SIGKILL');
        } catch { /* ignore */ }
        reject(new Error(`${bin} 执行超时`));
      }, timeoutMs);

      proc.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      proc.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      proc.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // ENOENT：宿主机没装
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`宿主机未安装 ${bin}`));
        } else {
          reject(err);
        }
      });
      proc.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `${bin} 退出码 ${code}${stderr ? `：${stderr.trim().slice(0, 500)}` : stdout ? `：${stdout.trim().slice(0, 500)}` : ''}`,
            ),
          );
        }
      });
    });
  }
}
