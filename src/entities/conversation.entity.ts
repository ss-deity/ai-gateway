import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
} from 'typeorm';
import { User } from './user.entity.js';
import { Message } from './message.entity.js';
import type { ConversationMemory } from '../memory/memory.service.js';

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ length: 255, default: '新对话' })
  title!: string;

  @ManyToOne(() => User, (user) => user.conversations)
  user!: User;

  @Column()
  userId!: number;

  /** 会话记忆：摘要 + 稳定事实 + 当前任务，由 MemoryService 维护 */
  @Column({ type: 'simple-json', nullable: true })
  memory?: ConversationMemory;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => Message, (message) => message.conversation)
  messages!: Message[];
}
