import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
   * 组合 BOS 完整可访问 URL
   */
  private urlOf(key: string): string {
    return `https://${BOS_BUCKET}.bj.bcebos.com/${key}`;
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
      'Content-Type': file.mimetype,
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
      'Content-Type': file.mimetype,
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
      await this.bosClient.copyObject(BOS_BUCKET, srcKey, BOS_BUCKET, dstKey);
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
        await this.bosClient.copyObject(BOS_BUCKET, srcKey, BOS_BUCKET, dstKey);
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
