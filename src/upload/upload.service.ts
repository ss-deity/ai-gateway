import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { resolveContentType } from '../common/content-type.js';
import { assertPublicHttpUrl } from '../common/url-guard.js';
import { User } from '../entities/user.entity.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const BaiduSdk = require('@baiducloud/sdk');

const BOS_CONFIG = {
  endpoint: process.env.BOS_ENDPOINT || 'https://bj.bcebos.com',
  credentials: {
    ak: process.env.BOS_AK || '',
    sk: process.env.BOS_SK || '',
  },
};

const BOS_BUCKET = process.env.BOS_BUCKET || '';

/** 目录占位对象文件名：用于在对象存储中"落"出一个空目录 */
const FOLDER_MARKER = '.folder';

/**
 * 允许转存的图片 MIME → 文件扩展名。
 * BOS 没有"按远程 URL 拉取对象"的服务端接口（copyObject 的源必须是 BOS 内的对象），
 * 所以远程图片只能由服务端先下载到内存、再 putObject，这里用于推断落地文件名的后缀。
 */
const IMAGE_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

/** 单张转存图片的大小上限：20MB */
const MAX_SAVE_IMAGE_BYTES = 20 * 1024 * 1024;

/** 图片扩展名白名单：用于「@ 选图」时从对象列表里筛出图片 */
const IMAGE_EXT_SET = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'avif',
  'jfif',
]);

/** 远程图片下载超时 */
const FETCH_IMAGE_TIMEOUT_MS = 30_000;

/** listObjects 返回的对象条目（仅取用到的字段） */
interface BosObject {
  key: string;
  size?: number;
  lastModified?: string;
}

/** 文件管理列表项 */
export interface FileEntry {
  /** 文件/文件夹名称（当前层级） */
  name: string;
  /** 相对用户根目录的路径，如 `docs/a.pdf` */
  path: string;
  /** 是否为文件夹 */
  isDir: boolean;
  /** 文件大小（字节），文件夹为 0 */
  size: number;
  /** 最后修改时间（毫秒时间戳） */
  lastModified: number;
  /** 文件可访问 URL（文件夹为 undefined） */
  url?: string;
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly bosClient: InstanceType<typeof BaiduSdk.BosClient>;

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {
    this.bosClient = new BaiduSdk.BosClient(BOS_CONFIG);
  }

  /**
   * 用户在 BOS 中的根目录前缀（不带 bucket）
   */
  private userFolderPrefix(uid: string): string {
    return `users/${uid}/`;
  }

  /**
   * 组合 BOS 完整可访问 URL。
   * key 里可能含中文、空格等字符，需按路径段做 percent-encoding，
   * 否则拼出来的不是合法 URL（BOS SDK 内部也是这样编码请求路径的）。
   */
  private urlOf(key: string): string {
    const encodedKey = key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `https://${BOS_BUCKET}.bj.bcebos.com/${encodedKey}`;
  }

  /**
   * 为用户创建 BOS 存储文件夹（通过上传一个 zero-byte 占位对象来"落"目录）。
   * 幂等：重复调用无副作用。
   */
  async createUserFolder(uid: string): Promise<string> {
    if (!uid) throw new Error('uid 不能为空');
    const prefix = this.userFolderPrefix(uid);
    const markerKey = `${prefix}.folder`;
    try {
      await this.bosClient.putObject(BOS_BUCKET, markerKey, Buffer.alloc(0), {
        'Content-Type': 'application/octet-stream',
        'x-bce-acl': 'private',
      });
      this.logger.log(`已为用户 uid=${uid} 创建 BOS 目录 ${prefix}`);
    } catch (err) {
      this.logger.error(`创建 BOS 用户目录失败 uid=${uid}`, err as Error);
      throw err;
    }
    return prefix;
  }

  /**
   * 根据用户 numeric id 找到 uid（无则抛错）
   */
  private async resolveUid(userId: number): Promise<string> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user || !user.uid) {
      throw new Error(`未找到用户或用户缺少 uid: userId=${userId}`);
    }
    return user.uid;
  }

  /**
   * 通用上传：必须携带 userId，将文件写入该用户目录（文件管理根目录）下的 dir 子目录。
   * dir 为相对根目录的路径（不含前导斜杠），缺省表示上传到根目录；文件名保留原始名称。
   */
  async uploadToBos(
    file: Express.Multer.File,
    userId: number,
    dir?: string,
  ): Promise<string> {
    const uid = await this.resolveUid(userId);
    const dirPrefix = this.dirPrefix(this.normalizeRel(dir));
    const safeName = this.sanitizeFileName(file.originalname);
    const key = `${this.userFolderPrefix(uid)}${dirPrefix}${safeName}`;

    await this.bosClient.putObject(BOS_BUCKET, key, file.buffer, {
      'Content-Type': resolveContentType(safeName, file.mimetype),
      'x-bce-acl': 'public-read',
    });

    return this.urlOf(key);
  }

  /**
   * 上传头像：写入用户目录下的 avatar/ 子目录，并同步 users.avatar 字段
   */
  async uploadAvatar(
    file: Express.Multer.File,
    userId: number,
  ): Promise<string> {
    const uid = await this.resolveUid(userId);
    const ext = file.originalname.split('.').pop() || 'png';
    const key = `${this.userFolderPrefix(uid)}avatar/${Date.now()}.${ext}`;

    await this.bosClient.putObject(BOS_BUCKET, key, file.buffer, {
      'Content-Type': resolveContentType(file.originalname, file.mimetype),
      'x-bce-acl': 'public-read',
    });

    const url = this.urlOf(key);
    await this.userRepo.update(userId, { avatar: url });
    return url;
  }

  /* ============================ 文件管理 ============================ */

  /**
   * 归一化相对路径：去掉首尾斜杠、`.`/`..` 等非法片段，返回 `a/b` 形式（可能为空串）。
   */
  private normalizeRel(rel?: string): string {
    if (!rel) return '';
    const parts = rel
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s && s !== '.' && s !== '..');
    return parts.join('/');
  }

  /** 目录前缀：空串保持空串，非空则补一个尾斜杠 */
  private dirPrefix(rel: string): string {
    return rel ? `${rel}/` : '';
  }

  /** 校验单个文件/文件夹名称（不含斜杠等非法字符） */
  private sanitizeFileName(name: string): string {
    const n = (name || '').trim();
    if (!n) throw new Error('名称不能为空');
    if (/[\\/<>|*?:"]/.test(n) || n === '.' || n === '..') {
      throw new Error('名称包含非法字符');
    }
    return n;
  }

  /**
   * 列出该用户某个目录下的直接子项（文件夹 + 文件）。
   * 通过列举前缀下的全部对象在内存中派生出当前层级的文件夹与文件。
   */
  async listFiles(userId: number, dir?: string): Promise<FileEntry[]> {
    const uid = await this.resolveUid(userId);
    const root = this.userFolderPrefix(uid);
    const relDir = this.normalizeRel(dir);
    const prefix = `${root}${this.dirPrefix(relDir)}`;

    const objects = await this.listAllObjects(prefix);

    const folderMtime = new Map<string, number>();
    const files: FileEntry[] = [];

    for (const obj of objects) {
      const rel = obj.key.slice(prefix.length);
      if (!rel || rel === FOLDER_MARKER) continue;
      const slashIndex = rel.indexOf('/');
      const mtime = obj.lastModified ? Date.parse(obj.lastModified) : 0;
      if (slashIndex === -1) {
        files.push({
          name: rel,
          path: `${this.dirPrefix(relDir)}${rel}`,
          isDir: false,
          size: obj.size ?? 0,
          lastModified: mtime,
          url: this.urlOf(obj.key),
        });
      } else {
        const folderName = rel.slice(0, slashIndex);
        const prev = folderMtime.get(folderName) ?? 0;
        folderMtime.set(folderName, Math.max(prev, mtime));
      }
    }

    const folders: FileEntry[] = [...folderMtime.entries()].map(
      ([name, mtime]) => ({
        name,
        path: `${this.dirPrefix(relDir)}${name}`,
        isDir: true,
        size: 0,
        lastModified: mtime,
      }),
    );

    const byName = (a: FileEntry, b: FileEntry) =>
      a.name.localeCompare(b.name, 'zh-Hans-CN');
    folders.sort(byName);
    files.sort(byName);
    return [...folders, ...files];
  }

  /**
   * 递归检索该用户「文件管理」下的全部图片文件，供输入框 @ 唤起时选择。
   * 与 listFiles 不同：跨全部子目录、只返回图片、按名称关键字过滤并限量。
   *
   * @param keyword 文件名关键字（不区分大小写），缺省返回最近修改的若干张
   * @param limit 返回条数上限
   */
  async searchImages(
    userId: number,
    keyword?: string,
    limit = 50,
  ): Promise<FileEntry[]> {
    const uid = await this.resolveUid(userId);
    const root = this.userFolderPrefix(uid);
    const objects = await this.listAllObjects(root);
    const kw = (keyword || '').trim().toLowerCase();

    const images: FileEntry[] = [];
    for (const obj of objects) {
      const rel = obj.key.slice(root.length);
      if (!rel || rel.endsWith('/')) continue;
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      if (!name || name === FOLDER_MARKER) continue;
      // 头像目录不属于用户可见的文件管理内容
      if (rel.startsWith('avatar/')) continue;
      const ext = name.split('.').pop()?.toLowerCase() || '';
      if (!IMAGE_EXT_SET.has(ext)) continue;
      if (kw && !name.toLowerCase().includes(kw)) continue;
      images.push({
        name,
        path: rel,
        isDir: false,
        size: obj.size ?? 0,
        lastModified: obj.lastModified ? Date.parse(obj.lastModified) : 0,
        url: this.urlOf(obj.key),
      });
    }

    // 最近修改的优先展示
    images.sort((a, b) => b.lastModified - a.lastModified);
    return images.slice(0, Math.max(1, limit));
  }

  /**
   * 新建文件夹：在 `root/dir/name/` 下放一个 0 字节占位对象来"落"目录。
   */
  async createFolder(
    userId: number,
    dir: string | undefined,
    name: string,
  ): Promise<FileEntry> {
    const uid = await this.resolveUid(userId);
    const root = this.userFolderPrefix(uid);
    const relDir = this.normalizeRel(dir);
    const folderName = this.sanitizeFileName(name);
    const folderRel = `${this.dirPrefix(relDir)}${folderName}`;
    const markerKey = `${root}${folderRel}/${FOLDER_MARKER}`;

    await this.bosClient.putObject(BOS_BUCKET, markerKey, Buffer.alloc(0), {
      'Content-Type': 'application/octet-stream',
      'x-bce-acl': 'private',
    });

    return {
      name: folderName,
      path: folderRel,
      isDir: true,
      size: 0,
      lastModified: Date.now(),
    };
  }

  /**
   * 删除文件或文件夹。文件夹会递归删除其前缀下的全部对象。
   */
  async deleteEntry(
    userId: number,
    relPath: string,
    isDir: boolean,
  ): Promise<void> {
    const uid = await this.resolveUid(userId);
    const root = this.userFolderPrefix(uid);
    const rel = this.normalizeRel(relPath);
    if (!rel) throw new Error('路径不能为空');

    if (!isDir) {
      await this.bosClient.deleteObject(BOS_BUCKET, `${root}${rel}`);
      return;
    }

    const prefix = `${root}${rel}/`;
    const objects = await this.listAllObjects(prefix);
    const keys = objects.map((o) => o.key);
    await this.deleteKeys(keys);
  }

  /**
   * 复制对象，并显式重新声明 public-read ACL。
   *
   * BOS 的 copyObject 不会继承源对象的 ACL：不带 x-bce-acl 时目标对象会退回 bucket
   * 默认权限（private），于是「重命名后原来能打开的链接变 403」。上传/转存写入时都是
   * public-read，这里必须补上，否则复制出来的新对象就不可公开访问了。
   * 目录占位对象保持 private，与 createFolder 一致。
   */
  private async copyObjectKeepingAcl(
    srcKey: string,
    dstKey: string,
  ): Promise<void> {
    const isFolderMarker = dstKey.endsWith(`/${FOLDER_MARKER}`);
    await this.bosClient.copyObject(BOS_BUCKET, srcKey, BOS_BUCKET, dstKey, {
      'x-bce-acl': isFolderMarker ? 'private' : 'public-read',
    });
  }

  /**
   * 重命名文件或文件夹（同目录内改名）。BOS 无原生重命名，采用复制 + 删除实现。
   */
  async renameEntry(
    userId: number,
    relPath: string,
    newName: string,
    isDir: boolean,
  ): Promise<FileEntry> {
    const uid = await this.resolveUid(userId);
    const root = this.userFolderPrefix(uid);
    const rel = this.normalizeRel(relPath);
    if (!rel) throw new Error('路径不能为空');
    const safeNewName = this.sanitizeFileName(newName);

    const lastSlash = rel.lastIndexOf('/');
    const parentRel = lastSlash === -1 ? '' : rel.slice(0, lastSlash);
    const newRel = `${this.dirPrefix(parentRel)}${safeNewName}`;

    if (!isDir) {
      const srcKey = `${root}${rel}`;
      const dstKey = `${root}${newRel}`;
      await this.copyObjectKeepingAcl(srcKey, dstKey);
      await this.bosClient.deleteObject(BOS_BUCKET, srcKey);
    } else {
      const srcPrefix = `${root}${rel}/`;
      const dstPrefix = `${root}${newRel}/`;
      const objects = await this.listAllObjects(srcPrefix);
      // 至少保证目录占位对象存在，避免空目录复制后丢失
      const keys =
        objects.length > 0
          ? objects.map((o) => o.key)
          : [`${srcPrefix}${FOLDER_MARKER}`];
      for (const srcKey of keys) {
        const dstKey = `${dstPrefix}${srcKey.slice(srcPrefix.length)}`;
        await this.copyObjectKeepingAcl(srcKey, dstKey);
      }
      await this.deleteKeys(objects.map((o) => o.key));
    }

    return {
      name: safeNewName,
      path: newRel,
      isDir,
      size: 0,
      lastModified: Date.now(),
      url: isDir ? undefined : this.urlOf(`${root}${newRel}`),
    };
  }

  /* ========================= 会话图片转存 ========================= */

  /**
   * 把会话中的一张图片转存到该用户「文件管理」的某个目录下。
   *
   * 会话图片有两种来源：即梦返回的第三方临时 URL、以及 base64 data URI，两者都不在我们的
   * BOS 里，而 BOS 的 copyObject 只支持 BOS 内部对象作为源、也没有"按 URL 远程拉取"的接口，
   * 因此只能服务端下载到内存再 putObject（不落磁盘、不经过浏览器）。
   *
   * @param userId 用户数字 id
   * @param sourceUrl 图片地址：http(s) URL 或 `data:image/*;base64,...`
   * @param dir 目标目录（相对用户根目录，缺省为根目录）
   * @param name 指定文件名，缺省按时间戳生成
   */
  async saveImageFromUrl(
    userId: number,
    sourceUrl: string,
    dir?: string,
    name?: string,
  ): Promise<FileEntry> {
    const uid = await this.resolveUid(userId);
    const root = this.userFolderPrefix(uid);
    const relDir = this.normalizeRel(dir);
    const dirPrefix = this.dirPrefix(relDir);

    const { buffer, mime } = await this.fetchImage(sourceUrl);
    const ext = IMAGE_MIME_EXT[mime] ?? 'png';
    const baseName = name
      ? this.sanitizeFileName(name)
      : `AI图片_${this.timestampSuffix()}.${ext}`;
    const fileName = await this.uniqueFileName(`${root}${dirPrefix}`, baseName);
    const key = `${root}${dirPrefix}${fileName}`;

    await this.bosClient.putObject(BOS_BUCKET, key, buffer, {
      'Content-Type': resolveContentType(fileName, mime),
      'x-bce-acl': 'public-read',
    });

    return {
      name: fileName,
      path: `${dirPrefix}${fileName}`,
      isDir: false,
      size: buffer.length,
      lastModified: Date.now(),
      url: this.urlOf(key),
    };
  }

  /** 生成 `20260729_153012` 形式的时间戳（本地时区），用于默认文件名 */
  private timestampSuffix(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
  }

  /**
   * 目标目录内已存在同名文件时，追加 ` (1)` ` (2)` 后缀直到不冲突。
   */
  private async uniqueFileName(
    dirFullPrefix: string,
    fileName: string,
  ): Promise<string> {
    const objects = await this.listAllObjects(dirFullPrefix);
    const existing = new Set(
      objects
        .map((o) => o.key.slice(dirFullPrefix.length))
        .filter((rel) => rel && !rel.includes('/')),
    );
    if (!existing.has(fileName)) return fileName;

    const dot = fileName.lastIndexOf('.');
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const suffix = dot > 0 ? fileName.slice(dot) : '';
    for (let i = 1; ; i++) {
      const candidate = `${stem} (${i})${suffix}`;
      if (!existing.has(candidate)) return candidate;
    }
  }

  /**
   * 取回图片内容：支持 data URI 与 http(s) URL。
   * URL 由客户端传入，因此这里做 SSRF 防护（仅 http/https、拒绝内网地址）、
   * MIME 白名单与大小上限校验。
   */
  private async fetchImage(
    sourceUrl: string,
  ): Promise<{ buffer: Buffer; mime: string }> {
    const src = (sourceUrl || '').trim();
    if (!src) throw new Error('图片地址不能为空');

    if (src.startsWith('data:')) {
      const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
      if (!match) throw new Error('图片 data URI 格式不正确');
      const mime = match[1].toLowerCase();
      if (!IMAGE_MIME_EXT[mime]) {
        throw new Error(`不支持的图片格式：${mime}`);
      }
      const buffer = match[2]
        ? Buffer.from(match[3], 'base64')
        : Buffer.from(decodeURIComponent(match[3]), 'utf8');
      if (buffer.length === 0) throw new Error('图片内容为空');
      if (buffer.length > MAX_SAVE_IMAGE_BYTES) {
        throw new Error('图片超过 20MB，无法转存');
      }
      return { buffer, mime };
    }

    await assertPublicHttpUrl(src, '图片地址');

    const res = await fetch(src, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_IMAGE_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`下载图片失败：HTTP ${res.status}`);
    }

    const mime = (res.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!IMAGE_MIME_EXT[mime]) {
      throw new Error(`不支持的图片格式：${mime || '未知'}`);
    }

    const declaredSize = Number(res.headers.get('content-length') || 0);
    if (declaredSize > MAX_SAVE_IMAGE_BYTES) {
      throw new Error('图片超过 20MB，无法转存');
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) throw new Error('图片内容为空');
    if (buffer.length > MAX_SAVE_IMAGE_BYTES) {
      throw new Error('图片超过 20MB，无法转存');
    }
    return { buffer, mime };
  }

  /** 列举某前缀下的全部对象（自动翻页） */
  private async listAllObjects(prefix: string): Promise<BosObject[]> {
    const all: BosObject[] = [];
    let marker = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.bosClient.listObjects(BOS_BUCKET, {
        prefix,
        marker,
        maxKeys: 1000,
      });
      const body = res.body as {
        contents?: BosObject[];
        isTruncated?: boolean;
      };
      const contents = body.contents ?? [];
      all.push(...contents);
      if (body.isTruncated && contents.length > 0) {
        marker = contents[contents.length - 1].key;
      } else {
        break;
      }
    }
    return all;
  }

  /** 批量删除对象，按 BOS 单次 1000 个上限分批 */
  private async deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      if (batch.length === 0) continue;
      await this.bosClient.deleteMultipleObjects(BOS_BUCKET, batch);
    }
  }
}
