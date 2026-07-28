import { Injectable } from '@nestjs/common';
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

@Injectable()
export class UploadService {
  private readonly bosClient: InstanceType<typeof BaiduSdk.BosClient>;

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {
    this.bosClient = new BaiduSdk.BosClient(BOS_CONFIG);
  }

  /**
   * 上传文件到 BOS，返回公开访问 URL
   */
  async uploadToBos(file: Express.Multer.File): Promise<string> {
    const ext = file.originalname.split('.').pop() || 'png';
    const key = `uploads/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    await this.bosClient.putObject(BOS_BUCKET, key, file.buffer, {
      'Content-Type': file.mimetype,
      'x-bce-acl': 'public-read',
    });

    return `https://${BOS_BUCKET}.bj.bcebos.com/${key}`;
  }

  /**
   * 上传头像并更新用户记录
   */
  async uploadAvatar(file: Express.Multer.File, userId: number): Promise<string> {
    const ext = file.originalname.split('.').pop() || 'png';
    const key = `avatars/${userId}_${Date.now()}.${ext}`;

    await this.bosClient.putObject(BOS_BUCKET, key, file.buffer, {
      'Content-Type': file.mimetype,
      'x-bce-acl': 'public-read',
    });

    const url = `https://${BOS_BUCKET}.bj.bcebos.com/${key}`;

    // 更新数据库用户头像
    await this.userRepo.update(userId, { avatar: url });

    return url;
  }
}
