import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
} from 'typeorm';
import { Conversation } from './conversation.entity.js';

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'enum', enum: ['user', 'assistant'] })
  role!: 'user' | 'assistant';

  @Column({ type: 'text' })
  content!: string;

  /** 生成的图片 URL 列表（如即梦图片生成），文本消息为空 */
  @Column({ type: 'simple-json', nullable: true })
  images?: string[];

  /** 用户上传的附件列表（图片 / 文档），仅 user 消息使用 */
  @Column({ type: 'simple-json', nullable: true })
  attachments?: { url: string; name: string; type: string; size: number }[];

  /** 生成该消息所用的模型 type（如 deepseek-v4 / jimeng-v4.6） */
  @Column({ type: 'varchar', length: 64, nullable: true })
  model?: string;

  @ManyToOne(() => Conversation, (conversation) => conversation.messages)
  conversation!: Conversation;

  @Column()
  conversationId!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
